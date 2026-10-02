//! Login de Instagram mediante un navegador controlado por InstaVault.
//!
//! InstaVault abre un perfil Chromium propio y persistente para el acceso
//! privado. La sesión permanece dentro de ese navegador: la app no exporta,
//! copia ni inyecta sus cookies en peticiones HTTP.

use anyhow::{anyhow, Context, Result};
use base64::Engine;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// Estado del navegador de login.
pub struct CdpSession {
    child: Child,
    port: u16,
    ephemeral_profile: Option<std::path::PathBuf>,
}

impl Drop for CdpSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(path) = self.ephemeral_profile.take() {
            let _ = std::fs::remove_dir_all(path);
        }
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

    /// Lanza el navegador dedicado para login asistido. Nunca abre el perfil
    /// cotidiano del usuario ni fuerza un logout de Instagram.
    /// Siempre visible: el usuario tiene que interactuar para loguearse.
    pub fn launch() -> Result<Self> {
        Self::launch_with_url("https://www.instagram.com/accounts/login/", false)
    }

    /// Abre el perfil dedicado de InstaVault de forma visible. Las consultas
    /// privadas sólo se realizan dentro de este navegador y tras una acción
    /// explícita del usuario.
    pub fn launch_api() -> Result<Self> {
        Self::launch_with_url("https://www.instagram.com/", false)
    }

    /// Motor público completamente aislado: usa un perfil temporal nuevo y
    /// modo incógnito, por lo que no puede leer ni reutilizar las cookies del
    /// perfil persistente empleado para cuentas privadas.
    pub fn launch_public_api() -> Result<Self> {
        let profile = std::env::temp_dir().join(format!("IVPublic-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&profile).context("no se pudo crear el perfil público temporal")?;
        Self::launch_with_profile("about:blank", true, profile, true)
    }

    fn launch_with_url(start_url: &str, headless: bool) -> Result<Self> {
        let profile = profile_dir()?;
        Self::launch_with_profile(start_url, headless, profile, false)
    }

    fn launch_with_profile(
        start_url: &str,
        headless: bool,
        profile_dir: std::path::PathBuf,
        ephemeral: bool,
    ) -> Result<Self> {
        let exe = find_chromium()?;
        let port = free_port()?;
        std::fs::create_dir_all(&profile_dir)
            .context("no se pudo crear el perfil del navegador")?;

        let mut args: Vec<String> = vec![
            format!("--remote-debugging-port={port}"),
            format!("--user-data-dir={}", profile_dir.display()),
            "--no-first-run".into(),
            "--no-default-browser-check".into(),
        ];
        if ephemeral {
            args.push("--incognito".into());
            args.push("--disable-sync".into());
        }
        if headless {
            args.push("--headless=new".into());
            // Viewport estable: el fallback que parsea HTML asume layout normal.
            args.push("--window-size=1280,800".into());
        }
        args.push(start_url.to_string());

        let child = Command::new(&exe)
            .args(&args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .with_context(|| format!("no se pudo lanzar {exe:?}"))?;

        Ok(CdpSession {
            child,
            port,
            ephemeral_profile: ephemeral.then_some(profile_dir),
        })
    }

    /// Espera a que el CDP HTTP responda de verdad (hasta 25 s).
    /// Un TCP connect no basta: Chrome abre el socket antes de servir HTTP,
    /// y consultarlo antes produce timeout de lectura (os error 10060).
    pub fn wait_ready(&self) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(25);
        let url = format!("http://127.0.0.1:{}/json/version", self.port);
        let mut last_err = String::new();
        while Instant::now() < deadline {
            match http_get_json(&url) {
                Ok(v) if v.get("Browser").is_some() => return Ok(()),
                Ok(_) => {
                    last_err = "CDP respondió sin campo Browser".to_string();
                }
                Err(e) => {
                    last_err = e.to_string();
                }
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        Err(anyhow!(
            "el navegador no abrió el puerto de depuración: {last_err}"
        ))
    }

    /// URL visible para el usuario (no aplica en headless; se usa para debug).
    pub fn debug_url(&self) -> String {
        format!("http://127.0.0.1:{}/json/version", self.port)
    }

    /// Indica si el proceso del navegador sigue vivo.
    pub fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Puerto CDP en uso.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Cierra el navegador ordenadamente.
    pub fn shutdown(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(path) = self.ephemeral_profile.take() {
            let _ = std::fs::remove_dir_all(path);
        }
    }
}

/// Obtiene la URL WebSocket de la primera página de Instagram abierta.
/// Prefiere páginas cuyo URL contenga instagram.com (evita pestañas
/// auxiliares/about:blank que el navegador abra durante el login).
fn page_ws_url(port: u16) -> Result<String> {
    let resp = http_get_json(&format!("http://127.0.0.1:{port}/json/list"))?;
    let pages = resp
        .as_array()
        .ok_or_else(|| anyhow!("respuesta /json/list no es un arreglo"))?;
    let mut fallback: Option<String> = None;
    for t in pages {
        if t.get("type").and_then(|t| t.as_str()) != Some("page") {
            continue;
        }
        let ws = t
            .get("webSocketDebuggerUrl")
            .and_then(|u| u.as_str())
            .map(|s| s.to_string());
        let url = t.get("url").and_then(|u| u.as_str()).unwrap_or("");
        if url.contains("instagram.com") {
            if let Some(ws) = ws {
                return Ok(ws);
            }
        }
        if fallback.is_none() {
            fallback = ws;
        }
    }
    fallback.ok_or_else(|| anyhow!("el navegador no tiene páginas abiertas"))
}

/// URL actual de la primera página (diagnóstico).
#[doc(hidden)]
pub fn current_url_for_test(port: u16) -> Result<String> {
    let resp = http_get_json(&format!("http://127.0.0.1:{port}/json/list"))?;
    let pages = resp
        .as_array()
        .ok_or_else(|| anyhow!("sin lista de páginas"))?;
    for p in pages {
        if p.get("type").and_then(|t| t.as_str()) == Some("page") {
            let url = p.get("url").and_then(|u| u.as_str()).unwrap_or("");
            if !url.is_empty() {
                return Ok(url.to_string());
            }
        }
    }
    Err(anyhow!("no se encontró ninguna página"))
}

/// All CDP calls have a real socket timeout; a navigation can be retried only
/// while establishing the execution context, never after an Instagram denial.
fn cdp_call(port: u16, method: &str, params: serde_json::Value) -> Result<serde_json::Value> {
    let ws_url = page_ws_url(port)?;
    let (mut ws, _) = tungstenite::client::connect(&ws_url)?;
    if let tungstenite::stream::MaybeTlsStream::Plain(stream) = ws.get_mut() {
        stream.set_read_timeout(Some(Duration::from_secs(35)))?;
        stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    }
    ws.send(tungstenite::Message::Text(
        serde_json::json!({"id":1,"method":method,"params":params}).to_string(),
    ))?;
    loop {
        if let tungstenite::Message::Text(text) = ws.read()? {
            let value: serde_json::Value = serde_json::from_str(&text)?;
            if value["id"] == 1 {
                if value.get("error").is_some() {
                    return Err(anyhow!("No se pudo preparar la página de Instagram."));
                }
                return Ok(value["result"].clone());
            }
        }
    }
}

/// Navega usando una sola conexión CDP y captura las respuestas JSON que la
/// propia web de Instagram produce. No construye llamadas móviles ni añade
/// headers/cookies. El perfil del navegador determina si el acceso es público
/// anónimo o privado explícito.
pub struct CaptureResult {
    pub payloads: Vec<serde_json::Value>,
    pub publication_codes: Vec<String>,
    pub stalled: bool,
    pub http_status: Option<u16>,
    pub checkpoint_reached: bool,
}

fn record_publication_codes(
    items: &[serde_json::Value],
    checkpoint: Option<&str>,
    checkpoint_reached: &mut bool,
    unique_codes: &mut std::collections::HashSet<String>,
    publication_codes: &mut Vec<String>,
    batch_size: usize,
) {
    for item in items {
        let Some(code) = item.get("shortcode").and_then(|value| value.as_str()) else {
            continue;
        };
        if !*checkpoint_reached {
            if checkpoint == Some(code) {
                *checkpoint_reached = true;
            }
            continue;
        }
        if publication_codes.len() < batch_size && unique_codes.insert(code.to_string()) {
            publication_codes.push(code.to_string());
        }
    }
}

pub fn capture_page_payloads(
    port: u16,
    url: &str,
    timeout: Duration,
    batch_size: usize,
    checkpoint: Option<&str>,
    cancelled: Option<&std::sync::atomic::AtomicBool>,
) -> Result<CaptureResult> {
    if !url.starts_with("https://www.instagram.com/") {
        anyhow::bail!("sólo se permiten páginas de Instagram");
    }
    let ws_url = page_ws_url(port)?;
    let (mut ws, _) = tungstenite::client::connect(&ws_url)
        .map_err(|e| anyhow!("no se pudo conectar al navegador: {e}"))?;
    if let tungstenite::stream::MaybeTlsStream::Plain(stream) = ws.get_mut() {
        stream.set_read_timeout(Some(Duration::from_millis(700)))?;
        stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    }

    use tungstenite::Message;
    ws.send(Message::Text(
        serde_json::json!({
            "id": 1, "method": "Network.enable", "params": {"maxTotalBufferSize": 50_000_000}
        })
        .to_string(),
    ))?;
    ws.send(Message::Text(
        serde_json::json!({
            "id": 3, "method": "Page.enable", "params": {}
        })
        .to_string(),
    ))?;
    ws.send(Message::Text(
        serde_json::json!({
            "id": 2, "method": "Page.navigate", "params": {"url": url}
        })
        .to_string(),
    ))?;

    let deadline = Instant::now() + timeout;
    let mut last_activity = Instant::now();
    let mut next_id = 10_u64;
    let mut pending: HashMap<u64, String> = HashMap::new();
    let mut interesting_requests = std::collections::HashSet::new();
    let mut payloads = Vec::new();
    let mut loaded = false;
    let mut navigation_acknowledged = false;
    let max_scrolls = if batch_size == 0 { 0 } else { 120 };
    let mut scrolls = 0_u32;
    let mut scroll_request: Option<u64> = None;
    let mut last_grid: Option<(u64, u64, String)> = None;
    let mut unchanged_scrolls = 0_u8;
    let mut checkpoint_reached = checkpoint.is_none();
    let mut publication_codes = Vec::new();
    let mut unique_codes = std::collections::HashSet::new();
    let mut http_status = None;
    let scroll_expression = r#"(() => {
      const root = document.querySelector('main') || document;
      const anchors = Array.from(root.querySelectorAll('a[href*="/p/"],a[href*="/reel/"]'));
      const items = anchors.map(anchor => {
        const img = anchor.querySelector('img');
        const parts = new URL(anchor.href, location.href).pathname.split('/').filter(Boolean);
        const marker = parts.findIndex(part => part === 'p' || part === 'reel');
        const code = marker >= 0 ? (parts[marker + 1] || '') : '';
        if (!img || !code) return null;
        const candidates = (img.srcset || '').split(',').map(item => {
          const fields = item.trim().split(/\s+/);
          return { url: fields[0] || '', width: parseInt(fields[1] || '0', 10) || 0 };
        }).filter(item => item.url).sort((a, b) => b.width - a.width);
        return {
          id: `web_${code}`,
          __instavault_dom: true,
          needs_detail: anchor.href.includes('/reel/') || !!anchor.querySelector('svg[aria-label*="Carousel"],svg[aria-label*="carrusel"]'),
          shortcode: code,
          display_url: candidates[0]?.url || img.currentSrc || img.src || '',
          dimensions: { width: img.naturalWidth || 0, height: img.naturalHeight || 0 },
          caption_text: img.alt || ''
        };
      }).filter(Boolean);
      const last = anchors[anchors.length - 1];
      if (last) last.scrollIntoView({block: 'end', behavior: 'instant'});
      const candidates = Array.from(document.querySelectorAll('main,section,div')).filter(el => {
        const style = getComputedStyle(el);
        return el.scrollHeight > el.clientHeight + 100 && /(auto|scroll)/.test(style.overflowY);
      }).sort((a,b) => (b.scrollHeight-b.clientHeight) - (a.scrollHeight-a.clientHeight));
      const target = candidates[0] || document.scrollingElement || document.documentElement;
      target.scrollTop += Math.max(target.clientHeight * 0.85, 720);
      return {
        height: target.scrollHeight,
        posts: items.length,
        fingerprint: items.map(item => item.shortcode).join(','),
        items
      };
    })()"#;

    while Instant::now() < deadline {
        if cancelled
            .map(|flag| flag.load(std::sync::atomic::Ordering::Relaxed))
            .unwrap_or(false)
        {
            break;
        }
        match ws.read() {
            Ok(Message::Text(text)) => {
                let value: serde_json::Value = match serde_json::from_str(&text) {
                    Ok(value) => value,
                    Err(_) => continue,
                };
                if value.get("id").and_then(|v| v.as_u64()) == Some(2)
                    && value.get("error").is_none()
                {
                    navigation_acknowledged = true;
                }
                if value.get("method").and_then(|v| v.as_str()) == Some("Page.loadEventFired") {
                    loaded = true;
                    last_activity = Instant::now();
                }
                if navigation_acknowledged
                    && value.get("method").and_then(|v| v.as_str())
                        == Some("Network.responseReceived")
                {
                    let response = &value["params"]["response"];
                    let status = response["status"].as_u64().unwrap_or(0) as u16;
                    if matches!(status, 401 | 403 | 429) {
                        http_status = Some(status);
                    }
                    let mime = response["mimeType"].as_str().unwrap_or_default();
                    let response_url = response["url"].as_str().unwrap_or_default();
                    let interesting = mime.contains("json")
                        || response_url.contains("graphql")
                        || response_url.contains("/api/v1/");
                    if interesting {
                        if let Some(request_id) = value["params"]["requestId"].as_str() {
                            interesting_requests.insert(request_id.to_string());
                        }
                    }
                }
                if value.get("method").and_then(|v| v.as_str()) == Some("Network.loadingFinished") {
                    if let Some(request_id) = value["params"]["requestId"].as_str() {
                        if interesting_requests.remove(request_id) {
                            let id = next_id;
                            next_id += 1;
                            pending.insert(id, request_id.to_string());
                            ws.send(Message::Text(
                                serde_json::json!({
                                    "id": id,
                                    "method": "Network.getResponseBody",
                                    "params": {"requestId": request_id}
                                })
                                .to_string(),
                            ))?;
                        }
                    }
                }
                if value.get("method").and_then(|v| v.as_str()) == Some("Network.loadingFailed") {
                    if let Some(request_id) = value["params"]["requestId"].as_str() {
                        interesting_requests.remove(request_id);
                    }
                }
                if let Some(id) = value.get("id").and_then(|v| v.as_u64()) {
                    if scroll_request == Some(id) {
                        scroll_request = None;
                        if let Some(dom_page) = value.pointer("/result/result/value").cloned() {
                            if let Some(items) = dom_page.get("items").and_then(|v| v.as_array()) {
                                record_publication_codes(
                                    items,
                                    checkpoint,
                                    &mut checkpoint_reached,
                                    &mut unique_codes,
                                    &mut publication_codes,
                                    batch_size,
                                );
                            }
                            payloads.push(dom_page);
                        }
                        let height = value
                            .pointer("/result/result/value/height")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0);
                        let posts = value
                            .pointer("/result/result/value/posts")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0);
                        let fingerprint = value
                            .pointer("/result/result/value/fingerprint")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string();
                        let grid = (height, posts, fingerprint);
                        if last_grid.as_ref() == Some(&grid) {
                            unchanged_scrolls = unchanged_scrolls.saturating_add(1);
                        } else {
                            unchanged_scrolls = 0;
                            last_grid = Some(grid);
                        }
                        last_activity = Instant::now();
                        continue;
                    }
                    if pending.remove(&id).is_some() {
                        if let Some(body) = value.pointer("/result/body").and_then(|v| v.as_str()) {
                            let decoded = if value
                                .pointer("/result/base64Encoded")
                                .and_then(|v| v.as_bool())
                                == Some(true)
                            {
                                base64::engine::general_purpose::STANDARD
                                    .decode(body)
                                    .ok()
                                    .and_then(|bytes| String::from_utf8(bytes).ok())
                            } else {
                                Some(body.to_string())
                            };
                            if let Some(decoded) = decoded {
                                if let Ok(json) =
                                    serde_json::from_str::<serde_json::Value>(&decoded)
                                {
                                    payloads.push(json);
                                    last_activity = Instant::now();
                                }
                            }
                        }
                    }
                }
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(error))
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(error) => return Err(anyhow!("se perdió la conexión con el navegador: {error}")),
        }
        if loaded
            && pending.is_empty()
            && scroll_request.is_none()
            && last_activity.elapsed() >= Duration::from_secs(2)
        {
            if scrolls >= max_scrolls
                || unchanged_scrolls >= 3
                || (batch_size > 0 && publication_codes.len() >= batch_size)
                || http_status.is_some()
            {
                break;
            }
            let id = next_id;
            next_id += 1;
            scrolls += 1;
            scroll_request = Some(id);
            ws.send(Message::Text(
                serde_json::json!({
                    "id": id,
                    "method": "Runtime.evaluate",
                    "params": {
                        "expression": scroll_expression,
                        "returnByValue": true
                    }
                })
                .to_string(),
            ))?;
            let wheel_id = next_id;
            next_id += 1;
            ws.send(Message::Text(
                serde_json::json!({
                    "id": wheel_id,
                    "method": "Input.dispatchMouseEvent",
                    "params": {"type":"mouseWheel","x":640,"y":650,"deltaX":0,"deltaY":900}
                })
                .to_string(),
            ))?;
            last_activity = Instant::now();
        }
    }
    Ok(CaptureResult {
        payloads,
        publication_codes,
        stalled: batch_size > 0 && unchanged_scrolls >= 3,
        http_status,
        checkpoint_reached,
    })
}

