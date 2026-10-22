# deck for iOS + Apple Watch

Native SwiftUI clients for [deck](../../README.md): drive
coding-agent sessions from your phone, and start work or review jobs straight
from issues and PRs on your wrist, including over LTE with the phone at home.
Siri drives the same actions through App Intents.

## Layout

- `Packages/DeckKit` - shared package
  - `DeckKit`: agent API models + client (contract: deck's `GET /llms.txt`,
    v2.0.0), Keychain credential store, QR sign-in parser, observable
    `DeckStore` with a resumable event-log long-poll loop. It calls only
    `/api/agent/*` routes (plus push registration), and reads the server's
    capability tokens from `GET /api/agent`: a feature the server doesn't
    advertise is hidden, with a banner saying deck needs updating
  - `DeckUI`: the app's shared leaf views (session rows, tool call and ask
    cards, PR and diff views, file attachment rows), `DeckStyle` radius tokens
    and `deckGlass()`. Builds for iOS and macOS; only the app links it, not the
    watch app or the extensions
  - `DeckIntents`: Siri App Intents (entities: sessions, projects, open issues,
    open PRs; intents: start work, start review, start a session from a spoken
    instruction, answer, attention check, send prompt, status, stop)
  - the operator's on-device brain (`OperatorBrain`, `OperatorTools`): Apple's
    model driving deck's agent API
  - `DeckBrowser`: the dev browser (tabs, loopback addresses, the SSH tunnel and
    its SOCKS5 listener). A separate product so SwiftNIO stays out of `DeckKit`,
    which the watch app and the extensions link
  - `DeckLocalModel`: the operator's downloaded models (the shortlist, the
    download, and the MLX bridge to FoundationModels). Separate for the same
    reason: only the app runs a model, and MLX is a large dependency
- `Apps/DeckApp` - iOS app (iOS 26+): sessions, inbox of blocking questions,
  start-from-issue/PR, schedules, QR onboarding, APNs registration
- `Apps/DeckWatch` - independent-capable watch app (watchOS 11+): inbox with
  one-tap answers, quick-start from issues/PRs, session status, its own APNs
  registration so pushes arrive directly over LTE
