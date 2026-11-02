import { join } from "node:path";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { BrowserWindow, app, dialog, ipcMain, shell } from "electron";
import { z } from "zod";
import { IPC_INVOKE, type IpcEnvelope, type VaultApi, type VaultMethod } from "@shared/api";
import type { AccessMode, Settings, StorageInfo, SyncResult } from "@shared/types";
import type { AppContext } from "./context";
import { VaultError, toErrorShape } from "./errors";
import { parseInstagramUrl } from "./ig/url";
import { importLegacyLibrary, legacyInfo } from "./legacy/tauri-import";
import { downloadToStore } from "./net/cdn";
import { extensionFor } from "./vault/store";

const id = z.number().int().positive();
const ids = z.array(id).max(20_000);
const kind = z.enum(["post", "story", "highlight"]);
const access = z.enum(["public", "account"]);
const accountId = id.nullable().optional();

const schemas: Partial<Record<VaultMethod, z.ZodType>> = {
  "app:openExternal": z.object({ url: z.string().url() }),
  "profiles:get": z.object({ profileId: id }),
  "profiles:setFavorite": z.object({ profileId: id, favorite: z.boolean() }),
  "profiles:delete": z.object({ profileId: id, deleteFiles: z.boolean() }),
  "profiles:touch": z.object({ profileId: id }),
  "media:list": z.object({ profileId: id, kind: kind.nullable().optional() }),
  "media:highlights": z.object({ profileId: id }),
  "media:remove": z.object({ mediaIds: ids }),
  "sync:state": z.object({ profileId: id }),
  "ig:lookup": z.object({ username: z.string().min(1).max(64), access, accountId }),
  "ig:sync": z.object({
    profileId: id,
    kind,
    access,
    accountId,
    continuation: z.boolean().optional(),
    batchSize: z.number().int().min(1).max(5000).optional(),
  }),
  "ig:parseUrl": z.object({ url: z.string().max(2048) }),
  "ig:resolveUrl": z.object({ url: z.string().min(1).max(2048), access, accountId }),
  "ig:saveResolved": z.object({ token: z.string().uuid(), target: z.enum(["library", "device"]), keys: z.array(z.string()).min(1).max(40) }),
  "accounts:disconnect": z.object({ accountId: id }),
  "accounts:delete": z.object({ accountId: id }),
  "downloads:start": z.object({
    profileId: id.optional(),
    kind: kind.optional(),
    mediaIds: ids.optional(),
    includeFailed: z.boolean().optional(),
    force: z.boolean().optional(),
    accountId,
  }),
  "downloads:cancel": z.object({ jobId: id }),
  "downloads:reset": z.object({ mediaIds: ids }),
  "export:media": z.object({ mediaIds: ids.min(1) }),
  "export:avatar": z.object({ profileId: id }),
  "export:reveal": z.object({ mediaId: id }),
  "settings:set": z
    .object({
      concurrency: z.number().int().min(1).max(8),
      fallbackPolicy: z.enum(["ask", "auto", "never"]),
      defaultAccountId: id.nullable(),
      postsBatchSize: z.number().int().min(12).max(600),
      thumbnailsOnSync: z.boolean(),
      onboardingDone: z.boolean(),
      reduceMotion: z.boolean(),
    })
    .partial(),
};

type Handlers = { [M in VaultMethod]: (args: never) => Promise<ReturnType<VaultApi[M]>> | ReturnType<VaultApi[M]> };

const safeName = (value: string) => value.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 80);

