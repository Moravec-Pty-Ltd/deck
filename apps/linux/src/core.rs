// The shell's decisions, kept free of Tauri so they unit-test without a window: what a
// deck:// link opens, where a navigation goes, which editor command may run.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use url::Url;

// A path on the deck server: one leading slash, so never `//host` or a backslash
// that a browser would read as another origin.
pub fn is_app_path(path: &str) -> bool {
	path.starts_with('/') && !path.starts_with("//") && !path.contains('\\')
}

// `deck://s/<id>` parses with `s` as the host, as DeckLink.swift does on Apple.
pub fn deck_link_path(link: &Url) -> Option<String> {
	if link.scheme() != "deck" {
		return None;
	}
	let mut path = format!("/{}{}", link.host_str()?, link.path());
	if let Some(query) = link.query() {
		path.push('?');
		path.push_str(query);
	}
	is_app_path(&path).then_some(path)
}

// The server URL as typed on first launch: http(s) only, reduced to its origin.
pub fn parse_server(input: &str) -> Option<Url> {
	let input = input.trim();
	let with_scheme = if input.contains("://") { input.to_string() } else { format!("http://{input}") };
	let url = Url::parse(&with_scheme).ok()?;
	if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
		return None;
	}
	Url::parse(&url.origin().ascii_serialization()).ok()
}

#[derive(Debug, PartialEq)]
pub enum Nav {
	// The deck server, or the shell's own settings page.
	Inside,
	// Hand to the desktop's default handler (browser, mail, editor).
	External,
	Block,
}

pub fn classify(url: &Url, server: Option<&Url>) -> Nav {
	match url.scheme() {
		"tauri" | "about" | "blob" | "data" => Nav::Inside,
		"http" | "https" if server.is_some_and(|s| s.origin() == url.origin()) => Nav::Inside,
		"http" | "https" | "mailto" | "zed" | "vscode" => Nav::External,
		_ => Nav::Block,
	}
}

// The ssh:// argument of the one command shape the server composes
// (editors-core.ts): `zed ssh://user@host[:port]/path`. Anything else is refused,
// including a user or host that ssh would read as an option.
pub fn zed_arg(command: &str) -> Option<&str> {
	let arg = command.strip_prefix("zed ")?;
	if arg.chars().any(|c| c.is_whitespace() || c.is_control()) {
		return None;
	}
	let url = Url::parse(arg).ok()?;
	let host = url.host_str()?;
	// Checked as written and decoded: a `%2D` would decode to the same `-`.
	let ok = url.scheme() == "ssh" && ![url.username(), host].iter().any(|p| p.starts_with('-') || p.contains('%'));
	ok.then_some(arg)
}

// Zed's binary is `zed`, or `zeditor` in some distro packages. Its installer
// puts it in ~/.local/bin, which a desktop session's PATH can leave out.
pub fn find_zed(path: Option<&OsStr>, home: Option<&Path>) -> Option<PathBuf> {
	let mut dirs: Vec<PathBuf> = path.map(|p| std::env::split_paths(p).collect()).unwrap_or_default();
	if let Some(home) = home {
		dirs.push(home.join(".local/bin"));
	}
	["zed", "zeditor"]
		.iter()
		.find_map(|name| dirs.iter().map(|d| d.join(name)).find(|p| is_executable(p)))
}

