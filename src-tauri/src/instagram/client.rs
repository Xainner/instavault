use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, ACCEPT_LANGUAGE};
use reqwest::Client;
use std::time::Duration;

/// Cliente sin estado para descargar bytes de CDN. No contiene cookies,
/// CSRF, identificadores de cuenta ni headers de la API interna.
#[derive(Clone)]
pub struct IgClient {
    http: Client,
}

impl IgClient {
    pub fn new() -> anyhow::Result<Self> {
        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static("*/*"));
        headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.9"));
        let http = Client::builder()
            .default_headers(headers)
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36")
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(15))
            .build()?;
        Ok(Self { http })
    }

    pub fn http(&self) -> &Client {
        &self.http
    }
}

#[cfg(test)]
mod tests {
    use super::IgClient;

    #[test]
    fn media_client_builds_without_credentials() {
        assert!(IgClient::new().is_ok());
    }
}