/// Devuelve un resumen DOM sin secretos. Sirve como fallback para metadatos y
/// para detectar bloqueo/login cuando Instagram no emite JSON utilizable.
pub fn page_snapshot(port: u16) -> Result<serde_json::Value> {
    let expression = r#"(() => ({
      url: location.href,
      title: document.title,
      text: (document.body?.innerText || '').slice(0, 12000),
      description: document.querySelector('meta[name="description"]')?.content || '',
      images: Array.from(document.images).slice(0, 80).map(img => ({
        src: (() => {
          const candidates = (img.srcset || '').split(',').map(item => {
            const parts = item.trim().split(/\s+/); const width = parseInt(parts[1] || '0', 10);
            return { url: parts[0] || '', width: Number.isFinite(width) ? width : 0 };
          }).filter(item => item.url);
          candidates.sort((a, b) => b.width - a.width);
          return candidates[0]?.url || img.currentSrc || img.src || '';
        })(), alt: img.alt || '', width: img.naturalWidth || 0,
        height: img.naturalHeight || 0, href: img.closest('a')?.href || ''
      })),
      highlights: Array.from(document.querySelectorAll('a[href*="/stories/highlights/"]')).map(a => ({
        href: a.href, title: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 80)
      }))
    }))()"#;
    let result = cdp_call(
        port,
        "Runtime.evaluate",
        serde_json::json!({
            "expression": expression, "returnByValue": true
        }),
    )?;
    result
        .pointer("/result/value")
        .cloned()
        .ok_or_else(|| anyhow!("Instagram no produjo un DOM utilizable"))
}

