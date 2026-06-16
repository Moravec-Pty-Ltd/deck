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

## Notes

- Each active Claude session runs as one long-lived `claude --input-format stream-json` process. Assistant text streams in live; a message sent mid-turn is queued and runs next; **Interrupt** stops the current turn (via a control_request) without ending the session, so you can immediately redirect it. Idle processes are torn down after 20 min and respawned with `--resume` on the next message.
- Permission modes: new Claude sessions default to YOLO (`--dangerously-skip-permissions`); untick for `acceptEdits`. Headless turns cannot answer permission prompts, so `default`/`plan` modes will stall on gated tools.
- A server restart drops live processes (transcripts and resume state survive; the next message respawns and resumes).
- http(s) links in session output are clickable. The transcript view only auto-scrolls when you're already near the bottom; a jump-to-latest button appears otherwise.
- State: `~/.deck/{sessions.json,projects.json,token,transcripts/}`.
