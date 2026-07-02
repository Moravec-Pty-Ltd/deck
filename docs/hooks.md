# Harness stop-hooks: deep-link to a deck session

deck can push notifications to its own PWA (see the [Notifications](../README.md#notifications)
section). This is different: it wires up *your agent harness's own* stop hook so
that when a turn finishes, you get a notification whose click-through opens the
exact deck session that launched the agent.

It works because deck stamps `DECK_SESSION_ID` into every agent it spawns
(`agentEnv` in `src/lib/server/agents/env.ts`, used by the claude, pi, and codex
paths). A stop hook reads that id and opens deck's session view at
`<deck-base-url>/s/$DECK_SESSION_ID`.

When `DECK_SESSION_ID` is unset (a session deck did not launch, e.g. an agent you
started by hand) the hook does nothing, so the harness behaves exactly as it
would without it.

## The script

One script serves all three harnesses: [`examples/deck-notify.sh`](examples/deck-notify.sh).
It reads `DECK_SESSION_ID`, builds `"$DECK_BASE_URL/s/$DECK_SESSION_ID"`, and
`curl`s ntfy with a title, body, and a `Click` header for the deep-link. Nothing
secret is committed. Copy it somewhere on your machine and make it executable:

```sh
cp docs/examples/deck-notify.sh ~/.local/bin/deck-notify.sh
chmod +x ~/.local/bin/deck-notify.sh
```

It reads its configuration from the environment:

| Variable | Purpose |
|---|---|
| `DECK_SESSION_ID` | Set by deck; identifies the session. Do not set this yourself. |
| `DECK_BASE_URL` | Your deck origin, e.g. `https://your-deck-host:4818`. Required. |
| `NTFY_TOPIC` | ntfy topic to publish to, via `https://ntfy.sh/<topic>`. Required unless `NTFY_URL` is set. |
| `NTFY_URL` | Full ntfy publish URL (e.g. a self-hosted server). Overrides `NTFY_TOPIC`. |
| `NTFY_TOKEN` | Optional bearer token for a protected ntfy topic. |

### Base URL

The hook needs deck's host and port to build the link. deck does not stamp that
into the agent environment today (it stamps only `DECK_SESSION_ID`; the port is
`PORT`, default `3000`), so you provide it yourself as `DECK_BASE_URL`.

Export `DECK_BASE_URL` and `NTFY_TOPIC` in the environment where you start deck.
deck passes its own environment through to every agent it spawns (`agentEnv`
spreads `process.env`), so the hook inherits them without any per-harness config:

```sh
export DECK_BASE_URL="https://your-deck-host:4818"
export NTFY_TOPIC="your-ntfy-topic"
PORT=4818 node build/index.js
```

> Future enhancement: issue #77 shipped the `DECK_SESSION_ID` half this relies
> on; stamping `DECK_BASE_URL` into
> `agentEnv` too was raised there as an optional follow-up and has not been done.
> If it were, the hook would be host-agnostic and you would not export
> `DECK_BASE_URL`. That is a code change, out of scope here.

## Per-harness wiring

### claude

Claude Code runs a [`Stop` hook](https://docs.claude.com/en/docs/claude-code/hooks)
when a turn ends. Add it to `~/.claude/settings.json` (global) or a project's
`.claude/settings.json`, using an absolute path to the script:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "/path/to/deck-notify.sh" } ] }
    ]
  }
}
```

Claude passes hook payload JSON on stdin; the script ignores it and reads only
the environment.

### pi

pi has no config-file hook; it exposes lifecycle events to TypeScript
[extensions](https://github.com/badlogic/pi). The `agent_end` event fires when a
turn finishes and pi is waiting for input. [`examples/pi-deck-notify.ts`](examples/pi-deck-notify.ts)
subscribes to it and runs the shared script. Install it as an extension and point
it at your script copy:

```sh
mkdir -p ~/.pi/agent/extensions
cp docs/examples/pi-deck-notify.ts ~/.pi/agent/extensions/
export DECK_NOTIFY_SCRIPT="$HOME/.local/bin/deck-notify.sh"
```

(`.pi/extensions/` in a project works too.) Use an absolute path for
`DECK_NOTIFY_SCRIPT`; the extension spawns it directly. Because the extension runs
inside the pi process, `process.env.DECK_SESSION_ID` and the rest are already
present.

### codex

Codex runs a [`notify`](https://github.com/openai/codex) program on notable
events, including `agent-turn-complete` when a turn finishes. Add it to
`~/.codex/config.toml`, again with an absolute path:

```toml
notify = ["/path/to/deck-notify.sh"]
```

Codex invokes the program with a single JSON argument describing the event; the
script ignores it and reads only the environment. The program is a child of the
codex process deck spawned, so it inherits `DECK_SESSION_ID`.

### shell (out of scope)

Plain tmux shell sessions get no `DECK_SESSION_ID` (they are not agents deck
launched with `agentEnv`), so there is nothing for a stop hook to link to. deck
already notifies on shell exit through its own monitor
(`src/lib/server/monitor.ts`), so no hook is needed here.
