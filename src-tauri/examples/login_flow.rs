//! Diagnóstico final: tras el fallo, prueba si el puerto responde con curl externo.
use instavault_lib::instagram::cdp_login::CdpSession;
use std::process::Command;
use std::time::Duration;

fn main() {
    CdpSession::kill_existing();
    std::thread::sleep(Duration::from_millis(600));
    let mut sess = match CdpSession::launch() {
        Ok(s) => s,
        Err(e) => { println!("LAUNCH FALLO: {e:#}"); return; }
    };
    let u = sess.debug_url();
    let port: u16 = u.rsplit(':').next().unwrap().split('/').next().unwrap().parse().unwrap();
    println!("puerto real: {port}");
    match sess.wait_ready() {
        Ok(_) => println!("wait_ready OK"),
        Err(e) => {
            println!("wait_ready FALLO: {e:#}");
            println!("is_alive: {}", sess.is_alive());
            // prueba externa con curl al MISMO puerto
            let out = Command::new("curl")
                .args(["-s", "-m", "4", &format!("http://127.0.0.1:{port}/json/version")])
                .output();
            match out {
                Ok(o) => println!("curl: exit={} body={}", o.status, String::from_utf8_lossy(&o.stdout).chars().take(120).collect::<String>()),
                Err(e) => println!("curl err: {e}"),
            }
            sess.shutdown();
            return;
        }
    }
    std::thread::sleep(Duration::from_millis(800));
    match sess.try_capture() {
        Ok(Some(h)) => println!("capture OK len {}", h.len()),
        Ok(None) => println!("capture: sin sessionid"),
        Err(e) => println!("capture FALLO: {e:#}"),
    }
    sess.shutdown();
}
