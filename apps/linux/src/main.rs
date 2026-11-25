// deck's Linux desktop shell: a window onto the user's deck server plus the
// native bits a browser tab can't do (tray, notifications, Open in Zed, deck://
// links, a global shortcut). It never bundles the web app, so a server update
// needs no new shell. The web side of the bridge is src/lib/shell.ts.

mod browser;
mod core;
mod tunnel;
#[cfg(target_os = "linux")]
mod linux;

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::ipc::CapabilityBuilder;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::webview::{DownloadEvent, NewWindowResponse, PermissionKind, PermissionResponse};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

use crate::core::{classify, deck_link_path, find_zed, is_app_path, parse_server, zed_arg, Nav, UpdatePrompt};

const MAIN: &str = "main";
const SETTINGS_PAGE: &str = "index.html";
// What the remote deck page may call; see allow_server. Zoom is for
// zoom_hotkeys_enabled's key handler.
const SERVER_PERMISSIONS: &[&str] = &[
	"core:webview:allow-set-webview-zoom",
	"allow-editor-available",
	"allow-open-editor",
	"allow-set-attention",
	"allow-notify",
	"allow-clipboard-image",
	"allow-dropped-files",
	"allow-dropped-file",
	"allow-open-dev-browser",
];
// Runs in every page. WebKitGTK has no reload key of its own (zoom keys come
// from zoom_hotkeys_enabled). It also hands the page a pasted image as an empty
// clipboardData, and a dropped file as a file:// URI with no File, so both are
// sent again carrying the bytes the shell reads (clipboard_image, dropped_file).
const PAGE_SCRIPT: &str = r#"
addEventListener('keydown', (e) => {
	if ((e.ctrlKey && e.key === 'r') || e.key === 'F5') { e.preventDefault(); location.reload(); }
});
addEventListener('paste', async (e) => {
	if (!e.isTrusted || e.clipboardData?.types.length) return;
	const png = await window.__TAURI_INTERNALS__?.invoke('clipboard_image').catch(() => null);
	if (!png?.byteLength) return;
	const data = new DataTransfer();
	data.items.add(new File([png], 'pasted.png', { type: 'image/png' }));
	e.target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
}, true);
addEventListener('drop', async (e) => {
	const ipc = window.__TAURI_INTERNALS__;
	if (!e.isTrusted || !ipc || e.dataTransfer?.files.length || !e.dataTransfer?.types.includes('text/uri-list')) return;
	const names = await ipc.invoke('dropped_files').catch(() => []);
	const data = new DataTransfer();
	for (const [index, name] of names.entries()) {
		const bytes = await ipc.invoke('dropped_file', { index }).catch(() => null);
		if (bytes) data.items.add(new File([bytes], name));
	}
	if (data.files.length) e.target.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
}, true);
"#;

#[derive(Default, Clone, Serialize, Deserialize)]
struct Settings {
	server: Option<String>,
	shortcut: Option<String>,
}

#[derive(Clone, Deserialize)]
struct Attention {
	title: String,
	href: String,
}

#[derive(Default)]
struct Shell {
	settings: Mutex<Settings>,
	attention: Mutex<Vec<Attention>>,
	// Why the global shortcut isn't live, for the settings page. Empty when it is.
	shortcut_note: Mutex<String>,
	// Where the window was hidden: some window managers place it anew on show.
	hidden_at: Mutex<Option<tauri::PhysicalPosition<i32>>>,
	update: Mutex<UpdatePrompt>,
}

fn settings_file(app: &AppHandle) -> Option<PathBuf> {
	app.path().app_config_dir().ok().map(|d| d.join("settings.json"))
}

fn load_settings(app: &AppHandle) -> Settings {
	settings_file(app)
		.and_then(|f| std::fs::read(f).ok())
		.and_then(|b| serde_json::from_slice(&b).ok())
		.unwrap_or_default()
}

fn store_settings(app: &AppHandle, settings: &Settings) -> Result<(), String> {
	let file = settings_file(app).ok_or("no config directory")?;
	std::fs::create_dir_all(file.parent().unwrap()).map_err(|e| e.to_string())?;
	std::fs::write(file, serde_json::to_vec_pretty(settings).unwrap()).map_err(|e| e.to_string())
}

fn server(app: &AppHandle) -> Option<Url> {
	app.state::<Shell>().settings.lock().unwrap().server.as_deref().and_then(parse_server)
}

