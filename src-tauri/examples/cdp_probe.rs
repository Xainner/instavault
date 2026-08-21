//! Diagnóstico NO destructivo: detecta el navegador de login que ya está
//! abierto (si lo hay) y prueba capture_cookies contra su puerto real,
//! sin matar nada.
use instavault_lib::instagram::cdp_login;
use std::time::Duration;

fn main() {
    // Busca el chrome de InstaVault por la linea de comandos del proceso.
    let out = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object {$_.CommandLine -match 'InstaVault'} | Select-Object -ExpandProperty CommandLine",
        ])
        .output();
    let cmdline = match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).to_string(),
        Err(e) => {
            println!("no se pudo consultar procesos: {e}");
            return;
        }
    };
    if cmdline.trim().is_empty() {
        println!("NO hay navegador de login abierto ahora mismo");
        return;
    }
    println!("navegador de login encontrado:");
    for line in cmdline.lines().take(2) {
        println!("  {}", &line[..line.len().min(160)]);
    }
    // Extrae el puerto
    let port: u16 = match cmdline
        .split("--remote-debugging-port=")
        .nth(1)
        .and_then(|s| s.split_whitespace().next())
        .and_then(|s| s.parse().ok())
    {
        Some(p) => p,
        None => {
            println!("  (sin puerto CDP en la linea de comando)");
            return;
        }
    };
    println!("puerto CDP: {port}");
    std::thread::sleep(Duration::from_millis(500));

    match cdp_login::capture_cookies(port) {
        Ok(Some(h)) => {
            println!("CAPTURA OK ({} bytes) -> header presente", h.len());
        }
        Ok(None) => println!("captura: Ok(None) -> no hay sessionid EN ESTE MOMENTO"),
        Err(e) => println!("captura FALLO: {e:#}"),
    }
    match cdp_login::current_user_via_page(port) {
        Ok(Some(u)) => println!("VALIDADO desde la pagina -> @{u}"),
        Ok(None) => println!("validacion: ok pero sin usuario"),
        Err(e) => println!("validacion FALLO: {e:#}"),
    }
}