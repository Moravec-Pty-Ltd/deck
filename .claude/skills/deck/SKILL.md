---
name: deck
description: Drive and monitor deck (the local Claude Code session manager) through its agent API. Use when asked to start deck work sessions or PR-review sessions, send prompts to or stop running deck sessions, check what deck sessions need attention or have finished, answer a blocking deck question, or review/merge a PR through deck.
version: 1.0.0
---

# deck agent API

deck is a local web app driving coding-agent sessions. It exposes an HTTP API for
orchestrators at `/api/agent/*`.

## Connect

- Base URL: `$DECK_BASE_URL` (deck-spawned agents have it stamped; default
  `http://localhost:4818`).
- Auth: send `Authorization: Bearer $DECK_TOKEN` on every request
  (`$DECK_TOKEN` is stamped into deck-spawned agents; otherwise read
  `~/.deck/token`).

The full, versioned contract lives at `$DECK_BASE_URL/llms.txt` (no auth
needed). Fetch it before anything non-trivial; the summary below covers only
the common operations.

## Common operations

Check every session (status, awaitingInput, workflowRun, cost, pr):

```sh
curl -s -H "Authorization: Bearer $DECK_TOKEN" "$DECK_BASE_URL/api/agent/sessions"
```

Add work (new session, fresh worktree, first prompt):

```sh
curl -s -X POST -H "Authorization: Bearer $DECK_TOKEN" -H 'content-type: application/json' \
	-d '{"mode":"work","cwd":"/path/to/project","prompt":"...","worktree":{"branch":"my-branch","newBranch":true}}' \
	"$DECK_BASE_URL/api/agent/sessions"
```

Start a PR review session:

```sh
curl -s -X POST -H "Authorization: Bearer $DECK_TOKEN" -H 'content-type: application/json' \
	-d '{"mode":"review","cwd":"/path/to/project","pr":{"repo":"owner/repo","number":42},"prompt":"Review this PR."}' \
	"$DECK_BASE_URL/api/agent/sessions"
```

Steer, stop, answer, tear down:

```sh
POST /api/agent/sessions/<id>/message  {"text":"..."}
POST /api/agent/sessions/<id>/stop
GET  /api/agent/asks                   # what's blocking, with the options
POST /api/agent/sessions/<id>/answer   {"text":"...", "askId":"..."}  # askId only for workflow asks
POST /api/agent/sessions/<id>/review   {"decision":"approve|request-changes|comment","body":"..."}
POST /api/agent/sessions/<id>/merge    {"method":"squash|merge|rebase","deleteBranch":true}
DELETE /api/agent/sessions/<id>        {"deleteWorktree":true,"deleteBranch":true}
```

Monitor everything on one SSE stream (snapshot, then live deltas):

```sh
curl -sN -H "Authorization: Bearer $DECK_TOKEN" "$DECK_BASE_URL/api/agent/events"
```
