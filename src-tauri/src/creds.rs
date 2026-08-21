use anyhow::Context;

const SERVICE: &str = "com.xainner.instakeeper";

/// Guarda el header de cookies crudo de una cuenta en el llavero del SO.
pub fn save_cookies(account_id: i64, cookie_header: &str) -> anyhow::Result<()> {
    let entry = keyring::Entry::new(SERVICE, &format!("account:{account_id}"))?;
    entry
        .set_password(cookie_header)
        .context("no se pudo escribir en el llavero del sistema")
}

/// Carga el header de cookies de una cuenta desde el llavero.
pub fn load_cookies(account_id: i64) -> anyhow::Result<String> {
    let entry = keyring::Entry::new(SERVICE, &format!("account:{account_id}"))?;
    entry
        .get_password()
        .context("no se pudieron leer las cookies de esta cuenta (¿llave eliminada?)")
}

/// Borra las cookies de una cuenta del llavero.
pub fn delete_cookies(account_id: i64) {
    if let Ok(entry) = keyring::Entry::new(SERVICE, &format!("account:{account_id}")) {
        let _ = entry.delete_credential();
    }
}
