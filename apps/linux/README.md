# deck for Linux

A thin Tauri v2 shell around the deck web app. It opens your deck server in a
window and adds what a browser tab can't: a tray icon with the count of what
needs you, native notifications, Open in Zed, `deck://` links, one window per
app, a global show/hide shortcut, and a dev browser. The UI is the web app the server serves,
so a server update needs no new shell.

## Install

Download the AppImage, the deb, or `deck-linux-x86_64.tar.gz` from the
[releases](https://github.com/Moravec-Pty-Ltd/deck/releases). The AppImage
updates itself from there; the deb updates through your package manager when
you install a newer one.

The AppImage carries Ubuntu 22.04's WebKitGTK. On a rolling distro (Arch, say)
the tarball is the better choice: it is the bare binary, so it runs on your
distro's WebKitGTK, which gets fixes far sooner. It needs the runtime packages
(Arch: `webkit2gtk-4.1 libayatana-appindicator`; Debian and Ubuntu:
`libwebkit2gtk-4.1-0 libayatana-appindicator3-1`). Voice mode also needs the
GStreamer plugins (Arch: `gst-plugins-good gst-plugin-pipewire`; Debian and
Ubuntu: `gstreamer1.0-plugins-good gstreamer1.0-pipewire`). It does not update itself:
download the next release and install it the same way.

```sh
tar -xzf deck-linux-x86_64.tar.gz
install -Dm755 deck/deck ~/.local/bin/deck
install -Dm644 deck/deck.desktop ~/.local/share/applications/deck.desktop
install -Dm644 deck/deck.png ~/.local/share/icons/hicolor/128x128/apps/deck.png
update-desktop-database ~/.local/share/applications   # for deck:// links
ldd ~/.local/bin/deck | grep webkit                    # the system's libwebkit2gtk-4.1.so.0
```

The launcher runs `deck`, so `~/.local/bin` must be on your session's `PATH`.

On first launch, enter the server address (the one you open deck at in a
browser, for example `https://deck.example.ts.net`), then sign in as usual.
Settings (server, shortcut, start at login) are in the tray menu.

The dev browser opens from a session's header (Dev browser), a running
server's localhost URL on its Servers tab, or the tray. It
has a tab for each running dev server of the session (from the tray, of every
session; deck lists none for a remote session, so type its address), and
`localhost` in it means the deck machine, or a remote session's host: it loads through deck's tunnel, signed in with the shell's own deck
sign-in, so there is nothing to set up.

`deck --toggle` shows or hides the window. On GNOME without the global
shortcuts portal, bind that command to a key in the keyboard settings.

## Crashes

The settings page shows the shell's version and the WebKitGTK it runs on, and
the shell prints both at start (`deck: deck shell <version>, WebKitGTK <version>`).
Put that line in a crash report.

When WebKit's web process crashes, the shell reloads the page and says so. A
page that crashes again within a minute is left alone, and the shell says that
instead. A crash of the shell's own process can't be caught: start deck again.

Under Wayland the shell sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` before GTK
starts, the usual fix for WebKitGTK crashes and blank windows with newer GPU
drivers. It leaves the variable alone if you set it yourself. To turn the
renderer back on, start deck with `DECK_WEBKIT_DMABUF=1`; for the launcher and
autostart too, put `DECK_WEBKIT_DMABUF=1` in `~/.config/environment.d/deck.conf`
and log in again. To tell whether
turning it off helps, run a few days each way and compare: crashes show in
`journalctl --user -b | grep -i -e deck -e WebKitWebProcess` and in
`coredumpctl list`. If the renderer makes no difference, it is the faster
choice, so turn it back on.

## Build

Needs Rust and the WebKitGTK headers (Debian and Ubuntu:
`libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev`).

```sh
cargo test
cargo run                                      # a debug shell
npx @tauri-apps/cli@2 build --bundles appimage deb
```

A release build signs the AppImage for the updater and needs
`TAURI_SIGNING_PRIVATE_KEY` (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`); without
them, add `--config '{"bundle":{"createUpdaterArtifacts":false}}'`. The
public key is in `tauri.conf.json`.

To release, push a `linux-v<version>` tag after bumping `version` in
`tauri.conf.json`. The `Linux shell` workflow builds both bundles and publishes
the release with the `latest.json` the updater reads. It needs the
`TAURI_SIGNING_PRIVATE_KEY` repository secret. The updater reads the newest
release in the repo, so other release lines must not take that spot.

## How it fits together

- `src/main.rs`: the window, tray, commands, and plugins.
- `src/core.rs`: the decisions (deck links, where a navigation goes, the Zed
  command check, the dev browser's addresses and tabs), unit-tested.
- `src/browser.rs` and `ui/browser.html`: the dev browser window, its toolbar
  and a webview per tab.
- `src/tunnel.rs`: the dev browser's proxy (below).
- `src/linux.rs`: WebKitGTK settings, notifications, and the XDG portals.
- `ui/index.html`: the settings page. `ui/icons`: Lucide icons for the toolbar.
- `src/lib/shell.ts` in the web app: the bridge, a no-op in a normal browser.

The deck page gets shell commands through a capability granted at run time to
the configured server's origin only. That includes reading an image off the
clipboard on paste and, over https or localhost, the microphone, so use an
https address (tailnet or `tailscale serve`) unless the network path is yours.
Pages on other origins open in the default browser. A deck page opened in a new tab (a file, say) gets a window of its own.

The dev browser's webviews use a SOCKS5 proxy the shell runs on loopback, with
a random password only they are given. A loopback host goes over one WebSocket
to the server's `/api/tunnel` per connection, with the window's deck credential (read from
the main window's sign-in cookie) in a header; every other host, a CDN say, is
connected to directly. Unlike WKWebView on Apple, WebKitGTK proxies a literal
`localhost`, so pages keep the origin a dev server's CORS settings expect. The
browser keeps its own cookies and storage, apart from deck's.

## WebKitGTK compared with Chromium

- No Web Push or service worker, so the shell raises notifications itself from
  the inbox the web app already follows. It keeps that feed open while the
  window is hidden.
- `getUserMedia` is off by default; the shell turns it on and grants the
  microphone to the deck origin only. Voice mode needs the GStreamer
  PulseAudio or PipeWire plugin, which the deb depends on.
- A pasted image arrives as an empty clipboard, and a dropped file as a URI with
  no file. The shell reads the image from the clipboard, and the dropped files
  from the drop GTK delivered (never a path the page names), and passes them on.
- A download goes nowhere unless the shell picks a place, so it asks where to
  save.
- No reload key: Ctrl+R and F5 come from the shell. Ctrl+= and Ctrl+- zoom.
- The tray can't tell a click from a menu open on most desktops (it is an
  AppIndicator), so Show deck is the first menu item.
