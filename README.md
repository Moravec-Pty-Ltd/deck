# deck

A single browser app for driving Claude Code sessions and tmux terminals on one machine. One flat, recency-sorted list of every session, a structured chat view for Claude, and a polled terminal view for shells. Built to replace the aoe + gmux split. Light, dark, and e-ink themes (e-ink kills all motion and shadows).

It runs headless Claude Code under your normal subscription auth, so there's no API key to manage, and it installs as a PWA on a phone so you can drive sessions from anywhere on your tailnet.

## Screenshots

A structured chat view for Claude sessions, with inline diffs and collapsible tool output:

![Claude chat view](docs/screenshots/claude-chat.png)

One flat, recency-sorted list of every session across claude, pi, codex, and shells:

![Session list](docs/screenshots/sessions-list.png)

A polled terminal view for tmux shells:

![Terminal view](docs/screenshots/terminal.png)

Light, dark, and e-ink themes (e-ink drops all motion and shadows for a flat, monochrome render):

![Light, dark, and e-ink themes](docs/screenshots/themes.png)

## Requirements

- Node 20 or newer
- [pnpm](https://pnpm.io) (the repo pins a version via `packageManager`)
- The `claude` CLI (Claude Code) on your `PATH`, already logged in
- `tmux` and `git`
- `tailscale` (optional, for remote/phone access over HTTPS)

## Platform support

deck runs on **macOS** and **Linux**. It drives external CLIs (`claude`, `tmux`, `git`) over your shell and depends on `tmux` for the shell sessions, so it needs a POSIX environment. There are no native/compiled dependencies, so any Node 20+ runtime works.

On **Windows** there are two paths. The supported one is [WSL2](https://learn.microsoft.com/windows/wsl/install): run deck inside it and treat it as Linux. There's also an **experimental native-Windows path** using [psmux](https://github.com/psmux/psmux), a tmux-compatible multiplexer, in place of `tmux` (see below).

**macOS** (Homebrew):

```sh
brew install node pnpm tmux git
```

**Linux** (Debian/Ubuntu):

```sh
sudo apt install tmux git
corepack enable          # provides pnpm at the version the repo pins
# Node 20+: use nvm, NodeSource, or your distro if it ships 20+
```

**Windows, via WSL2** (supported): install a distro (`wsl --install`), open it, then follow the Linux steps inside WSL. Run deck from the WSL shell and open the printed URL in a Windows browser. Keep the repo on the Linux filesystem (`~/...`, not `/mnt/c/...`) for sane performance.

**Windows, native** (experimental, unverified): deck shells out to `tmux`, `git`, and the agent CLIs, none of which ship with Windows. The native route is:

```powershell
winget install psmux        # provides a tmux-compatible `tmux` on PATH
winget install Git.Git
# Node 20+: winget install OpenJS.NodeJS, then `corepack enable` for pnpm
```

Then install the [`claude` CLI](https://docs.claude.com/en/docs/claude-code) and log in. Caveats on native Windows:

- deck resolves agent CLIs installed as `.cmd`/`.bat` shims (via `cross-spawn`), but an agent launched through such a shim runs under a `cmd.exe` wrapper that an interrupt may not fully tear down. Prefer native `.exe` installs of `claude`/`pi`/`codex` so teardown stays clean.
- psmux needs **PowerShell 7+** for Claude Code integration, and deck leans on tmux's `=name` exact-target syntax and `capture-pane -e` colour output, which haven't been verified against psmux. If shell sessions misbehave, fall back to WSL2.

The [`claude` CLI](https://docs.claude.com/en/docs/claude-code) is the same install everywhere (log in once). The rest of setup is identical on every platform:

## Setup

```sh
pnpm install
pnpm build
PORT=4818 node build/index.js
```

On first request deck prints an access URL with a token, and stores the token in `~/.deck/token`. Open `http://<host>:4818/?token=<token>` once and a year-long cookie is set.

Dev server: `pnpm dev`.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port (the examples use `4818`) |
| `HOST` | `0.0.0.0` | Bind address |
| `DECK_DATA` | `~/.deck` | Data directory (state, transcripts, keys) |
| `DECK_TOKEN` | random | Override the generated access token |
| `DECK_NO_AUTH` | unset | Set to `1` to skip the token gate entirely |
| `DECK_PUSH_SUBJECT` | `mailto:deck@localhost` | VAPID contact for web push |

## Remote access (Tailscale)

Bind loopback and front it with Tailscale `serve` so the tailnet is the access boundary:

```sh
tailscale serve --bg --https 4818 http://127.0.0.1:4818
HOST=127.0.0.1 PORT=4818 DECK_NO_AUTH=1 node build/index.js
```

`DECK_NO_AUTH=1` drops the token gate, which is redundant once only the tailnet can reach it. Leave it unset to keep token auth.

The dev server does this for you: `vite dev` runs a small plugin that registers a `tailscale serve` for the lifetime of the process (see `vite.config.ts`). It's on by default; set `DECK_NO_TAILSCALE=1` to opt out (no tailscale installed, native Windows, or you just don't want it), and the dev server runs without touching tailscale.

## Install on a phone (PWA)

deck ships a web manifest, icons, and a service worker, so Chrome on Android installs it as a WebAPK (its own icon, standalone window, no browser chrome). This needs a real HTTPS origin, which the Tailscale setup above provides.

1. On the phone, open the tailnet URL in **Chrome** (e.g. `https://<host>.ts.net:4818`). It must be the `https://` address, not a bare IP.
2. Tap the **Install** button in the top bar, or use the Chrome menu → **Install app**. (The same works from desktop Chrome/Edge.)
3. Launch from the new icon; it opens standalone.

The service worker caches the static app shell plus an offline fallback, so deck meets Chrome's "works offline" install criterion. All `/api/*` traffic, including the SSE transcript stream, always goes straight to the network, so live sessions are never stale.

**If no Install option shows:** a true WebAPK needs Google Play Services. On de-Googled Android, Chrome offers only **Add to Home screen**, which still creates a standalone launcher. On iOS, Safari → Share → **Add to Home Screen** does the same (no WebAPK, but the manifest and apple-touch-icon are honoured).

## Notifications

deck can push notifications to the installed PWA so you don't have to babysit a session. Tap the bell in the top bar to enable it (needs an HTTPS origin and notification permission). You get notified when:

- Claude asks a question
- a turn finishes (turns under 12s are skipped, since you're probably watching those)
- a Claude process crashes
- a shell exits

VAPID keys are generated on first run and stored in `~/.deck/vapid.json`; subscriptions live in `~/.deck/push-subscriptions.json`. Override the VAPID contact with `DECK_PUSH_SUBJECT`.

## How it works

- **Claude sessions** run headless Claude Code (`claude -p --input-format stream-json --output-format stream-json --resume`) under your normal subscription auth. Each active session is one long-lived process; events are appended to a JSONL transcript in `~/.deck/transcripts/` and streamed to the browser over SSE. A message sent mid-turn is queued and runs next; **Interrupt** ends the current turn (via a `control_request`) without ending the session. Idle processes are torn down after 20 minutes and respawned with `--resume` on the next message.
- **Shell sessions** are plain tmux sessions. Every live tmux session on the box shows up (aoe/gmux sessions included, marked *adhoc*); the detail view is a polled `capture-pane -e` snapshot with a send box and key shortcuts. You can still `tmux attach` from any terminal. Output renders in a self-hosted single-width **Hack Nerd Font Mono** so captured grids stay aligned; ANSI colours are parsed and drawn over the current theme (e-ink forces them monochrome). Untitled shells are auto-named after a starship.
- **Worktrees**: new sessions can run in a `git worktree` at `<repo>-worktrees/<branch>`. The picker has three modes: *None* (run in the project root), *Existing* (pick a worktree that already exists), and *New* (branch off and create one). Shells default to *None*; Claude sessions default to *New*.
- **Projects** are registered paths in `~/.deck/projects.json` that populate the new-session picker. Each can carry a template first-prompt with `[title]`, `[branch]`, `[cwd]` placeholders. The home list groups sessions by project (worktrees fold under their repo); each group has a quick-add button.
- **Path inputs** autocomplete directories as you type and resolve a leading `~/` to your home directory.
- **Session sidebar**: the session view has a project-grouped switcher (sticky on desktop, a hamburger drawer on mobile) for jumping between sessions, quick-adding a session to a project, or opening a shell straight into a Claude worktree.
- **Questions**: when Claude asks a multiple-choice question it goes through deck's own blocking MCP `ask` tool, not the built-in `AskUserQuestion` (which the headless CLI can only auto-dismiss). deck renders the options as buttons; your pick resolves the still-open tool call and the same turn carries on. The chosen options stay on the card after reload.
- **Tool calls** render structured: Bash shows the command, Edit/MultiEdit a red/green line diff, Write its content as an added-line diff, TodoWrite the checklist. Bash output and the diffs collapse behind a single shared toggle (collapsed by default); flip one and they all flip. Each result is paired back to its call.
- **Images**: paste into the Claude composer, pick with the paperclip, or drag-and-drop onto the conversation. They're sent as base64 blocks and shown inline.

## Notes

- Permission modes: new Claude sessions default to YOLO (`--dangerously-skip-permissions`); untick for `acceptEdits`. Headless turns can't answer permission prompts, so `default`/`plan` will stall on gated tools. The `ask` tool is allow-listed so it works in either mode.
- A server restart drops live processes. Transcripts and resume state survive, so the next message respawns and resumes.
- http(s) links in session output are clickable. The transcript auto-scrolls only when you're already near the bottom; a jump-to-latest button appears otherwise.
- State lives in `~/.deck/`: `sessions.json`, `projects.json`, `token`, `vapid.json`, `push-subscriptions.json`, and `transcripts/`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Jin Chan
