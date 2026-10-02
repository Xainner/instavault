import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AccountInfo,
  DownloadJob,
  DownloadProgress,
  DownloadSummary,
  Kind,
  Media,
  Profile,
  ProfileStats,
  SyncAccessMode,
  SyncProgress,
  SyncSummary,
} from "../types";

// Cuentas privadas: sólo el navegador dedicado administra su sesión.
export const listAccounts = () => invoke<AccountInfo[]>("list_accounts");

export const deleteAccount = (accountId: number) =>
  invoke<void>("delete_account", { accountId });

// Perfiles
export const lookupPublicProfile = (username: string) =>
  invoke<Profile>("lookup_public_profile", { username });

export const addPrivateProfile = (username: string, accountId: number) =>
  invoke<Profile>("add_private_profile", { username, accountId });

export const listProfiles = () => invoke<Profile[]>("list_profiles");

export const deleteProfile = (profileId: number) =>
  invoke<void>("delete_profile", { profileId });

export const getMedia = (profileId: number, kind?: Kind) =>
  invoke<Media[]>("get_media", { profileId, kind });

// Sincronización
export const syncPosts = (accountId: number, username: string, maxPages = 30) =>
  invoke<number>("sync_posts", { accountId, username, maxPages });

export const syncStories = (accountId: number, username: string) =>
  invoke<number>("sync_stories", { accountId, username });

export const syncHighlights = (accountId: number, username: string) =>
  invoke<number>("sync_highlights", { accountId, username });

export const syncProfile = (profileId: number, kind: Kind, accountId?: number) =>
  invoke<number>("sync_profile", { profileId, kind, accountId: accountId || null });

export const syncFeed = (
  profileId: number,
  accountId: number | null,
  accessMode: SyncAccessMode,
  continuation: boolean,
  batchSize = 30,
) => invoke<SyncSummary>("sync_feed", {
  profileId,
  accountId,
  accessMode,
  continuation,
  batchSize,
});

export const getSyncProgress = (profileId: number, kind: Kind = "post") =>
  invoke<SyncProgress | null>("get_sync_progress", { profileId, kind });

export const cancelSync = (operationId: string) =>
  invoke<void>("cancel_sync", { operationId });

// Descarga
export const downloadProfile = (
  accountId: number,
  profileId: number,
  kind: Kind,
  concurrency = 4,
  includeFailed = false,
) =>
  invoke<DownloadSummary>("download_profile", {
    accountId,
    profileId,
    kind,
    concurrency,
    includeFailed,
  });

export const downloadMedia = (accountId: number, mediaPk: number) =>
  invoke<DownloadSummary>("download_media", { accountId, mediaPk });

/// Borra el archivo local de un medio y lo vuelve a pendiente.
export const resetDownload = (mediaPk: number) =>
  invoke<void>("reset_download", { mediaPk });

/// Borra todos los archivos descargados de un perfil (o un kind).
export const clearDownloads = (profileId: number, kind?: Kind | null) =>
  invoke<number>("clear_downloads", { profileId, kind: kind ?? null });

// Estado / favoritos / jobs
export const setProfileFavorite = (profileId: number, favorite: boolean) =>
  invoke<void>("set_profile_favorite", { profileId, favorite });

export const downloadAvatar = (profileId: number) =>
  invoke<string | null>("download_avatar", { profileId });

export const getProfileStats = () => invoke<ProfileStats[]>("get_profile_stats");

export const listDownloadJobs = (limit = 30) =>
  invoke<DownloadJob[]>("list_download_jobs", { limit });

export const clearFinishedJobs = () => invoke<void>("clear_finished_jobs");

/// Copia un archivo local a un destino elegido por el usuario.
export const exportMedia = (mediaPk: number, dest: string) =>
  invoke<string>("export_media", { mediaPk, dest });

export const exportAvatar = (profileId: number, dest: string) =>
  invoke<string>("export_avatar", { profileId, dest });

/// Suscripción a eventos de progreso (1 por ítem descargado).
export const onDownloadProgress = (cb: (p: DownloadProgress) => void) =>
  listen<DownloadProgress>("download:progress", (e) => cb(e.payload)) as Promise<UnlistenFn>;

export interface SyncState {
  operation_id: string;
  stage: string;
  kind?: string;
  profile_id?: number;
  publications?: number;
  assets?: number;
}
export const onSyncState = (cb: (state: SyncState) => void) =>
  listen<SyncState>("sync:state", (event) => cb(event.payload)) as Promise<UnlistenFn>;

// Login asistido (navegador propio de InstaVault + CDP)
export const loginOpen = () => invoke<void>("login_open");
export const connectPrivateAccount = () => invoke<void>("connect_private_account");
export const loginCheck = () => invoke<AccountInfo | null>("login_check");
export const loginCancel = () => invoke<void>("login_cancel");
export const disconnectPrivateAccount = (accountId: number) =>
  invoke<void>("disconnect_private_account", { accountId });
