use super::api;
use super::cdp_login::{capture_page_payloads, page_snapshot, CaptureResult, CdpSession};
use super::models::{
    Candidate, CaptionWrap, ExtractedMedia, FeedItem, ImageVersions, ProfileRow, SyncStatus,
    VideoVersion, WebProfileUser,
};
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessMode {
    PublicAnonymous,
    PrivateExplicit,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
}

impl ProviderError {
    fn new(code: &'static str, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
        }
    }
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

pub type ProviderResult<T> = Result<T, ProviderError>;

pub struct WebProvider {
    browser: Arc<Mutex<Option<CdpSession>>>,
    mode: AccessMode,
}

pub struct ProviderSyncBatch {
    pub media: Vec<ExtractedMedia>,
    pub publication_codes: Vec<String>,
    pub status: SyncStatus,
    pub stop_reason: Option<String>,
}

impl WebProvider {
    pub fn public(browser: Arc<Mutex<Option<CdpSession>>>) -> Self {
        Self {
            browser,
            mode: AccessMode::PublicAnonymous,
        }
    }

    pub fn private(browser: Arc<Mutex<Option<CdpSession>>>) -> Self {
        Self {
            browser,
            mode: AccessMode::PrivateExplicit,
        }
    }

    fn ensure_browser<'a>(
        &self,
        guard: &'a mut Option<CdpSession>,
    ) -> ProviderResult<&'a mut CdpSession> {
        if guard.as_mut().map(|browser| browser.is_alive()) != Some(true) {
            let browser = match self.mode {
                AccessMode::PublicAnonymous => CdpSession::launch_public_api(),
                AccessMode::PrivateExplicit => CdpSession::launch_api(),
            }
            .map_err(|error| {
                ProviderError::new(
                    "network",
                    format!("No se pudo abrir el navegador: {error:#}"),
                    true,
                )
            })?;
            browser.wait_ready().map_err(|error| {
                ProviderError::new(
                    "network",
                    format!("El navegador no quedó listo: {error:#}"),
                    true,
                )
            })?;
            *guard = Some(browser);
        }
        Ok(guard.as_mut().expect("browser initialized"))
    }

    fn capture(
        &self,
        url: &str,
        batch_size: usize,
        checkpoint: Option<&str>,
        cancelled: Option<&std::sync::atomic::AtomicBool>,
    ) -> ProviderResult<(CaptureResult, Value)> {
        let mut guard = self.browser.lock().map_err(|_| {
            ProviderError::new("network", "El motor de Instagram está ocupado.", true)
        })?;
        let browser = self.ensure_browser(&mut guard)?;
        let timeout = Duration::from_secs((20 + batch_size as u64 * 2).clamp(20, 100));
        let capture = capture_page_payloads(
            browser.port(),
            url,
            timeout,
            batch_size,
            checkpoint,
            cancelled,
        )
        .map_err(|error| {
            ProviderError::new(
                "network",
                format!("No se pudo consultar Instagram: {error:#}"),
                true,
            )
        })?;
        let snapshot = page_snapshot(browser.port()).map_err(|error| {
            ProviderError::new(
                "provider_changed",
                format!("Instagram no produjo una página utilizable: {error:#}"),
                false,
            )
        })?;
        Ok((capture, snapshot))
    }

    pub fn lookup_profile(&self, username: &str) -> ProviderResult<ProfileRow> {
        let username = sanitize_username(username)?;
        let url = format!("https://www.instagram.com/{username}/");
        let (capture, snapshot) = self.capture(&url, 0, None, None)?;
        detect_denial(&snapshot, self.mode)?;
        let user = capture
            .payloads
            .iter()
            .find_map(|payload| find_profile(payload, &username));
        if let Some(user) = user {
            return Ok(profile_row(user));
        }
        if let Some(profile) = profile_from_snapshot(&snapshot, &username) {
            return Ok(profile);
        }
        if snapshot["url"]
            .as_str()
            .unwrap_or_default()
            .contains("/accounts/login")
        {
            return Err(denied(self.mode));
        }
        Err(ProviderError::new(
            if self.mode == AccessMode::PublicAnonymous {
                "public_blocked"
            } else {
                "provider_changed"
            },
            if self.mode == AccessMode::PublicAnonymous {
                "Instagram no entregó los datos públicos sin iniciar sesión. No se usaron tus cookies."
            } else {
                "Instagram cambió la estructura de la página y no se pudo leer el perfil."
            },
            false,
        ))
    }

    pub fn sync_media_batch(
        &self,
        username: &str,
        kind: &str,
        batch_size: usize,
        checkpoint: Option<&str>,
        cancelled: Option<&std::sync::atomic::AtomicBool>,
    ) -> ProviderResult<ProviderSyncBatch> {
        let username = sanitize_username(username)?;
        let url = match kind {
            "post" => format!("https://www.instagram.com/{username}/"),
            "story" => format!("https://www.instagram.com/stories/{username}/"),
            "highlight" => format!("https://www.instagram.com/{username}/"),
            _ => {
                return Err(ProviderError::new(
                    "provider_changed",
                    "Tipo de contenido inválido.",
                    false,
                ))
            }
        };
        let crawl_size = if kind == "post" {
            batch_size.clamp(1, 60)
        } else {
            1
        };
        let (mut capture, snapshot) = self.capture(&url, crawl_size, checkpoint, cancelled)?;
        if kind == "post" && !snapshot_matches_profile(&snapshot, &username) {
            return Err(ProviderError::new(
                if self.mode == AccessMode::PublicAnonymous {
                    "public_blocked"
                } else {
                    "provider_changed"
                },
                "Instagram no dejó el navegador en el perfil solicitado; no se guardó ningún contenido.",
                false,
            ));
        }
        let mut snapshots = vec![snapshot];
        // Los highlights sólo se consultan al pulsar sincronizar. Se limita la
        // acción para evitar paginación silenciosa y actividad innecesaria.
        if kind == "highlight" {
            let hrefs: Vec<String> = snapshots[0]["highlights"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|item| item["href"].as_str().map(str::to_string))
                .collect::<HashSet<_>>()
                .into_iter()
                .take(5)
                .collect();
            for href in hrefs {
                let (page_capture, page_snapshot) = self.capture(&href, 1, None, cancelled)?;
                capture.payloads.extend(page_capture.payloads);
                snapshots.push(page_snapshot);
            }
        }
        let mut media = Vec::new();
        for payload in &capture.payloads {
            collect_media(payload, kind, &username, &mut media);
        }
        if kind == "post" {
            collect_dom_images(&snapshots[0], kind, &mut media);
        } else if kind == "highlight" {
            for snapshot in &snapshots[1..] {
                collect_dom_images(snapshot, kind, &mut media);
            }
        }
        if kind == "post" && self.mode == AccessMode::PrivateExplicit {
            let allowed: HashSet<&str> = capture
                .publication_codes
                .iter()
                .map(String::as_str)
                .collect();
            let detail_codes = dom_detail_codes(&capture.payloads)
                .into_iter()
                .filter(|code| allowed.contains(code.as_str()))
                .collect::<Vec<_>>();
            for code in detail_codes {
                if cancelled
                    .map(|flag| flag.load(std::sync::atomic::Ordering::Relaxed))
                    .unwrap_or(false)
                {
                    break;
                }
                let detail_url = format!("https://www.instagram.com/p/{code}/");
                let (detail, detail_snapshot) = self.capture(&detail_url, 0, None, cancelled)?;
                let mut detailed = Vec::new();
                for payload in &detail.payloads {
                    collect_media(payload, kind, &username, &mut detailed);
                }
                collect_dom_images(&detail_snapshot, kind, &mut detailed);
                if detailed.iter().any(|item| item.quality_verified) || detailed.len() > 1 {
                    media.retain(|item| item.publication_code.as_deref() != Some(code.as_str()));
                    media.extend(detailed);
                }
            }
        }
        let mut seen = HashSet::new();
        media.retain(|item| seen.insert(item.media_id.clone()));
        if kind == "post" {
            // La cuadrícula DOM del perfil solicitado es la frontera de
            // confianza. Las respuestas JSON también incluyen anuncios,
            // sugerencias y actividad de otras cuentas; nunca pueden agregar
            // por sí solas una publicación al lote.
            let mut unique = HashSet::new();
            capture
                .publication_codes
                .retain(|code| unique.insert(code.clone()));
            capture.publication_codes.truncate(crawl_size);
            retain_grid_media(&mut media, &capture.publication_codes);
        }
        let explicitly_empty = snapshot_text_indicates_empty(&snapshots[0]);
        let terminal = pagination_terminal(&capture.payloads);
        let anonymous_wall = snapshot_indicates_login_wall(&snapshots[0]);
        if self.mode == AccessMode::PrivateExplicit
            && snapshots[0]["url"]
                .as_str()
                .unwrap_or_default()
                .contains("/accounts/login")
        {
            return Err(denied(self.mode));
        }
        let denial = snapshot_sync_denial(&snapshots[0]);
        let (status, stop_reason) = if cancelled
            .map(|flag| flag.load(std::sync::atomic::Ordering::Relaxed))
            .unwrap_or(false)
        {
            (
                SyncStatus::Cancelled,
                Some("Sincronización cancelada.".to_string()),
            )
        } else if let Some((status, reason)) = denial {
            (status, Some(reason))
        } else if capture.http_status == Some(429) {
            (
                SyncStatus::RateLimited,
                Some("Instagram limitó temporalmente las consultas.".to_string()),
            )
        } else if matches!(capture.http_status, Some(401) | Some(403)) {
            if self.mode == AccessMode::PublicAnonymous {
                (
                    SyncStatus::AnonymousLimit,
                    Some("Instagram exige sesión para continuar este perfil público.".into()),
                )
            } else {
                (
                    SyncStatus::Stalled,
                    Some("Instagram rechazó la sesión dedicada; reconecta la cuenta.".into()),
                )
            }
        } else if explicitly_empty || terminal == Some(false) {
            (SyncStatus::Complete, None)
        } else if capture.publication_codes.len() >= crawl_size {
            (SyncStatus::MoreAvailable, None)
        } else if self.mode == AccessMode::PublicAnonymous && (anonymous_wall || capture.stalled) {
            (
                SyncStatus::AnonymousLimit,
                Some(format!(
                    "Instagram limitó el acceso anónimo después de {} publicaciones.",
                    capture.publication_codes.len()
                )),
            )
        } else {
            (
                SyncStatus::Stalled,
                Some(
                    "No se pudo verificar el final del perfil; el avance quedó guardado."
                        .to_string(),
                ),
            )
        };
        Ok(ProviderSyncBatch {
            media,
            publication_codes: capture.publication_codes,
            status,
            stop_reason,
        })
    }

    pub fn sync_media(&self, username: &str, kind: &str) -> ProviderResult<Vec<ExtractedMedia>> {
        self.sync_media_batch(username, kind, 1, None, None)
            .map(|batch| batch.media)
    }
}

