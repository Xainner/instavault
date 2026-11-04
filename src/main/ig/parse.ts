import type { ErrorCode, MediaKind, MediaType } from "@shared/types";
import type { ExtractedHighlight, ExtractedMedia, ExtractedProfile, MediaSource } from "./types";

type Json = unknown;
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const int = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? Math.round(n) : null;
};
const text = (v: unknown): string | null => (typeof v === "string" && v.length ? v : null);
const idString = (v: unknown): string | null =>
  typeof v === "string" ? v : typeof v === "number" || typeof v === "bigint" ? String(v) : null;

/**
 * Recorre objetos anidados. Si `visit` devuelve true no desciende en ese
 * objeto (evita extraer dos veces los hijos de un carrusel ya procesado).
 */
export function walk(value: Json, visit: (obj: Obj) => boolean | void): void {
  if (Array.isArray(value)) {
    for (const child of value) walk(child, visit);
    return;
  }
  if (!isObj(value)) return;
  if (visit(value) === true) return;
  for (const child of Object.values(value)) walk(child, visit);
}

export function valueString(obj: Obj, names: string[]): string | null {
  for (const name of names) {
    const v = idString(obj[name]);
    if (v) return v;
  }
  return null;
}

// --------------------------------------------------------------- candidatos
export interface Candidate {
  url: string;
  width: number;
  height: number;
  bitrate: number;
  bytes: number;
}

/** Resolución primero; en empate, tamaño conocido y ancho. */
export function bestImage(candidates: unknown): Candidate | null {
  let best: Candidate | null = null;
  for (const raw of asArray(candidates)) {
    if (!isObj(raw)) continue;
    const url = text(raw.url) ?? text(raw.src);
    if (!url) continue;
    const c: Candidate = {
      url,
      width: int(raw.width) ?? int(raw.config_width) ?? 0,
      height: int(raw.height) ?? int(raw.config_height) ?? 0,
      bitrate: 0,
      bytes: int(raw.file_size) ?? 0,
    };
    if (!best || compareImage(c, best) > 0) best = c;
  }
  return best;
}

function compareImage(a: Candidate, b: Candidate): number {
  return a.width * a.height - b.width * b.height || a.bytes - b.bytes || a.width - b.width;
}

/** Resolución, luego bitrate, tamaño y ancho. */
export function bestVideo(versions: unknown): Candidate | null {
  let best: Candidate | null = null;
  for (const raw of asArray(versions)) {
    if (!isObj(raw)) continue;
    const url = text(raw.url);
    if (!url) continue;
    const c: Candidate = {
      url,
      width: int(raw.width) ?? 0,
      height: int(raw.height) ?? 0,
      bitrate: int(raw.bit_rate) ?? int(raw.bandwidth) ?? 0,
      bytes: int(raw.file_size) ?? 0,
    };
    if (!best || compareVideo(c, best) > 0) best = c;
  }
  return best;
}

function compareVideo(a: Candidate, b: Candidate): number {
  return a.width * a.height - b.width * b.height || a.bitrate - b.bitrate || a.bytes - b.bytes || a.width - b.width;
}

/** Miniatura: el candidato de imagen más cercano a `target` px de ancho. */
export function thumbCandidate(candidates: unknown, target = 480): string | null {
  let best: { url: string; d: number } | null = null;
  for (const raw of asArray(candidates)) {
    if (!isObj(raw)) continue;
    const url = text(raw.url) ?? text(raw.src);
    if (!url) continue;
    const width = int(raw.width) ?? int(raw.config_width) ?? 0;
    const d = Math.abs(width - target);
    if (!best || d < best.d) best = { url, d };
  }
  return best?.url ?? null;
}

// ---------------------------------------------------------- forma "móvil"
interface ExtractOpts {
  kind: MediaKind;
  highlightId?: string | null;
  source?: MediaSource;
}

function mobilePk(item: Obj): string | null {
  const pk = idString(item.pk);
  if (pk) return pk;
  const id = idString(item.id);
  return id ? id.split("_")[0] : null;
}

function prefixed(kind: MediaKind, id: string): string {
  if (kind === "story") return id.startsWith("st_") ? id : `st_${id}`;
  if (kind === "highlight") return id.startsWith("hl_") ? id : `hl_${id}`;
  return id;
}

