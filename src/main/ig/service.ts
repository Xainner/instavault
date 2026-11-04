import { randomUUID } from "node:crypto";
import type { AccessMode, MediaKind, ParsedUrl, QuickResolution, RemoteActivity, SyncResult, SyncStatus } from "@shared/types";
import { assetUrl } from "@shared/urls";
import type { MediaDownloadRow, Repo } from "../db/repo";
import { VaultError, cancelled } from "../errors";
import { downloadToStore } from "../net/cdn";
import type { VaultStore } from "../vault/store";
import { IgBridge } from "./bridge";
import {
  collectMedia,
  dedupe,
  detectDenial,
  extractMobileItem,
  findUser,
  paginationHasMore,
  parseEmbedHtml,
  findHighlights,
  findReels,
  parseJsonScripts,
  parseReels,
  profileFromSnapshot,
  profileFromUser,
  retainGridMedia,
  sanitizeUsername,
  snapshotIndicatesEmpty,
  snapshotIndicatesLoginWall,
  userTimelineHasMore,
  type PageSnapshot,
} from "./parse";
import type { ExtractedMedia, ExtractedProfile } from "./types";
import { parseInstagramUrl, shortcodeToMediaId } from "./url";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export interface ServiceHooks {
  activity(activity: RemoteActivity | null): void;
  libraryChanged(profileIds: number[]): void;
  mediaChanged(profileId: number, mediaIds: number[]): void;
}

interface OperationContext {
  isCancelled: () => boolean;
  stage: (text: string) => void;
}

interface StoredResolution {
  resolution: QuickResolution;
  media: ExtractedMedia[];
  ownerProfile: ExtractedProfile | null;
  accountId: number | null;
  createdAt: number;
}

function notFollowed(user: Obj): boolean {
  if (user.followed_by_viewer === false) return true;
  return isObj(user.friendship_status) && user.friendship_status.following === false;
}

