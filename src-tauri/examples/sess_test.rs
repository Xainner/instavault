//! Diagnóstico e2e: captura CDP + validación DESDE la página (flujo real nuevo).
//! Ejecutar: cargo run --example sess_test
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
    std::thread::sleep(Duration::from_millis(800));
    let header = match sess.try_capture() {
        Ok(Some(h)) => h,
        Ok(None) => {
            println!("sin sessionid (no hay login en el perfil)");
            return;
        }
        Err(e) => {
            println!("CAPTURE FALLO: {e:#}");
            return;
        }
    };
    println!("cookies capturadas ({} bytes)", header.len());
    match cdp_login::current_user_via_page(sess.port()) {
        Ok(Some(u)) => println!("VALIDADO DESDE LA PAGINA -> @{u}"),
        Ok(None) => println!("la pagina no reporta usuario logueado"),
        Err(e) => println!("VALIDACION FALLO: {e:#}"),
    }
    sess.shutdown();
}