function mobileSingle(item: Obj): { type: MediaType; best: Candidate; thumb: string | null; duration: number | null } | null {
  const isVideo = int(item.media_type) === 2 || Array.isArray(item.video_versions);
  const images = isObj(item.image_versions2) ? item.image_versions2.candidates : undefined;
  const thumb = thumbCandidate(images);
  if (isVideo) {
    const best = bestVideo(item.video_versions);
    if (best) return { type: 2, best, thumb, duration: typeof item.video_duration === "number" ? item.video_duration : null };
  }
  const best = bestImage(images);
  if (!best) return null;
  if (!best.width) best.width = int(item.original_width) ?? 0;
  if (!best.height) best.height = int(item.original_height) ?? 0;
  return { type: 1, best, thumb, duration: null };
}

/** Item de las APIs v1 / timeline GraphQL nueva (image_versions2, video_versions, carousel_media). */
export function extractMobileItem(item: Obj, opts: ExtractOpts): ExtractedMedia[] {
  const pk = mobilePk(item);
  if (!pk) return [];
  const code = text(item.code) ?? text(item.shortcode);
  const takenAt = int(item.taken_at) ?? int(item.taken_at_timestamp);
  const caption = isObj(item.caption) ? text(item.caption.text) : text(item.caption);
  const owner = isObj(item.user) ? text(item.user.username) : isObj(item.owner) ? text(item.owner.username) : null;
  const source = opts.source ?? "web_api";
  const children = asArray(item.carousel_media).filter(isObj);
  if (children.length) {
    const out: ExtractedMedia[] = [];
    children.forEach((child, index) => {
      const single = mobileSingle(child);
      if (!single) return;
      out.push({
        mediaId: prefixed(opts.kind, `${pk}_${index}`),
        publicationCode: code,
        childIndex: index,
        childCount: children.length,
        kind: opts.kind,
        highlightId: opts.highlightId ?? null,
        takenAt,
        caption,
        mediaType: single.type,
        bestUrl: single.best.url,
        thumbnailUrl: single.thumb,
        width: single.best.width || null,
        height: single.best.height || null,
        bitrate: single.best.bitrate || null,
        duration: single.duration,
        qualityVerified: true,
        source,
        ownerUsername: owner,
      });
    });
    return out;
  }
  const single = mobileSingle(item);
  if (!single) return [];
  return [
    {
      mediaId: prefixed(opts.kind, pk),
      publicationCode: code,
      childIndex: 0,
      childCount: 1,
      kind: opts.kind,
      highlightId: opts.highlightId ?? null,
      takenAt,
      caption,
      mediaType: single.type,
      bestUrl: single.best.url,
      thumbnailUrl: single.thumb,
      width: single.best.width || null,
      height: single.best.height || null,
      bitrate: single.best.bitrate || null,
      duration: single.duration,
      qualityVerified: true,
      source,
      ownerUsername: owner,
    },
  ];
}

// ------------------------------------------------------- forma GraphQL web
function graphCaption(node: Obj): string | null {
  const edges = isObj(node.edge_media_to_caption) ? asArray(node.edge_media_to_caption.edges) : [];
  const first = edges[0];
  return isObj(first) && isObj(first.node) ? text(first.node.text) : text(node.caption_text);
}

function graphSingle(node: Obj): { type: MediaType; best: Candidate; thumb: string | null; duration: number | null } | null {
  const dims = isObj(node.dimensions) ? node.dimensions : {};
  const width = int(dims.width) ?? 0;
  const height = int(dims.height) ?? 0;
  const resources = asArray(node.display_resources);
  const thumb = thumbCandidate(resources) ?? text(node.thumbnail_src) ?? text(node.display_url);
  const videoUrl = text(node.video_url);
  if (videoUrl) {
    return {
      type: 2,
      best: { url: videoUrl, width, height, bitrate: 0, bytes: 0 },
      thumb,
      duration: typeof node.video_duration === "number" ? node.video_duration : null,
    };
  }
  if (node.is_video === true) {
    // Video sin URL (respuestas anónimas recortadas): se resuelve al descargar.
    return {
      type: 2,
      best: { url: "", width, height, bitrate: 0, bytes: 0 },
      thumb,
      duration: typeof node.video_duration === "number" ? node.video_duration : null,
    };
  }
  const fromResources = bestImage(resources);
  const display = text(node.display_url);
  const best = fromResources ?? (display ? { url: display, width, height, bitrate: 0, bytes: 0 } : null);
  if (!best) return null;
  return { type: 1, best, thumb, duration: null };
}