fn is_executable(p: &Path) -> bool {
	use std::os::unix::fs::PermissionsExt;
	p.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

// Where a page in the dev browser may go: it is a browser, so any web origin
// stays in it, but never the shell's own pages. Editor links are the deck
// server's to launch, not any page's.
pub fn classify_browser(url: &Url) -> Nav {
	match url.scheme() {
		"http" | "https" | "about" | "blob" | "data" => Nav::Inside,
		"mailto" => Nav::External,
		_ => Nav::Block,
	}
}

// A host the tunnel carries: loopback, which in the dev browser means the deck
// machine (or a remote session's host). Every other host is reached directly.
// Any other name is resolved first, and goes through the tunnel too when it
// resolves to a local address (is_local_ip), so no alias reaches this machine.
pub fn is_tunnel_target(host: &str) -> bool {
	let host = host.trim_start_matches('[').trim_end_matches(']').trim_end_matches('.').to_ascii_lowercase();
	host == "localhost" || host.ends_with(".localhost") || host.parse::<std::net::IpAddr>().is_ok_and(is_local_ip)
}

// Loopback or unspecified (0.0.0.0, which dev servers print as an address),
// IPv4-mapped forms included.
pub fn is_local_ip(ip: std::net::IpAddr) -> bool {
	let ip = match ip {
		std::net::IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(ip, std::net::IpAddr::V4),
		v4 => v4,
	};
	ip.is_loopback() || ip.is_unspecified()
}

// Address-bar text as a URL to load: http for loopback (dev servers rarely do
// https), https otherwise. Loopback stays as typed: WebKitGTK proxies it, unlike
// WKWebView, so the Apple apps' deck.localhost stand-in isn't needed here.
// The page's origin stays what a dev server's CORS settings expect.
pub fn resolve_address(text: &str) -> Option<Url> {
	let text = text.trim();
	if text.is_empty() {
		return None;
	}
	let has_scheme = text.split_once("://").is_some_and(|(s, _)| s.starts_with(|c: char| c.is_ascii_alphabetic()) && s.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c)));
	let with_scheme = if has_scheme || text.starts_with("about:") {
		text.to_string()
	} else if text.chars().all(|c| c.is_ascii_digit()) {
		// A bare port, as a developer types it.
		format!("http://localhost:{text}")
	} else {
		// Parsed first, so the host is checked as normalised (127.1 is 127.0.0.1).
		match Url::parse(&format!("http://{text}")) {
			Ok(url) if url.host_str().is_some_and(is_tunnel_target) => return Some(url),
			_ => format!("https://{text}"),
		}
	};
	let url = Url::parse(&with_scheme).ok()?;
	matches!(url.scheme(), "http" | "https" | "about").then_some(url)
}

// The WebSocket upgrade for one proxied connection: the token goes in a header,
// never here.
pub fn tunnel_url(server: &Url, port: u16, session: Option<&str>) -> Url {
	let mut url = server.join("/api/tunnel").expect("an origin takes a path");
	let _ = url.set_scheme(if server.scheme() == "https" { "wss" } else { "ws" });
	url.query_pairs_mut().append_pair("port", &port.to_string());
	if let Some(session) = session {
		url.query_pairs_mut().append_pair("session", session);
	}
	url
}

// A dev server as /api/agent/sessions/{id}/servers lists it.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevServer {
	pub state: String,
	#[serde(default)]
	pub ports: Vec<DevPort>,
	pub preview_url: Option<String>,
}

#[derive(serde::Deserialize)]
pub struct DevPort {
	pub port: u16,
	pub label: Option<String>,
	#[serde(default)]
	pub primary: bool,
	#[serde(default)]
	pub listening: bool,
}

#[derive(serde::Serialize, Debug, PartialEq)]
pub struct ServerTab {
	pub port: u16,
	pub title: String,
	pub url: String,
	pub listening: bool,
}

// The states that get tabs, as BrowserTabs.swift and the web app's preview link.
pub fn is_previewable(state: &str) -> bool {
	matches!(state, "running" | "stalled")
}

// One tab per declared port of a running server, primary first. The primary
// port opens the URL the server printed, when it printed one.
pub fn server_tabs(servers: &[DevServer]) -> Vec<ServerTab> {
	let mut tabs: Vec<ServerTab> = Vec::new();
	for server in servers.iter().filter(|s| is_previewable(&s.state)) {
		let mut ports: Vec<&DevPort> = server.ports.iter().collect();
		ports.sort_by_key(|p| !p.primary);
		let primary = ports.first().map(|p| p.port);
		for p in ports {
			if tabs.iter().any(|t| t.port == p.port) {
				continue;
			}
			let preview = server.preview_url.as_deref().filter(|u| !u.is_empty() && Some(p.port) == primary);
			tabs.push(ServerTab {
				port: p.port,
				title: p.label.clone().unwrap_or_else(|| format!(":{}", p.port)),
				url: preview.map_or_else(|| format!("http://localhost:{}", p.port), str::to_string),
				listening: p.listening,
			});
		}
	}
	tabs
}

// An accelerator as the settings page takes it (`Ctrl+Alt+D`) in the XDG
// shortcuts format the Wayland portal wants (`CTRL+ALT+d`).
pub fn xdg_trigger(accelerator: &str) -> Option<String> {
	let parts: Vec<&str> = accelerator.split('+').map(str::trim).collect();
	let (key, mods) = parts.split_last()?;
	if key.is_empty() {
		return None;
	}
	let mut out = Vec::new();
	for m in mods {
		out.push(match m.to_ascii_lowercase().as_str() {
			"ctrl" | "control" => "CTRL",
			"alt" => "ALT",
			"shift" => "SHIFT",
			"super" | "meta" | "cmd" => "LOGO",
			_ => return None,
		});
	}
	let key = if key.chars().count() == 1 { key.to_lowercase() } else { key.to_string() };
	Some(format!("{}+{key}", out.join("+")).trim_start_matches('+').to_string())
}