function snapshotMatchesProfile(snapshot: PageSnapshot, username: string): boolean {
  try {
    const url = new URL(snapshot.url);
    const first = url.pathname.split("/").filter(Boolean)[0] ?? "";
    return url.hostname === "www.instagram.com" && first.toLowerCase() === username.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Orquesta el acceso a Instagram. Público = partición anónima en memoria;
 * cuenta = partición persistente de esa cuenta. Nunca se mezclan.
 */
export class InstagramService {
  private publicBridge: IgBridge | null = null;
  private accountBridges = new Map<number, IgBridge>();
  private active: { activity: RemoteActivity; cancelled: boolean } | null = null;
  private resolutions = new Map<string, StoredResolution>();

  constructor(
    private readonly repo: Repo,
    private readonly store: VaultStore,
    private readonly hooks: ServiceHooks,
  ) {}

  // ---------------------------------------------------------------- bridges
  bridge(access: AccessMode, accountId?: number | null): IgBridge {
    if (access === "public") {
      this.publicBridge ??= new IgBridge("ig-public", "public");
      return this.publicBridge;
    }
    const id = accountId ?? this.repo.getSettings().defaultAccountId ?? this.repo.listAccounts().find((a) => a.status === "valid")?.id;
    if (!id) throw new VaultError("private_login_required", "Conecta una cuenta de Instagram en «Cuentas» para continuar.");
    const account = this.repo.getAccount(id);
    if (!account) throw new VaultError("private_login_required", "La cuenta seleccionada ya no existe.");
    if (account.status !== "valid") throw new VaultError("private_login_required", `@${account.username} necesita reconectarse antes de usarla.`);
    let bridge = this.accountBridges.get(id);
    if (!bridge || bridge.partition !== account.partition) {
      bridge?.destroy();
      bridge = new IgBridge(account.partition, "account");
      this.accountBridges.set(id, bridge);
    }
    return bridge;
  }

  resolveAccountId(accountId?: number | null): number | null {
    if (accountId) return accountId;
    const settings = this.repo.getSettings();
    if (settings.defaultAccountId && this.repo.getAccount(settings.defaultAccountId)?.status === "valid") return settings.defaultAccountId;
    return this.repo.listAccounts().find((a) => a.status === "valid")?.id ?? null;
  }

  dropAccountBridge(accountId: number) {
    this.accountBridges.get(accountId)?.destroy();
    this.accountBridges.delete(accountId);
  }

  shutdown() {
    this.publicBridge?.destroy();
    for (const b of this.accountBridges.values()) b.destroy();
    this.accountBridges.clear();
  }

  // ------------------------------------------------------- operación única
  get activity(): RemoteActivity | null {
    return this.active?.activity ?? null;
  }

  async exclusive<T>(label: string, profileId: number | null, fn: (ctx: OperationContext) => Promise<T>): Promise<T> {
    if (this.active) throw new VaultError("busy", `Ya hay una operación en curso: ${this.active.activity.label}.`);
    const op = {
      activity: { operationId: randomUUID(), label, stage: "Preparando", profileId, cancellable: true } as RemoteActivity,
      cancelled: false,
    };
    this.active = op;
    this.hooks.activity(op.activity);
    const ctx: OperationContext = {
      isCancelled: () => op.cancelled,
      stage: (stage) => {
        op.activity = { ...op.activity, stage };
        this.hooks.activity(op.activity);
      },
    };
    try {
      return await fn(ctx);
    } finally {
      this.active = null;
      this.hooks.activity(null);
    }
  }

  cancel() {
    if (this.active) this.active.cancelled = true;
  }

  // ------------------------------------------------------------- perfiles
  /*
   * Instagram retiró /api/v1/users/web_profile_info/ y /api/v1/feed/user/
   * (404 con y sin sesión). Ahora el perfil y la cuadrícula se leen como lo
   * hace la web: sin sesión vienen incrustados en el HTML; con sesión, la
   * página los pide por GraphQL al cargarse y al desplazarse.
   */

  /** Navega el perfil, desplaza la cuadrícula y extrae perfil y publicaciones. */
  private async readGrid(
    bridge: IgBridge,
    username: string,
    opts: { need: number; checkpoint: string | null; ctx?: OperationContext; timeoutMs?: number; maxScrolls?: number },
  ) {
    const capture = await bridge.capture(`https://www.instagram.com/${username}/`, {
      batchSize: opts.need,
      checkpoint: opts.checkpoint,
      isCancelled: opts.ctx?.isCancelled,
      timeoutMs: opts.timeoutMs,
      maxScrolls: opts.maxScrolls,
    });
    const user = findUser(capture.payloads, username);
    const profile = (user ? profileFromUser(user, username) : null) ?? profileFromSnapshot(capture.snapshot, username);
    const media = retainGridMedia(
      dedupe([...collectMedia(capture.payloads, { kind: "post", username }), ...collectMedia(capture.gridItems, { kind: "post" })]),
      capture.publicationCodes,
    );
    return { capture, user, profile, media };
  }

  private profileUnreadable(bridge: IgBridge, snapshot: PageSnapshot): VaultError {
    const denial = detectDenial(snapshot);
    if (denial) return new VaultError(denial.code, denial.message, { retryable: denial.code === "rate_limited" });
    if (bridge.access === "public") {
      return new VaultError("public_blocked", "Instagram no entregó el perfil sin iniciar sesión. No se usó ninguna cuenta.", { canUseAccount: true });
    }
    if (snapshotIndicatesLoginWall(snapshot)) {
      return new VaultError("private_login_required", "La sesión de la cuenta expiró o fue rechazada. Vuelve a conectarla.");
    }
    return new VaultError("provider_changed", "Instagram cambió la página y no se pudo leer el perfil.");
  }


  private async saveAvatar(profileId: number, url: string | null) {
    if (!url) return;
    try {
      const asset = await downloadToStore(this.store, url, { bucket: "avatars", fallbackMime: "image/jpeg", maxBytes: 8 * 1024 * 1024 });
      this.repo.setProfileAvatar(profileId, asset.sha256);
    } catch {
      /* la foto es opcional */
    }
  }

  /** Busca un perfil y guarda sus metadatos, avatar y primeras publicaciones. */
  lookup(rawUsername: string, access: AccessMode, accountId?: number | null): Promise<number> {
    const username = sanitizeUsername(rawUsername);
    if (!username) return Promise.reject(new VaultError("invalid_input", "Nombre de usuario inválido."));
    return this.exclusive(`Buscando @${username}`, null, async (ctx) => {
      const bridge = this.bridge(access, accountId);
      ctx.stage(access === "public" ? "Consultando en modo anónimo" : "Consultando con tu cuenta");
      const grid = await this.readGrid(bridge, username, { need: 12, checkpoint: null, ctx });
      const profile = grid.profile;
      if (!profile) throw this.profileUnreadable(bridge, grid.capture.snapshot);
      if (ctx.isCancelled()) throw cancelled();
      const profileId = this.repo.upsertProfile(profile);
      ctx.stage("Guardando foto de perfil");
      await this.saveAvatar(profileId, profile.profilePicUrl);
      if (grid.media.length) {
        const result = this.repo.upsertMedia(profileId, grid.media);
        const codes = grid.capture.publicationCodes;
        const hasMore = userTimelineHasMore(grid.capture.payloads) ?? paginationHasMore(grid.capture.payloads);
        // Volver a buscar un perfil ya archivado no debe borrar el avance de su sincronización.
        if (!this.repo.getSync(profileId, "post")) this.repo.saveSync({
          profileId,
          kind: "post",
          access,
          cursor: null,
          lastCode: codes.at(-1) ?? null,
          seen: codes.length,
          status: hasMore === false && codes.length < 12 ? "complete" : "more_available",
          stopReason: null,
        });
        ctx.stage("Revelando miniaturas");
        await this.cacheThumbs(result.needThumb, profileId);
      }
      this.hooks.libraryChanged([profileId]);
      return profileId;
    });
  }

  // ------------------------------------------------------------ miniaturas
  async cacheThumbs(list: Array<{ id: number; url: string }>, profileId: number) {
    if (!list.length) return;
    const done: number[] = [];
    let index = 0;
    const worker = async () => {
      while (index < list.length) {
        const item = list[index++];
        try {
          const asset = await downloadToStore(this.store, item.url, { bucket: "thumbs", fallbackMime: "image/jpeg", maxBytes: 4 * 1024 * 1024 });
          this.repo.setThumb(item.id, asset.sha256);
          done.push(item.id);
        } catch {
          /* la miniatura es opcional */
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (done.length) this.hooks.mediaChanged(profileId, done);
  }

  // ---------------------------------------------------------- sincronizar
  sync(req: { profileId: number; kind: MediaKind; access: AccessMode; accountId?: number | null; continuation?: boolean; batchSize?: number }): Promise<SyncResult> {
    const row = this.repo.profileRow(req.profileId);
    if (!row) return Promise.reject(new VaultError("not_found", "El perfil no está en la biblioteca."));
    const label = { post: "publicaciones", story: "stories", highlight: "highlights" }[req.kind];
    return this.exclusive(`Sincronizando ${label} de @${row.username}`, req.profileId, async (ctx) => {
      if (req.kind === "post") return this.syncPosts(row, req, ctx);
      if (req.access === "public") {
        throw new VaultError("public_blocked", `Instagram sólo muestra ${label} con una sesión iniciada.`, { canUseAccount: true });
      }
      return req.kind === "story" ? this.syncStories(row, req, ctx) : this.syncHighlights(row, req, ctx);
    });
  }

  private async syncPosts(
    row: ExtractedProfile & { id: number },
    req: { profileId: number; access: AccessMode; accountId?: number | null; continuation?: boolean; batchSize?: number },
    ctx: OperationContext,
  ): Promise<SyncResult> {
    const batch = Math.max(6, Math.min(req.batchSize ?? this.repo.getSettings().postsBatchSize, 5000));
    const prior = req.continuation ? this.repo.getSync(req.profileId, "post") : null;
    const bridge = this.bridge(req.access, req.accountId);
    const anonymous = req.access === "public";
    let status: SyncStatus = "complete";
    let stopReason: string | null = null;
    const cursor: string | null = null;

    if (anonymous && row.isPrivate) {
      throw new VaultError("private_login_required", `@${row.username} es privada: usa una cuenta que la siga.`, { canUseAccount: true });
    }
    // Para reanudar hay que volver a desplazarse por lo ya visto hasta el checkpoint.
    const checkpoint = req.continuation ? (prior?.lastCode ?? null) : null;
    const behind = checkpoint ? (prior?.seen ?? 0) : 0;
    ctx.stage(anonymous ? "Recorriendo la cuadrícula en modo anónimo" : "Recorriendo la cuadrícula con tu cuenta");
    const grid = await this.readGrid(bridge, row.username, {
      need: batch,
      checkpoint,
      ctx,
      ...(anonymous ? {} : { timeoutMs: Math.min(900_000, 30_000 + (batch + behind) * 500), maxScrolls: Math.min(800, Math.ceil((batch + behind) / 6) + 20) }),
    });
    const { capture } = grid;
    const denial = detectDenial(capture.snapshot);
    const onProfile = snapshotMatchesProfile(capture.snapshot, row.username);
    if (grid.profile && onProfile) this.repo.upsertProfile(grid.profile);
    const codes = capture.publicationCodes;
    const media = grid.media;

    if (grid.profile?.isPrivate && !codes.length) {
      if (anonymous) {
        throw new VaultError("private_login_required", `@${row.username} es privada: usa una cuenta que la siga.`, { canUseAccount: true });
      }
      if (grid.user && notFollowed(grid.user)) throw new VaultError("private_not_followed", `@${row.username} es privada y tu cuenta no la sigue.`);
    }
    if (!onProfile && !media.length) {
      if (denial) throw new VaultError(denial.code, denial.message, { retryable: denial.code === "rate_limited" });
      if (anonymous) {
        throw new VaultError("public_blocked", "Instagram no dejó ver el perfil sin iniciar sesión. No se usó ninguna cuenta.", { canUseAccount: true });
      }
      throw new VaultError("private_login_required", "La sesión de la cuenta expiró o fue rechazada. Vuelve a conectarla.");
    }

    const hasMore = userTimelineHasMore(capture.payloads) ?? paginationHasMore(capture.payloads);
    const seenTotal = behind + codes.length;
    const knownTotal = grid.profile?.mediaCount ?? row.mediaCount ?? null;
    if (ctx.isCancelled()) {
      status = "cancelled";
      stopReason = "Sincronización cancelada.";
    } else if (denial && denial.code === "challenge_required") {
      status = "challenge_required";
      stopReason = denial.message;
    } else if ((denial && denial.code === "rate_limited") || capture.httpStatus === 429) {
      status = "rate_limited";
      stopReason = "Instagram limitó temporalmente las consultas.";
    } else if (codes.length >= batch) {
      status = "more_available";
    } else if (snapshotIndicatesEmpty(capture.snapshot) || hasMore === false || (knownTotal !== null && seenTotal >= knownTotal)) {
      status = "complete";
    } else if (anonymous && (capture.httpStatus === 401 || capture.httpStatus === 403 || snapshotIndicatesLoginWall(capture.snapshot) || capture.stalled || !onProfile)) {
      status = "anonymous_limit";
      stopReason = `Instagram limitó el modo anónimo tras ${seenTotal} publicaciones.`;
    } else if (checkpoint && !capture.checkpointReached) {
      status = "stalled";
      stopReason = "No se llegó al punto donde quedó la sincronización anterior; vuelve a intentarlo.";
    } else {
      status = "stalled";
      stopReason = "No se pudo confirmar el final del perfil; el avance quedó guardado.";
    }

    ctx.stage("Guardando en la biblioteca");
    const unique = dedupe(media);
    const before = new Set(this.repo.listMedia(req.profileId, "post").map((m) => m.id));
    const result = this.repo.upsertMedia(req.profileId, unique);
    const newItems = result.ids.filter((id) => !before.has(id)).length;
    const lastCode = codes.at(-1) ?? prior?.lastCode ?? null;
    this.repo.saveSync({
      profileId: req.profileId,
      kind: "post",
      access: req.access,
      cursor,
      lastCode,
      seen: (prior?.seen ?? 0) + codes.length,
      status,
      stopReason,
    });
    this.hooks.libraryChanged([req.profileId]);
    if (this.repo.getSettings().thumbnailsOnSync) {
      ctx.stage("Revelando miniaturas");
      await this.cacheThumbs(result.needThumb, req.profileId);
    }
    return {
      profileId: req.profileId,
      kind: "post",
      access: req.access,
      status,
      newItems,
      updatedItems: result.updated,
      publications: new Set(codes).size,
      continuationAvailable: ["more_available", "anonymous_limit", "stalled"].includes(status),
      stopReason,
    };
  }

  /*
   * Stories y highlights: /api/v1/feed/reels_media/ y highlights_tray ya no
   * responden. El HTML del visor (/stories/…) trae los reels incrustados. Se
   * pide sólo el HTML, sin ejecutar el visor ni pulsar «Ver historia»: así no
   * se marca nada como visto (la web lo hace con PolarisStoriesV3SeenMutation).
   */
  private async storyPage(bridge: IgBridge, path: string): Promise<Obj[]> {
    const page = await bridge.fetchText(path);
    if (page.status === 0) throw new VaultError("network", `No se pudo contactar con Instagram (${page.body || "sin respuesta"}).`, { retryable: true });
    if (page.status === 429) throw new VaultError("rate_limited", "Instagram limitó temporalmente las consultas. Espera unos minutos.", { retryable: true });
    if (page.url.includes("/challenge/")) throw new VaultError("challenge_required", "Instagram pide una verificación de seguridad. Ábrela en la ventana de la cuenta.");
    if (page.url.includes("/accounts/login")) throw new VaultError("private_login_required", "La sesión de la cuenta expiró o fue rechazada. Vuelve a conectarla.");
    if (page.status === 404) return [];
    if (page.status < 200 || page.status >= 300) throw new VaultError("provider_changed", `Respuesta inesperada de Instagram (${page.status}).`);
    return findReels(parseJsonScripts(page.body));
  }

  /** Stories activas del perfil (vacío si no tiene). */
  private async storyMedia(bridge: IgBridge, username: string): Promise<ExtractedMedia[]> {
    const reels = (await this.storyPage(bridge, `/stories/${encodeURIComponent(username)}/`)).filter(
      (reel) => isObj(reel.user) && typeof reel.user.username === "string" && reel.user.username.toLowerCase() === username.toLowerCase(),
    );
    return parseReels({ reels_media: reels }, "story");
  }

  private async highlightMedia(bridge: IgBridge, highlightId: string): Promise<ExtractedMedia[]> {
    const reels = (await this.storyPage(bridge, `/stories/highlights/${encodeURIComponent(highlightId)}/`)).filter((reel) => String(reel.id) === `highlight:${highlightId}`);
    return parseReels({ reels_media: reels }, "highlight");
  }

  private async syncStories(row: ExtractedProfile & { id: number }, req: { profileId: number; accountId?: number | null }, ctx: OperationContext): Promise<SyncResult> {
    const bridge = this.bridge("account", req.accountId);
    ctx.stage("Buscando stories activas");
    const items = await this.storyMedia(bridge, row.username);
    return this.finishReelSync(row, "story", items, ctx);
  }

  private async syncHighlights(row: ExtractedProfile & { id: number }, req: { profileId: number; accountId?: number | null }, ctx: OperationContext): Promise<SyncResult> {
    const bridge = this.bridge("account", req.accountId);
    ctx.stage("Leyendo highlights");
    // La bandeja llega por GraphQL al abrir el perfil.
    const grid = await this.readGrid(bridge, row.username, { need: 0, checkpoint: null, ctx });
    const tray = findHighlights(grid.capture.payloads, row.username);
    if (!tray.length && !snapshotMatchesProfile(grid.capture.snapshot, row.username)) throw this.profileUnreadable(bridge, grid.capture.snapshot);
    if (grid.profile) this.repo.upsertProfile(grid.profile);
    const items: ExtractedMedia[] = [];
    for (const [i, highlight] of tray.entries()) {
      if (ctx.isCancelled()) break;
      ctx.stage(`Highlights ${i + 1}/${tray.length}`);
      const media = await this.highlightMedia(bridge, highlight.highlightId);
      if (media.length) highlight.itemCount = media.length;
      items.push(...media);
    }
    this.repo.upsertHighlights(req.profileId, tray);
    await this.cacheHighlightCovers(req.profileId);
    return this.finishReelSync(row, "highlight", items, ctx);
  }

  private async cacheHighlightCovers(profileId: number) {
    for (const cover of this.repo.highlightsNeedingCover(profileId)) {
      try {
        const asset = await downloadToStore(this.store, cover.url, { bucket: "thumbs", fallbackMime: "image/jpeg", maxBytes: 4 * 1024 * 1024 });
        this.repo.setHighlightCover(cover.id, asset.sha256);
      } catch {
        /* opcional */
      }
    }
  }

  private async finishReelSync(row: ExtractedProfile & { id: number }, kind: "story" | "highlight", items: ExtractedMedia[], ctx: OperationContext): Promise<SyncResult> {
    const before = new Set(this.repo.listMedia(row.id, kind).map((m) => m.id));
    const result = this.repo.upsertMedia(row.id, dedupe(items));
    const status: SyncStatus = ctx.isCancelled() ? "cancelled" : "complete";
    this.repo.saveSync({ profileId: row.id, kind, access: "account", cursor: null, lastCode: null, seen: items.length, status, stopReason: null });
    this.hooks.libraryChanged([row.id]);
    ctx.stage("Revelando miniaturas");
    await this.cacheThumbs(result.needThumb, row.id);
    return {
      profileId: row.id,
      kind,
      access: "account",
      status,
      newItems: result.ids.filter((id) => !before.has(id)).length,
      updatedItems: result.updated,
      publications: items.length,
      continuationAvailable: false,
      stopReason: null,
    };
  }

  // ---------------------------------------------------- publicaciones sueltas
  /** Resuelve una publicación por shortcode con la mejor fuente disponible. */
  async resolveShortcode(code: string, access: AccessMode, accountId?: number | null): Promise<{ media: ExtractedMedia[]; owner: string | null }> {
    const bridge = this.bridge(access, accountId);
    const mediaId = shortcodeToMediaId(code);
    if (access === "account" && mediaId) {
      const json = await bridge.apiGet(`/api/v1/media/${mediaId}/info/`);
      const item = Array.isArray(json.items) ? json.items.find(isObj) : null;
      if (item) {
        const media = extractMobileItem(item, { kind: "post" }).map((m) => ({ ...m, publicationCode: m.publicationCode ?? code }));
        return { media, owner: media[0]?.ownerUsername ?? null };
      }
    }
    let best: ExtractedMedia[] = [];
    try {
      const embed = await bridge.fetchText(`/p/${encodeURIComponent(code)}/embed/captioned/`);
      if (embed.status === 200) best = parseEmbedHtml(embed.body, code);
    } catch {
      /* se intenta con la página */
    }
    const embedComplete = best.length > 0 && best.every((m) => m.qualityVerified && m.bestUrl);
    if (!embedComplete) {
      const capture = await bridge.capture(`https://www.instagram.com/p/${code}/`, { batchSize: 0 });
      const denial = detectDenial(capture.snapshot);
      const found = collectMedia(capture.payloads, { kind: "post" }).filter((m) => m.publicationCode === code);
      if (found.length && (found.some((m) => m.qualityVerified) || found.length > best.length)) best = found;
      if (!best.length) {
        if (denial) throw new VaultError(denial.code, denial.message);
        if (access === "public") {
          throw new VaultError("public_blocked", "Instagram no mostró esta publicación sin iniciar sesión.", { canUseAccount: true });
        }
        throw new VaultError("not_found", "No se encontró contenido descargable en esta publicación.");
      }
    }
    return { media: best, owner: best[0]?.ownerUsername ?? null };
  }

  /** Resuelve un enlace para la vista "Descargar por enlace". */
  resolveUrl(url: string, access: AccessMode, accountId?: number | null): Promise<QuickResolution> {
    const parsed = parseInstagramUrl(url);
    if (!parsed) return Promise.reject(new VaultError("invalid_url", "Ese enlace no parece de Instagram."));
    if (parsed.type === "profile") return Promise.reject(new VaultError("invalid_input", "Es un perfil: búscalo en tu archivo."));
    return this.exclusive("Resolviendo enlace", null, async (ctx) => {
      let media: ExtractedMedia[] = [];
      let owner: string | null = null;
      let effectiveAccess = access;
      if (parsed.type === "post") {
        ctx.stage("Leyendo la publicación");
        ({ media, owner } = await this.resolveShortcode(parsed.shortcode, access, accountId));
      } else {
        if (access === "public") {
          throw new VaultError("public_blocked", "Instagram sólo muestra stories y highlights con una sesión iniciada.", { canUseAccount: true });
        }
        effectiveAccess = "account";
        const bridge = this.bridge("account", accountId);
        if (parsed.type === "story") {
          ctx.stage(`Buscando la story de @${parsed.username}`);
          media = (await this.storyMedia(bridge, parsed.username)).filter((m) => m.mediaId === `st_${parsed.storyId}` || m.mediaId.startsWith(`st_${parsed.storyId}_`));
          if (!media.length) throw new VaultError("not_found", "La story ya no está disponible (duran 24 horas).");
          owner = parsed.username;
        } else {
          ctx.stage("Leyendo el highlight");
          media = await this.highlightMedia(bridge, parsed.highlightId);
          owner = media[0]?.ownerUsername ?? null;
          if (!media.length) throw new VaultError("not_found", "Ese highlight no tiene contenido visible.");
        }
      }
      if (!media.length) throw new VaultError("not_found", "No se encontró contenido descargable.");
      ctx.stage("Preparando vista previa");
      const items = await Promise.all(
        media.map(async (m, index) => {
          let previewUrl: string | null = null;
          const source = m.thumbnailUrl ?? (m.mediaType === 1 ? m.bestUrl : null);
          if (source) {
            try {
              previewUrl = assetUrl((await downloadToStore(this.store, source, { bucket: "thumbs", fallbackMime: "image/jpeg", maxBytes: 6 * 1024 * 1024 })).sha256);
            } catch {
              previewUrl = null;
            }
          }
          return { key: `${index}`, mediaType: m.mediaType, width: m.width, height: m.height, previewUrl, childIndex: m.childIndex };
        }),
      );
      let ownerProfile: ExtractedProfile | null = null;
      let ownerAvatar: string | null = null;
      if (owner) {
        const existing = this.repo.listProfiles().find((p) => p.username === owner.toLowerCase());
        ownerAvatar = existing?.avatarUrl ?? null;
        ownerProfile = existing ? this.repo.profileRow(existing.id) : null;
      }
      const token = randomUUID();
      const resolution: QuickResolution = {
        token,
        parsed: parsed as ParsedUrl,
        access: effectiveAccess,
        owner: owner ? { username: owner.toLowerCase(), fullName: ownerProfile?.fullName ?? null, avatarUrl: ownerAvatar } : null,
        caption: media[0]?.caption ?? null,
        takenAt: media[0]?.takenAt ?? null,
        items,
      };
      this.resolutions.set(token, { resolution, media, ownerProfile, accountId: accountId ?? null, createdAt: Date.now() });
      for (const [key, value] of this.resolutions) if (Date.now() - value.createdAt > 3_600_000) this.resolutions.delete(key);
      return resolution;
    });
  }

  takeResolution(token: string): StoredResolution {
    const stored = this.resolutions.get(token);
    if (!stored) throw new VaultError("invalid_input", "La vista previa caducó; vuelve a pegar el enlace.");
    return stored;
  }

  // --------------------------------------------------- re-resolución de URLs
  /**
   * Obtiene URLs frescas para medios cuya firma caducó. Agrupa por
   * publicación/reel para no repetir consultas.
   */
  async refreshCandidates(rows: MediaDownloadRow[], accountId: number | null): Promise<Set<number>> {
    const refreshed = new Set<number>();
    const posts = new Map<string, MediaDownloadRow[]>();
    const stories = new Map<number, MediaDownloadRow[]>();
    const highlights = new Map<string, MediaDownloadRow[]>();
    for (const row of rows) {
      if (row.kind === "post" && row.publicationCode) posts.set(row.publicationCode, [...(posts.get(row.publicationCode) ?? []), row]);
      else if (row.kind === "story") stories.set(row.profileId, [...(stories.get(row.profileId) ?? []), row]);
      else if (row.kind === "highlight" && row.highlightId) highlights.set(row.highlightId, [...(highlights.get(row.highlightId) ?? []), row]);
    }
    const apply = (group: MediaDownloadRow[], fresh: ExtractedMedia[]) => {
      for (const row of group) {
        const match =
          fresh.find((m) => m.mediaId === row.mediaId) ??
          fresh.find((m) => m.publicationCode !== null && m.publicationCode === row.publicationCode && m.childIndex === row.childIndex);
        if (match && match.bestUrl) {
          this.repo.updateCandidate(row.id, match);
          refreshed.add(row.id);
        }
      }
    };
    for (const [code, group] of posts) {
      const isPrivate = group[0].isPrivate;
      const attempts: Array<{ access: AccessMode; accountId: number | null }> = isPrivate
        ? [{ access: "account", accountId }]
        : accountId
          ? [{ access: "public", accountId: null }, { access: "account", accountId }]
          : [{ access: "public", accountId: null }];
      for (const attempt of attempts) {
        try {
          const { media } = await this.resolveShortcode(code, attempt.access, attempt.accountId);
          apply(group, media);
          break;
        } catch (error) {
          if (error instanceof VaultError && ["rate_limited", "challenge_required"].includes(error.code)) throw error;
        }
      }
    }
    if (stories.size || highlights.size) {
      const bridge = this.bridge("account", accountId);
      for (const [profileId, group] of stories) {
        const row = this.repo.profileRow(profileId);
        if (!row) continue;
        apply(group, await this.storyMedia(bridge, row.username));
      }
      for (const [highlightId, group] of highlights) {
        apply(group, await this.highlightMedia(bridge, highlightId));
      }
    }
    return refreshed;
  }
}
