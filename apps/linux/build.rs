fn main() {
	// App commands get permissions so a capability can grant them to the remote
	// deck origin (see allow_server in main.rs).
	let commands = &["get_settings", "save_settings", "editor_available", "open_editor", "set_attention", "notify", "clipboard_image", "dropped_files", "dropped_file"];
	tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(commands)))
		.expect("tauri build script failed");
}
