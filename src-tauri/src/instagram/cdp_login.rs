//! Login de Instagram mediante un navegador controlado por InstaVault.
//!
//! Chrome 127+ cifra las cookies con App-Bound Encryption y Chrome 136+ prohíbe
//! el debugging remoto sobre el perfil por defecto, así que leer la base de
//! cookies del usuario ya no es viable. En su lugar, InstaVault abre SU PROPIO
//! Chromium (perfil persistente en %APPDATA%/InstaVault/browser-profile) con
//! --remote-debugging-port, el usuario inicia sesión ahí una vez, y la app
//! captura las cookies vía DevTools Protocol (Network.getCookies), que devuelve
//! los valores ya descifrados.

use anyhow::{anyhow, Context, Result};
use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// Estado del navegador de login.
pub struct CdpSession {
    child: Child,
    port: u16,
}

impl Drop for CdpSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl CdpSession {
    /// Elimina cualquier proceso de Chrome que use el perfil de InstaVault.
    /// Sin esto, Chrome redirige al proceso existente (que bloquea el perfil) y el
    /// nuevo no abre el puerto CDP -> timeout de conexión (os error 10060).
    pub fn kill_existing() {
        let Ok(profile) = profile_dir() else { return };
        let needle = profile.to_string_lossy().to_string();
        #[cfg(target_os = "windows")]
        {
            let _ = std::process::Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-Command",
                    "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' or Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*InstaVault*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
                ])
                .output();
        }
        let _ = needle;
    }

    /// Lanza un Chromium con perfil propio y CDP en un puerto libre.
    pub fn launch() -> Result<Self> {
        let exe = find_chromium()?;
        let port = free_port()?;
        let profile_dir = profile_dir()?;
        std::fs::create_dir_all(&profile_dir).context("no se pudo crear el perfil del navegador")?;

        let child = Command::new(&exe)
            .args([
                &format!("--remote-debugging-port={port}"),
                &format!(
                    "--user-data-dir={}",
                    profile_dir.display()
                ),
                "--no-first-run",
                "--no-default-browser-check",
                "https://www.instagram.com/accounts/login/",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .with_context(|| format!("no se pudo lanzar {exe:?}"))?;

        Ok(CdpSession { child, port })
    }

    /// Espera a que el CDP esté disponible (hasta 15 s).
    pub fn wait_ready(&self) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            if std::net::TcpStream::connect(("127.0.0.1", self.port)).is_ok() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(300));
    }
        Err(anyhow!("el navegador no abrió el puerto de depuración"))
    }

    /// URL visible para el usuario (no aplica en headless; se usa para debug).
    pub fn debug_url(&self) -> String {
        format!("http://127.0.0.1:{}/json/version", self.port)
    }

    /// Espera (sondeando cada 2 s) hasta que exista la cookie sessionid de
    /// instagram.com o se agote el tiempo.
    pub fn wait_for_session(&self, timeout: Duration) -> Result<String> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(header) = self.try_capture()? {
                return Ok(header);
            }
            if Instant::now() >= deadline {
                return Err(anyhow!("tiempo agotado esperando el login"));
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    }

    /// Intenta capturar las cookies de Instagram ahora mismo.
    /// Devuelve None si aún no hay sessionid.
    pub fn try_capture(&self) -> Result<Option<String>> {
        capture_cookies(self.port)
    }

    /// Indica si el proceso del navegador sigue vivo.
    pub fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Cierra el navegador ordenadamente.
    pub fn shutdown(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Obtiene la URL WebSocket de la primera página abierta.
fn page_ws_url(port: u16) -> Result<String> {
    let resp = http_get_json(&format!("http://127.0.0.1:{port}/json/list"))?;
    let pages = resp
        .as_array()
        .ok_or_else(|| anyhow!("respuesta /json/list no es un arreglo"))?
        .iter()
        .filter(|t| t.get("type").and_then(|t| t.as_str()) == Some("page"))
        .collect::<Vec<_>>();
    let page = pages
        .first()
        .ok_or_else(|| anyhow!("el navegador no tiene páginas abiertas"))?;
    page.get("webSocketDebuggerUrl")
        .and_then(|u| u.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| anyhow!("página sin webSocketDebuggerUrl"))
}

/// Conecta al CDP, pide las cookies de Instagram y arma el header.
/// Devuelve Ok(None) si aún no hay sessionid.
pub fn capture_cookies(port: u16) -> Result<Option<String>> {
    let ws_url = page_ws_url(port)?;
    let (mut ws, _resp) = tungstenite::client::connect(&ws_url)
        .map_err(|e| anyhow!("no se pudo conectar al CDP: {e}"))?;
    // Timeout de lectura: si Chrome no responde, falla en vez de colgar.
    use tungstenite::stream::MaybeTlsStream;
    if let MaybeTlsStream::Plain(tcp) = ws.get_ref() {
        let _ = tcp.set_read_timeout(Some(Duration::from_secs(5)));
    }
    let req = serde_json::json!({
        "id": 1,
        "method": "Network.getCookies",
        "params": {"urls": ["https://www.instagram.com", "https://instagram.com"]}
    });
    use tungstenite::Message;
    ws.send(Message::Text(req.to_string()))
        .map_err(|e| anyhow!("error enviando comando CDP: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(10);
    let cookies = loop {
        if Instant::now() >= deadline {
            return Err(anyhow!("timeout esperando respuesta CDP"));
        }
        match ws.read() {
            Ok(Message::Text(t)) => {
                let v: serde_json::Value = serde_json::from_str(&t)
                    .map_err(|e| anyhow!("CDP devolvió JSON inválido: {e}"))?;
                if v.get("id").and_then(|i| i.as_u64()) == Some(1) {
                    break v
                        .pointer("/result/cookies")
                        .cloned()
                        .ok_or_else(|| anyhow!("respuesta CDP sin cookies"))?;
                }
            }
            Ok(_) => {}
            Err(e) => return Err(anyhow!("error leyendo del CDP: {e}")),
        }
    };
    let mut parts: Vec<String> = Vec::new();
    let mut has_session = false;
    for c in cookies.as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
        let name = c.get("name").and_then(|n| n.as_str()).unwrap_or("");
        let value = c.get("value").and_then(|v| v.as_str()).unwrap_or("");
        if name.is_empty() || value.is_empty() {
            continue;
        }
        if name == "sessionid" {
            has_session = true;
        }
        parts.push(format!("{name}={value}"));
    }
    parts.sort();
    if !has_session {
        return Ok(None);
    }
    Ok(Some(parts.join("; ")))
}

/// GET HTTP mínimo que parsea la respuesta JSON (expuesto para diagnóstico).
#[doc(hidden)]
pub fn http_get_json_for_test(url: &str) -> Result<serde_json::Value> {
    http_get_json(url)
}

/// GET HTTP mínimo que parsea la respuesta JSON.
fn http_get_json(url: &str) -> Result<serde_json::Value> {
    let mut url = url.to_string();
    // httparse manual: evitamos dependencia extra
    let host_port_end = url.find("://").map(|i| i + 3).unwrap_or(0);
    let rest = &url[host_port_end..];
    let slash = rest.find('/').ok_or_else(|| anyhow!("URL inválida"))?;
    let host_port = &rest[..slash];
    let path = &rest[slash..];
    let mut stream = std::net::TcpStream::connect(host_port)
        .with_context(|| format!("no se pudo conectar a {host_port}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    write!(stream, "GET {path} HTTP/1.1\r\nHost: {host_port}\r\nConnection: close\r\n\r\n")?;
    stream.flush()?;
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf)?;
    let text = String::from_utf8_lossy(&buf);
    let body = text
        .split("\r\n\r\n")
        .nth(1)
        .ok_or_else(|| anyhow!("respuesta HTTP malformada"))?;
    url.clear();
    serde_json::from_str(body).with_context(|| "JSON inválido en respuesta HTTP")
}

/// Busca un ejecutable de Chromium disponible.
fn find_chromium() -> Result<String> {
    let candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
    ];
    for c in candidates {
        if std::path::Path::new(c).exists() {
            return Ok(c.to_string());
        }
    }
    Err(anyhow!("no se encontró Chrome, Edge ni Brave instalado"))
}

/// Directorio persistente del perfil del navegador de InstaVault.
fn profile_dir() -> Result<std::path::PathBuf> {
    let base = dirs::data_dir().ok_or_else(|| anyhow!("no se pudo resolver APPDATA"))?;
    Ok(base.join("InstaVault").join("browser-profile"))
}

/// Puerto TCP libre efímero.
fn free_port() -> Result<u16> {
    let l = std::net::TcpListener::bind("127.0.0.1:0")?;
    let port = l.local_addr()?.port();
    drop(l);
    Ok(port)
}
