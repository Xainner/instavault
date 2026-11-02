import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Repo } from "../src/main/db/repo";
import { importLegacyLibrary, legacyInfo } from "../src/main/legacy/tauri-import";
import { VaultStore, sniffMime } from "../src/main/vault/store";
import type { ExtractedMedia } from "../src/main/ig/types";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);
const MP4 = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 9, 9, 9]);

function media(partial: Partial<ExtractedMedia>): ExtractedMedia {
  return {
    mediaId: "1",
    publicationCode: "CODE",
    childIndex: 0,
    childCount: 1,
    kind: "post",
    takenAt: 100,
    caption: null,
    mediaType: 1,
    bestUrl: "https://scontent.cdninstagram.com/a.jpg?oe=7FFFFFFF",
    thumbnailUrl: "https://scontent.cdninstagram.com/t.jpg",
    width: 1080,
    height: 1350,
    bitrate: null,
    duration: null,
    qualityVerified: true,
    source: "web_api",
    ...partial,
  };
}

let dir: string;
let repo: Repo;
let store: VaultStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "iv-test-"));
  repo = new Repo(join(dir, "library.db"));
  store = new VaultStore(join(dir, "vault"), repo);
});

afterEach(() => {
  repo.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("almacén direccionado por contenido", () => {
  it("guarda, deduplica y detecta el tipo real", async () => {
    const a = await store.ingestBuffer(JPEG, { bucket: "media", mime: "application/octet-stream" });
    expect(a.mime).toBe("image/jpeg");
    expect(a.sha256).toBe(sha(JPEG));
    expect(a.relPath).toMatch(/^media[\\/][0-9a-f]{2}[\\/][0-9a-f]{64}\.jpg$/);
    const b = await store.ingestStream(Readable.from([Buffer.from(JPEG)]), { bucket: "media", mime: "image/jpeg" });
    expect(b.created).toBe(false);
    expect(repo.assetTotals().assets).toBe(1);
    expect(sniffMime(MP4, "x")).toBe("video/mp4");
  });

  it("exporta verificando el SHA-256 y recoge huérfanos", async () => {
    const a = await store.ingestBuffer(JPEG, { bucket: "media", mime: "image/jpeg" });
    const target = join(dir, "export", "copia.jpg");
    await store.exportTo(a.sha256, target);
    expect(sha(readFileSync(target))).toBe(a.sha256);
    expect(repo.orphanAssets().map((x) => x.sha256)).toEqual([a.sha256]);
    await store.removeAsset(repo.orphanAssets()[0]);
    expect(existsSync(a.absPath)).toBe(false);
  });
});

describe("biblioteca", () => {
  it("una fuente verificada mejora la fila del DOM sin duplicar", () => {
    const profileId = repo.ensureProfile("demo");
    repo.upsertMedia(profileId, [media({ mediaId: "web_CODE", source: "dom_fallback", qualityVerified: false, width: 640 })]);
    const result = repo.upsertMedia(profileId, [media({ mediaId: "999", width: 1440 })]);
    const rows = repo.listMedia(profileId, "post");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mediaId: "999", width: 1440, qualityVerified: true });
    expect(result.updated).toBe(1);
  });

  it("una fila verificada no se degrada con datos del DOM", () => {
    const profileId = repo.ensureProfile("demo");
    repo.upsertMedia(profileId, [media({ mediaId: "999", width: 1440 })]);
    repo.upsertMedia(profileId, [media({ mediaId: "web_CODE", source: "dom_fallback", qualityVerified: false, width: 320 })]);
    expect(repo.listMedia(profileId, "post")[0]).toMatchObject({ mediaId: "999", width: 1440 });
  });

  it("guarda la expiración de la URL y re-encola fallidos al refrescar", () => {
    const profileId = repo.ensureProfile("demo");
    const { ids } = repo.upsertMedia(profileId, [media({ bestUrl: "https://scontent.cdninstagram.com/a.jpg?oe=65000000" })]);
    repo.setMediaStatus(ids[0], "failed", "HTTP 403");
    repo.upsertMedia(profileId, [media({ bestUrl: "https://scontent.cdninstagram.com/b.jpg?oe=7FFFFFFF" })]);
    const row = repo.downloadRows({ ids })[0];
    expect(row.status).toBe("pending");
    expect(row.urlExpiresAt).toBe(0x7fffffff);
  });

  it("calcula estadísticas y mosaico por perfil", async () => {
    const profileId = repo.ensureProfile("demo");
    const { ids } = repo.upsertMedia(profileId, [media({ mediaId: "1", publicationCode: "A" }), media({ mediaId: "2", publicationCode: "B" })]);
    const asset = await store.ingestBuffer(JPEG, { bucket: "media", mime: "image/jpeg" });
    repo.markDownloaded(ids[0], asset.sha256, { width: 10, height: 10, thumbSha: null });
    const [profile] = repo.listProfiles(profileId);
    expect(profile.stats.find((s) => s.kind === "post")).toMatchObject({ total: 2, downloaded: 1, pending: 1 });
    expect(profile.cover).toEqual([`vault://a/${asset.sha256}`]);
    expect(profile.bytes).toBe(JPEG.length);
  });
});

