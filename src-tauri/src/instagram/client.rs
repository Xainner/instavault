use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, ACCEPT_LANGUAGE, COOKIE};
use reqwest::Client;
use serde::de::DeserializeOwned;
use std::collections::HashMap;
use std::time::Duration;

/// Header CSRF requerido por la API; reqwest no expone constante propia.
const X_CSRF_TOKEN: HeaderName = HeaderName::from_static("x-csrf-token");

/// App-ID usado por la app móvil de Instagram para la API privada.
pub const IG_APP_ID: &str = "936619743392459";

/// User-Agent móvil (Android). CRÍTICO: la API rechaza UAs de navegador.
const ANDROID_UA: &str = concat!(
    "Instagram 289.0.0.23.291 Android (30/11; 420dpi; 1080x2340; ",
    "samsung; SM-G991B; o1s; exynos2100; en_US; 493057863513416)"
);

/// Una sesión autenticada: guarda las cookies en crudo (desde el navegador)
/// y los campos derivados necesarios para las llamadas.
#[derive(Debug, Clone)]
pub struct Session {
    pub cookie_header: String,
    pub sessionid: String,
    pub csrftoken: String,
    pub ds_user_id: String,
}

impl Session {
    /// Construye la sesión desde un header de cookies crudo, p.ej.
    /// `sessionid=abc...; csrftoken=xyz...; ds_user_id=123; ig_did=...`
    pub fn from_cookie_header(raw: &str) -> Self {
        let map = parse_cookies(raw);
        let csrftoken = map.get("csrftoken").cloned().unwrap_or_default();
        let ds_user_id = map.get("ds_user_id").cloned().unwrap_or_default();
        let sessionid = map.get("sessionid").cloned().unwrap_or_default();
        let cookie_header =
            format!("sessionid={sessionid}; csrftoken={csrftoken}; ds_user_id={ds_user_id};");
        Session {
            cookie_header,
            sessionid,
            csrftoken,
            ds_user_id,
        }
    }

    /// Válida mínimo: necesita sessionid y csrftoken no vacíos.
    pub fn is_minimally_valid(&self) -> bool {
        !self.sessionid.is_empty() && !self.csrftoken.is_empty()
    }
}

fn parse_cookies(raw: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for part in raw.split(';') {
        let part = part.trim();
        if let Some((k, v)) = part.split_once('=') {
            map.insert(k.trim().to_string(), v.trim().to_string());
        }
    }
    map
}

/// Cliente HTTP reutilizable. El `Client` de reqwest es Sync+Clone; se crea una
/// vez y se comparte. Las cookies se envían por request vía header manual.
#[derive(Clone)]
pub struct IgClient {
    http: Client,
}

impl IgClient {
    pub fn new() -> anyhow::Result<Self> {
        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static("*/*"));
        headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.9"));
        headers.insert("X-IG-App-ID", HeaderValue::from_static(IG_APP_ID));
        headers.insert(
            "X-Requested-With",
            HeaderValue::from_static("XMLHttpRequest"),
        );
        headers.insert("X-IG-Connection-Type", HeaderValue::from_static("WIFI"));
        let http = Client::builder()
            .default_headers(headers)
            .user_agent(ANDROID_UA)
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(15))
            .build()?;
        Ok(IgClient { http })
    }

    pub fn http(&self) -> &Client {
        &self.http
    }

    /// GET con sesión; devuelve JSON tipado.
    pub async fn get_json<T: DeserializeOwned>(
        &self,
        url: &str,
        session: &Session,
    ) -> anyhow::Result<T> {
        let body = self.get_bytes(url, session).await?;
        Ok(serde_json::from_slice(&body)?)
    }

    /// GET con sesión; devuelve bytes crudos (para descarga de media se usa una
    /// variante sin JSON).
    pub async fn get_bytes(&self, url: &str, session: &Session) -> anyhow::Result<Vec<u8>> {
        let mut req = self.http.get(url);
        let mut headers = HeaderMap::new();
        headers.insert(COOKIE, HeaderValue::from_str(&session.cookie_header)?);
        if !session.csrftoken.is_empty() {
            headers.insert(X_CSRF_TOKEN, HeaderValue::from_str(&session.csrftoken)?);
        }
        req = req.headers(headers);
        let resp = req.send().await?;
        let status = resp.status();
        let bytes = resp.bytes().await?;
        if !status.is_success() {
            let snippet = String::from_utf8_lossy(&bytes[..bytes.len().min(300)]).to_string();
            anyhow::bail!("HTTP {status}: {snippet}");
        }
        Ok(bytes.to_vec())
    }
}
