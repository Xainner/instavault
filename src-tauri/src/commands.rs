use crate::creds;
use crate::db::Db;
use crate::instagram::download;
use crate::instagram::models::{
    AccountInfo, DownloadJob, DownloadSummary, MediaRow, ProfileRow, ProfileStats, SyncAccessMode,
    SyncProgressRow, SyncStatus, SyncSummary,
};
use crate::AppState;
use std::net::ToSocketAddrs;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

type DbLock = Arc<Mutex<Db>>;

fn db(state: &AppState) -> DbLock {
    state.db.clone()
}

fn account_from_row(r: &(i64, String, String, String, Option<i64>)) -> AccountInfo {
    AccountInfo {
        id: r.0,
        username: r.1.clone(),
        status: r.3.clone(),
        last_valid: r.4,
    }
}

// ---------------------------------------------------------------------------
// Cuentas
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_accounts(state: tauri::State<'_, AppState>) -> Result<Vec<AccountInfo>, String> {
    let rows = db(&state)
        .lock()
        .unwrap()
        .list_accounts()
        .map_err(|e| format!("{e:#}"))?;
    Ok(rows.iter().map(account_from_row).collect())
}

#[tauri::command]
pub fn delete_account(state: tauri::State<'_, AppState>, account_id: i64) -> Result<(), String> {
    creds::delete_cookies(account_id);
    db(&state)
        .lock()
        .unwrap()
        .delete_account(account_id)
        .map_err(|e| format!("{e:#}"))
}

// ---------------------------------------------------------------------------
// Login con navegador propio (CDP)
// ---------------------------------------------------------------------------

/// Abre la ventana de login de Instagram (navegador de InstaVault).
#[tauri::command]
pub fn login_open(state: tauri::State<'_, AppState>) -> Result<(), String> {
    use crate::instagram::cdp_login::CdpSession;
    let mut guard = state.cdp.lock().unwrap();
    // Limpia cualquier instancia previa (del mismo perfil) que bloquee el
    // puerto CDP y cause timeout de conexión (os error 10060).
    if guard.is_some() {
        let mut s = guard.take().unwrap();
        s.shutdown();
    }
    CdpSession::kill_existing();
    std::thread::sleep(std::time::Duration::from_millis(600));
    *guard = Some(CdpSession::launch().map_err(|e| format!("{e:#}"))?);
    let sess = guard.as_mut().unwrap();
    // El puerto debe quedar listo antes de devolver el control a la UI.
    sess.wait_ready().map_err(|e| {
        *guard = None;
        e.to_string()
    })
}

#[tauri::command]
pub fn connect_private_account(state: tauri::State<'_, AppState>) -> Result<(), String> {
    login_open(state)
}

/// Consulta si ya hay sesión de Instagram capturable; si sí, crea la cuenta.
#[tauri::command]
pub async fn login_check(state: tauri::State<'_, AppState>) -> Result<Option<AccountInfo>, String> {
    use crate::instagram::cdp_login;
    // Tareas bloqueantes en hilo aparte.
    let cdp = std::sync::Arc::clone(&state.cdp);
    let result = tokio::task::spawn_blocking(move || -> Result<Option<String>, String> {
        let mut guard = cdp.lock().map_err(|e| format!("{e:#}"))?;
        let Some(sess) = guard.as_mut() else {
            return Err("no hay navegador de login activo".to_string());
        };
        if !sess.is_alive() {
            *guard = None;
            return Err("la ventana de login se cerró sin completar el login".to_string());
        }
        // Valida dentro del navegador dedicado. Las cookies nunca se extraen,
        // copian al llavero ni se entregan al cliente HTTP.
        let username = cdp_login::current_user_via_page(sess.port())
            .map_err(|e| format!("{e:#}"))?
            .filter(|value| !value.is_empty());
        Ok(username)
    })
    .await
    .map_err(|e| format!("{e:#}"))??;

    let Some(username) = result else {
        return Ok(None); // el usuario todavía está completando el login
    };
    let id = db(&state)
        .lock()
        .unwrap()
        .add_browser_account(&username)
        .map_err(|e| format!("{e:#}"))?;
    // Elimina cualquier credencial antigua sólo después de confirmar que el
    // perfil dedicado quedó conectado.
    creds::delete_cookies(id);
    let account = db(&state)
        .lock()
        .unwrap()
        .list_accounts()
        .map_err(|e| format!("{e:#}"))?
        .iter()
        .find(|row| row.0 == id)
        .map(account_from_row)
        .ok_or_else(|| "no se pudo releer la cuenta".to_string())?;
    Ok(Some(account))
}

/// Cancela el flujo de login y cierra el navegador.
#[tauri::command]
pub fn login_cancel(state: tauri::State<'_, AppState>) -> Result<(), String> {
    if let Ok(mut guard) = state.cdp.lock() {
        if let Some(mut s) = guard.take() {
            s.shutdown();
        }
    }
    Ok(())
}

