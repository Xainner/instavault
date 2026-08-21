//! Diagnóstico: lanza el navegador de login (logout primero) y muestra la
//! respuesta EXACTA del fetch de validación, sin iniciar sesión.
use instavault_lib::instagram::cdp_login::{self, CdpSession};
use std::time::Duration;

fn main() {
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
    std::thread::sleep(Duration::from_secs(5)); // deja cargar la página

    // 1. Qué URL tiene la página ahora
    match cdp_login::current_url_for_test(sess.port()) {
        Ok(u) => println!("URL actual: {u}"),
        Err(e) => println!("URL FALLO: {e:#}"),
    }

    // 2. El fetch de validación (lo que la app ejecuta)
    match cdp_login::current_user_via_page(sess.port()) {
        Ok(Some(u)) => println!("VALIDADO -> @{u}"),
        Ok(None) => println!("sin usuario (no logueado, esperado)"),
        Err(e) => println!("VALIDACION FALLO: {e:#}"),
    }

    // 3. Si falla, probar variantes del fetch para ver cuál responde
    match cdp_login::raw_fetch_for_test(sess.port()) {
        Ok(r) => println!("FETCH CRUDO: {r}"),
        Err(e) => println!("FETCH CRUDO FALLO: {e:#}"),
    }
    sess.shutdown();
}