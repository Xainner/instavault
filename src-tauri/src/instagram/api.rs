use super::client::{IgClient, Session};
use super::models::*;
use anyhow::Context;
use serde::Deserialize;

const API_BASE: &str = "https://i.instagram.com/api/v1";

// ---------------------------------------------------------------------------
// Sesión / validación
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct CurrentUserResponse {
    pub user: CurrentUser,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct CurrentUser {
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub pk: Option<String>,
}

/// Valida/lee la sesión autenticada (falla si las cookies no son válidas).
pub async fn current_user(ig: &IgClient, session: &Session) -> anyhow::Result<CurrentUser> {
    let body = raw_current_user(ig, session).await?;
    let resp: CurrentUserResponse = serde_json::from_slice(&body)
        .context("respuesta de current_user sin campo user")?;
    Ok(resp.user)
}

/// GET crudo de current_user (para diagnóstico).
pub async fn raw_current_user(ig: &IgClient, session: &Session) -> anyhow::Result<Vec<u8>> {
    let url = format!("{API_BASE}/accounts/current_user/?edit=true");
    ig.get_bytes(&url, session).await
}

// ---------------------------------------------------------------------------
// Perfil
// ---------------------------------------------------------------------------

pub async fn lookup_profile(
    ig: &IgClient,
    session: &Session,
    username: &str,
) -> anyhow::Result<WebProfileUser> {
    let url = format!("{API_BASE}/users/web_profile_info/?username={username}");
    let resp: WebProfileInfo = ig
        .get_json(&url, session)
        .await
        .context("fallo al resolver perfil")?;
    resp.data
        .user
        .context("perfil no encontrado (puede ser privado o no existir)")
}

// ---------------------------------------------------------------------------
// Posts / feed con paginación
// ---------------------------------------------------------------------------

/// Itera el feed del usuario hasta `max_pages` páginas o hasta agotar.
/// Devuelve la lista completa de items (cada item puede ser carousel).
pub async fn fetch_posts(
    ig: &IgClient,
    session: &Session,
    pk: &str,
    max_pages: u32,
) -> anyhow::Result<Vec<FeedItem>> {
    let mut all: Vec<FeedItem> = Vec::new();
    let mut max_id: Option<String> = None;
    for _ in 0..max_pages {
        let mut url = format!("{API_BASE}/feed/user/{pk}/?count=33");
        if let Some(m) = &max_id {
            url.push_str(&format!("&max_id={m}"));
        }
        let resp: FeedResponse = ig
            .get_json(&url, session)
            .await
            .context("fallo al leer feed de posts")?;
        all.extend(resp.items);
        if !resp.more_available || resp.next_max_id.is_none() {
            break;
        }
        max_id = resp.next_max_id;
        // pausa breve para no golpear el rate-limit
        tokio::time::sleep(std::time::Duration::from_millis(700)).await;
    }
    Ok(all)
}

// ---------------------------------------------------------------------------
// Stories activas
// ---------------------------------------------------------------------------

pub async fn fetch_stories(
    ig: &IgClient,
    session: &Session,
    pk: &str,
) -> anyhow::Result<Vec<FeedItem>> {
    let url = format!("{API_BASE}/feed/user/{pk}/reel_media/");
    let resp: ReelMediaResponse = ig
        .get_json(&url, session)
        .await
        .context("fallo al leer stories")?;
    Ok(resp.items)
}

// ---------------------------------------------------------------------------
// Highlights
// ---------------------------------------------------------------------------

pub async fn fetch_highlights_tray(
    ig: &IgClient,
    session: &Session,
    user_pk: &str,
) -> anyhow::Result<Vec<HighlightTrayItem>> {
    let url = format!("{API_BASE}/highlights/{user_pk}/highlights_tray/");
    let resp: HighlightsTrayResponse = ig
        .get_json(&url, session)
        .await
        .context("fallo al leer tray de highlights")?;
    Ok(resp.tray.unwrap_or_default())
}

/// Lee media de uno o varios reels (ids ya limpios, p.ej.
/// `highlight:123,highlight:456`). Endpoint mobile genérico de reels.
pub async fn fetch_reels_media(
    ig: &IgClient,
    session: &Session,
    reel_ids: &str,
) -> anyhow::Result<Vec<FeedItem>> {
    let url = format!(
        "{API_BASE}/feed/reels_media/?reel_ids={}",
        urlencoding(reel_ids)
    );
    let resp: ReelsMediaResponse = ig
        .get_json(&url, session)
        .await
        .context("fallo al leer reels media")?;
    let mut out = Vec::new();
    for reel in resp.reels.values() {
        out.extend(reel.items.clone());
    }
    Ok(out)
}

pub async fn fetch_highlight_media(
    ig: &IgClient,
    session: &Session,
    highlight_id: &str,
) -> anyhow::Result<Vec<FeedItem>> {
    // El id de highlight viene como "highlight:123456"; la API usa el número limpio.
    let clean = highlight_id.split(':').last().unwrap_or(highlight_id);
    let reel_id = format!("highlight:{clean}");
    let url = format!(
        "{API_BASE}/feed/reels_media/?reel_ids={}",
        urlencoding(&reel_id)
    );
    let resp: ReelsMediaResponse = ig
        .get_json(&url, session)
        .await
        .context("fallo al leer media del highlight")?;
    // La respuesta mapea reel_id → {items}; tomamos el primero que exista.
    let mut out = Vec::new();
    for reel in resp.reels.values() {
        out.extend(reel.items.clone());
    }
    Ok(out)
}

/// Mejor URL de UN medio vía `media/{pk}/info/` (el endpoint que usa la web).
/// A diferencia de feed/reels_media, para stories/highlights devuelve el
/// candidato SIN límite de píxeles (resolución original, p.ej. 1179x2096),
/// y las firmas de CDN siempre son frescas. `media_id` acepta los formatos
/// de la BD: `{pk}`, `{pk}_{idx}` (carousel), `st_{pk}`, `hl_{pk}`.
#[derive(Debug, Clone)]
pub struct MediaCandidate {
    pub url: String,
    pub width: i64,
    pub height: i64,
    pub bitrate: i64,
}

pub async fn fetch_media_info_candidate(
    ig: &IgClient,
    session: &Session,
    media_id: &str,
) -> anyhow::Result<Option<MediaCandidate>> {
    let (pk, child_idx) = if let Some((p, i)) = media_id
        .strip_prefix("st_")
        .or_else(|| media_id.strip_prefix("hl_"))
        .unwrap_or(media_id)
        .split_once('_')
    {
        (p, i.parse::<usize>().ok())
    } else {
        (
            media_id.strip_prefix("st_").unwrap_or(media_id),
            None,
        )
    };
    let url = format!("{API_BASE}/media/{pk}/info/");
    let v: serde_json::Value = ig
        .get_json(&url, session)
        .await
        .context("fallo al leer media info")?;
    // El item viene directo o envuelto en items[]
    let item: &serde_json::Value = if v.get("image_versions2").is_some()
        || v.get("carousel_media").is_some()
    {
        &v
    } else {
        v.get("items")
            .and_then(|i| i.as_array())
            .and_then(|a| a.first())
            .context("info sin item")?
    };
    // Carousel → hijo del índice; simple → el propio item
    let target = match child_idx {
        Some(i) => item
            .get("carousel_media")
            .and_then(|c| c.as_array())
            .and_then(|c| c.get(i))
            .context("info: índice de carousel inválido")?,
        None => item,
    };
    Ok(best_candidate(target))
}

/// Candidato de mayor calidad: resolución y, para videos empatados, bitrate.
fn best_candidate(item: &serde_json::Value) -> Option<MediaCandidate> {
    let videos = item
        .get("video_versions")
        .and_then(|v| v.as_array())
        .and_then(|versions| {
            versions
                .iter()
                .filter_map(|c| {
                    Some(MediaCandidate {
                        width: c.get("width")?.as_i64()?,
                        height: c.get("height")?.as_i64()?,
                        bitrate: c.get("bit_rate").and_then(|v| v.as_i64()).unwrap_or(0),
                        url: c.get("url")?.as_str()?.to_string(),
                    })
                })
                .max_by_key(|c| (c.width * c.height, c.bitrate, c.width))
        });
    if videos.is_some() {
        return videos;
    }
    item.get("image_versions2")
        .and_then(|iv| iv.get("candidates"))
        .and_then(|c| c.as_array())
        .and_then(|cands| {
            cands
                .iter()
                .filter_map(|c| {
                    Some(MediaCandidate {
                        width: c.get("width")?.as_i64()?,
                        height: c.get("height")?.as_i64()?,
                        bitrate: 0,
                        url: c.get("url")?.as_str()?.to_string(),
                    })
                })
                .max_by_key(|c| (c.width * c.height, c.width))
        })
}

// ---------------------------------------------------------------------------
// Extracción a MediaRow-listos-para-guardar
// ---------------------------------------------------------------------------

/// Convierte un item crudo de la API en 1..N medios descargables
/// (un carousel produce varias filas). kind: post|story|highlight.
pub fn extract_item(item: &FeedItem, kind: &str) -> Vec<ExtractedMedia> {
    let code = item.code.clone();
    let taken = item.taken_at;
    let caption = item
        .caption
        .as_ref()
        .and_then(|c| c.text.clone())
        .filter(|t| !t.is_empty());

    // Carousel → cada hijo
    if item.media_type == 8 {
        if let Some(children) = &item.carousel_media {
            let mut out = Vec::new();
            for (i, child) in children.iter().enumerate() {
                let child_id = format!("{}_{}", item.pk, i);
                if let Some(best) = best_url(child) {
                    out.push(ExtractedMedia {
                        media_id: child_id,
                        kind: kind.to_string(),
                        code: code.clone(),
                        taken_at: taken,
                        caption: caption.clone(),
                        media_type: child.media_type,
                        thumbnail_url: thumb_url(child),
                        best_url: best,
                    });
                }
            }
            return out;
        }
    }

    // Simple (foto o video)
    if let Some(best) = best_url(item) {
        vec![ExtractedMedia {
            media_id: item.pk.clone(),
            kind: kind.to_string(),
            code: code.clone(),
            taken_at: taken,
            caption: caption.clone(),
            media_type: item.media_type,
            thumbnail_url: thumb_url(item),
            best_url: best,
        }]
    } else {
        Vec::new()
    }
}

fn best_url(item: &FeedItem) -> Option<String> {
    if item.media_type == 2 {
        // video → mejor resolución
        item.video_versions
            .as_ref()
            .and_then(|v| v.iter().max_by_key(|x| (x.width * x.height, x.bit_rate.unwrap_or(0), x.width)))
            .map(|v| v.url.clone())
    } else {
        // foto → mejor resolución
        item.image_versions2
            .as_ref()
            .and_then(|iv| iv.candidates.iter().max_by_key(|c| c.width * c.height))
            .map(|c| c.url.clone())
    }
}

fn thumb_url(item: &FeedItem) -> Option<String> {
    item.image_versions2.as_ref().and_then(|iv| {
        iv.candidates
            .iter()
            .min_by_key(|c| (c.width - 320).abs())
            .map(|c| c.url.clone())
    })
}

fn urlencoding(s: &str) -> String {
    // encode solo los caracteres esenciales para el query
    s.replace(':', "%3A")
}

#[cfg(test)]
mod tests {
    use super::best_candidate;

    #[test]
    fn picks_largest_image_candidate() {
        let item = serde_json::json!({"image_versions2":{"candidates":[
            {"url":"small","width":320,"height":320},
            {"url":"largest","width":1440,"height":1800},
            {"url":"medium","width":1080,"height":1350}
        ]}});
        let best = best_candidate(&item).unwrap();
        assert_eq!(best.url, "largest");
        assert_eq!((best.width, best.height), (1440, 1800));
    }

    #[test]
    fn video_resolution_then_bitrate_wins() {
        let item = serde_json::json!({"video_versions":[
            {"url":"low","width":1080,"height":1920,"bit_rate":1200},
            {"url":"high","width":1080,"height":1920,"bit_rate":4800},
            {"url":"small","width":720,"height":1280,"bit_rate":9000}
        ]});
        let best = best_candidate(&item).unwrap();
        assert_eq!(best.url, "high");
        assert_eq!(best.bitrate, 4800);
    }
}
