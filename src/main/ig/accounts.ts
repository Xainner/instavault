import { randomUUID } from "node:crypto";
import { BrowserWindow, session } from "electron";
import type { Account } from "@shared/types";
import type { Repo } from "../db/repo";
import { VaultError } from "../errors";
import { downloadToStore } from "../net/cdn";
import type { VaultStore } from "../vault/store";
import { IgBridge, cleanUserAgent } from "./bridge";
import { CURRENT_USER_SCRIPT } from "./scripts";

const LOGIN_URL = "https://www.instagram.com/accounts/login/";
const ALLOWED_LOGIN_HOSTS = /(^|\.)(instagram\.com|facebook\.com|fbcdn\.net)$/i;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Cada cuenta vive en su propia partición persistente de Chromium. El usuario
 * inicia sesión en una ventana visible de Instagram; la app sólo comprueba que
 * existe sesión y lee el id numérico del usuario. Las cookies nunca se copian.
 */
export class AccountManager {
  private pending: { window: BrowserWindow; promise: Promise<Account | null>; cancel: () => void } | null = null;

  constructor(
    private readonly repo: Repo,
    private readonly store: VaultStore,
    private readonly onChanged: () => void,
    private readonly dropBridge: (accountId: number) => void,
  ) {}

  connect(parent: BrowserWindow | null): Promise<Account | null> {
    if (this.pending) {
      this.pending.window.focus();
      return this.pending.promise;
    }
    const partition = `persist:ig-acct-${randomUUID()}`;
    const ses = session.fromPartition(partition);
    ses.setUserAgent(cleanUserAgent());
    const window = new BrowserWindow({
      parent: parent ?? undefined,
      width: 470,
      height: 780,
      minWidth: 380,
      title: "Conectar Instagram · InstaVault",
      backgroundColor: "#121010",
      autoHideMenuBar: true,
      webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      try {
        if (!ALLOWED_LOGIN_HOSTS.test(new URL(url).hostname)) event.preventDefault();
      } catch {
        event.preventDefault();
      }
    });
    void window.loadURL(LOGIN_URL);

    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (timer) clearInterval(timer);
      this.pending = null;
    };
    const promise = new Promise<Account | null>((resolve, reject) => {
      const finish = (value: Account | null, error?: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (!window.isDestroyed()) window.close();
        if (error) reject(error);
        else resolve(value);
      };
      window.on("closed", () => {
        if (!settled) {
          settled = true;
          cleanup();
          void ses.clearStorageData();
          resolve(null);
        }
      });
      let checking = false;
      timer = setInterval(async () => {
        if (checking || settled) return;
        checking = true;
        try {
          const [userCookie] = await ses.cookies.get({ url: "https://www.instagram.com", name: "ds_user_id" });
          const [sessionCookie] = await ses.cookies.get({ url: "https://www.instagram.com", name: "sessionid" });
          if (!userCookie || !sessionCookie) return;
          const account = await this.register(partition, userCookie.value, window);
          finish(account);
        } catch (error) {
          finish(null, error instanceof VaultError ? error : new VaultError("provider_changed", `No se pudo confirmar la sesión: ${(error as Error).message}`));
        } finally {
          checking = false;
        }
      }, 1500);
    });
    this.pending = {
      window,
      promise,
      cancel: () => {
        if (!window.isDestroyed()) window.close();
      },
    };
    return promise;
  }

  cancelConnect() {
    this.pending?.cancel();
  }

  private async register(partition: string, igUserId: string, window: BrowserWindow): Promise<Account> {
    const bridge = new IgBridge(partition, "account");
    let username: string | null = null;
    let avatarUrl: string | null = null;
    try {
      const info = await bridge.apiGet(`/api/v1/users/${encodeURIComponent(igUserId)}/info/`);
      const user = isObj(info.user) ? info.user : null;
      if (user) {
        username = typeof user.username === "string" ? user.username : null;
        const hd = isObj(user.hd_profile_pic_url_info) ? user.hd_profile_pic_url_info.url : null;
        avatarUrl = typeof hd === "string" ? hd : typeof user.profile_pic_url === "string" ? user.profile_pic_url : null;
      }
    } catch {
      /* respaldo por DOM */
    } finally {
      bridge.destroy();
    }
    if (!username && !window.isDestroyed()) {
      username = (await window.webContents.executeJavaScript(CURRENT_USER_SCRIPT, true).catch(() => null)) as string | null;
    }
    if (!username) throw new VaultError("provider_changed", "Se inició sesión, pero no se pudo identificar el nombre de usuario.");
    username = username.toLowerCase();
    let avatarSha: string | null = null;
    if (avatarUrl) {
      try {
        avatarSha = (await downloadToStore(this.store, avatarUrl, { bucket: "avatars", fallbackMime: "image/jpeg", maxBytes: 6 * 1024 * 1024 })).sha256;
      } catch {
        avatarSha = null;
      }
    }
    const previous = this.repo.listAccounts().find((a) => a.username === username);
    const previousPartition = previous ? this.repo.getAccount(previous.id)?.partition : null;
    const id = this.repo.upsertAccount({ username, igUserId, partition, avatarSha });
    if (previousPartition && previousPartition !== partition) {
      this.dropBridge(id);
      void session.fromPartition(previousPartition).clearStorageData();
    }
    const settings = this.repo.getSettings();
    if (!settings.defaultAccountId || !this.repo.getAccount(settings.defaultAccountId)) this.repo.setSettings({ defaultAccountId: id });
    this.onChanged();
    const account = this.repo.listAccounts().find((a) => a.id === id);
    if (!account) throw new VaultError("internal", "No se pudo guardar la cuenta.");
    return account;
  }

  /** Cierra la sesión borrando los datos de su partición. */
  async disconnect(accountId: number) {
    const account = this.repo.getAccount(accountId);
    if (!account) return;
    this.dropBridge(accountId);
    await session.fromPartition(account.partition).clearStorageData();
    this.repo.setAccountStatus(accountId, "reconnect_required");
    this.onChanged();
  }

  async remove(accountId: number) {
    const account = this.repo.getAccount(accountId);
    if (!account) return;
    this.dropBridge(accountId);
    await session.fromPartition(account.partition).clearStorageData();
    this.repo.deleteAccount(accountId);
    const settings = this.repo.getSettings();
    if (settings.defaultAccountId === accountId) {
      this.repo.setSettings({ defaultAccountId: this.repo.listAccounts().find((a) => a.status === "valid")?.id ?? null });
    }
    this.onChanged();
  }
}
