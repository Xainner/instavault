//! Extracción de cookies de navegadores Chromium (Chrome, Edge, Brave, Opera)
//! en Windows: lee la base de cookies cifrada, descifra con la clave de
//! "Local State" (DPAPI + AES-256-GCM) y arma el header de Instagram.

use anyhow::{anyhow, Context, Result};
use base64::Engine;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserProfile {
    pub browser: String,
    pub profile: String,
    pub cookies_path: String,
    #[serde(skip)]
    pub local_state_path: PathBuf,
}

/// Rutas de "User Data" relativas a %LOCALAPPDATA%.
/// Opera vive en "Opera Software" (p. ej. "Opera GX Stable") y no expone un
/// "User Data" único, por eso se trata aparte con glob.
const BROWSERS: &[(&str, &str)] = &[
    ("Google/Chrome/User Data", "Chrome"),
    ("Microsoft/Edge/User Data", "Edge"),
    ("BraveSoftware/Brave-Browser/User Data", "Brave"),
];

/// Detecta perfiles de navegadores Chromium con base de cookies disponible.
/// Chrome/Edge/Brave: <User Data>/<Perfil>/Cookies o <Perfil>/Network/Cookies
/// (los Chrome modernos mueven la base a la carpeta Network).
pub fn discover() -> Vec<BrowserProfile> {
    let local = match std::env::var("LOCALAPPDATA").ok().map(PathBuf::from) {
        Some(d) => d,
        None => return Vec::new(),
    };
    let mut out = Vec::new();
    for (rel, name) in BROWSERS {
        let user_data = local.join(rel);
        scan_chromium(&user_data, name, &mut out);
    }
    // Opera / Opera GX: %LOCALAPPDATA%\Opera Software\<Stable|Opera GX Stable>
    let opera_root = local.join("Opera Software");
    if opera_root.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&opera_root) {
            for entry in entries.flatten() {
                let d = entry.path();
                if !d.is_dir() {
                    continue;
                }
                let fname = entry.file_name().to_string_lossy().to_string();
                if fname.ends_with("Stable") {
                    scan_chromium(&d, "Opera", &mut out);
                }
            }
        }
    }
    // Perfil "Default" primero
    out.sort_by(|a, b| {
        b.profile
            .eq_ignore_ascii_case("default")
            .cmp(&a.profile.eq_ignore_ascii_case("default"))
    });
    out
}

/// Recorre los perfiles de un "User Data" buscando la base de cookies
/// (rutas clásica y moderna).
fn scan_chromium(user_data: &Path, browser: &str, out: &mut Vec<BrowserProfile>) {
    if !user_data.is_dir() {
        return;
    }
    let local_state = user_data.join("Local State");
    let Ok(entries) = std::fs::read_dir(user_data) else {
        return;
    };
    for entry in entries.flatten() {
        let d = entry.path();
        if !d.is_dir() {
            continue;
        }
        let cookies = if d.join("Cookies").exists() {
            d.join("Cookies")
        } else {
            let p = d.join("Network").join("Cookies");
            if p.exists() {
                p
            } else {
                continue;
            }
        };
        let profile = entry.file_name().to_string_lossy().to_string();
        out.push(BrowserProfile {
            browser: browser.to_string(),
            profile,
            cookies_path: cookies.to_string_lossy().to_string(),
            local_state_path: local_state.clone(),
        });
    }
}