- `project.yml` - [XcodeGen](https://github.com/yonaskolb/XcodeGen) spec; the
  `.xcodeproj` is generated, not committed. Signing team comes from `.env`
  (gitignored, see `.env.example`)

## Build

Run these from `apps/ios`.

```sh
brew install xcodegen        # once
cp .env.example .env         # once; set DEVELOPMENT_TEAM to your Apple team ID
./generate.sh                # sources .env, runs xcodegen
open Deck.xcodeproj          # run DeckApp
```

CI-style check without signing:

```sh
xcodebuild -project Deck.xcodeproj -scheme DeckApp \
  -destination 'generic/platform=iOS Simulator' \
  -skipMacroValidation CODE_SIGNING_ALLOWED=NO build
cd Packages/DeckKit && swift test
```

`-skipMacroValidation` is not optional: `mlx-swift-lm` builds its model loader
with a Swift macro, and outside the IDE there is no trust prompt to answer, so
the build stops at "Macro must be enabled before it can be used".

### UI tests

The UI tests drive the real app against a deck. One command runs them against
a throwaway one:

```sh
./uitest.sh                                   # iPhone 17 Pro, then iPad Pro 11-inch (M5)
./uitest.sh "iPhone Duo"                      # the foldable layouts
./uitest.sh <simulator-id> -- -only-testing:DeckAppUITests/SearchUITests
```

A device is a simulator name or an id from `xcrun simctl list devices
available`; a name picks one that is not already running. For each device the
script:

- seeds a temp `DECK_DATA` with `uitest/seed.mjs`: the project `files-proj` (a
  temp git repo holding the images and `report.csv` a message mentions), and
  sessions with transcripts ("long transcript", "file previews", "voice
  smoke", "ask smoke", a session that ran tools) beside a `dev server` shell on
  a private tmux socket
- starts deck with `--host 127.0.0.1` on port 4851 (`DECK_UITEST_PORT` moves
  it), its `HOME` in the temp dir, no inherited `DECK_*` variables, and the fake
  `claude` and tmux wrapper from `e2e/` first on `PATH`, so a prompt gets a
  canned reply and no model is called. `uitest/fake-speech.mjs` stands in for
  the speech server
- signs the app out (uninstall and keychain reset), runs `xcodebuild test`
  with `TEST_RUNNER_DECK_UITEST_URL` and `TEST_RUNNER_DECK_UITEST_TOKEN`
  exported, and pushes each question the deck asks to the simulator with
  `xcrun simctl push` (`uitest/push-asks.mjs`), standing in for APNs

On exit it stops the servers, kills the tmux socket, shuts down the
simulators it booted, and deletes the temp dirs and the build in
`/tmp/dd-uitest-*`. Set `DECK_UITEST_DERIVED_DATA=<dir>` to keep the build
between runs.

A test that applies to one kind of device skips elsewhere: `PadLayoutUITests`
on anything but an iPad, the opened-flat `FoldableUITests` off the iPhone Duo
simulator (the tabletop one forces its layout with `DECK_HINGE=tabletop` on
any iPhone), `SessionsCompactUITests` wherever the list sits beside the
session, and `OperatorUITests` where the on-device model is unavailable.

To point the tests at another deck, export the two variables in the shell (as
trailing `KEY=value` arguments they become build settings and every test
skips) and start that deck with `--host`: vite with no `--host` binds `[::1]`
only, so the simulator cannot reach `127.0.0.1:<port>`, and the app renders as
if signed in with no data rather than saying it cannot connect.

## TestFlight

`./ship.sh [ios|mac|all]` ships from this Mac (default `ios`):

- `ios` runs `fastlane ios beta`: archives DeckApp with the embedded watch app
  and uploads the ipa.
- `mac` runs `fastlane mac beta`: archives DeckMac, exports an App Store pkg and
  uploads it as a macOS build.
- `all` runs both, iOS first.

Each lane regenerates the project with XcodeGen and numbers the build one past
the larger of the latest iOS and latest macOS TestFlight builds. The Mac app
shares the bundle id `tech.moravec.deck` with the iOS app, so both platforms
live on one App Store Connect record, and a build number either platform has
used is refused on the other.

Use the Homebrew fastlane (`brew install fastlane`); the lanes sign with an App
Store Connect API key, so no Xcode account is needed. `.env` (see
`.env.example`) supplies the key id, issuer id, key path and
`DEVELOPMENT_TEAM`. The key needs the Admin role, since cloud signing refuses an
App Manager key. Release builds sign with the production push entitlement
(`Apps/*/*.release.entitlements`) so TestFlight tokens are real; Debug stays on
the sandbox.

One-time setup:

1. `./ship.sh bootstrap` (`fastlane ios bootstrap`) creates the App Store
   Connect app for `tech.moravec.deck` with iOS and macOS, or adds macOS to an
   existing record by creating its first macOS version. If App Store Connect
   refuses that, the lane says so: add it by hand under Apps > deck > Add
   Platform > macOS.
2. On developer.apple.com, under Certificates, Identifiers & Profiles >
   Identifiers > `tech.moravec.deck`, check the App ID is not limited to iOS
   (an explicit App ID registered today covers every platform; an older one
   shows only iOS, and the Mac archive then fails to find a profile) and that
   Push Notifications is still ticked. Fix it there; the API cannot change an
   App ID's platform.
3. The Mac pkg is signed with a Mac Installer Distribution certificate. If the
   `mac` lane's export stops for want of one, create it under Certificates
   (Mac Installer Distribution) and install it in the login keychain.

The watch app id `tech.moravec.deck.watchkitapp` and the Mac App Store
provisioning profile are created on the first archive.

## Server prerequisites

1. deck running with the APNs feature (deck PR #162) and reachable over HTTPS.
   The production setup is a Cloudflare tunnel: `deck.<your-domain>` ->
   `localhost:4818`, with deck's shared-token auth staying ON.
2. An APNs auth key so deck can send pushes:
   - developer.apple.com -> Certificates, Identifiers & Profiles -> Keys ->
     new key with the Apple Push Notifications service enabled
   - save the `.p8` file as `~/.deck/apns-key.p8` on the deck machine
   - write `~/.deck/apns.json`: `{ "keyId": "<key id>", "teamId": "<your team id>" }`
     (topic defaults to tech.moravec.deck)
   - restart deck
3. Debug builds register against the APNs sandbox; TestFlight/production builds
   use production APNs. deck sends to both per registered device.

## Voice mode

The waveform button in a session's composer reads each new reply aloud and
lets you talk back: just speak, or with hands-free off hold the mic button
(release sends, drag off cancels). Skip moves to the next reply, Stop halts
reading and interrupts the turn. Blocking questions are read with numbered
options; say an option, its number, or a free-text reply. The bar's settings
pick how much is read (every update or the final reply only) and switch
hands-free mode, on by default (an open mic with an energy detector;
sensitivity adjustable), which can interrupt a reply mid-sentence. Reading
continues behind the lock screen for the session you turned it on for; the
watch reads while its Voice screen is open.

It needs deck configured with a speech server (**Settings > Voice** on the
web, or **Settings > deck server settings** here); the button only appears when `GET /api/agent/speech` reports one. The phone
never talks to the speech server directly.

## Operator

The Operator tab is voice control of all of deck: say what you want and a model
works out which of deck's functions to call (what is going on, a reply read or
summarised, an instruction sent, a waiting question answered, a turn stopped, a
session started with a skill; it asks before starting one).

**The thinking happens on the phone.** Apple's on-device model (FoundationModels,
iOS 26+) holds the conversation and calls deck's agent API through eight tools,
so nothing runs on the deck machine, there is no endpoint to configure, and what
you say never leaves the device. It replaced a model that ran beside deck and
held 3.6 GB of its memory. The conversation is per-device now, where the old one
was a single log shared by every device: that is the trade for having no model
to run.

Turn it on and the phone listens for "hey deck" with Apple's on-device speech
recognition, fed from the same microphone tap the recorder uses
(`VoiceController.onAudioBuffer`); the wake word opens the gate (`listenGate`)
and the take is captured, transcribed by deck's speech server, and answered.
After each reply an 8 s follow-up window keeps the gate open. Hold the mic to
talk at any time, or type. While on, the app reads the event log it already
follows and speaks up on its own: a new question with numbered options, a
finished turn summarised. A session's own voice mode pauses the operator and it
resumes when you leave the session.

**The whole context is 4,096 tokens**, which shapes everything here. A
session's latest reply is routinely longer than that on its own, so every tool
result is bounded (2,000 characters, 25 sessions a list) and the conversation
is trimmed and retried when it fills anyway. Unbounded, a few follow-ups end in
"Provided 4,099 tokens, but the maximum allowed is 4,096" with nothing said.

For the same reason, skills are found through a tool rather than listed in the
prompt: this machine has 142 of them, and naming them up front cost 12.4
seconds a turn against 1.4 without, because the model re-reads its instructions
every turn with no prompt cache to hide the cost. Keep anything that can be a
tool call a tool call, and keep what comes back small.

Needs Apple Intelligence on and iOS 26 or later; the tab says so when it is
missing. It still needs deck configured with a speech server for the voice part
(**Settings > Voice** on the web, or **Settings > deck server settings** here).

The watch is the exception: watchOS ships the model framework but marks the
model itself unavailable, so the watch Operator page still asks deck to think
for it and needs deck's watch operator settings (**Settings > Watch operator**
on the web). No wake word there
either, since watchOS has no on-device recogniser for one.

