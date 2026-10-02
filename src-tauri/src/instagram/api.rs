use super::models::*;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaCandidate {
    pub url: String,
    pub width: i64,
    pub height: i64,
    pub bitrate: i64,
    pub byte_size: i64,
}

/// Selecciona el mejor candidato conocido. La resolución domina; en empate
/// ganan bitrate/tamaño/ancho. No realiza ninguna petición a Instagram.
pub fn best_candidate(item: &serde_json::Value) -> Option<MediaCandidate> {
    let videos = item
        .get("video_versions")
        .and_then(|v| v.as_array())
        .and_then(|versions| {
            versions
                .iter()
                .filter_map(|candidate| {
                    Some(MediaCandidate {
                        width: candidate.get("width")?.as_i64()?,
                        height: candidate.get("height")?.as_i64()?,
                        bitrate: candidate
                            .get("bit_rate")
                            .and_then(|v| v.as_i64())
                            .unwrap_or(0),
                        byte_size: candidate
                            .get("file_size")
                            .and_then(|v| v.as_i64())
                            .unwrap_or(0),
                        url: candidate.get("url")?.as_str()?.to_string(),
                    })
                })
                .max_by_key(|candidate| {
                    (
                        candidate.width * candidate.height,
                        candidate.bitrate,
                        candidate.byte_size,
                        candidate.width,
                    )
                })
        });
    if videos.is_some() {
        return videos;
    }
    item.get("image_versions2")
        .and_then(|v| v.get("candidates"))
        .and_then(|v| v.as_array())
        .and_then(|candidates| {
            candidates
                .iter()
                .filter_map(|candidate| {
                    Some(MediaCandidate {
                        width: candidate.get("width")?.as_i64()?,
                        height: candidate.get("height")?.as_i64()?,
                        bitrate: 0,
                        byte_size: candidate
                            .get("file_size")
                            .and_then(|v| v.as_i64())
                            .unwrap_or(0),
                        url: candidate.get("url")?.as_str()?.to_string(),
                    })
                })
                .max_by_key(|candidate| {
                    (
                        candidate.width * candidate.height,
                        candidate.byte_size,
                        candidate.width,
                    )
                })
        })
}

pub fn extract_item(item: &FeedItem, kind: &str) -> Vec<ExtractedMedia> {
    let code = item.code.clone();
    let taken = item.taken_at;
    let caption = item
        .caption
        .as_ref()
        .and_then(|value| value.text.clone())
        .filter(|value| !value.is_empty());
    if item.media_type == 8 {
        if let Some(children) = &item.carousel_media {
            return children
                .iter()
                .enumerate()
                .filter_map(|(index, child)| {
                    selected(child).map(|best| ExtractedMedia {
                        media_id: format!("{}_{}", item.pk, index),
                        publication_code: code.clone(),
                        child_index: index as i64,
                        kind: kind.to_string(),
                        code: code.clone(),
                        taken_at: taken,
                        caption: caption.clone(),
                        media_type: child.media_type,
                        thumbnail_url: thumb_url(child),
                        best_url: best.url,
                        width: Some(best.width),
                        height: Some(best.height),
                        bitrate: (best.bitrate > 0).then_some(best.bitrate),
                        byte_size: (best.byte_size > 0).then_some(best.byte_size),
                        quality_verified: true,
                        source: "web_response",
                    })
                })
                .collect();
        }
    }
    selected(item)
        .map(|best| {
            vec![ExtractedMedia {
                media_id: item.pk.clone(),
                publication_code: code.clone(),
                child_index: 0,
                kind: kind.to_string(),
                code,
                taken_at: taken,
                caption,
                media_type: item.media_type,
                thumbnail_url: thumb_url(item),
                best_url: best.url,
                width: Some(best.width),
                height: Some(best.height),
                bitrate: (best.bitrate > 0).then_some(best.bitrate),
                byte_size: (best.byte_size > 0).then_some(best.byte_size),
                quality_verified: true,
                source: "web_response",
            }]
        })
        .unwrap_or_default()
}

fn selected(item: &FeedItem) -> Option<MediaCandidate> {
    if item.media_type == 2 {
        item.video_versions
            .as_ref()?
            .iter()
            .max_by_key(|value| {
                (
                    value.width * value.height,
                    value.bit_rate.unwrap_or(0),
                    value.width,
                )
            })
            .map(|value| MediaCandidate {
                url: value.url.clone(),
                width: value.width,
                height: value.height,
                bitrate: value.bit_rate.unwrap_or(0),
                byte_size: 0,
            })
    } else {
        item.image_versions2
            .as_ref()?
            .candidates
            .iter()
            .max_by_key(|value| (value.width * value.height, value.width))
            .map(|value| MediaCandidate {
                url: value.url.clone(),
                width: value.width,
                height: value.height,
                bitrate: 0,
                byte_size: 0,
            })
    }
}

fn thumb_url(item: &FeedItem) -> Option<String> {
    item.image_versions2
        .as_ref()?
        .candidates
        .iter()
        .min_by_key(|candidate| (candidate.width - 320).abs())
        .map(|candidate| candidate.url.clone())
}

#[cfg(test)]
mod tests {
    use super::best_candidate;

    #[test]
    fn picks_largest_image_then_known_size() {
        let item = serde_json::json!({"image_versions2":{"candidates":[
            {"url":"small","width":320,"height":320,"file_size":9999},
            {"url":"large-a","width":1440,"height":1800,"file_size":1000},
            {"url":"large-b","width":1440,"height":1800,"file_size":2000}
        ]}});
        assert_eq!(best_candidate(&item).unwrap().url, "large-b");
    }

    #[test]
    fn video_resolution_then_bitrate_then_size_wins() {
        let item = serde_json::json!({"video_versions":[
            {"url":"low","width":1080,"height":1920,"bit_rate":1200,"file_size":5000},
            {"url":"high-small","width":1080,"height":1920,"bit_rate":4800,"file_size":4000},
            {"url":"high-large","width":1080,"height":1920,"bit_rate":4800,"file_size":8000}
        ]});
        assert_eq!(best_candidate(&item).unwrap().url, "high-large");
    }
}
