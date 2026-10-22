# End-to-end tests

Playwright drives the web app in headless Chromium against a throwaway deck.

```sh
pnpm exec playwright install chromium   # once
pnpm test:e2e
```

`playwright.config.ts` makes a temp root holding deck's `HOME`, its `DECK_DATA`
(seeded with `projects.json`) and a small git project, then starts `vite dev`
on port 4840 with `DECK_TOKEN=e2e`. The root is deleted when the run ends. It
never touches `~/.deck`, port 4818 or your live tmux sessions.

Two directories go first on the server's `PATH`:

- `fake-harness/claude` stands in for the Claude CLI (see below), so deck
  shows Claude as installed and no real model is called.
- `bin/tmux` points every tmux call at a private `deck-e2e` socket, so the
  tests only see tmux sessions they made. The socket is killed at the end.

## The fake `claude`

A dependency-free Node script speaking the CLI's stream-json protocol: an
`init` event on start, then per user message streamed text deltas, the
assistant message and a `result` with cost and usage. A `control_request`
interrupt ends the turn. Keywords in the prompt pick the reply:

| Keyword | Reply |
| --- | --- |
| (none) | `Fake reply to: <prompt>` |
| `[tool]` | a `Bash` tool_use and its tool_result, then the reply |
| `[background:<seconds>]` | reports a running background task, replies, then reports it finished after that many seconds |
| `[background-agent:<seconds>]` | the same for a background `Agent` call, with its `task_started` and `task_notification` events |
| `[slow]` | starts a turn and waits until interrupted, so Working and Stop show |
| `[error]` | an error message and an `error_during_execution` result |
| `[file:<path>]` | a reply naming each path, so deck previews the files |
| `[ask]` | calls deck's MCP `ask` tool and replies with the answer |
| `[agent]` | an `Agent` tool_use, a subagent's text and `Bash` call tagged with its `parent_tool_use_id`, then the Agent's tool_result |
| `[background]` | a background `Agent` call with claude's `task_started` and `task_progress` events, then four seconds later a step and its `task_notification` report |
