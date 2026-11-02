import { DatabaseSync, type StatementSync } from "node:sqlite";
import type {
  Account,
  AccessMode,
  Highlight,
  Job,
  KindStats,
  LibraryStats,
  Media,
  MediaKind,
  MediaStatus,
  Profile,
  QuickHistoryEntry,
  Settings,
  SyncState,
  SyncStatus,
} from "@shared/types";
import { assetUrl } from "@shared/urls";
import type { ExtractedHighlight, ExtractedMedia, ExtractedProfile } from "../ig/types";
import { cdnExpiry } from "../ig/cdn";
import { MIGRATIONS } from "./schema";

type Row = Record<string, unknown>;
const now = () => Math.floor(Date.now() / 1000);
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const bool = (v: unknown) => Number(v) === 1;

export const DEFAULT_SETTINGS: Settings = {
  concurrency: 4,
  fallbackPolicy: "ask",
  defaultAccountId: null,
  postsBatchSize: 36,
  thumbnailsOnSync: true,
  onboardingDone: false,
  reduceMotion: false,
};

export interface AssetRow {
  sha256: string;
  relPath: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
}

export interface MediaDownloadRow {
  id: number;
  profileId: number;
  username: string;
  isPrivate: boolean;
  kind: MediaKind;
  mediaId: string;
  publicationCode: string | null;
  childIndex: number;
  highlightId: string | null;
  mediaType: 1 | 2;
  bestUrl: string | null;
  urlExpiresAt: number | null;
  thumbnailUrl: string | null;
  thumbSha: string | null;
  status: MediaStatus;
  width: number | null;
  height: number | null;
  bitrate: number | null;
  qualityVerified: boolean;
  source: string | null;
}

export interface UpsertResult {
  inserted: number;
  updated: number;
  ids: number[];
  needThumb: Array<{ id: number; url: string }>;
}