describe("importación de InstaVault 1.x", () => {
  function legacyDb(path: string) {
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE accounts (id INTEGER PRIMARY KEY, username TEXT, keyring_ref TEXT, added_at INTEGER, last_valid INTEGER, status TEXT, auth_mode TEXT);
      CREATE TABLE profiles (id INTEGER PRIMARY KEY, username TEXT, pk TEXT, full_name TEXT, biography TEXT, followers INTEGER, following INTEGER,
        media_count INTEGER, is_private INTEGER, is_verified INTEGER, profile_pic_url TEXT, is_favorite INTEGER, fetched_at INTEGER, avatar_local_path TEXT);
      CREATE TABLE media (id INTEGER PRIMARY KEY, media_id TEXT, profile_id INTEGER, kind TEXT, code TEXT, taken_at INTEGER, caption TEXT, media_type INTEGER,
        thumbnail_url TEXT, best_url TEXT, local_path TEXT, status TEXT, error TEXT, created_at INTEGER, width INTEGER, height INTEGER, bitrate INTEGER,
        byte_size INTEGER, quality_verified INTEGER, publication_code TEXT, child_index INTEGER);
      CREATE TABLE media_content (media_id INTEGER PRIMARY KEY, data BLOB, mime_type TEXT, byte_size INTEGER, sha256 TEXT, width INTEGER, height INTEGER,
        bitrate INTEGER, quality_verified INTEGER, source TEXT, downloaded_at INTEGER);
      CREATE TABLE media_thumbnail_content (media_id INTEGER PRIMARY KEY, data BLOB, mime_type TEXT, byte_size INTEGER, sha256 TEXT, downloaded_at INTEGER);
      CREATE TABLE profile_avatar_content (profile_id INTEGER PRIMARY KEY, data BLOB, mime_type TEXT, byte_size INTEGER, sha256 TEXT, downloaded_at INTEGER);
      CREATE TABLE sync_progress (profile_id INTEGER, kind TEXT, access_mode TEXT, last_shortcode TEXT, publications_seen INTEGER, status TEXT, stop_reason TEXT, updated_at INTEGER);
    `);
    db.prepare("INSERT INTO accounts VALUES (1,'mi.cuenta','account:1',1,1,'valid','legacy_cookie')").run();
    db.prepare("INSERT INTO profiles VALUES (1,'viejo.perfil','77','Viejo','bio',10,5,3,0,1,'https://x/pic.jpg',1,1,NULL)").run();
    const insert = db.prepare("INSERT INTO media VALUES (?,?,1,'post',?,?,NULL,?,NULL,?,NULL,?,?,1,1080,1350,NULL,NULL,1,?,?)");
    insert.run(1, "500_0", "CAR", 10, 1, "https://scontent.cdninstagram.com/a.jpg?oe=6700A1B2", "downloaded", null, "CAR", 0);
    insert.run(2, "500_1", "CAR", 10, 2, "https://scontent.cdninstagram.com/b.mp4", "downloaded", null, "CAR", 1);
    insert.run(3, "501", "ONE", 9, 1, "https://scontent.cdninstagram.com/c.jpg", "failed", "HTTP 403", "ONE", 0);
    insert.run(4, "502", "TWO", 8, 1, "https://scontent.cdninstagram.com/d.jpg", "metadata", null, "TWO", 0);
    db.prepare("INSERT INTO media_content VALUES (1,?,'image/jpeg',12,'x',1080,1350,NULL,1,'web_response',5)").run(JPEG);
    db.prepare("INSERT INTO media_content VALUES (2,?,'video/mp4',15,'y',720,900,2400,1,'web_response',6)").run(MP4);
    db.prepare("INSERT INTO media_thumbnail_content VALUES (2,?,'image/jpeg',12,'z',1)").run(JPEG);
    db.prepare("INSERT INTO profile_avatar_content VALUES (1,?,'image/jpeg',12,'w',1)").run(JPEG);
    db.prepare("INSERT INTO sync_progress VALUES (1,'post','public_anonymous','TWO',3,'anonymous_limit','muro',1)").run();
    db.close();
  }

  it("importa perfiles, medios y archivos sin tocar el original", async () => {
    const legacyPath = join(dir, "instakeeper.db");
    legacyDb(legacyPath);
    const before = sha(readFileSync(legacyPath));
    const paths = { database: legacyPath, browserProfile: join(dir, "nope"), backupDir: join(dir, "backups") };
    expect(legacyInfo(paths, repo)).toMatchObject({ available: true, profiles: 1, media: 4, downloaded: 2, done: false });

    const result = await importLegacyLibrary(paths, repo, store, () => undefined);
    expect(result).toMatchObject({ profiles: 1, media: 4 });
    expect(sha(readFileSync(legacyPath))).toBe(before);

    const [profile] = repo.listProfiles();
    expect(profile).toMatchObject({ username: "viejo.perfil", isFavorite: true, isVerified: true });
    expect(profile.avatarUrl).toBe(`vault://a/${sha(JPEG)}`);

    const rows = repo.listMedia(profile.id, "post");
    const byId = new Map(rows.map((r) => [r.mediaId, r]));
    expect(byId.get("500_0")).toMatchObject({ status: "downloaded", sha256: sha(JPEG), childCount: 2, qualityVerified: true });
    expect(byId.get("500_1")).toMatchObject({ status: "downloaded", sha256: sha(MP4), mediaType: 2, thumbUrl: `vault://a/${sha(JPEG)}` });
    expect(byId.get("501")).toMatchObject({ status: "failed", error: "HTTP 403" });
    expect(byId.get("502")).toMatchObject({ status: "pending" });

    expect(repo.getSync(profile.id, "post")).toMatchObject({ access: "public", status: "anonymous_limit", lastCode: "TWO", seen: 3 });
    expect(repo.listAccounts()).toMatchObject([{ username: "mi.cuenta", status: "reconnect_required" }]);
    expect(legacyInfo(paths, repo).done).toBe(true);

    // Es idempotente: una segunda importación no duplica nada.
    await importLegacyLibrary(paths, repo, store, () => undefined);
    expect(repo.listMedia(profile.id, "post")).toHaveLength(4);
  });
});