## Operator model

Apple's on-device model is the default, and its context is 4,096 tokens for the
instructions, eight tool schemas, the conversation and the tool result put
together. That is the ceiling behind most of the rules above, and it is why a
session's reply arrives as its opening 2,000 characters. It also refuses
instructions about its own output, so "reply with exactly X" comes back as "I
cannot fulfill that request" where a server model would simply comply.

**Settings > Operator > Model** swaps it for a model downloaded from Hugging
Face. Four are suggested, smallest first, and any MLX-format repo can be typed
in instead:

| | weights | |
|---|---|---|
| `mlx-community/Qwen3-1.7B-4bit` | 970 MB | the lightest worth asking to call a tool |
| `mlx-community/Qwen3.5-2B-4bit` | 1.7 GB | suggested |
| `mlx-community/Llama-3.2-3B-Instruct-4bit` | 1.8 GB | a second opinion in another family |
| `mlx-community/Qwen3-4B-4bit` | 2.3 GB | the most capable of the four |

Qwen3.5 2B is suggested because the deck machine's own operator runs Qwen3.5
nine sizes up, so its one quirk is already known: thinking has to stay on for a
tool turn, or the model narrates what it would do instead of doing it. That is
why `.reasoning` is declared alongside `.toolCalling` when the model is built.