export function extractGraphNode(node: Obj, opts: ExtractOpts): ExtractedMedia[] {
  const id = valueString(node, ["id", "pk"]);
  const code = text(node.shortcode) ?? text(node.code);
  if (!id) return [];
  const takenAt = int(node.taken_at_timestamp) ?? int(node.taken_at);
  const caption = graphCaption(node);
  const owner = isObj(node.owner) ? text(node.owner.username) : null;
  const dom = node.__instavault_dom === true;
  const source: MediaSource = dom ? "dom_fallback" : (opts.source ?? "web_response");
  const children = isObj(node.edge_sidecar_to_children)
    ? asArray(node.edge_sidecar_to_children.edges)
        .map((e) => (isObj(e) && isObj(e.node) ? e.node : null))
        .filter(isObj)
    : [];
  const base = { kind: opts.kind, highlightId: opts.highlightId ?? null, takenAt, caption, ownerUsername: owner };
  if (children.length) {
    const out: ExtractedMedia[] = [];
    children.forEach((child, index) => {
      const single = graphSingle(child);
      if (!single) return;
      out.push({
        ...base,
        mediaId: prefixed(opts.kind, `${id}_${index}`),
        publicationCode: code,
        childIndex: index,
        childCount: children.length,
        mediaType: single.type,
        bestUrl: single.best.url,
        thumbnailUrl: single.thumb,
        width: single.best.width || null,
        height: single.best.height || null,
        bitrate: null,
        duration: single.duration,
        qualityVerified: !dom,
        source,
      });
    });
    return out;
  }
  const single = graphSingle(node);
  if (!single) return [];
  return [
    {
      ...base,
      mediaId: prefixed(opts.kind, id),
      publicationCode: code,
      childIndex: 0,
      childCount: 1,
      mediaType: single.type,
      bestUrl: single.best.url,
      thumbnailUrl: single.thumb,
      width: single.best.width || null,
      height: single.best.height || null,
      bitrate: null,
      duration: single.duration,
      qualityVerified: !dom,
      source,
    },
  ];
}

/**
 * Extrae todos los medios de una respuesta arbitraria. Ignora objetos cuyo
 * dueño es otra cuenta (anuncios, sugerencias, comentarios).
 */
export function collectMedia(payload: Json, opts: ExtractOpts & { username?: string | null }): ExtractedMedia[] {
  const out: ExtractedMedia[] = [];
  const wanted = opts.username?.toLowerCase() ?? null;
  walk(payload, (obj) => {
    const owner =
      (isObj(obj.owner) ? text(obj.owner.username) : null) ?? (isObj(obj.user) && "media_type" in obj ? text(obj.user.username) : null);
    if (wanted && owner && owner.toLowerCase() !== wanted) return true;
    if ("media_type" in obj && (isObj(obj.image_versions2) || Array.isArray(obj.video_versions) || Array.isArray(obj.carousel_media))) {
      out.push(...extractMobileItem(obj, opts));
      return true;
    }
    const code = text(obj.shortcode) ?? text(obj.code);
    const hasVisual = text(obj.display_url) || text(obj.video_url) || text(obj.thumbnail_src);
    if (code && hasVisual && valueString(obj, ["id", "pk"])) {
      out.push(...extractGraphNode(obj, opts));
      return true;
    }
    return false;
  });
  return dedupe(out);
}

export function dedupe(items: ExtractedMedia[]): ExtractedMedia[] {
  const seen = new Map<string, ExtractedMedia>();
  for (const item of items) {
    const key = item.publicationCode ? `${item.publicationCode}#${item.childIndex}` : item.mediaId;
    const prev = seen.get(key);
    if (!prev || (!prev.qualityVerified && item.qualityVerified) || areaOf(item) > areaOf(prev)) seen.set(key, item);
  }
  return [...seen.values()];
}

const areaOf = (m: ExtractedMedia) => (m.width ?? 0) * (m.height ?? 0);

/** La cuadrícula del perfil es la frontera de confianza para posts. */
export function retainGridMedia(media: ExtractedMedia[], codes: string[]): ExtractedMedia[] {
  const allowed = new Set(codes);
  return media.filter((m) => m.publicationCode !== null && allowed.has(m.publicationCode));
}

