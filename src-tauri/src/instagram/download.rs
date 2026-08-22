use super::client::{IgClient, Session};
use super::models::{DownloadError, DownloadProgress, DownloadSummary, MediaRow};
use anyhow::Context;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

struct ItemResult {
    media_id: String,
    code: Option<String>,
    ok: bool,
    error: Option<String>,
}

struct DownloadedContent {
    bytes: Vec<u8>,
    mime_type: String,
    width: Option<i64>,
    height: Option<i64>,
    bitrate: Option<i64>,
    quality_verified: bool,
    source: &'static str,
}

/// Descarga un lote de medios hacia disco y escribe el estado en BD.
/// `on_progress` recibe un snapshot tras cada ítem finalizado (el emisor
/// decide a dónde llevarlo: evento Tauri, log, etc.). Devuelve el resumen
/// autoritativo del lote.
pub async fn download_all<P>(
    ig: &IgClient,
    session: &Session,
    db: Arc<Mutex<crate::db::Db>>,
    base_dir: &Path,
    username: &str,
    rows: Vec<MediaRow>,
    concurrency: usize,
    profile_id: i64,
    kind: &str,
    job_id: i64,
    on_progress: P,
) -> anyhow::Result<DownloadSummary>
where
    P: Fn(DownloadProgress) + Send + Sync + Clone + 'static,
{
    let total = rows.len();
    if total == 0 {
        return Ok(DownloadSummary {
            total: 0,
            ok: 0,
            failed: 0,
            errors: Vec::new(),
        });
    }
    let done = Arc::new(AtomicUsize::new(0));
    let ok_c = Arc::new(AtomicUsize::new(0));
    let failed_c = Arc::new(AtomicUsize::new(0));
    on_progress(DownloadProgress {
        job_id,
        profile_id,
        kind: kind.to_string(),
        total,
        done: 0,
        ok: 0,
        failed: 0,
        current: None,
    });
    let kind = kind.to_string();

    let sem = Arc::new(tokio::sync::Semaphore::new(concurrency.max(1)));
    let mut handles = Vec::new();
    for row in rows {
        let permit = sem.clone().acquire_owned().await?;
        let ig = ig.clone();
        let session = session.clone();
        let db = db.clone();
        let base_dir = base_dir.to_path_buf();
        let username = username.to_string();
        let (done, ok_c, failed_c) = (done.clone(), ok_c.clone(), failed_c.clone());
        let on_progress = on_progress.clone();
        let kind = kind.clone();
        handles.push(tokio::spawn(async move {
            let _permit = permit;
            let db_id = row.id.unwrap_or(0);
            let label = row
                .code
                .clone()
                .or_else(|| Some(row.media_id.clone()))
                .unwrap_or_default();
            let (ok, err) = match download_one(&ig, &session, &row, &base_dir, &username, job_id).await {
                Ok(content) => {
                    let saved = db.lock().unwrap().store_media_content(
                        db_id, &content.bytes, &content.mime_type, content.width,
                        content.height, content.bitrate, content.quality_verified, content.source,
                    );
                    match saved {
                        Ok(()) => (true, None),
                        Err(e) => {
                            let message = format!("no se pudo guardar en SQLite: {e}");
                            let _ = db.lock().unwrap().mark_failed(db_id, &message);
                            (false, Some(message))
                        }
                    }
                }
                Err(e) => {
                    let _ = db.lock().unwrap().mark_failed(db_id, &e.to_string());
                    (false, Some(e.to_string()))
                }
            };
            let d = done.fetch_add(1, Ordering::Relaxed) + 1;
            let o = if ok {
                ok_c.fetch_add(1, Ordering::Relaxed) + 1
            } else {
                ok_c.load(Ordering::Relaxed)
            };
            let f = if ok {
                failed_c.load(Ordering::Relaxed)
            } else {
                failed_c.fetch_add(1, Ordering::Relaxed) + 1
            };
            on_progress(DownloadProgress {
                job_id,
                profile_id,
                kind,
                total,
                done: d,
                ok: o,
                failed: f,
                current: Some(label),
            });
            ItemResult {
                media_id: row.media_id,
                code: row.code,
                ok,
                error: err,
            }
        }));
    }

    let mut results = Vec::with_capacity(total);
    for h in handles {
        results.push(h.await.unwrap_or(ItemResult {
            media_id: String::new(),
            code: None,
            ok: false,
            error: Some("tarea de descarga perdida".into()),
        }));
    }
    let errors = results
        .iter()
        .filter(|r| !r.ok)
        .map(|r| DownloadError {
            media_id: r.media_id.clone(),
            code: r.code.clone(),
            error: r.error.clone().unwrap_or_else(|| "error desconocido".into()),
        })
        .collect();
    let ok = results.iter().filter(|r| r.ok).count();
    Ok(DownloadSummary {
        total,
        ok,
        failed: total - ok,
        errors,
    })
}