export class Repo {
  readonly db: DatabaseSync;
  private cache = new Map<string, StatementSync>();

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");
    this.migrate();
    this.recover();
  }

  close() {
    this.db.close();
  }

  private migrate() {
    const current = Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version ?? 0);
    for (let version = current; version < MIGRATIONS.length; version++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[version]);
        this.db.exec(`PRAGMA user_version = ${version + 1}`);
      });
    }
  }

  /** Un cierre inesperado no debe dejar trabajos “en curso” para siempre. */
  private recover() {
    this.db.exec(`
      UPDATE media SET status='pending' WHERE status='downloading';
      UPDATE jobs SET status='cancelled', finished_at=COALESCE(finished_at, strftime('%s','now')) WHERE status='running';
    `);
  }

  stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  tx<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // ---------------------------------------------------------------- settings
  getSettings(): Settings {
    const rows = this.stmt("SELECT key, value FROM settings").all() as Row[];
    const out: Settings = { ...DEFAULT_SETTINGS };
    for (const row of rows) {
      const key = String(row.key) as keyof Settings;
      if (key in out) {
        try {
          (out as unknown as Record<string, unknown>)[key] = JSON.parse(String(row.value));
        } catch {
          /* valor corrupto: se ignora y queda el predeterminado */
        }
      }
    }
    return out;
  }

  setSettings(patch: Partial<Settings>): Settings {
    this.tx(() => {
      for (const [key, value] of Object.entries(patch)) {
        if (!(key in DEFAULT_SETTINGS) || value === undefined) continue;
        this.stmt("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
          key,
          JSON.stringify(value),
        );
      }
    });
    return this.getSettings();
  }

  getMeta(key: string): string | null {
    const row = this.stmt("SELECT value FROM settings WHERE key=?").get(`meta:${key}`) as Row | undefined;
    return row ? String(row.value) : null;
  }

  setMeta(key: string, value: string) {
    this.stmt("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`meta:${key}`, value);
  }

  // ---------------------------------------------------------------- accounts
  listAccounts(): Account[] {
    return (this.stmt("SELECT * FROM accounts ORDER BY added_at").all() as Row[]).map(toAccount);
  }

  getAccount(id: number): (Account & { partition: string }) | null {
    const row = this.stmt("SELECT * FROM accounts WHERE id=?").get(id) as Row | undefined;
    return row ? { ...toAccount(row), partition: String(row.partition) } : null;
  }

  upsertAccount(input: { username: string; igUserId: string | null; partition: string; avatarSha?: string | null }): number {
    const existing = this.stmt("SELECT id, partition FROM accounts WHERE username=?").get(input.username) as Row | undefined;
    if (existing) {
      this.stmt(
        "UPDATE accounts SET ig_user_id=?, partition=?, status='valid', last_valid=?, avatar_sha=COALESCE(?, avatar_sha) WHERE id=?",
      ).run(input.igUserId, input.partition, now(), input.avatarSha ?? null, Number(existing.id));
      return Number(existing.id);
    }
    const result = this.stmt(
      "INSERT INTO accounts(username, ig_user_id, partition, status, avatar_sha, added_at, last_valid) VALUES (?,?,?,'valid',?,?,?)",
    ).run(input.username, input.igUserId, input.partition, input.avatarSha ?? null, now(), now());
    return Number(result.lastInsertRowid);
  }

  insertLegacyAccount(username: string, partition: string) {
    this.stmt(
      "INSERT OR IGNORE INTO accounts(username, partition, status, added_at) VALUES (?,?,'reconnect_required',?)",
    ).run(username, partition, now());
  }

  setAccountStatus(id: number, status: Account["status"]) {
    this.stmt("UPDATE accounts SET status=?, last_valid=CASE WHEN ?='valid' THEN ? ELSE last_valid END WHERE id=?").run(
      status,
      status,
      now(),
      id,
    );
  }

  deleteAccount(id: number) {
    this.stmt("DELETE FROM accounts WHERE id=?").run(id);
  }

  // ------------------------------------------------------------------ assets
  upsertAsset(asset: AssetRow) {
    this.stmt(
      `INSERT INTO assets(sha256, rel_path, mime, bytes, width, height, created_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(sha256) DO UPDATE SET rel_path=excluded.rel_path, mime=excluded.mime, bytes=excluded.bytes,
         width=COALESCE(excluded.width, width), height=COALESCE(excluded.height, height)`,
    ).run(asset.sha256, asset.relPath, asset.mime, asset.bytes, asset.width, asset.height, now());
  }

  getAsset(sha: string): AssetRow | null {
    const row = this.stmt("SELECT * FROM assets WHERE sha256=?").get(sha) as Row | undefined;
    return row
      ? {
          sha256: String(row.sha256),
          relPath: String(row.rel_path),
          mime: String(row.mime),
          bytes: Number(row.bytes),
          width: num(row.width),
          height: num(row.height),
        }
      : null;
  }

  /** Assets que ya no referencia ningún medio, avatar, portada ni historial. */
  orphanAssets(): AssetRow[] {
    return (
      this.stmt(
        `SELECT * FROM assets a WHERE
           NOT EXISTS (SELECT 1 FROM media WHERE asset_sha=a.sha256 OR thumb_sha=a.sha256)
           AND NOT EXISTS (SELECT 1 FROM profiles WHERE avatar_sha=a.sha256)
           AND NOT EXISTS (SELECT 1 FROM accounts WHERE avatar_sha=a.sha256)
           AND NOT EXISTS (SELECT 1 FROM highlights WHERE cover_sha=a.sha256)
           AND NOT EXISTS (SELECT 1 FROM quick_downloads WHERE thumb_sha=a.sha256)`,
      ).all() as Row[]
    ).map((row) => ({
      sha256: String(row.sha256),
      relPath: String(row.rel_path),
      mime: String(row.mime),
      bytes: Number(row.bytes),
      width: num(row.width),
      height: num(row.height),
    }));
  }

  deleteAsset(sha: string) {
    this.stmt("DELETE FROM assets WHERE sha256=?").run(sha);
  }

  assetTotals(): { assets: number; bytes: number } {
    const row = this.stmt("SELECT COUNT(*) c, COALESCE(SUM(bytes),0) b FROM assets").get() as Row;
    return { assets: Number(row.c), bytes: Number(row.b) };
  }

  // ---------------------------------------------------------------- profiles
  upsertProfile(p: ExtractedProfile): number {
    const existing = this.stmt("SELECT id FROM profiles WHERE username=?").get(p.username) as Row | undefined;
    if (existing) {
      this.stmt(
        `UPDATE profiles SET ig_id=COALESCE(?, ig_id), full_name=COALESCE(?, full_name), biography=COALESCE(?, biography),
           external_url=COALESCE(?, external_url), followers=COALESCE(?, followers), following=COALESCE(?, following),
           media_count=COALESCE(?, media_count), is_private=COALESCE(?, is_private), is_verified=?,
           profile_pic_url=COALESCE(?, profile_pic_url), fetched_at=?, last_activity=? WHERE id=?`,
      ).run(
        p.igId,
        p.fullName,
        p.biography,
        p.externalUrl,
        p.followers,
        p.following,
        p.mediaCount,
        p.isPrivate === null ? null : p.isPrivate ? 1 : 0,
        p.isVerified ? 1 : 0,
        p.profilePicUrl,
        now(),
        now(),
        Number(existing.id),
      );
      return Number(existing.id);
    }
    const result = this.stmt(
      `INSERT INTO profiles(username, ig_id, full_name, biography, external_url, followers, following, media_count,
         is_private, is_verified, profile_pic_url, fetched_at, created_at, last_activity)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      p.username,
      p.igId,
      p.fullName,
      p.biography,
      p.externalUrl,
      p.followers,
      p.following,
      p.mediaCount,
      p.isPrivate === null ? null : p.isPrivate ? 1 : 0,
      p.isVerified ? 1 : 0,
      p.profilePicUrl,
      now(),
      now(),
      now(),
    );
    return Number(result.lastInsertRowid);
  }

  ensureProfile(username: string): number {
    const row = this.stmt("SELECT id FROM profiles WHERE username=?").get(username) as Row | undefined;
    if (row) return Number(row.id);
    return this.upsertProfile({
      username,
      igId: null,
      fullName: null,
      biography: null,
      externalUrl: null,
      followers: null,
      following: null,
      mediaCount: null,
      isPrivate: null,
      isVerified: false,
      profilePicUrl: null,
    });
  }

  setProfileAvatar(profileId: number, sha: string) {
    this.stmt("UPDATE profiles SET avatar_sha=? WHERE id=?").run(sha, profileId);
  }

  setFavorite(profileId: number, favorite: boolean) {
    this.stmt("UPDATE profiles SET is_favorite=? WHERE id=?").run(favorite ? 1 : 0, profileId);
  }

  touchProfile(profileId: number) {
    this.stmt("UPDATE profiles SET last_activity=? WHERE id=?").run(now(), profileId);
  }

  deleteProfile(profileId: number) {
    this.stmt("DELETE FROM profiles WHERE id=?").run(profileId);
  }

  profileRow(profileId: number): (ExtractedProfile & { id: number }) | null {
    const row = this.stmt("SELECT * FROM profiles WHERE id=?").get(profileId) as Row | undefined;
    if (!row) return null;
    return {
      id: Number(row.id),
      username: String(row.username),
      igId: str(row.ig_id),
      fullName: str(row.full_name),
      biography: str(row.biography),
      externalUrl: str(row.external_url),
      followers: num(row.followers),
      following: num(row.following),
      mediaCount: num(row.media_count),
      isPrivate: row.is_private === null ? null : bool(row.is_private),
      isVerified: bool(row.is_verified),
      profilePicUrl: str(row.profile_pic_url),
    };
  }

  listProfiles(onlyId?: number): Profile[] {
    const rows = (
      onlyId === undefined
        ? this.stmt("SELECT * FROM profiles ORDER BY COALESCE(last_activity, created_at) DESC").all()
        : this.stmt("SELECT * FROM profiles WHERE id=?").all(onlyId)
    ) as Row[];
    if (!rows.length) return [];
    const statsRows = this.stmt(
      `SELECT profile_id, kind, COUNT(*) total,
         SUM(status='downloaded') downloaded, SUM(status='failed') failed,
         SUM(status IN ('pending','downloading')) pending
       FROM media GROUP BY profile_id, kind`,
    ).all() as Row[];
    const syncRows = this.stmt("SELECT profile_id, kind, last_sync FROM sync_state").all() as Row[];
    const coverRows = this.stmt(
      `SELECT profile_id, sha FROM (
         SELECT profile_id, COALESCE(thumb_sha, CASE WHEN media_type=1 THEN asset_sha END) sha,
           ROW_NUMBER() OVER (PARTITION BY profile_id ORDER BY (asset_sha IS NULL), COALESCE(taken_at,0) DESC, id DESC) rn
         FROM media WHERE kind='post' AND COALESCE(thumb_sha, CASE WHEN media_type=1 THEN asset_sha END) IS NOT NULL
       ) WHERE rn <= 4`,
    ).all() as Row[];
    const byteRows = this.stmt(
      `SELECT m.profile_id, COALESCE(SUM(a.bytes),0) bytes FROM media m JOIN assets a ON a.sha256=m.asset_sha GROUP BY m.profile_id`,
    ).all() as Row[];

    const stats = new Map<number, KindStats[]>();
    for (const r of statsRows) {
      const list = stats.get(Number(r.profile_id)) ?? [];
      list.push({
        kind: String(r.kind) as MediaKind,
        total: Number(r.total),
        downloaded: Number(r.downloaded ?? 0),
        failed: Number(r.failed ?? 0),
        pending: Number(r.pending ?? 0),
        lastSync: null,
      });
      stats.set(Number(r.profile_id), list);
    }
    for (const s of syncRows) {
      const list = stats.get(Number(s.profile_id)) ?? [];
      const entry = list.find((k) => k.kind === s.kind);
      if (entry) entry.lastSync = num(s.last_sync);
      else
        list.push({ kind: String(s.kind) as MediaKind, total: 0, downloaded: 0, failed: 0, pending: 0, lastSync: num(s.last_sync) });
      stats.set(Number(s.profile_id), list);
    }
    const covers = new Map<number, string[]>();
    for (const c of coverRows) {
      const list = covers.get(Number(c.profile_id)) ?? [];
      list.push(assetUrl(String(c.sha))!);
      covers.set(Number(c.profile_id), list);
    }
    const bytes = new Map(byteRows.map((r) => [Number(r.profile_id), Number(r.bytes)]));

    const profiles = rows.map(
      (row): Profile => ({
        id: Number(row.id),
        username: String(row.username),
        igId: str(row.ig_id),
        fullName: str(row.full_name),
        biography: str(row.biography),
        externalUrl: str(row.external_url),
        followers: num(row.followers),
        following: num(row.following),
        mediaCount: num(row.media_count),
        isPrivate: row.is_private === null ? null : bool(row.is_private),
        isVerified: bool(row.is_verified),
        isFavorite: bool(row.is_favorite),
        avatarUrl: assetUrl(str(row.avatar_sha)),
        fetchedAt: num(row.fetched_at),
        createdAt: Number(row.created_at),
        lastActivity: num(row.last_activity),
        cover: covers.get(Number(row.id)) ?? [],
        stats: stats.get(Number(row.id)) ?? [],
        bytes: bytes.get(Number(row.id)) ?? 0,
      }),
    );
    return profiles;
  }

  // ------------------------------------------------------------------- media
  upsertMedia(profileId: number, items: ExtractedMedia[]): UpsertResult {
    const result: UpsertResult = { inserted: 0, updated: 0, ids: [], needThumb: [] };
    this.tx(() => {
      for (const item of items) {
        const existing = (
          item.publicationCode
            ? this.stmt(
                "SELECT id, media_id, status, source, quality_verified, thumb_sha FROM media WHERE profile_id=? AND kind=? AND publication_code=? AND child_index=?",
              ).get(profileId, item.kind, item.publicationCode, item.childIndex)
            : this.stmt(
                "SELECT id, media_id, status, source, quality_verified, thumb_sha FROM media WHERE profile_id=? AND kind=? AND media_id=?",
              ).get(profileId, item.kind, item.mediaId)
        ) as Row | undefined;
        const expires = cdnExpiry(item.bestUrl);
        if (existing) {
          const id = Number(existing.id);
          const incomingWeaker = item.source === "dom_fallback" && existing.source !== "dom_fallback";
          if (!incomingWeaker) {
            const clash =
              String(existing.media_id) !== item.mediaId &&
              this.stmt("SELECT 1 FROM media WHERE profile_id=? AND kind=? AND media_id=? AND id<>?").get(
                profileId,
                item.kind,
                item.mediaId,
                id,
              );
            this.stmt(
              `UPDATE media SET media_id=?, best_url=COALESCE(?, best_url), url_expires_at=CASE WHEN ? IS NULL THEN url_expires_at ELSE ? END,
                 thumbnail_url=COALESCE(?, thumbnail_url),
                 caption=COALESCE(?, caption), taken_at=COALESCE(?, taken_at), media_type=?, width=?, height=?,
                 bitrate=?, duration=COALESCE(?, duration), quality_verified=?, source=?, child_count=?,
                 highlight_id=COALESCE(?, highlight_id),
                 status=CASE WHEN status='failed' THEN 'pending' ELSE status END,
                 error=CASE WHEN status='failed' THEN NULL ELSE error END
               WHERE id=?`,
            ).run(
              clash ? String(existing.media_id) : item.mediaId,
              item.bestUrl || null,
              item.bestUrl || null,
              expires,
              item.thumbnailUrl,
              item.caption,
              item.takenAt,
              item.mediaType,
              item.width,
              item.height,
              item.bitrate,
              item.duration,
              item.qualityVerified ? 1 : 0,
              item.source,
              item.childCount,
              item.highlightId ?? null,
              id,
            );
            result.updated++;
          }
          result.ids.push(id);
          if (!existing.thumb_sha && item.thumbnailUrl) result.needThumb.push({ id, url: item.thumbnailUrl });
          continue;
        }
        const inserted = this.stmt(
          `INSERT INTO media(profile_id, kind, media_id, publication_code, child_index, child_count, highlight_id,
             taken_at, caption, media_type, best_url, url_expires_at, thumbnail_url, width, height, bitrate, duration,
             quality_verified, source, status, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)
           ON CONFLICT(profile_id, kind, media_id) DO NOTHING`,
        ).run(
          profileId,
          item.kind,
          item.mediaId,
          item.publicationCode,
          item.childIndex,
          item.childCount,
          item.highlightId ?? null,
          item.takenAt,
          item.caption,
          item.mediaType,
          item.bestUrl || null,
          expires,
          item.thumbnailUrl,
          item.width,
          item.height,
          item.bitrate,
          item.duration,
          item.qualityVerified ? 1 : 0,
          item.source,
          now(),
        );
        if (Number(inserted.changes) > 0) {
          const id = Number(inserted.lastInsertRowid);
          result.inserted++;
          result.ids.push(id);
          if (item.thumbnailUrl) result.needThumb.push({ id, url: item.thumbnailUrl });
        }
      }
    });
    return result;
  }

  listMedia(profileId: number, kind?: MediaKind | null): Media[] {
    const rows = (
      kind
        ? this.stmt(MEDIA_SELECT + " WHERE m.profile_id=? AND m.kind=? ORDER BY COALESCE(m.taken_at,0) DESC, m.publication_code, m.child_index").all(
            profileId,
            kind,
          )
        : this.stmt(MEDIA_SELECT + " WHERE m.profile_id=? ORDER BY COALESCE(m.taken_at,0) DESC, m.publication_code, m.child_index").all(profileId)
    ) as Row[];
    return rows.map(toMedia);
  }

  mediaByIds(ids: number[]): Media[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    return (this.db.prepare(MEDIA_SELECT + ` WHERE m.id IN (${placeholders})`).all(...ids) as Row[]).map(toMedia);
  }

  downloadRows(where: { ids?: number[]; profileId?: number; kind?: MediaKind; includeFailed?: boolean; force?: boolean }): MediaDownloadRow[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (where.ids?.length) {
      clauses.push(`m.id IN (${where.ids.map(() => "?").join(",")})`);
      params.push(...where.ids);
    }
    if (where.profileId !== undefined) {
      clauses.push("m.profile_id=?");
      params.push(where.profileId);
    }
    if (where.kind) {
      clauses.push("m.kind=?");
      params.push(where.kind);
    }
    if (!where.force) {
      clauses.push(where.includeFailed ? "m.status IN ('pending','failed')" : "m.status='pending'");
    } else {
      clauses.push("m.status<>'downloading'");
    }
    const sql = `SELECT m.*, p.username, p.is_private FROM media m JOIN profiles p ON p.id=m.profile_id
                 WHERE ${clauses.join(" AND ")} ORDER BY COALESCE(m.taken_at,0) DESC, m.child_index`;
    return (this.db.prepare(sql).all(...params) as Row[]).map((r) => ({
      id: Number(r.id),
      profileId: Number(r.profile_id),
      username: String(r.username),
      isPrivate: bool(r.is_private),
      kind: String(r.kind) as MediaKind,
      mediaId: String(r.media_id),
      publicationCode: str(r.publication_code),
      childIndex: Number(r.child_index),
      highlightId: str(r.highlight_id),
      mediaType: Number(r.media_type) === 2 ? 2 : 1,
      bestUrl: str(r.best_url),
      urlExpiresAt: num(r.url_expires_at),
      thumbnailUrl: str(r.thumbnail_url),
      thumbSha: str(r.thumb_sha),
      status: String(r.status) as MediaStatus,
      width: num(r.width),
      height: num(r.height),
      bitrate: num(r.bitrate),
      qualityVerified: bool(r.quality_verified),
      source: str(r.source),
    }));
  }

  setMediaStatus(id: number, status: MediaStatus, error: string | null = null) {
    this.stmt("UPDATE media SET status=?, error=? WHERE id=?").run(status, error, id);
  }

  markDownloaded(id: number, sha: string, extra: { width: number | null; height: number | null; thumbSha: string | null }) {
    this.stmt(
      `UPDATE media SET status='downloaded', error=NULL, asset_sha=?, downloaded_at=?,
         width=COALESCE(?, width), height=COALESCE(?, height), thumb_sha=COALESCE(?, thumb_sha) WHERE id=?`,
    ).run(sha, now(), extra.width, extra.height, extra.thumbSha, id);
  }

  setThumb(id: number, sha: string) {
    this.stmt("UPDATE media SET thumb_sha=? WHERE id=?").run(sha, id);
  }

  updateCandidate(id: number, item: Pick<ExtractedMedia, "bestUrl" | "width" | "height" | "bitrate" | "qualityVerified" | "source" | "thumbnailUrl">) {
    this.stmt(
      `UPDATE media SET best_url=?, url_expires_at=?, width=COALESCE(?, width), height=COALESCE(?, height),
         bitrate=COALESCE(?, bitrate), quality_verified=?, source=?, thumbnail_url=COALESCE(?, thumbnail_url) WHERE id=?`,
    ).run(
      item.bestUrl,
      cdnExpiry(item.bestUrl),
      item.width,
      item.height,
      item.bitrate,
      item.qualityVerified ? 1 : 0,
      item.source,
      item.thumbnailUrl,
      id,
    );
  }

  /** Vuelve a pendiente (re-descarga). El archivo queda huérfano hasta el GC. */
  resetMedia(ids: number[]): number {
    if (!ids.length) return 0;
    const placeholders = ids.map(() => "?").join(",");
    const r = this.db
      .prepare(`UPDATE media SET status='pending', error=NULL, asset_sha=NULL, downloaded_at=NULL WHERE id IN (${placeholders}) AND status<>'downloading'`)
      .run(...ids);
    return Number(r.changes);
  }

  removeMedia(ids: number[]): number {
    if (!ids.length) return 0;
    const placeholders = ids.map(() => "?").join(",");
    return Number(this.db.prepare(`DELETE FROM media WHERE id IN (${placeholders})`).run(...ids).changes);
  }

  profileIdsForMedia(ids: number[]): number[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    return (this.db.prepare(`SELECT DISTINCT profile_id FROM media WHERE id IN (${placeholders})`).all(...ids) as Row[]).map((r) =>
      Number(r.profile_id),
    );
  }

  // -------------------------------------------------------------- highlights
  upsertHighlights(profileId: number, list: ExtractedHighlight[]) {
    this.tx(() => {
      list.forEach((h, position) => {
        this.stmt(
          `INSERT INTO highlights(profile_id, highlight_id, title, cover_url, item_count, position, fetched_at)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(profile_id, highlight_id) DO UPDATE SET title=excluded.title, cover_url=excluded.cover_url,
             item_count=excluded.item_count, position=excluded.position, fetched_at=excluded.fetched_at`,
        ).run(profileId, h.highlightId, h.title, h.coverUrl, h.itemCount, position, now());
      });
    });
  }

  highlightsNeedingCover(profileId: number): Array<{ id: number; url: string }> {
    return (
      this.stmt("SELECT id, cover_url FROM highlights WHERE profile_id=? AND cover_sha IS NULL AND cover_url IS NOT NULL").all(
        profileId,
      ) as Row[]
    ).map((r) => ({ id: Number(r.id), url: String(r.cover_url) }));
  }

  setHighlightCover(id: number, sha: string) {
    this.stmt("UPDATE highlights SET cover_sha=? WHERE id=?").run(sha, id);
  }

  listHighlights(profileId: number): Highlight[] {
    return (
      this.stmt(
        `SELECT h.*, (SELECT COUNT(*) FROM media m WHERE m.profile_id=h.profile_id AND m.kind='highlight' AND m.highlight_id=h.highlight_id) local_count
         FROM highlights h WHERE profile_id=? ORDER BY position`,
      ).all(profileId) as Row[]
    ).map((r) => ({
      id: Number(r.id),
      profileId: Number(r.profile_id),
      highlightId: String(r.highlight_id),
      title: String(r.title),
      coverUrl: assetUrl(str(r.cover_sha)),
      itemCount: Math.max(Number(r.item_count), Number(r.local_count)),
    }));
  }

  // ------------------------------------------------------------------- sync
  getSync(profileId: number, kind: MediaKind): (SyncState & { cursor: string | null; lastCode: string | null }) | null {
    const r = this.stmt("SELECT * FROM sync_state WHERE profile_id=? AND kind=?").get(profileId, kind) as Row | undefined;
    return r ? { ...toSync(r), cursor: str(r.cursor), lastCode: str(r.last_code) } : null;
  }

  listSync(profileId: number): SyncState[] {
    return (this.stmt("SELECT * FROM sync_state WHERE profile_id=?").all(profileId) as Row[]).map(toSync);
  }

  saveSync(input: {
    profileId: number;
    kind: MediaKind;
    access: AccessMode;
    cursor: string | null;
    lastCode: string | null;
    seen: number;
    status: SyncStatus;
    stopReason: string | null;
  }) {
    this.stmt(
      `INSERT INTO sync_state(profile_id, kind, access, cursor, last_code, seen, status, stop_reason, updated_at, last_sync)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(profile_id, kind) DO UPDATE SET access=excluded.access, cursor=excluded.cursor, last_code=excluded.last_code,
         seen=excluded.seen, status=excluded.status, stop_reason=excluded.stop_reason, updated_at=excluded.updated_at,
         last_sync=excluded.last_sync`,
    ).run(
      input.profileId,
      input.kind,
      input.access,
      input.cursor,
      input.lastCode,
      input.seen,
      input.status,
      input.stopReason,
      now(),
      now(),
    );
    this.touchProfile(input.profileId);
  }

  // ------------------------------------------------------------------- jobs
  insertJob(profileId: number | null, label: string, total: number): number {
    return Number(
      this.stmt("INSERT INTO jobs(profile_id, label, total, status, started_at) VALUES (?,?,?,'running',?)").run(profileId, label, total, now())
        .lastInsertRowid,
    );
  }

  finishJob(id: number, ok: number, failed: number, status: Job["status"]) {
    this.stmt("UPDATE jobs SET ok=?, failed=?, status=?, finished_at=? WHERE id=?").run(ok, failed, status, now(), id);
  }

  getJob(id: number): Job | null {
    const r = this.stmt("SELECT j.*, p.username FROM jobs j LEFT JOIN profiles p ON p.id=j.profile_id WHERE j.id=?").get(id) as
      | Row
      | undefined;
    return r ? toJob(r) : null;
  }

  listJobs(limit = 40): Job[] {
    return (
      this.stmt("SELECT j.*, p.username FROM jobs j LEFT JOIN profiles p ON p.id=j.profile_id ORDER BY j.id DESC LIMIT ?").all(limit) as Row[]
    ).map(toJob);
  }

  clearFinishedJobs() {
    this.stmt("DELETE FROM jobs WHERE status<>'running'").run();
  }

  // ------------------------------------------------------------------ quick
  addQuick(entry: { url: string; ownerUsername: string | null; itemCount: number; thumbSha: string | null; savedLibrary: boolean }) {
    this.stmt("INSERT INTO quick_downloads(url, owner_username, item_count, thumb_sha, saved_library, created_at) VALUES (?,?,?,?,?,?)").run(
      entry.url,
      entry.ownerUsername,
      entry.itemCount,
      entry.thumbSha,
      entry.savedLibrary ? 1 : 0,
      now(),
    );
  }

  listQuick(): QuickHistoryEntry[] {
    return (this.stmt("SELECT * FROM quick_downloads ORDER BY id DESC LIMIT 60").all() as Row[]).map((r) => ({
      id: Number(r.id),
      url: String(r.url),
      ownerUsername: str(r.owner_username),
      itemCount: Number(r.item_count),
      thumbUrl: assetUrl(str(r.thumb_sha)),
      savedToLibrary: bool(r.saved_library),
      createdAt: Number(r.created_at),
    }));
  }

  clearQuick() {
    this.stmt("DELETE FROM quick_downloads").run();
  }

  // ------------------------------------------------------------------ stats
  libraryStats(): LibraryStats {
    const r = this.stmt(
      `SELECT (SELECT COUNT(*) FROM profiles) profiles, COUNT(m.id) media,
         COALESCE(SUM(m.status='downloaded'),0) downloaded, COALESCE(SUM(m.status='failed'),0) failed,
         (SELECT COALESCE(SUM(a.bytes),0) FROM assets a) bytes
       FROM media m`,
    ).get() as Row;
    return {
      profiles: Number(r.profiles),
      media: Number(r.media),
      downloaded: Number(r.downloaded),
      failed: Number(r.failed),
      bytes: Number(r.bytes),
    };
  }
}

const MEDIA_SELECT = `SELECT m.*, a.bytes asset_bytes, a.mime asset_mime FROM media m LEFT JOIN assets a ON a.sha256=m.asset_sha`;

function toAccount(r: Row): Account {
  return {
    id: Number(r.id),
    username: String(r.username),
    igUserId: str(r.ig_user_id),
    status: String(r.status) === "valid" ? "valid" : "reconnect_required",
    avatarUrl: assetUrl(str(r.avatar_sha)),
    addedAt: Number(r.added_at),
    lastValid: num(r.last_valid),
  };
}

function toMedia(r: Row): Media {
  const assetSha = str(r.asset_sha);
  const thumbSha = str(r.thumb_sha);
  const mediaType = Number(r.media_type) === 2 ? 2 : 1;
  return {
    id: Number(r.id),
    profileId: Number(r.profile_id),
    kind: String(r.kind) as MediaKind,
    mediaId: String(r.media_id),
    publicationCode: str(r.publication_code),
    childIndex: Number(r.child_index),
    childCount: Number(r.child_count),
    highlightId: str(r.highlight_id),
    takenAt: num(r.taken_at),
    caption: str(r.caption),
    mediaType,
    width: num(r.width),
    height: num(r.height),
    bitrate: num(r.bitrate),
    duration: num(r.duration),
    qualityVerified: bool(r.quality_verified),
    source: str(r.source),
    status: String(r.status) as MediaStatus,
    error: str(r.error),
    contentUrl: assetUrl(assetSha),
    thumbUrl: assetUrl(thumbSha ?? (mediaType === 1 ? assetSha : null)),
    bytes: num(r.asset_bytes),
    sha256: assetSha,
    mime: str(r.asset_mime),
    downloadedAt: num(r.downloaded_at),
  };
}

function toSync(r: Row): SyncState {
  return {
    profileId: Number(r.profile_id),
    kind: String(r.kind) as MediaKind,
    access: String(r.access) === "account" ? "account" : "public",
    status: String(r.status) as SyncStatus,
    seen: Number(r.seen),
    stopReason: str(r.stop_reason),
    updatedAt: Number(r.updated_at),
    lastSync: num(r.last_sync),
  };
}

function toJob(r: Row): Job {
  return {
    id: Number(r.id),
    profileId: num(r.profile_id),
    username: str(r.username),
    label: String(r.label),
    total: Number(r.total),
    ok: Number(r.ok),
    failed: Number(r.failed),
    status: String(r.status) as Job["status"],
    startedAt: Number(r.started_at),
    finishedAt: num(r.finished_at),
  };
}
