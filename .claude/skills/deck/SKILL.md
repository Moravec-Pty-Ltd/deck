---
name: deck
description: Drive and monitor deck (the local Claude Code session manager) through its agent API. Use when asked to start deck work sessions or PR-review sessions, send prompts to or stop running deck sessions, check what deck sessions need attention or have finished, answer a blocking deck question, or review/merge a PR through deck.
version: 2.0.0
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
the common operations. Every error is `{ "message": "..." }` with an HTTP status
(400 bad request / gh failure, 401 auth, 403 project confinement, 404 unknown,
409 conflict).

## Discovery (form valid calls with no out-of-band values)

```sh
GET /api/agent/projects              # [{ path, name, group }] — every valid cwd
GET /api/agent/kinds                 # installed agent CLIs + models
GET /api/agent/issues?project=<path> # open issues → create's issue {source,id,url}
GET /api/agent/prs?project=<path>    # open PRs → review's pr {repo,number}
GET /api/agent/workflows?project=<path>  # startable workflowIds (not the New/Review pair)
```

## Common operations

Check every session (status, awaitingInput, workflowRun, cost, pr):

```sh
curl -s -H "Authorization: Bearer $DECK_TOKEN" "$DECK_BASE_URL/api/agent/sessions"
```

Add work (new session, fresh worktree, first prompt). `Idempotency-Key` makes a
retried create safe:

```sh
curl -s -X POST -H "Authorization: Bearer $DECK_TOKEN" -H 'content-type: application/json' \
	-H "Idempotency-Key: $(uuidgen)" \
	-d '{"mode":"work","cwd":"/path/to/project","prompt":"...","worktree":{"branch":"my-branch","newBranch":true}}' \
	"$DECK_BASE_URL/api/agent/sessions"
```

Start a PR review session:

```sh
curl -s -X POST -H "Authorization: Bearer $DECK_TOKEN" -H 'content-type: application/json' \
	-d '{"mode":"review","cwd":"/path/to/project","pr":{"repo":"owner/repo","number":42},"prompt":"Review this PR."}' \
	"$DECK_BASE_URL/api/agent/sessions"
```

Steer, read output, run/cancel a workflow, answer, tear down:

```sh
POST /api/agent/sessions/<id>/message     {"text":"..."}   # -> { ok, status, seq }
GET  /api/agent/sessions/<id>             # digest + lastResult (the latest reply)
GET  /api/agent/sessions/<id>/transcript  # readable messages + lastResult + cost
POST /api/agent/sessions/<id>/stop
POST /api/agent/sessions/<id>/workflow    {"workflowId":"..."} | {"action":"cancel"}
GET  /api/agent/asks                      # what's blocking, with the options
POST /api/agent/sessions/<id>/answer      {"text":"...", "askId":"..."}  # askId only for workflow asks
POST /api/agent/sessions/<id>/review      {"decision":"approve|request-changes|comment","body":"..."}
POST /api/agent/sessions/<id>/merge       {"method":"squash|merge|rebase","deleteBranch":true}
DELETE /api/agent/sessions/<id>           {"deleteWorktree":true,"deleteBranch":true}
```

## Completion

- A **turn** is done when `status` goes running → idle and a `turn-finished`
  event fires; read the reply via `lastResult` or `/transcript`.
- A **run** is done when `workflowRun.status` ∈ done | paused | cancelled.

## Monitor — the event log

Every transition is appended to `~/.deck/events.jsonl` with a monotonic `seq`.
Track the last `seq` and resume from it (restart-safe). Locally, tail the file
(it rotates, so `tail -F` or re-read from your `seq`); remotely, poll the cursor:

```sh
curl -s -H "Authorization: Bearer $DECK_TOKEN" "$DECK_BASE_URL/api/agent/events"            # bootstrap: { snapshot, seq }
curl -s -H "Authorization: Bearer $DECK_TOKEN" "$DECK_BASE_URL/api/agent/events?since=<seq>"        # { events, seq }
curl -s -H "Authorization: Bearer $DECK_TOKEN" "$DECK_BASE_URL/api/agent/events?since=<seq>&wait=1" # long-poll ~25s
```

A too-old `since` returns `{ gap: true, snapshot, seq }`: re-snapshot and resume.
Apply deltas idempotently (an overlapping event may repeat snapshot state).
