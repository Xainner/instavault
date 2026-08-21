//! Prueba e2e del motor API CDP: busca perfiles públicos con la sesión guardada.
//! Ejecutar: cargo run --example api_probe
use instavault_lib::instagram::cdp_login::{self, CdpSession};
use std::time::Duration;

fn main() {
    CdpSession::kill_existing();
    std::thread::sleep(Duration::from_millis(600));
    let mut sess = match CdpSession::launch_api() {
        Ok(s) => s,
        Err(e) => {
            println!("LAUNCH FALLO: {e:#}");
            return;
        }
    };
    if let Err(e) = sess.wait_ready() {
        println!("WAIT FALLO: {e:#}");
        return;
    }
    std::thread::sleep(Duration::from_secs(5)); // home cargando

    for username in ["cristiano", "fiochavesch", "leomessi"] {
        let path = format!("/api/v1/users/web_profile_info/?username={username}");
        match cdp_login::api_fetch_via_page(sess.port(), &path) {
            Ok(v) => {
                let name = v
                    .pointer("/data/user/username")
                    .and_then(|u| u.as_str())
                    .unwrap_or("?");
                let privado = v
                    .pointer("/data/user/is_private")
                    .and_then(|u| u.as_bool())
                    .unwrap_or(false);
                println!("OK {username}: @{name} privado={privado}");
            }
            Err(e) => println!("FALLO {username}: {e:#}"),
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    sess.shutdown();
}