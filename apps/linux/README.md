# deck for Linux

A thin Tauri v2 shell around the deck web app. It opens your deck server in a
window and adds what a browser tab can't: a tray icon with the count of what
needs you, native notifications, Open in Zed, `deck://` links, one window per
app, and a global show/hide shortcut. The UI is the web app the server serves,
so a server update needs no new shell.

## Install

Download the AppImage or the deb from the
[releases](https://github.com/Moravec-Pty-Ltd/deck/releases). The AppImage
updates itself from there; the deb updates through your package manager when
you install a newer one.

On first launch, enter the server address (the one you open deck at in a
browser, for example `https://deck.example.ts.net`), then sign in as usual.
Settings (server, shortcut, start at login) are in the tray menu.

`deck --toggle` shows or hides the window. On GNOME without the global
shortcuts portal, bind that command to a key in the keyboard settings.

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
  command check), unit-tested.
- `src/linux.rs`: WebKitGTK settings, notifications, and the XDG portals.
- `ui/index.html`: the settings page.
- `src/lib/shell.ts` in the web app: the bridge, a no-op in a normal browser.

The deck page gets shell commands through a capability granted at run time to
the configured server's origin only. That includes reading an image off the
clipboard on paste and, over https or localhost, the microphone, so use an
https address (tailnet or `tailscale serve`) unless the network path is yours.
Pages on other origins open in the default browser. A deck page opened in a new tab (a file, say) gets a window of its own.

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
