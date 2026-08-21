use crate::creds;
use crate::db::Db;
use crate::instagram::client::{IgClient, Session};
use crate::instagram::models::{AccountInfo, MediaRow, ProfileRow, WebProfileInfo, WebProfileUser};
use crate::instagram::{api, download};
use crate::AppState;
use std::sync::{Arc, Mutex};

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
        pk: Some(u.id.clone()),
        full_name: u.full_name.clone(),
        biography: u.biography.clone(),
        followers: Some(u.edge_followed_by.count),
        following: Some(u.edge_follow.count),
        media_count: Some(u.edge_owner_to_timeline_media.count),
        is_private: u.is_private.unwrap_or(false) as i64,
        is_verified: u.is_verified.unwrap_or(false) as i64,
        profile_pic_url: u.profile_pic_url_hd.clone(),
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
    use crate::instagram::cdp_login::CdpSession;
    let mut guard = state.cdp.lock().map_err(|e| e.to_string())?;
    if let Some(s) = guard.as_mut() {
        if s.is_alive() {
            return Ok(s.port());
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
    std::thread::sleep(std::time::Duration::from_secs(4));
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
    }
    Ok(count)
}

#[tauri::command]
pub async fn sync_highlights(
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
    let tray = api::fetch_highlights_tray(&ig, &s, &pk)
        .await
        .map_err(|e| e.to_string())?;
    {
        let lock = dbl.lock().unwrap();
        for h in &tray {
            lock.upsert_highlight(h.title.as_deref().unwrap_or("Highlight"), &h.id, profile_id)
                .map_err(|e| e.to_string())?;
        }
    }
    let mut count = 0usize;
    for h in &tray {
        let items = api::fetch_highlight_media(&ig, &s, &h.id)
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
    }
    Ok(count)
}

// ---------------------------------------------------------------------------
// Descarga
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn download_profile(
    state: tauri::State<'_, AppState>,
    account_id: i64,
    profile_id: i64,
    kind: String,
    concurrency: usize,
) -> Result<(usize, usize), String> {
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
        .filter(|m| m.status == "metadata" && m.best_url.is_some())
        .collect::<Vec<_>>();
    let base = state.data_dir.clone();
    let (ok, fail) = download::download_all(&ig, &s, dbl, &base, &username, rows, concurrency)
        .await
        .map_err(|e| e.to_string())?;
    Ok((ok, fail))
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async fn ensure_profile(
    ig: &IgClient,
    s: &Session,
    dbl: &DbLock,
    username: &str,
) -> anyhow::Result<i64> {
    {
        let lock = dbl.lock().unwrap();
        if let Ok(id) = lock.get_profile_id(username) {
            return Ok(id);
        }
    }
    let user = api::lookup_profile(ig, s, username).await?;
    let row = to_profile_row(&user);
    Ok(dbl.lock().unwrap().upsert_profile(&row)?)
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
