import type { BrowserWindow } from "electron";
import type { VaultEvent } from "@shared/types";
import type { Repo } from "./db/repo";
import type { DownloadManager } from "./downloads/manager";
import type { AccountManager } from "./ig/accounts";
import type { InstagramService } from "./ig/service";
import type { LegacyPaths } from "./legacy/tauri-import";
import type { Updater } from "./updater";
import type { VaultStore } from "./vault/store";

export interface AppContext {
  repo: Repo;
  store: VaultStore;
  ig: InstagramService;
  downloads: DownloadManager;
  accounts: AccountManager;
  updater: Updater;
  legacy: LegacyPaths;
  dataDir: string;
  fixtures: boolean;
  window(): BrowserWindow | null;
  emit(event: VaultEvent): void;
}