/// Clave AES-256 desde "Local State" (base64 v10/v11 + DPAPI).
fn load_master_key(local_state: &Path) -> Result<[u8; 32]> {
    let text = std::fs::read_to_string(local_state)
        .with_context(|| format!("no se pudo leer {:?}", local_state))?;
    let v: serde_json::Value = serde_json::from_str(&text)
        .with_context(|| "Local State no es JSON válido")?;
    let b64 = v["os_crypt"]["encrypted_key"]
        .as_str()
        .ok_or_else(|| anyhow!("el navegador no expone la clave cifrada (os_crypt.encrypted_key)"))?;
    let raw = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .context("clave base64 inválida")?;
    if raw.len() < 5 + 32 {
        return Err(anyhow!(
            "clave maestra con longitud inesperada: {} bytes",
            raw.len()
        ));
    }
    // Formato de Windows: "DPAPI" (5 bytes) + bloque protegido por DPAPI.
    let prefix = &raw[0..5];
    if prefix != b"DPAPI" {
        return Err(anyhow!(
            "prefijo de clave no soportado: {:?} (¿navegador muy nuevo?)",
            String::from_utf8_lossy(prefix)
        ));
    }
    let key = unsafe { dpapi_unprotect(&raw[5..]) }?;
    if key.len() != 32 {
        return Err(anyhow!("clave DPAPI descifrada con longitud inválida: {}", key.len()));
    }
    let mut k = [0u8; 32];
    k.copy_from_slice(&key);
    Ok(k)
}

fn decrypt_cookie_value(value: &[u8], key: &[u8; 32]) -> Result<String> {
    let bytes = if value.len() >= 3 {
        match &value[0..3] {
            b"v10" | b"v11" => {
                if value.len() < 3 + 12 + 16 {
                    return Err(anyhow!("cookie v10/v11 demasiado corta"));
                }
                aes_gcm_decrypt(key, &value[3..])?
            }
            b"v20" => unsafe { dpapi_unprotect(&value[3..]) }?,
            _ => value.to_vec(),
        }
    } else {
        value.to_vec()
    };
    String::from_utf8(bytes).context("cookie no es texto UTF-8")
}

fn aes_gcm_decrypt(key: &[u8; 32], payload: &[u8]) -> Result<Vec<u8>> {
    use aead::Aead;
    use aes_gcm::{Aes256Gcm, Nonce, KeyInit};
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| anyhow!("clave AES inválida: {e}"))?;
    let (nonce, ct) = payload.split_at(12);
    cipher
        .decrypt(Nonce::from_slice(nonce), ct)
        .map_err(|e| anyhow!("descifrado AES-GCM de la cookie falló: {e}"))
}

/// Extrae el header de cookies de instagram.com para un perfil de navegador.
pub fn instagram_cookie_header(bp: &BrowserProfile) -> Result<CookieExtract> {
    let key = load_master_key(&bp.local_state_path)?;

    // Copia temporal: el navegador puede tener el archivo bloqueado.
    let tmp = std::env::temp_dir().join(format!(
        "instavault_cookies_{}.db",
        uuid::Uuid::new_v4()
    ));
    // Reintentos: el SO libera el archivo en cuanto el navegador hace flush.
    let mut last_err = String::new();
    for attempt in 0..4u32 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(400 * attempt as u64));
        }
        match std::fs::copy(&bp.cookies_path, &tmp) {
            Ok(_) => break,
            Err(e) => {
                last_err = format!("no se pudo leer la base de cookies de {}: {e}", bp.browser);
            }
        }
    }
    if !tmp.exists() {
        return Err(anyhow!(
            "{last_err}. Cierra {} (todos sus procesos) y vuelve a intentarlo.",
            bp.browser
        ));
    }

    let result = (|| -> Result<CookieExtract> {
        let conn = rusqlite::Connection::open(&tmp)?;
        let mut stmt = conn.prepare(
            "SELECT host_key, name, value FROM cookies WHERE host_key LIKE '%instagram.com'",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Vec<u8>>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut map: std::collections::BTreeMap<String, String> = std::collections::BTreeMap::new();
        for (host, name, raw) in rows {
            if raw.is_empty() {
                continue;
            }
            // Prefiere hosts sin www si ambos existen (escribir después = ganar)
            if host.starts_with("www.") {
                if map.contains_key(&name) {
                    continue;
                }
            }
            match decrypt_cookie_value(&raw, &key) {
                Ok(v) => {
                    map.insert(name, v);
                }
                Err(_) => continue,
            }
        }

        if !map.contains_key("sessionid") {
            return Err(anyhow!(
                "no hay cookie sessionid de Instagram en este perfil (¿estás logueado en ese navegador?)"
            ));
        }
        let mut parts: Vec<String> = map
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect();
        parts.sort();
        Ok(CookieExtract {
            header: parts.join("; "),
            ds_user_id: map.get("ds_user_id").cloned(),
        })
    })();

    let _ = std::fs::remove_file(&tmp);
    result
}