// Remote pages get no IPC unless a capability names their origin, and the origin
// is only known at run time.
fn allow_server(app: &AppHandle, server: &Url) {
	let origin = server.origin().ascii_serialization();
	let mut cap = CapabilityBuilder::new(format!("server-{}", origin.replace(|c: char| !c.is_ascii_alphanumeric(), "-")))
		.remote(format!("{origin}/*"))
		.window(MAIN);
	for &p in SERVER_PERMISSIONS {
		cap = cap.permission(p);
	}
	if let Err(e) = app.add_capability(cap) {
		eprintln!("deck: could not allow {origin}: {e}");
	}
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
	app.get_webview_window(MAIN)
}

fn show(app: &AppHandle) {
	if let Some(w) = main_window(app) {
		if let Some(at) = app.state::<Shell>().hidden_at.lock().unwrap().take() {
			let _ = w.set_position(at);
		}
		let _ = w.unminimize();
		let _ = w.show();
		let _ = w.set_focus();
	}
}

fn hide(app: &AppHandle) {
	let _ = app.save_window_state(StateFlags::all() - StateFlags::VISIBLE);
	if let Some(w) = main_window(app) {
		*app.state::<Shell>().hidden_at.lock().unwrap() = w.outer_position().ok();
		let _ = w.hide();
	}
}

fn toggle(app: &AppHandle) {
	let shown = main_window(app).is_some_and(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false));
	if shown {
		hide(app)
	} else {
		show(app)
	}
}

// Open a deck path in the main window: through the web app's router when deck
// is already loaded (no reload), else by loading it.
fn open_path(app: &AppHandle, path: &str) {
	show(app);
	let (Some(server), Some(w)) = (server(app), main_window(app)) else { return };
	if !is_app_path(path) {
		return;
	}
	if w.url().is_ok_and(|u| u.origin() == server.origin()) {
		let detail = serde_json::to_string(path).unwrap();
		let _ = w.eval(format!("window.dispatchEvent(new CustomEvent('deck:open', {{ detail: {detail} }}))"));
	} else if let Ok(url) = server.join(path) {
		let _ = w.navigate(url);
	}
}

fn open_link(app: &AppHandle, link: &Url) {
	match deck_link_path(link) {
		Some(path) => open_path(app, &path),
		None => show(app),
	}
}

fn open_settings(app: &AppHandle) {
	if let Some(w) = app.get_webview_window("settings") {
		let _ = w.set_focus();
		return;
	}
	let _ = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App(SETTINGS_PAGE.into()))
		.title("deck settings")
		.inner_size(520.0, 560.0)
		.build();
}

fn open_external(app: &AppHandle, url: &Url) {
	let _ = app.opener().open_url(url.as_str(), None::<&str>);
}

// `path` is where a deck:// link that launched the shell points: loaded
// directly, since the page can't take a deck:open event before it hydrates.
fn build_main(app: &AppHandle, path: Option<&str>) -> tauri::Result<WebviewWindow> {
	let start = match server(app) {
		Some(s) => WebviewUrl::External(path.and_then(|p| s.join(p).ok()).unwrap_or(s)),
		None => WebviewUrl::App(SETTINGS_PAGE.into()),
	};
	let window = shell_window(app, MAIN, start).title("deck").inner_size(1280.0, 860.0).min_inner_size(420.0, 360.0).build()?;
	#[cfg(target_os = "linux")]
	linux::tune_webview(&window);
	Ok(window)
}

static VIEWS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