#[tauri::command]
pub fn disconnect_private_account(
    state: tauri::State<'_, AppState>,
    account_id: i64,
) -> Result<(), String> {
    if let Ok(mut guard) = state.cdp.lock() {
        if let Some(mut browser) = guard.take() {
            browser.shutdown();
        }
    }
    creds::delete_cookies(account_id);
    db(&state)
        .lock()
        .unwrap()
        .set_account_status(account_id, "reconnect_required")
        .map_err(|e| format!("{e:#}"))
}

// ---------------------------------------------------------------------------
// Perfiles
// ---------------------------------------------------------------------------

/// Búsqueda remota estrictamente anónima. No recibe account_id a propósito:
/// esto hace imposible que el frontend filtre credenciales por accidente.
#[tauri::command]
pub async fn lookup_public_profile(
    state: tauri::State<'_, AppState>,
    username: String,
) -> Result<ProfileRow, String> {
    let (operation_id, _) = begin_operation(&state)?;
    let provider = crate::instagram::provider::WebProvider::public(state.public_cdp.clone());
    let result = tokio::task::spawn_blocking(move || provider.lookup_profile(&username)).await;
    finish_operation(&state, &operation_id);
    let row = result
        .map_err(|e| format!("{{\"code\":\"network\",\"message\":\"{e}\"}}"))?
        .map_err(provider_error)?;
    let id = db(&state)
        .lock()
        .unwrap()
        .upsert_profile(&row)
        .map_err(|e| format!("{e:#}"))?;
    Ok(ProfileRow {
        id: Some(id),
        ..row
    })
}

/// Segundo paso deliberado cuando la búsqueda pública no puede resolver un
/// perfil. La sesión privada sólo se abre en esta función.
#[tauri::command]
pub async fn add_private_profile(
    state: tauri::State<'_, AppState>,
    username: String,
    account_id: i64,
) -> Result<ProfileRow, String> {
    ensure_account_selected(&state, account_id)?;
    let (operation_id, _) = begin_operation(&state)?;
    let provider = crate::instagram::provider::WebProvider::private(state.cdp.clone());
    let result = tokio::task::spawn_blocking(move || provider.lookup_profile(&username)).await;
    finish_operation(&state, &operation_id);
    let row = result
        .map_err(|e| format!("{{\"code\":\"network\",\"message\":\"{e}\"}}"))?
        .map_err(provider_error)?;
    let id = db(&state)
        .lock()
        .unwrap()
        .upsert_profile(&row)
        .map_err(|e| format!("{e:#}"))?;
    Ok(ProfileRow {
        id: Some(id),
        ..row
    })
}