#[derive(Debug)]
pub struct CookieExtract {
    pub header: String,
    pub ds_user_id: Option<String>,
}

/// Proceso (imagen) de cada navegador para poder cerrarlo con taskkill.
pub fn process_image(browser: &str) -> Option<&'static str> {
    match browser.to_ascii_lowercase().as_str() {
        "chrome" => Some("chrome.exe"),
        "edge" => Some("msedge.exe"),
        "brave" => Some("brave.exe"),
        "opera" => Some("opera.exe"),
        _ => None,
    }
}

/// Cierra todas las instancias del navegador indicado (para desbloquear la
/// base de cookies). Devuelve el número de procesos terminados.
pub fn close_browser(browser: &str) -> Result<u32> {
    let image = process_image(browser)
        .ok_or_else(|| anyhow!("navegador no soportado: {browser}"))?;
    let out = std::process::Command::new("taskkill")
        .args(["/F", "/IM", image])
        .output()
        .context("no se pudo ejecutar taskkill")?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !out.status.success() {
        // Si no hay instancias corriendo, taskkill falla pero eso está bien.
        if stdout.contains("no se encuentra") || stderr.contains("no se encuentra")
            || stdout.to_lowercase().contains("not running")
        {
            return Ok(0);
        }
        return Err(anyhow!("taskkill falló: {stderr}{stdout}"));
    }
    // taskkill imprime "Éxito: el proceso ... con PID n se ha finalizado"
    let n = stdout
        .lines()
        .filter(|l| l.to_lowercase().contains("pid"))
        .count() as u32;
    Ok(n)
}

// ---------------------------------------------------------------------------
// DPAPI (Windows)
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
unsafe fn dpapi_unprotect(data: &[u8]) -> Result<Vec<u8>> {
    use std::ffi::c_void;
    use std::ptr;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct DataBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    #[link(name = "crypt32")]
    extern "system" {
        fn CryptUnprotectData(
            p_data_in: *mut DataBlob,
            p_data_desc: *mut *mut u16,
            p_optional_entropy: *mut DataBlob,
            pv_reserved: *mut c_void,
            p_prompt: *mut c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(h_mem: *mut c_void) -> *mut c_void;
    }

    let mut in_blob = DataBlob {
        cb_data: data.len() as u32,
        pb_data: data.as_ptr() as *mut u8,
    };
    let mut out_blob = DataBlob {
        cb_data: 0,
        pb_data: ptr::null_mut(),
    };
    if CryptUnprotectData(
        &mut in_blob,
        ptr::null_mut(),
        ptr::null_mut(),
        ptr::null_mut(),
        ptr::null_mut(),
        0,
        &mut out_blob,
    ) == 0
    {
        let code = std::io::Error::last_os_error()
            .raw_os_error()
            .unwrap_or(-1);
        return Err(anyhow!(
            "CryptUnprotectData falló (código {code}). La clave está protegida por DPAPI del usuario actual."
        ));
    }
    let out = std::slice::from_raw_parts(out_blob.pb_data, out_blob.cb_data as usize).to_vec();
    LocalFree(out_blob.pb_data as *mut c_void);
    Ok(out)
}

#[cfg(not(target_os = "windows"))]
fn dpapi_unprotect(_data: &[u8]) -> Result<Vec<u8>> {
    Err(anyhow!(
        "la extracción desde el navegador solo está disponible en Windows por ahora"
    ))
}