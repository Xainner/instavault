//! Verifica (1) el round-trip de AES-GCM y (2) si Rust puede abrir la base de
//! cookies de Chrome en vivo (solo lectura).
//! Ejecutar: cargo run --example gcm_test
use instavault_lib::instagram::browser::discover;

fn main() {
    use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
    use aead::Aead;
    let key = [0x42u8; 32];
    let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
    let nonce = Nonce::from_slice(&[0u8; 12]);
    let pt = b"sessionid=test; csrftoken=abc".to_vec();
    let ct = cipher.encrypt(nonce, pt.as_slice()).unwrap();
    let back = cipher.decrypt(nonce, ct.as_slice()).unwrap();
    assert_eq!(pt, back);
    println!("[OK] AES-256-GCM round-trip correcto ({} bytes)", pt.len());

    for p in discover() {
        match std::fs::File::open(&p.cookies_path) {
            Ok(f) => {
                let meta = f.metadata().map(|m| m.len()).unwrap_or(0);
                println!(
                    "[OK] Rust abrio {} ({} bytes) en vivo",
                    p.cookies_path, meta
                );
            }
            Err(e) => {
                println!("[XX] Rust no pudo abrir {}: {e}", p.cookies_path);
            }
        }
    }
}