#[tauri::command]
pub fn list_profiles(state: tauri::State<'_, AppState>) -> Result<Vec<ProfileRow>, String> {
    db(&state)
        .lock()
        .unwrap()
        .list_profiles()
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn delete_profile(state: tauri::State<'_, AppState>, profile_id: i64) -> Result<(), String> {
    db(&state)
        .lock()
        .unwrap()
        .delete_profile_cascade(profile_id)
        .map_err(|e| format!("{e:#}"))
        .map(|_| ())
}

/// Borra el archivo descargado de UN medio y lo marca pendiente, para
/// poder re-descargarlo (p.ej. con mejor calidad o firma fresca).
#[tauri::command]
pub fn reset_download(state: tauri::State<'_, AppState>, media_pk: i64) -> Result<(), String> {
    let dbl = db(&state);
    {
        let lock = dbl.lock().unwrap();
        let row = lock
            .get_media_by_id(media_pk)
            .map_err(|e| format!("{e:#}"))?
            .ok_or_else(|| "medio no encontrado".to_string())?;
        if row.status != "downloaded" {
            return Err("el medio no está descargado".to_string());
        }
        lock.reset_download(media_pk)
            .map_err(|e| format!("{e:#}"))?;
    }
    Ok(())
}

/// Borra TODOS los archivos descargados de un perfil (o de un kind) y los
/// marca pendientes. La metadatos quedan en la base para re-descargar.
#[tauri::command]
pub fn clear_downloads(
    state: tauri::State<'_, AppState>,
    profile_id: i64,
    kind: Option<String>,
) -> Result<usize, String> {
    let dbl = db(&state);
    let n = dbl
        .lock()
        .unwrap()
        .reset_downloads_profile(profile_id, kind.as_deref())
        .map_err(|e| format!("{e:#}"))?;
    Ok(n)
}

#[tauri::command]
pub fn get_media(
    state: tauri::State<'_, AppState>,
    profile_id: i64,
    kind: Option<String>,
) -> Result<Vec<MediaRow>, String> {
    db(&state)
        .lock()
        .unwrap()
        .media_by_profile(profile_id, kind.as_deref())
        .map_err(|e| format!("{e:#}"))
}

// ---------------------------------------------------------------------------
// Sincronización (fetch metadata → BD)
// ---------------------------------------------------------------------------

fn profile_requires_auth(is_private: Option<i64>) -> bool {
    is_private == Some(1)
}

fn provider_error(error: crate::instagram::provider::ProviderError) -> String {
    serde_json::to_string(&error).unwrap_or_else(|_| error.to_string())
}

fn ensure_account_selected(state: &AppState, account_id: i64) -> Result<(), String> {
    if account_id <= 0 {
        return Err(provider_error(crate::instagram::provider::ProviderError {
            code: "private_login_required",
            message: "Selecciona y conecta una cuenta para este perfil privado.".into(),
            retryable: false,
        }));
    }
    let account = db(state)
        .lock()
        .unwrap()
        .list_accounts()
        .map_err(|e| format!("{e:#}"))?
        .into_iter()
        .find(|row| row.0 == account_id);
    let Some(account) = account else {
        return Err("cuenta privada no encontrada".into());
    };
    if account.3 != "valid" {
        return Err(provider_error(crate::instagram::provider::ProviderError {
            code: "private_login_required",
            message: "Esta cuenta necesita reconectarse antes de usar perfiles privados.".into(),
            retryable: false,
        }));
    }
    Ok(())
}

fn begin_operation(
    state: &AppState,
) -> Result<(String, Arc<std::sync::atomic::AtomicBool>), String> {
    let mut operation = state
        .instagram_operation
        .lock()
        .map_err(|_| "estado de sincronización ocupado")?;
    if operation.is_some() {
        return Err("ya hay una operación de Instagram en curso".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
    *operation = Some((id.clone(), cancelled.clone()));
    Ok((id, cancelled))
}

fn finish_operation(state: &AppState, id: &str) {
    if let Ok(mut operation) = state.instagram_operation.lock() {
        if operation.as_ref().map(|value| value.0.as_str()) == Some(id) {
            *operation = None;
        }
    }
}

#[tauri::command]
pub fn cancel_sync(state: tauri::State<'_, AppState>, operation_id: String) -> Result<(), String> {
    let operation = state
        .instagram_operation
        .lock()
        .map_err(|_| "estado de sincronización ocupado")?;
    let Some((id, cancelled)) = operation.as_ref() else {
        return Ok(());
    };
    if id == &operation_id {
        cancelled.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
pub async fn sync_posts(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    account_id: i64,
    username: String,
    max_pages: u32,
) -> Result<usize, String> {
    let profile_id = db(&state)
        .lock()
        .unwrap()
        .get_profile_id(&username)
        .map_err(|_| "perfil no encontrado; búscalo primero".to_string())?;
    sync_profile_inner(
        &app,
        &state,
        profile_id,
        "post".into(),
        Some(account_id),
        max_pages.clamp(1, 12),
    )
    .await
}

#[tauri::command]
pub async fn sync_stories(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    account_id: i64,
    username: String,
) -> Result<usize, String> {
    let profile_id = db(&state)
        .lock()
        .unwrap()
        .get_profile_id(&username)
        .map_err(|_| "perfil no encontrado; búscalo primero".to_string())?;
    sync_profile_inner(
        &app,
        &state,
        profile_id,
        "story".into(),
        Some(account_id),
        1,
    )
    .await
}

#[tauri::command]
pub async fn sync_highlights(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    account_id: i64,
    username: String,
) -> Result<usize, String> {
    let profile_id = db(&state)
        .lock()
        .unwrap()
        .get_profile_id(&username)
        .map_err(|_| "perfil no encontrado; búscalo primero".to_string())?;
    sync_profile_inner(
        &app,
        &state,
        profile_id,
        "highlight".into(),
        Some(account_id),
        1,
    )
    .await
}

#[tauri::command]
pub async fn sync_profile(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    profile_id: i64,
    kind: String,
    account_id: Option<i64>,
) -> Result<usize, String> {
    let max_pages = if kind == "post" { 12 } else { 1 };
    sync_profile_inner(&app, &state, profile_id, kind, account_id, max_pages).await
}

#[tauri::command]
pub fn get_sync_progress(
    state: tauri::State<'_, AppState>,
    profile_id: i64,
    kind: String,
) -> Result<Option<SyncProgressRow>, String> {
    db(&state)
        .lock()
        .unwrap()
        .sync_progress(profile_id, &kind)
        .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
pub async fn sync_feed(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    profile_id: i64,
    account_id: Option<i64>,
    access_mode: SyncAccessMode,
    continuation: bool,
    batch_size: usize,
) -> Result<SyncSummary, String> {
    let profile = db(&state)
        .lock()
        .unwrap()
        .get_profile_by_id(profile_id)
        .map_err(|error| format!("{error:#}"))?
        .ok_or_else(|| "perfil no encontrado".to_string())?;
    let private = profile_requires_auth(profile.is_private);
    if private && access_mode == SyncAccessMode::PublicAnonymous {
        return Err(provider_error(crate::instagram::provider::ProviderError {
            code: "private_login_required",
            message: "Este perfil privado requiere una operación autenticada explícita.".into(),
            retryable: false,
        }));
    }
    if access_mode == SyncAccessMode::AuthenticatedExplicit {
        ensure_account_selected(&state, account_id.unwrap_or_default())?;
    }
    let prior = if continuation {
        db(&state)
            .lock()
            .unwrap()
            .sync_progress(profile_id, "post")
            .map_err(|error| format!("{error:#}"))?
    } else {
        None
    };
    let checkpoint = prior.as_ref().and_then(|row| row.last_shortcode.clone());
    let batch_size = batch_size.clamp(1, 60);
    let (operation_id, cancelled) = begin_operation(&state)?;
    let _ = app.emit(
        "sync:state",
        serde_json::json!({
            "operation_id": operation_id,
            "stage": if continuation { "Reanudando cuadrícula" } else { "Leyendo cuadrícula" },
            "kind": "post", "profile_id": profile_id,
            "publications": 0, "assets": 0
        }),
    );
    let browser = if access_mode == SyncAccessMode::PublicAnonymous {
        state.public_cdp.clone()
    } else {
        state.cdp.clone()
    };
    let username = profile.username.clone();
    let mode_for_provider = access_mode.clone();
    let checkpoint_for_provider = checkpoint.clone();
    let cancelled_for_provider = cancelled.clone();
    let result = tokio::task::spawn_blocking(move || {
        let provider = if mode_for_provider == SyncAccessMode::PublicAnonymous {
            crate::instagram::provider::WebProvider::public(browser)
        } else {
            crate::instagram::provider::WebProvider::private(browser)
        };
        provider.sync_media_batch(
            &username,
            "post",
            batch_size,
            checkpoint_for_provider.as_deref(),
            Some(cancelled_for_provider.as_ref()),
        )
    })
    .await
    .map_err(|error| format!("falló la tarea de sincronización: {error}"));

    let outcome: Result<SyncSummary, String> = async {
        match result {
            Ok(Ok(batch)) => {
                let existing = {
                    let lock = db(&state);
                    let lock = lock.lock().unwrap();
                    batch
                        .publication_codes
                        .iter()
                        .filter_map(|code| {
                            lock.publication_exists(profile_id, "post", code)
                                .ok()
                                .map(|exists| (code.clone(), exists))
                        })
                        .collect::<std::collections::HashMap<_, _>>()
                };
                let new_publications = batch
                    .publication_codes
                    .iter()
                    .filter(|code| !existing.get(*code).copied().unwrap_or(false))
                    .count();
                let updated_publications = batch
                    .publication_codes
                    .len()
                    .saturating_sub(new_publications);
                let asset_count = batch.media.len();
                let _ = app.emit(
                    "sync:state",
                    serde_json::json!({
                        "operation_id": operation_id, "stage":"Guardando en la biblioteca",
                        "kind":"post", "profile_id":profile_id,
                        "publications":batch.publication_codes.len(), "assets":asset_count
                    }),
                );
                let (_, thumbnails) =
                    store_extracted_media(&state, profile_id, "post", batch.media);
                cache_media_thumbnails(&state, thumbnails).await;
                let local_publications = db(&state)
                    .lock()
                    .unwrap()
                    .publication_count(profile_id, "post")
                    .map_err(|error| format!("{error:#}"))?;
                let last_shortcode = batch.publication_codes.last().cloned().or(checkpoint);
                let publications_seen =
                    prior.as_ref().map(|row| row.publications_seen).unwrap_or(0)
                        + batch.publication_codes.len();
                let continuation_available = matches!(
                    batch.status,
                    SyncStatus::MoreAvailable | SyncStatus::AnonymousLimit | SyncStatus::Stalled
                );
                let progress = SyncProgressRow {
                    profile_id,
                    kind: "post".into(),
                    access_mode: access_mode.clone(),
                    last_shortcode: last_shortcode.clone(),
                    publications_seen,
                    status: batch.status.clone(),
                    stop_reason: batch.stop_reason.clone(),
                    updated_at: chrono::Utc::now().timestamp(),
                };
                let lock = db(&state);
                let lock = lock.lock().unwrap();
                lock.save_sync_progress(&progress)
                    .map_err(|error| format!("{error:#}"))?;
                let _ = lock.record_sync(profile_id, "post");
                Ok(SyncSummary {
                    profile_id,
                    kind: "post".into(),
                    status: batch.status,
                    access_mode,
                    batch_publications: batch.publication_codes.len(),
                    new_publications,
                    updated_publications,
                    asset_count,
                    local_publications,
                    continuation_available,
                    stop_reason: batch.stop_reason,
                    last_shortcode,
                })
            }
            Ok(Err(error)) => Err(provider_error(error)),
            Err(error) => Err(error),
        }
    }
    .await;
    finish_operation(&state, &operation_id);
    let _ = app.emit(
        "sync:state",
        serde_json::json!({"operation_id":operation_id,"stage":"finished","profile_id":profile_id}),
    );
    outcome
}

async fn sync_profile_inner(
    app: &AppHandle,
    state: &AppState,
    profile_id: i64,
    kind: String,
    account_id: Option<i64>,
    _max_pages: u32,
) -> Result<usize, String> {
    if !matches!(kind.as_str(), "post" | "story" | "highlight") {
        return Err("tipo de contenido inválido".into());
    }
    let profile = db(state)
        .lock()
        .unwrap()
        .get_profile_by_id(profile_id)
        .map_err(|e| format!("{e:#}"))?
        .ok_or_else(|| "perfil no encontrado".to_string())?;
    let private = profile_requires_auth(profile.is_private);
    if private {
        ensure_account_selected(state, account_id.unwrap_or_default())?;
    }
    let (operation_id, cancelled) = begin_operation(state)?;
    let _ = app.emit("sync:state", serde_json::json!({
        "operation_id": operation_id, "stage": if private { "Preparando sesión privada" } else { "Preparando acceso anónimo" },
        "kind": kind, "profile_id": profile_id
    }));

    let browser = if private {
        state.cdp.clone()
    } else {
        state.public_cdp.clone()
    };
    let username = profile.username.clone();
    let kind_for_provider = kind.clone();
    let result = tokio::task::spawn_blocking(move || {
        if cancelled.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(crate::instagram::provider::ProviderError {
                code: "cancelled",
                message: "Sincronización cancelada.".into(),
                retryable: false,
            });
        }
        let provider = if private {
            crate::instagram::provider::WebProvider::private(browser)
        } else {
            crate::instagram::provider::WebProvider::public(browser)
        };
        let result = provider.sync_media(&username, &kind_for_provider);
        if cancelled.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(crate::instagram::provider::ProviderError {
                code: "cancelled",
                message: "Sincronización cancelada.".into(),
                retryable: false,
            });
        }
        result
    })
    .await
    .map_err(|e| format!("falló la tarea de sincronización: {e}"))?;

    let outcome = match result {
        Ok(extracted) => {
            let _ = app.emit("sync:state", serde_json::json!({"operation_id": operation_id, "stage":"Guardando en la biblioteca"}));
            let (count, thumbnails) = store_extracted_media(state, profile_id, &kind, extracted);
            let _ = app.emit("sync:state", serde_json::json!({"operation_id": operation_id, "stage":"Guardando miniaturas locales"}));
            cache_media_thumbnails(state, thumbnails).await;
            let lock = db(state);
            let lock = lock.lock().unwrap();
            let _ = lock.reset_failed(profile_id, &kind);
            let _ = lock.record_sync(profile_id, &kind);
            Ok(count)
        }
        Err(error) => Err(provider_error(error)),
    };
    finish_operation(state, &operation_id);
    let _ = app.emit(
        "sync:state",
        serde_json::json!({"operation_id": operation_id, "stage":"finished"}),
    );
    outcome
}

fn store_extracted_media(
    state: &AppState,
    profile_id: i64,
    kind: &str,
    extracted: Vec<crate::instagram::models::ExtractedMedia>,
) -> (usize, Vec<(i64, String)>) {
    let lock = db(state);
    let lock = lock.lock().unwrap();
    let mut count = 0;
    let mut thumbnails = Vec::new();
    for media in extracted {
        let thumbnail_url = media.thumbnail_url.clone();
        let prefix = match kind {
            "story" => "st_",
            "highlight" => "hl_",
            _ => "",
        };
        let media_id = if media.media_id.starts_with(prefix) {
            media.media_id.clone()
        } else {
            format!("{prefix}{}", media.media_id)
        };
        let row = MediaRow {
            media_id,
            publication_code: media.publication_code.or_else(|| media.code.clone()),
            child_index: media.child_index,
            profile_id: Some(profile_id),
            kind: kind.to_string(),
            code: media.code,
            taken_at: media.taken_at,
            caption: media.caption,
            media_type: Some(media.media_type),
            thumbnail_url: media.thumbnail_url,
            thumbnail_content_url: None,
            best_url: Some(media.best_url),
            local_path: None,
            has_content: false,
            content_url: None,
            byte_size: media.byte_size,
            width: media.width,
            height: media.height,
            bitrate: media.bitrate,
            quality_verified: media.quality_verified,
            status: "metadata".into(),
            error: None,
            created_at: Some(chrono::Utc::now().timestamp()),
            id: None,
        };
        if let Ok(id) = lock.upsert_media(&row) {
            count += 1;
            if let Some(url) = thumbnail_url.filter(|url| url.starts_with("http")) {
                thumbnails.push((id, url));
            }
        }
    }
    (count, thumbnails)
}

async fn cache_media_thumbnails(state: &AppState, thumbnails: Vec<(i64, String)>) {
    let semaphore = Arc::new(tokio::sync::Semaphore::new(4));
    let mut tasks = tokio::task::JoinSet::new();
    for (id, url) in thumbnails {
        let permit = semaphore.clone().acquire_owned().await;
        let Ok(permit) = permit else { continue };
        let client = state.ig.clone();
        let database = state.db.clone();
        tasks.spawn(async move {
            let _permit = permit;
            let response = client.http().get(url).send().await.ok()?;
            if !response.status().is_success() {
                return None;
            }
            let mime = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("image/jpeg")
                .split(';')
                .next()
                .unwrap_or("image/jpeg")
                .to_string();
            if !mime.starts_with("image/") {
                return None;
            }
            let bytes = response.bytes().await.ok()?;
            if bytes.is_empty() || bytes.len() > 8 * 1024 * 1024 {
                return None;
            }
            database
                .lock()
                .ok()?
                .store_media_thumbnail(id, &bytes, &mime)
                .ok()?;
            Some(())
        });
    }
    while tasks.join_next().await.is_some() {}
}

async fn refresh_download_candidates(
    app: &AppHandle,
    state: &AppState,
    profile_id: i64,
    username: &str,
    kind: &str,
    private: bool,
) -> Result<(), String> {
    let (operation_id, _) = begin_operation(state)?;
    let _ = app.emit(
        "sync:state",
        serde_json::json!({
            "operation_id": operation_id, "stage": "Verificando calidad disponible",
            "kind": kind, "profile_id": profile_id
        }),
    );
    let browser = if private {
        state.cdp.clone()
    } else {
        state.public_cdp.clone()
    };
    let username = username.to_string();
    let kind_owned = kind.to_string();
    let result = tokio::task::spawn_blocking(move || {
        let provider = if private {
            crate::instagram::provider::WebProvider::private(browser)
        } else {
            crate::instagram::provider::WebProvider::public(browser)
        };
        provider.sync_media(&username, &kind_owned)
    })
    .await
    .map_err(|error| format!("falló el refresco de calidad: {error}"));
    finish_operation(state, &operation_id);
    let _ = app.emit(
        "sync:state",
        serde_json::json!({"operation_id": operation_id, "stage":"finished"}),
    );
    match result {
        Ok(Ok(extracted)) => {
            let (_, thumbnails) = store_extracted_media(state, profile_id, kind, extracted);
            cache_media_thumbnails(state, thumbnails).await;
            Ok(())
        }
        Ok(Err(error))
            if matches!(
                error.code,
                "challenge_required" | "rate_limited" | "private_login_required"
            ) =>
        {
            Err(provider_error(error))
        }
        _ => {
            db(state)
                .lock()
                .unwrap()
                .mark_candidates_unverified(profile_id, kind)
                .map_err(|error| format!("no se pudo marcar la calidad: {error:#}"))?;
            Ok(())
        }
    }
}

// ---------------------------------------------------------------------------
// Descarga
// ---------------------------------------------------------------------------

/// Descarga un lote (kind completo). `include_failed` reintenta los fallidos
/// ("Reintentar fallidos"); si no, solo los pendientes (metadata).
/// Emite `download:progress` por ítem; el retorno es el resumen autoritativo.
#[tauri::command]
pub async fn download_profile(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    account_id: i64,
    profile_id: i64,
    kind: String,
    include_failed: bool,
    concurrency: usize,
) -> Result<DownloadSummary, String> {
    let private = db(&state)
        .lock()
        .unwrap()
        .get_profile_by_id(profile_id)
        .map_err(|e| format!("{e:#}"))?
        .map(|p| profile_requires_auth(p.is_private))
        .unwrap_or(false);
    if private {
        ensure_account_selected(&state, account_id)?;
    }
    let ig = state.ig.clone();
    let dbl = db(&state);
    let username = {
        let lock = dbl.lock().unwrap();
        lock.get_profile_by_id(profile_id)
            .map_err(|e| format!("{e:#}"))?
            .map(|p| p.username)
            .ok_or_else(|| "perfil no encontrado".to_string())?
    };
    refresh_download_candidates(&app, &state, profile_id, &username, &kind, private).await?;
    let rows = dbl
        .lock()
        .unwrap()
        .media_by_profile(profile_id, Some(&kind))
        .map_err(|e| format!("{e:#}"))?
        .into_iter()
        .filter(|m| {
            m.best_url.is_some()
                && (m.status == "metadata" || (include_failed && m.status == "failed"))
        })
        .collect::<Vec<_>>();
    if rows.is_empty() {
        return Ok(DownloadSummary {
            total: 0,
            ok: 0,
            failed: 0,
            errors: Vec::new(),
        });
    }
    if dbl
        .lock()
        .unwrap()
        .has_active_job(profile_id, &kind)
        .map_err(|e| format!("{e:#}"))?
    {
        return Err("ya hay una descarga en curso para este perfil".to_string());
    }
    let job_id = dbl
        .lock()
        .unwrap()
        .insert_job(profile_id, &kind, rows.len() as i64)
        .map_err(|e| format!("{e:#}"))?;
    let base = state.data_dir.clone();
    let summary = download::download_all(
        &ig,
        dbl.clone(),
        &base,
        &username,
        rows,
        concurrency,
        profile_id,
        &kind,
        job_id,
        move |p| {
            let _ = app.emit("download:progress", p);
        },
    )
    .await
    .map_err(|e| format!("{e:#}"))?;
    let _ = dbl
        .lock()
        .unwrap()
        .finish_job(job_id, summary.ok as i64, summary.failed as i64);
    Ok(summary)
}

/// Descarga/reintenta UN medio. Misma maquinaria que el lote (job de 1 ítem).
#[tauri::command]
pub async fn download_media(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    account_id: i64,
    media_pk: i64,
) -> Result<DownloadSummary, String> {
    let ig = state.ig.clone();
    let dbl = db(&state);
    let (profile_id, username, kind) = {
        let lock = dbl.lock().unwrap();
        let row = lock
            .get_media_by_id(media_pk)
            .map_err(|e| format!("{e:#}"))?
            .ok_or_else(|| "medio no encontrado".to_string())?;
        let profile_id = row
            .profile_id
            .ok_or_else(|| "medio sin perfil".to_string())?;
        let kind = row.kind.clone();
        let username = lock
            .get_profile_by_id(profile_id)
            .map_err(|e| format!("{e:#}"))?
            .map(|p| p.username)
            .ok_or_else(|| "perfil no encontrado".to_string())?;
        (profile_id, username, kind)
    };
    let private = dbl
        .lock()
        .unwrap()
        .get_profile_by_id(profile_id)
        .map_err(|e| format!("{e:#}"))?
        .map(|p| profile_requires_auth(p.is_private))
        .unwrap_or(false);
    if private {
        ensure_account_selected(&state, account_id)?;
    }
    refresh_download_candidates(&app, &state, profile_id, &username, &kind, private).await?;
    let row = dbl
        .lock()
        .unwrap()
        .get_media_by_id(media_pk)
        .map_err(|e| format!("{e:#}"))?
        .ok_or_else(|| "medio no encontrado después del refresco".to_string())?;
    if dbl
        .lock()
        .unwrap()
        .has_active_job(profile_id, &kind)
        .map_err(|e| format!("{e:#}"))?
    {
        return Err("ya hay una descarga en curso para este perfil".to_string());
    }
    let job_id = dbl
        .lock()
        .unwrap()
        .insert_job(profile_id, &kind, 1)
        .map_err(|e| format!("{e:#}"))?;
    let base = state.data_dir.clone();
    let summary = download::download_all(
        &ig,
        dbl.clone(),
        &base,
        &username,
        vec![row],
        1,
        profile_id,
        &kind,
        job_id,
        move |p| {
            let _ = app.emit("download:progress", p);
        },
    )
    .await
    .map_err(|e| format!("{e:#}"))?;
    let _ = dbl
        .lock()
        .unwrap()
        .finish_job(job_id, summary.ok as i64, summary.failed as i64);
    Ok(summary)
}

// ---------------------------------------------------------------------------
// Favoritos y estado (studio)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn set_profile_favorite(
    state: tauri::State<'_, AppState>,
    profile_id: i64,
    favorite: bool,
) -> Result<(), String> {
    db(&state)
        .lock()
        .unwrap()
        .set_favorite(profile_id, favorite)
        .map_err(|e| format!("{e:#}"))
}

/// Localiza la foto de perfil en `%APPDATA%/…/avatars/{id}.jpg` y devuelve
/// la ruta (o la ruta ya cacheada). Motivo: las URLs firmadas de la CDN
/// expiran en días, y el IPv6 de esa CDN está caído en esta red (DNS devuelve
/// una AAAA blackhole y el WebView no logra conectar). Se descarga una vez
/// desde Rust forzando IPv4 y se sirve vía asset-protocol.
#[tauri::command]
pub async fn download_avatar(
    state: tauri::State<'_, AppState>,
    profile_id: i64,
) -> Result<Option<String>, String> {
    let dbl = db(&state);
    let (url, cached) = {
        let lock = dbl.lock().unwrap();
        let p = lock
            .get_profile_by_id(profile_id)
            .map_err(|e| format!("{e:#}"))?
            .ok_or_else(|| "perfil no encontrado".to_string())?;
        (p.profile_pic_url.clone(), p.avatar_local_path.clone())
    };
    if let Some(p) =
        cached.filter(|p| p.contains("vault.localhost") || std::path::Path::new(p).is_file())
    {
        return Ok(Some(p));
    }
    let url = url.ok_or_else(|| "el perfil no tiene URL de foto".to_string())?;
    // Fuerza IPv4 si hay registro A: el AAAA de la CDN está blackholeado y
    // esperar el timeout de SYN de IPv6 tardaría ~20 s por intento.
    let host = url::Url::parse(&url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()));
    let v4 = host.as_ref().and_then(|h| {
        (h.as_str(), 443u16)
            .to_socket_addrs()
            .ok()
            .and_then(|mut it| it.find(|a| a.is_ipv4()))
    });
    let mut builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(20));
    if let (Some(h), Some(addr)) = (&host, v4) {
        builder = builder.resolve(h, addr);
    }
    let client = builder.build().map_err(|e| format!("{e:#}"))?;
    let resp = client
        .get(&url)
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        )
        .send()
        .await
        .map_err(|e| format!("no se pudo descargar la foto: {e}"))?
        .error_for_status()
        .map_err(|e| format!("la CDN rechazó la foto: {e}"))?;
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .split(';')
        .next()
        .unwrap_or("image/jpeg")
        .to_string();
    let bytes = resp.bytes().await.map_err(|e| format!("{e:#}"))?;
    if bytes.len() < 100 {
        return Err("la respuesta de la foto no parece una imagen".to_string());
    }
    dbl.lock()
        .unwrap()
        .store_avatar_content(profile_id, &bytes, &mime)
        .map_err(|e| format!("{e:#}"))?;
    Ok(Some(format!("http://vault.localhost/avatar/{profile_id}")))
}

