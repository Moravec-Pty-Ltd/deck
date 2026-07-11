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
> stable agent-facing API: create and steer sessions, act on PRs, answer
> blocking questions, and monitor everything over one SSE stream.

Version: ${shippedSkillVersion}
Base URL: ${baseUrl}

## Authentication

Send the shared token on every /api request (deck-spawned agents find it in
\`$DECK_TOKEN\`, alongside \`$DECK_BASE_URL\`; otherwise it's in ~/.deck/token):

- \`Authorization: Bearer <token>\` (preferred) or \`X-Deck-Token: <token>\`

Unauthenticated requests to /api/* get 401. This document needs no auth.

## Sessions

A session is the unit of work: one agent (kind: claude|pi|codex|opencode) or
shell in a working directory, optionally in its own git worktree, optionally
running a multi-step workflow. Statuses: running | idle | error | dead.
\`awaitingInput: true\` means the session is blocked on a question (see Asks).
Shell sessions appear in digests and the event feed for monitoring, but the
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

One session's digest. 404 when unknown.

### POST /api/agent/sessions

Add work or start a PR review. Returns 201 \`{ "id", "url" }\`.

\`\`\`json
{ "mode": "work",
	"cwd": "/path/to/project",          // required; a registered deck project for worktree/issue use
	"prompt": "...",                    // optional first prompt
	"kind": "claude",                   // optional, default claude
	"title": "...", "model": "...",     // optional
	"workflowId": "...",                // optional configured workflow to run
	"issue": { "source": "github|linear|clickup", "id": "owner/repo#1", "url": "..." },  // optional
	"worktree": { "branch": "my-branch", "newBranch": true, "base": "main" }             // optional
}
\`\`\`

\`\`\`json
{ "mode": "review",
	"cwd": "/path/to/project",
	"pr": { "repo": "owner/repo", "number": 42, "url": "...", "title": "..." },  // repo+number required
	"prompt": "...", "kind": "claude", "workflowId": "..."
}
\`\`\`

Review mode fetches the PR head into a worktree and seeds the session with the
PR, so the review/merge endpoints below work on it.

### POST /api/agent/sessions/{id}/message

\`{ "text": "..." }\` — send a prompt / steer. Mid-turn messages queue (claude)
or restart the turn (other kinds). Returns \`{ "ok": true, "status": "running" }\`.

### POST /api/agent/sessions/{id}/stop

Interrupt the in-flight turn (empty body). Returns \`{ "ok": true }\`.

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
for workflow checkpoints). Returns \`{ "ok": true }\`, or \`{ "ok": false }\`
when nothing matching was waiting.

## Monitoring

### GET /api/agent/events (SSE)

One stream for all sessions. Emits \`event: snapshot\` first (the full digest
array above), then \`event: delta\` frames, each
\`{ "sessionId", "type", "at", ...payload }\`:

- \`status\` — { status: running|idle|error|dead }
- \`awaiting-input\` — { awaitingInput, source: mcp|workflow, askId?, questions? }
- \`turn-finished\` — { subtype, cost } (subtype "success" = clean turn end)
- \`workflow\` — { workflowRun } (every step/status transition)
- \`pr\` — { pr } (captured PR seen or its GitHub state changed)
- \`session-created\` — { session: <digest> }
- \`session-deleted\` — {}

An \`event: ping\` heartbeat fires every 25s; reconnect if it stops.

## Notes

- Sessions are the unit of work; there is no separate job queue. Workflow runs
  (\`workflowRun\`) are per-session step pipelines: running | awaiting-input |
  paused | done | cancelled.
- Worktree and issue operations require \`cwd\` to be inside a project
  registered in deck; plain sessions can run in any existing directory.
- All endpoints are also usable by deck-spawned agents: \`$DECK_BASE_URL\`,
  \`$DECK_TOKEN\`, and \`$DECK_SESSION_ID\` are stamped into their environment.
`;

export const GET: RequestHandler = () => {
	return new Response(doc, {
		headers: { 'content-type': 'text/plain; charset=utf-8' }
	});
};
