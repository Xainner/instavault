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
  findProfile,
  paginationHasMore,
  parseEmbedHtml,
  parseHighlightsTray,
  parseReels,
  profileFromSnapshot,
  profileFromUser,
  retainGridMedia,
  sanitizeUsername,
  snapshotIndicatesEmpty,
  snapshotIndicatesLoginWall,
  timelineFromProfileInfo,
  type PageSnapshot,
} from "./parse";
import type { ExtractedMedia, ExtractedProfile } from "./types";
import { parseInstagramUrl, shortcodeToMediaId } from "./url";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  private async profileInfo(bridge: IgBridge, username: string): Promise<{ profile: ExtractedProfile; raw: Obj; user: Obj }> {
    const raw = await bridge.apiGet(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`);
    const data = isObj(raw.data) ? raw.data : null;
    const user = data && isObj(data.user) ? data.user : null;
    if (!user) throw new VaultError("not_found", `Instagram no encontró a @${username}.`);
    const profile = profileFromUser(user, username);
    if (!profile) throw new VaultError("provider_changed", "Instagram devolvió un perfil sin nombre de usuario.");
    return { profile, raw, user };
  }

  private async profileFromPage(bridge: IgBridge, username: string, ctx: OperationContext): Promise<ExtractedProfile> {
    const capture = await bridge.capture(`https://www.instagram.com/${username}/`, { batchSize: 0, isCancelled: ctx.isCancelled });
    const denial = detectDenial(capture.snapshot);
    if (denial) throw new VaultError(denial.code, denial.message, { retryable: denial.code === "rate_limited" });
    for (const payload of capture.payloads) {
      const found = findProfile(payload, username);
      if (found) return found;
    }
    const fromDom = profileFromSnapshot(capture.snapshot, username);
    if (fromDom) return fromDom;
    if (bridge.access === "public") {
      throw new VaultError("public_blocked", "Instagram no entregó el perfil sin iniciar sesión. No se usó ninguna cuenta.", { canUseAccount: true });
    }
    throw new VaultError("provider_changed", "Instagram cambió la página y no se pudo leer el perfil.");
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
      let profile: ExtractedProfile;
      let timeline: ReturnType<typeof timelineFromProfileInfo> | null = null;
      try {
        const info = await this.profileInfo(bridge, username);
        profile = info.profile;
        timeline = timelineFromProfileInfo(info.raw);
      } catch (error) {
        if (!(error instanceof VaultError) || !["public_blocked", "provider_changed", "private_login_required"].includes(error.code)) throw error;
        if (error.code === "private_login_required" && access === "account") throw error;
        ctx.stage("Leyendo la página del perfil");
        profile = await this.profileFromPage(bridge, username, ctx);
      }
      if (ctx.isCancelled()) throw cancelled();
      const profileId = this.repo.upsertProfile(profile);
      ctx.stage("Guardando foto de perfil");
      await this.saveAvatar(profileId, profile.profilePicUrl);
      if (timeline && timeline.media.length) {
        const result = this.repo.upsertMedia(profileId, timeline.media);
        this.repo.saveSync({
          profileId,
          kind: "post",
          access,
          cursor: access === "public" ? timeline.endCursor : null,
          lastCode: timeline.codes.at(-1) ?? null,
          seen: timeline.codes.length,
          status: timeline.hasNext === false ? "complete" : "more_available",
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
    const media: ExtractedMedia[] = [];
    const codes: string[] = [];
    let status: SyncStatus = "complete";
    let stopReason: string | null = null;
    let cursor: string | null = null;

    if (req.access === "account") {
      ctx.stage("Leyendo el perfil con tu cuenta");
      const info = await this.profileInfo(bridge, row.username);
      this.repo.upsertProfile(info.profile);
      if (info.profile.isPrivate && info.user.followed_by_viewer === false) {
        throw new VaultError("private_not_followed", `@${row.username} es privada y tu cuenta no la sigue.`);
      }
      const igId = info.profile.igId;
      if (!igId) throw new VaultError("provider_changed", "Instagram no devolvió el identificador del perfil.");
      cursor = prior?.access === "account" ? prior.cursor : null;
      let skipUntil = prior && prior.access === "public" ? prior.lastCode : null;
      let pages = 0;
      for (;;) {
        if (ctx.isCancelled()) {
          status = "cancelled";
          stopReason = "Sincronización cancelada.";
          break;
        }
        ctx.stage(`Leyendo publicaciones · ${codes.length}/${batch === 5000 ? "todas" : batch}`);
        const json = await bridge.apiGet(`/api/v1/feed/user/${igId}/?count=33${cursor ? `&max_id=${encodeURIComponent(cursor)}` : ""}`);
        pages++;
        const items = Array.isArray(json.items) ? json.items.filter(isObj) : [];
        for (const item of items) {
          const code = typeof item.code === "string" ? item.code : null;
          if (skipUntil) {
            if (code === skipUntil) skipUntil = null;
            continue;
          }
          media.push(...extractMobileItem(item, { kind: "post" }));
          if (code) codes.push(code);
        }
        cursor = typeof json.next_max_id === "string" ? json.next_max_id : null;
        const more = json.more_available === true && cursor !== null;
        if (!more) {
          status = "complete";
          break;
        }
        if (codes.length >= batch) {
          status = "more_available";
          break;
        }
        if (pages > 400) {
          status = "more_available";
          break;
        }
        await sleep(1200 + Math.random() * 1300);
      }
    } else {
      if (row.isPrivate) {
        throw new VaultError("private_login_required", `@${row.username} es privada: usa una cuenta que la siga.`, { canUseAccount: true });
      }
      let hasNext: boolean | null = null;
      let apiFailed = false;
      if (!req.continuation) {
        ctx.stage("Leyendo el perfil en modo anónimo");
        try {
          const info = await this.profileInfo(bridge, row.username);
          this.repo.upsertProfile(info.profile);
          if (info.profile.isPrivate) {
            throw new VaultError("private_login_required", `@${row.username} es privada: usa una cuenta que la siga.`, { canUseAccount: true });
          }
          const timeline = timelineFromProfileInfo(info.raw);
          media.push(...timeline.media);
          codes.push(...timeline.codes);
          hasNext = timeline.hasNext;
          cursor = timeline.endCursor;
        } catch (error) {
          if (!(error instanceof VaultError) || !["public_blocked", "provider_changed"].includes(error.code)) throw error;
          apiFailed = true;
        }
      }
      const need = apiFailed || req.continuation ? batch : batch - codes.length;
      if (need > 0 && hasNext !== false) {
        ctx.stage("Recorriendo la cuadrícula");
        const checkpoint = req.continuation ? (prior?.lastCode ?? null) : (codes.at(-1) ?? null);
        const capture = await bridge.capture(`https://www.instagram.com/${row.username}/`, {
          batchSize: need,
          checkpoint,
          isCancelled: ctx.isCancelled,
        });
        const denial = detectDenial(capture.snapshot);
        const onProfile = snapshotMatchesProfile(capture.snapshot, row.username);
        if (!onProfile && !media.length) {
          throw new VaultError("public_blocked", "Instagram no dejó ver el perfil sin iniciar sesión. No se usó ninguna cuenta.", { canUseAccount: true });
        }
        const found = retainGridMedia(
          dedupe([...collectMedia(capture.payloads, { kind: "post", username: row.username }), ...collectMedia(capture.gridItems, { kind: "post" })]),
          capture.publicationCodes,
        );
        media.push(...found);
        codes.push(...capture.publicationCodes);
        if (ctx.isCancelled()) {
          status = "cancelled";
          stopReason = "Sincronización cancelada.";
        } else if (denial && denial.code === "challenge_required") {
          status = "challenge_required";
          stopReason = denial.message;
        } else if ((denial && denial.code === "rate_limited") || capture.httpStatus === 429) {
          status = "rate_limited";
          stopReason = "Instagram limitó temporalmente las consultas.";
        } else if (capture.httpStatus === 401 || capture.httpStatus === 403) {
          status = "anonymous_limit";
          stopReason = "Instagram pide iniciar sesión para seguir viendo este perfil.";
        } else if (snapshotIndicatesEmpty(capture.snapshot) || paginationHasMore(capture.payloads) === false) {
          status = "complete";
        } else if (capture.publicationCodes.length >= need) {
          status = "more_available";
        } else if (snapshotIndicatesLoginWall(capture.snapshot) || capture.stalled || !onProfile) {
          status = "anonymous_limit";
          stopReason = `Instagram limitó el modo anónimo tras ${codes.length} publicaciones.`;
        } else {
          status = "stalled";
          stopReason = "No se pudo confirmar el final del perfil; el avance quedó guardado.";
        }
      } else {
        status = hasNext === false ? "complete" : "more_available";
      }
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

  private async userIdFor(bridge: IgBridge, row: ExtractedProfile & { id: number }): Promise<string> {
    if (row.igId) return row.igId;
    const info = await this.profileInfo(bridge, row.username);
    this.repo.upsertProfile(info.profile);
    if (!info.profile.igId) throw new VaultError("provider_changed", "Instagram no devolvió el identificador del perfil.");
    return info.profile.igId;
  }

  private async syncStories(row: ExtractedProfile & { id: number }, req: { profileId: number; accountId?: number | null }, ctx: OperationContext): Promise<SyncResult> {
    const bridge = this.bridge("account", req.accountId);
    ctx.stage("Buscando stories activas");
    const igId = await this.userIdFor(bridge, row);
    const json = await bridge.apiGet(`/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(igId)}`);
    const items = parseReels(json, "story");
    return this.finishReelSync(row, "story", items, ctx);
  }

  private async syncHighlights(row: ExtractedProfile & { id: number }, req: { profileId: number; accountId?: number | null }, ctx: OperationContext): Promise<SyncResult> {
    const bridge = this.bridge("account", req.accountId);
    ctx.stage("Leyendo highlights");
    const igId = await this.userIdFor(bridge, row);
    const tray = parseHighlightsTray(await bridge.apiGet(`/api/v1/highlights/${encodeURIComponent(igId)}/highlights_tray/`));
    this.repo.upsertHighlights(req.profileId, tray);
    await this.cacheHighlightCovers(req.profileId);
    const items: ExtractedMedia[] = [];
    for (let i = 0; i < tray.length; i += 3) {
      if (ctx.isCancelled()) break;
      const group = tray.slice(i, i + 3);
      ctx.stage(`Highlights ${Math.min(i + 3, tray.length)}/${tray.length}`);
      const query = group.map((h) => `reel_ids=${encodeURIComponent(`highlight:${h.highlightId}`)}`).join("&");
      items.push(...parseReels(await bridge.apiGet(`/api/v1/feed/reels_media/?${query}`), "highlight"));
    }
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
          const info = await this.profileInfo(bridge, parsed.username);
          const json = await bridge.apiGet(`/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(info.profile.igId ?? "")}`);
          media = parseReels(json, "story").filter((m) => m.mediaId === `st_${parsed.storyId}` || m.mediaId.startsWith(`st_${parsed.storyId}_`));
          if (!media.length) throw new VaultError("not_found", "La story ya no está disponible (duran 24 horas).");
          owner = parsed.username;
        } else {
          ctx.stage("Leyendo el highlight");
          const json = await bridge.apiGet(`/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(`highlight:${parsed.highlightId}`)}`);
          media = parseReels(json, "highlight");
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
        const igId = await this.userIdFor(bridge, row);
        apply(group, parseReels(await bridge.apiGet(`/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(igId)}`), "story"));
      }
      for (const [highlightId, group] of highlights) {
        apply(group, parseReels(await bridge.apiGet(`/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(`highlight:${highlightId}`)}`), "highlight"));
      }
    }
    return refreshed;
  }
}
