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
                     commands::copy_file_to,
                ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
