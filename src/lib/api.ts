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
} from "../types";

// Cuentas
export const addAccount = (username: string, cookieHeader: string) =>
  invoke<AccountInfo>("add_account", { username, cookieHeader });

export const validateAccount = (accountId: number) =>
  invoke<AccountInfo>("validate_account", { accountId });

export const listAccounts = () => invoke<AccountInfo[]>("list_accounts");

export const deleteAccount = (accountId: number) =>
  invoke<void>("delete_account", { accountId });

// Perfiles
export const fetchProfile = (accountId: number, username: string) =>
  invoke<Profile>("fetch_profile", { accountId, username });
export const warmSearchEngine = () => invoke<void>("warm_search_engine");

export const listProfiles = () => invoke<Profile[]>("list_profiles");

export const deleteProfile = (profileId: number) =>
  invoke<void>("delete_profile", { profileId });

export const getMedia = (profileId: number, kind?: Kind) =>
  invoke<Media[]>("get_media", { profileId, kind });

// Sincronización
export const syncPosts = (accountId: number, username: string, maxPages = 4) =>
  invoke<number>("sync_posts", { accountId, username, maxPages });

export const syncStories = (accountId: number, username: string) =>
  invoke<number>("sync_stories", { accountId, username });

export const syncHighlights = (accountId: number, username: string) =>
  invoke<number>("sync_highlights", { accountId, username });

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

// Navegador
export interface BrowserProfile {
  browser: string;
  profile: string;
  cookiesPath: string;
}

export const listBrowserProfiles = () =>
  invoke<BrowserProfile[]>("list_browser_profiles");

export const importBrowserAccount = (index: number) =>
  invoke<AccountInfo>("import_browser_account", { index });

// Login asistido (navegador propio de InstaVault + CDP)
export const loginOpen = () => invoke<void>("login_open");
export const loginCheck = () => invoke<AccountInfo | null>("login_check");
export const loginCancel = () => invoke<void>("login_cancel");