#[cfg(test)]
mod tests {
	use super::*;

	fn url(s: &str) -> Url {
		Url::parse(s).unwrap()
	}

	#[test]
	fn deck_links_open_their_session() {
		assert_eq!(deck_link_path(&url("deck://s/abc-123")).as_deref(), Some("/s/abc-123"));
		assert_eq!(deck_link_path(&url("deck://inbox")).as_deref(), Some("/inbox"));
		assert_eq!(deck_link_path(&url("deck://s/x?y=1")).as_deref(), Some("/s/x?y=1"));
		assert_eq!(deck_link_path(&url("https://example.com/s/x")), None);
	}

	#[test]
	fn app_paths_stay_on_the_server() {
		assert!(is_app_path("/s/x"));
		assert!(!is_app_path("//evil.example/x"));
		assert!(!is_app_path("/\\evil.example"));
		assert!(!is_app_path("https://evil.example"));
	}

	#[test]
	fn server_input_becomes_an_origin() {
		assert_eq!(parse_server("deck.example:4818").unwrap().as_str(), "http://deck.example:4818/");
		assert_eq!(parse_server(" https://deck.example/s/x ").unwrap().as_str(), "https://deck.example/");
		assert!(parse_server("file:///etc/passwd").is_none());
		assert!(parse_server("").is_none());
	}

	#[test]
	fn navigation_leaves_the_shell_for_other_origins() {
		let server = url("http://deck.example:4818/");
		assert_eq!(classify(&url("http://deck.example:4818/s/x"), Some(&server)), Nav::Inside);
		assert_eq!(classify(&url("tauri://localhost/index.html"), Some(&server)), Nav::Inside);
		assert_eq!(classify(&url("https://github.com/acme/app/pull/1"), Some(&server)), Nav::External);
		assert_eq!(classify(&url("http://deck.example:3000/"), Some(&server)), Nav::External);
		assert_eq!(classify(&url("vscode://vscode-remote/ssh-remote+u@h/p"), Some(&server)), Nav::External);
		assert_eq!(classify(&url("https://deck.example:4818/"), None), Nav::External);
		assert_eq!(classify(&url("file:///etc/passwd"), Some(&server)), Nav::Block);
	}

	#[test]
	fn only_the_composed_zed_command_runs() {
		assert_eq!(zed_arg("zed ssh://me@box:2222/code/app"), Some("ssh://me@box:2222/code/app"));
		assert_eq!(zed_arg("zed ssh://me@box/a%20b"), Some("ssh://me@box/a%20b"));
		assert_eq!(zed_arg("zed ssh://-oProxyCommand=x@box/p"), None);
		assert_eq!(zed_arg("zed ssh://%2DoProxyCommand=x@box/p"), None);
		assert_eq!(zed_arg("zed ssh://me@-oProxyCommand/p"), None);
		assert_eq!(zed_arg("zed ssh://me@box/p --wait"), None);
		assert_eq!(zed_arg("zed /etc"), None);
		assert_eq!(zed_arg("rm ssh://me@box/p"), None);
	}

	#[test]
	fn finds_zed_in_local_bin() {
		let home = std::env::temp_dir().join(format!("deck-shell-test-{}", std::process::id()));
		let bin = home.join(".local/bin");
		std::fs::create_dir_all(&bin).unwrap();
		assert_eq!(find_zed(Some(OsStr::new("/nonexistent")), Some(&home)), None);
		std::fs::create_dir(bin.join("zed")).unwrap();
		let zed = bin.join("zeditor");
		std::fs::write(&zed, "").unwrap();
		assert_eq!(find_zed(None, Some(&home)), None, "a directory or a file without +x is not Zed");
		#[cfg(unix)]
		{
			use std::os::unix::fs::PermissionsExt;
			std::fs::set_permissions(&zed, std::fs::Permissions::from_mode(0o755)).unwrap();
		}
		assert_eq!(find_zed(None, Some(&home)), Some(zed));
		std::fs::remove_dir_all(home).unwrap();
	}