/// Lee el usuario visible exclusivamente desde el DOM del navegador dedicado.
/// No extrae ni copia cookies y no ejecuta peticiones API por JavaScript.
pub fn current_user_via_page(port: u16) -> Result<Option<String>> {
    let expression = r#"(() => {
      if (location.pathname.startsWith('/accounts/')) return null;
      const excluded = new Set(['accounts','explore','reels','direct','stories','about','legal','web']);
      for (const img of Array.from(document.images)) {
        const match = (img.alt || '').match(/^(.+?)(?:'s|’s) profile picture$/i);
        if (match && /^[A-Za-z0-9._]{1,30}$/.test(match[1])) return match[1];
      }
      for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
        const parts = new URL(anchor.href, location.href).pathname.split('/').filter(Boolean);
        if (parts.length === 1 && /^[A-Za-z0-9._]{1,30}$/.test(parts[0]) && !excluded.has(parts[0])) {
          const label = (anchor.getAttribute('aria-label') || anchor.textContent || '').toLowerCase();
          if (label.includes('profile') || label.includes('perfil')) return parts[0];
        }
      }
      return null;
    })()"#;
    let result = cdp_call(
        port,
        "Runtime.evaluate",
        serde_json::json!({
            "expression": expression, "returnByValue": true
        }),
    )?;
    Ok(result
        .pointer("/result/value")
        .and_then(|value| value.as_str())
        .map(str::to_string))
}