/** `false` sólo con una señal explícita de fin; `null` si no se sabe. */
export function paginationHasMore(payloads: Json[]): boolean | null {
  let more = false;
  let end = false;
  for (const payload of payloads) {
    walk(payload, (obj) => {
      if (typeof obj.more_available === "boolean" && Array.isArray(obj.items)) {
        more ||= obj.more_available;
        end ||= !obj.more_available;
      }
      if (isObj(obj.page_info) && typeof obj.page_info.has_next_page === "boolean") {
        more ||= obj.page_info.has_next_page;
        end ||= !obj.page_info.has_next_page;
      }
    });
  }
  return more ? true : end ? false : null;
}

/**
 * Paginación de la cuadrícula del perfil (consulta GraphQL de la web). Ignora
 * otras conexiones que la página también pide, como el feed de inicio.
 * `null` si la página no pidió la cuadrícula por GraphQL.
 */
export function userTimelineHasMore(payloads: Json): boolean | null {
  let result: boolean | null = null;
  walk(payloads, (obj) => {
    const connection = obj.xdt_api__v1__feed__user_timeline_graphql_connection;
    if (isObj(connection) && isObj(connection.page_info) && typeof connection.page_info.has_next_page === "boolean") {
      result = result === false ? false : connection.page_info.has_next_page;
    }
  });
  return result;
}

// --------------------------------------------------------------- perfiles
function count(obj: Obj, nested: string, flat: string): number | null {
  const n = obj[nested];
  if (isObj(n) && int(n.count) !== null) return int(n.count);
  return int(obj[flat]);
}

export function profileFromUser(user: Obj, username?: string): ExtractedProfile | null {
  const name = text(user.username) ?? username ?? null;
  if (!name) return null;
  return {
    username: name.toLowerCase(),
    // `pk` primero: en las respuestas GraphQL nuevas `id` es el id de FB (1784…), no el pk.
    igId: valueString(user, ["pk", "pk_id", "id"]),
    fullName: text(user.full_name),
    biography: text(user.biography),
    externalUrl: text(user.external_url),
    followers: count(user, "edge_followed_by", "follower_count"),
    following: count(user, "edge_follow", "following_count"),
    mediaCount: count(user, "edge_owner_to_timeline_media", "media_count"),
    isPrivate: typeof user.is_private === "boolean" ? user.is_private : null,
    isVerified: user.is_verified === true,
    profilePicUrl:
      (isObj(user.hd_profile_pic_url_info) ? text(user.hd_profile_pic_url_info.url) : null) ??
      text(user.profile_pic_url_hd) ??
      text(user.profile_pic_url),
  };
}

const PROFILE_FIELDS = [
  "follower_count",
  "edge_followed_by",
  "following_count",
  "media_count",
  "edge_owner_to_timeline_media",
  "biography",
  "full_name",
  "is_private",
  "hd_profile_pic_url_info",
  "pk",
  "friendship_status",
];

/**
 * Busca el objeto de usuario del perfil pedido. Las respuestas traen copias
 * reducidas del mismo usuario (p. ej. el autor de cada post), así que se
 * elige la más completa.
 */
export function findUser(payload: Json, username: string): Obj | null {
  const wanted = username.toLowerCase();
  let best: Obj | null = null;
  let bestScore = 0;
  walk(payload, (obj) => {
    if (typeof obj.username !== "string" || obj.username.toLowerCase() !== wanted) return false;
    const shaped = "is_private" in obj || "profile_pic_url_hd" in obj || "profile_pic_url" in obj || "full_name" in obj;
    if (!shaped) return false;
    const score = 1 + PROFILE_FIELDS.filter((f) => f in obj && obj[f] !== null).length;
    if (score > bestScore) {
      best = obj;
      bestScore = score;
    }
    return false;
  });
  return best;
}

export function findProfile(payload: Json, username: string): ExtractedProfile | null {
  const user = findUser(payload, username);
  return user ? profileFromUser(user, username) : null;
}

