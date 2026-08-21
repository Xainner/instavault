use crate::creds;
use crate::db::Db;
use crate::instagram::client::{IgClient, Session};
use crate::instagram::models::{AccountInfo, MediaRow, ProfileRow, WebProfileUser};
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

#[tauri::command]
pub async fn add_account(
    state: tauri::State<'_, AppState>,
    username: String,
    cookie_header: String,
) -> Result<AccountInfo, String> {
    let s = Session::from_cookie_header(&cookie_header);
    if !s.is_minimally_valid() {
        return Err("Cookies incompletas: se requieren sessionid y csrftoken".to_string());
    }
    let ig = state.ig.clone();
    let status = match api::current_user(&ig, &s).await {
        Ok(me) => {
            if !me.username.is_empty() && me.username.to_lowercase() != username.to_lowercase() {
                return Err(format!(
                    "Las cookies pertenecen a @{}, no a @{}",
                    me.username, username
                ));
            }
            "valid"
        }
        Err(_) => "invalid",
    };
    let dbl = db(&state);
    let id = dbl
        .lock()
        .unwrap()
        .add_account(&username, &format!("account:{}", 0))
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
// Perfiles
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn fetch_profile(
    state: tauri::State<'_, AppState>,
    account_id: i64,
    username: String,
) -> Result<ProfileRow, String> {
    let s = session(&state, account_id).map_err(|e| e.to_string())?;
    let ig = state.ig.clone();
    let user = api::lookup_profile(&ig, &s, &username)
        .await
        .map_err(|e| e.to_string())?;
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
