import { BrowserWindow, app, session, type Session, type WebContents } from "electron";
import type { AccessMode } from "@shared/types";
import { VaultError, cancelled } from "../errors";
import { classifyJson, parseJsonLoose, type RawResponse } from "./classify";
import { recordPublicationCodes, type PageSnapshot } from "./parse";
import { CURRENT_USER_SCRIPT, SCROLL_SCRIPT, SNAPSHOT_SCRIPT, fetchScript } from "./scripts";

const ORIGIN = "https://www.instagram.com";

/** User agent de Chrome sin los marcadores de Electron ni del nombre de la app. */
export function cleanUserAgent(): string {
  return app.userAgentFallback
    .replace(/\sElectron\/\S+/i, "")
    .replace(new RegExp(`\\s${app.getName()}\\/\\S+`, "i"), "")
    .replace(/\sinstavault\/\S+/i, "");
}

export function isInstagramUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "www.instagram.com" || u.hostname === "instagram.com");
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface CaptureOptions {
  /** Publicaciones nuevas a reunir haciendo scroll (0 = sin scroll). */
  batchSize: number;
  /** Shortcode a partir del cual empezar a contar (reanudación). */
  checkpoint?: string | null;
  timeoutMs?: number;
  isCancelled?: () => boolean;
}

export interface CaptureResult {
  payloads: unknown[];
  gridItems: unknown[];
  publicationCodes: string[];
  stalled: boolean;
  httpStatus: number | null;
  checkpointReached: boolean;
  snapshot: PageSnapshot;
}

/**
 * Motor de una partición de Chromium: una ventana oculta abierta en
 * instagram.com que hace peticiones same-origin y navega páginas reales.
 * Todas las llamadas se serializan y se espacian con jitter.
 */
export class IgBridge {
  private window: BrowserWindow | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private lastAction = 0;

  constructor(
    readonly partition: string,
    readonly access: AccessMode,
  ) {}

  get session(): Session {
    return session.fromPartition(this.partition);
  }