/** Datos que la web incrusta en `<script type="application/json">` (SSR). */
export function parseJsonScripts(html: string): Json[] {
  const out: Json[] = [];
  for (const match of html.matchAll(/<script\b[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      out.push(JSON.parse(match[1]));
    } catch {
      /* bloque no JSON */
    }
  }
  return out;
}

/** Primeros posts incluidos en web_profile_info (edge_owner_to_timeline_media). */
export function timelineFromProfileInfo(payload: Json): { media: ExtractedMedia[]; codes: string[]; endCursor: string | null; hasNext: boolean | null } {
  const user = isObj(payload) && isObj(payload.data) && isObj(payload.data.user) ? payload.data.user : null;
  const timeline = user && isObj(user.edge_owner_to_timeline_media) ? user.edge_owner_to_timeline_media : null;
  if (!timeline) return { media: [], codes: [], endCursor: null, hasNext: null };
  const nodes = asArray(timeline.edges)
    .map((e) => (isObj(e) && isObj(e.node) ? e.node : null))
    .filter(isObj);
  const media = nodes.flatMap((node) => extractGraphNode(node, { kind: "post", source: "web_api" }));
  const codes = nodes.map((n) => text(n.shortcode)).filter((c): c is string => Boolean(c));
  const pageInfo = isObj(timeline.page_info) ? timeline.page_info : {};
  return {
    media,
    codes,
    endCursor: text(pageInfo.end_cursor),
    hasNext: typeof pageInfo.has_next_page === "boolean" ? pageInfo.has_next_page : null,
  };
}

// ---------------------------------------------------- stories / highlights
/** reels_media: { reels_media: [...] } o { reels: { id: {...} } }. */
export function parseReels(payload: Json, kind: "story" | "highlight"): ExtractedMedia[] {
  if (!isObj(payload)) return [];
  const reels: Obj[] = [];
  for (const r of asArray(payload.reels_media)) if (isObj(r)) reels.push(r);
  if (isObj(payload.reels)) for (const r of Object.values(payload.reels)) if (isObj(r)) reels.push(r);
  const out: ExtractedMedia[] = [];
  for (const reel of reels) {
    const reelId = idString(reel.id) ?? "";
    const highlightId = kind === "highlight" ? reelId.replace(/^highlight:/, "") : null;
    for (const item of asArray(reel.items)) {
      if (isObj(item)) out.push(...extractMobileItem(item, { kind, highlightId, source: "web_api" }));
    }
  }
  return out;
}

/**
 * Reels (stories o highlights) en cualquier forma: el HTML del visor de
 * stories los incrusta en `xdt_api__v1__feed__reels_media` y en
 * `xdt_api__v1__feed__reels_media__connection` (edges[].node).
 */
export function findReels(payload: Json): Obj[] {
  const out: Obj[] = [];
  const seen = new Set<string>();
  walk(payload, (obj) => {
    const id = idString(obj.id);
    if (!id || !Array.isArray(obj.items) || !("reel_type" in obj || "latest_reel_media" in obj || isObj(obj.user))) return false;
    if (!seen.has(id)) {
      seen.add(id);
      out.push(obj);
    }
    return true;
  });
  return out;
}

/** Highlights del perfil en la respuesta GraphQL de la bandeja (edges[].node con id "highlight:…"). */
export function findHighlights(payload: Json, username?: string): ExtractedHighlight[] {
  const wanted = username?.toLowerCase() ?? null;
  const out = new Map<string, ExtractedHighlight>();
  walk(payload, (obj) => {
    const id = idString(obj.id);
    if (!id?.startsWith("highlight:") || !("title" in obj)) return false;
    const owner = isObj(obj.user) ? text(obj.user.username) : null;
    if (wanted && owner && owner.toLowerCase() !== wanted) return true;
    const cover = isObj(obj.cover_media) && isObj(obj.cover_media.cropped_image_version) ? text(obj.cover_media.cropped_image_version.url) : null;
    const highlightId = id.replace(/^highlight:/, "");
    if (!out.has(highlightId)) {
      out.set(highlightId, { highlightId, title: text(obj.title) ?? "", coverUrl: cover, itemCount: int(obj.media_count) ?? (Array.isArray(obj.items) ? obj.items.length : 0) });
    }
    return true;
  });
  return [...out.values()];
}

export function parseHighlightsTray(payload: Json): ExtractedHighlight[] {
  if (!isObj(payload)) return [];
  const tray = asArray(payload.tray);
  const out: ExtractedHighlight[] = [];
  for (const raw of tray) {
    if (!isObj(raw)) continue;
    const id = idString(raw.id);
    if (!id) continue;
    const cover = isObj(raw.cover_media) && isObj(raw.cover_media.cropped_image_version) ? text(raw.cover_media.cropped_image_version.url) : null;
    out.push({
      highlightId: id.replace(/^highlight:/, ""),
      title: text(raw.title) ?? "",
      coverUrl: cover,
      itemCount: int(raw.media_count) ?? 0,
    });
  }
  return out;
}

// ------------------------------------------------------------------ embed
/** Página /p/<code>/embed/captioned/: busca shortcode_media o la imagen embebida. */
export function parseEmbedHtml(html: string, shortcode: string): ExtractedMedia[] {
  const candidates: Json[] = [];
  const contextMatch = html.match(/"contextJSON":"((?:\\.|[^"\\])*)"/);
  if (contextMatch) {
    try {
      candidates.push(JSON.parse(JSON.parse(`"${contextMatch[1]}"`)));
    } catch {
      /* formato distinto */
    }
  }
  const additional = html.match(/__additionalDataLoaded\(\s*['"][^'"]+['"]\s*,\s*(\{[\s\S]*?\})\s*\)\s*;/);
  if (additional) {
    try {
      candidates.push(JSON.parse(additional[1]));
    } catch {
      /* formato distinto */
    }
  }
  for (const candidate of candidates) {
    let media: Obj | null = null;
    walk(candidate, (obj) => {
      if (media) return true;
      if (isObj(obj.shortcode_media)) {
        media = obj.shortcode_media;
        return true;
      }
      return false;
    });
    if (media) {
      const items = extractGraphNode(media, { kind: "post", source: "embed" });
      if (items.length) return items;
    }
  }
  const img = html.match(/class="EmbeddedMediaImage"[^>]*src="([^"]+)"/) ?? html.match(/<img[^>]+class="EmbeddedMediaImage"[^>]+src="([^"]+)"/);
  if (img) {
    const url = img[1].replace(/&amp;/g, "&");
    return [
      {
        mediaId: `web_${shortcode}`,
        publicationCode: shortcode,
        childIndex: 0,
        childCount: 1,
        kind: "post",
        takenAt: null,
        caption: null,
        mediaType: 1,
        bestUrl: url,
        thumbnailUrl: url,
        width: null,
        height: null,
        bitrate: null,
        duration: null,
        qualityVerified: false,
        source: "embed",
      },
    ];
  }
  return [];
}

