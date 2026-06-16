# deck

Single browser app for driving Claude Code sessions and adhoc tmux terminals on this machine. Built to replace the aoe + gmux split with one flat, recency-sorted session list, with light/dark/e-ink themes (e-ink kills all motion and shadows).

## How it works

- **Claude sessions** run headless Claude Code (`claude -p --output-format stream-json --resume`) under your normal Claude subscription auth. No API key needed. Each turn spawns a process; events are appended to a JSONL transcript in `~/.deck/transcripts/` and streamed to the browser over SSE. The UI renders a structured chat view (messages, collapsed tool calls, turn cost).
- **Shell sessions** are plain tmux sessions. Every live tmux session on the box shows up in the list (aoe/gmux sessions included, marked adhoc); the detail view is a polled `capture-pane` text snapshot with a send box and key shortcuts (ctrl-c, esc, arrows). You can still `tmux attach` from any terminal.
- **Worktrees**: session creation can make a `git worktree` at `<repo>-worktrees/<branch>` (new or existing branch). Init scripts are intentionally manual.
- **Projects** are registered paths stored in `~/.deck/projects.json`, used to populate the new-session picker. Each can carry a template first-prompt that prefills new Claude sessions; placeholders `[title]`, `[branch]`, `[cwd]` are substituted at creation. The home list groups sessions by project (worktrees fold under their repo).

## Run

```sh
npm install
npm run build
PORT=4818 node build/index.js
```

The access URL (with token) is printed on first request and the token lives in `~/.deck/token`. Open `http://<host>:4818/?token=<token>` once; a year-long cookie is set. Override with `DECK_TOKEN` / `DECK_DATA` env vars.

For remote access, bind loopback and front it with Tailscale:

```sh
tailscale serve --bg --https 4818 http://127.0.0.1:4818
HOST=127.0.0.1 PORT=4818 DECK_NO_AUTH=1 node build/index.js
```

`DECK_NO_AUTH=1` skips the token gate, which is redundant once the tailnet is the access boundary. Leave it unset for token auth.

Dev: `npm run dev`.

## Install on a phone (PWA / WebAPK)

deck ships a web manifest, icons, and a service worker, so Chrome on Android installs it as a WebAPK (its own home-screen icon, standalone window, no browser chrome). This needs a real HTTPS origin, which the Tailscale `serve` setup above provides.

1. On the phone, open the tailnet URL in **Chrome** (e.g. `https://<host>.ts.net:4818`). It must be the `https://` address, not a bare IP. Reload once if you'd opened it before the PWA bits existed.
2. Tap the **Install** button that appears in deck's top bar, or use Chrome menu (⋮) → **Install app** / **Add to Home screen**. (The same install works from desktop Chrome/Edge.)
3. Launch from the new icon; it opens standalone.

The service worker caches the static app shell (hashed JS/CSS, icons) plus an offline fallback page, so the app satisfies Chrome's "works offline" install criterion. All `/api/*` traffic, including the SSE transcript stream, always goes straight to the network, so live sessions are never served stale. The status-bar color follows the active light/dark theme.

**If no Install option shows:** a true WebAPK install needs Google Play Services to mint the APK. On de-Googled or minimal Android builds without Play Services, Chrome offers only **Add to Home screen**, which still creates a standalone launcher (the manifest's `display: standalone` is honored), just not a real WebAPK. The in-app Install button only appears on Chromium browsers that support web-app install; if it never appears, the browser/device doesn't support it. Firefox for Android can also add a standalone launcher without Play Services.

On iOS, Safari → Share → **Add to Home Screen** gives a similar standalone launcher (Apple doesn't generate a WebAPK, but the manifest and apple-touch-icon are honored).

## Notes

- Each active Claude session runs as one long-lived `claude --input-format stream-json` process. Assistant text streams in live; a message sent mid-turn is queued and runs next; **Interrupt** stops the current turn (via a control_request) without ending the session, so you can immediately redirect it. Idle processes are torn down after 20 min and respawned with `--resume` on the next message.
- Permission modes: new Claude sessions default to YOLO (`--dangerously-skip-permissions`); untick for `acceptEdits`. Headless turns cannot answer permission prompts, so `default`/`plan` modes will stall on gated tools.
- A server restart drops live processes (transcripts and resume state survive; the next message respawns and resumes).
- Tool calls render structured: Bash shows the command + output (unified diffs in output are colorized), Edit/MultiEdit show a red/green line diff, Write shows its content as an added-line diff, TodoWrite shows the checklist, Read/Grep/Glob and others collapse their output. Each tool result is paired back to its call.
- Image attachments: paste an image into the Claude composer, use the paperclip to pick files, or drag-and-drop onto the conversation. Images are sent as base64 blocks in the user message and shown inline in the transcript.
- `AskUserQuestion`: when Claude asks a multiple-choice question, deck renders the options as buttons (single- or multi-select, plus an "other" field) and sends your pick back as the next message. The headless CLI auto-dismisses the prompt itself, so your answer arrives as a follow-up the model continues from; once answered the card shows the chosen options.
- http(s) links in session output are clickable. The transcript view only auto-scrolls when you're already near the bottom; a jump-to-latest button appears otherwise.
- The UI is mobile-friendly: no horizontal overflow at phone widths, button labels collapse to icons, and the conversation height uses `dvh` so the composer stays reachable.
- State: `~/.deck/{sessions.json,projects.json,token,transcripts/}`.