// A window onto the deck server with the shell's rules. A deck page opened in a
// new tab (a file, a session) gets another of these, as a browser tab would;
// anything off the deck origin goes to the browser.
fn shell_window<'a>(app: &'a AppHandle, label: &str, url: WebviewUrl) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
	let nav_app = app.clone();
	let new_window_app = app.clone();
	let download_app = app.clone();
	let permission_app = app.clone();
	WebviewWindowBuilder::new(app, label, url)
		// Files dropped on the composer must reach the web app, not Tauri.
		.disable_drag_drop_handler()
		.zoom_hotkeys_enabled(true)
		.initialization_script(PAGE_SCRIPT)
		.on_navigation(move |url| match classify(url, server(&nav_app).as_ref()) {
			Nav::Inside => true,
			Nav::External => {
				open_external(&nav_app, url);
				false
			}
			Nav::Block => false,
		})
		.on_new_window(move |url, features| {
			let app = &new_window_app;
			match classify(&url, server(app).as_ref()) {
				Nav::Inside => {}
				Nav::External => {
					open_external(app, &url);
					return NewWindowResponse::Deny;
				}
				Nav::Block => return NewWindowResponse::Deny,
			}
			let label = format!("view-{}", VIEWS.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
			let blank = WebviewUrl::External("about:blank".parse().unwrap());
			match shell_window(app, &label, blank).window_features(features).title("deck").inner_size(1000.0, 760.0).build() {
				Ok(window) => NewWindowResponse::Create { window },
				Err(_) => NewWindowResponse::Deny,
			}
		})
		.on_download(move |_, event| download(&download_app, event))
		// Voice mode records through getUserMedia, which WebKitGTK denies unless the
		// shell grants it. Only the deck server gets the microphone.
		.on_permission_request(move |webview, kind| {
			let from_server = server(&permission_app).is_some_and(|s| webview.url().is_ok_and(|u| u.origin() == s.origin()));
			match kind {
				PermissionKind::Microphone if from_server => PermissionResponse::Allow,
				_ => PermissionResponse::Deny,
			}
		})
}

static DOWNLOADS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
// Downloads in flight: URL, scratch folder, file name. A failed one reports no
// path, so it is found by URL.
static DOWNLOAD_DIRS: Mutex<Vec<(String, PathBuf, String)>> = Mutex::new(Vec::new());

fn scratch_dir(app: &AppHandle) -> Option<PathBuf> {
	app.path().app_cache_dir().ok().map(|d| d.join("downloads"))
}

fn tell(app: &AppHandle, text: String) {
	app.dialog().message(text).show(|_| {});
}

// WebKitGTK does nothing with a download unless the shell picks a destination.
// Each one lands in a scratch folder of its own, then the user says where it goes.
fn download(app: &AppHandle, event: DownloadEvent<'_>) -> bool {
	match event {
		DownloadEvent::Requested { url, destination } => {
			// wry's suggestion already avoids a clash in ~/Downloads, where the dialog opens.
			let name = destination.file_name().map(|n| n.to_owned()).unwrap_or_else(|| "download".into());
			let n = DOWNLOADS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
			let Some(dir) = scratch_dir(app).map(|d| d.join(n.to_string())).filter(|d| std::fs::create_dir_all(d).is_ok()) else {
				tell(app, format!("Could not download {}: no folder to save it in.", name.to_string_lossy()));
				return false;
			};
			DOWNLOAD_DIRS.lock().unwrap().push((url.to_string(), dir.clone(), name.to_string_lossy().into_owned()));
			*destination = dir.join(name);
			true
		}
		DownloadEvent::Finished { url, path, success } => {
			let entry = {
				let mut dirs = DOWNLOAD_DIRS.lock().unwrap();
				let parent = path.as_deref().and_then(|p| p.parent());
				let found = match parent {
					Some(parent) => dirs.iter().position(|(_, d, _)| d == parent),
					None => dirs.iter().position(|(u, _, _)| *u == url.as_str()),
				};
				found.map(|i| dirs.remove(i))
			};
			// None: a download the shell cancelled itself, already reported.
			let Some((_, dir, name)) = entry else { return true };
			let (Some(path), true) = (path, success) else {
				let _ = std::fs::remove_dir_all(&dir);
				tell(app, format!("The download of {name} failed."));
				return true;
			};
			let mut dialog = app.dialog().file();
			if let Some(name) = path.file_name() {
				dialog = dialog.set_file_name(name.to_string_lossy());
			}
			if let Ok(downloads) = app.path().download_dir() {
				dialog = dialog.set_directory(downloads);
			}
			let app = app.clone();
			dialog.save_file(move |picked| {
				let Some(picked) = picked else {
					let _ = std::fs::remove_dir_all(&dir);
					return;
				};
				let saved = picked.into_path().ok().filter(|dest| std::fs::rename(&path, dest).is_ok() || std::fs::copy(&path, dest).is_ok());
				match saved {
					Some(_) => {
						let _ = std::fs::remove_dir_all(&dir);
					}
					None => tell(&app, format!("Could not save the file there. Until deck quits it is at {}.", path.display())),
				}
			});
			true
		}
		_ => true,
	}
}