// ------------------------------------------------------- DOM / denegación
export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  description?: string;
  images: Array<{ src: string; alt: string; width: number; height: number; href: string }>;
  highlights?: Array<{ href: string; title: string }>;
}

export function snapshotIndicatesLoginWall(snapshot: PageSnapshot): boolean {
  const t = snapshot.text.toLowerCase();
  return (
    snapshot.url.includes("/accounts/login") ||
    t.includes("log in to see photos") ||
    t.includes("inicia sesión para ver") ||
    (t.includes("see more from") && t.includes("log in"))
  );
}

export function snapshotIndicatesEmpty(snapshot: PageSnapshot): boolean {
  const t = snapshot.text.toLowerCase();
  return ["no posts yet", "aún no hay publicaciones", "todavía no hay publicaciones"].some((m) => t.includes(m));
}

export function detectDenial(snapshot: PageSnapshot): { code: ErrorCode; message: string } | null {
  const t = snapshot.text.toLowerCase();
  if (snapshot.url.includes("/challenge/") || t.includes("challenge_required") || t.includes("checkpoint_required")) {
    return { code: "challenge_required", message: "Instagram pide una verificación de seguridad. No se harán más consultas." };
  }
  if (t.includes("page isn't available") || t.includes("sorry, this page") || t.includes("esta página no está disponible")) {
    return { code: "not_found", message: "Instagram no encontró esa página o perfil." };
  }
  if (t.includes("please wait a few minutes") || t.includes("feedback_required") || t.includes("try again later")) {
    return { code: "rate_limited", message: "Instagram limitó temporalmente las consultas. Espera unos minutos." };
  }
  return null;
}

