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

    /// Lanza el navegador para el login asistido (fuerza logout primero).
    /// Siempre visible: el usuario tiene que interactuar para loguearse.
    pub fn launch() -> Result<Self> {
        Self::launch_with_url("https://www.instagram.com/accounts/logout/", false)
    }

    /// Lanza el navegador como motor de API (home; conserva la sesión del perfil).
    /// Instagram bloquea (429) los clientes HTTP externos, así que todas las
    /// llamadas pasan por el propio Chrome vía CDP. Corre en headless: es
    /// fire-and-forget y no debe mostrar ventanas al usuario.
    pub fn launch_api() -> Result<Self> {
        Self::launch_with_url("https://www.instagram.com/", true)
    }

    fn launch_with_url(start_url: &str, headless: bool) -> Result<Self> {
        let exe = find_chromium()?;
        let port = free_port()?;
        let profile_dir = profile_dir()?;
        std::fs::create_dir_all(&profile_dir).context("no se pudo crear el perfil del navegador")?;

        let mut args: Vec<String> = vec![
            format!("--remote-debugging-port={port}"),
            format!("--user-data-dir={}", profile_dir.display()),
            "--no-first-run".into(),
            "--no-default-browser-check".into(),
        ];
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

        Ok(CdpSession { child, port })
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
            Err(anyhow!("el navegador no abrió el puerto de depuración: {last_err}"))
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

    /// Puerto CDP en uso.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Cierra el navegador ordenadamente.
    pub fn shutdown(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
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

/// Ejecuta el fetch de validación y devuelve el texto crudo (diagnóstico).
#[doc(hidden)]
pub fn raw_fetch_for_test(port: u16) -> Result<String> {
    let ws_url = page_ws_url(port)?;
    let (mut ws, _resp) = tungstenite::client::connect(&ws_url)
        .map_err(|e| anyhow!("no se pudo conectar al CDP: {e}"))?;
    let expr = r#"(async () => {
        const res = await fetch('/api/v1/accounts/current_user/?edit=true', {
            headers: {'X-Requested-With':'XMLHttpRequest','X-IG-App-ID':'1217981644879628'},
            credentials: 'include'
        });
        return res.status + ' :: ' + (await res.text()).slice(0, 200);
    })()"#;
    use tungstenite::Message;
    ws.send(Message::Text(
        serde_json::json!({
            "id": 1,
            "method": "Runtime.evaluate",
            "params": {"expression": expr, "returnByValue": true, "awaitPromise": true}
        })
        .to_string(),
    ))
    .map_err(|e| anyhow!("error enviando comando CDP: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if Instant::now() >= deadline {
            return Err(anyhow!("timeout"));
        }
        match ws.read() {
            Ok(Message::Text(t)) => {
                let v: serde_json::Value = serde_json::from_str(&t)
                    .map_err(|e| anyhow!("CDP devolvió JSON inválido: {e}"))?;
                if v.get("id").and_then(|i| i.as_u64()) == Some(1) {
                    return Ok(v
                        .pointer("/result/result/value")
                        .and_then(|x| x.as_str())
                        .unwrap_or("?")
                        .to_string());
                }
            }
            Ok(_) => {}
            Err(e) => return Err(anyhow!("error leyendo del CDP: {e}")),
        }
    }
}

