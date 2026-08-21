//! Diagnóstico: captura real + parseo + is_minimally_valid, imprimiendo cada paso.
use instavault_lib::instagram::cdp_login::CdpSession;
use std::time::Duration;

fn main() {
    CdpSession::kill_existing();
    std::thread::sleep(Duration::from_millis(600));
    let mut sess = match CdpSession::launch() {
        Ok(s) => s,
        Err(e) => { println!("LAUNCH FALLO: {e:#}"); return; }
    };
    if let Err(e) = sess.wait_ready() { println!("WAIT FALLO: {e:#}"); return; }
    std::thread::sleep(Duration::from_millis(800));
    let header = match sess.try_capture() {
        Ok(Some(h)) => h,
        Ok(None) => { println!("sin sessionid"); return; }
        Err(e) => { println!("CAPTURE FALLO: {e:#}"); return; }
    };
    println!("HEADER: {}", header);
    let s = instavault_lib::instagram::client::Session::from_cookie_header(&header);
    println!("header contiene sessionid=: {}", s.cookie_header.contains("sessionid="));
    println!("header contiene __: {}", s.cookie_header.contains("__"));
    println!("csrftoken: len {}", s.csrftoken.len());
    println!("ds_user_id: {}", s.ds_user_id);
    println!("cookie_header: {}", s.cookie_header);
    println!("valid: {}", s.is_minimally_valid());
    sess.shutdown();
}
