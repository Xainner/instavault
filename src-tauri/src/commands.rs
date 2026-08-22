use crate::creds;
use crate::db::Db;
use crate::instagram::client::{IgClient, Session};
use crate::instagram::models::{
    AccountInfo, DownloadJob, DownloadSummary, MediaRow, ProfileRow, ProfileStats, WebProfileInfo,
    WebProfileUser,
};
use crate::instagram::{api, download};
use crate::AppState;
use std::net::ToSocketAddrs;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

type DbLock = Arc<Mutex<Db>>;

fn db(state: &AppState) -> DbLock {
    state.db.clone()
}

fn session(_state: &AppState, account_id: i64) -> anyhow::Result<Session> {
    let raw = creds::load_cookies(account_id)?;
    Ok(Session::from_cookie_header(&raw))
}

fn to_profile_row(u: &WebProfileUser) -> ProfileRow {
    ProfileRow {
        username: u.username.clone(),
        pk: u.id.clone(),
        full_name: u.full_name.clone(),
        biography: u.biography.clone(),
        // Option: el fallback HTML devuelve null (desconocido) y el upsert
        // con COALESCE conserva los conteos reales guardados.
        followers: u.edge_followed_by.as_ref().map(|c| c.count),
        following: u.edge_follow.as_ref().map(|c| c.count),
        media_count: u.edge_owner_to_timeline_media.as_ref().map(|c| c.count),
        is_private: u.is_private.map(|b| b as i64),
        is_verified: u.is_verified.map(|b| b as i64),
        profile_pic_url: u.profile_pic_url_hd.clone(),
        avatar_local_path: None,
        is_favorite: 0,
        fetched_at: Some(chrono::Utc::now().timestamp()),
        id: None,
    }
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

/// Inserta una cuenta (valida la sesión contra la API y persiste cookies).
async fn insert_account(
    state: &AppState,
    username: String,
    cookie_header: String,
) -> Result<AccountInfo, String> {
    let s = Session::from_cookie_header(&cookie_header);
    if !s.is_minimally_valid() {
        return Err("Cookies incompletas: se requieren sessionid y csrftoken".to_string());
    }
    let ig = state.ig.clone();
    let (status, real_username) = match api::current_user(&ig, &s).await {
        Ok(me) if !me.username.is_empty() => ("valid", Some(me.username)),
        Ok(_) => ("valid", None),
        Err(_) => ("invalid", None),
    };
    let username = real_username.unwrap_or(username);
    let dbl = db(state);
    let id = dbl
        .lock()
        .unwrap()
        .add_account(&username, &format!("account:{}" , 0))
        .map_err(|e| e.to_string())?;
    creds::save_cookies(id, &cookie_header)
        .map_err(|e| format!("No se pudieron guardar las cookies: {e}"))?;
    dbl.lock()
        .unwrap()
        .set_account_status(id, status)
        .map_err(|e| e.to_string())?;
    let rows = dbl
        .lock()
        .unwrap()
        .list_accounts()
        .map_err(|e| e.to_string())?;
    rows.iter()
        .find(|r| r.0 == id)
        .map(account_from_row)
        .ok_or_else(|| "error al releer la cuenta".to_string())
}

/// Inserta una cuenta cuya sesión YA fue validada desde el navegador
/// (status "valid" directo, sin re-validar por la API móvil, que rechaza
/// cookies web con "useragent mismatch").
async fn insert_account_verified(
    state: &AppState,
    username: String,
    cookie_header: String,
) -> Result<AccountInfo, String> {
    let s = Session::from_cookie_header(&cookie_header);
    if !s.is_minimally_valid() {
        return Err("Cookies incompletas: se requieren sessionid y csrftoken".to_string());
    }
    let dbl = db(state);
    let id = dbl
        .lock()
        .unwrap()
        .add_account(&username, &format!("account:{}", 0))
        .map_err(|e| e.to_string())?;
    creds::save_cookies(id, &cookie_header)
        .map_err(|e| format!("No se pudieron guardar las cookies: {e}"))?;
    dbl.lock()
        .unwrap()
        .set_account_status(id, "valid")
        .map_err(|e| e.to_string())?;
    let rows = dbl
        .lock()
        .unwrap()
        .list_accounts()
        .map_err(|e| e.to_string())?;
    rows.iter()
        .find(|r| r.0 == id)
        .map(account_from_row)
        .ok_or_else(|| "error al releer la cuenta".to_string())
}

#[tauri::command]
pub async fn add_account(
    state: tauri::State<'_, AppState>,
    username: String,
    cookie_header: String,
) -> Result<AccountInfo, String> {
    insert_account(&state, username, cookie_header).await
}

#[tauri::command]
pub async fn validate_account(
    state: tauri::State<'_, AppState>,
    account_id: i64,
) -> Result<AccountInfo, String> {
    let s = session(&state, account_id).map_err(|e| e.to_string())?;
    let ig = state.ig.clone();
    let ok = api::current_user(&ig, &s).await.is_ok();
    let st = if ok { "valid" } else { "invalid" };
    let dbl = db(&state);
    dbl.lock()
        .unwrap()
        .set_account_status(account_id, st)
        .map_err(|e| e.to_string())?;
    let rows = dbl
        .lock()
        .unwrap()
        .list_accounts()
        .map_err(|e| e.to_string())?;
    rows.iter()
        .find(|r| r.0 == account_id)
        .map(account_from_row)
        .ok_or_else(|| "cuenta no encontrada".to_string())
}

#[tauri::command]
pub fn list_accounts(state: tauri::State<'_, AppState>) -> Result<Vec<AccountInfo>, String> {
    let rows = db(&state)
        .lock()
        .unwrap()
        .list_accounts()
        .map_err(|e| e.to_string())?;
    Ok(rows.iter().map(account_from_row).collect())
}

#[tauri::command]
pub fn delete_account(state: tauri::State<'_, AppState>, account_id: i64) -> Result<(), String> {
    creds::delete_cookies(account_id);
    db(&state)
        .lock()
        .unwrap()
        .delete_account(account_id)
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Conexión desde navegador (Chrome/Edge/Brave/Opera)
// ---------------------------------------------------------------------------

/// Lista los perfiles de navegadores Chromium detectados con cookies.
#[tauri::command]
pub fn list_browser_profiles() -> Result<Vec<crate::instagram::browser::BrowserProfile>, String> {
    Ok(crate::instagram::browser::discover())
}

/// Extrae la sesión de Instagram de un perfil de navegador y crea la cuenta.
/// Si la base de cookies está bloqueada (navegador abierto), la cierra y reintenta.
#[tauri::command]
pub async fn import_browser_account(
    state: tauri::State<'_, AppState>,
    index: usize,
) -> Result<AccountInfo, String> {
    use crate::instagram::browser;
    let profiles = browser::discover();
    let bp = profiles
        .get(index)
        .ok_or_else(|| "perfil de navegador no encontrado".to_string())?;
    let extract = browser::instagram_cookie_header(bp).or_else(|e| {
        let msg = e.to_string();
        let blocked = msg.contains("no se pudo leer la base de cookies");
        if !blocked {
            return Err(msg);
        }
        // Cierra el navegador para liberar el archivo y reintenta una vez.
        let _ = browser::close_browser(&bp.browser);
        std::thread::sleep(std::time::Duration::from_millis(2500));
        browser::instagram_cookie_header(bp).map_err(|e| e.to_string())
    })?;
    insert_account(
        &state,
        extract
            .ds_user_id
            .map(|d| format!("usuario_{d}"))
            .unwrap_or_else(|| "instagram".to_string()),
        extract.header,
    )
    .await
}

/// Cierra todas las instancias de un navegador (util para desbloquear cookies).
#[tauri::command]
pub fn close_browser(browser_name: String) -> Result<u32, String> {
    crate::instagram::browser::close_browser(&browser_name).map_err(|e| e.to_string())
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
    *guard = Some(CdpSession::launch().map_err(|e| e.to_string())?);
    let sess = guard.as_mut().unwrap();
    // El puerto debe quedar listo antes de devolver el control a la UI.
    sess.wait_ready().map_err(|e| {
        *guard = None;
        e.to_string()
    })
}

/// Consulta si ya hay sesión de Instagram capturable; si sí, crea la cuenta.
#[tauri::command]
pub async fn login_check(state: tauri::State<'_, AppState>) -> Result<Option<AccountInfo>, String> {
    use crate::instagram::cdp_login;
    // Tareas bloqueantes en hilo aparte.
    let cdp = std::sync::Arc::clone(&state.cdp);
    let result = tokio::task::spawn_blocking(move || -> Result<Option<(String, String)>, String> {
        let mut guard = cdp.lock().map_err(|e| e.to_string())?;
        let Some(sess) = guard.as_mut() else {
            return Err("no hay navegador de login activo".to_string());
        };
        if !sess.is_alive() {
            *guard = None;
            return Err("la ventana de login se cerró sin completar el login".to_string());
        }
        // Sin sessionid todavía NO es un error: el usuario aún puede estar
        // escribiendo credenciales. Devuelve None y el frontend sigue
        // esperando hasta que aparezca.
        let header = match sess.try_capture().map_err(|e| e.to_string())? {
            Some(h) => h,
            None => return Ok(None),
        };
        // Valida la sesión DESDE la página (mismo UA/cookies del navegador)
        // y obtiene el username real; la API externa rechaza cookies web.
        let username = cdp_login::current_user_via_page(sess.port())
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "la sesión del navegador no está logueada".to_string())?;
        Ok(Some((header, username)))
    })
    .await
    .map_err(|e| e.to_string())??;

    let Some((header, username)) = result else {
        return Ok(None); // sigue esperando: aún no hay sessionid
    };
    // Inserta PRIMERO; solo si sale bien cierra el navegador.
    let account = insert_account_verified(&state, username, header).await?;
    if let Ok(mut guard) = state.cdp.lock() {
        if let Some(mut s) = guard.take() {
            s.shutdown();
        }
    }
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

// ---------------------------------------------------------------------------
// Perfiles
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn fetch_profile(
    state: tauri::State<'_, AppState>,
    _account_id: i64,
    username: String,
) -> Result<ProfileRow, String> {
    use crate::instagram::cdp_login;
    // Todas las consultas pasan por el navegador (la API bloquea clientes externos).
    let port = ensure_api_browser(&state).map_err(|e| e.to_string())?;
    let path = format!("/api/v1/users/web_profile_info/?username={username}");
    let json = tokio::task::spawn_blocking(move || {
        cdp_login::api_fetch_via_page(port, &path)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    let info: WebProfileInfo = serde_json::from_value(json)
        .map_err(|e| format!("respuesta del API inesperada: {e}"))?;
    let user = info
        .data
        .user
        .ok_or_else(|| "perfil no encontrado (¿el usuario existe?)".to_string())?;
    let row = to_profile_row(&user);
    let id = db(&state)
        .lock()
        .unwrap()
        .upsert_profile(&row)
        .map_err(|e| e.to_string())?;
    Ok(ProfileRow {
        id: Some(id),
        ..row
    })
}

/// Asegura que hay un navegador API vivo (con la sesión del perfil de
/// InstaVault) y devuelve su puerto CDP. Lo lanza si no existe.
/// Todas las consultas a Instagram pasan por Chrome vía CDP: la API bloquea
/// (429) los clientes HTTP externos.
fn ensure_api_browser(state: &AppState) -> Result<u16, String> {
    use crate::instagram::cdp_login::{self, CdpSession};
    let mut guard = state.cdp.lock().map_err(|e| e.to_string())?;
    if let Some(s) = guard.as_mut() {
        if s.is_alive() {
            let port = s.port();
            drop(guard);
            // El navegador reutilizado puede estar en login/logout/2FA:
            // navega a la home para que la sesión del perfil se active.
            let _ = cdp_login::navigate_home(port);
            return Ok(port);
        }
    }
    // Sin navegador vivo: mata instancias colgadas y lanza uno nuevo
    // (home, conserva la sesión del login asistido).
    drop(guard);
    CdpSession::kill_existing();
    std::thread::sleep(std::time::Duration::from_millis(600));
    let sess = CdpSession::launch_api().map_err(|e| e.to_string())?;
    sess.wait_ready().map_err(|e| e.to_string())?;
    let port = sess.port();
    *state.cdp.lock().map_err(|e| e.to_string())? = Some(sess);
    // La home necesita unos segundos para cargar y validar la sesión.
    std::thread::sleep(std::time::Duration::from_secs(6));
    Ok(port)
}

#[tauri::command]
pub fn list_profiles(state: tauri::State<'_, AppState>) -> Result<Vec<ProfileRow>, String> {
    db(&state)
        .lock()
        .unwrap()
        .list_profiles()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_profile(state: tauri::State<'_, AppState>, profile_id: i64) -> Result<(), String> {
    db(&state)
        .lock()
        .unwrap()
        .delete_profile_cascade(profile_id)
        .map_err(|e| e.to_string())
        .map(|_| ())
}

/// Borra el archivo descargado de UN medio y lo marca pendiente, para
/// poder re-descargarlo (p.ej. con mejor calidad o firma fresca).
#[tauri::command]
pub fn reset_download(state: tauri::State<'_, AppState>, media_pk: i64) -> Result<(), String> {
    let dbl = db(&state);
    let path = {
        let lock = dbl.lock().unwrap();
        let row = lock
            .get_media_by_id(media_pk)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "medio no encontrado".to_string())?;
        if row.status != "downloaded" {
            return Err("el medio no está descargado".to_string());
        }
        lock.reset_download(media_pk).map_err(|e| e.to_string())?;
        row.local_path
    };
    if let Some(p) = path {
        let _ = std::fs::remove_file(p);
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
    let paths: Vec<String> = {
        let lock = dbl.lock().unwrap();
        lock.media_by_profile(profile_id, kind.as_deref())
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|m| m.status == "downloaded")
            .filter_map(|m| m.local_path)
            .collect()
    };
    for p in &paths {
        let _ = std::fs::remove_file(p);
    }
    let n = dbl
        .lock()
        .unwrap()
        .reset_downloads_profile(profile_id, kind.as_deref())
        .map_err(|e| e.to_string())?;
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
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Sincronización (fetch metadata → BD)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn sync_posts(
    state: tauri::State<'_, AppState>,
    account_id: i64,
    username: String,
    max_pages: u32,
) -> Result<usize, String> {
    let s = session(&state, account_id).map_err(|e| e.to_string())?;
    let ig = state.ig.clone();
    let dbl = db(&state);
    let profile_id = ensure_profile(&ig, &s, &dbl, &username)
        .await
        .map_err(|e| e.to_string())?;
    let pk = lock_pk(&dbl, profile_id);
    let items = api::fetch_posts(&ig, &s, &pk, max_pages)
        .await
        .map_err(|e| e.to_string())?;
    let extracted = items
        .iter()
        .flat_map(|i| api::extract_item(i, "post"))
        .collect::<Vec<_>>();
    let mut count = 0usize;
    {
        let lock = dbl.lock().unwrap();
        for em in &extracted {
            let row = MediaRow {
                media_id: em.media_id.clone(),
                profile_id: Some(profile_id),
                kind: em.kind.clone(),
                code: em.code.clone(),
                taken_at: em.taken_at,
                caption: em.caption.clone(),
                media_type: Some(em.media_type),
                thumbnail_url: em.thumbnail_url.clone(),
                best_url: Some(em.best_url.clone()),
                local_path: None,
                status: "metadata".to_string(),
                error: None,
                created_at: Some(chrono::Utc::now().timestamp()),
                id: None,
            };
            if lock.upsert_media(&row).is_ok() {
                count += 1;
            }
        }
        // La sync reintenta lo fallido y registra el estado (última vez).
        let _ = lock.reset_failed(profile_id, "post");
        let _ = lock.record_sync(profile_id, "post");
    }
    Ok(count)
}

#[tauri::command]
pub async fn sync_stories(
    state: tauri::State<'_, AppState>,
    account_id: i64,
    username: String,
) -> Result<usize, String> {
    let s = session(&state, account_id).map_err(|e| e.to_string())?;
    let ig = state.ig.clone();
    let dbl = db(&state);
    let profile_id = ensure_profile(&ig, &s, &dbl, &username)
        .await
        .map_err(|e| e.to_string())?;
    let pk = lock_pk(&dbl, profile_id);
    let items = api::fetch_stories(&ig, &s, &pk)
        .await
        .map_err(|e| e.to_string())?;
    let mut count = 0usize;
    {
        let lock = dbl.lock().unwrap();
        for em in items.iter().flat_map(|i| api::extract_item(i, "story")) {
            let row = MediaRow {
                media_id: format!("st_{}", em.media_id),
                profile_id: Some(profile_id),
                kind: "story".to_string(),
                code: em.code.clone(),
                taken_at: em.taken_at,
                caption: em.caption.clone(),
                media_type: Some(em.media_type),
                thumbnail_url: em.thumbnail_url.clone(),
                best_url: Some(em.best_url.clone()),
                local_path: None,
                status: "metadata".to_string(),
                error: None,
                created_at: Some(chrono::Utc::now().timestamp()),
                id: None,
            };
            if lock.upsert_media(&row).is_ok() {
                count += 1;
            }
        }
        // La sync reintenta lo fallido y registra el estado (última vez).
        let _ = lock.reset_failed(profile_id, "story");
        let _ = lock.record_sync(profile_id, "story");
    }
    Ok(count)
}

#[tauri::command]
pub async fn sync_highlights(
    state: tauri::State<'_, AppState>,
    account_id: i64,
    username: String,
) -> Result<usize, String> {
    use crate::instagram::cdp_login;
    let s = session(&state, account_id).map_err(|e| e.to_string())?;
    let ig = state.ig.clone();
    let dbl = db(&state);
    let profile_id = ensure_profile(&ig, &s, &dbl, &username)
        .await
        .map_err(|e| e.to_string())?;

    // El endpoint mobile `highlights_tray` devuelve `status: fail` (caído).
    // Estrategia: leer los reels del DOM de la página de perfil (browser
    // CDP; los muestra incluso logged-out) y el media por `reels_media`.
    let port = ensure_api_browser(&state).map_err(|e| e.to_string())?;
    let uname = username.clone();
    let reels = tokio::task::spawn_blocking(move || {
        let url = format!("https://www.instagram.com/{uname}/");
        cdp_login::navigate_to(port, &url)?;
        // La página tarda en renderizar el tray de highlights.
        std::thread::sleep(std::time::Duration::from_secs(7));
        let r = cdp_login::extract_highlight_reels(port);
        if r.as_ref().map(|v| v.is_empty()).unwrap_or(true) {
            // Reintento con espera extra (primeras veces renderiza lento).
            std::thread::sleep(std::time::Duration::from_secs(5));
            let r2 = cdp_login::extract_highlight_reels(port)?;
            Ok(r2)
        } else {
            r
        }
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    if reels.is_empty() {
        return Ok(0);
    }
    {
        let lock = dbl.lock().unwrap();
        for h in &reels {
            lock.upsert_highlight(
                if h.title.is_empty() { "Highlight" } else { &h.title },
                &h.id,
                profile_id,
            )
            .map_err(|e| e.to_string())?;
        }
    }
    let mut count = 0usize;
    for h in &reels {
        let items = api::fetch_reels_media(&ig, &s, &format!("highlight:{}", h.id))
            .await
            .map_err(|e| e.to_string())?;
        let lock = dbl.lock().unwrap();
        for em in items.iter().flat_map(|i| api::extract_item(i, "highlight")) {
            let row = MediaRow {
                media_id: format!("hl_{}", em.media_id),
                profile_id: Some(profile_id),
                kind: "highlight".to_string(),
                code: em.code.clone(),
                taken_at: em.taken_at,
                caption: em.caption.clone(),
                media_type: Some(em.media_type),
                thumbnail_url: em.thumbnail_url.clone(),
                best_url: Some(em.best_url.clone()),
                local_path: None,
                status: "metadata".to_string(),
                error: None,
                created_at: Some(chrono::Utc::now().timestamp()),
                id: None,
            };
            if lock.upsert_media(&row).is_ok() {
                count += 1;
            }
        }
        // La sync reintenta lo fallido y registra el estado (última vez).
        let _ = lock.reset_failed(profile_id, "highlight");
        let _ = lock.record_sync(profile_id, "highlight");
    }
    Ok(count)
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
    let s = session(&state, account_id).map_err(|e| e.to_string())?;
    let ig = state.ig.clone();
    let dbl = db(&state);
    let username = {
        let lock = dbl.lock().unwrap();
        lock.get_profile_by_id(profile_id)
            .map_err(|e| e.to_string())?
            .map(|p| p.username)
            .ok_or_else(|| "perfil no encontrado".to_string())?
    };
    let rows = dbl
        .lock()
        .unwrap()
        .media_by_profile(profile_id, Some(&kind))
        .map_err(|e| e.to_string())?
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
        .map_err(|e| e.to_string())?
    {
        return Err("ya hay una descarga en curso para este perfil".to_string());
    }
    let job_id = dbl
        .lock()
        .unwrap()
        .insert_job(profile_id, &kind, rows.len() as i64)
        .map_err(|e| e.to_string())?;
    let base = state.data_dir.clone();
    let summary = download::download_all(
        &ig,
        &s,
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
    .map_err(|e| e.to_string())?;
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
    let s = session(&state, account_id).map_err(|e| e.to_string())?;
    let ig = state.ig.clone();
    let dbl = db(&state);
    let (row, profile_id, username, kind) = {
        let lock = dbl.lock().unwrap();
        let row = lock
            .get_media_by_id(media_pk)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "medio no encontrado".to_string())?;
        if row.best_url.is_none() {
            return Err("el medio no tiene URL para descargar".to_string());
        }
        let profile_id = row.profile_id.ok_or_else(|| "medio sin perfil".to_string())?;
        let kind = row.kind.clone();
        let username = lock
            .get_profile_by_id(profile_id)
            .map_err(|e| e.to_string())?
            .map(|p| p.username)
            .ok_or_else(|| "perfil no encontrado".to_string())?;
        (row, profile_id, username, kind)
    };
    if dbl
        .lock()
        .unwrap()
        .has_active_job(profile_id, &kind)
        .map_err(|e| e.to_string())?
    {
        return Err("ya hay una descarga en curso para este perfil".to_string());
    }
    let job_id = dbl
        .lock()
        .unwrap()
        .insert_job(profile_id, &kind, 1)
        .map_err(|e| e.to_string())?;
    let base = state.data_dir.clone();
    let summary = download::download_all(
        &ig,
        &s,
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
    .map_err(|e| e.to_string())?;
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
        .map_err(|e| e.to_string())
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
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "perfil no encontrado".to_string())?;
        (p.profile_pic_url.clone(), p.avatar_local_path.clone())
    };
    if let Some(p) = cached.filter(|p| std::path::Path::new(p).is_file()) {
        return Ok(Some(p));
    }
    let url = url.ok_or_else(|| "el perfil no tiene URL de foto".to_string())?;
    let dir = state
        .data_dir
        .parent()
        .map(|d| d.join("avatars"))
        .unwrap_or_else(|| state.data_dir.join("avatars"));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(format!("{}.jpg", profile_id));
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
    let client = builder.build().map_err(|e| e.to_string())?;
    let bytes = client
        .get(&url)
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        )
        .send()
        .await
        .map_err(|e| format!("no se pudo descargar la foto: {e}"))?
        .error_for_status()
        .map_err(|e| format!("la CDN rechazó la foto: {e}"))?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;
    if bytes.len() < 100 {
        return Err("la respuesta de la foto no parece una imagen".to_string());
    }
    std::fs::write(&file, &bytes).map_err(|e| e.to_string())?;
    let path = file.to_string_lossy().to_string();
    dbl.lock()
        .unwrap()
        .set_avatar_path(profile_id, &path)
        .map_err(|e| e.to_string())?;
    Ok(Some(path))
}

#[tauri::command]
pub fn get_profile_stats(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ProfileStats>, String> {
    db(&state)
        .lock()
        .unwrap()
        .profile_stats()
        .map_err(|e| e.to_string())
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
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_finished_jobs(state: tauri::State<'_, AppState>) -> Result<(), String> {
    db(&state)
        .lock()
        .unwrap()
        .clear_finished_jobs()
        .map_err(|e| e.to_string())
}

/// Copia un archivo ya descargado a un destino elegido por el usuario
/// ("Guardar en este equipo"). `dest` puede ser solo la carpeta (se usa el
/// nombre original del archivo) o un path completo.
#[tauri::command]
pub fn copy_file_to(source: String, dest: String) -> Result<String, String> {
    let src = std::path::Path::new(&source);
    if !src.is_file() {
        return Err(format!("el archivo no existe: {source}"));
    }
    let dest_path = std::path::Path::new(&dest);
    // Si dest termina en un separador o es una carpeta existente, metemos el
    // nombre original del archivo dentro.
    let target = if dest_path.is_dir() {
        let name = src
            .file_name()
            .map(|n| n.to_os_string())
            .ok_or_else(|| "sin nombre de archivo".to_string())?;
        dest_path.join(name)
    } else {
        dest_path.to_path_buf()
    };
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::copy(src, &target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// Asegura el perfil en BD y lo refresca (foto, conteos, pk) en cada sync:
/// las URLs de la CDN expiran ~24 h, así que la foto guardada envejece.
/// Si el lookup falla pero el perfil ya existe, continúa con los datos
/// guardados (un 429 de perfil no rompe la sync de media).
async fn ensure_profile(
    ig: &IgClient,
    s: &Session,
    dbl: &DbLock,
    username: &str,
) -> anyhow::Result<i64> {
    let existing = dbl.lock().unwrap().get_profile_id(username).ok();
    match api::lookup_profile(ig, s, username).await {
        Ok(user) => Ok(dbl.lock().unwrap().upsert_profile(&to_profile_row(&user))?),
        Err(e) => existing.ok_or_else(|| e),
    }
}

fn lock_pk(dbl: &DbLock, profile_id: i64) -> String {
    dbl.lock()
        .unwrap()
        .get_profile_by_id(profile_id)
        .ok()
        .flatten()
        .and_then(|p| p.pk)
        .unwrap_or_default()
}
