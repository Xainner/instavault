import { copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { LegacyImportInfo } from "@shared/types";
import { assetUrl } from "@shared/urls";
import type { Repo } from "../db/repo";
import type { VaultStore } from "../vault/store";
import { cdnExpiry } from "../ig/cdn";

type Row = Record<string, unknown>;

export interface LegacyPaths {
  /** %APPDATA%/com.xainner.instavault/instakeeper.db */
  database: string;
  /** %APPDATA%/InstaVault/browser-profile (Chrome dedicado de la 1.x) */
  browserProfile: string;
  backupDir: string;
}

export type ImportProgress = (phase: string, done: number, total: number, thumbUrl: string | null) => void;

function columns(db: DatabaseSync, table: string): Set<string> {
  try {
    return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((r) => String(r.name)));
  } catch {
    return new Set();
  }
}

function hasTable(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const s = (v: unknown) => (v === null || v === undefined ? null : String(v));

export function legacyInfo(paths: LegacyPaths, repo: Repo): LegacyImportInfo {
  const done = repo.getMeta("legacy_import_done") !== null;
  const browser = existsSync(paths.browserProfile) ? paths.browserProfile : null;
  if (!existsSync(paths.database)) {
    return { available: false, path: null, profiles: 0, media: 0, downloaded: 0, done, legacyBrowserProfile: browser };
  }
  try {
    const db = new DatabaseSync(paths.database, { readOnly: true });
    try {
      const profiles = hasTable(db, "profiles") ? Number((db.prepare("SELECT COUNT(*) c FROM profiles").get() as Row).c) : 0;
      const media = hasTable(db, "media") ? Number((db.prepare("SELECT COUNT(*) c FROM media").get() as Row).c) : 0;
      const downloaded = hasTable(db, "media_content")
        ? Number((db.prepare("SELECT COUNT(*) c FROM media_content").get() as Row).c)
        : 0;
      return { available: true, path: paths.database, profiles, media, downloaded, done, legacyBrowserProfile: browser };
    } finally {
      db.close();
    }
  } catch {
    return { available: true, path: paths.database, profiles: 0, media: 0, downloaded: 0, done, legacyBrowserProfile: browser };
  }
}

/**
 * Importa la biblioteca de InstaVault 1.x. Trabaja sobre una copia de
 * seguridad (incluido el WAL) abierta en sólo lectura: el original no se toca.
 */
export async function importLegacyLibrary(
  paths: LegacyPaths,
  repo: Repo,
  store: VaultStore,
  progress: ImportProgress,
): Promise<{ profiles: number; media: number; files: number }> {
  if (!existsSync(paths.database)) throw new Error("No se encontró la biblioteca de InstaVault 1.x.");
  await mkdir(paths.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = join(paths.backupDir, `instakeeper-${stamp}.db`);
  progress("Copia de seguridad", 0, 1, null);
  await copyFile(paths.database, backup);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(paths.database + suffix)) await copyFile(paths.database + suffix, backup + suffix);
  }

  // Abrir la copia en escritura una vez consolida el WAL; luego se lee.
  const consolidate = new DatabaseSync(backup);
  consolidate.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  consolidate.close();
  const old = new DatabaseSync(backup, { readOnly: true });

  const profileMap = new Map<number, number>();
  let mediaCount = 0;
  let files = 0;
  try {
    // ------------------------------------------------------------ cuentas
    if (hasTable(old, "accounts")) {
      for (const row of old.prepare("SELECT username FROM accounts").all() as Row[]) {
        repo.insertLegacyAccount(String(row.username), `persist:ig-acct-legacy-${String(row.username)}`);
      }
    }

    // ------------------------------------------------------------ perfiles
    const pcols = columns(old, "profiles");
    const profiles = old.prepare("SELECT * FROM profiles").all() as Row[];
    profiles.forEach((row, index) => {
      const id = repo.upsertProfile({
        username: String(row.username),
        igId: s(row.pk),
        fullName: s(row.full_name),
        biography: s(row.biography),
        externalUrl: null,
        followers: n(row.followers),
        following: n(row.following),
        mediaCount: n(row.media_count),
        isPrivate: row.is_private === null || row.is_private === undefined ? null : Number(row.is_private) === 1,
        isVerified: Number(row.is_verified ?? 0) === 1,
        profilePicUrl: s(row.profile_pic_url),
      });
      if (pcols.has("is_favorite") && Number(row.is_favorite) === 1) repo.setFavorite(id, true);
      profileMap.set(Number(row.id), id);
      progress("Perfiles", index + 1, profiles.length, null);
    });

    if (hasTable(old, "profile_avatar_content")) {
      for (const row of old.prepare("SELECT profile_id, data, mime_type FROM profile_avatar_content").all() as Row[]) {
        const target = profileMap.get(Number(row.profile_id));
        if (!target || !(row.data instanceof Uint8Array)) continue;
        const asset = await store.ingestBuffer(row.data, { bucket: "avatars", mime: String(row.mime_type ?? "image/jpeg") });
        repo.setProfileAvatar(target, asset.sha256);
        files++;
      }
    }

    // ------------------------------------------------------------- medios
    const mcols = columns(old, "media");
    const media = old.prepare("SELECT * FROM media ORDER BY id").all() as Row[];
    const contentStmt = hasTable(old, "media_content")
      ? old.prepare("SELECT data, mime_type, width, height, bitrate, quality_verified, source, downloaded_at FROM media_content WHERE media_id=?")
      : null;
    const thumbStmt = hasTable(old, "media_thumbnail_content")
      ? old.prepare("SELECT data, mime_type FROM media_thumbnail_content WHERE media_id=?")
      : null;
    const insert = repo.db.prepare(
      `INSERT INTO media(profile_id, kind, media_id, publication_code, child_index, child_count, taken_at, caption, media_type,
         best_url, url_expires_at, thumbnail_url, width, height, bitrate, quality_verified, source, status, error,
         asset_sha, thumb_sha, downloaded_at, created_at)
       VALUES (?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(profile_id, kind, media_id) DO UPDATE SET
         asset_sha=COALESCE(media.asset_sha, excluded.asset_sha), thumb_sha=COALESCE(media.thumb_sha, excluded.thumb_sha),
         status=CASE WHEN media.asset_sha IS NULL AND excluded.asset_sha IS NOT NULL THEN 'downloaded' ELSE media.status END`,
    );

    for (let i = 0; i < media.length; i++) {
      const row = media[i];
      const profileId = profileMap.get(Number(row.profile_id));
      if (!profileId) continue;
      const kind = ["post", "story", "highlight"].includes(String(row.kind)) ? String(row.kind) : "post";
      let assetSha: string | null = null;
      let thumbSha: string | null = null;
      let width = n(row.width);
      let height = n(row.height);
      let bitrate = mcols.has("bitrate") ? n(row.bitrate) : null;
      let verified = mcols.has("quality_verified") ? Number(row.quality_verified ?? 0) === 1 : false;
      let source: string | null = "legacy";
      let downloadedAt: number | null = null;

      const content = contentStmt?.get(Number(row.id)) as Row | undefined;
      if (content && content.data instanceof Uint8Array) {
        const asset = await store.ingestBuffer(content.data, {
          bucket: "media",
          mime: String(content.mime_type ?? "application/octet-stream"),
          width: n(content.width),
          height: n(content.height),
        });
        assetSha = asset.sha256;
        width = n(content.width) ?? width;
        height = n(content.height) ?? height;
        bitrate = n(content.bitrate) ?? bitrate;
        verified = Number(content.quality_verified ?? 0) === 1;
        source = s(content.source) ?? "legacy";
        downloadedAt = n(content.downloaded_at);
        files++;
      } else if (mcols.has("local_path") && row.local_path && existsSync(String(row.local_path))) {
        const asset = await store.ingestFile(String(row.local_path), {
          bucket: "media",
          mime: Number(row.media_type) === 2 ? "video/mp4" : "image/jpeg",
        });
        assetSha = asset.sha256;
        files++;
      }
      const thumb = thumbStmt?.get(Number(row.id)) as Row | undefined;
      if (thumb && thumb.data instanceof Uint8Array) {
        thumbSha = (await store.ingestBuffer(thumb.data, { bucket: "thumbs", mime: String(thumb.mime_type ?? "image/jpeg") })).sha256;
      }

      const oldStatus = String(row.status ?? "metadata");
      const status = assetSha ? "downloaded" : oldStatus === "failed" ? "failed" : "pending";
      const bestUrl = s(row.best_url);
      insert.run(
        profileId,
        kind,
        String(row.media_id),
        s(mcols.has("publication_code") ? row.publication_code : null) ?? s(row.code),
        mcols.has("child_index") ? Number(row.child_index ?? 0) : 0,
        n(row.taken_at),
        s(row.caption),
        Number(row.media_type) === 2 ? 2 : 1,
        bestUrl,
        cdnExpiry(bestUrl),
        s(row.thumbnail_url),
        width,
        height,
        bitrate,
        verified ? 1 : 0,
        source,
        status,
        status === "failed" ? s(row.error) : null,
        assetSha,
        thumbSha,
        downloadedAt,
        n(row.created_at) ?? Math.floor(Date.now() / 1000),
      );
      mediaCount++;
      if (i % 5 === 0 || i === media.length - 1) progress("Medios", i + 1, media.length, assetUrl(thumbSha ?? (Number(row.media_type) === 2 ? null : assetSha)));
    }

    repo.db.exec(`
      UPDATE media SET child_count = (
        SELECT COUNT(*) FROM media m2 WHERE m2.profile_id=media.profile_id AND m2.kind=media.kind
          AND m2.publication_code=media.publication_code)
      WHERE publication_code IS NOT NULL;
    `);

    // ------------------------------------------------- progreso de sync
    if (hasTable(old, "sync_progress")) {
      for (const row of old.prepare("SELECT * FROM sync_progress").all() as Row[]) {
        const profileId = profileMap.get(Number(row.profile_id));
        if (!profileId) continue;
        repo.saveSync({
          profileId,
          kind: (["post", "story", "highlight"].includes(String(row.kind)) ? String(row.kind) : "post") as "post",
          access: String(row.access_mode) === "authenticated_explicit" ? "account" : "public",
          cursor: null,
          lastCode: s(row.last_shortcode),
          seen: Number(row.publications_seen ?? 0),
          status: (s(row.status) ?? "stalled") as "stalled",
          stopReason: s(row.stop_reason),
        });
      }
    }
  } finally {
    old.close();
  }
  repo.setMeta("legacy_import_done", String(Date.now()));
  progress("Listo", 1, 1, null);
  return { profiles: profileMap.size, media: mediaCount, files };
}