fn snapshot_matches_profile(snapshot: &Value, username: &str) -> bool {
    let Some(url) = snapshot["url"].as_str() else {
        return false;
    };
    let Ok(url) = url::Url::parse(url) else {
        return false;
    };
    url.host_str() == Some("www.instagram.com")
        && url
            .path_segments()
            .and_then(|mut segments| segments.next().map(str::to_string))
            .is_some_and(|segment| segment.eq_ignore_ascii_case(username))
}

fn retain_grid_media(media: &mut Vec<ExtractedMedia>, publication_codes: &[String]) {
    let allowed: HashSet<&str> = publication_codes.iter().map(String::as_str).collect();
    media.retain(|item| {
        item.publication_code
            .as_deref()
            .map(|code| allowed.contains(code))
            .unwrap_or(false)
    });
}

fn snapshot_text_indicates_empty(snapshot: &Value) -> bool {
    let text = snapshot["text"]
        .as_str()
        .unwrap_or_default()
        .to_ascii_lowercase();
    [
        "no posts yet",
        "aún no hay publicaciones",
        "todavía no hay publicaciones",
    ]
    .iter()
    .any(|message| text.contains(message))
}

fn dom_detail_codes(payloads: &[Value]) -> Vec<String> {
    let mut codes = Vec::new();
    let mut seen = HashSet::new();
    for payload in payloads {
        walk(payload, &mut |map| {
            if map.get("needs_detail").and_then(Value::as_bool) != Some(true) {
                return;
            }
            if let Some(code) = value_string(map, &["shortcode", "code"]) {
                if seen.insert(code.clone()) {
                    codes.push(code);
                }
            }
        });
    }
    codes
}

