import type {
  Account,
  AccessMode,
  AppInfo,
  DownloadRequest,
  Highlight,
  Job,
  LegacyImportInfo,
  LibraryStats,
  Media,
  MediaKind,
  ParsedUrl,
  Profile,
  QuickHistoryEntry,
  QuickResolution,
  Settings,
  StorageInfo,
  SyncRequest,
  SyncResult,
  SyncState,
  UpdateState,
  VaultErrorShape,
  VaultEvent,
} from "./types";

/**
 * Métodos IPC expuestos al renderer. Cada método recibe un único objeto de
 * argumentos (validado en el proceso principal) y devuelve una promesa.
 */
export interface VaultApi {
  // App
  "app:info": () => AppInfo;
  "app:openExternal": (args: { url: string }) => void;

  // Biblioteca local (cero tráfico a Instagram)
  "library:stats": () => LibraryStats;
  "profiles:list": () => Profile[];
  "profiles:get": (args: { profileId: number }) => Profile | null;
  "profiles:setFavorite": (args: { profileId: number; favorite: boolean }) => void;
  "profiles:delete": (args: { profileId: number; deleteFiles: boolean }) => void;
  "profiles:touch": (args: { profileId: number }) => void;
  "media:list": (args: { profileId: number; kind?: MediaKind | null }) => Media[];
  "media:highlights": (args: { profileId: number }) => Highlight[];
  "media:remove": (args: { mediaIds: number[] }) => number;
  "sync:state": (args: { profileId: number }) => SyncState[];

  // Instagram (tráfico explícito)
  "ig:lookup": (args: { username: string; access: AccessMode; accountId?: number | null }) => Profile;
  "ig:sync": (args: SyncRequest) => SyncResult;
  "ig:cancel": () => void;
  "ig:parseUrl": (args: { url: string }) => ParsedUrl | null;
  "ig:resolveUrl": (args: { url: string; access: AccessMode; accountId?: number | null }) => QuickResolution;
  "ig:saveResolved": (args: { token: string; target: "library" | "device"; keys: string[] }) => { saved: number; profileId: number | null; folder: string | null };
  "quick:history": () => QuickHistoryEntry[];
  "quick:clearHistory": () => void;

  // Cuentas (sesión dedicada por cuenta)
  "accounts:list": () => Account[];
  "accounts:connect": () => Account | null;
  "accounts:cancelConnect": () => void;
  "accounts:disconnect": (args: { accountId: number }) => void;
  "accounts:delete": (args: { accountId: number }) => void;

  // Descargas
  "downloads:start": (args: DownloadRequest) => Job | null;
  "downloads:jobs": () => Job[];
  "downloads:cancel": (args: { jobId: number }) => void;
  "downloads:clearFinished": () => void;
  "downloads:reset": (args: { mediaIds: number[] }) => number;

  // Exportación
  "export:media": (args: { mediaIds: number[] }) => { exported: number; folder: string | null };
  "export:avatar": (args: { profileId: number }) => string | null;
  "export:reveal": (args: { mediaId: number }) => void;

  // Ajustes y almacén
  "settings:get": () => Settings;
  "settings:set": (args: Partial<Settings>) => Settings;
  "storage:info": () => StorageInfo;
  "storage:gc": () => { removed: number; bytes: number };
  "storage:open": () => void;

  // Importación 1.x
  "legacy:info": () => LegacyImportInfo;
  "legacy:import": () => { profiles: number; media: number; files: number };
  "legacy:removeBrowserProfile": () => boolean;

  // Actualizaciones
  "update:check": () => UpdateState;
  "update:install": () => void;
}

export type VaultMethod = keyof VaultApi;
export type VaultArgs<M extends VaultMethod> = Parameters<VaultApi[M]> extends [infer A] ? A : void;
export type VaultResult<M extends VaultMethod> = ReturnType<VaultApi[M]>;

export type IpcEnvelope<T> = { ok: true; data: T } | { ok: false; error: VaultErrorShape };

/** Lo que el preload expone en `window.vault`. */
export interface VaultBridge {
  invoke<M extends VaultMethod>(method: M, args?: VaultArgs<M>): Promise<IpcEnvelope<VaultResult<M>>>;
  on(listener: (event: VaultEvent) => void): () => void;
  platform: string;
}

export const IPC_INVOKE = "vault:invoke";
export const IPC_EVENT = "vault:event";
