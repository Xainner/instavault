//! Prueba e2e de la importación desde navegador (sin crear cuenta en BD):
//! detecta perfiles, extrae las cookies de Instagram, valida la sesión en
//! vivo contra la API y muestra el username real de la cuenta.
//! Ejecutar: cargo run --example extract_test
fn main() {
    let rt = tokio::runtime::Runtime::new().expect("rt");
    rt.block_on(async {
        use instavault_lib::instagram::browser;
        use instavault_lib::instagram::client::{IgClient, Session};
        let profiles = browser::discover();
        if profiles.is_empty() {
            println!("Sin perfiles detectados.");
            return;
        }
        let ig = match IgClient::new() {
            Ok(c) => c,
            Err(e) => {
                println!("No se pudo crear el cliente HTTP: {e}");
                return;
            }
        };
        for p in &profiles {
            println!("Probando {} [{}]:", p.browser, p.profile);
            let extract = match browser::instagram_cookie_header(p) {
                Ok(e) => e,
                Err(e) => {
                    println!("  Fallo al extraer: {e}");
                    continue;
                }
            };
            let names: Vec<&str> = extract
                .header
                .split(';')
                .map(|kv| kv.trim().split('=').next().unwrap_or(""))
                .filter(|s| !s.is_empty())
                .collect();
            println!(
                "  Extraidas {} cookies: {}",
                names.len(),
                names.join(", ")
            );
            let s = Session::from_cookie_header(&extract.header);
            match instavault_lib::instagram::api::current_user(&ig, &s).await {
                Ok(u) => println!(
                    "  SESION VALIDA -> username: @{} (id {:?})",
                    u.username, u.pk
                ),
                Err(e) => println!("  Sesion NO valida: {e}"),
            }
        }
    });
}