fn snapshot_indicates_login_wall(snapshot: &Value) -> bool {
    let url = snapshot["url"].as_str().unwrap_or_default();
    let text = snapshot["text"]
        .as_str()
        .unwrap_or_default()
        .to_ascii_lowercase();
    url.contains("/accounts/login")
        || text.contains("log in to see photos")
        || text.contains("inicia sesión para ver")
        || text.contains("see more from") && text.contains("log in")
}

fn snapshot_sync_denial(snapshot: &Value) -> Option<(SyncStatus, String)> {
    let url = snapshot["url"].as_str().unwrap_or_default();
    let text = snapshot["text"]
        .as_str()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if url.contains("/challenge/")
        || text.contains("challenge_required")
        || text.contains("checkpoint_required")
    {
        return Some((
            SyncStatus::ChallengeRequired,
            "Instagram requiere una revisión de seguridad. No se harán más consultas.".into(),
        ));
    }
    if text.contains("please wait a few minutes")
        || text.contains("feedback_required")
        || text.contains("try again later")
    {
        return Some((
            SyncStatus::RateLimited,
            "Instagram limitó temporalmente las consultas. No se reintentará automáticamente."
                .into(),
        ));
    }
    None
}

/// Some Instagram builds expose GraphQL `page_info`, while others expose the
/// mobile-shaped `more_available`. `Some(false)` is the only authoritative end.
fn pagination_terminal(payloads: &[Value]) -> Option<bool> {
    let mut has_more = false;
    let mut reached_end = false;
    for payload in payloads {
        walk(payload, &mut |map| {
            if let Some(more) = map.get("more_available").and_then(Value::as_bool) {
                if map.get("items").and_then(Value::as_array).is_some() {
                    has_more |= more;
                    reached_end |= !more;
                }
            }
            if let Some(page_info) = map.get("page_info").and_then(Value::as_object) {
                if let Some(more) = page_info.get("has_next_page").and_then(Value::as_bool) {
                    has_more |= more;
                    reached_end |= !more;
                }
            }
        });
    }
    if has_more {
        Some(true)
    } else if reached_end {
        Some(false)
    } else {
        None
    }
}