	#[test]
	fn the_dev_browser_keeps_web_pages_but_not_shell_pages() {
		assert_eq!(classify_browser(&url("https://cdn.example/x.js")), Nav::Inside);
		assert_eq!(classify_browser(&url("http://deck.localhost:5173/")), Nav::Inside);
		assert_eq!(classify_browser(&url("mailto:me@example.com")), Nav::External);
		assert_eq!(classify_browser(&url("vscode://file/etc/passwd")), Nav::Block);
		assert_eq!(classify_browser(&url("tauri://localhost/browser.html")), Nav::Block);
		assert_eq!(classify_browser(&url("file:///etc/passwd")), Nav::Block);
		assert_eq!(classify_browser(&url("deck://s/x")), Nav::Block);
	}

	#[test]
	fn only_loopback_goes_through_the_tunnel() {
		for host in ["localhost", "LOCALHOST", "localhost.", "deck.localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]", "0.0.0.0", "::", "::ffff:127.0.0.1"] {
			assert!(is_tunnel_target(host), "{host}");
		}
		for host in ["example.com", "10.0.0.5", "localhost.example.com", "fonts.googleapis.com", "::ffff:8.8.8.8"] {
			assert!(!is_tunnel_target(host), "{host}");
		}
	}

	#[test]
	fn addresses_default_to_http_for_loopback() {
		let resolved = |s: &str| resolve_address(s).map(|u| u.to_string());
		assert_eq!(resolved("localhost:5173").as_deref(), Some("http://localhost:5173/"));
		assert_eq!(resolved(" 127.0.0.1:3000/api?x=1 ").as_deref(), Some("http://127.0.0.1:3000/api?x=1"));
		assert_eq!(resolved("[::1]:8080").as_deref(), Some("http://[::1]:8080/"));
		assert_eq!(resolved("tenant.localhost:3000").as_deref(), Some("http://tenant.localhost:3000/"));
		assert_eq!(resolved("5173").as_deref(), Some("http://localhost:5173/"));
		assert_eq!(resolved("127.1:3000").as_deref(), Some("http://127.0.0.1:3000/"));
		assert_eq!(resolved("localhost:3000/x?u=http://y").as_deref(), Some("http://localhost:3000/x?u=http://y"));
		assert_eq!(resolved("http://localhost:5173/a").as_deref(), Some("http://localhost:5173/a"));
		assert_eq!(resolved("example.com/docs").as_deref(), Some("https://example.com/docs"));
		assert_eq!(resolved("about:blank").as_deref(), Some("about:blank"));
		assert_eq!(resolved("file:///etc/passwd"), None);
		assert_eq!(resolved("tauri://localhost/"), None);
		assert_eq!(resolved("  "), None);
	}

	#[test]
	fn tunnel_urls_carry_port_and_session_only() {
		let server = url("https://deck.example.ts.net/");
		assert_eq!(tunnel_url(&server, 5173, None).as_str(), "wss://deck.example.ts.net/api/tunnel?port=5173");
		assert_eq!(tunnel_url(&url("http://10.0.0.2:4818/"), 3000, Some("abc-1")).as_str(), "ws://10.0.0.2:4818/api/tunnel?port=3000&session=abc-1");
	}

	#[test]
	fn running_servers_get_a_tab_per_port() {
		let servers: Vec<DevServer> = serde_json::from_str(
			r#"[
				{"name":"api","state":"running","ports":[{"port":3000,"listening":true},{"port":5173,"label":"web","primary":true,"listening":true}],"previewUrl":"http://localhost:5173/app"},
				{"name":"docs","state":"stopped","ports":[{"port":4000,"listening":false}]},
				{"name":"dup","state":"stalled","ports":[{"port":3000,"listening":false},{"port":9000,"listening":false}]}
			]"#,
		)
		.unwrap();
		let tab = |port, title: &str, url: &str, listening| ServerTab { port, title: title.into(), url: url.into(), listening };
		assert_eq!(
			server_tabs(&servers),
			vec![
				tab(5173, "web", "http://localhost:5173/app", true),
				tab(3000, ":3000", "http://localhost:3000", true),
				tab(9000, ":9000", "http://localhost:9000", false),
			]
		);
	}

	#[test]
	fn accelerators_convert_to_xdg_triggers() {
		assert_eq!(xdg_trigger("Ctrl+Alt+D").as_deref(), Some("CTRL+ALT+d"));
		assert_eq!(xdg_trigger("Super+Space").as_deref(), Some("LOGO+Space"));
		assert_eq!(xdg_trigger("F12").as_deref(), Some("F12"));
		assert_eq!(xdg_trigger("Hyper+D"), None);
		assert_eq!(xdg_trigger("Ctrl+"), None);
	}
}