/// Ejecuta un GET relativo del API (p. ej. `/api/v1/users/web_profile_info/?username=x`)
/// DESDE la página de Instagram y devuelve el JSON parseado.
/// Es el motor de todas las consultas: Instagram bloquea (429) los clientes
/// HTTP externos, pero responde bien a los fetch del propio navegador.
pub fn api_fetch_via_page(port: u16, path: &str) -> Result<serde_json::Value> {
    let ws_url = page_ws_url(port)?;
    let (mut ws, _resp) = tungstenite::client::connect(&ws_url)
        .map_err(|e| anyhow!("no se pudo conectar al CDP: {e}"))?;
    // Extrae el username del path para el fallback (`/{username}/`).
    let user_json = path
        .split("username=")
        .nth(1)
        .unwrap_or("")
        .split('&')
        .next()
        .unwrap_or("")
        .to_string();
    let expr = format!(
        r#"(async () => {{
            const tryPath = async (path, tries) => {{
                for (let i = 0; i < tries; i++) {{
                    try {{
                        const res = await fetch(path, {{
                            headers: {{'X-Requested-With':'XMLHttpRequest','X-IG-App-ID':'1217981644879628'}},
                            credentials: 'include'
                        }});
                        const t = await res.text();
                        if (res.status === 429 || res.status === 400) {{
                            await new Promise(r => setTimeout(r, 1500 * (i + 1)));
                            continue;
                        }}
                        if (res.status === 403) return {{ok:false, why:'forbidden'}};
                        if (res.status === 404) return {{ok:false, why:'notFound'}};
                        if (res.status >= 400) return {{ok:false, why:'http'+res.status}};
                        try {{ const j = JSON.parse(t); return {{ok:true, v:j}}; }}
                        catch(e) {{ return {{ok:false, why:'html'}}; }}
                    }} catch(e) {{ return {{ok:false, why:'netErr'}}; }}
                }}
                return {{ok:false, why:'rateLimit'}};
            }};
            try {{
                const r = await tryPath({path:?}, 3);
                if (r.ok) return r;
                // El API puede devolver HTML si la página está en login/2FA.
                // Fallback: parsear la propia pagina del perfil.
                if (r.why === 'html' || r.why === 'http400' || r.why === 'http401' || r.why === 'rateLimit') {{
                    const u = {user_json:?};
                    try {{
                        const res = await fetch('/' + u + '/', {{
                            headers: {{'X-Requested-With':'XMLHttpRequest','X-IG-App-ID':'1217981644879628'}},
                            credentials: 'include'
                        }});
                        const t = await res.text();
                        if (res.status === 404) return {{ok:false, why:'notFound'}};
                        const m = t.match(/"username":"([^"]{{2,30}})"/);
                        const mid = t.match(/"id":"([0-9]+)"/);
if (m) {{
                    // null = desconocido: el upsert con COALESCE no pisa datos reales.
                    // (si no hay id numerico, id=null: usar el username romperia la sync de feed)
                    return {{ok:true, v:{{data:{{user:{{id: mid ? mid[1] : null, username: m[1], full_name: null, biography: null, profile_pic_url_hd: null, is_private: null, is_verified: null, edge_followed_by: null, edge_follow: null, edge_owner_to_timeline_media: null}}}}}}}};
                }}
                        return {{ok:false, why:'noUsername'}};
                    }} catch(e) {{ return {{ok:false, why:'err2'}}; }}
                }}
                return r;
            }} catch(e) {{ return {{ok:false, why:'scriptErr:' + e}}; }}
        }})()"#
    );
    use tungstenite::Message;
    ws.send(Message::Text(
        serde_json::json!({
            "id": 1,
            "method": "Runtime.evaluate",
            "params": {"expression": expr, "returnByValue": true, "awaitPromise": true}
        })
        .to_string(),
    ))
    .map_err(|e| anyhow!("error enviando comando CDP: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(25);
    loop {
        if Instant::now() >= deadline {
            return Err(anyhow!("timeout esperando respuesta del API"));
        }
        match ws.read() {
            Ok(Message::Text(t)) => {
                let v: serde_json::Value = serde_json::from_str(&t)
                    .map_err(|e| anyhow!("CDP devolvió JSON inválido: {e}"))?;
                if v.get("id").and_then(|i| i.as_u64()) != Some(1) {
                    continue;
                }
                if v.get("error").is_some() || v.pointer("/result/exceptionDetails").is_some() {
                    std::thread::sleep(Duration::from_millis(500));
                    return api_fetch_via_page(port, path);
                }
                let val = v
                    .pointer("/result/result/value")
                    .ok_or_else(|| anyhow!("API sin resultado"))?;
                let ok = val.get("ok").and_then(|o| o.as_bool()).unwrap_or(false);
                let why = val.get("why").and_then(|m| m.as_str()).unwrap_or("?");
                if !ok {
                    let label = match why {
                        "rateLimit" => "Instagram limitó la petición (429); espera un momento e inténtalo de nuevo".to_string(),
                        "forbidden" => "Instagram rechazó la petición (403)".to_string(),
                        "notFound" => "perfil no encontrado (¿el usuario existe?)".to_string(),
                        "html" => "Instagram devolvió HTML en vez de JSON (¿sesión expirada?)".to_string(),
                        "netErr" => "error de red del navegador".to_string(),
                        other => format!("Instagram respondió: {other}"),
                    };
                    return Err(anyhow!(label));
                }
                return Ok(val.get("v").cloned().unwrap_or(serde_json::Value::Null));
            }
            Ok(_) => {}
            Err(e) => return Err(anyhow!("error leyendo del CDP: {e}")),
        }
    }
}

/// Navega la página actual a la home de Instagram y espera a que cargue.
/// Necesario antes de usar el motor API: el navegador reutilizado puede
/// estar en login/logout/2FA, donde los fetch redirigen a login.
pub fn navigate_home(port: u16) -> Result<()> {
    let ws_url = page_ws_url(port)?;
    let (mut ws, _resp) = tungstenite::client::connect(&ws_url)
        .map_err(|e| anyhow!("no se pudo conectar al CDP: {e}"))?;
    use tungstenite::Message;
    ws.send(Message::Text(
        serde_json::json!({
            "id": 1,
            "method": "Page.navigate",
            "params": {"url": "https://www.instagram.com/"}
        })
        .to_string(),
    ))
    .map_err(|e| anyhow!("error navegando: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if Instant::now() >= deadline {
            return Err(anyhow!("timeout navegando a la home"));
        }
        match ws.read() {
            Ok(Message::Text(t)) => {
                let v: serde_json::Value = serde_json::from_str(&t)
                    .map_err(|e| anyhow!("CDP devolvió JSON inválido: {e}"))?;
                if v.get("id").and_then(|i| i.as_u64()) == Some(1) {
                    break;
                }
            }
            Ok(_) => {}
            Err(e) => return Err(anyhow!("error leyendo del CDP: {e}")),
        }
    }
    // Deja que la home cargue y valide la sesión.
    std::thread::sleep(Duration::from_secs(6));
    Ok(())
}

/// Navega la página actual a una URL arbitraria de Instagram.
/// A diferencia de `navigate_home`, no duerme: el llamador decide cuánto
/// esperar a que la página renderice.
pub fn navigate_to(port: u16, url: &str) -> Result<()> {
    let ws_url = page_ws_url(port)?;
    let (mut ws, _resp) = tungstenite::client::connect(&ws_url)
        .map_err(|e| anyhow!("no se pudo conectar al CDP: {e}"))?;
    use tungstenite::Message;
    ws.send(Message::Text(
        serde_json::json!({
            "id": 1,
            "method": "Page.navigate",
            "params": {"url": url}
        })
        .to_string(),
    ))
    .map_err(|e| anyhow!("error navegando: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if Instant::now() >= deadline {
            return Err(anyhow!("timeout navegando a {url}"));
        }
        match ws.read() {
            Ok(Message::Text(t)) => {
                let v: serde_json::Value = serde_json::from_str(&t)
                    .map_err(|e| anyhow!("CDP devolvió JSON inválido: {e}"))?;
                if v.get("id").and_then(|i| i.as_u64()) == Some(1) {
                    return Ok(());
                }
            }
            Ok(_) => {}
            Err(e) => return Err(anyhow!("error leyendo del CDP: {e}")),
        }
    }
}

/// Extrae los highlight reels de la página de perfil renderizada
/// (`a[href*="/stories/highlights/{id}/"]`). El endpoint mobile
/// `highlights_tray` está caído; la página los muestra igual (aunque el
/// navegador esté logged-out), así que el DOM es la fuente confiable.
pub fn extract_highlight_reels(port: u16) -> Result<Vec<super::models::HighlightReel>> {
    let ws_url = page_ws_url(port)?;
    let (mut ws, _resp) = tungstenite::client::connect(&ws_url)
        .map_err(|e| anyhow!("no se pudo conectar al CDP: {e}"))?;
    let expr = r#"(() => {
        const out = [];
        document.querySelectorAll('a[href*="/stories/highlights/"]').forEach(a => {
            const m = a.href.match(/\/stories\/highlights\/(\d+)/);
            if (!m) return;
            const title = (a.innerText || a.getAttribute('aria-label') || '').trim();
            if (!out.some(o => o.id === m[1])) {
                out.push({ id: m[1], title: title.slice(0, 80) });
            }
        });
        return out;
    })()"#;
    use tungstenite::Message;
    ws.send(Message::Text(
        serde_json::json!({
            "id": 1,
            "method": "Runtime.evaluate",
            "params": {"expression": expr, "returnByValue": true}
        })
        .to_string(),
    ))
    .map_err(|e| anyhow!("error enviando comando CDP: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(25);
    loop {
        if Instant::now() >= deadline {
            return Err(anyhow!("timeout esperando los highlights del DOM"));
        }
        match ws.read() {
            Ok(Message::Text(t)) => {
                let v: serde_json::Value = serde_json::from_str(&t)
                    .map_err(|e| anyhow!("CDP devolvió JSON inválido: {e}"))?;
                if v.get("id").and_then(|i| i.as_u64()) != Some(1) {
                    continue;
                }
                let val = v
                    .pointer("/result/result/value")
                    .ok_or_else(|| anyhow!("DOM sin resultado"))?;
                let reels: Vec<super::models::HighlightReel> = serde_json::from_value(val.clone())
                    .map_err(|e| anyhow!("parseo de highlights: {e}"))?;
                return Ok(reels);
            }
            Ok(_) => {}
            Err(e) => return Err(anyhow!("error leyendo del CDP: {e}")),
        }
    }
}

/// GET HTTP mínimo que parsea la respuesta JSON (expuesto para diagnóstico).
#[doc(hidden)]
pub fn http_get_json_for_test(url: &str) -> Result<serde_json::Value> {
    http_get_json(url)
}

/// Pide current_user a la página misma (fetch desde instagram.com).
/// Devuelve el username real si la sesión del navegador es válida.
/// Estrategia: primero `/web/api/v1` (API nueva de la web, que devuelve JSON);
/// si no, parsea el HTML de `/accounts/edit/` (página del propio perfil).
/// La API vieja (`/api/v1`) ya devuelve HTML en la web actual, no JSON.
pub fn current_user_via_page(port: u16) -> Result<Option<String>> {
    let ws_url = page_ws_url(port)?;
    let (mut ws, _resp) = tungstenite::client::connect(&ws_url)
        .map_err(|e| anyhow!("no se pudo conectar al CDP: {e}"))?;
    // JS con try/catch GLOBAL: siempre devuelve {ok:...}, nunca lanza.
    let expr = r#"(async () => {
        try {
            async function tryFetch(url) {
                try {
                    const res = await fetch(url, {
                        headers: {'X-Requested-With':'XMLHttpRequest','X-IG-App-ID':'1217981644879628'},
                        credentials: 'include'
                    });
                    const t = await res.text();
                    if (res.status === 401) return {ok:false, why:'noAuth'};
                    try {
                        const j = JSON.parse(t);
                        if (j.user && j.user.username) return {ok:true, username:j.user.username};
                        if (j.username) return {ok:true, username:j.username};
                        return {ok:false, why:'noJson'};
                    } catch(e) { return {ok:false, why:'html'}; }
                } catch(e) { return {ok:false, why:'err'}; }
            }
            // 1) API web nueva
            let r = await tryFetch('/web/api/v1/accounts/current_user/?edit=true');
            if (r.ok) return r;
            // 2) API vieja (algunos entornos aun la sirven)
            r = await tryFetch('/api/v1/accounts/current_user/?edit=true');
            if (r.ok) return r;
            // 3) Pagina del propio perfil: extrae el username de los datos embebidos
            try {
                const res = await fetch('/accounts/edit/', {credentials:'include'});
                const t = await res.text();
                const m = t.match(/"username":"([^"]{3,30})"/);
                if (m) {
                    const login = t.includes('password') && t.includes('username');
                    return login ? {ok:false, why:'loginPage'} : {ok:true, username:m[1]};
                }
                return {ok:false, why:'noUsername'};
            } catch(e) { return {ok:false, why:'err2'}; }
        } catch(e) { return {ok:false, why:'scriptErr:' + e}; }
    })()"#;
    use tungstenite::Message;
    ws.send(Message::Text(
        serde_json::json!({
            "id": 1,
            "method": "Runtime.evaluate",
            "params": {"expression": expr, "returnByValue": true, "awaitPromise": true}
        })
        .to_string(),
    ))
    .map_err(|e| anyhow!("error enviando comando CDP: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(25);
    loop {
        if Instant::now() >= deadline {
            return Err(anyhow!("timeout esperando current_user"));
        }
        match ws.read() {
            Ok(Message::Text(t)) => {
                let v: serde_json::Value = serde_json::from_str(&t)
                    .map_err(|e| anyhow!("CDP devolvió JSON inválido: {e}"))?;
                if v.get("id").and_then(|i| i.as_u64()) != Some(1) {
                    continue;
                }
                // Contexto invalidado (la página navegó durante el fetch):
                // reconecta y reintenta en vez de fallar.
                if v.get("error").is_some()
                    || v.pointer("/result/exceptionDetails").is_some()
                {
                    std::thread::sleep(Duration::from_millis(500));
                    return current_user_via_page(port);
                }
                let val = v
                    .pointer("/result/result/value")
                    .ok_or_else(|| {
                        anyhow!("current_user sin resultado: {}", t.chars().take(120).collect::<String>())
                    })?;
                let ok = val.get("ok").and_then(|o| o.as_bool()).unwrap_or(false);
                let why = val.get("why").and_then(|m| m.as_str()).unwrap_or("?");
                if !ok {
                    return Err(anyhow!(
                        "sesión del navegador no válida ({why}); vuelve a iniciar sesión en la ventana"
                    ));
                }
                return Ok(val
                    .get("username")
                    .and_then(|u| u.as_str())
                    .map(|s| s.to_string()));
            }
            Ok(_) => {}
            Err(e) => return Err(anyhow!("error leyendo del CDP: {e}")),
        }
    }
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
        Ok(String::from_utf8_lossy(&line).trim_end_matches('\r').to_string())
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
