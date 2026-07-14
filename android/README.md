# deck Android thin client

A minimal sideloadable Android app that wraps the deck web UI in a WebView.
For devices that can't install the PWA (e.g. e-ink phones): install the APK,
enter your deck server URL once, and it behaves like the installed app.

No Gradle, no dependencies: one activity, built directly with the Android SDK
command-line tools (`aapt2`, `javac`, `d8`, `apksigner`).

## Build

Requires an Android SDK (build-tools + a platform) and a JDK. `ANDROID_HOME`
defaults to `~/Library/Android/sdk`.

```sh
./build.sh            # produces build/deck.apk
./build.sh --install  # also installs via adb onto a connected device
```

The APK is signed with a personal key generated on first build at
`~/.deck/android.keystore`. Keep that file; upgrades install over the top only
when signed with the same key (otherwise uninstall first).

## Install and set up

1. Copy `build/deck.apk` to the phone (or use `--install` with USB debugging)
   and open it to install. Allow installs from unknown sources if prompted.
2. On first launch, enter the deck server URL, e.g. `http://your-mac:4818`
   (a tailnet hostname works well).
3. Back navigates the app; pressing back at the root opens a small menu with
   Reload, Change server, and Exit.

## Notes

- Cleartext http is allowed since deck usually runs without TLS on a
  LAN/tailnet.
- Links that leave the deck origin open in the phone's browser.
- Web push notifications don't work in a WebView; this client has no
  notification support.
- The service worker doesn't register over plain http, so there is no offline
  shell and also no stale-cache problem: every launch loads the live server.
- E-ink friendliness: plain light theme and no overscroll glow. Pair it with
  deck's light theme.
