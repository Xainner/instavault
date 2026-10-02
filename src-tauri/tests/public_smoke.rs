use instavault_lib::instagram::provider::WebProvider;
use std::sync::{Arc, Mutex};

/// Red real, sólo anónima y bajo ejecución manual. Es ignorada en CI para no
/// convertir el build en tráfico periódico hacia Instagram.
#[test]
#[ignore = "smoke manual anónimo"]
fn public_lookup_never_requires_an_account() {
    let provider = WebProvider::public(Arc::new(Mutex::new(None)));
    let username =
        std::env::var("INSTAVAULT_PUBLIC_SMOKE_USER").unwrap_or_else(|_| "instagram".to_string());
    match provider.lookup_profile(&username) {
        Ok(profile) => {
            println!("public_ok username={}", profile.username);
            assert_eq!(profile.username, username);
            match provider.sync_media_batch(&username, "post", 30, None, None) {
                Ok(batch) => {
                    println!(
                        "public_batch publications={} assets={} status={:?}",
                        batch.publication_codes.len(),
                        batch.media.len(),
                        batch.status
                    );
                    assert!(!batch.publication_codes.is_empty());
                    assert!(batch
                        .publication_codes
                        .iter()
                        .all(|code| code != "p" && code != "reel"));
                }
                Err(error) => {
                    println!("public_posts_safe_error code={}", error.code);
                    assert!(matches!(
                        error.code,
                        "public_blocked" | "network" | "provider_changed"
                    ));
                }
            }
        }
        Err(error) => {
            println!("public_safe_error code={}", error.code);
            assert!(matches!(
                error.code,
                "public_blocked" | "network" | "provider_changed"
            ));
        }
    }
}
