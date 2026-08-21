use anyhow::Context;

const SERVICE: &str = "com.xainner.instavault";
/// Servicio usado en versiones tempranas (fallback de lectura).
const SERVICE_LEGACY: &str = "com.xainner.instakeeper";

/// Guarda el header de cookies crudo de una cuenta en el llavero del SO.
pub fn save_cookies(account_id: i64, cookie_header: &str) -> anyhow::Result<()> {
    let entry = keyring::Entry::new(SERVICE, &format!("account:{account_id}"))?;
    entry
        .set_password(cookie_header)
        .context("no se pudo escribir en el llavero del sistema")?;
    Ok(())
}

/// Carga el header de cookies de una cuenta (proba el servicio nuevo y el legacy).
pub fn load_cookies(account_id: i64) -> anyhow::Result<String> {
    let key = format!("account:{account_id}");
    if let Ok(entry) = keyring::Entry::new(SERVICE, &key) {
        if let Ok(pw) = entry.get_password() {
            return Ok(pw);
        }
    }
    if let Ok(entry) = keyring::Entry::new(SERVICE_LEGACY, &key) {
        if let Ok(pw) = entry.get_password() {
            return Ok(pw);
        }
    }
    Err(anyhow::anyhow!(
        "no se pudieron leer las cookies de esta cuenta (¿llave eliminada?)"
    ))
}

/// Borra las cookies de una cuenta del llavero (nuevo y legacy).
pub fn delete_cookies(account_id: i64) {
    let key = format!("account:{account_id}");
    for svc in [SERVICE, SERVICE_LEGACY] {
        if let Ok(entry) = keyring::Entry::new(svc, &key) {
            let _ = entry.delete_credential();
        }
    }
}