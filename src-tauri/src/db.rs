use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Debug, Clone)]
pub struct ContentRecord {
    pub data: Vec<u8>,
    pub mime_type: String,
    pub byte_size: i64,
    pub sha256: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub bitrate: Option<i64>,
    pub quality_verified: bool,
}

pub struct Db {
    conn: Connection,
}

impl Db {
    pub fn open(dir: &Path) -> rusqlite::Result<Self> {
        std::fs::create_dir_all(dir).ok();
        let path = dir.join("instakeeper.db");
        let conn = Connection::open(&path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        let mut db = Db { conn };
        db.migrate()?;
        db.migrate_legacy_files()?;
        Ok(db)
    }

    fn migrate(&self) -> rusqlite::Result<()> {
        self.conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS accounts (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                username    TEXT UNIQUE NOT NULL,
                keyring_ref TEXT NOT NULL,
                added_at    INTEGER NOT NULL,
                last_valid  INTEGER,
                status      TEXT NOT NULL DEFAULT 'unknown'
            );

            CREATE TABLE IF NOT EXISTS profiles (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                username        TEXT UNIQUE NOT NULL,
                pk              TEXT,
                full_name       TEXT,
                biography       TEXT,
                followers       INTEGER,
                following       INTEGER,
                media_count     INTEGER,
                is_private      INTEGER,
                is_verified     INTEGER,
                profile_pic_url TEXT,
                is_favorite     INTEGER NOT NULL DEFAULT 0,
                fetched_at      INTEGER
            );

            CREATE TABLE IF NOT EXISTS media (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                media_id     TEXT UNIQUE NOT NULL,
                profile_id   INTEGER REFERENCES profiles(id) ON DELETE CASCADE,
                kind         TEXT NOT NULL,
                code         TEXT,
                taken_at     INTEGER,
                caption      TEXT,
                media_type   INTEGER,
                thumbnail_url TEXT,
                best_url     TEXT,
                local_path   TEXT,
                status       TEXT NOT NULL DEFAULT 'metadata',
                error        TEXT,
                created_at   INTEGER
            );

            CREATE TABLE IF NOT EXISTS highlights (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                title        TEXT,
                highlight_id TEXT UNIQUE,
                profile_id   INTEGER REFERENCES profiles(id) ON DELETE CASCADE,
                fetched_at   INTEGER
            );

            CREATE TABLE IF NOT EXISTS sync_stats (
                profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
                kind       TEXT NOT NULL,
                last_sync  INTEGER,
                PRIMARY KEY (profile_id, kind)
            );

            CREATE TABLE IF NOT EXISTS download_jobs (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                profile_id  INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
                kind        TEXT NOT NULL,
                total       INTEGER NOT NULL,
                ok          INTEGER NOT NULL DEFAULT 0,
                failed      INTEGER NOT NULL DEFAULT 0,
                started_at  INTEGER NOT NULL,
                finished_at INTEGER
            );

            CREATE TABLE IF NOT EXISTS media_content (
                media_id         INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
                data             BLOB NOT NULL,
                mime_type        TEXT NOT NULL,
                byte_size        INTEGER NOT NULL,
                sha256           TEXT NOT NULL,
                width            INTEGER,
                height           INTEGER,
                bitrate          INTEGER,
                quality_verified INTEGER NOT NULL DEFAULT 0,
                source           TEXT NOT NULL DEFAULT 'legacy',
                downloaded_at    INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS profile_avatar_content (
                profile_id    INTEGER PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
                data          BLOB NOT NULL,
                mime_type     TEXT NOT NULL,
                byte_size     INTEGER NOT NULL,
                sha256        TEXT NOT NULL,
                downloaded_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS media_thumbnail_content (
                media_id      INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
                data          BLOB NOT NULL,
                mime_type     TEXT NOT NULL,
                byte_size     INTEGER NOT NULL,
                sha256        TEXT NOT NULL,
                downloaded_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sync_progress (
                profile_id        INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
                kind              TEXT NOT NULL,
                access_mode       TEXT NOT NULL,
                last_shortcode    TEXT,
                publications_seen INTEGER NOT NULL DEFAULT 0,
                status            TEXT NOT NULL,
                stop_reason       TEXT,
                updated_at        INTEGER NOT NULL,
                PRIMARY KEY (profile_id, kind)
            );
            "#,
        )?;
        // Migration para BDs existentes (idempotente): la columna is_favorite
        // no existía en el CREATE original.
        if !Self::column_exists(&self.conn, "profiles", "is_favorite") {
            self.conn.execute(
                "ALTER TABLE profiles ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        // Copia local de la foto de perfil (servida vía asset-protocol).
        if !Self::column_exists(&self.conn, "profiles", "avatar_local_path") {
            self.conn
                .execute("ALTER TABLE profiles ADD COLUMN avatar_local_path TEXT", [])?;
        }
        if !Self::column_exists(&self.conn, "accounts", "auth_mode") {
            self.conn.execute(
                "ALTER TABLE accounts ADD COLUMN auth_mode TEXT NOT NULL DEFAULT 'legacy_cookie'",
                [],
            )?;
            self.conn.execute(
                "UPDATE accounts SET status='reconnect_required' WHERE auth_mode='legacy_cookie'",
                [],
            )?;
        }
        for (name, definition) in [
            ("width", "INTEGER"),
            ("height", "INTEGER"),
            ("bitrate", "INTEGER"),
            ("byte_size", "INTEGER"),
            ("quality_verified", "INTEGER NOT NULL DEFAULT 0"),
            ("publication_code", "TEXT"),
            ("child_index", "INTEGER NOT NULL DEFAULT 0"),
        ] {
            if !Self::column_exists(&self.conn, "media", name) {
                self.conn.execute(
                    &format!("ALTER TABLE media ADD COLUMN {name} {definition}"),
                    [],
                )?;
            }
        }
        self.conn.execute(
            "UPDATE media SET publication_code=code WHERE publication_code IS NULL AND code IS NOT NULL",
            [],
        )?;
        // Recalcular posiciones puede intercambiar índices ya existentes. Se
        // suspende la restricción durante esta migración idempotente para no
        // fallar por una colisión transitoria (por ejemplo 0 -> 1 antes de que
        // el antiguo 1 cambie de posición); se vuelve a crear tras fusionar.
        self.conn
            .execute("DROP INDEX IF EXISTS media_publication_asset_unique", [])?;
        self.assign_canonical_child_indices()?;
        self.merge_canonical_duplicates()?;
        self.conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS media_publication_asset_unique
             ON media(profile_id,kind,publication_code,child_index)
             WHERE publication_code IS NOT NULL",
            [],
        )?;
        // Un parser experimental interpretó los segmentos `/p/` y `/reel/`
        // como shortcodes. Sólo se retiran esos placeholders exactos cuando
        // nunca llegaron a contener bytes de la biblioteca.
        self.conn.execute(
            "DELETE FROM media WHERE media_id IN ('web_p','web_reel')
             AND NOT EXISTS (SELECT 1 FROM media_content mc WHERE mc.media_id=media.id)",
            [],
        )?;
        // Jobs "en curso" de una sesión anterior: la app murió a mitad de
        // descarga, así que se cierran con lo que alcanzó.
        self.conn.execute(
            "UPDATE download_jobs SET finished_at=?1 WHERE finished_at IS NULL",
            [chrono::Utc::now().timestamp()],
        )?;
        Ok(())
    }

    fn assign_canonical_child_indices(&self) -> rusqlite::Result<()> {
        let mut groups = self.conn.prepare(
            "SELECT profile_id,kind,publication_code
             FROM media WHERE publication_code IS NOT NULL
             GROUP BY profile_id,kind,publication_code HAVING COUNT(*) > 1",
        )?;
        let groups = groups
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        for (profile_id, kind, code) in groups {
            let mut stmt = self.conn.prepare(
                "SELECT id,media_id FROM media
                 WHERE profile_id=?1 AND kind=?2 AND publication_code=?3 ORDER BY id",
            )?;
            let rows = stmt
                .query_map(params![profile_id, kind, code], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            let mut next_child = 0_i64;
            for (id, _) in rows
                .iter()
                .filter(|(_, media_id)| !media_id.starts_with("web_"))
            {
                self.conn.execute(
                    "UPDATE media SET child_index=?2 WHERE id=?1",
                    params![id, next_child],
                )?;
                next_child += 1;
            }
            for (id, _) in rows
                .iter()
                .filter(|(_, media_id)| media_id.starts_with("web_"))
            {
                self.conn
                    .execute("UPDATE media SET child_index=0 WHERE id=?1", [id])?;
            }
        }
        Ok(())
    }

    fn merge_canonical_duplicates(&self) -> rusqlite::Result<()> {
        let mut groups = self.conn.prepare(
            "SELECT profile_id,kind,publication_code,child_index
             FROM media WHERE publication_code IS NOT NULL
             GROUP BY profile_id,kind,publication_code,child_index HAVING COUNT(*) > 1",
        )?;
        let duplicate_groups = groups
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(groups);
        for (profile_id, kind, code, child_index) in duplicate_groups {
            let mut ids = self.conn.prepare(
                "SELECT m.id,
                        EXISTS(SELECT 1 FROM media_content mc WHERE mc.media_id=m.id) AS has_blob,
                        EXISTS(SELECT 1 FROM media_thumbnail_content mt WHERE mt.media_id=m.id) AS has_thumb
                 FROM media m
                 WHERE profile_id=?1 AND kind=?2 AND publication_code=?3 AND child_index=?4
                 ORDER BY has_blob DESC, has_thumb DESC, m.id ASC",
            )?;
            let rows = ids
                .query_map(params![profile_id, kind, code, child_index], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, bool>(1)?,
                        row.get::<_, bool>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(ids);
            let Some((survivor, _, _)) = rows.first().copied() else {
                continue;
            };
            for (duplicate, _, _) in rows.into_iter().skip(1) {
                self.conn.execute(
                    "INSERT OR IGNORE INTO media_content
                     SELECT ?1,data,mime_type,byte_size,sha256,width,height,bitrate,quality_verified,source,downloaded_at
                     FROM media_content WHERE media_id=?2",
                    params![survivor, duplicate],
                )?;
                self.conn.execute(
                    "INSERT OR IGNORE INTO media_thumbnail_content
                     SELECT ?1,data,mime_type,byte_size,sha256,downloaded_at
                     FROM media_thumbnail_content WHERE media_id=?2",
                    params![survivor, duplicate],
                )?;
                self.conn.execute(
                    "UPDATE media SET
                       caption=COALESCE(caption,(SELECT caption FROM media WHERE id=?2)),
                       taken_at=COALESCE(taken_at,(SELECT taken_at FROM media WHERE id=?2)),
                       best_url=COALESCE(best_url,(SELECT best_url FROM media WHERE id=?2)),
                       thumbnail_url=COALESCE(thumbnail_url,(SELECT thumbnail_url FROM media WHERE id=?2))
                     WHERE id=?1",
                    params![survivor, duplicate],
                )?;
                self.conn
                    .execute("DELETE FROM media WHERE id=?1", [duplicate])?;
            }
        }
        Ok(())
    }

    fn migrate_legacy_files(&mut self) -> rusqlite::Result<()> {
        let media: Vec<(i64, String)> = {
            let mut stmt = self.conn.prepare(
                "SELECT id, local_path FROM media WHERE local_path IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM media_content WHERE media_id=media.id)",
            )?;
            let rows = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        let mut imported_media = Vec::new();
        let tx = self.conn.transaction()?;
        for (id, path) in media {
            if let Ok(bytes) = std::fs::read(&path) {
                if !bytes.is_empty() {
                    let mime = mime_from_path(&path, false);
                    let sha = sha256_hex(&bytes);
                    tx.execute(
                        "INSERT OR REPLACE INTO media_content
                         (media_id,data,mime_type,byte_size,sha256,width,height,bitrate,quality_verified,source,downloaded_at)
                         VALUES (?1,?2,?3,?4,?5,NULL,NULL,NULL,0,'legacy',?6)",
                        params![id, bytes, mime, bytes.len() as i64, sha, chrono::Utc::now().timestamp()],
                    )?;
                    tx.execute(
                        "UPDATE media SET status='downloaded',error=NULL WHERE id=?1",
                        [id],
                    )?;
                    imported_media.push((id, path, bytes.len(), sha));
                }
            }
        }
        let avatars: Vec<(i64, String)> = {
            let mut stmt = tx.prepare(
                "SELECT id, avatar_local_path FROM profiles WHERE avatar_local_path IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM profile_avatar_content WHERE profile_id=profiles.id)",
            )?;
            let rows = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        let mut imported_avatars = Vec::new();
        for (id, path) in avatars {
            if let Ok(bytes) = std::fs::read(&path) {
                if !bytes.is_empty() {
                    let mime = mime_from_path(&path, false);
                    let sha = sha256_hex(&bytes);
                    tx.execute(
                        "INSERT OR REPLACE INTO profile_avatar_content
                         (profile_id,data,mime_type,byte_size,sha256,downloaded_at)
                         VALUES (?1,?2,?3,?4,?5,?6)",
                        params![
                            id,
                            bytes,
                            mime,
                            bytes.len() as i64,
                            sha,
                            chrono::Utc::now().timestamp()
                        ],
                    )?;
                    imported_avatars.push((id, path, bytes.len(), sha));
                }
            }
        }
        tx.commit()?;
        for (id, path, size, sha) in imported_media {
            let verified: bool = self
                .conn
                .query_row(
                    "SELECT byte_size=?2 AND sha256=?3 FROM media_content WHERE media_id=?1",
                    params![id, size as i64, sha],
                    |row| row.get(0),
                )
                .unwrap_or(false);
            if verified {
                let _ = std::fs::remove_file(path);
            }
        }
        for (id, path, size, sha) in imported_avatars {
            let verified: bool = self.conn.query_row(
                "SELECT byte_size=?2 AND sha256=?3 FROM profile_avatar_content WHERE profile_id=?1",
                params![id, size as i64, sha], |row| row.get(0),
            ).unwrap_or(false);
            if verified {
                let _ = std::fs::remove_file(path);
            }
        }
        Ok(())
    }

    fn column_exists(conn: &Connection, table: &str, col: &str) -> bool {
        // Nombres hardcodeados (sin inyección): solo se consulta la pragma.
        conn.query_row(
            &format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = '{col}'"),
            [],
            |r| r.get::<_, i64>(0),
        )
        .unwrap_or(0)
            > 0
    }

    // ---- Accounts ----
    pub fn add_account(&self, username: &str, keyring_ref: &str) -> rusqlite::Result<i64> {
        self.conn.execute(
            "INSERT OR IGNORE INTO accounts (username, keyring_ref, added_at, status)
             VALUES (?1, ?2, ?3, 'unknown')",
            params![username, keyring_ref, chrono::Utc::now().timestamp()],
        )?;
        let id = self.conn.query_row(
            "SELECT id FROM accounts WHERE username=?1",
            params![username],
            |r| r.get(0),
        )?;
        Ok(id)
    }

    pub fn add_browser_account(&self, username: &str) -> rusqlite::Result<i64> {
        self.conn.execute(
            "INSERT INTO accounts (username,keyring_ref,added_at,status,auth_mode)
             VALUES (?1,'dedicated_browser',?2,'valid','dedicated_browser')
             ON CONFLICT(username) DO UPDATE SET keyring_ref='dedicated_browser',
             status='valid',auth_mode='dedicated_browser',last_valid=excluded.added_at",
            params![username, chrono::Utc::now().timestamp()],
        )?;
        self.conn.query_row(
            "SELECT id FROM accounts WHERE username=?1",
            [username],
            |row| row.get(0),
        )
    }

    pub fn set_account_status(&self, account_id: i64, status: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE accounts SET status=?2, last_valid=?3 WHERE id=?1",
            params![account_id, status, chrono::Utc::now().timestamp()],
        )?;
        Ok(())
    }

    pub fn list_accounts(
        &self,
    ) -> rusqlite::Result<Vec<(i64, String, String, String, Option<i64>)>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, username, keyring_ref, status, last_valid FROM accounts ORDER BY id",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn delete_account(&self, id: i64) -> rusqlite::Result<()> {
        self.conn
            .execute("DELETE FROM accounts WHERE id=?1", params![id])?;
        Ok(())
    }

    /// Borra un perfil y todo su media en cascada (posts/stories/highlights).
    pub fn delete_profile_cascade(&self, profile_id: i64) -> rusqlite::Result<()> {
        self.conn
            .execute("DELETE FROM profiles WHERE id=?1", params![profile_id])?;
        Ok(())
    }

    // ---- Profiles ----
    pub fn upsert_profile(
        &self,
        p: &crate::instagram::models::ProfileRow,
    ) -> rusqlite::Result<i64> {
        // COALESCE: una fetch degradada (fallback HTML con nulls) no pisa los
        // valores reales guardados. is_favorite nunca se toca (sobrevive re-fetches).
        self.conn.execute(
            r#"INSERT INTO profiles (username, pk, full_name, biography, followers, following,
                                      media_count, is_private, is_verified, profile_pic_url,
                                      avatar_local_path, fetched_at)
                VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
                ON CONFLICT(username) DO UPDATE SET
                  pk=COALESCE(excluded.pk, profiles.pk),
                  full_name=COALESCE(excluded.full_name, profiles.full_name),
                  biography=COALESCE(excluded.biography, profiles.biography),
                  followers=COALESCE(excluded.followers, profiles.followers),
                  following=COALESCE(excluded.following, profiles.following),
                  media_count=COALESCE(excluded.media_count, profiles.media_count),
                  is_private=COALESCE(excluded.is_private, profiles.is_private),
                  is_verified=COALESCE(excluded.is_verified, profiles.is_verified),
                  profile_pic_url=COALESCE(excluded.profile_pic_url, profiles.profile_pic_url),
                  avatar_local_path=COALESCE(excluded.avatar_local_path, profiles.avatar_local_path),
                  fetched_at=excluded.fetched_at"#,
            params![
                p.username, p.pk, p.full_name, p.biography, p.followers, p.following,
                p.media_count, p.is_private, p.is_verified, p.profile_pic_url,
                p.avatar_local_path, p.fetched_at
            ],
        )?;
        Ok(self.conn.query_row(
            "SELECT id FROM profiles WHERE username=?1",
            params![p.username],
            |r| r.get(0),
        )?)
    }

    pub fn get_profile_id(&self, username: &str) -> rusqlite::Result<i64> {
        self.conn.query_row(
            "SELECT id FROM profiles WHERE username=?1",
            params![username],
            |r| r.get(0),
        )
    }

    pub fn get_profile_by_id(
        &self,
        id: i64,
    ) -> rusqlite::Result<Option<crate::instagram::models::ProfileRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT username, pk, full_name, biography, followers, following, media_count,
                    is_private, is_verified, profile_pic_url,
                    CASE WHEN EXISTS(SELECT 1 FROM profile_avatar_content a WHERE a.profile_id=profiles.id)
                         THEN 'http://vault.localhost/avatar/' || profiles.id ELSE avatar_local_path END,
                    (SELECT byte_size FROM profile_avatar_content a WHERE a.profile_id=profiles.id),
                    is_favorite, fetched_at, id
             FROM profiles WHERE id=?1",
        )?;
        let rows = stmt
            .query_map(params![id], |r| {
                let content_url: Option<String> = r.get(10)?;
                Ok(crate::instagram::models::ProfileRow {
                    username: r.get(0)?,
                    pk: r.get(1)?,
                    full_name: r.get(2)?,
                    biography: r.get(3)?,
                    followers: r.get(4)?,
                    following: r.get(5)?,
                    media_count: r.get(6)?,
                    is_private: r.get(7)?,
                    is_verified: r.get(8)?,
                    profile_pic_url: r.get(9)?,
                    avatar_local_path: None,
                    has_content: content_url.is_some(),
                    content_url,
                    byte_size: r.get(11)?,
                    is_favorite: r.get::<_, Option<i64>>(12)?.unwrap_or(0),
                    fetched_at: r.get(13)?,
                    id: Some(r.get(14)?),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows.into_iter().next())
    }

    pub fn list_profiles(&self) -> rusqlite::Result<Vec<crate::instagram::models::ProfileRow>> {
        let mut stmt = self.conn.prepare(
"SELECT username, pk, full_name, biography, followers, following, media_count,
                    is_private, is_verified, profile_pic_url,
                    CASE WHEN EXISTS(SELECT 1 FROM profile_avatar_content a WHERE a.profile_id=profiles.id)
                         THEN 'http://vault.localhost/avatar/' || profiles.id ELSE avatar_local_path END,
                    (SELECT byte_size FROM profile_avatar_content a WHERE a.profile_id=profiles.id),
                    is_favorite, fetched_at, id
             FROM profiles ORDER BY is_favorite DESC, username",
        )?;
        let rows = stmt
            .query_map([], |r| {
                let content_url: Option<String> = r.get(10)?;
                Ok(crate::instagram::models::ProfileRow {
                    username: r.get(0)?,
                    pk: r.get(1)?,
                    full_name: r.get(2)?,
                    biography: r.get(3)?,
                    followers: r.get(4)?,
                    following: r.get(5)?,
                    media_count: r.get(6)?,
                    is_private: r.get(7)?,
                    is_verified: r.get(8)?,
                    profile_pic_url: r.get(9)?,
                    avatar_local_path: None,
                    has_content: content_url.is_some(),
                    content_url,
                    byte_size: r.get(11)?,
                    is_favorite: r.get::<_, Option<i64>>(12)?.unwrap_or(0),
                    fetched_at: r.get(13)?,
                    id: Some(r.get(14)?),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    // ---- Media ----
    pub fn upsert_media(&self, m: &crate::instagram::models::MediaRow) -> rusqlite::Result<i64> {
        self.upsert_media_with_result(m).map(|(id, _)| id)
    }

    pub fn upsert_media_with_result(
        &self,
        m: &crate::instagram::models::MediaRow,
    ) -> rusqlite::Result<(i64, bool)> {
        let existing = if let (Some(profile_id), Some(code)) = (m.profile_id, &m.publication_code) {
            self.conn
                .query_row(
                    "SELECT id FROM media WHERE profile_id=?1 AND kind=?2 AND publication_code=?3 AND child_index=?4",
                    params![profile_id, m.kind, code, m.child_index],
                    |row| row.get(0),
                )
                .optional()?
        } else {
            self.conn
                .query_row(
                    "SELECT id FROM media WHERE media_id=?1",
                    params![m.media_id],
                    |row| row.get(0),
                )
                .optional()?
        };
        if let Some(id) = existing {
            self.conn.execute(
                "UPDATE media SET best_url=?2,thumbnail_url=?3,caption=COALESCE(?4,caption),
                   media_type=?5,code=COALESCE(?6,code),taken_at=COALESCE(?7,taken_at),
                   width=?8,height=?9,bitrate=?10,byte_size=?11,quality_verified=?12,
                   publication_code=COALESCE(?13,publication_code),child_index=?14
                 WHERE id=?1",
                params![
                    id,
                    m.best_url,
                    m.thumbnail_url,
                    m.caption,
                    m.media_type,
                    m.code,
                    m.taken_at,
                    m.width,
                    m.height,
                    m.bitrate,
                    m.byte_size,
                    m.quality_verified as i64,
                    m.publication_code,
                    m.child_index
                ],
            )?;
            return Ok((id, false));
        }
        self.conn.execute(
            r#"INSERT INTO media (media_id, publication_code, child_index, profile_id, kind, code,
                                  taken_at, caption, media_type, thumbnail_url, best_url, local_path,
                                  status, error, created_at, width, height, bitrate, byte_size, quality_verified)
               VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)"#,
            params![
                m.media_id,
                m.publication_code,
                m.child_index,
                m.profile_id,
                m.kind,
                m.code,
                m.taken_at,
                m.caption,
                m.media_type,
                m.thumbnail_url,
                m.best_url,
                m.local_path,
                m.status,
                m.error,
                m.created_at,
                m.width,
                m.height,
                m.bitrate,
                m.byte_size,
                m.quality_verified as i64
            ],
        )?;
        Ok((self.conn.last_insert_rowid(), true))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn store_media_content(
        &self,
        id: i64,
        data: &[u8],
        mime_type: &str,
        width: Option<i64>,
        height: Option<i64>,
        bitrate: Option<i64>,
        quality_verified: bool,
        source: &str,
    ) -> rusqlite::Result<()> {
        let sha = sha256_hex(data);
        self.conn.execute(
            "INSERT INTO media_content
             (media_id,data,mime_type,byte_size,sha256,width,height,bitrate,quality_verified,source,downloaded_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
             ON CONFLICT(media_id) DO UPDATE SET data=excluded.data,mime_type=excluded.mime_type,
             byte_size=excluded.byte_size,sha256=excluded.sha256,width=excluded.width,
             height=excluded.height,bitrate=excluded.bitrate,quality_verified=excluded.quality_verified,
             source=excluded.source,downloaded_at=excluded.downloaded_at",
            params![id, data, mime_type, data.len() as i64, sha, width, height, bitrate,
                    quality_verified as i64, source, chrono::Utc::now().timestamp()],
        )?;
        self.conn.execute(
            "UPDATE media SET status='downloaded', local_path=NULL, error=NULL WHERE id=?1",
            [id],
        )?;
        Ok(())
    }

    pub fn store_media_thumbnail(
        &self,
        id: i64,
        data: &[u8],
        mime_type: &str,
    ) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO media_thumbnail_content (media_id,data,mime_type,byte_size,sha256,downloaded_at)
             VALUES (?1,?2,?3,?4,?5,?6)
             ON CONFLICT(media_id) DO UPDATE SET data=excluded.data,mime_type=excluded.mime_type,
             byte_size=excluded.byte_size,sha256=excluded.sha256,downloaded_at=excluded.downloaded_at",
            params![id, data, mime_type, data.len() as i64, sha256_hex(data), chrono::Utc::now().timestamp()],
        )?;
        Ok(())
    }

    pub fn thumbnail_content(&self, id: i64) -> rusqlite::Result<Option<ContentRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT data,mime_type,byte_size,sha256 FROM media_thumbnail_content WHERE media_id=?1",
        )?;
        let mut rows = stmt.query_map([id], |r| {
            Ok(ContentRecord {
                data: r.get(0)?,
                mime_type: r.get(1)?,
                byte_size: r.get(2)?,
                sha256: r.get(3)?,
                width: None,
                height: None,
                bitrate: None,
                quality_verified: false,
            })
        })?;
        Ok(rows.next().transpose()?)
    }

    pub fn media_content(&self, id: i64) -> rusqlite::Result<Option<ContentRecord>> {
        self.conn
            .query_row(
                "SELECT data,mime_type,byte_size,sha256,width,height,bitrate,quality_verified
             FROM media_content WHERE media_id=?1",
                [id],
                |r| {
                    Ok(ContentRecord {
                        data: r.get(0)?,
                        mime_type: r.get(1)?,
                        byte_size: r.get(2)?,
                        sha256: r.get(3)?,
                        width: r.get(4)?,
                        height: r.get(5)?,
                        bitrate: r.get(6)?,
                        quality_verified: r.get::<_, i64>(7)? != 0,
                    })
                },
            )
            .optional()
    }

    pub fn store_avatar_content(
        &self,
        profile_id: i64,
        data: &[u8],
        mime_type: &str,
    ) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO profile_avatar_content (profile_id,data,mime_type,byte_size,sha256,downloaded_at)
             VALUES (?1,?2,?3,?4,?5,?6)
             ON CONFLICT(profile_id) DO UPDATE SET data=excluded.data,mime_type=excluded.mime_type,
             byte_size=excluded.byte_size,sha256=excluded.sha256,downloaded_at=excluded.downloaded_at",
            params![profile_id, data, mime_type, data.len() as i64, sha256_hex(data), chrono::Utc::now().timestamp()],
        )?;
        self.conn.execute(
            "UPDATE profiles SET avatar_local_path=NULL WHERE id=?1",
            [profile_id],
        )?;
        Ok(())
    }

    pub fn avatar_content(&self, profile_id: i64) -> rusqlite::Result<Option<ContentRecord>> {
        self.conn.query_row(
            "SELECT data,mime_type,byte_size,sha256,NULL,NULL,NULL,1 FROM profile_avatar_content WHERE profile_id=?1",
            [profile_id], |r| Ok(ContentRecord { data:r.get(0)?, mime_type:r.get(1)?, byte_size:r.get(2)?, sha256:r.get(3)?,
                width:None, height:None, bitrate:None, quality_verified:true }),
        ).optional()
    }

    pub fn mark_failed(&self, id: i64, error: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE media SET status='failed', error=?2 WHERE id=?1",
            params![id, error],
        )?;
        Ok(())
    }

    /// Vuelve un medio descargado a pendiente (permite re-descargarlo).
    pub fn reset_download(&self, id: i64) -> rusqlite::Result<()> {
        self.conn
            .execute("DELETE FROM media_content WHERE media_id=?1", [id])?;
        self.conn.execute(
            "UPDATE media SET status='metadata', local_path=NULL, error=NULL WHERE id=?1",
            params![id],
        )?;
        Ok(())
    }

    pub fn mark_candidates_unverified(&self, profile_id: i64, kind: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE media SET quality_verified=0 WHERE profile_id=?1 AND kind=?2",
            params![profile_id, kind],
        )?;
        Ok(())
    }

    /// Vuelve a pendiente todos los descargados de un perfil (o un kind).
    pub fn reset_downloads_profile(
        &self,
        profile_id: i64,
        kind: Option<&str>,
    ) -> rusqlite::Result<usize> {
        let n = if let Some(k) = kind {
            self.conn.execute(
                "DELETE FROM media_content WHERE media_id IN
                 (SELECT id FROM media WHERE profile_id=?1 AND kind=?2)",
                params![profile_id, k],
            )?;
            self.conn.execute(
                "UPDATE media SET status='metadata', local_path=NULL, error=NULL
                 WHERE profile_id=?1 AND kind=?2 AND status='downloaded'",
                params![profile_id, k],
            )?
        } else {
            self.conn.execute(
                "DELETE FROM media_content WHERE media_id IN
                 (SELECT id FROM media WHERE profile_id=?1)",
                [profile_id],
            )?;
            self.conn.execute(
                "UPDATE media SET status='metadata', local_path=NULL, error=NULL
                 WHERE profile_id=?1 AND status='downloaded'",
                params![profile_id],
            )?
        };
        Ok(n)
    }

    pub fn media_by_profile(
        &self,
        profile_id: i64,
        kind: Option<&str>,
    ) -> rusqlite::Result<Vec<crate::instagram::models::MediaRow>> {
        let mut sql = String::from(
            "SELECT media_id, profile_id, kind, code, taken_at, caption, media_type,
                    thumbnail_url, best_url,
                    CASE WHEN EXISTS(SELECT 1 FROM media_content mc WHERE mc.media_id=media.id)
                         THEN 'http://vault.localhost/media/' || media.id ELSE local_path END,
                    COALESCE((SELECT byte_size FROM media_content mc WHERE mc.media_id=media.id),media.byte_size),
                    COALESCE((SELECT width FROM media_content mc WHERE mc.media_id=media.id),media.width),
                    COALESCE((SELECT height FROM media_content mc WHERE mc.media_id=media.id),media.height),
                    COALESCE((SELECT bitrate FROM media_content mc WHERE mc.media_id=media.id),media.bitrate),
                    COALESCE((SELECT quality_verified FROM media_content mc WHERE mc.media_id=media.id),media.quality_verified,0),
                    status, error, created_at, id,
                    CASE WHEN EXISTS(SELECT 1 FROM media_thumbnail_content mt WHERE mt.media_id=media.id)
                         THEN 'http://vault.localhost/thumbnail/' || media.id ELSE NULL END,
                    publication_code, child_index
             FROM media WHERE profile_id=?1",
        );
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(profile_id)];
        if let Some(k) = kind {
            sql.push_str(" AND kind=?2");
            params.push(Box::new(k.to_string()));
        }
        // El fallback DOM de Instagram no siempre expone `taken_at`. Esos
        // medios sí son válidos y se insertan siguiendo el orden de la
        // cuadrícula (más reciente primero). Si ordenamos sólo por taken_at,
        // SQLite coloca todos los NULL al final y una sincronización privada
        // parece no haber actualizado nada. `created_at` conserva el momento
        // en que se descubrió el medio e `id ASC` mantiene el orden del lote.
        sql.push_str(" ORDER BY COALESCE(taken_at, created_at) DESC, id ASC");
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt
            .query_map(
                rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())),
                |r| {
                    let content_url: Option<String> = r.get(9)?;
                    Ok(crate::instagram::models::MediaRow {
                        media_id: r.get(0)?,
                        publication_code: r.get(20)?,
                        child_index: r.get(21)?,
                        profile_id: r.get(1)?,
                        kind: r.get(2)?,
                        code: r.get(3)?,
                        taken_at: r.get(4)?,
                        caption: r.get(5)?,
                        media_type: r.get(6)?,
                        thumbnail_url: r.get(7)?,
                        thumbnail_content_url: r.get(19)?,
                        best_url: r.get(8)?,
                        local_path: None,
                        has_content: content_url.is_some(),
                        content_url,
                        byte_size: r.get(10)?,
                        width: r.get(11)?,
                        height: r.get(12)?,
                        bitrate: r.get(13)?,
                        quality_verified: r.get::<_, i64>(14)? != 0,
                        status: r.get(15)?,
                        error: r.get(16)?,
                        created_at: r.get(17)?,
                        id: Some(r.get(18)?),
                    })
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn publication_count(&self, profile_id: i64, kind: &str) -> rusqlite::Result<usize> {
        self.conn.query_row(
            "SELECT COUNT(DISTINCT COALESCE(publication_code,code,media_id))
             FROM media WHERE profile_id=?1 AND kind=?2",
            params![profile_id, kind],
            |row| row.get::<_, i64>(0).map(|value| value.max(0) as usize),
        )
    }

    pub fn publication_exists(
        &self,
        profile_id: i64,
        kind: &str,
        code: &str,
    ) -> rusqlite::Result<bool> {
        self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM media WHERE profile_id=?1 AND kind=?2
                           AND COALESCE(publication_code,code)=?3)",
            params![profile_id, kind, code],
            |row| row.get(0),
        )
    }

    pub fn sync_progress(
        &self,
        profile_id: i64,
        kind: &str,
    ) -> rusqlite::Result<Option<crate::instagram::models::SyncProgressRow>> {
        use crate::instagram::models::{SyncAccessMode, SyncProgressRow, SyncStatus};
        self.conn
            .query_row(
                "SELECT access_mode,last_shortcode,publications_seen,status,stop_reason,updated_at
                 FROM sync_progress WHERE profile_id=?1 AND kind=?2",
                params![profile_id, kind],
                |row| {
                    let access: String = row.get(0)?;
                    let status: String = row.get(3)?;
                    let access_mode = if access == "authenticated_explicit" {
                        SyncAccessMode::AuthenticatedExplicit
                    } else {
                        SyncAccessMode::PublicAnonymous
                    };
                    let status = match status.as_str() {
                        "complete" => SyncStatus::Complete,
                        "anonymous_limit" => SyncStatus::AnonymousLimit,
                        "stalled" => SyncStatus::Stalled,
                        "rate_limited" => SyncStatus::RateLimited,
                        "challenge_required" => SyncStatus::ChallengeRequired,
                        "cancelled" => SyncStatus::Cancelled,
                        _ => SyncStatus::MoreAvailable,
                    };
                    Ok(SyncProgressRow {
                        profile_id,
                        kind: kind.to_string(),
                        access_mode,
                        last_shortcode: row.get(1)?,
                        publications_seen: row.get::<_, i64>(2)?.max(0) as usize,
                        status,
                        stop_reason: row.get(4)?,
                        updated_at: row.get(5)?,
                    })
                },
            )
            .optional()
    }

    pub fn save_sync_progress(
        &self,
        progress: &crate::instagram::models::SyncProgressRow,
    ) -> rusqlite::Result<()> {
        let access = match progress.access_mode {
            crate::instagram::models::SyncAccessMode::PublicAnonymous => "public_anonymous",
            crate::instagram::models::SyncAccessMode::AuthenticatedExplicit => {
                "authenticated_explicit"
            }
        };
        self.conn.execute(
            "INSERT INTO sync_progress
             (profile_id,kind,access_mode,last_shortcode,publications_seen,status,stop_reason,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(profile_id,kind) DO UPDATE SET
               access_mode=excluded.access_mode,last_shortcode=excluded.last_shortcode,
               publications_seen=excluded.publications_seen,status=excluded.status,
               stop_reason=excluded.stop_reason,updated_at=excluded.updated_at",
            params![
                progress.profile_id,
                progress.kind,
                access,
                progress.last_shortcode,
                progress.publications_seen as i64,
                progress.status.as_str(),
                progress.stop_reason,
                progress.updated_at
            ],
        )?;
        Ok(())
    }

    pub fn pending_downloads(
        &self,
        limit: i64,
    ) -> rusqlite::Result<Vec<crate::instagram::models::MediaRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT media_id, profile_id, kind, code, taken_at, caption, media_type,
                    thumbnail_url, best_url,
                    CASE WHEN EXISTS(SELECT 1 FROM media_content mc WHERE mc.media_id=media.id)
                         THEN 'http://vault.localhost/media/' || media.id ELSE local_path END,
                    COALESCE((SELECT byte_size FROM media_content mc WHERE mc.media_id=media.id),media.byte_size),
                    COALESCE((SELECT width FROM media_content mc WHERE mc.media_id=media.id),media.width),
                    COALESCE((SELECT height FROM media_content mc WHERE mc.media_id=media.id),media.height),
                    COALESCE((SELECT bitrate FROM media_content mc WHERE mc.media_id=media.id),media.bitrate),
                    COALESCE((SELECT quality_verified FROM media_content mc WHERE mc.media_id=media.id),media.quality_verified,0),
                    status, error, created_at, id,
                    CASE WHEN EXISTS(SELECT 1 FROM media_thumbnail_content mt WHERE mt.media_id=media.id)
                         THEN 'http://vault.localhost/thumbnail/' || media.id ELSE NULL END,
                    publication_code, child_index
             FROM media WHERE status='metadata' AND best_url IS NOT NULL LIMIT ?1",
        )?;
        let rows = stmt
            .query_map(params![limit], |r| {
                let content_url: Option<String> = r.get(9)?;
                Ok(crate::instagram::models::MediaRow {
                    media_id: r.get(0)?,
                    publication_code: r.get(20)?,
                    child_index: r.get(21)?,
                    profile_id: r.get(1)?,
                    kind: r.get(2)?,
                    code: r.get(3)?,
                    taken_at: r.get(4)?,
                    caption: r.get(5)?,
                    media_type: r.get(6)?,
                    thumbnail_url: r.get(7)?,
                    thumbnail_content_url: r.get(19)?,
                    best_url: r.get(8)?,
                    local_path: None,
                    has_content: content_url.is_some(),
                    content_url,
                    byte_size: r.get(10)?,
                    width: r.get(11)?,
                    height: r.get(12)?,
                    bitrate: r.get(13)?,
                    quality_verified: r.get::<_, i64>(14)? != 0,
                    status: r.get(15)?,
                    error: r.get(16)?,
                    created_at: r.get(17)?,
                    id: Some(r.get(18)?),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    // ---- Highlights ----
    pub fn upsert_highlight(
        &self,
        title: &str,
        highlight_id: &str,
        profile_id: i64,
    ) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO highlights (title, highlight_id, profile_id, fetched_at)
             VALUES (?1,?2,?3,?4)",
            params![
                title,
                highlight_id,
                profile_id,
                chrono::Utc::now().timestamp()
            ],
        )?;
        Ok(())
    }

    pub fn list_highlights(&self, profile_id: i64) -> rusqlite::Result<Vec<(String, String)>> {
        let mut stmt = self.conn.prepare(
            "SELECT title, highlight_id FROM highlights WHERE profile_id=?1 ORDER BY title",
        )?;
        let rows = stmt
            .query_map(params![profile_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    // ---- Favoritos ----
    pub fn set_favorite(&self, profile_id: i64, favorite: bool) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE profiles SET is_favorite=?2 WHERE id=?1",
            params![profile_id, favorite as i64],
        )?;
        Ok(())
    }

    /// Guarda la ruta local de la foto de perfil ya descargada.
    pub fn set_avatar_path(&self, profile_id: i64, path: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE profiles SET avatar_local_path=?2 WHERE id=?1",
            params![profile_id, path],
        )?;
        Ok(())
    }

    // ---- Estado de sincronización ----

    /// Registra que se sincronizó un kind (última vez; idempotente por profile+kind).
    pub fn record_sync(&self, profile_id: i64, kind: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO sync_stats (profile_id, kind, last_sync) VALUES (?1,?2,?3)
             ON CONFLICT(profile_id, kind) DO UPDATE SET last_sync=excluded.last_sync",
            params![profile_id, kind, chrono::Utc::now().timestamp()],
        )?;
        Ok(())
    }

    /// Re-sincronizar reintenta: failed → metadata (limpia el error).
    pub fn reset_failed(&self, profile_id: i64, kind: &str) -> rusqlite::Result<usize> {
        let n = self.conn.execute(
            "UPDATE media SET status='metadata', error=NULL
             WHERE profile_id=?1 AND kind=?2 AND status='failed'",
            params![profile_id, kind],
        )?;
        Ok(n)
    }

    /// Stats por perfil: conteos siempre agregados desde `media` (fuente de verdad)
    /// + last_sync de `sync_stats`.
    pub fn profile_stats(&self) -> rusqlite::Result<Vec<crate::instagram::models::ProfileStats>> {
        use crate::instagram::models::{KindStats, ProfileStats};
        let mut by_profile: std::collections::HashMap<
            i64,
            (i64, std::collections::HashMap<String, KindStats>),
        > = std::collections::HashMap::new();

        {
            let mut stmt = self
                .conn
                .prepare("SELECT profile_id, COUNT(*) FROM media GROUP BY profile_id")?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            for (pid, total) in rows {
                by_profile.insert(pid, (total, std::collections::HashMap::new()));
            }
        }
        {
            let mut stmt = self.conn.prepare(
                "SELECT profile_id, kind,
                        COUNT(DISTINCT CASE WHEN kind='post'
                              THEN COALESCE(publication_code,code,media_id)
                              ELSE CAST(id AS TEXT) END),
                        COALESCE(SUM(status='downloaded'),0), COALESCE(SUM(status='failed'),0)
                 FROM media GROUP BY profile_id, kind",
            )?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, i64>(4)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            for (pid, kind, local, downloaded, failed) in rows {
                if let Some(entry) = by_profile.get_mut(&pid) {
                    entry.1.insert(
                        kind.clone(),
                        KindStats {
                            kind,
                            local_count: local,
                            downloaded,
                            failed,
                            last_sync: None,
                        },
                    );
                }
            }
        }
        {
            let mut stmt = self
                .conn
                .prepare("SELECT profile_id, kind, last_sync FROM sync_stats")?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<i64>>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            for (pid, kind, last_sync) in rows {
                if let Some(entry) = by_profile.get_mut(&pid) {
                    if let Some(k) = entry.1.get_mut(&kind) {
                        k.last_sync = last_sync;
                    } else {
                        entry.1.insert(
                            kind.clone(),
                            KindStats {
                                kind,
                                local_count: 0,
                                downloaded: 0,
                                failed: 0,
                                last_sync,
                            },
                        );
                    }
                }
            }
        }

        let mut out = Vec::with_capacity(by_profile.len());
        for (pid, (total, kinds)) in by_profile {
            out.push(ProfileStats {
                profile_id: pid,
                total_media: total,
                kinds: kinds.into_values().collect(),
            });
        }
        Ok(out)
    }

    // ---- Descarga (por medio) ----
    pub fn get_media_by_id(
        &self,
        id: i64,
    ) -> rusqlite::Result<Option<crate::instagram::models::MediaRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT media_id, profile_id, kind, code, taken_at, caption, media_type,
                    thumbnail_url, best_url,
                    CASE WHEN EXISTS(SELECT 1 FROM media_content mc WHERE mc.media_id=media.id)
                         THEN 'http://vault.localhost/media/' || media.id ELSE local_path END,
                    COALESCE((SELECT byte_size FROM media_content mc WHERE mc.media_id=media.id),media.byte_size),
                    COALESCE((SELECT width FROM media_content mc WHERE mc.media_id=media.id),media.width),
                    COALESCE((SELECT height FROM media_content mc WHERE mc.media_id=media.id),media.height),
                    COALESCE((SELECT bitrate FROM media_content mc WHERE mc.media_id=media.id),media.bitrate),
                    COALESCE((SELECT quality_verified FROM media_content mc WHERE mc.media_id=media.id),media.quality_verified,0),
                    status, error, created_at, id,
                    CASE WHEN EXISTS(SELECT 1 FROM media_thumbnail_content mt WHERE mt.media_id=media.id)
                         THEN 'http://vault.localhost/thumbnail/' || media.id ELSE NULL END,
                    publication_code, child_index
             FROM media WHERE id=?1",
        )?;
        let mut rows = stmt.query_map(params![id], |r| {
            let content_url: Option<String> = r.get(9)?;
            Ok(crate::instagram::models::MediaRow {
                media_id: r.get(0)?,
                publication_code: r.get(20)?,
                child_index: r.get(21)?,
                profile_id: r.get(1)?,
                kind: r.get(2)?,
                code: r.get(3)?,
                taken_at: r.get(4)?,
                caption: r.get(5)?,
                media_type: r.get(6)?,
                thumbnail_url: r.get(7)?,
                thumbnail_content_url: r.get(19)?,
                best_url: r.get(8)?,
                local_path: None,
                has_content: content_url.is_some(),
                content_url,
                byte_size: r.get(10)?,
                width: r.get(11)?,
                height: r.get(12)?,
                bitrate: r.get(13)?,
                quality_verified: r.get::<_, i64>(14)? != 0,
                status: r.get(15)?,
                error: r.get(16)?,
                created_at: r.get(17)?,
                id: Some(r.get(18)?),
            })
        })?;
        Ok(rows.next().transpose()?)
    }