#[tauri::command]
pub fn get_profile_stats(state: tauri::State<'_, AppState>) -> Result<Vec<ProfileStats>, String> {
    db(&state)
        .lock()
        .unwrap()
        .profile_stats()
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn list_download_jobs(
    state: tauri::State<'_, AppState>,
    limit: Option<i64>,
) -> Result<Vec<DownloadJob>, String> {
    db(&state)
        .lock()
        .unwrap()
        .list_jobs(limit.unwrap_or(20))
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn clear_finished_jobs(state: tauri::State<'_, AppState>) -> Result<(), String> {
    db(&state)
        .lock()
        .unwrap()
        .clear_finished_jobs()
        .map_err(|e| format!("{e:#}"))
}

/// Copia un archivo ya descargado a un destino elegido por el usuario
/// ("Guardar en este equipo"). `dest` puede ser solo la carpeta (se usa el
/// nombre original del archivo) o un path completo.
#[tauri::command]
pub fn export_media(
    state: tauri::State<'_, AppState>,
    media_pk: i64,
    dest: String,
) -> Result<String, String> {
    let content = db(&state)
        .lock()
        .unwrap()
        .media_content(media_pk)
        .map_err(|e| format!("{e:#}"))?
        .ok_or_else(|| "el medio no está guardado".to_string())?;
    write_export(&content.data, &content.sha256, &dest)
}

#[tauri::command]
pub fn export_avatar(
    state: tauri::State<'_, AppState>,
    profile_id: i64,
    dest: String,
) -> Result<String, String> {
    let content = db(&state)
        .lock()
        .unwrap()
        .avatar_content(profile_id)
        .map_err(|e| format!("{e:#}"))?
        .ok_or_else(|| "el avatar no está guardado".to_string())?;
    write_export(&content.data, &content.sha256, &dest)
}

fn write_export(data: &[u8], expected_sha256: &str, dest: &str) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let actual = format!("{:x}", Sha256::digest(data));
    if actual != expected_sha256 {
        return Err("el contenido guardado no coincide con su hash; no se exportó".into());
    }
    let dest_path = std::path::Path::new(&dest);
    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{e:#}"))?;
    }
    std::fs::write(dest_path, data).map_err(|e| format!("{e:#}"))?;
    let exported = std::fs::read(dest_path).map_err(|e| format!("{e:#}"))?;
    if format!("{:x}", Sha256::digest(&exported)) != expected_sha256 {
        let _ = std::fs::remove_file(dest_path);
        return Err("la copia exportada no superó la verificación SHA-256".into());
    }
    Ok(dest_path.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

#[cfg(test)]
mod privacy_tests {
    use super::profile_requires_auth;

    #[test]
    fn credentials_are_reserved_for_confirmed_private_profiles() {
        assert!(profile_requires_auth(Some(1)));
        assert!(!profile_requires_auth(Some(0)));
        assert!(!profile_requires_auth(None));
    }
}
