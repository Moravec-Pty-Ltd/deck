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
	fn accelerators_convert_to_xdg_triggers() {
		assert_eq!(xdg_trigger("Ctrl+Alt+D").as_deref(), Some("CTRL+ALT+d"));
		assert_eq!(xdg_trigger("Super+Space").as_deref(), Some("LOGO+Space"));
		assert_eq!(xdg_trigger("F12").as_deref(), Some("F12"));
		assert_eq!(xdg_trigger("Hyper+D"), None);
		assert_eq!(xdg_trigger("Ctrl+"), None);
	}
}
