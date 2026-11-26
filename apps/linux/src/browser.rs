// The dev browser: a window of tabs onto a session's dev servers (or every
// session's), loaded through the tunnel (tunnel.rs) so localhost means the deck
// machine. A toolbar webview (ui/browser.html) keeps the tab list and sits above
// one webview per tab. The Apple apps' version is DeckBrowser in DeckKit.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock};

use tauri::webview::{NewWindowResponse, PermissionResponse};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewBuilder, WebviewUrl, Window};

use crate::core::{classify_browser, is_previewable, loopback_address, resolve_address, server_tabs, DevServer, Nav, ServerTab};
use crate::tunnel::{self, Route};

const BAR: f64 = 82.0;
const BAR_PAGE: &str = "browser.html";

// Each browser window's proxy, by window label. shortcut: kept for the app's
// lifetime so reopening reuses it (and the webviews' proxy settings stay
// valid); prune them if browsing many sessions ever adds up.
static PROXIES: Mutex<Vec<(String, String, Arc<Mutex<Route>>)>> = Mutex::new(Vec::new());
// One open() at a time, so a double click can't start two proxies for a window.
static OPENING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn bar_label(window: &str) -> String {
	format!("{window}-bar")
}

// The deck token, from the cookie the main window signed in with. No cookie
// (signed out, or a server that needs no token) sends an empty one, and deck
// answers as it would any request.
fn token(app: &AppHandle, server: &Url) -> String {
	crate::main_window(app)
		.and_then(|w| w.cookies_for_url(server.clone()).ok())
		.and_then(|cookies| cookies.into_iter().find(|c| c.name() == "deck_token"))
		.map(|c| percent_encoding::percent_decode_str(c.value()).decode_utf8_lossy().into_owned())
		.unwrap_or_default()
}

pub async fn open(app: AppHandle, session: Option<String>, url: Option<String>) -> Result<(), String> {
	let url = url.map(|u| loopback_address(&u).ok_or("The dev browser only opens localhost addresses from deck.")).transpose()?;
	let server = crate::server(&app).ok_or("Set the deck server first.")?;
	if session.as_deref().is_some_and(|s| s.is_empty() || s.len() > 128 || !s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')) {
		return Err("invalid session".into());
	}
	let _one = OPENING.lock().await;
	let label = session.as_ref().map_or_else(|| "browser".to_string(), |s| format!("browser-{s}"));
	let route = Route { token: token(&app, &server), server, session: session.clone() };
	match route_of(&label) {
		Some((_, shared)) => *shared.lock().unwrap() = route,
		None => {
			let proxy = tunnel::start(route).await.map_err(|e| format!("Could not start the dev browser's proxy: {e}"))?;
			PROXIES.lock().unwrap().push((label.clone(), proxy.uri(), proxy.route));
		}
	}

	if let Some(window) = app.get_window(&label) {
		let _ = window.unminimize();
		let _ = window.set_focus();
		want(app.get_webview(&bar_label(&label)), url);
		return Ok(());
	}
	let window = tauri::window::WindowBuilder::new(&app, &label)
		.title("Dev browser")
		.inner_size(1200.0, 820.0)
		.min_inner_size(480.0, 320.0)
		.build()
		.map_err(|e| e.to_string())?;
	// The bounds are ignored on Linux; pin_height lays it out.
	let bar = WebviewBuilder::new(bar_label(&label), WebviewUrl::App(BAR_PAGE.into()));
	let bar = window.add_child(bar, LogicalPosition::new(0.0, 0.0), LogicalSize::new(1200.0, BAR)).map_err(|e| {
		// A window without its toolbar would be found and focused by the next open.
		let _ = window.destroy();
		e.to_string()
	})?;
	#[cfg(target_os = "linux")]
	crate::linux::pin_height(&bar, BAR as i32);
	want(Some(bar), url);
	Ok(())
}

// Asks the toolbar for a tab on url. It may not have run its script yet, so the
// url is left where the script looks for it once it does.
fn want(bar: Option<Webview>, url: Option<Url>) {
	if let (Some(bar), Some(url)) = (bar, url) {
		let _ = bar.eval(format!("window.wanted = {}; window.openWanted?.()", serde_json::json!(url.as_str())));
	}
}

fn route_of(window: &str) -> Option<(String, Arc<Mutex<Route>>)> {
	PROXIES.lock().unwrap().iter().find(|(l, _, _)| l == window).map(|(_, uri, r)| (uri.clone(), r.clone()))
}

