use std::sync::{Arc, Mutex};
use std::net::TcpListener;
use tauri::Manager;
use sha2::{Sha256, Digest};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::Rng;

#[derive(serde::Serialize)]
struct OAuthResult {
    code: String,
    redirect_uri: String,
    code_verifier: String,
}

fn generate_code_verifier() -> String {
    let random_bytes: Vec<u8> = (0..32).map(|_| rand::thread_rng().gen::<u8>()).collect();
    URL_SAFE_NO_PAD.encode(random_bytes)
}

fn generate_code_challenge(verifier: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let result = hasher.finalize();
    URL_SAFE_NO_PAD.encode(result)
}

#[tauri::command]
async fn start_oauth_flow(client_id: String, scopes: String) -> Result<OAuthResult, String> {
    // Use fixed port 3737 for OAuth redirect
    let port = 3737;
    let listener = TcpListener::bind(format!("127.0.0.1:{}", port))
        .map_err(|e| format!("Failed to bind port {}: {}. Make sure port {} is not in use.", port, e, port))?;

    let redirect_uri = format!("http://localhost:{}", port);

    // Generate PKCE parameters
    let code_verifier = generate_code_verifier();
    let code_challenge = generate_code_challenge(&code_verifier);

    // Build OAuth URL with PKCE
    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent&code_challenge={}&code_challenge_method=S256",
        client_id,
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(&scopes),
        urlencoding::encode(&code_challenge)
    );

    // Store the auth code
    let auth_code = Arc::new(Mutex::new(None));
    let auth_code_clone = auth_code.clone();

    // Start HTTP server in background
    let redirect_uri_clone = redirect_uri.clone();
    std::thread::spawn(move || {
        let server = tiny_http::Server::from_listener(listener, None).unwrap();

        if let Ok(request) = server.recv() {
            let url = request.url();

            // Parse query parameters
            if let Some(query) = url.split('?').nth(1) {
                for param in query.split('&') {
                    if let Some((key, value)) = param.split_once('=') {
                        if key == "code" {
                            let decoded = urlencoding::decode(value).unwrap_or_default();
                            *auth_code_clone.lock().unwrap() = Some(decoded.to_string());

                            // Send success response
                            let response = tiny_http::Response::from_string(
                                "Authentication successful! You can close this window and return to the app."
                            );
                            let _ = request.respond(response);
                            break;
                        }
                    }
                }
            }
        }
    });

    // Open browser
    open::that(&auth_url).map_err(|e| format!("Failed to open browser: {}", e))?;

    // Wait for auth code (with timeout)
    for _ in 0..60 {
        std::thread::sleep(std::time::Duration::from_secs(1));
        if let Some(code) = auth_code.lock().unwrap().as_ref() {
            return Ok(OAuthResult {
                code: code.clone(),
                redirect_uri,
                code_verifier,
            });
        }
    }

    Err("OAuth timeout: No response received".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .invoke_handler(tauri::generate_handler![start_oauth_flow])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
