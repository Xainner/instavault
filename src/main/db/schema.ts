/**
 * Migraciones idempotentes y versionadas con PRAGMA user_version.
 * SQLite guarda sólo metadatos; los bytes viven en el almacén de archivos.
 */
export const MIGRATIONS: string[] = [
  /* v1 */ `
  CREATE TABLE accounts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT NOT NULL UNIQUE,
    ig_user_id  TEXT,
    partition   TEXT NOT NULL UNIQUE,
    status      TEXT NOT NULL DEFAULT 'valid',
    avatar_sha  TEXT,
    added_at    INTEGER NOT NULL,
    last_valid  INTEGER
  );

  CREATE TABLE assets (
    sha256     TEXT PRIMARY KEY,
    rel_path   TEXT NOT NULL,
    mime       TEXT NOT NULL,
    bytes      INTEGER NOT NULL,
    width      INTEGER,
    height     INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE profiles (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    username        TEXT NOT NULL UNIQUE,
    ig_id           TEXT,
    full_name       TEXT,
    biography       TEXT,
    external_url    TEXT,
    followers       INTEGER,
    following       INTEGER,
    media_count     INTEGER,
    is_private      INTEGER,
    is_verified     INTEGER NOT NULL DEFAULT 0,
    is_favorite     INTEGER NOT NULL DEFAULT 0,
    profile_pic_url TEXT,
    avatar_sha      TEXT REFERENCES assets(sha256),
    fetched_at      INTEGER,
    created_at      INTEGER NOT NULL,
    last_activity   INTEGER
  );

  CREATE TABLE media (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id       INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    kind             TEXT NOT NULL CHECK (kind IN ('post','story','highlight')),
    media_id         TEXT NOT NULL,
    publication_code TEXT,
    child_index      INTEGER NOT NULL DEFAULT 0,
    child_count      INTEGER NOT NULL DEFAULT 1,
    highlight_id     TEXT,
    taken_at         INTEGER,
    caption          TEXT,
    media_type       INTEGER NOT NULL DEFAULT 1,
    best_url         TEXT,
    url_expires_at   INTEGER,
    thumbnail_url    TEXT,
    width            INTEGER,
    height           INTEGER,
    bitrate          INTEGER,
    duration         REAL,
    quality_verified INTEGER NOT NULL DEFAULT 0,
    source           TEXT,
    status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','downloading','downloaded','failed')),
    error            TEXT,
    asset_sha        TEXT REFERENCES assets(sha256),
    thumb_sha        TEXT REFERENCES assets(sha256),
    downloaded_at    INTEGER,
    created_at       INTEGER NOT NULL,
    UNIQUE (profile_id, kind, media_id)
  );
  CREATE INDEX media_profile_kind ON media(profile_id, kind, taken_at DESC);
  CREATE INDEX media_publication ON media(profile_id, kind, publication_code, child_index);
  CREATE INDEX media_status ON media(status);

  CREATE TABLE highlights (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id   INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    highlight_id TEXT NOT NULL,
    title        TEXT NOT NULL DEFAULT '',
    cover_url    TEXT,
    cover_sha    TEXT REFERENCES assets(sha256),
    item_count   INTEGER NOT NULL DEFAULT 0,
    position     INTEGER NOT NULL DEFAULT 0,
    fetched_at   INTEGER,
    UNIQUE (profile_id, highlight_id)
  );

  CREATE TABLE sync_state (
    profile_id  INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    access      TEXT NOT NULL,
    cursor      TEXT,
    last_code   TEXT,
    seen        INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL,
    stop_reason TEXT,
    updated_at  INTEGER NOT NULL,
    last_sync   INTEGER,
    PRIMARY KEY (profile_id, kind)
  );

  CREATE TABLE jobs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id  INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
    label       TEXT NOT NULL,
    total       INTEGER NOT NULL,
    ok          INTEGER NOT NULL DEFAULT 0,
    failed      INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'running',
    started_at  INTEGER NOT NULL,
    finished_at INTEGER
  );

  CREATE TABLE quick_downloads (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    url            TEXT NOT NULL,
    owner_username TEXT,
    item_count     INTEGER NOT NULL,
    thumb_sha      TEXT REFERENCES assets(sha256),
    saved_library  INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL
  );

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];