fn profile_from_snapshot(snapshot: &Value, username: &str) -> Option<ProfileRow> {
    let url = snapshot["url"].as_str().unwrap_or_default();
    if url.contains("/accounts/login") {
        return None;
    }
    let title = snapshot["title"].as_str().unwrap_or_default();
    let text = snapshot["text"].as_str().unwrap_or_default();
    let title_matches = title.to_ascii_lowercase().contains(&format!("@{username}"));
    let text_matches = text
        .lines()
        .any(|line| line.trim().eq_ignore_ascii_case(username));
    if !title_matches && !text_matches {
        return None;
    }
    let full_name = title
        .split("(@")
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("instagram"))
        .map(str::to_string);
    let lower = text.to_ascii_lowercase();
    let is_private = lower.contains("this account is private")
        || lower.contains("esta cuenta es privada")
        || lower.contains("cuenta privada");
    let profile_pic_url = snapshot["images"].as_array().and_then(|images| {
        images
            .iter()
            .filter(|image| {
                let alt = image["alt"]
                    .as_str()
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                alt.contains(username) && (alt.contains("profile") || alt.contains("perfil"))
            })
            .max_by_key(|image| {
                image["width"].as_i64().unwrap_or(0) * image["height"].as_i64().unwrap_or(0)
            })
            .and_then(|image| image["src"].as_str())
            .map(str::to_string)
    });
    Some(ProfileRow {
        username: username.to_string(),
        pk: None,
        full_name,
        biography: None,
        followers: None,
        following: None,
        media_count: None,
        is_private: Some(i64::from(is_private)),
        is_verified: None,
        profile_pic_url,
        avatar_local_path: None,
        has_content: false,
        content_url: None,
        byte_size: None,
        is_favorite: 0,
        fetched_at: Some(chrono::Utc::now().timestamp()),
        id: None,
    })
}

fn sanitize_username(value: &str) -> ProviderResult<String> {
    let username = value.trim().trim_start_matches('@').to_ascii_lowercase();
    if username.is_empty()
        || username.len() > 30
        || !username
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_'))
    {
        return Err(ProviderError::new(
            "not_found",
            "Nombre de usuario inválido.",
            false,
        ));
    }
    Ok(username)
}