  private async pace() {
    const gap = 900 + Math.random() * 900;
    const wait = this.lastAction + gap - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastAction = Date.now();
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async contents(): Promise<WebContents> {
    if (this.window && !this.window.isDestroyed()) return this.window.webContents;
    const ses = this.session;
    ses.setUserAgent(cleanUserAgent());
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        partition: this.partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    win.webContents.setAudioMuted(true);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event, url) => {
      if (!isInstagramUrl(url)) event.preventDefault();
    });
    win.on("closed", () => {
      if (this.window === win) this.window = null;
    });
    this.window = win;
    await this.load(win.webContents, `${ORIGIN}/`, 35_000).catch((error) => {
      win.destroy();
      this.window = null;
      throw error;
    });
    return win.webContents;
  }

  private async load(wc: WebContents, url: string, timeoutMs: number) {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        wc.loadURL(url).catch((error: Error) => {
          // ERR_ABORTED aparece cuando la SPA redirige; la página sigue siendo usable.
          if (!/ERR_ABORTED|\(-3\)/.test(error.message)) throw error;
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new VaultError("network", "Instagram tardó demasiado en responder.", { retryable: true })), timeoutMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw new VaultError("network", `No se pudo abrir Instagram: ${(error as Error).message}`, { retryable: true });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** GET a la API web desde la propia página; devuelve JSON o lanza un error tipado. */
  apiGet(path: string): Promise<Record<string, unknown>> {
    return this.serial(async () => {
      const wc = await this.contents();
      await this.pace();
      const response = (await wc.executeJavaScript(fetchScript(path, "json"), true)) as RawResponse;
      return classifyJson(response, this.access);
    });
  }

  /** GET de una página HTML same-origin (p. ej. el embed de una publicación). */
  fetchText(path: string): Promise<RawResponse> {
    return this.serial(async () => {
      const wc = await this.contents();
      await this.pace();
      return (await wc.executeJavaScript(fetchScript(path, "text"), true)) as RawResponse;
    });
  }

  snapshot(): Promise<PageSnapshot> {
    return this.serial(async () => {
      const wc = await this.contents();
      return (await wc.executeJavaScript(SNAPSHOT_SCRIPT, true)) as PageSnapshot;
    });
  }

  currentUserFromPage(): Promise<string | null> {
    return this.serial(async () => {
      const wc = await this.contents();
      return (await wc.executeJavaScript(CURRENT_USER_SCRIPT, true)) as string | null;
    });
  }

  /**
   * Navega una página real de Instagram y captura los JSON que la web pide
   * (GraphQL y API v1) usando el depurador interno de Electron.
   */
  capture(url: string, options: CaptureOptions): Promise<CaptureResult> {
    if (!isInstagramUrl(url)) return Promise.reject(new VaultError("invalid_url", "Sólo se permiten páginas de Instagram."));
    return this.serial(async () => {
      const wc = await this.contents();
      await this.pace();
      const dbg = wc.debugger;
      if (!dbg.isAttached()) dbg.attach("1.3");
      const payloads: unknown[] = [];
      const gridItems: unknown[] = [];
      const interesting = new Set<string>();
      const bodies: Promise<void>[] = [];
      let httpStatus: number | null = null;
      let lastActivity = Date.now();
      const onMessage = (_event: unknown, method: string, params: Record<string, any>) => {
        if (method === "Network.responseReceived") {
          const response = params.response ?? {};
          const status = Number(response.status ?? 0);
          const responseUrl = String(response.url ?? "");
          if ([401, 403, 429].includes(status) && isInstagramUrl(responseUrl)) httpStatus = status;
          const mime = String(response.mimeType ?? "");
          if (
            isInstagramUrl(responseUrl) &&
            (mime.includes("json") || responseUrl.includes("/graphql") || responseUrl.includes("/api/v1/"))
          ) {
            interesting.add(String(params.requestId));
          }
        } else if (method === "Network.loadingFinished" && interesting.delete(String(params.requestId))) {
          bodies.push(
            dbg
              .sendCommand("Network.getResponseBody", { requestId: params.requestId })
              .then((result: { body: string; base64Encoded: boolean }) => {
                const text = result.base64Encoded ? Buffer.from(result.body, "base64").toString("utf8") : result.body;
                payloads.push(...parseJsonLoose(text));
                lastActivity = Date.now();
              })
              .catch(() => undefined),
          );
        } else if (method === "Network.loadingFailed") {
          interesting.delete(String(params.requestId));
        }
      };
      dbg.on("message", onMessage);
      const state = { checkpoint: options.checkpoint ?? null, reached: !options.checkpoint, seen: new Set<string>(), codes: [] as string[] };
      let unchanged = 0;
      let lastFingerprint = "";
      const deadline = Date.now() + (options.timeoutMs ?? Math.min(110_000, 25_000 + options.batchSize * 2_000));
      try {
        await dbg.sendCommand("Network.enable", { maxTotalBufferSize: 50_000_000 });
        await this.load(wc, url, 35_000);
        lastActivity = Date.now();
        const maxScrolls = options.batchSize > 0 ? 140 : 0;
        // Espera inicial a que la página emita sus respuestas.
        while (Date.now() < deadline && Date.now() - lastActivity < 1800) {
          if (options.isCancelled?.()) throw cancelled();
          await sleep(250);
        }
        for (let scroll = 0; scroll < maxScrolls && Date.now() < deadline; scroll++) {
          if (options.isCancelled?.()) throw cancelled();
          if (httpStatus !== null || state.codes.length >= options.batchSize || unchanged >= 3) break;
          const page = (await wc.executeJavaScript(SCROLL_SCRIPT, true)) as { fingerprint: string; height: number; items: Array<{ shortcode?: unknown }> };
          gridItems.push(...page.items);
          recordPublicationCodes(page.items, state, options.batchSize);
          const fingerprint = `${page.height}|${page.fingerprint}`;
          unchanged = fingerprint === lastFingerprint ? unchanged + 1 : 0;
          lastFingerprint = fingerprint;
          const idleStart = Date.now();
          while (Date.now() < deadline && (Date.now() - lastActivity < 1600 || Date.now() - idleStart < 900)) {
            if (options.isCancelled?.()) throw cancelled();
            await sleep(200);
          }
        }
        if (options.batchSize > 0) {
          const page = (await wc.executeJavaScript(SCROLL_SCRIPT, true)) as { items: Array<{ shortcode?: unknown }> };
          gridItems.push(...page.items);
          recordPublicationCodes(page.items, state, options.batchSize);
        }
        await Promise.race([Promise.all(bodies), sleep(4000)]);
        const snapshot = (await wc.executeJavaScript(SNAPSHOT_SCRIPT, true)) as PageSnapshot;
        return {
          payloads,
          gridItems,
          publicationCodes: state.codes,
          stalled: options.batchSize > 0 && unchanged >= 3,
          httpStatus,
          checkpointReached: state.reached,
          snapshot,
        };
      } finally {
        dbg.removeListener("message", onMessage);
        try {
          await dbg.sendCommand("Network.disable");
        } catch {
          /* la página pudo cerrarse */
        }
      }
    });
  }

  destroy() {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}
