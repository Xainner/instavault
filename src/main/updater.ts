import { app } from "electron";
import electronUpdater from "electron-updater";
import type { UpdateState } from "@shared/types";

const { autoUpdater } = electronUpdater;

/** Actualizaciones firmadas desde GitHub Releases (latest.yml de electron-builder). */
export class Updater {
  private state: UpdateState = { state: "idle" };
  private wired = false;

  constructor(private readonly emit: (state: UpdateState) => void) {}

  private set(state: UpdateState) {
    this.state = state;
    this.emit(state);
  }

  private wire() {
    if (this.wired) return;
    this.wired = true;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("checking-for-update", () => this.set({ state: "checking" }));
    autoUpdater.on("update-available", (info) =>
      this.set({ state: "available", version: info.version, notes: typeof info.releaseNotes === "string" ? info.releaseNotes : null }),
    );
    autoUpdater.on("update-not-available", () => this.set({ state: "none" }));
    autoUpdater.on("download-progress", (p) => this.set({ state: "downloading", percent: Math.round(p.percent) }));
    autoUpdater.on("update-downloaded", (info) => this.set({ state: "ready", version: info.version }));
    autoUpdater.on("error", (error) => this.set({ state: "error", message: error?.message ?? String(error) }));
  }

  get current(): UpdateState {
    return this.state;
  }

  async check(): Promise<UpdateState> {
    if (!app.isPackaged) {
      this.set({ state: "none" });
      return this.state;
    }
    this.wire();
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      this.set({ state: "error", message: (error as Error).message });
    }
    return this.state;
  }

  async install() {
    if (this.state.state === "ready") {
      autoUpdater.quitAndInstall();
      return;
    }
    if (this.state.state === "available") {
      this.wire();
      await autoUpdater.downloadUpdate();
    }
  }
}
