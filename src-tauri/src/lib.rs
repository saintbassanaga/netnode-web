use argon2::Argon2;

/// Derives a 32-byte stronghold vault key from an arbitrary password string.
///
/// The frontend passes the machine hostname (which the OS can provide via
/// `@tauri-apps/plugin-os`) as the "password". Argon2id makes brute-force
/// impractical while keeping derivation fast enough for startup.
fn derive_vault_key(password: &[u8]) -> Result<Vec<u8>, String> {
    // Fixed, app-specific salt — NOT a per-user random salt.
    // This is intentional: the vault must re-open deterministically without
    // storing the salt anywhere. Security relies on Argon2id's cost parameters.
    const SALT: &[u8; 22] = b"netnode-stronghold-v1!";

    let argon2 = Argon2::default(); // Argon2id, version 19
    let mut key = [0u8; 32];
    argon2
        .hash_password_into(password, SALT, &mut key)
        .map_err(|e| e.to_string())?;

    Ok(key.to_vec())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_stronghold::Builder::new(|password| {
                derive_vault_key(password.as_bytes()).expect("vault key derivation failed")
            })
            .build(),
        )
        .run(tauri::generate_context!())
        .expect("error while running NetNode");
}
