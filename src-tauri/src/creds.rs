const SERVICE: &str = "com.xainner.instavault";
/// Servicios usados por versiones anteriores. La versión actual no guarda ni
/// lee cookies: sólo elimina la credencial legacy al reconectar/desconectar.
const SERVICE_LEGACY: &str = "com.xainner.instakeeper";

/// Borra las cookies de una cuenta del llavero (nuevo y legacy).
pub fn delete_cookies(account_id: i64) {
    let key = format!("account:{account_id}");
    for svc in [SERVICE, SERVICE_LEGACY] {
        if let Ok(entry) = keyring::Entry::new(svc, &key) {
            let _ = entry.delete_credential();
        }
    }
}