export function profileFromSnapshot(snapshot: PageSnapshot, username: string): ExtractedProfile | null {
  if (snapshot.url.includes("/accounts/login")) return null;
  const wanted = username.toLowerCase();
  const titleMatches = snapshot.title.toLowerCase().includes(`@${wanted}`);
  const textMatches = snapshot.text.split("\n").some((line) => line.trim().toLowerCase() === wanted);
  if (!titleMatches && !textMatches) return null;
  const fullName =
    snapshot.title
      .split("(@")[0]
      ?.trim()
      .replace(/\s*•.*$/, "") || null;
  const lower = snapshot.text.toLowerCase();
  const isPrivate = lower.includes("this account is private") || lower.includes("esta cuenta es privada") || lower.includes("cuenta privada");
  const pic = snapshot.images
    .filter((img) => {
      const alt = img.alt.toLowerCase();
      return alt.includes(wanted) && (alt.includes("profile") || alt.includes("perfil"));
    })
    .sort((a, b) => b.width * b.height - a.width * a.height)[0];
  const counts = parseDescriptionCounts(snapshot.description ?? "");
  return {
    username: wanted,
    igId: null,
    fullName: fullName && fullName.toLowerCase() !== "instagram" ? fullName : null,
    biography: null,
    externalUrl: null,
    followers: counts.followers,
    following: counts.following,
    mediaCount: counts.posts,
    isPrivate,
    isVerified: false,
    profilePicUrl: pic?.src ?? null,
  };
}

/** meta description: "1,234 Followers, 56 Following, 78 Posts - ..." */
export function parseDescriptionCounts(description: string): { followers: number | null; following: number | null; posts: number | null } {
  const grab = (re: RegExp) => {
    const m = description.match(re);
    if (!m) return null;
    return parseCompactNumber(m[1]);
  };
  return {
    followers: grab(/([\d.,]+[KkMm]?)\s+(?:Followers|seguidores)/i),
    following: grab(/([\d.,]+[KkMm]?)\s+(?:Following|seguidos)/i),
    posts: grab(/([\d.,]+[KkMm]?)\s+(?:Posts|publicaciones)/i),
  };
}

export function parseCompactNumber(raw: string): number | null {
  const m = raw.trim().match(/^([\d.,]+)\s*([KkMm])?$/);
  if (!m) return null;
  const suffix = m[2]?.toLowerCase();
  if (suffix) {
    const n = Number(m[1].replace(/,/g, "."));
    if (!Number.isFinite(n)) return null;
    return Math.round(n * (suffix === "k" ? 1_000 : 1_000_000));
  }
  const n = Number(m[1].replace(/[.,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Imágenes de la cuadrícula del DOM como último recurso (calidad no verificada). */
export function domGridMedia(snapshot: PageSnapshot, kind: MediaKind): ExtractedMedia[] {
  const out: ExtractedMedia[] = [];
  for (const img of snapshot.images) {
    if (!(img.href.includes("/p/") || img.href.includes("/reel/")) || !img.src.startsWith("http")) continue;
    const parts = img.href.split("/").filter(Boolean);
    const marker = parts.findIndex((p) => p === "p" || p === "reel");
    const code = marker >= 0 ? parts[marker + 1] : null;
    if (!code) continue;
    out.push({
      mediaId: `web_${code}`,
      publicationCode: code,
      childIndex: 0,
      childCount: 1,
      kind,
      takenAt: null,
      caption: img.alt || null,
      mediaType: 1,
      bestUrl: img.src,
      thumbnailUrl: img.src,
      width: img.width || null,
      height: img.height || null,
      bitrate: null,
      duration: null,
      qualityVerified: false,
      source: "dom_fallback",
    });
  }
  return out;
}

/** Cuenta shortcodes nuevos de la cuadrícula a partir del checkpoint. */
export function recordPublicationCodes(
  items: Array<{ shortcode?: unknown }>,
  state: { checkpoint: string | null; reached: boolean; seen: Set<string>; codes: string[] },
  batchSize: number,
) {
  for (const item of items) {
    const code = typeof item.shortcode === "string" ? item.shortcode : null;
    if (!code) continue;
    if (!state.reached) {
      if (code === state.checkpoint) state.reached = true;
      continue;
    }
    if (state.codes.length < batchSize && !state.seen.has(code)) {
      state.seen.add(code);
      state.codes.push(code);
    }
  }
}

export function sanitizeUsername(value: string): string | null {
  const username = value.trim().replace(/^@/, "").toLowerCase();
  if (!username || username.length > 30 || !/^[a-z0-9._]+$/.test(username)) return null;
  return username;
}
