use rusqlite::Connection;

/// Verificación manual y de solo lectura para una biblioteca real. La ruta se
/// recibe por entorno y nunca se incorpora al repositorio ni a la salida.
#[test]
#[ignore = "requiere INSTAVAULT_LIBRARY_DB"]
fn existing_library_is_healthy() {
    let path = std::env::var_os("INSTAVAULT_LIBRARY_DB")
        .expect("define INSTAVAULT_LIBRARY_DB para ejecutar esta prueba manual");
    let db = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("no se pudo abrir la biblioteca en modo lectura");
    let integrity: String = db
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .expect("falló integrity_check");
    assert_eq!(integrity, "ok");

    let profiles: i64 = db
        .query_row("SELECT COUNT(*) FROM profiles", [], |row| row.get(0))
        .expect("no se pudieron contar perfiles");
    let media: i64 = db
        .query_row("SELECT COUNT(*) FROM media", [], |row| row.get(0))
        .expect("no se pudieron contar medios");
    let blobs: i64 = db
        .query_row("SELECT COUNT(*) FROM media_content", [], |row| row.get(0))
        .expect("no se pudieron contar BLOB");
    let avatars: i64 = db
        .query_row("SELECT COUNT(*) FROM profile_avatar_content", [], |row| {
            row.get(0)
        })
        .expect("no se pudieron contar avatares");
    let thumbnails: i64 = db
        .query_row("SELECT COUNT(*) FROM media_thumbnail_content", [], |row| {
            row.get(0)
        })
        .unwrap_or(0);
    let blob_bytes: i64 = db
        .query_row(
            "SELECT COALESCE(SUM(byte_size), 0) FROM media_content",
            [],
            |row| row.get(0),
        )
        .expect("no se pudieron sumar los bytes");
    let invalid_placeholders: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM media WHERE media_id IN ('web_p','web_reel')",
            [],
            |row| row.get(0),
        )
        .expect("no se pudieron validar los placeholders");
    assert_eq!(invalid_placeholders, 0);
    let progress_rows: i64 = db
        .query_row("SELECT COUNT(*) FROM sync_progress", [], |row| row.get(0))
        .expect("no se pudo consultar sync_progress");
    println!(
        "library_ok profiles={profiles} media={media} media_content={blobs} avatars={avatars} thumbnails={thumbnails} blob_bytes={blob_bytes} sync_progress={progress_rows}"
    );
    let mut account_query = db
        .prepare("SELECT username,status,COALESCE(auth_mode,'') FROM accounts ORDER BY id")
        .expect("no se pudo preparar el resumen de cuentas");
    let accounts = account_query
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .expect("no se pudieron consultar las cuentas");
    for account in accounts {
        let (username, status, auth_mode) = account.expect("cuenta inválida");
        println!("account username={username} status={status} auth_mode={auth_mode}");
    }

    let mut profile_query = db
        .prepare(
            "SELECT p.username,p.is_private,COUNT(m.id),MAX(m.taken_at),MAX(m.created_at), \
                    SUM(CASE WHEN m.id IS NOT NULL AND m.taken_at IS NULL THEN 1 ELSE 0 END), \
                    SUM(CASE WHEN mt.media_id IS NOT NULL THEN 1 ELSE 0 END) \
             FROM profiles p LEFT JOIN media m ON m.profile_id=p.id \
             LEFT JOIN media_thumbnail_content mt ON mt.media_id=m.id \
             GROUP BY p.id ORDER BY p.id",
        )
        .expect("no se pudo preparar el resumen de perfiles");
    let profiles = profile_query
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
            ))
        })
        .expect("no se pudieron consultar los perfiles");
    for profile in profiles {
        let (username, private, count, newest_taken, newest_stored, undated, thumbnails) =
            profile.expect("perfil inválido");
        println!(
            "profile username={username} private={private:?} media={count} undated={undated} thumbnails={thumbnails} newest_taken={newest_taken:?} newest_stored={newest_stored:?}"
        );
    }
    if let Ok(username) = std::env::var("INSTAVAULT_LIBRARY_PROFILE") {
        let privacy: Option<i64> = db
            .query_row(
                "SELECT is_private FROM profiles WHERE username=?1",
                [username],
                |row| row.get(0),
            )
            .expect("no se pudo consultar la privacidad del perfil");
        println!("profile_privacy={privacy:?}");
    }
}