fn detect_denial(snapshot: &Value, mode: AccessMode) -> ProviderResult<()> {
    let url = snapshot["url"].as_str().unwrap_or_default();
    let text = snapshot["text"]
        .as_str()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if url.contains("/challenge/")
        || text.contains("challenge_required")
        || text.contains("checkpoint_required")
    {
        return Err(ProviderError::new(
            "challenge_required",
            "Instagram requiere una revisión de seguridad. No se harán más consultas.",
            false,
        ));
    }
    if text.contains("page isn't available")
        || text.contains("sorry, this page")
        || text.contains("esta página no está disponible")
    {
        return Err(ProviderError::new(
            "not_found",
            "Instagram no encontró ese perfil.",
            false,
        ));
    }
    if text.contains("please wait a few minutes")
        || text.contains("feedback_required")
        || text.contains("try again later")
    {
        return Err(ProviderError::new(
            "rate_limited",
            "Instagram limitó temporalmente las consultas. No se reintentará automáticamente.",
            false,
        ));
    }
    if url.contains("/accounts/login") && mode == AccessMode::PrivateExplicit {
        return Err(ProviderError::new(
            "private_login_required",
            "La sesión privada no está conectada. Inicia sesión en el navegador dedicado.",
            false,
        ));
    }
    Ok(())
}

fn denied(mode: AccessMode) -> ProviderError {
    match mode {
        AccessMode::PublicAnonymous => ProviderError::new(
            "public_blocked",
            "Instagram exige iniciar sesión para esta consulta pública. No se usaron tus cookies.",
            false,
        ),
        AccessMode::PrivateExplicit => ProviderError::new(
            "private_login_required",
            "La sesión privada expiró o fue rechazada.",
            false,
        ),
    }
}

fn walk<'a>(value: &'a Value, visit: &mut impl FnMut(&'a Map<String, Value>)) {
    match value {
        Value::Object(map) => {
            visit(map);
            for child in map.values() {
                walk(child, visit);
            }
        }
        Value::Array(items) => {
            for child in items {
                walk(child, visit);
            }
        }
        _ => {}
    }
}

fn value_string(map: &Map<String, Value>, names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| map.get(*name))
        .and_then(|value| match value {
            Value::String(value) => Some(value.clone()),
            Value::Number(value) => Some(value.to_string()),
            _ => None,
        })
}

fn find_profile(value: &Value, username: &str) -> Option<WebProfileUser> {
    let mut result = None;
    walk(value, &mut |map| {
        if result.is_some()
            || map
                .get("username")
                .and_then(Value::as_str)
                .map(|v| !v.eq_ignore_ascii_case(username))
                .unwrap_or(true)
        {
            return;
        }
        let has_profile_shape = map.contains_key("is_private")
            || map.contains_key("profile_pic_url_hd")
            || map.contains_key("profile_pic_url")
            || map.contains_key("full_name");
        if !has_profile_shape {
            return;
        }
        result = Some(WebProfileUser {
            id: value_string(map, &["id", "pk"]),
            username: username.to_string(),
            full_name: map
                .get("full_name")
                .and_then(Value::as_str)
                .map(str::to_string),
            biography: map
                .get("biography")
                .and_then(Value::as_str)
                .map(str::to_string),
            profile_pic_url_hd: value_string(map, &["profile_pic_url_hd", "profile_pic_url"]),
            is_private: map.get("is_private").and_then(Value::as_bool),
            is_verified: map.get("is_verified").and_then(Value::as_bool),
            edge_followed_by: count_wrap(map, "edge_followed_by", "follower_count"),
            edge_follow: count_wrap(map, "edge_follow", "following_count"),
            edge_owner_to_timeline_media: count_wrap(
                map,
                "edge_owner_to_timeline_media",
                "media_count",
            ),
        });
    });
    result
}

fn count_wrap(
    map: &Map<String, Value>,
    nested: &str,
    flat: &str,
) -> Option<super::models::CountWrap> {
    map.get(nested)
        .and_then(|v| v.get("count"))
        .and_then(Value::as_i64)
        .or_else(|| map.get(flat).and_then(Value::as_i64))
        .map(|count| super::models::CountWrap { count })
}

fn profile_row(user: WebProfileUser) -> ProfileRow {
    ProfileRow {
        username: user.username,
        pk: user.id,
        full_name: user.full_name,
        biography: user.biography,
        followers: user.edge_followed_by.map(|v| v.count),
        following: user.edge_follow.map(|v| v.count),
        media_count: user.edge_owner_to_timeline_media.map(|v| v.count),
        is_private: user.is_private.map(i64::from),
        is_verified: user.is_verified.map(i64::from),
        profile_pic_url: user.profile_pic_url_hd,
        avatar_local_path: None,
        has_content: false,
        content_url: None,
        byte_size: None,
        is_favorite: 0,
        fetched_at: Some(chrono::Utc::now().timestamp()),
        id: None,
    }
}

