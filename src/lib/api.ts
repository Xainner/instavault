import { invoke } from "@tauri-apps/api/core";
import type { AccountInfo, Kind, Media, Profile } from "../types";

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
) => invoke<[number, number]>("download_profile", { accountId, profileId, kind, concurrency });

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