fn tray_menu(app: &AppHandle, attention: &[Attention]) -> tauri::Result<Menu<tauri::Wry>> {
	let menu = Menu::new(app)?;
	menu.append(&MenuItem::with_id(app, "show", "Show deck", true, None::<&str>)?)?;
	menu.append(&PredefinedMenuItem::separator(app)?)?;
	if attention.is_empty() {
		menu.append(&MenuItem::with_id(app, "none", "Nothing needs you", false, None::<&str>)?)?;
	}
	for (i, item) in attention.iter().enumerate() {
		menu.append(&MenuItem::with_id(app, format!("open:{i}"), &item.title, true, None::<&str>)?)?;
	}
	menu.append(&PredefinedMenuItem::separator(app)?)?;
	menu.append(&MenuItem::with_id(app, "new", "Start a session", true, None::<&str>)?)?;
	menu.append(&MenuItem::with_id(app, "inbox", "Inbox", true, None::<&str>)?)?;
	menu.append(&MenuItem::with_id(app, "browser", "Dev browser", true, None::<&str>)?)?;
	menu.append(&PredefinedMenuItem::separator(app)?)?;
	menu.append(&MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?)?;
	menu.append(&MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?)?;
	Ok(menu)
}

fn on_menu(app: &AppHandle, id: &str) {
	match id {
		"show" => show(app),
		"new" => open_path(app, "/?new=1"),
		"inbox" => open_path(app, "/inbox"),
		"settings" => open_settings(app),
		"browser" => {
			let app = app.clone();
			tauri::async_runtime::spawn(async move {
				if let Err(e) = browser::open(app.clone(), None, None).await {
					tell(&app, e);
				}
			});
		}
		"quit" => {
			let _ = app.save_window_state(StateFlags::all() - StateFlags::VISIBLE);
			app.exit(0)
		}
		_ => {
			let href = id
				.strip_prefix("open:")
				.and_then(|i| i.parse::<usize>().ok())
				.and_then(|i| app.state::<Shell>().attention.lock().unwrap().get(i).map(|a| a.href.clone()));
			if let Some(href) = href {
				open_path(app, &href);
			}
		}
	}
}

