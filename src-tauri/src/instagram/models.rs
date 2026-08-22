// Varios campos solo existen para deserializar la API; se marcan para no spamear warnings.
#![allow(dead_code)]
use serde::{Deserialize, Serialize};

// Filas de la BD (serializables al frontend)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileRow {
    pub username: String,
    pub pk: Option<String>,
    pub full_name: Option<String>,
    pub biography: Option<String>,
    pub followers: Option<i64>,
    pub following: Option<i64>,
    pub media_count: Option<i64>,
    // Option: una fetch degradada devuelve null y el upsert con COALESCE
    // conserva el valor real guardado.
    pub is_private: Option<i64>,
    pub is_verified: Option<i64>,
    pub profile_pic_url: Option<String>,
    /// Copia local de la foto (%APPDATA%/avatars/{id}.jpg). El WebView no
    /// siempre puede cargar la CDN (URLs firmadas que expiran), así que la
    /// app la descarga una vez en Rust y la sirve por asset-protocol.
    pub avatar_local_path: Option<String>,
    pub is_favorite: i64,
    pub fetched_at: Option<i64>,
    pub id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaRow {
    pub media_id: String,
    pub profile_id: Option<i64>,
    pub kind: String, // post | story | highlight | profile_pic
    pub code: Option<String>,
    pub taken_at: Option<i64>,
    pub caption: Option<String>,
    pub media_type: Option<i64>, // 1=photo 2=video 8=carousel
    pub thumbnail_url: Option<String>,
    pub best_url: Option<String>,
    pub local_path: Option<String>,
    pub status: String, // metadata | downloaded | failed
    pub error: Option<String>,
    pub created_at: Option<i64>,
    pub id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountInfo {
    pub id: i64,
    pub username: String,
    pub status: String,
    pub last_valid: Option<i64>,
}

// ---- Estructuras crudas de la API de Instagram ----

// Perfil vía endpoint web nonsense (web_profile_info)
#[derive(Debug, Clone, Deserialize)]
pub struct WebProfileInfo {
    pub data: WebProfileData,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WebProfileData {
    pub user: Option<WebProfileUser>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WebProfileUser {
    // Option: el fallback HTML devuelve null cuando no logra extraer el id.
    #[serde(default)]
    pub id: Option<String>,
    pub username: String,
    pub full_name: Option<String>,
    pub biography: Option<String>,
    pub profile_pic_url_hd: Option<String>,
    pub is_private: Option<bool>,
    pub is_verified: Option<bool>,
    // Option: el fallback HTML devuelve null (dato desconocido) y el upsert
    // con COALESCE no pisa los valores reales guardados.
    #[serde(default)]
    pub edge_followed_by: Option<CountWrap>,
    #[serde(default)]
    pub edge_follow: Option<CountWrap>,
    #[serde(default)]
    pub edge_owner_to_timeline_media: Option<CountWrap>,
}

#[derive(Debug, Default, Clone, Deserialize)]
pub struct CountWrap {
    #[serde(default)]
    pub count: i64,
}

// Feed de posts
#[derive(Debug, Clone, Deserialize)]
pub struct FeedResponse {
    #[serde(default)]
    pub items: Vec<FeedItem>,
    #[serde(default)]
    pub more_available: bool,
    #[serde(default)]
    pub next_max_id: Option<String>,
    pub status: Option<String>,
}

// Item genérico (se usa para posts, stories y highlights)
#[derive(Debug, Clone, Deserialize)]
pub struct FeedItem {
    pub pk: String,
    pub id: Option<String>,
    #[serde(default)]
    pub media_type: i64, // 1 photo, 2 video, 8 carousel
    #[serde(default)]
    pub taken_at: Option<i64>,
    #[serde(default)]
    pub code: Option<String>,
    pub caption: Option<CaptionWrap>,
    #[serde(default)]
    pub image_versions2: Option<ImageVersions>,
    #[serde(default)]
    pub video_versions: Option<Vec<VideoVersion>>,
    #[serde(default)]
    pub carousel_media: Option<Vec<FeedItem>>,
    #[serde(default)]
    pub is_reel_media: Option<bool>,
}

#[derive(Debug, Deserialize, Default, Clone)]
pub struct CaptionWrap {
    #[serde(default)]
    pub text: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ImageVersions {
    #[serde(default)]
    pub candidates: Vec<Candidate>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Candidate {
    pub url: String,
    #[serde(default)]
    pub width: i64,
    #[serde(default)]
    pub height: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct VideoVersion {
    #[serde(default)]
    pub type_: Option<i64>,
    pub url: String,
    #[serde(default)]
    pub width: i64,
    #[serde(default)]
    pub height: i64,
}

// Stories
#[derive(Debug, Clone, Deserialize)]
pub struct ReelMediaResponse {
    #[serde(default)]
    pub items: Vec<FeedItem>,
    #[serde(default)]
    pub user: Option<ReelUser>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReelUser {
    pub pk: Option<String>,
    pub username: Option<String>,
    pub profile_pic_url: Option<String>,
}

// Highlights tray
#[derive(Debug, Clone, Deserialize)]
pub struct HighlightsTrayResponse {
    pub tray: Option<Vec<HighlightTrayItem>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HighlightTrayItem {
    pub id: String,
    pub title: Option<String>,
}

/// Highlight reel extraído del DOM de la página de perfil (el endpoint
/// mobile `highlights_tray` devuelve `status: fail`; la web los renderiza igual).
#[derive(Debug, Clone, Deserialize)]
pub struct HighlightReel {
    pub id: String,
    #[serde(default)]
    pub title: String,
}

// Reels_media → dict keyed por reel id
#[derive(Debug, Clone, Deserialize)]
pub struct ReelsMediaResponse {
    pub reels: std::collections::HashMap<String, ReelMediaResponse>,
}

// Media extraído y listo para guardar
#[derive(Debug, Clone)]
pub struct ExtractedMedia {
    pub media_id: String,
    pub kind: String,
    pub code: Option<String>,
    pub taken_at: Option<i64>,
    pub caption: Option<String>,
    pub media_type: i64,
    pub thumbnail_url: Option<String>,
    pub best_url: String,
}

// ---- DTOs de descargas y estado (frontend) ----

/// Snapshot de progreso emitido vía evento `download:progress`.
#[derive(Debug, Clone, Serialize)]
pub struct DownloadProgress {
    pub job_id: i64,
    pub profile_id: i64,
    pub kind: String,
    pub total: usize,
    pub done: usize,
    pub ok: usize,
    pub failed: usize,
    /// code (o media_id) del ítem recién procesado.
    pub current: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadError {
    pub media_id: String,
    pub code: Option<String>,
    pub error: String,
}

/// Resultado autoritativo de un lote (retorna el comando; los eventos son informativos).
#[derive(Debug, Clone, Serialize)]
pub struct DownloadSummary {
    pub total: usize,
    pub ok: usize,
    pub failed: usize,
    pub errors: Vec<DownloadError>,
}

/// Job de descarga persistido (manager de descargas).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadJob {
    pub id: i64,
    pub profile_id: i64,
    pub username: String,
    pub kind: String,
    pub total: i64,
    pub ok: i64,
    pub failed: i64,
    pub started_at: i64,
    pub finished_at: Option<i64>,
}

/// Estado de sincronización/descarga de un kind (agregado desde `media`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KindStats {
    pub kind: String,
    pub local_count: i64,
    pub downloaded: i64,
    pub failed: i64,
    pub last_sync: Option<i64>,
}

/// Stats de un perfil (1 consulta para toda la UI).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileStats {
    pub profile_id: i64,
    pub total_media: i64,
    pub kinds: Vec<KindStats>,
}