Nothing is downloaded until asked, and the weights stay on the device
afterwards. **Free the memory** drops the loaded copy and keeps the file;
**Delete the weights** removes it. Until a chosen model is downloaded the
operator keeps using Apple's.

### How it fits

[`mlx-swift-lm`](https://github.com/ml-explore/mlx-swift-lm)'s
`MLXFoundationModels` bridges an MLX model to Apple's own
`FoundationModels.LanguageModel`, so a downloaded model plugs into
`LanguageModelSession` and **deck's seven operator tools are unchanged**; only
which model answers differs. That bridge is why this is a model-management
feature rather than a second operator.

Two consequences worth knowing:

- **iOS 27 or later.** Supplying your own `LanguageModel` is new in 27; below
  it the screen says so and Apple's model stays. The watch is unaffected and
  still asks deck to think for it.
- **Tool results are bounded to the model.** `OperatorLimits` carries the
  allowance: 2,000 characters and 25 sessions on Apple's model, 12,000 and 80
  on a downloaded one. Getting a session's whole reply instead of its opening
  is the difference you actually notice.

MLX only links into the app, through the `DeckLocalModel` product, for the same
reason SwiftNIO only links into `DeckBrowser`: the watch app, the widgets and
the share extension all link `DeckKit` and none of them runs a model.

Both of the macros `mlx-swift-lm` uses need `-skipMacroValidation` on the
command line, which `ship.sh` passes through fastlane.
The app also carries `increased-memory-limit` and
`extended-virtual-addressing`, without which iOS kills it well before 1.7 GB of
weights are resident.

## Schedules

A prompt that runs on a clock, for the recurring jobs that want an agent rather
than a cron entry. Reached from the clock in the **Start** tab, or from a
session's menu with *Repeat on a schedule*, which opens the form already pointed
at that session.

The form asks one question first, because the rest depends on it. **Starts a new
session** spawns a fresh one per run in a project directory, with its own agent
pick, so every run looks at the project as it stands. **Sends to one session**
sends the prompt into a session that already exists, so what it worked out last
run is still loaded.

deck owns the clock. The app offers the same presets the web form does and lets
you type a five-field cron expression, but it does not parse one: it asks deck
what an expression would do (`GET /api/agent/schedules/preview`) and shows the
next three runs. One cron engine, on the server, rather than a second one here
drifting out of step with it.

Rows show the expression, the target, when it is next due, and how the last run
went. A session target with no title is one deck can no longer find, which is why
that schedule stopped; it reads `session no longer exists` in red. **Run now**
fires a schedule whatever its due time says, and reports deck's refusal if the
last run is still going.

## Dev browser

A session's dev servers run on the deck machine, which is never this one, so
`http://localhost:5173` means nothing here and a link out to Safari finds
nothing. The app browses them itself instead: the **Browser** tab, the globe in
a session's toolbar, or a server's preview address.

The tab shows every running server across all sessions, since the tunnel reaches
the machine rather than a session; from a session it shows that session's. It
took Settings' place in the tab bar, which is now a gear on Sessions: five is
the most iOS shows before burying the sixth under "More".

It opens a tab per declared port, named from the dev config's labels, with the
primary one in front and a dot showing whether the port is answering yet. `+`
adds a tab for any address. Reaching them needs the tunnel, under the lock
button or the status strip: host, port, user and password for ssh on the deck
machine, which needs `AllowTcpForwarding` on. The host is prefilled from the
deck origin, since that is the machine the servers are on.

The local SOCKS port is chosen by the kernel rather than asked for. A fixed
number clashes: the prototype this came from is on the same phone, defaults to
1080 and connects on launch, so deck asking for 1080 too simply lost.

Dev servers speak plain http, and the loopback sentinel is an ordinary hostname
to App Transport Security rather than an exempt loopback address, so the app
sets `NSAllowsArbitraryLoadsInWebContent`. Scoped to web content on purpose: the
API traffic URLSession carries stays under ATS.

The tunnel is an in-process `ssh -D`: SwiftNIO SSH opens the connection, a
loopback SOCKS5 listener takes the web view's requests, and a
`ProxyConfiguration` on the web view's data store points at it. A proxy rather
than one published origin per port, because the point is that undeclared ports
work too: a page on 5173 that fetches 3000 is a request nothing could have
enumerated in advance.

Two things to know when it misbehaves. Loopback URLs are rewritten to
`deck.localhost` on the way in, because WKWebView refuses to proxy a literal
`localhost` and bypasses it to this device; the address bar hides the rewrite,
so a URL that looks right can still be the wrong host underneath. And the
machine's SSH host key is trusted on first use, so a rebuilt machine fails with
both fingerprints until you forget it in the tunnel sheet.

On the Mac the browser is its own window (Window > Browser, Shift-Command-B)
with the same tabs, address bar and tunnel sheet. Deck may run on that very
Mac, though, and then there is no tunnel: when the deck origin's host is
loopback (`localhost`, `127.0.0.1`, `::1`) the dev servers are local, so pages
load directly and the lock button is gone. `LoopbackHost.isDirect` decides it;
a tailnet name or a LAN address still means another machine and the tunnel.

Testing the tunnel end to end needs an SSH server, so that test skips without
one. Any server with password auth and forwarding will do:

```sh
cd Packages/DeckKit && DECK_TUNNEL_HOST=127.0.0.1 DECK_TUNNEL_PORT=2222 \
  DECK_TUNNEL_USER=dev DECK_TUNNEL_PASSWORD=devpass swift test
```

It asserts the forward was opened as well as the body coming back: the target
sits on this machine, so without that check it would pass on a bypassed proxy.

## Siri

Siri covers the one-shot commands without any of the above, through App
Intents. Nine intents, each with several spoken phrases registered:

- "Show my deck sessions" / "What is running in deck" / "Search deck sessions"
- "What needs my attention in deck?" / "Is anything waiting in deck"
- "How is deck going?" / "What did deck say" / "Catch me up on deck"
- "Start a session in deck" (it then asks what to work on)
- "Start work on <issue> in deck" / "Review <pull request> in deck"
- "Answer deck: yes, merge it" / "Stop deck"

Each intent carries several phrasings on purpose. There is no assistant schema
domain for coding-agent sessions (Apple ships them for mail, photos, documents
and the like), so App Shortcuts match these close to verbatim and nothing is
paraphrased for us: a phrasing that is not written down gets "I can't do that
in the deck app, try opening it". If Siri misses something you say often, add
it to `Apps/SharedIntents/AppIntentsRegistration.swift` (the phone and watch
apps both compile it); every phrase must
contain `\(.applicationName)`.

The intents surface automatically once the app is installed, and are built with
the iOS 27 SDK, so App Intents 2.0 composition applies.

Siri routes one utterance to one intent; it does not hold a conversation or
summarise a transcript. That is what the Operator tab is for.

## Lock screen and notifications

A running session gets a Live Activity: status, time since it started, cost,
and the newest reply on the lock screen and in the Dynamic Island, with a
Stop button. deck pushes updates to the card while the app is suspended
(`POST /api/push/apns/activity` registers the card's token), so it needs the
same APNs key as notifications.

A question's notification carries its options: long-press it and pick
"Option 1/2/3" (the body lists which is which) or "Reply" to type, and the
answer posts without opening the app. Search from the Sessions tab: typing filters the list to sessions whose name
matches, and what was said matches under them, so a hit still opens its session
at that message.
Long-press any reply to have it read aloud.

A session's menu shows how full its context window is and offers **Compact
context**, which summarises the history and frees the window. A row in the list
grows a `context 78%` chip once it passes two thirds, red past 85%. deck can
also compact on its own at a threshold you set, under **Settings > deck server
settings** here or **Settings > Auto-compact** on the web.

Rename a session from its menu (**Rename**) or by swiping its row in the list.
An unregistered tmux terminal has no record on the deck side, so renaming it
renames the tmux session and deck's id for it moves with it; the app follows
that rather than closing the session you had open.

A message that names a local file (a screenshot the agent took, a report it
wrote) shows it under the text: images as previews that open a full-screen
gallery of the message's images (swipe between them, pinch to zoom, share),
other files as chips that fetch the file and open it in Quick Look. deck
serves only files inside a registered project or its worktrees
(`/api/agent/sessions/<id>/files`); anything else stays plain text.

## iPad and Mac

The app runs full size on iPad in either orientation: the wide layout built
for the foldable puts the sessions list beside the open session. Drag the
divider to resize the list (260 to 560pt, remembered per device); on a
foldable the fold decides instead, since the seam has to land on the hinge.

Text in a reply is selectable, so a paragraph can be dragged and copied like
anywhere else. An image in the transcript has **Copy image** on its context
menu and a copy button in the full-screen gallery, which puts the picture on
the clipboard rather than a file reference.

### The Mac app

`DeckMac` is a native SwiftUI app for macOS 26 and later, not a Catalyst build
of the iPad app. It shares the bundle id `tech.moravec.deck` with the iOS app,
so one App Store record carries both, and links DeckKit, DeckUI (the shared
session row, tool cards, question card and terminal view) and DeckIntents, so
the Siri phrases match the phone's.

```sh
xcodebuild -project Deck.xcodeproj -scheme DeckMac -destination 'platform=macOS' \
  -skipMacroValidation CODE_SIGNING_ALLOWED=NO build
```

A Mac has no camera to scan the sign-in QR code, so it signs in one of two
ways:

- **Paste** the server URL and the token, or paste a whole sign-in link (the
  one the QR code encodes) into the URL field and the token comes with it.
- **Ask for access.** The app requests pairing from the server and shows a
  six-digit code. Approve the request in deck in a browser that is already
  signed in, after checking it shows the same code; the app picks the token up
  from the approval and signs in.

The main window is a sidebar of places (Inbox, Runs, Schedules, Start) over
the sessions list, and whichever is selected beside it. Inbox, runs, schedules,
starting a session and the session sheets are the phone's own views. A session
shows its transcript (history paged in on demand, live output as it streams,
images and the files a message mentions), its PR with review and merge, the
question card when it is waiting on you, and a composer that takes images
picked, pasted or dropped; shell sessions get a terminal. Its toolbar menu has
the phone's actions: agent, model, thinking level, compact, restart, rename,
changes, dev servers, schedule and delete.

Double-click a session (or choose **Open in New Window** from its context
menu) to give it a window of its own. Settings (Command-,) holds the account
and Sign Out, the projects with their dev servers, issue sources and
automation, the deck server's settings, and the operator's model. The menu bar
carries the keyboard shortcuts: Command-N new session, Shift-Command-N new
window, Command-Return send, Command-. stop, Shift-Command-K compact context,
Command-K command palette, Command-F search, Command-[ and Command-] previous
and next session.

Not yet: searching what sessions said (the sidebar filters by name only), the
transcript's thread view, deleting several sessions at once, unhiding a hidden
project, the operator's wake word, and the share extension. Live Activities,
widgets and the hinge are phone-only and stay that way.

The app is sandboxed with network client and server access (the server half is
for the dev browser's loopback SOCKS listener, which the sandbox refuses
silently otherwise) and read-only access to files you pick. Shipping it needs
macOS added to the app id's platforms and a Mac provisioning profile with push.

## Foldables

On iPhone Duo the closed phone works as any other. Opened flat, the Sessions
tab shows the list on the left half and the open session on the right, split
on the fold, and the session's transcript stream and voice mode carry on
across a fold or unfold. Half open on a table, the transcript stands on the
upper half and the lower half holds voice mode (a large hold-to-talk button,
Skip, Stop, the output route and settings, or a "Start voice mode" button
when it is off), the question card, and the composer. Posture comes from
UIKit's `UIHingeInteraction` (iOS 27.1); older systems and other phones
never see the split layouts. The simulator can neither bend nor turn the
open display, so `DECK_HINGE=tabletop` in the launch environment forces the
tabletop layout for the UI tests and screenshots (`FoldableUITests`).

## Onboarding a device

Open deck in a browser, show the sign-in QR (the same one the PWA uses), and
scan it from the iOS app's sign-in screen. The app stores the origin + token in
the Keychain and syncs them to the watch via Watch Connectivity. The manual
fallback is pasting the origin and token directly.