/// GET HTTP mínimo que parsea la respuesta JSON.
fn http_get_json(url: &str) -> Result<serde_json::Value> {
    // Parser HTTP mínimo, robusto contra keep-alive: lee los headers y luego
    // exactamente Content-Length bytes (read_to_end colgaría esperando EOF,
    // lo que Windows reporta como timeout os error 10060).
    fn read_line(stream: &mut std::net::TcpStream) -> Result<String> {
        let mut line = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            let n = stream.read(&mut byte)?;
            if n == 0 {
                break;
            }
            if byte[0] == b'\n' {
                break;
            }
            line.push(byte[0]);
        }
        Ok(String::from_utf8_lossy(&line)
            .trim_end_matches('\r')
            .to_string())
    }

    let host_port_end = url.find("://").map(|i| i + 3).unwrap_or(0);
    let rest = &url[host_port_end..];
    let slash = rest.find('/').ok_or_else(|| anyhow!("URL inválida"))?;
    let host_port = &rest[..slash];
    let path = &rest[slash..];

    let mut stream = std::net::TcpStream::connect(host_port)
        .with_context(|| format!("no se pudo conectar a {host_port}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(8)))?;
    stream.set_write_timeout(Some(Duration::from_secs(8)))?;
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: {host_port}\r\nConnection: close\r\n\r\n"
    )?;
    stream.flush()?;

    // Headers
    let mut content_length: Option<usize> = None;
    loop {
        let line = read_line(&mut stream)?;
        if line.is_empty() {
            break; // fin de headers
        }
        if let Some(rest) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            content_length = rest.trim().parse().ok();
        }
    }
    let len = content_length.ok_or_else(|| anyhow!("respuesta sin Content-Length"))?;

    // Cuerpo exacto
    let mut body = vec![0u8; len];
    let mut read = 0usize;
    while read < len {
        let n = stream.read(&mut body[read..])?;
        if n == 0 {
            break;
        }
        read += n;
    }
    body.truncate(read);
    serde_json::from_slice(&body).with_context(|| "JSON inválido en respuesta HTTP")
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

#[cfg(test)]
mod tests {
    use super::record_publication_codes;
    use std::collections::HashSet;

    #[test]
    fn resume_skips_through_checkpoint_and_caps_unique_publications() {
        let items = vec![
            serde_json::json!({"shortcode":"A"}),
            serde_json::json!({"shortcode":"B"}),
            serde_json::json!({"shortcode":"C"}),
            serde_json::json!({"shortcode":"C"}),
            serde_json::json!({"shortcode":"D"}),
        ];
        let mut reached = false;
        let mut unique = HashSet::new();
        let mut out = Vec::new();
        record_publication_codes(&items, Some("B"), &mut reached, &mut unique, &mut out, 2);
        assert!(reached);
        assert_eq!(out, ["C", "D"]);
    }
}
