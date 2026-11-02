import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, app, nativeTheme, session, shell } from "electron";
import { IPC_EVENT } from "@shared/api";
import type { VaultEvent } from "@shared/types";
import type { AppContext } from "./context";
import { Repo } from "./db/repo";
import { DownloadManager } from "./downloads/manager";
import { AccountManager } from "./ig/accounts";
import { cleanUserAgent } from "./ig/bridge";
import { InstagramService } from "./ig/service";
import { registerIpc } from "./ipc";
import { Updater } from "./updater";
import { handleVaultProtocol, registerVaultScheme } from "./vault/protocol";
import { VaultStore } from "./vault/store";

const here = fileURLToPath(new URL(".", import.meta.url));

// node:sqlite es estable en la práctica pero emite un aviso experimental.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning?.message;
  if (/SQLite is an experimental feature/i.test(text ?? "")) return;
  return (emitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

if (process.env.INSTAVAULT_USER_DATA) app.setPath("userData", process.env.INSTAVAULT_USER_DATA);
app.setName("InstaVault");
app.setAppUserModelId("com.xainner.instavault");
registerVaultScheme();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;
  let context: AppContext | null = null;

  const emit = (event: VaultEvent) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC_EVENT, event);
  };

  const createWindow = () => {
    const isMac = process.platform === "darwin";
    mainWindow = new BrowserWindow({
      width: 1440,
      height: 920,
      minWidth: 1040,
      minHeight: 680,
      show: false,
      title: "InstaVault",
      backgroundColor: "#0f0d0c",
      titleBarStyle: "hidden",
      ...(isMac
        ? { trafficLightPosition: { x: 18, y: 16 } }
        : { titleBarOverlay: { color: "#0f0d0c", symbolColor: "#cdbfae", height: 44 } }),
      ...(app.isPackaged ? {} : { icon: join(here, "../../build/icon.png") }),
      webPreferences: {
        preload: join(here, "../preload/index.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    mainWindow.once("ready-to-show", () => {
      if (!process.env.INSTAVAULT_HIDE_WINDOW) mainWindow?.show();
    });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\/(www\.)?(instagram\.com|github\.com)\//i.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    mainWindow.webContents.on("will-navigate", (event, url) => {
      const allowed = process.env.ELECTRON_RENDERER_URL ? url.startsWith(process.env.ELECTRON_RENDERER_URL) : url.startsWith("file://");
      if (!allowed) event.preventDefault();
    });
    mainWindow.on("closed", () => {
      mainWindow = null;
    });
    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    else void mainWindow.loadFile(join(here, "../renderer/index.html"));
  };

  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    nativeTheme.themeSource = "dark";
    app.userAgentFallback = cleanUserAgent();
    // La ventana principal no necesita permisos del sistema (cámara, notificaciones…).
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

    const dataDir = app.getPath("userData");
    const repo = new Repo(join(dataDir, "library.db"));
    const store = new VaultStore(join(dataDir, "vault"), repo);
    await store.cleanTmp();
    handleVaultProtocol(repo, store);

    const ig = new InstagramService(repo, store, {
      activity: (activity) => emit({ type: "remote:activity", activity }),
      libraryChanged: (profileIds) => emit({ type: "library:changed", profileIds }),
      mediaChanged: (profileId, mediaIds) => emit({ type: "media:changed", profileId, mediaIds }),
    });
    const downloads = new DownloadManager(repo, store, ig, {
      progress: (progress) => emit({ type: "job:progress", progress }),
      finished: (job) => {
        emit({ type: "job:finished", job });
        if (job.profileId) emit({ type: "library:changed", profileIds: [job.profileId] });
      },
      mediaChanged: (profileId, mediaIds) => emit({ type: "media:changed", profileId, mediaIds }),
    });
    const accounts = new AccountManager(
      repo,
      store,
      () => emit({ type: "accounts:changed" }),
      (accountId) => ig.dropAccountBridge(accountId),
    );
    const updater = new Updater((update) => emit({ type: "update", update }));
    const appData = app.getPath("appData");
    const fixtures = Boolean(process.env.INSTAVAULT_SEED_DIR);

    context = {
      repo,
      store,
      ig,
      downloads,
      accounts,
      updater,
      dataDir,
      fixtures,
      legacy: {
        database: process.env.INSTAVAULT_LEGACY_DB ?? join(appData, "com.xainner.instavault", "instakeeper.db"),
        browserProfile: join(appData, "InstaVault", "browser-profile"),
        backupDir: join(dataDir, "backups"),
      },
      window: () => mainWindow,
      emit,
    };

    if (fixtures) {
      const { seedDemoLibrary } = await import("./dev/seed");
      await seedDemoLibrary(repo, store, process.env.INSTAVAULT_SEED_DIR!, Number(process.env.INSTAVAULT_SEED_BULK ?? 0));
    }

    registerIpc(context);
    createWindow();

    if (app.isPackaged) setTimeout(() => void updater.check(), 6000);
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (!mainWindow && context) createWindow();
  });

  app.on("before-quit", () => {
    if (!context) return;
    context.downloads.cancelAll();
    context.ig.shutdown();
  });

  app.on("will-quit", () => {
    try {
      context?.repo.close();
    } catch {
      /* ya cerrada */
    }
  });
}
