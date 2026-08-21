use rusqlite::{params, Connection};
use std::path::Path;

pub struct Db {
    conn: Connection,
}

impl Db {
    pub fn open(dir: &Path) -> rusqlite::Result<Self> {
        std::fs::create_dir_all(dir).ok();
        let path = dir.join("instakeeper.db");
        let conn = Connection::open(&path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        let db = Db { conn };
        db.migrate()?;
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
            "#,
        )?;
        Ok(())
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
        self.conn.execute(
            r#"INSERT INTO profiles (username, pk, full_name, biography, followers, following,
                                     media_count, is_private, is_verified, profile_pic_url, fetched_at)
               VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
               ON CONFLICT(username) DO UPDATE SET
                 pk=excluded.pk, full_name=excluded.full_name, biography=excluded.biography,
                 followers=excluded.followers, following=excluded.following,
                 media_count=excluded.media_count, is_private=excluded.is_private,
                 is_verified=excluded.is_verified, profile_pic_url=excluded.profile_pic_url,
                 fetched_at=excluded.fetched_at"#,
            params![
                p.username, p.pk, p.full_name, p.biography, p.followers, p.following,
                p.media_count, p.is_private, p.is_verified, p.profile_pic_url,
                p.fetched_at
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
                    is_private, is_verified, profile_pic_url, fetched_at, id
             FROM profiles WHERE id=?1",
        )?;
        let mut rows = stmt.query_map(params![id], |r| {
            Ok(crate::instagram::models::ProfileRow {
                username: r.get(0)?,
                pk: r.get(1)?,
                full_name: r.get(2)?,
                biography: r.get(3)?,
                followers: r.get(4)?,
                following: r.get(5)?,
                media_count: r.get(6)?,
                is_private: r.get::<_, Option<i64>>(7)?.unwrap_or(0),
                is_verified: r.get::<_, Option<i64>>(8)?.unwrap_or(0),
                profile_pic_url: r.get(9)?,
                fetched_at: r.get(10)?,
                id: Some(r.get(11)?),
            })
        })?;
        Ok(rows.next().transpose()?)
    }

