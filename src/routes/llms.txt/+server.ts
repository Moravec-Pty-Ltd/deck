import type { RequestHandler } from './$types';
import { baseUrl } from '$lib/server/config';
import { shippedSkillVersion } from '$lib/server/skills';

// The canonical machine-facing contract for deck's agent API (issue #127,
// llmstxt.org convention): everything an external agent needs to drive and
// monitor deck, self-contained. Served without auth (see hooks.server.ts) so a
// client can self-onboard before it has presented the token; it documents the
// auth scheme but contains no secrets. Versioned in lockstep with the deck
// skill (the doc and the skill describe the same contract).

const doc = `# deck agent API

> deck is a single-user local web app that drives coding-agent sessions
> (claude / pi / codex / opencode) and tmux terminals. This documents its
> stable agent-facing API: discover projects / issues / PRs / workflows, create
> and steer sessions, read what they replied, act on PRs, answer blocking
> questions, and follow a durable, resumable event log. Designed so an
> autonomous orchestrator can drive deck end-to-end from this document alone.

Version: ${shippedSkillVersion}
Base URL: ${baseUrl}

## Authentication

Send the shared token on every /api request (deck-spawned agents find it in
\`$DECK_TOKEN\`, alongside \`$DECK_BASE_URL\`; otherwise it's in ~/.deck/token):

- \`Authorization: Bearer <token>\` (preferred) or \`X-Deck-Token: <token>\`

Unauthenticated requests to /api/* get 401. This document needs no auth.

## Error shape

Every /api error is a JSON body \`{ "message": "..." }\` with an HTTP status:

- \`400\` — bad request (invalid body/params; also a gh passthrough failure on
  review/merge, message carried through).
- \`401\` — missing/invalid token.
- \`403\` — a worktree/issue operation whose \`cwd\` is outside the registered
  project set (project confinement).
- \`404\` — unknown session / project / route.
- \`409\` — conflict (a workflow run or turn is already in flight).

Parse \`message\` for the reason; don't rely on the status alone.

## Discovery

Read-only projections, stable regardless of deck's internal storage. Use these
to form valid create/review calls without any out-of-band values.

### GET /api/agent/projects

Registered projects, the source of every \`cwd\`:

\`\`\`json
[{ "path": "/path/to/project", "name": "project", "group": "apps" }]
\`\`\`

\`create\` and \`review\` require \`cwd\` to be one of these \`path\`s for
worktree/issue/PR use; a plain session can run in any existing directory.

### GET /api/agent/kinds

Which agent CLIs are installed here and the models each enumerates:

\`\`\`json
[{ "kind": "claude", "available": true, "models": [] },
 { "kind": "pi", "available": false, "models": [{ "provider": "...", "model": "..." }] }]
\`\`\`

Pick a kind with \`available: true\` (an unavailable kind 400s at spawn).
\`model\` on create is free-text; an empty \`models\` list means pass any id the
CLI accepts.

### GET /api/agent/issues?project=<path>

Open issues for a project (\`project\` = a discovery \`path\`; \`&refresh=1\`
bypasses the 60s cache). Each row maps onto \`create\`'s \`issue\`:

\`\`\`json
{ "issues": [{ "source": "github", "id": "owner/repo#1", "title": "...", "url": "..." }],
  "errors": [{ "sourceId": "...", "message": "..." }] }
\`\`\`

Pass \`{ source, id, url }\` straight through as \`create\`'s \`issue\`.

### GET /api/agent/prs?project=<path>

Open PRs awaiting your review for a project. Each row carries \`review\`'s
\`pr { repo, number }\` plus context for picking one:

\`\`\`json
{ "prs": [{ "repo": "owner/repo", "number": 42, "title": "...", "url": "...",
	"headRefName": "feat", "baseRefName": "main", "isDraft": false, "author": "..." }],
  "errors": [] }
\`\`\`

### GET /api/agent/workflows?project=<path>

Startable workflows configured for a project:

\`\`\`json
[{ "id": "ship", "name": "Ship it", "context": "issue",
	"steps": [{ "name": "Implement", "type": "agent" }, { "name": "Test", "type": "gate" }] }]
\`\`\`

An \`id\` here is a valid \`workflowId\` for create or run-on-session. The plain
New/Review pair is *not* listed and is not a startable id.

## Sessions

A session is the unit of work: one agent (kind: claude|pi|codex|opencode) or
shell in a working directory, optionally in its own git worktree, optionally
running a multi-step workflow. Statuses: running | idle | error | dead.
\`awaitingInput: true\` means the session is blocked on a question (see Asks).
Shell sessions appear in digests and the event log for monitoring, but the
agent API cannot create or drive them (kind "shell" is rejected on create).

### GET /api/agent/sessions

Digest of every session:

\`\`\`json
[{
	"id": "c_abc123", "url": "${baseUrl}/s/c_abc123",
	"kind": "claude", "title": "...", "cwd": "/path/to/worktree",
	"status": "running", "awaitingInput": false,
	"createdAt": 0, "lastActiveAt": 0, "model": "...",
	"worktree": { "repo": "/path/to/project", "branch": "...", "createdBranch": true, "base": "main" },
	"issues": [{ "source": "github", "id": "owner/repo#1", "url": "..." }],
	"pr": { "repo": "owner/repo", "number": 42, "url": "...", "state": "open",
		"reviewDecision": "APPROVED", "mergeable": "MERGEABLE", "approvals": 1, "changesRequested": 0 },
	"workflowRun": { "workflowId": "...", "name": "...", "step": 1, "status": "running",
		"steps": [{ "name": "...", "type": "agent" }] },
	"cost": { "costUsd": 0.42, "turns": 12, "durationMs": 258000, "results": 12 }
}]
\`\`\`

### GET /api/agent/sessions/{id}

One session's digest, plus \`"lastResult"\`: the session's most recent assistant
reply (null if none yet). 404 when unknown.

### GET /api/agent/sessions/{id}/transcript

Readable turn output — what the session actually said:

\`\`\`json
{ "messages": [{ "role": "user", "text": "..." }, { "role": "assistant", "text": "..." }],
	"lastResult": "...", "cost": { "costUsd": 0, "turns": 0, "durationMs": 0, "results": 0 } }
\`\`\`

Bounded to the recent tail. The digest tells you a turn finished; this tells you
what it produced.

### POST /api/agent/sessions

Add work or start a PR review. Returns 201 \`{ "id", "url" }\` (200 on an
idempotent replay).

\`\`\`json
{ "mode": "work",
	"cwd": "/path/to/project",          // required; a registered project (see Discovery) for worktree/issue use
	"prompt": "...",                    // optional first prompt; omitted/blank defaults to the project's template
	"kind": "claude",                   // optional, default claude; use an available kind (see /api/agent/kinds)
	"title": "...", "model": "...",     // optional; model is free-text
	"workflowId": "...",                // optional startable workflow (see /api/agent/workflows)
	"issue": { "source": "github|linear|clickup", "id": "owner/repo#1", "url": "..." },  // optional; from /api/agent/issues
	"worktree": { "branch": "my-branch", "newBranch": true, "base": "main" }             // optional
}
\`\`\`

\`\`\`json
{ "mode": "review",
	"cwd": "/path/to/project",
	"pr": { "repo": "owner/repo", "number": 42, "url": "...", "title": "..." },  // repo+number required; from /api/agent/prs
	"prompt": "...", "kind": "claude", "workflowId": "..."  // prompt omitted/blank defaults to the project's review prompt
}
\`\`\`

Review mode fetches the PR head into a worktree and seeds the session with the
PR, so the review/merge endpoints below work on it.

In both modes, an omitted or blank \`prompt\` defaults to the project's
configured first-prompt template (work) / review prompt (review), the same
default the web new-session modal prefills, so the session's first turn still
starts. A supplied \`prompt\` always wins; there's no default when the project
has none configured.

**Idempotency**: send \`Idempotency-Key: <key>\` (or body \`"idempotencyKey"\`)
so a retried create — after a lost 201 — returns the same session (200) instead
of spawning a second one + worktree. Retry a failed/timed-out create under the
same key.

### POST /api/agent/sessions/{id}/message

\`{ "text": "..." }\` — send a prompt / steer. Mid-turn messages queue (claude)
or restart the turn (other kinds). Returns \`{ "ok": true, "status": "running",
"seq": <n> }\`. \`seq\` is the event-log cursor at send time: poll the event log
from it and watch for this session's \`turn-finished\` to know the turn is done.

### POST /api/agent/sessions/{id}/stop

Interrupt the in-flight turn (empty body). Returns \`{ "ok": true }\`.

### POST /api/agent/sessions/{id}/model

\`{ "model"?: "..." }\` — switch the session's model. Absent or empty resets to
the CLI default. Idle-only (409 if a turn is running); applies on the next
turn. Returns \`{ "ok": true }\`.

### POST /api/agent/sessions/{id}/workflow

\`{ "workflowId": "..." }\` — start a workflow run on this session, or
\`{ "action": "cancel" }\` to cancel/dismiss the current run. Returns
\`{ "ok": true, "status": "running" }\` (start) or \`{ "ok": true }\` (cancel).
409 if a run or turn is already in flight.

### POST /api/agent/sessions/{id}/review

\`{ "decision": "approve" | "request-changes" | "comment", "body": "..." }\` —
submit a GitHub review on the session's PR (body required except approve).
Returns \`{ "pr": <pr> }\`; a gh failure is a 400 with the message.

### POST /api/agent/sessions/{id}/merge

\`{ "method": "squash" | "merge" | "rebase", "deleteBranch": true }\` — merge
the session's PR (method defaults to squash). Returns \`{ "pr": <pr> }\`.

### DELETE /api/agent/sessions/{id}

\`{ "deleteWorktree": true, "deleteBranch": true }\` (JSON body, or query
\`?worktree=1&branch=1\`) — stop everything and remove the session.

## Completion semantics

Poll (a session digest, or the event log below) to know when it's safe to
proceed:

- A **turn** is finished when the session's \`status\` goes running → idle and a
  \`turn-finished\` event fires (subtype "success" = clean end); \`cost.results\`
  advances. Read the reply via \`lastResult\` / the transcript endpoint.
- A **run** is finished when \`workflowRun.status\` ∈ done | paused | cancelled
  (running | awaiting-input mean still going).

## Asks (blocking questions)

### GET /api/agent/asks

Everything waiting on a human answer, oldest first:

\`\`\`json
[{ "sessionId": "c_abc123", "source": "mcp" | "workflow", "askId": "wfask-...",
	"askedAt": 0,
	"questions": [{ "question": "...", "header": "...", "multiSelect": false,
		"options": [{ "label": "...", "description": "..." }] }] }]
\`\`\`

\`askId\` is present only for workflow checkpoints and must be echoed back when
answering one.

### POST /api/agent/sessions/{id}/answer

\`{ "text": "...", "askId": "..." }\` — resolve the pending ask (\`askId\` only
for workflow checkpoints). On success \`{ "ok": true, "seq": <n> }\` (\`seq\`
correlates the resulting turn). On failure \`{ "ok": false, "reason": ... }\`:

- \`no-pending-ask\` — nothing was waiting (already answered, or a race).
- \`askid-required\` — a workflow checkpoint is waiting but no \`askId\` was sent.
- \`askid-mismatch\` — the \`askId\` doesn't match the waiting checkpoint.

## Push notifications

Native iOS/watchOS clients register a device token to receive the same nudges
the installed PWA gets over web push (question asked, turn finished, session
crashed/exited, PR/workflow updates). Disabled server-side until an APNs key
is configured; registering is harmless either way.

### POST /api/push/apns/register

\`{ "token": "...", "platform": "ios" | "watchos", "env": "development" | "production" }\`,
upsert this device (\`token\` is the hex APNs device token). Returns
\`{ "ok": true }\`.

### POST /api/push/apns/unregister

\`{ "token": "..." }\`, stop sending to this device. Returns \`{ "ok": true }\`.

## Monitoring — the event log

Every session transition is appended to a durable, monotonically-sequenced log
at \`~/.deck/events.jsonl\` (one JSON object per line, with a global \`seq\`).
Track the last \`seq\` you processed and resume from it — restart-safe, no
persistent socket. Two ways to consume it:

**Local (primary): tail the file.** Bootstrap session state once from
\`GET /api/agent/sessions\`, then follow \`~/.deck/events.jsonl\`, tracking the
last \`seq\`. The file rotates (to \`events.jsonl.1\`) when it grows large, so
follow by name (\`tail -F\`) or re-read from your last \`seq\`.

**Remote/tailnet: the HTTP cursor.** \`GET /api/agent/events\`:

- No \`?since\` (bootstrap) → \`{ "snapshot": <all-session digest>, "seq": <n> }\`.
- \`?since=<seq>\` → \`{ "events": [ ...events with seq > since ], "seq": <n> }\`.
- \`?since=<seq>&wait=1\` → long-poll: holds up to ~25s for the next event, then
  returns (possibly with an empty \`events\`). Low latency, no persistent stream.
- If \`since\` predates the retained window →
  \`{ "gap": true, "snapshot": <digest>, "seq": <n> }\`: re-snapshot and resume
  from \`seq\`.

Each event is \`{ "seq", "sessionId", "type", "at", ...payload }\`:

- \`status\` — { status: running|idle|error|dead }
- \`awaiting-input\` — { awaitingInput, source: mcp|workflow, askId?, questions? }
- \`turn-finished\` — { subtype, cost } (subtype "success" = clean turn end)
- \`workflow\` — { workflowRun } (every step/status transition)
- \`pr\` — { pr } (captured PR seen or its GitHub state changed)
- \`session-created\` — { session: <digest> }
- \`session-deleted\` — {}

Apply deltas idempotently: after a gap re-snapshot (or bootstrap) an overlapping
event may repeat state the snapshot already reflects.

## Notes

- Sessions are the unit of work; there is no separate job queue. Workflow runs
  (\`workflowRun\`) are per-session step pipelines: running | awaiting-input |
  paused | done | cancelled.
- Worktree, issue, and PR operations require \`cwd\` to be a registered project
  (see Discovery); plain sessions can run in any existing directory.
- All endpoints are also usable by deck-spawned agents: \`$DECK_BASE_URL\`,
  \`$DECK_TOKEN\`, and \`$DECK_SESSION_ID\` are stamped into their environment.
`;

export const GET: RequestHandler = () => {
	return new Response(doc, {
		headers: { 'content-type': 'text/plain; charset=utf-8' }
	});
};