export function registerIpc(ctx: AppContext) {
  const { repo, store, ig, downloads, accounts } = ctx;

  /**
   * Política de respaldo: si el modo anónimo choca con un muro de Instagram,
   * "auto" reintenta con la cuenta, "ask" devuelve el error marcado para que
   * la interfaz pregunte y "never" no ofrece la cuenta.
   */
  async function withFallback<T>(requested: AccessMode, requestedAccount: number | null | undefined, run: (access: AccessMode, accountId: number | null) => Promise<T>): Promise<T> {
    try {
      return await run(requested, requestedAccount ?? null);
    } catch (error) {
      if (requested !== "public" || !(error instanceof VaultError) || !error.canUseAccount) throw error;
      const policy = repo.getSettings().fallbackPolicy;
      const fallbackAccount = ig.resolveAccountId(requestedAccount ?? null);
      if (policy === "auto" && fallbackAccount) return run("account", fallbackAccount);
      throw new VaultError(error.code, error.message, { retryable: error.retryable, canUseAccount: policy === "ask" && fallbackAccount !== null });
    }
  }

  async function gc(): Promise<{ removed: number; bytes: number }> {
    let removed = 0;
    let bytes = 0;
    for (const asset of repo.orphanAssets()) {
      bytes += await store.removeAsset(asset);
      removed++;
    }
    return { removed, bytes };
  }

  const handlers: Handlers = {
    "app:info": () => ({
      version: app.getVersion(),
      platform: process.platform,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      dataDir: ctx.dataDir,
      fixtures: ctx.fixtures,
    }),
    "app:openExternal": async ({ url }: { url: string }) => {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || !/(^|\.)(instagram\.com|github\.com)$/i.test(parsed.hostname)) {
        throw new VaultError("invalid_input", "Enlace externo no permitido.");
      }
      await shell.openExternal(parsed.toString());
    },

    "library:stats": () => repo.libraryStats(),
    "profiles:list": () => repo.listProfiles(),
    "profiles:get": ({ profileId }: { profileId: number }) => repo.listProfiles(profileId)[0] ?? null,
    "profiles:setFavorite": ({ profileId, favorite }: { profileId: number; favorite: boolean }) => {
      repo.setFavorite(profileId, favorite);
      ctx.emit({ type: "library:changed", profileIds: [profileId] });
    },
    "profiles:delete": async ({ profileId, deleteFiles }: { profileId: number; deleteFiles: boolean }) => {
      repo.deleteProfile(profileId);
      if (deleteFiles) await gc();
      ctx.emit({ type: "library:changed", profileIds: [profileId] });
    },
    "profiles:touch": ({ profileId }: { profileId: number }) => repo.touchProfile(profileId),
    "media:list": ({ profileId, kind }: { profileId: number; kind?: "post" | "story" | "highlight" | null }) => repo.listMedia(profileId, kind),
    "media:highlights": ({ profileId }: { profileId: number }) => repo.listHighlights(profileId),
    "media:remove": ({ mediaIds }: { mediaIds: number[] }) => {
      const profiles = repo.profileIdsForMedia(mediaIds);
      const removed = repo.removeMedia(mediaIds);
      ctx.emit({ type: "library:changed", profileIds: profiles });
      return removed;
    },
    "sync:state": ({ profileId }: { profileId: number }) => repo.listSync(profileId),

    "ig:lookup": async ({ username, access, accountId }: { username: string; access: AccessMode; accountId?: number | null }) => {
      const profileId = await withFallback(access, accountId, (a, acct) => ig.lookup(username, a, acct));
      const profile = repo.listProfiles(profileId)[0];
      if (!profile) throw new VaultError("internal", "No se pudo leer el perfil guardado.");
      return profile;
    },
    "ig:sync": async (req: { profileId: number; kind: "post" | "story" | "highlight"; access: AccessMode; accountId?: number | null; continuation?: boolean; batchSize?: number }) => {
      const policy = repo.getSettings().fallbackPolicy;
      const result: SyncResult = await withFallback(req.access, req.accountId, (a, acct) => ig.sync({ ...req, access: a, accountId: acct }));
      // Con política automática, el muro anónimo se continúa con la cuenta.
      const fallbackAccount = ig.resolveAccountId(req.accountId ?? null);
      if (result.access === "public" && result.status === "anonymous_limit" && policy === "auto" && fallbackAccount) {
        const next = await ig.sync({ ...req, access: "account", accountId: fallbackAccount, continuation: true });
        return {
          ...next,
          newItems: next.newItems + result.newItems,
          updatedItems: next.updatedItems + result.updatedItems,
          publications: next.publications + result.publications,
        };
      }
      return result;
    },
    "ig:cancel": () => ig.cancel(),
    "ig:parseUrl": ({ url }: { url: string }) => parseInstagramUrl(url),
    "ig:resolveUrl": ({ url, access, accountId }: { url: string; access: AccessMode; accountId?: number | null }) =>
      withFallback(access, accountId, (a, acct) => ig.resolveUrl(url, a, acct)),
    "ig:saveResolved": async ({ token, target, keys }: { token: string; target: "library" | "device"; keys: string[] }) => {
      const stored = ig.takeResolution(token);
      const chosen = stored.media.filter((_, index) => keys.includes(String(index)));
      if (!chosen.length) throw new VaultError("invalid_input", "Selecciona al menos una pieza.");
      const owner = stored.resolution.owner?.username ?? null;
      const firstThumb = stored.resolution.items.find((i) => keys.includes(i.key))?.previewUrl?.replace("vault://a/", "") ?? null;
      if (target === "library") {
        if (!owner) throw new VaultError("provider_changed", "No se identificó al autor de la publicación.");
        const profileId = repo.ensureProfile(owner);
        repo.upsertMedia(profileId, chosen);
        const rows = repo.listMedia(profileId, chosen[0].kind);
        const rowIds: number[] = [];
        for (const item of chosen) {
          const row = rows.find(
            (r) => r.mediaId === item.mediaId || (item.publicationCode !== null && r.publicationCode === item.publicationCode && r.childIndex === item.childIndex),
          );
          if (!row) continue;
          rowIds.push(row.id);
          const sha = stored.resolution.items[stored.media.indexOf(item)]?.previewUrl?.replace("vault://a/", "");
          if (sha && !row.thumbUrl) repo.setThumb(row.id, sha);
        }
        repo.addQuick({ url: stored.resolution.parsed.url, ownerUsername: owner, itemCount: chosen.length, thumbSha: firstThumb, savedLibrary: true });
        ctx.emit({ type: "library:changed", profileIds: [profileId] });
        if (rowIds.length) await downloads.start({ mediaIds: rowIds, accountId: stored.accountId, includeFailed: true });
        return { saved: chosen.length, profileId, folder: null };
      }
      const win = ctx.window();
      const pick = await dialog.showOpenDialog(win ?? (undefined as unknown as BrowserWindow), {
        title: "Elige dónde guardar",
        properties: ["openDirectory", "createDirectory"],
      });
      if (pick.canceled || !pick.filePaths[0]) return { saved: 0, profileId: null, folder: null };
      const folder = pick.filePaths[0];
      let saved = 0;
      for (const item of chosen) {
        if (!item.bestUrl) continue;
        const asset = await downloadToStore(store, item.bestUrl, { bucket: "media", fallbackMime: item.mediaType === 2 ? "video/mp4" : "image/jpeg" });
        const name = `${safeName(owner ?? "instagram")}_${safeName(item.publicationCode ?? item.mediaId)}${chosen.length > 1 ? `_${item.childIndex + 1}` : ""}.${extensionFor(asset.mime)}`;
        await store.exportTo(asset.sha256, join(folder, name));
        saved++;
      }
      repo.addQuick({ url: stored.resolution.parsed.url, ownerUsername: owner, itemCount: saved, thumbSha: firstThumb, savedLibrary: false });
      await gc();
      return { saved, profileId: null, folder };
    },
    "quick:history": () => repo.listQuick(),
    "quick:clearHistory": () => repo.clearQuick(),

    "accounts:list": () => repo.listAccounts(),
    "accounts:connect": () => accounts.connect(ctx.window()),
    "accounts:cancelConnect": () => accounts.cancelConnect(),
    "accounts:disconnect": ({ accountId }: { accountId: number }) => accounts.disconnect(accountId),
    "accounts:delete": ({ accountId }: { accountId: number }) => accounts.remove(accountId),

    "downloads:start": (req: { profileId?: number; kind?: "post" | "story" | "highlight"; mediaIds?: number[]; includeFailed?: boolean; force?: boolean; accountId?: number | null }) =>
      downloads.start(req),
    "downloads:jobs": () => repo.listJobs(),
    "downloads:cancel": ({ jobId }: { jobId: number }) => downloads.cancel(jobId),
    "downloads:clearFinished": () => repo.clearFinishedJobs(),
    "downloads:reset": ({ mediaIds }: { mediaIds: number[] }) => {
      const changed = repo.resetMedia(mediaIds);
      ctx.emit({ type: "library:changed", profileIds: repo.profileIdsForMedia(mediaIds) });
      return changed;
    },

    "export:media": async ({ mediaIds }: { mediaIds: number[] }) => {
      const media = repo.mediaByIds(mediaIds).filter((m) => m.sha256);
      if (!media.length) throw new VaultError("invalid_input", "Ninguna de las piezas está descargada todavía.");
      const usernames = new Map<number, string>();
      const nameFor = (m: (typeof media)[number]) => {
        if (!usernames.has(m.profileId)) usernames.set(m.profileId, repo.profileRow(m.profileId)?.username ?? "instagram");
        const base = `${safeName(usernames.get(m.profileId)!)}_${safeName(m.publicationCode ?? m.mediaId)}`;
        return `${base}${m.childCount > 1 ? `_${m.childIndex + 1}` : ""}.${extensionFor(m.mime ?? "image/jpeg")}`;
      };
      const win = ctx.window();
      if (media.length === 1) {
        const result = await dialog.showSaveDialog(win ?? (undefined as unknown as BrowserWindow), {
          title: "Guardar en el equipo",
          defaultPath: join(app.getPath("pictures"), nameFor(media[0])),
        });
        if (result.canceled || !result.filePath) return { exported: 0, folder: null };
        await store.exportTo(media[0].sha256!, result.filePath);
        return { exported: 1, folder: result.filePath };
      }
      const pick = await dialog.showOpenDialog(win ?? (undefined as unknown as BrowserWindow), {
        title: `Guardar ${media.length} piezas`,
        defaultPath: app.getPath("pictures"),
        properties: ["openDirectory", "createDirectory"],
      });
      if (pick.canceled || !pick.filePaths[0]) return { exported: 0, folder: null };
      let exported = 0;
      for (const m of media) {
        await store.exportTo(m.sha256!, join(pick.filePaths[0], nameFor(m)));
        exported++;
      }
      return { exported, folder: pick.filePaths[0] };
    },
    "export:avatar": async ({ profileId }: { profileId: number }) => {
      const profile = repo.listProfiles(profileId)[0];
      const sha = profile?.avatarUrl?.replace("vault://a/", "");
      if (!profile || !sha) throw new VaultError("invalid_input", "Este perfil no tiene foto guardada.");
      const asset = repo.getAsset(sha);
      const result = await dialog.showSaveDialog(ctx.window() ?? (undefined as unknown as BrowserWindow), {
        title: "Guardar foto de perfil",
        defaultPath: join(app.getPath("pictures"), `${profile.username}_perfil.${extensionFor(asset?.mime ?? "image/jpeg")}`),
      });
      if (result.canceled || !result.filePath) return null;
      await store.exportTo(sha, result.filePath);
      return result.filePath;
    },
    "export:reveal": ({ mediaId }: { mediaId: number }) => {
      const media = repo.mediaByIds([mediaId])[0];
      const asset = media?.sha256 ? repo.getAsset(media.sha256) : null;
      if (asset) shell.showItemInFolder(store.absolute(asset.relPath));
    },

    "settings:get": () => repo.getSettings(),
    "settings:set": (patch: Partial<Settings>) => repo.setSettings(patch),
    "storage:info": (): StorageInfo => {
      const totals = repo.assetTotals();
      const orphanBytes = repo.orphanAssets().reduce((sum, a) => sum + a.bytes, 0);
      return { dataDir: ctx.dataDir, vaultDir: store.root, bytes: totals.bytes, assets: totals.assets, orphanBytes };
    },
    "storage:gc": () => gc(),
    "storage:open": async () => {
      await shell.openPath(store.root);
    },

    "legacy:info": () => legacyInfo(ctx.legacy, repo),
    "legacy:import": async () => {
      const result = await importLegacyLibrary(ctx.legacy, repo, store, (phase, done, total, thumbUrl) =>
        ctx.emit({ type: "import:progress", phase, done, total, thumbUrl }),
      );
      ctx.emit({ type: "library:changed", profileIds: [] });
      ctx.emit({ type: "accounts:changed" });
      return result;
    },
    "legacy:removeBrowserProfile": async () => {
      if (!existsSync(ctx.legacy.browserProfile)) return false;
      await rm(ctx.legacy.browserProfile, { recursive: true, force: true });
      return true;
    },

    "update:check": () => ctx.updater.check(),
    "update:install": () => ctx.updater.install(),
  };

  ipcMain.handle(IPC_INVOKE, async (event, method: string, rawArgs: unknown): Promise<IpcEnvelope<unknown>> => {
    const win = ctx.window();
    if (!win || event.sender !== win.webContents) {
      return { ok: false, error: { code: "invalid_input", message: "Origen IPC no autorizado.", retryable: false } };
    }
    const handler = (handlers as unknown as Record<string, (args: unknown) => unknown>)[method];
    if (!handler) return { ok: false, error: { code: "invalid_input", message: `Método desconocido: ${method}`, retryable: false } };
    try {
      const schema = schemas[method as VaultMethod];
      const args = schema ? schema.parse(rawArgs ?? {}) : rawArgs;
      return { ok: true, data: await handler(args) };
    } catch (error) {
      if (error instanceof z.ZodError) {
        return { ok: false, error: { code: "invalid_input", message: "Parámetros inválidos.", retryable: false } };
      }
      return { ok: false, error: toErrorShape(error) };
    }
  });
}