    pub fn list_profiles(&self) -> rusqlite::Result<Vec<crate::instagram::models::ProfileRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT username, pk, full_name, biography, followers, following, media_count,
                    is_private, is_verified, profile_pic_url, fetched_at, id
             FROM profiles ORDER BY username",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(crate::instagram::models::ProfileRow {
                    username: r.get(0)?,
                    pk: r.get(1)?,
                    full_name: r.get(2)?,
                    biography: r.get(3)?,
                    followers: r.get(4)?,
                    following: r.get(5)?,
                    media_count: r.get(6)?,
                    is_private: r.get::<_, Option<i64>>(7)?.unwrap_or(0),
                    is_verified: r.get::<_, Option<i64>>(8)?.unwrap_or(0),
                    profile_pic_url: r.get(9)?,
                    fetched_at: r.get(10)?,
                    id: Some(r.get(11)?),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    // ---- Media ----
    pub fn upsert_media(&self, m: &crate::instagram::models::MediaRow) -> rusqlite::Result<i64> {
        self.conn.execute(
            r#"INSERT INTO media (media_id, profile_id, kind, code, taken_at, caption, media_type,
                                  thumbnail_url, best_url, local_path, status, error, created_at)
               VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
               ON CONFLICT(media_id) DO UPDATE SET
                 best_url=excluded.best_url, thumbnail_url=excluded.thumbnail_url,
                 caption=excluded.caption, media_type=excluded.media_type,
                 code=excluded.code, taken_at=excluded.taken_at"#,
            params![
                m.media_id,
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
                m.created_at
            ],
        )?;
        Ok(self.conn.query_row(
            "SELECT id FROM media WHERE media_id=?1",
            params![m.media_id],
            |r| r.get(0),
        )?)
    }

    pub fn mark_downloaded(&self, id: i64, local_path: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE media SET status='downloaded', local_path=?2, error=NULL WHERE id=?1",
            params![id, local_path],
        )?;
        Ok(())
    }

    pub fn mark_failed(&self, id: i64, error: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE media SET status='failed', error=?2 WHERE id=?1",
            params![id, error],
        )?;
        Ok(())
    }

    pub fn media_by_profile(
        &self,
        profile_id: i64,
        kind: Option<&str>,
    ) -> rusqlite::Result<Vec<crate::instagram::models::MediaRow>> {
        let mut sql = String::from(
            "SELECT media_id, profile_id, kind, code, taken_at, caption, media_type,
                    thumbnail_url, best_url, local_path, status, error, created_at, id
             FROM media WHERE profile_id=?1",
        );
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(profile_id)];
        if let Some(k) = kind {
            sql.push_str(" AND kind=?2");
            params.push(Box::new(k.to_string()));
        }
        sql.push_str(" ORDER BY taken_at DESC");
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt
            .query_map(
                rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())),
                |r| {
                    Ok(crate::instagram::models::MediaRow {
                        media_id: r.get(0)?,
                        profile_id: r.get(1)?,
                        kind: r.get(2)?,
                        code: r.get(3)?,
                        taken_at: r.get(4)?,
                        caption: r.get(5)?,
                        media_type: r.get(6)?,
                        thumbnail_url: r.get(7)?,
                        best_url: r.get(8)?,
                        local_path: r.get(9)?,
                        status: r.get(10)?,
                        error: r.get(11)?,
                        created_at: r.get(12)?,
                        id: Some(r.get(13)?),
                    })
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn pending_downloads(
        &self,
        limit: i64,
    ) -> rusqlite::Result<Vec<crate::instagram::models::MediaRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT media_id, profile_id, kind, code, taken_at, caption, media_type,
                    thumbnail_url, best_url, local_path, status, error, created_at, id
             FROM media WHERE status='metadata' AND best_url IS NOT NULL LIMIT ?1",
        )?;
        let rows = stmt
            .query_map(params![limit], |r| {
                Ok(crate::instagram::models::MediaRow {
                    media_id: r.get(0)?,
                    profile_id: r.get(1)?,
                    kind: r.get(2)?,
                    code: r.get(3)?,
                    taken_at: r.get(4)?,
                    caption: r.get(5)?,
                    media_type: r.get(6)?,
                    thumbnail_url: r.get(7)?,
                    best_url: r.get(8)?,
                    local_path: r.get(9)?,
                    status: r.get(10)?,
                    error: r.get(11)?,
                    created_at: r.get(12)?,
                    id: Some(r.get(13)?),
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
            is_private: 0,
            is_verified: 0,
            profile_pic_url: None,
            fetched_at: Some(1),
            id: None,
        };
        let pid = db.upsert_profile(&p).unwrap();
        assert_eq!(db.get_profile_id("juan").unwrap(), pid);

        let m = MediaRow {
            media_id: "abc_1".into(),
            profile_id: Some(pid),
            kind: "post".into(),
            code: Some("ABC".into()),
            taken_at: Some(2),
            caption: Some("hola".into()),
            media_type: Some(1),
            thumbnail_url: Some("http://t".into()),
            best_url: Some("http://b".into()),
            local_path: None,
            status: "metadata".into(),
            error: None,
            created_at: Some(3),
            id: None,
        };
        let mid = db.upsert_media(&m).unwrap();
        db.mark_downloaded(mid, "/ruta/a.jpg").unwrap();
        let med = db.media_by_profile(pid, Some("post")).unwrap();
        assert_eq!(med.len(), 1);
        assert_eq!(med[0].status, "downloaded");
        assert_eq!(med[0].local_path.as_deref(), Some("/ruta/a.jpg"));

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
            is_private: 0,
            is_verified: 0,
            profile_pic_url: None,
            fetched_at: None,
            id: None,
        };
        let pid = db.upsert_profile(&p).unwrap();
        let mk = |code: &str| MediaRow {
            media_id: "same_id".into(),
            profile_id: Some(pid),
            kind: "post".into(),
            code: Some(code.into()),
            taken_at: None,
            caption: None,
            media_type: None,
            thumbnail_url: None,
            best_url: Some(format!("http://{code}")),
            local_path: None,
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
}
