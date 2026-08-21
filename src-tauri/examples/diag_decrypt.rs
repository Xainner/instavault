//! Prueba el descifrado real de las cookies de Instagram (sin imprimir
//! valores, solo longitudes y éxito/fallo por cookie).
//! Ejecutar: cargo run --example diag_decrypt
use instavault_lib::instagram::browser;

fn main() {
    let profiles = browser::discover();
    if profiles.is_empty() {
        println!("sin perfiles");
        return;
    }
    for bp in &profiles {
        println!("=== {} [{}] ===", bp.browser, bp.profile);
        let key = match browser::load_key_for_test(&bp.local_state_path) {
            Ok(k) => k,
            Err(e) => {
                println!("clave: ERR {e}");
                continue;
            }
        };
        let tmp = std::env::temp_dir().join(format!("iv_diag2_{}.db", bp.profile.replace('\\', "_")));
        let _ = std::fs::remove_file(&tmp);
        if std::fs::copy(&bp.cookies_path, &tmp).is_err() {
            println!("copia: BLOQUEADA");
            continue;
        }
        let conn = rusqlite::Connection::open(&tmp).unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT name, value, encrypted_value FROM cookies WHERE host_key LIKE '%instagram.com'",
            )
            .unwrap();
        let rows: Vec<(String, String, Vec<u8>)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, Vec<u8>>(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();

        for (name, plain, enc) in &rows {
            if enc.is_empty() {
                println!("  {name}: sin encrypted_value");
                continue;
            }
            let prefix: Vec<u8> = enc.iter().take(3).cloned().collect();
            let pfx = String::from_utf8_lossy(&prefix).to_string();
            match browser::decrypt_for_test(&enc, &key) {
                Ok(v) => println!("  {name} [{pfx}] OK len={}", v.len()),
                Err(e) => println!("  {name} [{pfx}] FAIL: {}", e.to_string().split('.').next().unwrap_or("?")),
            }
        }
        let _ = std::fs::remove_file(&tmp);
    }
}
