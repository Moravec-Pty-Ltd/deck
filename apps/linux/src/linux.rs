// The Linux-only parts: WebKitGTK settings, freedesktop notifications, and the
// XDG portals for the colour scheme and a Wayland global shortcut.

use std::collections::HashMap;
use std::sync::Mutex;

use ashpd::desktop::global_shortcuts::{GlobalShortcuts, NewShortcut};
use ashpd::desktop::settings::{ColorScheme, Settings};
use futures_util::StreamExt;
use tauri::{AppHandle, Manager, Theme, WebviewWindow};

use crate::core::xdg_trigger;

// The files in the last drop GTK delivered to the window, as paths. Connected
// handlers run before WebKit's own, so this is set before the page sees the drop.
static DROPPED: Mutex<Vec<std::path::PathBuf>> = Mutex::new(Vec::new());
// GTK also delivers the data while a drag only hovers; only a real drop arms it.
static DROP_ARMED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn tune_webview(window: &WebviewWindow) {
	let _ = window.with_webview(|webview| {
		use gtk::prelude::{DragContextExtManual, WidgetExt};
		use webkit2gtk::{SettingsExt, WebViewExt};
		let view = webview.inner();
		if let Some(settings) = WebViewExt::settings(&view) {
			// getUserMedia (voice mode) is off by default in WebKitGTK.
			settings.set_enable_media_stream(true);
		}
		// WebKit asks for each target in turn; the uri-list one carries the files,
		// and a later uri-list drag (a link, say) replaces them. A drag that starts
		// in the shell (the page's own, which can carry any file:// URI) is skipped.
		view.connect_drag_leave(|_, _, _| DROP_ARMED.store(false, std::sync::atomic::Ordering::SeqCst));
		view.connect_drag_drop(|_, context, _, _, _| {
			// Paths left over from a drag that only hovered must not ride on a
			// drop that carries no files.
			if context.list_targets().iter().any(|t| t.name() == "text/uri-list") {
				DROP_ARMED.store(true, std::sync::atomic::Ordering::SeqCst);
			} else {
				DROPPED.lock().unwrap().clear();
			}
			false
		});
		view.connect_drag_data_received(|_, context, _, _, data, _, _| {
			if data.target().name() == "text/uri-list" {
				if context.drag_get_source_widget().is_some() {
					DROPPED.lock().unwrap().clear();
					return;
				}
				*DROPPED.lock().unwrap() = data.uris().iter().filter_map(|u| url::Url::parse(u).ok()?.to_file_path().ok()).collect();
			}
		});
	});
}

// Must run before GTK starts: WebKit reads the variable once, for its first view.
pub fn choose_renderer() {
	let user_set = std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER");
	if crate::core::disable_dmabuf(is_wayland(), user_set.as_deref(), std::env::var_os("DECK_WEBKIT_DMABUF").as_deref()) {
		std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
	}
}

// The WebKitGTK the shell is running on, for crash reports: the AppImage's own,
// or the system's for the deb and the tarball.
pub fn webkit_version() -> String {
	use webkit2gtk::ffi;
	unsafe { format!("{}.{}.{}", ffi::webkit_get_major_version(), ffi::webkit_get_minor_version(), ffi::webkit_get_micro_version()) }
}

// When the last "reloaded" notice went up: views that share a web process
// (deck's windows, say) all report its crash, and one dialog is enough.
static NOTICED: Mutex<Option<std::time::Instant>> = Mutex::new(None);

// A crashed web process leaves its view blank, so reload it and say so. A page
// that crashes again within a minute is left alone rather than reloaded in a loop.
pub fn recover_crashes(webview: &tauri::Webview, what: &'static str) {
	let app = webview.app_handle().clone();
	let _ = webview.with_webview(move |webview| {
		use webkit2gtk::{WebProcessTerminationReason, WebViewExt};
		let last = std::cell::Cell::new(None::<std::time::Instant>);
		webview.inner().connect_web_process_terminated(move |view, reason| {
			if reason == WebProcessTerminationReason::TerminatedByApi {
				return;
			}
			eprintln!("deck: the web process for {what} ended ({reason:?})");
			let now = std::time::Instant::now();
			let again = last.replace(Some(now)).is_some_and(|t| now - t < std::time::Duration::from_secs(60));
			if again {
				crate::tell(&app, format!("{what} crashed again within a minute, so it was not reloaded. Quit deck from the tray and start it again."));
				return;
			}
			view.reload();
			let mut noticed = NOTICED.lock().unwrap();
			if noticed.is_none_or(|t| now - t > std::time::Duration::from_secs(2)) {
				*noticed = Some(now);
				drop(noticed);
				crate::tell(&app, format!("{what} crashed and was reloaded."));
			}
		});
	});
}

