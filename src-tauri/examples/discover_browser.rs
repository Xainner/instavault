//! Smoke test del detector de perfiles de navegador.
//! Ejecutar: cargo run --example discover_browser
fn main() {
    let profiles = instavault_lib::instagram::browser::discover();
    if profiles.is_empty() {
        println!("No se detecto ningun perfil de Chromium con cookies.");
        return;
    }
    println!("Perfiles detectados con cookies de Instagram:");
    for p in &profiles {
        println!("  - {} [{}] -> {}", p.browser, p.profile, p.cookies_path);
    }
}