/// Descarga un solo medio con reintentos. `job_id` hace el temp-file único
/// por job: dos jobs concurrentes del mismo medio no escriben en el mismo
/// archivo temporal (corrupción por truncado cruzado).
async fn download_one(
    ig: &IgClient,
    session: &Session,
    row: &MediaRow,
    base_dir: &Path,
    username: &str,
    job_id: i64,
) -> anyhow::Result<DownloadedContent> {
    let mut url = row.best_url.as_deref().context("sin best_url")?.to_string();
    let mut width = None;
    let mut height = None;
    let mut bitrate = None;
    let mut quality_verified = false;
    for attempt in 0..2 {
        match super::api::fetch_media_info_candidate(ig, session, &row.media_id).await {
            Ok(Some(fresh)) => {
                url = fresh.url;
                width = Some(fresh.width);
                height = Some(fresh.height);
                bitrate = (fresh.bitrate > 0).then_some(fresh.bitrate);
                quality_verified = true;
                break;
            }
            _ if attempt == 0 => tokio::time::sleep(std::time::Duration::from_millis(450)).await,
            _ => break,
        }
    }
    let _ = (base_dir, username, job_id);

    let mut last_err: Option<anyhow::Error> = None;
    for attempt in 0..3 {
        let req = ig.http().get(&url);
        match req.send().await {
            Ok(resp) => {
                if !resp.status().is_success() {
                    last_err = Some(anyhow::anyhow!("HTTP {}", resp.status()));
                } else {
                    let mime = resp.headers().get(reqwest::header::CONTENT_TYPE)
                        .and_then(|v| v.to_str().ok()).unwrap_or(
                            if row.media_type == Some(2) { "video/mp4" } else { "image/jpeg" }
                        ).split(';').next().unwrap_or("application/octet-stream").to_string();
                    match resp.bytes().await {
                        Ok(bytes) => {
                            if bytes.is_empty() {
                                last_err = Some(anyhow::anyhow!("respuesta vacía"));
                            } else {
                                return Ok(DownloadedContent {
                                    bytes: bytes.to_vec(), mime_type: mime, width, height, bitrate,
                                    quality_verified,
                                    source: if quality_verified { "fresh_info" } else { "feed_fallback" },
                                });
                            }
                        }
                        Err(e) => last_err = Some(e.into()),
                    }
                }
            }
            Err(e) => last_err = Some(e.into()),
        }
        tokio::time::sleep(std::time::Duration::from_secs(1 << attempt)).await;
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("descarga fallida")))
}

#[allow(dead_code)]
fn extension_from_url(url: &str) -> Option<String> {
    let p = url.split('?').next().unwrap_or(url);
    let path = std::path::PathBuf::from(p);
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .map(|e| {
            if e == "jpeg" {
                "jpg".to_string()
            } else {
                e.to_string()
            }
        })
}