fn collect_media(value: &Value, kind: &str, username: &str, out: &mut Vec<ExtractedMedia>) {
    walk(value, &mut |map| {
        if let Some(owner) = map
            .get("owner")
            .and_then(|v| v.get("username"))
            .and_then(Value::as_str)
        {
            if !owner.eq_ignore_ascii_case(username) {
                return;
            }
        }
        if map.contains_key("media_type")
            && (map.contains_key("image_versions2") || map.contains_key("video_versions"))
        {
            if let Ok(item) = serde_json::from_value::<FeedItem>(Value::Object(map.clone())) {
                out.extend(api::extract_item(&item, kind));
            }
            return;
        }
        let code = value_string(map, &["shortcode", "code"]);
        let id = value_string(map, &["id", "pk"]);
        let image = value_string(map, &["display_url", "thumbnail_src", "image_url"]);
        let video = value_string(map, &["video_url"]);
        if id.is_none() || code.is_none() || (image.is_none() && video.is_none()) {
            return;
        }
        let dimensions = map.get("dimensions");
        let width = dimensions
            .and_then(|v| v.get("width"))
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let height = dimensions
            .and_then(|v| v.get("height"))
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let children = graph_children(map);
        let item = FeedItem {
            pk: id.unwrap(),
            id: None,
            media_type: if children.is_some() {
                8
            } else if video.is_some() {
                2
            } else {
                1
            },
            taken_at: map
                .get("taken_at_timestamp")
                .or_else(|| map.get("taken_at"))
                .and_then(Value::as_i64),
            code,
            caption: graph_caption(map).map(|text| CaptionWrap { text: Some(text) }),
            image_versions2: image.clone().map(|url| ImageVersions {
                candidates: vec![Candidate { url, width, height }],
            }),
            video_versions: video.map(|url| {
                vec![VideoVersion {
                    type_: None,
                    url,
                    bit_rate: map.get("bit_rate").and_then(Value::as_i64),
                    width,
                    height,
                }]
            }),
            carousel_media: children,
            is_reel_media: None,
        };
        let start = out.len();
        out.extend(api::extract_item(&item, kind));
        if map
            .get("__instavault_dom")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            for extracted in &mut out[start..] {
                extracted.quality_verified = false;
                extracted.source = "dom_fallback";
            }
        }
    });
}

fn graph_caption(map: &Map<String, Value>) -> Option<String> {
    map.get("edge_media_to_caption")?
        .get("edges")?
        .as_array()?
        .first()?
        .get("node")?
        .get("text")?
        .as_str()
        .map(str::to_string)
}

fn graph_children(map: &Map<String, Value>) -> Option<Vec<FeedItem>> {
    let edges = map
        .get("edge_sidecar_to_children")?
        .get("edges")?
        .as_array()?;
    let mut children = Vec::new();
    for edge in edges {
        let node = edge.get("node")?.as_object()?;
        let id = value_string(node, &["id", "pk"])?;
        let image = value_string(node, &["display_url", "thumbnail_src"]);
        let video = value_string(node, &["video_url"]);
        let dimensions = node.get("dimensions");
        let width = dimensions
            .and_then(|v| v.get("width"))
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let height = dimensions
            .and_then(|v| v.get("height"))
            .and_then(Value::as_i64)
            .unwrap_or(0);
        children.push(FeedItem {
            pk: id,
            id: None,
            media_type: if video.is_some() { 2 } else { 1 },
            taken_at: None,
            code: None,
            caption: None,
            image_versions2: image.map(|url| ImageVersions {
                candidates: vec![Candidate { url, width, height }],
            }),
            video_versions: video.map(|url| {
                vec![VideoVersion {
                    type_: None,
                    url,
                    bit_rate: None,
                    width,
                    height,
                }]
            }),
            carousel_media: None,
            is_reel_media: None,
        });
    }
    (!children.is_empty()).then_some(children)
}

