//! Prueba el motor público aislado. No abre el perfil persistente ni envía
//! cookies; es equivalente a la búsqueda normal de la aplicación.
use instavault_lib::instagram::cdp_login::{self, CdpSession};
use std::time::Duration;

fn main() {
    let mut sess = match CdpSession::launch_public_api() {
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
    for username in ["instagram"] {
        let path = format!("/api/v1/users/web_profile_info/?username={username}");
        match cdp_login::api_fetch_via_page(sess.port(), &path) {
            Ok(v) => {
                let name = v
                    .pointer("/data/user/username")
                    .and_then(|u| u.as_str())
                    .unwrap_or("?");
                println!("OK {username}: @{name}");
                if let Some(pk) = v.pointer("/data/user/id").and_then(|id| id.as_str()) {
                    let feed = format!("/api/v1/feed/user/{pk}/?count=3");
                    match cdp_login::api_fetch_via_page(sess.port(), &feed) {
                        Ok(feed) => println!(
                            "feed público: {} items",
                            feed.get("items").and_then(|v| v.as_array()).map_or(0, |v| v.len())
                        ),
                        Err(e) => println!("feed público FALLÓ: {e:#}"),
                    }
                }
            }
            Err(e) => println!("FALLO {username}: {e:#}"),
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    sess.shutdown();
}