    // ---- Jobs de descarga (manager) ----
    pub fn insert_job(&self, profile_id: i64, kind: &str, total: i64) -> rusqlite::Result<i64> {
        self.conn.execute(
            "INSERT INTO download_jobs (profile_id, kind, total, started_at)
             VALUES (?1,?2,?3,?4)",
            params![profile_id, kind, total, chrono::Utc::now().timestamp()],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn finish_job(&self, job_id: i64, ok: i64, failed: i64) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE download_jobs SET ok=?2, failed=?3, finished_at=?4 WHERE id=?1",
            params![job_id, ok, failed, chrono::Utc::now().timestamp()],
        )?;
        Ok(())
    }

    pub fn list_jobs(
        &self,
        limit: i64,
    ) -> rusqlite::Result<Vec<crate::instagram::models::DownloadJob>> {
        use crate::instagram::models::DownloadJob;
        let mut stmt = self.conn.prepare(
            "SELECT j.id, j.profile_id, p.username, j.kind, j.total, j.ok, j.failed,
                    j.started_at, j.finished_at
             FROM download_jobs j JOIN profiles p ON p.id = j.profile_id
             ORDER BY j.id DESC LIMIT ?1",
        )?;
        let rows = stmt
            .query_map(params![limit], |r| {
                Ok(DownloadJob {
                    id: r.get(0)?,
                    profile_id: r.get(1)?,
                    username: r.get(2)?,
                    kind: r.get(3)?,
                    total: r.get(4)?,
                    ok: r.get(5)?,
                    failed: r.get(6)?,
                    started_at: r.get(7)?,
                    finished_at: r.get(8)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Hay un job en curso para este perfil+kind (para no lanzar dos descargas
    /// concurrentes del mismo lote: escribirían sobre los mismos archivos).
    pub fn has_active_job(&self, profile_id: i64, kind: &str) -> rusqlite::Result<bool> {
        let n = self.conn.query_row(
            "SELECT COUNT(*) FROM download_jobs WHERE profile_id=?1 AND kind=?2 AND finished_at IS NULL",
            params![profile_id, kind],
            |r| r.get::<_, i64>(0),
        )?;
        Ok(n > 0)
    }

    pub fn clear_finished_jobs(&self) -> rusqlite::Result<()> {
        self.conn.execute(
            "DELETE FROM download_jobs WHERE finished_at IS NOT NULL",
            [],
        )?;
        Ok(())
    }
}

fn sha256_hex(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}

fn mime_from_path(path: &str, video: bool) -> String {
    if video || path.to_ascii_lowercase().ends_with(".mp4") {
        "video/mp4".to_string()
    } else if path.to_ascii_lowercase().ends_with(".png") {
        "image/png".to_string()
    } else if path.to_ascii_lowercase().ends_with(".webp") {
        "image/webp".to_string()
    } else {
        "image/jpeg".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instagram::models::{MediaRow, ProfileRow};

    fn temp_db() -> Db {
        let dir = std::env::temp_dir().join(format!("instakeeper_test_{}", uuid::Uuid::new_v4()));
        Db::open(&dir).unwrap()
    }

    #[test]
    fn account_crud() {
        let db = temp_db();
        let id = db.add_account("prueba", "account:x").unwrap();
        let rows = db.list_accounts().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].1, "prueba");
        db.set_account_status(id, "valid").unwrap();
        let rows = db.list_accounts().unwrap();
        assert_eq!(rows[0].3, "valid");
        db.delete_account(id).unwrap();
        assert_eq!(db.list_accounts().unwrap().len(), 0);
    }

    #[test]
    fn profile_and_media_crud_with_cascade() {
        let db = temp_db();
        let p = ProfileRow {
            username: "juan".into(),
            pk: Some("123".into()),
            full_name: Some("Juan".into()),
            biography: None,
            followers: Some(10),
            following: Some(20),
            media_count: Some(3),
            is_private: Some(0),
            is_verified: Some(0),
            profile_pic_url: None,
            avatar_local_path: None,
            has_content: false,
            content_url: None,
            byte_size: None,
            is_favorite: 0,
            fetched_at: Some(1),
            id: None,
        };
        let pid = db.upsert_profile(&p).unwrap();
        assert_eq!(db.get_profile_id("juan").unwrap(), pid);

        let m = MediaRow {
            media_id: "abc_1".into(),
            publication_code: Some("ABC".into()),
            child_index: 0,
            profile_id: Some(pid),
            kind: "post".into(),
            code: Some("ABC".into()),
            taken_at: Some(2),
            caption: Some("hola".into()),
            media_type: Some(1),
            thumbnail_url: Some("http://t".into()),
            thumbnail_content_url: None,
            best_url: Some("http://b".into()),
            local_path: None,
            has_content: false,
            content_url: None,
            byte_size: None,
            width: None,
            height: None,
            bitrate: None,
            quality_verified: false,
            status: "metadata".into(),
            error: None,
            created_at: Some(3),
            id: None,
        };
        let mid = db.upsert_media(&m).unwrap();
        db.store_media_content(
            mid,
            b"image-bytes",
            "image/jpeg",
            Some(1080),
            Some(1350),
            None,
            true,
            "test",
        )
        .unwrap();
        let med = db.media_by_profile(pid, Some("post")).unwrap();
        assert_eq!(med.len(), 1);
        assert_eq!(med[0].status, "downloaded");
        let expected = format!("http://vault.localhost/media/{mid}");
        assert_eq!(med[0].content_url.as_deref(), Some(expected.as_str()));
        assert!(med[0].has_content);
        assert_eq!(med[0].byte_size, Some(b"image-bytes".len() as i64));

        // cascada: al borrar el perfil se borra el media
        db.delete_profile_cascade(pid).unwrap();
        assert!(db.get_profile_id("juan").is_err());
        assert_eq!(db.media_by_profile(pid, Some("post")).unwrap().len(), 0);
    }

    #[test]
    fn media_dedup_upsert() {
        let db = temp_db();
        let p = ProfileRow {
            username: "dedupe".into(),
            pk: None,
            full_name: None,
            biography: None,
            followers: None,
            following: None,
            media_count: None,
            is_private: Some(0),
            is_verified: Some(0),
            profile_pic_url: None,
            avatar_local_path: None,
            has_content: false,
            content_url: None,
            byte_size: None,
            is_favorite: 0,
            fetched_at: None,
            id: None,
        };
        let pid = db.upsert_profile(&p).unwrap();
        let mk = |code: &str| MediaRow {
            media_id: "same_id".into(),
            publication_code: None,
            child_index: 0,
            profile_id: Some(pid),
            kind: "post".into(),
            code: Some(code.into()),
            taken_at: None,
            caption: None,
            media_type: None,
            thumbnail_url: None,
            thumbnail_content_url: None,
            best_url: Some(format!("http://{code}")),
            local_path: None,
            has_content: false,
            content_url: None,
            byte_size: None,
            width: None,
            height: None,
            bitrate: None,
            quality_verified: false,
            status: "metadata".into(),
            error: None,
            created_at: None,
            id: None,
        };
        db.upsert_media(&mk("A")).unwrap();
        db.upsert_media(&mk("B")).unwrap(); // mismo media_id → actualiza, no duplica
        let med = db.media_by_profile(pid, Some("post")).unwrap();
        assert_eq!(med.len(), 1);
        assert_eq!(med[0].code.as_deref(), Some("B"));
    }

    #[test]
    fn newly_discovered_dom_media_is_not_hidden_behind_dated_media() {
        let db = temp_db();
        let pid = db
            .upsert_profile(&mk_profile("private-grid", None))
            .unwrap();
        let mk = |media_id: &str, taken_at: Option<i64>, created_at: i64| MediaRow {
            media_id: media_id.into(),
            publication_code: Some(media_id.into()),
            child_index: 0,
            profile_id: Some(pid),
            kind: "post".into(),
            code: Some(media_id.into()),
            taken_at,
            caption: None,
            media_type: Some(1),
            thumbnail_url: Some(format!("https://cdn.invalid/{media_id}.jpg")),
            thumbnail_content_url: None,
            best_url: Some(format!("https://cdn.invalid/{media_id}.jpg")),
            local_path: None,
            has_content: false,
            content_url: None,
            byte_size: None,
            width: Some(1080),
            height: Some(1080),
            bitrate: None,
            quality_verified: false,
            status: "metadata".into(),
            error: None,
            created_at: Some(created_at),
            id: None,
        };
        db.upsert_media(&mk("old-dated", Some(100), 100)).unwrap();
        db.upsert_media(&mk("new-dom-first", None, 200)).unwrap();
        db.upsert_media(&mk("new-dom-second", None, 200)).unwrap();

        let media = db.media_by_profile(pid, Some("post")).unwrap();
        let ids: Vec<_> = media.iter().map(|item| item.media_id.as_str()).collect();
        assert_eq!(ids, ["new-dom-first", "new-dom-second", "old-dated"]);
    }

    #[test]
    fn canonical_migration_merges_web_placeholder_without_losing_carousel_blobs() {
        let db = temp_db();
        let pid = db.upsert_profile(&mk_profile("carousel", None)).unwrap();
        db.conn
            .execute("DROP INDEX media_publication_asset_unique", [])
            .unwrap();
        for media_id in ["100_0", "100_1", "web_CODE"] {
            db.conn
                .execute(
                    "INSERT INTO media
                     (media_id,profile_id,kind,code,publication_code,child_index,status,created_at)
                     VALUES (?1,?2,'post','CODE','CODE',0,'metadata',1)",
                    params![media_id, pid],
                )
                .unwrap();
        }
        let first: i64 = db
            .conn
            .query_row("SELECT id FROM media WHERE media_id='100_0'", [], |row| {
                row.get(0)
            })
            .unwrap();
        let second: i64 = db
            .conn
            .query_row("SELECT id FROM media WHERE media_id='100_1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        let web: i64 = db
            .conn
            .query_row(
                "SELECT id FROM media WHERE media_id='web_CODE'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        db.store_media_content(
            first,
            b"first",
            "image/jpeg",
            None,
            None,
            None,
            true,
            "test",
        )
        .unwrap();
        db.store_media_content(
            second,
            b"second",
            "image/jpeg",
            None,
            None,
            None,
            true,
            "test",
        )
        .unwrap();
        db.store_media_thumbnail(web, b"thumb", "image/jpeg")
            .unwrap();

        db.assign_canonical_child_indices().unwrap();
        db.merge_canonical_duplicates().unwrap();

        let rows: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM media WHERE publication_code='CODE'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let blobs: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM media_content mc JOIN media m ON m.id=mc.media_id
                 WHERE m.publication_code='CODE'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let thumbs: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM media_thumbnail_content mt JOIN media m ON m.id=mt.media_id
                 WHERE m.publication_code='CODE'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!((rows, blobs, thumbs), (2, 2, 1));
    }

    fn mk_profile(username: &str, pic: Option<&str>) -> ProfileRow {
        ProfileRow {
            username: username.into(),
            pk: Some("999".into()),
            full_name: Some("Nombre".into()),
            biography: Some("bio".into()),
            followers: Some(10),
            following: Some(5),
            media_count: Some(7),
            is_private: Some(1),
            is_verified: Some(1),
            profile_pic_url: pic.map(|s| s.to_string()),
            avatar_local_path: None,
            has_content: false,
            content_url: None,
            byte_size: None,
            is_favorite: 0,
            fetched_at: Some(1),
            id: None,
        }
    }

    #[test]
    fn upsert_profile_keeps_old_values_on_null() {
        let db = temp_db();
        db.upsert_profile(&mk_profile("ana", Some("https://pic/1.jpg")))
            .unwrap();
        // Fetch degradada: todo null → no pisa foto ni conteos.
        let degraded = ProfileRow {
            profile_pic_url: None,
            pk: None,
            full_name: None,
            biography: None,
            followers: None,
            following: None,
            media_count: None,
            is_private: None,
            is_verified: None,
            ..mk_profile("ana", None)
        };
        db.upsert_profile(&degraded).unwrap();
        let p = db
            .get_profile_by_id(db.get_profile_id("ana").unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(p.profile_pic_url.as_deref(), Some("https://pic/1.jpg"));
        assert_eq!(p.followers, Some(10));
        assert_eq!(p.pk.as_deref(), Some("999"));
        // booleanos también sobreviven a una fetch degradada (no se resetean a 0)
        assert_eq!(p.is_private, Some(1));
        assert_eq!(p.is_verified, Some(1));
    }

    #[test]
    fn favorite_survives_upsert_and_toggles() {
        let db = temp_db();
        let pid = db.upsert_profile(&mk_profile("ana", Some("x"))).unwrap();
        db.set_favorite(pid, true).unwrap();
        db.upsert_profile(&mk_profile("ana", Some("y"))).unwrap(); // re-fetch
        let p = db.get_profile_by_id(pid).unwrap().unwrap();
        assert_eq!(p.is_favorite, 1);
        db.set_favorite(pid, false).unwrap();
        let p = db.get_profile_by_id(pid).unwrap().unwrap();
        assert_eq!(p.is_favorite, 0);
    }

    #[test]
    fn reset_failed_only_touched_failed() {
        let db = temp_db();
        let pid = db.upsert_profile(&mk_profile("ana", None)).unwrap();
        let mk = |mid: &str| MediaRow {
            media_id: mid.into(),
            publication_code: None,
            child_index: 0,
            profile_id: Some(pid),
            kind: "post".into(),
            code: None,
            taken_at: None,
            caption: None,
            media_type: None,
            thumbnail_url: None,
            thumbnail_content_url: None,
            best_url: Some("u".into()),
            local_path: None,
            has_content: false,
            content_url: None,
            byte_size: None,
            width: None,
            height: None,
            bitrate: None,
            quality_verified: false,
            status: "metadata".into(),
            error: None,
            created_at: None,
            id: None,
        };
        let a = db.upsert_media(&mk("a")).unwrap();
        let b = db.upsert_media(&mk("b")).unwrap();
        let c = db.upsert_media(&mk("c")).unwrap();
        db.mark_failed(a, "HTTP 404").unwrap();
        db.store_media_content(b, b"b", "image/jpeg", None, None, None, false, "test")
            .unwrap();
        // c queda metadata.
        let n = db.reset_failed(pid, "post").unwrap();
        assert_eq!(n, 1);
        let med = db.media_by_profile(pid, Some("post")).unwrap();
        let by_id = |id: i64| med.iter().find(|m| m.id == Some(id)).unwrap();
        assert_eq!(by_id(a).status, "metadata");
        assert!(by_id(a).error.is_none());
        assert_eq!(by_id(b).status, "downloaded"); // intacto
        assert_eq!(by_id(c).status, "metadata");
    }

    #[test]
    fn profile_stats_aggregates_and_sync() {
        let db = temp_db();
        let pid = db.upsert_profile(&mk_profile("ana", None)).unwrap();
        let mk = |mid: &str| MediaRow {
            media_id: mid.into(),
            publication_code: None,
            child_index: 0,
            profile_id: Some(pid),
            kind: "post".into(),
            code: None,
            taken_at: None,
            caption: None,
            media_type: None,
            thumbnail_url: None,
            thumbnail_content_url: None,
            best_url: Some("u".into()),
            local_path: None,
            has_content: false,
            content_url: None,
            byte_size: None,
            width: None,
            height: None,
            bitrate: None,
            quality_verified: false,
            status: "metadata".into(),
            error: None,
            created_at: None,
            id: None,
        };
        let a = db.upsert_media(&mk("a")).unwrap();
        let _ = db.upsert_media(&mk("b")).unwrap();
        db.store_media_content(a, b"a", "image/jpeg", None, None, None, false, "test")
            .unwrap();
        db.record_sync(pid, "post").unwrap();
        db.record_sync(pid, "story").unwrap(); // sin media: aparece solo por la sync
        let stats = db.profile_stats().unwrap();
        assert_eq!(stats.len(), 1);
        let s = &stats[0];
        assert_eq!(s.profile_id, pid);
        assert_eq!(s.total_media, 2);
        let post = s.kinds.iter().find(|k| k.kind == "post").unwrap();
        assert_eq!(post.local_count, 2);
        assert_eq!(post.downloaded, 1);
        assert!(post.last_sync.is_some());
        let story = s.kinds.iter().find(|k| k.kind == "story").unwrap();
        assert_eq!(story.local_count, 0);
        assert!(story.last_sync.is_some());
    }

    #[test]
    fn download_jobs_lifecycle() {
        let db = temp_db();
        let pid = db.upsert_profile(&mk_profile("ana", None)).unwrap();
        let j1 = db.insert_job(pid, "post", 10).unwrap();
        let j2 = db.insert_job(pid, "story", 3).unwrap();
        db.finish_job(j1, 8, 2).unwrap();
        let jobs = db.list_jobs(10).unwrap();
        assert_eq!(jobs.len(), 2);
        let j1row = jobs.iter().find(|j| j.id == j1).unwrap();
        assert_eq!(j1row.total, 10);
        assert_eq!(j1row.ok, 8);
        assert_eq!(j1row.failed, 2);
        assert!(j1row.finished_at.is_some());
        assert_eq!(j1row.username, "ana");
        let j2row = jobs.iter().find(|j| j.id == j2).unwrap();
        assert!(j2row.finished_at.is_none());
        // cascade: borrar el perfil borra los jobs
        db.delete_profile_cascade(pid).unwrap();
        assert_eq!(db.list_jobs(10).unwrap().len(), 0);
    }

    #[test]
    fn legacy_file_is_verified_then_migrated_to_blob() {
        let dir =
            std::env::temp_dir().join(format!("instakeeper_migrate_{}", uuid::Uuid::new_v4()));
        let legacy = dir.join("legacy.jpg");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&legacy, b"legacy-image-bytes").unwrap();
        let db = Db::open(&dir).unwrap();
        let pid = db.upsert_profile(&mk_profile("migration", None)).unwrap();
        let mid = db
            .upsert_media(&MediaRow {
                media_id: "legacy-media".into(),
                publication_code: None,
                child_index: 0,
                profile_id: Some(pid),
                kind: "post".into(),
                code: None,
                taken_at: None,
                caption: None,
                media_type: Some(1),
                thumbnail_url: None,
                thumbnail_content_url: None,
                best_url: Some("https://example.invalid/a.jpg".into()),
                local_path: Some(legacy.to_string_lossy().to_string()),
                has_content: false,
                content_url: None,
                byte_size: None,
                width: None,
                height: None,
                bitrate: None,
                quality_verified: false,
                status: "downloaded".into(),
                error: None,
                created_at: None,
                id: None,
            })
            .unwrap();
        drop(db);
        let reopened = Db::open(&dir).unwrap();
        let stored = reopened.media_content(mid).unwrap().unwrap();
        assert_eq!(stored.data, b"legacy-image-bytes");
        assert!(!legacy.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[ignore = "requiere INSTAVAULT_MIGRATION_COPY_DIR"]
    fn real_library_copy_migrates_without_content_loss() {
        let dir = std::env::var_os("INSTAVAULT_MIGRATION_COPY_DIR")
            .map(std::path::PathBuf::from)
            .expect("define INSTAVAULT_MIGRATION_COPY_DIR");
        let path = dir.join("instakeeper.db");
        let before = rusqlite::Connection::open(&path).unwrap();
        let profiles_before: i64 = before
            .query_row("SELECT COUNT(*) FROM profiles", [], |row| row.get(0))
            .unwrap();
        let media_before: i64 = before
            .query_row("SELECT COUNT(*) FROM media", [], |row| row.get(0))
            .unwrap();
        let blobs_before: i64 = before
            .query_row("SELECT COUNT(*) FROM media_content", [], |row| row.get(0))
            .unwrap();
        drop(before);

        let migrated = Db::open(&dir).expect("la migración falló");
        let integrity: String = migrated
            .conn
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .unwrap();
        let profiles_after: i64 = migrated
            .conn
            .query_row("SELECT COUNT(*) FROM profiles", [], |row| row.get(0))
            .unwrap();
        let media_after: i64 = migrated
            .conn
            .query_row("SELECT COUNT(*) FROM media", [], |row| row.get(0))
            .unwrap();
        let blobs_after: i64 = migrated
            .conn
            .query_row("SELECT COUNT(*) FROM media_content", [], |row| row.get(0))
            .unwrap();
        assert_eq!(integrity, "ok");
        assert_eq!(profiles_after, profiles_before);
        assert!(media_after <= media_before);
        assert_eq!(blobs_after, blobs_before);
        println!(
            "migration_ok profiles={profiles_before}->{profiles_after} media={media_before}->{media_after} blobs={blobs_before}->{blobs_after}"
        );
    }
}