// The tabs the session's running dev servers call for, or every session's.
#[tauri::command]
pub async fn browser_servers(webview: Webview) -> Result<Vec<ServerTab>, String> {
	let (_, route) = route_of(webview.window().label()).ok_or("no such browser")?;
	let (server, token, session) = {
		let r = route.lock().unwrap();
		(r.server.clone(), r.token.clone(), r.session.clone())
	};
	static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
	let client = CLIENT.get_or_init(|| reqwest::Client::builder().timeout(std::time::Duration::from_secs(10)).build().unwrap_or_default());
	let get = |path: String| {
		let (client, token, url) = (client.clone(), token.clone(), server.join(&path));
		async move {
			let res = client.get(url.map_err(|e| e.to_string())?).bearer_auth(token).send().await.map_err(|e| e.to_string())?;
			match res.status() {
				reqwest::StatusCode::UNAUTHORIZED => Err("Sign in to deck in the main window, then open the dev browser again.".to_string()),
				s if !s.is_success() => Err(format!("deck answered {s}")),
				_ => res.json::<serde_json::Value>().await.map_err(|e| e.to_string()),
			}
		}
	};
	let list = |v: serde_json::Value| serde_json::from_value::<Vec<DevServer>>(v["servers"].clone()).map_err(|e| e.to_string());
	let servers = match session {
		Some(id) => list(get(format!("/api/agent/sessions/{id}/servers")).await?)?,
		None => {
			// Sorted, so the tabs keep their order from one poll to the next.
			let states: BTreeMap<String, Vec<String>> = serde_json::from_value(get("/api/agent/servers".into()).await?).map_err(|e| e.to_string())?;
			let live = states.iter().filter(|(_, states)| states.iter().any(|s| is_previewable(s)));
			let fetched = futures_util::future::join_all(live.map(|(id, _)| get(format!("/api/agent/sessions/{id}/servers")))).await;
			// A session that ends between the two calls just has no tabs.
			fetched.into_iter().filter_map(|r| r.ok().and_then(|v| list(v).ok())).flatten().collect()
		}
	};
	Ok(server_tabs(&servers))
}

// What the toolbar does to a tab: open (load an address, creating the tab's
// webview the first time), show, close, back, forward, reload.
#[tauri::command]
pub async fn browser_tab(webview: Webview, tab: String, action: String, address: Option<String>) -> Result<(), String> {
	if tab.is_empty() || !tab.chars().all(|c| c.is_ascii_alphanumeric()) {
		return Err("invalid tab".into());
	}
	let window = webview.window();
	let label = format!("{}-tab-{tab}", window.label());
	let view = window.webviews().into_iter().find(|v| v.label() == label);
	let result = match (action.as_str(), view) {
		("open", view) => {
			let url = address.as_deref().and_then(resolve_address).ok_or("Not an address deck can open.")?;
			let view = match view {
				Some(v) => v,
				None => add_tab(&window, &label, &tab)?,
			};
			let shown = show_only(&window, &label);
			view.navigate(url).and(shown)
		}
		("show", Some(_)) => show_only(&window, &label),
		("close", Some(v)) => v.close(),
		("back", Some(v)) => v.eval("history.back()"),
		("forward", Some(v)) => v.eval("history.forward()"),
		("reload", Some(v)) => v.reload(),
		(_, None) => return Ok(()),
		_ => return Err("unknown action".into()),
	};
	result.map_err(|e| e.to_string())
}

fn show_only(window: &Window, label: &str) -> tauri::Result<()> {
	let tabs = format!("{}-tab-", window.label());
	for view in window.webviews().into_iter().filter(|v| v.label().starts_with(&tabs)) {
		if view.label() == label {
			view.show()?;
			view.set_focus()?;
		} else {
			view.hide()?;
		}
	}
	Ok(())
}

fn add_tab(window: &Window, label: &str, tab: &str) -> Result<Webview, String> {
	let (proxy, _) = route_of(window.label()).ok_or("no such browser")?;
	let app = window.app_handle().clone();
	let bar = bar_label(window.label());
	// Its own data directory gives the browser its own WebKit context: the proxy
	// is set per context, and the main window's must stay direct.
	let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("browser").join(window.label());
	let (nav_app, new_app, new_bar) = (app.clone(), app.clone(), bar.clone());
	let builder = WebviewBuilder::new(label, WebviewUrl::External("about:blank".parse().unwrap()))
		.data_directory(dir)
		// Drops reach the page, as in a browser.
		.disable_drag_drop_handler()
		.initialization_script(crate::PAGE_SCRIPT)
		.on_navigation(move |url| match classify_browser(url) {
			Nav::Inside => true,
			Nav::External => {
				crate::open_external(&nav_app, url);
				false
			}
			Nav::Block => false,
		})
		// A link that opens a window opens a tab instead.
		.on_new_window(move |url, _| {
			match (classify_browser(&url), new_app.get_webview(&new_bar)) {
				(Nav::Inside, Some(bar)) => {
					let _ = bar.eval(format!("openTab({})", serde_json::json!(url.as_str())));
				}
				(Nav::External, _) => crate::open_external(&new_app, &url),
				_ => {}
			}
			NewWindowResponse::Deny
		})
		.on_download(move |_, event| crate::download(&app, event))
		.on_permission_request(|_, _| PermissionResponse::Deny);
	let size = window.inner_size().map_err(|e| e.to_string())?.to_logical::<f64>(window.scale_factor().unwrap_or(1.0));
	let view = window
		.add_child(builder, LogicalPosition::new(0.0, BAR), LogicalSize::new(size.width, (size.height - BAR).max(0.0)))
		.map_err(|e| e.to_string())?;
	let (report_app, tab) = (window.app_handle().clone(), tab.to_string());
	#[cfg(target_os = "linux")]
	crate::linux::browse_through(&view, proxy, move |url, title| {
		if let Some(bar) = report_app.get_webview(&bar) {
			let _ = bar.eval(format!("onPage({})", serde_json::json!({ "tab": tab, "url": url, "title": title })));
		}
	});
	#[cfg(not(target_os = "linux"))]
	let _ = (proxy, report_app, tab, bar);
	Ok(view)
}