// A window's webviews share a vertical box on Linux (Tauri ignores their
// bounds there), each taking an equal share. The dev browser's toolbar keeps its
// height, and the one tab shown fills the rest: hidden ones take no space.
pub fn pin_height(webview: &tauri::Webview, height: i32) {
	let _ = webview.with_webview(move |webview| {
		use gtk::prelude::{BoxExt, Cast, WidgetExt};
		let view = webview.inner();
		if let Some(parent) = view.parent().and_then(|p| p.downcast::<gtk::Box>().ok()) {
			parent.set_child_packing(&view, false, false, 0, gtk::PackType::Start);
		}
		view.set_size_request(-1, height);
	});
}

// Sends a dev browser tab through its proxy (tunnel.rs) and reports its address
// and title as they change, pushState included. wry's own proxy setting would
// drop the proxy's password. The tab's WebKit context is its window's alone.
pub fn browse_through(webview: &tauri::Webview, proxy: String, report: impl Fn(String, String) + Send + 'static) {
	let _ = webview.with_webview(move |webview| {
		use webkit2gtk::{NetworkProxyMode, NetworkProxySettings, WebViewExt, WebsiteDataManagerExt};
		let view = webview.inner();
		if let Some(manager) = view.website_data_manager() {
			manager.set_network_proxy_settings(NetworkProxyMode::Custom, Some(&mut NetworkProxySettings::new(Some(&proxy), &[])));
		}
		let report = std::rc::Rc::new(move |v: &webkit2gtk::WebView| report(v.uri().unwrap_or_default().into(), v.title().unwrap_or_default().into()));
		let on_title = report.clone();
		view.connect_uri_notify(move |v| report(v));
		view.connect_title_notify(move |v| on_title(v));
	});
}

// The page reads a drop once: dropped_files takes it (GTK also fills it while
// a drag only hovers), and each file can be served once.
static SERVING: Mutex<Vec<Option<std::path::PathBuf>>> = Mutex::new(Vec::new());

pub fn take_dropped() -> Vec<String> {
	let armed = DROP_ARMED.swap(false, std::sync::atomic::Ordering::SeqCst);
	let paths = std::mem::take(&mut *DROPPED.lock().unwrap());
	let paths = if armed { paths } else { Vec::new() };
	let names = paths.iter().map(|p| p.file_name().unwrap_or_default().to_string_lossy().into_owned()).collect();
	*SERVING.lock().unwrap() = paths.into_iter().map(Some).collect();
	names
}

pub fn serve_dropped(index: usize) -> Option<std::path::PathBuf> {
	SERVING.lock().unwrap().get_mut(index)?.take()
}

pub fn clipboard_png(app: &AppHandle) -> Option<Vec<u8>> {
	let (tx, rx) = std::sync::mpsc::channel();
	app.run_on_main_thread(move || {
		let image = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD).wait_for_image();
		let _ = tx.send(image.and_then(|i| i.save_to_bufferv("png", &[]).ok()));
	})
	.ok()?;
	rx.recv().ok().flatten()
}

pub fn is_wayland() -> bool {
	std::env::var_os("WAYLAND_DISPLAY").is_some() || std::env::var("XDG_SESSION_TYPE").is_ok_and(|t| t == "wayland")
}

// Notification ids the desktop assigned, by tag, so the next one for the same
// session replaces it instead of stacking.
static SHOWN: Mutex<Option<HashMap<String, u32>>> = Mutex::new(None);

