// Thore — the app is the web frontend in ../renderer; the shell stays minimal.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Thore");
}
