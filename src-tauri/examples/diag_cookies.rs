//! Diagnóstico: lista las cookies de instagram.com del perfil y cuántas se
//! descifran. NO imprime valores, solo nombres y longitudes.
//! Ejecutar: cargo run --example diag_cookies
use instavault_lib::instagram::browser;

fn main() {
    let profiles = browser::discover();
    let bp = match profiles.first() {
        Some(p) => p,
        None => {
            println!("sin perfiles");
            return;
        }
    };
    println!("Perfil: {} [{}]", bp.browser, bp.profile);
    let key = match load(&bp) {
        Ok(k) => k,
        Err(e) => {
            println!("clave: ERR {e}");
            return;
        }
    };
    println!("clave maestra: OK");

    let tmp = std::env::temp_dir().join("iv_diag.db");
    let _ = std::fs::remove_file(&tmp);
    if std::fs::copy(&bp.cookies_path, &tmp).is_err() {
        println!("copia: BLOQUEADA (navegador abierto)");
        return;
    }
    let conn = rusqlite::Connection::open(&tmp).unwrap();
    let mut stmt = conn
        .prepare("SELECT host_key, name, length(value), length(encrypted_value) FROM cookies WHERE host_key LIKE '%instagram%'")
        .unwrap();
    let rows: Vec<(String, String, i64, i64)> = stmt
        .query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                r.get::<_, Option<i64>>(3)?.unwrap_or(0),
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    println!("cookies instagram*: {}", rows.len());
    for (host, name, lv, le) in &rows {
        println!("  {host} {name} plain={lv} enc={le}");
    }
    let _ = std::fs::remove_file(&tmp);

    fn load(bp: &browser::BrowserProfile) -> Result<[u8; 32], String> {
        // reutiliza la clave via API pública indirecta
        match browser::load_key_for_test(&bp.local_state_path) {
            Ok(k) => Ok(k),
            Err(e) => Err(e.to_string()),
        }
    }
}
