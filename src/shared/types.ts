// Contrato compartido entre el proceso principal y la interfaz.

export type MediaKind = "post" | "story" | "highlight";
export type MediaStatus = "pending" | "downloading" | "downloaded" | "failed";
/** 1 = foto, 2 = video. Los carruseles se guardan pieza por pieza. */
export type MediaType = 1 | 2;

export type AccessMode = "public" | "account";
export type FallbackPolicy = "ask" | "auto" | "never";

export type ErrorCode =
  | "public_blocked"
  | "anonymous_limit"
  | "private_login_required"
  | "private_not_followed"
  | "challenge_required"
  | "rate_limited"
  | "not_found"
  | "network"
  | "cancelled"
  | "provider_changed"
  | "invalid_url"
  | "busy"
  | "invalid_input"
  | "internal";

export interface VaultErrorShape {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  /** La operación podría completarse usando la cuenta conectada. */
  canUseAccount?: boolean;
}

export interface Account {
  id: number;
  username: string;
  igUserId: string | null;
  status: "valid" | "reconnect_required";
  avatarUrl: string | null;
  addedAt: number;
  lastValid: number | null;
}

export interface KindStats {
  kind: MediaKind;
  total: number;
  downloaded: number;
  failed: number;
  pending: number;
  lastSync: number | null;
}

export interface Profile {
  id: number;
  username: string;
  igId: string | null;
  fullName: string | null;
  biography: string | null;
  externalUrl: string | null;
  followers: number | null;
  following: number | null;
  mediaCount: number | null;
  isPrivate: boolean | null;
  isVerified: boolean;
  isFavorite: boolean;
  avatarUrl: string | null;
  fetchedAt: number | null;
  createdAt: number;
  lastActivity: number | null;
  /** Hasta 4 miniaturas locales recientes para el mosaico de portada. */
  cover: string[];
  stats: KindStats[];
  bytes: number;
}

export interface Media {
  id: number;
  profileId: number;
  kind: MediaKind;
  mediaId: string;
  publicationCode: string | null;
  childIndex: number;
  childCount: number;
  highlightId: string | null;
  takenAt: number | null;
  caption: string | null;
  mediaType: MediaType;
  width: number | null;
  height: number | null;
  bitrate: number | null;
  duration: number | null;
  qualityVerified: boolean;
  source: string | null;
  status: MediaStatus;
  error: string | null;
  /** vault:// del archivo completo, si ya está descargado. */
  contentUrl: string | null;
  /** vault:// de la miniatura local, si existe. */
  thumbUrl: string | null;
  bytes: number | null;
  sha256: string | null;
  mime: string | null;
  downloadedAt: number | null;
}

export interface Highlight {
  id: number;
  profileId: number;
  highlightId: string;
  title: string;
  coverUrl: string | null;
  itemCount: number;
}

export type SyncStatus =
  | "complete"
  | "more_available"
  | "anonymous_limit"
  | "stalled"
  | "rate_limited"
  | "challenge_required"
  | "cancelled";

export interface SyncState {
  profileId: number;
  kind: MediaKind;
  access: AccessMode;
  status: SyncStatus;
  seen: number;
  stopReason: string | null;
  updatedAt: number;
  lastSync: number | null;
}

export interface SyncResult {
  profileId: number;
  kind: MediaKind;
  access: AccessMode;
  status: SyncStatus;
  newItems: number;
  updatedItems: number;
  publications: number;
  continuationAvailable: boolean;
  stopReason: string | null;
}

export interface SyncRequest {
  profileId: number;
  kind: MediaKind;
  access: AccessMode;
  accountId?: number | null;
  continuation?: boolean;
  batchSize?: number;
}

export interface Job {
  id: number;
  profileId: number | null;
  username: string | null;
  label: string;
  total: number;
  ok: number;
  failed: number;
  status: "running" | "done" | "cancelled";
  startedAt: number;
  finishedAt: number | null;
}

export interface JobProgress {
  jobId: number;
  profileId: number | null;
  total: number;
  done: number;
  ok: number;
  failed: number;
  bytesPerSecond: number;
  /** Última pieza terminada (para la tira "Revelando"). */
  last: { mediaId: number; thumbUrl: string | null; ok: boolean } | null;
}

export interface DownloadRequest {
  profileId?: number;
  kind?: MediaKind;
  mediaIds?: number[];
  includeFailed?: boolean;
  /** Fuerza re-descargar aunque ya exista (reemplaza el archivo). */
  force?: boolean;
  accountId?: number | null;
}

export type ParsedUrl =
  | { type: "post"; shortcode: string; url: string }
  | { type: "story"; username: string; storyId: string; url: string }
  | { type: "highlight"; highlightId: string; url: string }
  | { type: "profile"; username: string; url: string };

export interface QuickItem {
  key: string;
  mediaType: MediaType;
  width: number | null;
  height: number | null;
  previewUrl: string | null;
  childIndex: number;
}

export interface QuickResolution {
  token: string;
  parsed: ParsedUrl;
  access: AccessMode;
  owner: { username: string; fullName: string | null; avatarUrl: string | null } | null;
  caption: string | null;
  takenAt: number | null;
  items: QuickItem[];
}

export interface QuickHistoryEntry {
  id: number;
  url: string;
  ownerUsername: string | null;
  itemCount: number;
  thumbUrl: string | null;
  savedToLibrary: boolean;
  createdAt: number;
}

export interface Settings {
  concurrency: number;
  fallbackPolicy: FallbackPolicy;
  defaultAccountId: number | null;
  postsBatchSize: number;
  thumbnailsOnSync: boolean;
  onboardingDone: boolean;
  reduceMotion: boolean;
}

export interface LibraryStats {
  profiles: number;
  media: number;
  downloaded: number;
  bytes: number;
  failed: number;
}

export interface StorageInfo {
  dataDir: string;
  vaultDir: string;
  bytes: number;
  assets: number;
  orphanBytes: number;
}

export interface LegacyImportInfo {
  available: boolean;
  path: string | null;
  profiles: number;
  media: number;
  downloaded: number;
  done: boolean;
  legacyBrowserProfile: string | null;
}

export interface AppInfo {
  version: string;
  platform: string;
  electron: string;
  chrome: string;
  dataDir: string;
  fixtures: boolean;
}

export type UpdateState =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string; notes: string | null }
  | { state: "none" }
  | { state: "downloading"; percent: number }
  | { state: "ready"; version: string }
  | { state: "error"; message: string };

export interface RemoteActivity {
  operationId: string;
  label: string;
  stage: string;
  profileId: number | null;
  cancellable: boolean;
}

export type VaultEvent =
  | { type: "library:changed"; profileIds: number[] }
  | { type: "media:changed"; profileId: number; mediaIds: number[] }
  | { type: "job:progress"; progress: JobProgress }
  | { type: "job:finished"; job: Job }
  | { type: "remote:activity"; activity: RemoteActivity | null }
  | { type: "import:progress"; phase: string; done: number; total: number; thumbUrl: string | null }
  | { type: "accounts:changed" }
  | { type: "update"; update: UpdateState };
