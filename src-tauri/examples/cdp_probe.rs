//! Sonda CDP: reproduce el flujo de try_capture contra un puerto dado e
//! imprime cada paso para diagnosticar por qué la app no detecta la sesión.
//! Ejecutar: cargo run --example cdp_probe -- 64840
use std::time::{Duration, Instant};

fn main() {
    let port: u16 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    if port == 0 {
        println!("uso: cdp_probe <puerto>");
        return;
    }
    println!("sondeando puerto {port}");

    // 1) /json/list via el mismo http_get_json de la lib
    let list_url = format!("http://127.0.0.1:{port}/json/list");
    let resp = match instavault_lib::instagram::cdp_login::http_get_json_for_test(&list_url) {
        Ok(v) => v,
        Err(e) => {
            println!("FALLO /json/list: {e:#}");
            return;
        }
    };
    let pages: Vec<&serde_json::Value> = resp
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|t| t.get("type").and_then(|t| t.as_str()) == Some("page"))
                .collect()
        })
        .unwrap_or_default();
    println!("paginas: {}", pages.len());
    let Some(page) = pages.first() else {
        return;
    };
    let ws_url = page
        .get("webSocketDebuggerUrl")
        .and_then(|u| u.as_str())
        .unwrap_or("");
    println!("ws_url: {ws_url}");

    // 2) conectar websocket
    let (mut ws, _r) = match tungstenite::client::connect(ws_url) {
        Ok(x) => x,
        Err(e) => {
            println!("FALLO connect: {e}");
            return;
        }
    };
    println!("websocket conectado");

    // 3) enviar comando
    let req = serde_json::json!({
        "id": 1,
        "method": "Network.getCookies",
        "params": {"urls": ["https://www.instagram.com", "https://instagram.com"]}
    });
    use tungstenite::Message;
    if let Err(e) = ws.send(Message::Text(req.to_string())) {
        println!("FALLO send: {e}");
        return;
    }
    println!("comando enviado, leyendo respuesta…");

    // 4) leer hasta id=1
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if Instant::now() >= deadline {
            println!("TIMEOUT sin respuesta");
            return;
        }
        match ws.read() {
            Ok(Message::Text(t)) => {
                let v: serde_json::Value = match serde_json::from_str(&t) {
                    Ok(v) => v,
                    Err(e) => {
                        println!("JSON invalido: {e}");
                        continue;
                    }
                };
                if v.get("id").and_then(|i| i.as_u64()) == Some(1) {
                    let cookies = v.pointer("/result/cookies");
                    match cookies {
                        Some(c) => {
                            let n = c.as_array().map(|a| a.len()).unwrap_or(0);
                            println!("RESPUESTA OK: {n} cookies");
                            for ck in c.as_array().unwrap() {
                                let name = ck.get("name").and_then(|x| x.as_str()).unwrap_or("?");
                                let len = ck.get("value").and_then(|x| x.as_str()).map(|s| s.len()).unwrap_or(0);
                                println!("  {name} len={len}");
                            }
                        }
                        None => println!("respuesta SIN result.cookies: {v}"),
                    }
                    return;
                }
                println!("(mensaje intermedio id={:?})", v.get("id"));
            }
            Ok(Message::Ping(_)) => println!("(ping)"),
            Ok(Message::Pong(_)) => println!("(pong)"),
            Ok(_) => println!("(otro frame)"),
            Err(e) => {
                println!("FALLO read: {e}");
                return;
            }
        }
    }
}
