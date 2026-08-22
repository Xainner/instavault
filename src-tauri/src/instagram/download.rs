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
                Ok(path) => {
                    let _ = db.lock().unwrap().mark_downloaded(db_id, &path);
                    (true, None)
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
) -> anyhow::Result<String> {
    let mut url = row.best_url.as_deref().context("sin best_url")?.to_string();
    // Imágenes: media/{pk}/info/ (el endpoint de la web) da la mejor versión
    // disponible — para stories/highlights es la resolución original sin
    // límite de píxeles — y siempre con firma de CDN fresca (las URLs
    // guardadas expiran). Si falla, se descarga con la URL guardada.
    if row.media_type == Some(1) {
        if let Ok(Some(fresh)) = super::api::fetch_media_info_url(ig, session, &row.media_id).await {
            url = fresh;
        }
    }
    let dir = base_dir.join(username).join(&row.kind);
    std::fs::create_dir_all(&dir)?;

    // Los videos de IG no traen extensión confiable en la URL CDN.
    let ext = if row.media_type == Some(2) {
        "mp4".to_string()
    } else {
        extension_from_url(&url).unwrap_or_else(|| "jpg".to_string())
    };
    let stem = sanitize_filename(if let Some(code) = &row.code {
        code.as_str()
    } else {
        row.media_id.as_str()
    });
    let final_path = dir.join(format!("{stem}.{ext}"));

    // Dedup: ya existe y no está vacío → hecho
    if final_path.exists() && final_path.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(final_path.to_string_lossy().to_string());
    }

    let mut last_err: Option<anyhow::Error> = None;
    for attempt in 0..3 {
        let tmp = dir.join(format!(".{stem}.{ext}.part{attempt}.{job_id}"));
        let req = ig.http().get(&url);
        match req.send().await {
            Ok(resp) => {
                if !resp.status().is_success() {
                    last_err = Some(anyhow::anyhow!("HTTP {}", resp.status()));
                } else {
                    match resp.bytes().await {
                        Ok(bytes) => {
                            tokio::fs::write(&tmp, &bytes).await?;
                            std::fs::rename(&tmp, &final_path)?;
                            return Ok(final_path.to_string_lossy().to_string());
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

fn sanitize_filename(s: &str) -> String {
    let mut out: String = s
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if out.is_empty() {
        out = "media".to_string();
    }
    if out.len() > 80 {
        out.truncate(80);
    }
    out
}
