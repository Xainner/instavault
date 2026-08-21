//! Simula el caso real: navegador del login asistido (página login/logout)
//! reutilizado como motor API. Navega a la home y busca.
use instavault_lib::instagram::cdp_login::{self, CdpSession};
use std::time::Duration;

fn main() {
    // Estado REAL tras el login asistido: navegador vivo pero en logout/login.
    CdpSession::kill_existing();
    std::thread::sleep(Duration::from_millis(600));
    let mut sess = match CdpSession::launch() {
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
    // Deja que cargue la página de logout/login (estado "sucio").
    std::thread::sleep(Duration::from_secs(4));

    // Ahora el flujo de búsqueda real: navegar a home y buscar.
    match cdp_login::navigate_home(sess.port()) {
        Ok(()) => println!("navegación a home OK"),
        Err(e) => println!("navegación FALLO: {e:#}"),
    }
    for username in ["cristiano", "fiochavesch"] {
        let path = format!("/api/v1/users/web_profile_info/?username={username}");
        match cdp_login::api_fetch_via_page(sess.port(), &path) {
            Ok(v) => {
                let name = v
                    .pointer("/data/user/username")
                    .and_then(|u| u.as_str())
                    .unwrap_or("?");
                println!("OK {username}: @{name}");
            }
            Err(e) => println!("FALLO {username}: {e:#}"),
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    sess.shutdown();
}