async fn apply_shortcut(app: &AppHandle, accelerator: Option<&str>) {
	let note = match accelerator.map(str::trim).filter(|a| !a.is_empty()) {
		None => {
			let _ = app.global_shortcut().unregister_all();
			#[cfg(target_os = "linux")]
			linux::stop_portal_shortcut().await;
			String::new()
		}
		#[cfg(target_os = "linux")]
		Some(accel) if linux::is_wayland() => linux::portal_shortcut(app, accel).await,
		Some(accel) => {
			let _ = app.global_shortcut().unregister_all();
			match app.global_shortcut().register(accel) {
				Ok(()) => String::new(),
				Err(e) => format!("Could not register {accel}: {e}"),
			}
		}
	};
	*app.state::<Shell>().shortcut_note.lock().unwrap() = note;
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsView {
	server: Option<String>,
	shortcut: Option<String>,
	autostart: bool,
	shortcut_note: String,
}

#[tauri::command]
fn get_settings(app: AppHandle) -> SettingsView {
	let shell = app.state::<Shell>();
	let settings = shell.settings.lock().unwrap().clone();
	let shortcut_note = shell.shortcut_note.lock().unwrap().clone();
	SettingsView {
		server: settings.server,
		shortcut: settings.shortcut,
		autostart: app.autolaunch().is_enabled().unwrap_or(false),
		shortcut_note,
	}
}

// Async so the portal's confirmation dialog doesn't freeze the window.
#[tauri::command]
async fn save_settings(app: AppHandle, window: WebviewWindow, server: String, shortcut: String, autostart: bool) -> Result<String, String> {
	let url = parse_server(&server).ok_or("Enter the deck server's address, like http://deck.example:4818")?;
	let shortcut = Some(shortcut.trim().to_string()).filter(|s| !s.is_empty());
	let next = Settings { server: Some(url.to_string()), shortcut: shortcut.clone() };
	store_settings(&app, &next)?;
	let shell = app.state::<Shell>();
	let (changed, had_server) = {
		let mut current = shell.settings.lock().unwrap();
		let before = current.server.clone();
		*current = next;
		(before != current.server, before.is_some())
	};
	let _ = if autostart { app.autolaunch().enable() } else { app.autolaunch().disable() };
	// A granted origin can't be revoked, so a switch from one server to another
	// restarts the shell, which then grants only the new one.
	if changed && had_server {
		app.restart();
	}
	apply_shortcut(&app, shortcut.as_deref()).await;
	if changed || main_window(&app).is_some_and(|w| w.url().is_ok_and(|u| u.scheme() == "tauri")) {
		allow_server(&app, &url);
		if let Some(w) = main_window(&app) {
			let _ = w.navigate(url);
		}
	}
	let note = app.state::<Shell>().shortcut_note.lock().unwrap().clone();
	if note.is_empty() && window.label() == "settings" {
		let _ = window.close();
	}
	Ok(note)
}

#[tauri::command]
fn editor_available() -> bool {
	find_zed(std::env::var_os("PATH").as_deref(), std::env::var_os("HOME").map(PathBuf::from).as_deref()).is_some()
}

#[tauri::command]
fn open_editor(command: String) -> Result<(), String> {
	let arg = zed_arg(&command).ok_or("not a Zed command")?;
	let zed = find_zed(std::env::var_os("PATH").as_deref(), std::env::var_os("HOME").map(PathBuf::from).as_deref())
		.ok_or("Zed is not installed")?;
	let mut command = std::process::Command::new(zed);
	command.arg(arg);
	// An AppImage's library path is for the shell, not for Zed.
	if std::env::var_os("APPIMAGE").is_some() {
		command.env_remove("LD_LIBRARY_PATH");
	}
	let mut child = command.spawn().map_err(|e| e.to_string())?;
	std::thread::spawn(move || child.wait());
	Ok(())
}

// The sessions and runs waiting on the user, from the web app's inbox count.
#[tauri::command]
fn set_attention(app: AppHandle, items: Vec<Attention>) {
	let Some(tray) = app.tray_by_id("tray") else { return };
	let count = items.len();
	let _ = tray.set_title(match count {
		0 => None,
		1..=9 => Some(count.to_string()),
		_ => Some("9+".into()),
	});
	if let Ok(menu) = tray_menu(&app, &items) {
		let _ = tray.set_menu(Some(menu));
	}
	*app.state::<Shell>().attention.lock().unwrap() = items;
}

// One notification per session (tag): a second ask replaces the first.
#[tauri::command]
fn notify(app: AppHandle, tag: String, title: String, body: String, href: String) {
	#[cfg(target_os = "linux")]
	linux::notify(&app, tag, &title, &body, href);
	#[cfg(not(target_os = "linux"))]
	let _ = (app, tag, title, body, href);
}

// The image on the system clipboard as PNG, for PAGE_SCRIPT's paste fix. Async
// so it runs off the main thread the clipboard read has to wait on.
#[tauri::command]
async fn clipboard_image(app: AppHandle) -> tauri::ipc::Response {
	#[cfg(target_os = "linux")]
	let png = linux::clipboard_png(&app).unwrap_or_default();
	#[cfg(not(target_os = "linux"))]
	let png = {
		let _ = app;
		Vec::new()
	};
	tauri::ipc::Response::new(png)
}

// The files in the user's last drop on the window, for PAGE_SCRIPT's drop fix.
// The page only picks by index: it gets paths GTK delivered, never one it names.
#[tauri::command]
fn dropped_files() -> Vec<String> {
	#[cfg(target_os = "linux")]
	return linux::take_dropped();
	#[cfg(not(target_os = "linux"))]
	Vec::new()
}

#[tauri::command]
async fn dropped_file(index: usize) -> Result<tauri::ipc::Response, String> {
	#[cfg(target_os = "linux")]
	let path = linux::serve_dropped(index);
	#[cfg(not(target_os = "linux"))]
	let path: Option<PathBuf> = { let _ = index; None };
	let path = path.ok_or("no such dropped file")?;
	std::fs::read(path).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

// The dev browser on a session's servers, from the deck page's session header, or on
// one server's url, from its Servers tab.
#[tauri::command]
async fn open_dev_browser(app: AppHandle, session: String, url: Option<String>) -> Result<(), String> {
	let opened = browser::open(app.clone(), Some(session), url).await;
	if let Err(e) = &opened {
		tell(&app, e.clone());
	}
	opened
}

// The AppImage updates itself from GitHub releases; a deb updates through apt. A shell
// hidden to the tray can run for days, so this runs at start and every UPDATE_EVERY.
const UPDATE_EVERY: std::time::Duration = std::time::Duration::from_secs(6 * 60 * 60);

async fn check_update(app: AppHandle) -> tauri_plugin_updater::Result<()> {
	let Some(update) = app.updater()?.check().await? else { return Ok(()) };
	let version = update.version.clone();
	if !app.state::<Shell>().update.lock().unwrap().offer(&version) {
		return Ok(());
	}
	let handle = app.clone();
	app.dialog()
		.message(format!("deck {version} is available. Install it and restart?"))
		.title("Update deck")
		.buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom("Update".into(), "Later".into()))
		.show(move |yes| {
			if !yes {
				handle.state::<Shell>().update.lock().unwrap().close(Some(&version));
				return;
			}
			tauri::async_runtime::spawn(async move {
				match update.download_and_install(|_, _| {}, || {}).await {
					Ok(()) => handle.restart(),
					Err(e) => {
						eprintln!("deck: update install failed: {e}");
						handle.state::<Shell>().update.lock().unwrap().close(None);
					}
				}
			});
		});
	Ok(())
}

fn main() {
	tauri::Builder::default()
		.plugin(tauri_plugin_single_instance::init(|app, argv, _| {
			if argv.iter().any(|a| a == "--toggle") {
				toggle(app)
			} else if !argv.iter().any(|a| a.starts_with("deck://")) {
				show(app)
			}
		}))
		.plugin(tauri_plugin_deep_link::init())
		.plugin(
			tauri_plugin_window_state::Builder::default()
				.with_state_flags(StateFlags::all() - StateFlags::VISIBLE)
				.with_filter(|label| label == MAIN)
				.build(),
		)
		.plugin(tauri_plugin_autostart::Builder::new().build())
		.plugin(
			tauri_plugin_global_shortcut::Builder::new()
				.with_handler(|app, _, event| {
					if event.state == ShortcutState::Pressed {
						toggle(app)
					}
				})
				.build(),
		)
		.plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
		.plugin(tauri_plugin_dialog::init())
		.plugin(tauri_plugin_updater::Builder::new().build())
		.manage(Shell::default())
		.invoke_handler(tauri::generate_handler![get_settings, save_settings, editor_available, open_editor, set_attention, notify, clipboard_image, dropped_files, dropped_file, open_dev_browser, browser::browser_servers, browser::browser_tab])
		.setup(|app| {
			// reqwest and the tunnel's TLS use the process's crypto provider.
			let _ = rustls::crypto::ring::default_provider().install_default();
			let handle = app.handle().clone();
			if let Some(scratch) = scratch_dir(&handle) {
				let _ = std::fs::remove_dir_all(scratch);
			}
			let settings = load_settings(&handle);
			*app.state::<Shell>().settings.lock().unwrap() = settings.clone();
			if let Some(url) = server(&handle) {
				allow_server(&handle, &url);
			}

			TrayIconBuilder::with_id("tray")
				.icon(app.default_window_icon().cloned().expect("bundle icon"))
				.tooltip("deck")
				.menu(&tray_menu(&handle, &[])?)
				.on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
				.build(app)?;

			let launched_with = app.deep_link().get_current().ok().flatten().unwrap_or_default();
			let start_path = launched_with.iter().find_map(deck_link_path);
			build_main(&handle, start_path.as_deref())?;
			let shortcut_app = handle.clone();
			tauri::async_runtime::spawn(async move { apply_shortcut(&shortcut_app, settings.shortcut.as_deref()).await });

			// The deb's desktop file registers deck://; an AppImage registers itself.
			if std::env::var_os("APPIMAGE").is_some() {
				let _ = app.deep_link().register_all();
			}
			let link_app = handle.clone();
			app.deep_link().on_open_url(move |event| {
				for url in event.urls() {
					open_link(&link_app, &url);
				}
			});

			#[cfg(target_os = "linux")]
			tauri::async_runtime::spawn(linux::follow_color_scheme(handle.clone()));
			if std::env::var_os("APPIMAGE").is_some() {
				let app = handle.clone();
				tauri::async_runtime::spawn(async move {
					loop {
						if let Err(e) = check_update(app.clone()).await {
							eprintln!("deck: update check failed: {e}");
						}
						tokio::time::sleep(UPDATE_EVERY).await;
					}
				});
			}
			Ok(())
		})
		.on_window_event(|window, event| {
			// Closing the window hides it to the tray; Quit is in the tray menu.
			if let WindowEvent::CloseRequested { api, .. } = event {
				if window.label() == MAIN {
					api.prevent_close();
					hide(window.app_handle());
				}
			}
		})
		.run(tauri::generate_context!())
		.expect("deck shell failed to start");
}
