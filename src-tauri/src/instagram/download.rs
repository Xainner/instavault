use super::client::{IgClient, Session};
use super::models::MediaRow;
use anyhow::Context;
use std::path::Path;
use std::sync::{Arc, Mutex};

/// Descarga todos los medios en estado 'metadata' hacia disco.
/// `username` es el dueño (ruta base llama accounts/{username}/{kind}/).
/// Devuelve (descargados, fallidos) y escribe el estado en BD.
pub async fn download_all(
    ig: &IgClient,
    session: &Session,
    db: Arc<Mutex<crate::db::Db>>,
    base_dir: &Path,
    username: &str,
    rows: Vec<MediaRow>,
    concurrency: usize,
) -> anyhow::Result<(usize, usize)> {
    let sem = Arc::new(tokio::sync::Semaphore::new(concurrency.max(1)));
    let mut handles = Vec::new();
    for row in rows {
        let permit = sem.clone().acquire_owned().await?;
        let ig = ig.clone();
        let session = session.clone();
        let db = db.clone();
        let base_dir = base_dir.to_path_buf();
        let username = username.to_string();
        handles.push(tokio::spawn(async move {
            let _permit = permit;
            let media_id = row.id.unwrap_or(0);
            match download_one(&ig, &session, &row, &base_dir, &username).await {
                Ok(path) => {
                    let _ = db.lock().unwrap().mark_downloaded(media_id, &path);
                    true
                }
                Err(e) => {
                    let _ = db.lock().unwrap().mark_failed(media_id, &e.to_string());
                    false
                }
            }
        }));
    }

    let mut ok = 0;
    let mut fail = 0;
    for h in handles {
        if h.await.unwrap_or(false) {
            ok += 1;
        } else {
            fail += 1;
        }
    }
    Ok((ok, fail))
}

/// Descarga un solo medio con reintentos.
async fn download_one(
    ig: &IgClient,
    _session: &Session,
    row: &MediaRow,
    base_dir: &Path,
    username: &str,
) -> anyhow::Result<String> {
    let _ = _session; // las URLs de la CDN no requieren cookies
    let url = row.best_url.as_deref().context("sin best_url")?;
    let dir = base_dir.join(username).join(&row.kind);
    std::fs::create_dir_all(&dir)?;

    let ext = extension_from_url(url).unwrap_or_else(|| "jpg".to_string());
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
        let tmp = dir.join(format!(".{stem}.{ext}.part{attempt}"));
        let req = ig.http().get(url);
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
