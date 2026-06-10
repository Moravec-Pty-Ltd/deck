# deck

Single browser app for driving Claude Code sessions and adhoc tmux terminals on this machine. Built to replace the aoe + gmux split with one flat, recency-sorted session list, with light/dark/e-ink themes (e-ink kills all motion and shadows).

## How it works

- **Claude sessions** run headless Claude Code (`claude -p --output-format stream-json --resume`) under your normal Claude subscription auth. No API key needed. Each turn spawns a process; events are appended to a JSONL transcript in `~/.deck/transcripts/` and streamed to the browser over SSE. The UI renders a structured chat view (messages, collapsed tool calls, turn cost).
- **Shell sessions** are plain tmux sessions. Every live tmux session on the box shows up in the list (aoe/gmux sessions included, marked adhoc); the detail view is a polled `capture-pane` text snapshot with a send box and key shortcuts (ctrl-c, esc, arrows). You can still `tmux attach` from any terminal.
- **Worktrees**: session creation can make a `git worktree` at `<repo>-worktrees/<branch>` (new or existing branch). Init scripts are intentionally manual.
- **Projects** are registered paths stored in `~/.deck/projects.json`, used to populate the new-session picker.

## Run

Bind to loopback and let Tailscale terminate TLS, so the tailnet is the access boundary:

```sh
npm install
npm run build
HOST=127.0.0.1 PORT=4818 ORIGIN="https://<machine>.<tailnet>.ts.net:4818" node build/index.js

# one-time, in another shell: expose it over HTTPS, tailnet-only
tailscale serve --bg --https=4818 http://127.0.0.1:4818
```

Then open `https://<machine>.<tailnet>.ts.net:4818/` (real Let's Encrypt cert, no warnings). `ORIGIN` lets SvelteKit know its public https origin behind the proxy.

**Auth.** Off by default: access is whoever can reach the tailnet. Set `DECK_TOKEN=<secret>` to add a token wall on top (e.g. a shared tailnet); then open `…/?token=<secret>` once and a year-long cookie is set. `DECK_DATA` overrides the state dir.

Dev: `npm run dev` (Vite). The tailscale `.ts.net` hostnames are allowlisted in `vite.config.ts` so dev/preview also work behind the proxy.

## Notes

- Permission modes: new Claude sessions default to YOLO (`--dangerously-skip-permissions`); untick for `acceptEdits`. Headless turns cannot answer permission prompts, so `default`/`plan` modes will stall on gated tools.
- A server restart loses in-flight turn processes (transcripts and resume state survive; just send again).
- State: `~/.deck/{sessions.json,projects.json,transcripts/}`.