pub fn notify(app: &AppHandle, tag: String, title: &str, body: &str, href: String) {
	let mut n = notify_rust::Notification::new();
	n.appname("deck").summary(title).body(body).icon("deck").action("default", "Open");
	if let Some(id) = SHOWN.lock().unwrap().as_ref().and_then(|m| m.get(&tag)) {
		n.id(*id);
	}
	let Ok(handle) = n.show() else { return };
	SHOWN.lock().unwrap().get_or_insert_with(HashMap::new).insert(tag, handle.id());
	let app = app.clone();
	std::thread::spawn(move || {
		handle.wait_for_action(|action| {
			if action == "default" {
				crate::open_path(&app, &href);
			}
		})
	});
}

// GTK only sees the legacy dark-theme flag; GNOME and KDE publish the user's
// choice through the settings portal, so follow that.
pub async fn follow_color_scheme(app: AppHandle) {
	let Ok(settings) = Settings::new().await else { return };
	if let Ok(scheme) = settings.color_scheme().await {
		apply_scheme(&app, scheme);
	}
	let Ok(mut changes) = settings.receive_color_scheme_changed().await else { return };
	while let Some(scheme) = changes.next().await {
		apply_scheme(&app, scheme);
	}
}

fn apply_scheme(app: &AppHandle, scheme: ColorScheme) {
	let theme = match scheme {
		ColorScheme::PreferDark => Some(Theme::Dark),
		ColorScheme::PreferLight => Some(Theme::Light),
		ColorScheme::NoPreference => None,
	};
	for window in app.windows().values() {
		let _ = window.set_theme(theme);
	}
}

// The running portal session: dropping the sender makes its task stop
// listening and close the session, which unbinds the key; the handle says when
// that is done.
static PORTAL: Mutex<Option<(tauri::async_runtime::Sender<()>, tauri::async_runtime::JoinHandle<()>)>> = Mutex::new(None);

// Closes the previous session before a new one binds the same shortcut id.
pub async fn stop_portal_shortcut() {
	let old = PORTAL.lock().unwrap().take();
	if let Some((stop, task)) = old {
		drop(stop);
		// A session still waiting on the desktop's confirmation dialog won't see
		// the stop; don't wait on it for ever.
		if tokio::time::timeout(std::time::Duration::from_secs(5), task).await.is_err() {
			eprintln!("deck: the previous shortcut session did not close");
		}
	}
}

// X11 key grabs don't reach a Wayland compositor; the GlobalShortcuts portal is
// the only way in. Returns the note the settings page shows when it isn't there
// (GNOME before 48, for one): the user binds `deck --toggle` in the desktop.
pub async fn portal_shortcut(app: &AppHandle, accelerator: &str) -> String {
	stop_portal_shortcut().await;
	let Some(trigger) = xdg_trigger(accelerator) else {
		return format!("{accelerator} is not a shortcut. Use a form like Ctrl+Alt+D.");
	};
	let (tx, mut rx) = tauri::async_runtime::channel::<Result<(), &'static str>>(1);
	let (stop, mut stopped) = tauri::async_runtime::channel::<()>(1);
	let app = app.clone();
	let task = tauri::async_runtime::spawn(async move {
		let unbound = "Your desktop has no global shortcut portal. Bind `deck --toggle` to a key in your desktop's keyboard settings instead.";
		let Ok(portal) = GlobalShortcuts::new().await else {
			let _ = tx.send(Err(unbound)).await;
			return;
		};
		let Ok(session) = portal.create_session().await else {
			let _ = tx.send(Err(unbound)).await;
			return;
		};
		let bound = async {
			let shortcut = NewShortcut::new("toggle", "Show or hide deck").preferred_trigger(trigger.as_str());
			portal.bind_shortcuts(&session, &[shortcut], None).await?.response()?;
			portal.receive_activated().await
		}
		.await;
		match bound {
			Ok(activated) => {
				let _ = tx.send(Ok(())).await;
				let mut activated = activated.take_until(Box::pin(async move { stopped.recv().await }));
				while activated.next().await.is_some() {
					crate::toggle(&app);
				}
			}
			Err(_) => {
				let _ = tx.send(Err("The desktop did not bind the shortcut. Try another, or bind `deck --toggle` in your desktop's keyboard settings.")).await;
			}
		}
		let _ = session.close().await;
	});
	*PORTAL.lock().unwrap() = Some((stop, task));
	match rx.recv().await {
		Some(Ok(())) => String::new(),
		Some(Err(note)) => note.into(),
		None => "The shortcut could not be set.".into(),
	}
}
