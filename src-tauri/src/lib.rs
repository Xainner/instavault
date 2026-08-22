mod commands;
pub mod creds;
mod db;
pub mod instagram;

use instagram::client::IgClient;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::Manager;

/// Estado global de la app compartido con los comandos.
pub struct AppState {
    pub db: Arc<Mutex<db::Db>>,
    pub data_dir: PathBuf, // donde se guardan las descargas (accounts/{user}/...)
    pub ig: Arc<IgClient>,
    /// Navegador de login activo (flujo CDP), si hay uno en curso.
    pub cdp: Arc<Mutex<Option<instagram::cdp_login::CdpSession>>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .register_uri_scheme_protocol("vault", |ctx, request| {
            let state = ctx.app_handle().state::<AppState>();
            let path = request.uri().path().trim_matches('/');
            let mut parts = path.split('/');
            let kind = parts.next().unwrap_or_default();
            let id = parts.next().and_then(|v| v.parse::<i64>().ok());
            let content = id.and_then(|id| {
                let lock = state.db.lock().ok()?;
                match kind {
                    "media" => lock.media_content(id).ok().flatten(),
                    "avatar" => lock.avatar_content(id).ok().flatten(),
                    _ => None,
                }
            });
            let Some(content) = content else {
                return tauri::http::Response::builder().status(404).body(Vec::new()).unwrap();
            };
            let total = content.data.len();
            let range = request.headers().get(tauri::http::header::RANGE)
                .and_then(|v| v.to_str().ok()).and_then(|v| parse_range(v, total));
            let (status, start, end) = range.map(|(s,e)| (206, s, e))
                .unwrap_or((200, 0, total.saturating_sub(1)));
            let body = if total == 0 { Vec::new() } else { content.data[start..=end].to_vec() };
            let mut response = tauri::http::Response::builder()
                .status(status)
                .header(tauri::http::header::CONTENT_TYPE, content.mime_type)
                .header(tauri::http::header::ACCEPT_RANGES, "bytes")
                .header(tauri::http::header::CONTENT_LENGTH, body.len().to_string())
                .header(tauri::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
            if status == 206 {
                response = response.header(tauri::http::header::CONTENT_RANGE, format!("bytes {start}-{end}/{total}"));
            }
            response.body(body).unwrap()
        })
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let dl_dir = data_dir.join("downloads");
            std::fs::create_dir_all(&dl_dir).ok();
            let database = db::Db::open(&data_dir)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
            let ig = IgClient::new()
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
            let state = AppState {
                db: Arc::new(Mutex::new(database)),
                data_dir: dl_dir,
                ig: Arc::new(ig),
                cdp: Arc::new(Mutex::new(None)),
            };
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::add_account,
            commands::validate_account,
            commands::list_accounts,
            commands::delete_account,
            commands::list_browser_profiles,
            commands::import_browser_account,
            commands::close_browser,
            commands::login_open,
            commands::login_check,
            commands::login_cancel,
                    commands::warm_search_engine,
                    commands::fetch_profile,
                    commands::list_profiles,
                    commands::delete_profile,
                    commands::get_media,
                    commands::sync_posts,
                    commands::sync_stories,
                    commands::sync_highlights,
commands::download_profile,
                     commands::download_media,
                     commands::reset_download,
                     commands::clear_downloads,
commands::set_profile_favorite,
                     commands::download_avatar,
                     commands::get_profile_stats,
commands::list_download_jobs,
                     commands::clear_finished_jobs,
                     commands::export_media,
                     commands::export_avatar,
                ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn parse_range(value: &str, total: usize) -> Option<(usize, usize)> {
    let spec = value.strip_prefix("bytes=")?.split(',').next()?;
    let (start, end) = spec.split_once('-')?;
    let start = start.parse::<usize>().ok()?;
    if start >= total { return None; }
    let end = end.parse::<usize>().ok().unwrap_or(total.saturating_sub(1));
    Some((start, end.min(total.saturating_sub(1))))
}