fn collect_dom_images(snapshot: &Value, kind: &str, out: &mut Vec<ExtractedMedia>) {
    let Some(images) = snapshot["images"].as_array() else {
        return;
    };
    for image in images {
        let href = image["href"].as_str().unwrap_or_default();
        if !(href.contains("/p/") || href.contains("/reel/")) {
            continue;
        }
        let Some(src) = image["src"]
            .as_str()
            .filter(|value| value.starts_with("http"))
        else {
            continue;
        };
        let code = href
            .split('/')
            .filter(|part| !part.is_empty())
            .last()
            .unwrap_or_default()
            .to_string();
        if code.is_empty() {
            continue;
        }
        out.push(ExtractedMedia {
            media_id: format!("web_{code}"),
            publication_code: Some(code.clone()),
            child_index: 0,
            kind: kind.to_string(),
            code: Some(code),
            taken_at: None,
            caption: image["alt"].as_str().map(str::to_string),
            media_type: 1,
            thumbnail_url: Some(src.to_string()),
            best_url: src.to_string(),
            width: image["width"].as_i64(),
            height: image["height"].as_i64(),
            bitrate: None,
            byte_size: None,
            quality_verified: false,
            source: "dom_fallback",
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_profile_in_nested_graphql_payload() {
        let value = serde_json::json!({"data":{"user":{"id":"7","username":"Test.User","full_name":"Test","is_private":false,"profile_pic_url":"https://cdn.test/a.jpg","follower_count":12}}});
        let user = find_profile(&value, "test.user").unwrap();
        assert_eq!(user.id.as_deref(), Some("7"));
        assert_eq!(user.edge_followed_by.unwrap().count, 12);
    }

    #[test]
    fn username_validation_rejects_urls_and_spaces() {
        assert!(sanitize_username("@valid_name.1").is_ok());
        assert!(sanitize_username("https://instagram.com/x").is_err());
        assert!(sanitize_username("bad name").is_err());
    }

    #[test]
    fn pagination_end_requires_an_authoritative_false_signal() {
        let graphql_more = serde_json::json!({"data":{"user":{"edge_owner_to_timeline_media":{
            "edges":[],"page_info":{"has_next_page":true,"end_cursor":"next"}
        }}}});
        let graphql_end = serde_json::json!({"data":{"user":{"edge_owner_to_timeline_media":{
            "edges":[],"page_info":{"has_next_page":false,"end_cursor":null}
        }}}});
        let mobile_end = serde_json::json!({"items":[],"more_available":false,"next_max_id":null});
        assert_eq!(pagination_terminal(&[graphql_more]), Some(true));
        assert_eq!(pagination_terminal(&[graphql_end]), Some(false));
        assert_eq!(pagination_terminal(&[mobile_end]), Some(false));
        assert_eq!(
            pagination_terminal(&[serde_json::json!({"items":[]})]),
            None
        );
    }

    #[test]
    fn login_wall_is_not_reported_as_complete() {
        let snapshot = serde_json::json!({
            "url":"https://www.instagram.com/accounts/login/",
            "text":"Log in to see photos and videos"
        });
        assert!(snapshot_indicates_login_wall(&snapshot));
        assert!(!snapshot_text_indicates_empty(&snapshot));
    }

    #[test]
    fn navigation_must_end_on_the_requested_profile() {
        assert!(snapshot_matches_profile(
            &serde_json::json!({"url":"https://www.instagram.com/maribel_viquez/"}),
            "maribel_viquez"
        ));
        assert!(!snapshot_matches_profile(
            &serde_json::json!({"url":"https://www.instagram.com/fiochavesch/"}),
            "maribel_viquez"
        ));
        assert!(!snapshot_matches_profile(
            &serde_json::json!({"url":"https://www.instagram.com/accounts/login/"}),
            "maribel_viquez"
        ));
    }

    #[test]
    fn unrelated_json_media_cannot_enter_a_profile_batch() {
        let item = |code: &str| ExtractedMedia {
            media_id: format!("web_{code}"),
            publication_code: Some(code.to_string()),
            child_index: 0,
            kind: "post".into(),
            code: Some(code.to_string()),
            taken_at: None,
            caption: None,
            media_type: 1,
            thumbnail_url: None,
            best_url: "https://cdn.example/media.jpg".into(),
            width: None,
            height: None,
            bitrate: None,
            byte_size: None,
            quality_verified: false,
            source: "fixture",
        };
        let mut media = vec![item("MARIBEL"), item("FIO"), item("ADVERTISEMENT")];
        retain_grid_media(&mut media, &["MARIBEL".into()]);
        assert_eq!(media.len(), 1);
        assert_eq!(media[0].publication_code.as_deref(), Some("MARIBEL"));
    }
}
