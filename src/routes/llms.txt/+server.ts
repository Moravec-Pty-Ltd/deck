import type { RequestHandler } from './$types';
import { baseUrl } from '$lib/server/config';
import { shippedSkillVersion } from '$lib/server/skills';
import { AGENT_CAPABILITIES } from '$lib/server/agent-capabilities';
import { MIN_QUERY_CHARS } from '$lib/search-core';
import { SEARCH_LIMIT_MAX } from '$lib/server/search';

// The canonical machine-facing contract for deck's agent API (issue #127,
// llmstxt.org convention): everything an external agent needs to drive and
// monitor deck, self-contained. Served without auth (see hooks.server.ts) so a
// client can self-onboard before it has presented the token; it documents the
// auth scheme but contains no secrets. Versioned in lockstep with the deck
// skill (the doc and the skill describe the same contract).

const doc = `# deck agent API

> deck is a single-user local web app that drives coding-agent sessions
> (claude / pi / codex / opencode) and tmux terminals. This documents its
> stable agent-facing API: discover projects / issues / PRs, create and steer
> sessions, read what they replied, act on PRs, answer blocking questions, and
> follow a durable, resumable event log. Designed so an autonomous orchestrator
> can drive deck end-to-end from this document alone.

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
- \`409\`: conflict (a turn is already in flight, e.g. a model switch mid-turn).
  A worktree create that hits a leftover branch is a 409 too, with extra
  fields: see POST /api/agent/sessions.

Parse \`message\` for the reason; don't rely on the status alone.

## Discovery

Read-only projections, stable regardless of deck's internal storage. Use these
to form valid create/review calls without any out-of-band values.

### GET /api/agent

What this server supports: \`{ "version": "<skill version>", "capabilities": ["stream", ...] }\`.
Each capability token names an agent route or behaviour added after the
baseline; a client should check for a token before relying on what it names,
and treat a 404 here as a server older than every token. Tokens are only ever
added. Current tokens: ${AGENT_CAPABILITIES.map((t) => `\`${t}\``).join(', ')}.

### GET /api/agent/projects

Registered projects, the source of every \`cwd\`:

\`\`\`json
[{ "path": "/path/to/project", "name": "project", "group": "apps", "hidden": true }]
\`\`\`

\`create\` and \`review\` require \`cwd\` to be one of these \`path\`s for
worktree/issue/PR use; a plain session can run in any existing directory.

\`hidden\` is present only on a hidden project (see below); it still accepts
new sessions, it is just kept out of the lists.

### POST /api/agent/projects/hidden

\`{ "path": "/path/to/project", "hidden": true }\` — move a project, and every
session working in it or in one of its worktrees, into the "Hidden" section at
the bottom of the lists. Nothing stops running and nothing is deleted; hidden
sessions also stop sending notifications. \`false\` brings it back. An
unregistered path is a 404. Returns \`{ "ok": true, "path", "hidden" }\`.

### GET /api/agent/kinds

Which agent CLIs are installed here and the models each enumerates:

\`\`\`json
[{ "kind": "claude", "available": true, "models": [] },
 { "kind": "pi", "available": false, "models": [{ "provider": "...", "model": "..." }] }]
\`\`\`

A model row carries \`expensive: true\` when it is a premium model worth a
cost confirm before you start or switch to it (absent otherwise).

Pick a kind with \`available: true\` (an unavailable kind 400s at spawn).
\`model\` on create is free-text; an empty \`models\` list means pass any id the
CLI accepts.

### GET /api/agent/issues?project=<path>

Open issues for a project (\`project\` = a discovery \`path\`; \`&refresh=1\`
bypasses the 60s cache). Each row maps onto \`create\`'s \`issue\`:

\`\`\`json
{ "issues": [{ "source": "github", "sourceId": "...", "id": "owner/repo#1", "title": "...", "url": "...",
	"updatedAt": 1700000000000, "blockers": [{ "id": "owner/repo#2", "title": "..." }] }],
  "errors": [{ "sourceId": "...", "message": "..." }] }
\`\`\`

Pass \`{ source, sourceId, id, url }\` straight through as \`create\`'s \`issue\`.
\`updatedAt\` is epoch ms; \`blockers\` lists the open issues this one waits on.

### GET /api/agent/prs?project=<path>

Open PRs awaiting your review for a project. Each row carries \`review\`'s
\`pr { repo, number }\` plus context for picking one:

\`\`\`json
{ "prs": [{ "sourceId": "...", "repo": "owner/repo", "number": 42, "title": "...", "url": "...",
	"headRefName": "feat", "baseRefName": "main", "isDraft": false, "author": "...",
	"updatedAt": 1700000000000 }],
  "errors": [] }
\`\`\`

### GET /api/agent/skills

The skills installed on this machine (\`~/.claude/skills\` and each project's
\`.claude/skills\`), so you can tell a session to run one and can say what one
does:

\`\`\`json
{ "skills": [{ "name": "dev-workflow", "description": "...", "scope": "global" }] }
\`\`\`

\`scope\` is \`"global"\` or the project the skill belongs to.
\`GET /api/agent/skills/{name}\` returns \`{ "name", "body" }\`, the SKILL.md
truncated; 404 when no directory holds it.

A session runs a skill when its message starts with \`/name arguments\`. Send
\`"skills": true\` on a message (below) and deck rewrites spoken phrasing
("run dev-workflow on ENG-1") into that command against this machine's skills,
so a voice client does not need its own copy of the matching.

### GET /api/agent/defaults?project=<path>

What a new session in a project starts with when you pick nothing: the same
defaults the web new-session modal preselects.

\`\`\`json
{ "path": "/path/to/project", "base": "main",
  "prompts": { "work": "...", "review": "..." },
  "kinds": { "claude": { "model": "opus", "effort": "high", "permissionMode": "bypassPermissions" },
             "pi": { "model": "...", "provider": "..." }, "codex": { "model": "" }, "opencode": { "model": "" } } }
\`\`\`

\`base\` and each \`prompts\` entry are absent when the project has none
configured; an empty \`model\` means the CLI picks. Send these values on create
to start exactly what the web modal would, or override any of them. 404 for a
path that isn't a registered project.

The response also carries \`"expensiveModels": ["fable", ...]\`: the premium
models the web asks you to confirm before using. A model counts as expensive
when any entry is a case-insensitive substring of its id or its provider, so a
client can apply the same confirm to a free-text model it is about to send.

### GET /api/agent/user

\`{ "login": "octocat" }\`: the GitHub login deck's \`gh\` is signed in as, or
\`null\` when gh can't resolve it. Use it to offer merge only on your own PRs
(deck also captures PRs you are only reviewing).

### GET /api/agent/search?q=<text>&limit=<n>

Full-text search over what was said in every agent session. \`q\` is a
case-insensitive substring, at least ${MIN_QUERY_CHARS} characters (shorter is a 400);
\`limit\` defaults to 30 and is capped at ${SEARCH_LIMIT_MAX}.

\`\`\`json
{ "query": "...", "truncated": false,
  "hits": [{ "sessionId": "...", "title": "...", "index": 42, "role": "user|assistant", "snippet": "...", "at": 1700000000000 }] }
\`\`\`

\`index\` is the event's absolute transcript index: open the session there
with \`/s/{id}?at={index}\`, or page to it with /history.

### GET /api/agent/quick-messages

The user's canned messages, \`[{ "id": "...", "label"?: "...", "text": "...", "projectId"?: "..." }]\`,
for a one-tap send to a session, in display order. \`projectId\` is a
registered project's \`path\`: such a message is offered only in that project's
sessions, listed before the global ones (no \`projectId\`). Servers listing the
\`quick-messages-by-project\` capability store and return it; older ones drop it.

### PUT /api/agent/quick-messages

Replace the whole list with the same shape (up to 200; \`id\` and \`text\`
required, a blank \`label\` or \`projectId\` is dropped). Returns the stored
list; a schema mismatch is a 400.

## Projects

Register, configure and remove the projects that confine every worktree, git
and file operation. A deck-spawned agent may do this too: registering a
directory widens what deck will run git against, so it is limited to
directories under \`$HOME\` or inside an already registered project (anything
else is a 403).

### POST /api/agent/projects

\`{ "path": "~/code/example", "name"?: "example", "group"?: "apps" }\` registers
an existing directory (\`~\` expands; a missing or non-directory path is a 400,
one outside \`$HOME\` and the registered projects a 403, and so is \`$HOME\`
itself or any path under it with a dot-directory in it, such as
\`~/.secrets\`). A new project is stored under its canonical path, symlinks
resolved. Posting a path that is already registered re-saves it: every field
you omit keeps its stored value.
Optional fields as for \`PATCH /api/agent/projects/config\`. Returns the full
stored record, 201.

### DELETE /api/agent/projects?path=<path>

Unregister a project. Its directory, worktrees and sessions are untouched; its
issue-source keys go unless another project's source still uses them. Returns
\`{ "ok": true }\`.

### GET /api/agent/projects/config?path=<path>

A project's full stored record: \`{ name, path, group?, hidden?, template?,
reviewPrompt?, lastBase?, lastModels?, lastEffort?, sources?, dev?, automation? }\`.
\`template\` and \`reviewPrompt\` are the first-prompt templates for work and
review sessions, \`dev\` the dev-server config, \`automation\` the background
feed config. Without \`path\`, an array of every record. 404 for an
unregistered path.

### PATCH /api/agent/projects/config

\`{ "path": "<registered path>", ...fields }\` edits a project. Only the fields
you send change: \`name\`, \`group\`, \`template\`, \`reviewPrompt\`,
\`lastBase\` (strings; a blank clears, a non-string is a 400), \`dev\` and
\`automation\` (validated; a bad shape is a 400 naming the problem). \`hidden\`
has its own route, sources theirs, and the remembered model picks are written
by session creates, so those are ignored here. Returns the updated record; 404
for an unregistered path.

\`dev\` replaces the whole dev-server config (see Dev servers). Every key is
optional; step and server \`cwd\` are relative to the worktree:

\`\`\`json
{
	"copyFromMain": [".env"],
	"setup": [{ "label": "install", "run": "pnpm i", "cwd"?: "." }],
	"servers": [{ "name": "web", "run": "pnpm dev", "cwd"?: "apps/web",
		"setup"?: [<step>], "ports"?: [{ "port": 5173, "label"?: "app", "primary"?: true }],
		"readyPattern"?: "Local:\\\\s+(http\\\\S+)" }]
}
\`\`\`

Server names must be unique (also after tmux sanitising) and \`readyPattern\`
must compile as a regex; a port is an integer 1-65535.

### POST /api/agent/projects/clone

\`{ "url": "https://github.com/acme/repo.git", "parent": "~/code", "name"?, "group"? }\`
clones into \`<parent>/<repo name>\` and registers the result (201, the stored
record). \`url\` must be https, ssh, git or scp-style; \`parent\` an existing
directory under \`$HOME\` or a registered project (403 otherwise, and 403 when
the destination would sit in a dot-directory under \`$HOME\`, as for POST
/api/agent/projects). The project is stored under its real path. 409 when
the destination exists and is not an empty directory, or is already
registered; 400 with git's stderr when the clone fails, and nothing is
registered then.

### GET /api/agent/fs/complete?q=<partial path>

Directory completions for a path being typed, as \`["~/code/example", ...]\`
(up to 40, \`~\`-collapsed; hidden directories only when the last segment
starts with \`.\`). Confined to \`$HOME\` and the registered projects: anything
else returns \`[]\`.

### GET /api/agent/git/branches?repo=<path>

Branch names (local and remote, \`origin/\` stripped, deduplicated) for a
registered project or one of its worktrees, as \`["main", "feat", ...]\`.
\`[]\` for a path outside the project set or not a git repo; 400 without
\`repo\`.

### GET /api/agent/git/worktrees?repo=<path>

\`[{ "path": "/path/to/project", "branch": "main", "isMain": true }, ...]\`, the
repo's worktrees, main working tree first. Same confinement and errors as
branches.

## Sessions

A session is the unit of work: one agent (kind: claude|pi|codex|opencode) or
shell in a working directory, optionally in its own git worktree. Statuses:
running | idle | error | dead.
\`awaitingInput: true\` means the session is blocked on a question (see Asks).
Shell sessions (tmux terminals) are started with create's \`mode: "shell"\` and
driven through /terminal (see Terminals); the agent-session endpoints
(message, stop, answer, stream) do not apply to them.

### GET /api/agent/sessions

Digest of every session:

\`\`\`json
[{
	"id": "c_abc123", "url": "${baseUrl}/s/c_abc123",
	"kind": "claude", "title": "...", "cwd": "/path/to/worktree",
	"status": "running", "awaitingInput": false,
	"createdAt": 0, "lastActiveAt": 0, "model": "...", "effort": "high",
	"worktree": { "repo": "/path/to/project", "branch": "...", "createdBranch": true, "base": "main" },
	"issues": [{ "source": "github", "id": "owner/repo#1", "url": "..." }],
	"pr": { "repo": "owner/repo", "number": 42, "url": "...", "state": "open",
		"reviewDecision": "APPROVED", "mergeable": "MERGEABLE", "approvals": 1, "changesRequested": 0 },
	"cost": { "costUsd": 0.42, "turns": 12, "durationMs": 258000, "results": 12 },
	"context": { "used": 702516, "window": 1000000 },
	"hidden": true,
	"unread": true
}]
\`\`\`

Present only when set: \`provider\` (pi's provider, the other kinds carry it
inside \`model\`), \`permissionMode\` (acceptEdits | bypassPermissions | default |
plan), and on shell sessions \`managed\` (deck owns the tmux session) and
\`attached\` (a terminal client is attached to it).

\`hidden\` is present only on a hidden session, whether it was hidden itself or
its project was. A client that lists sessions should keep those out of its main
list and offer them in a "Hidden" section instead.

\`unread\` is present only while the session has a notification you have not
read: deck sets it when it notifies about the session, and clears it when the
session is opened in any client or its question is answered. The app icon
badge is the number of unread sessions that are not hidden.

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

### GET /api/agent/sessions/{id}/stream

Server-sent events for one agent session's raw transcript (what the web and
native session views render). 404 when unknown, 400 for a shell session.
Events:

- \`snapshot\`: \`{ "seq", "n", "data" }\`, the recent history split into \`n\`
	frames. Concatenate \`data\` in \`seq\` order and parse it as
	\`{ "start", "total", "cost", "context", "agents", "events": [...] }\`: \`events\`
	are the transcript lines from index \`start\` of \`total\`, and \`agents\` the
	session's subagents (with the \`subagents\` capability; see /agents below).
- \`status\`: the session status (running | idle | error | dead) on open and on
	every change.
- \`transcript\`: one live raw event, appended after the snapshot.
- \`exit\`: the session's claude process exited, so any subagent still shown
	as running has stopped (with the \`subagents\` capability).
- \`ping\`: a heartbeat every 25s; a stream silent for longer is dead, reconnect.

Opening the stream also kicks a background refresh of the session's PR, which
arrives through the digest and event log. Raw events are the CLI's own
stream-json lines plus deck's \`deck.*\` markers; they are less stable than
the digest and transcript projections above. A subagent's events carry
\`parent_tool_use_id\`, the id of the Agent (older CLIs: Task) tool_use that
launched it.

### GET /api/agent/sessions/{id}/agents

Every subagent of the session, folded over the whole transcript from claude's
\`system\` task events (\`subagents\` capability):

\`\`\`json
{ "tasks": { "<task id>": { "taskId": "...", "toolUseId": "<Agent call id>",
	"callIndex": 12, "description": "...", "subagentType": "...",
	"background": true, "status": "running", "activity": "Reading a file",
	"tokens": 0, "toolUses": 0, "durationMs": 0, "summary": "<final report>" } },
	"byCall": { "<Agent call id>": "<task id>" }, "callIndex": { "<Agent call id>": 12 } }
\`\`\`

\`status\` is running | completed | failed | stopped; with no claude process
every agent reads stopped. \`callIndex\` is the transcript index of the event
holding the launching call. The stream's snapshot carries the same object but
leaves out \`summary\` (setting \`reportOmitted\`) for finished agents launched
before its window; fetch them here when the reader scrolls back that far.

### GET /api/agent/sessions/{id}/history?before=<index>&limit=<n>

Older raw events for back-scroll: \`{ "start", "events": [...] }\`, the lines
\`[start, before)\` oldest first. \`before\` defaults to the end of the
transcript; \`limit\` defaults to 200 and is capped at 1000. Page backwards by
passing the previous \`start\` as the next \`before\` until \`start\` is 0.

### GET /api/agent/sessions/{id}/images/{file}

The bytes of an image attached to a user message, named by the \`file\` the
transcript's \`deck.user\` event carries. Immutable, so cache it. 404 when the
session or image is unknown.

### POST /api/agent/sessions/{id}/files

\`{ "paths": ["/path/to/project/out.png", "notes.md"] }\` — which of the files a
message mentions exist and can be served: \`{ "files": [{ "path", "name",
"size", "mime", "image" }] }\` (\`path\` as sent, so you can match it back). Relative paths resolve from the session's cwd. Only
regular files inside a registered project or its worktrees are listed; anything
else is silently absent. Up to 20 paths are checked per call.

### GET /api/agent/sessions/{id}/files?path=<path>&download=1

Serve one of those files, inline (or as an attachment with \`download=1\`), with
an \`etag\` (send \`If-None-Match\` for a 304). 404 for a path outside the
registered projects or a missing file.

### GET /api/agent/sessions/{id}/dir?path=<relative>

One folder under the session's cwd, for browsing it (capability
\`files-browser\`): \`{ "path": "src", "root": "/path/to/project", "entries":
[{ "name", "dir", "size", "mtimeMs" }], "truncated": false }\`. \`path\` is
relative to the cwd (\`""\` or absent for the cwd itself) and \`root\` is the
cwd's canonical absolute path, so a file to open with the \`files\` GET is
\`root/path/name\`. Folders come first, then names in natural order; dotfiles
and generated folders are included, and hiding them is the client's choice. At
most 2000 entries, with \`truncated\` set when more were left out. A \`..\`
segment, a missing folder, or a symlink out of the registered projects is a 404;
a session whose cwd is outside them is a 403.

### GET /api/agent/sessions/{id}/diff?meta=1

The session's worktree changes against its base branch. \`{ "git": false }\` when
the cwd is not a git repository; otherwise \`{ "git": true, "patch": "<unified
diff>", "meta" }\`, or with \`meta=1\` just \`{ "git": true, "meta" }\`. \`meta\` is
\`{ "baseRef", "baseResolved", "truncated", "fileCount", "additions",
"deletions", "files": [{ "path", "status", "additions", "deletions", "binary",
"oldPath"? }] }\`; \`truncated\` means the patch was trimmed (about 5 MB).

### POST /api/agent/sessions

Add work or start a PR review. Returns 201 \`{ "id", "url" }\` (200 on an
idempotent replay).

\`\`\`json
{ "mode": "work",
	"cwd": "/path/to/project",          // required; a registered project (see Discovery) for worktree/issue use
	"prompt": "...",                    // optional first prompt; omitted/blank defaults to the project's template
	"kind": "claude",                   // optional, default claude; use an available kind (see /api/agent/kinds)
	"title": "...", "model": "...",     // optional; model is free-text
	"effort": "low|medium|high|xhigh|max",  // optional; claude reasoning effort, omit for the CLI default
	"issue": { "source": "github|linear|clickup", "id": "owner/repo#1", "url": "..." },  // optional; from /api/agent/issues
	"worktree": { "branch": "my-branch", "newBranch": true, "base": "main" }             // optional; a newBranch is slugified into a valid ref (owner/repo#1 -> owner-repo-1)
}
\`\`\`

\`\`\`json
{ "mode": "review",
	"cwd": "/path/to/project",
	"pr": { "repo": "owner/repo", "number": 42, "url": "...", "title": "..." },  // repo+number required; from /api/agent/prs
	"prompt": "...", "kind": "claude"  // prompt omitted/blank defaults to the project's review prompt
}
\`\`\`

Review mode fetches the PR head into a worktree and seeds the session with the
PR, so the review/merge endpoints below work on it.

\`\`\`json
{ "mode": "shell",
	"cwd": "/path/to/project",          // required; an existing directory
	"command": "npm run dev",           // optional; runs instead of the login shell
	"title": "...",                     // optional; untitled shells get a generated name
	"worktree": { "branch": "my-branch", "newBranch": true },  // optional, as in work mode; or { "fromPr": 42 } for a PR's head
	"issues": [...], "pr": { "repo": "owner/repo", "number": 42 }  // optional context, shaped as in work / review mode
}
\`\`\`

Shell mode starts a deck-managed tmux terminal and no agent turn; \`kind\` must
not be "shell" in work or review mode. Drive it with /terminal below.

In both modes, an omitted or blank \`prompt\` defaults to the project's
configured first-prompt template (work) / review prompt (review), the same
default the web new-session modal prefills, so the session's first turn still
starts. A supplied \`prompt\` always wins; there's no default when the project
has none configured.

Work mode also accepts an \`issues\` array (up to 10), which takes precedence
over the legacy single \`issue\`. Pass raw prompt templates: the server expands
placeholders and fetches attached issue titles, bodies, comments, and images.
Preserve discovery's \`sourceId\` so keyed trackers use the correct credential.
Older clients without it use the project's matching source where unambiguous.

When \`title\` is omitted or blank, a session on exactly one issue is titled
with its display id (\`#1\` for a GitHub issue, \`ABC-123\` otherwise), else
with the worktree branch.

**Leftover branch (409)**: when the worktree's branch already exists or a stale
worktree holds it, create returns 409
\`{ "message": "...", "code": "branch-exists" | "stale-worktree", "branch": "..." }\`
instead of touching it. Retry the same body with
\`"worktree": { ..., "onExisting": "reuse" | "recreate" }\`: \`reuse\` checks the
existing branch out as it stands (keeping its commits), \`recreate\` deletes it
and branches again from \`base\` (unpushed commits on it are lost). A second
failure is reported as is.

**Idempotency**: send \`Idempotency-Key: <key>\` (or body \`"idempotencyKey"\`)
so a retried create — after a lost 201 — returns the same session (200) instead
of spawning a second one + worktree. Retry a failed/timed-out create under the
same key.

### POST /api/agent/sessions/{id}/message

\`{ "text": "...", "expand"?: true, "skills"?: true, "voice"?: true, "images"?: [{ "media_type": "image/png", "data": "base64" }] }\` — send a prompt / steer. Mid-turn messages queue (claude)
or restart the turn (other kinds). Returns \`{ "ok": true, "status": "running",
"seq": <n> }\`. \`seq\` is the event-log cursor at send time: poll the event log
from it and watch for this session's \`turn-finished\` to know the turn is done.
Text is literal unless \`expand: true\` is supplied. Expansion can fetch rich
issue context for attached issues. \`skills: true\` additionally rewrites spoken
skill phrasing into its \`/name arguments\` command (see Discovery). \`voice: true\`
marks a message spoken in voice mode: deck asks the agent to open its reply
with a short plain answer that reads well aloud. Images currently require a Claude session;
other runtimes return 400 rather than silently discarding attachments.

### POST /api/agent/sessions/{id}/stop

Interrupt the in-flight turn (empty body). Returns \`{ "ok": true }\`.

### POST /api/agent/sessions/{id}/agent
Switch coding agents between turns. Body: { "kind": "claude" | "codex" | "pi" | "opencode" }.
Keeps the deck session, working directory, and transcript. Starts a fresh native
runtime and resets model/provider/effort settings. Recent conversation text is
passed with the next message; older context, tool output, and images may be omitted.
Returns 409 while a turn is running, or 400 if the agent is not installed.

### POST /api/agent/sessions/{id}/model

\`{ "model"?: "..." }\` — switch the session's model. Absent or empty resets to
the CLI default. Idle-only (409 if a turn is running); applies on the next
turn. Returns \`{ "ok": true }\`.

### POST /api/agent/sessions/{id}/effort

\`{ "effort"?: "low|medium|high|xhigh|max" }\` — switch a claude session's
reasoning effort. Absent or empty resets to the CLI default; an unknown value or
a non-claude session is a 400. Idle-only (409 if a turn is running); applies on
the next turn. Returns \`{ "ok": true }\`.

\`context\` is how full the session's context window is: \`used\` tokens of
\`window\`. Absent until a turn has reported both. Watch it to decide when to
compact (below) or to hand work to a fresh session.

### POST /api/agent/sessions/{id}/compact

Empty body. Summarise the session's history and free the context window, the
same as typing \`/compact\`, keeping what a handoff keeps: goal, what is done
and in progress, next steps, blockers, key files, decisions, git state. Idle-only
(409 if a turn is running); a non-claude session is a 400. It runs as a turn of
its own, so the usual \`turn-finished\` follows. Returns \`{ "ok": true }\`.

deck can also do this by itself once \`context.used / context.window\` passes a
threshold, if the \`autoCompact\` block in ~/.deck/settings.json is on.

### POST /api/agent/sessions/{id}/title

\`{ "title": "..." }\` — rename a session. Whitespace is collapsed to one line
and trimmed; empty or over 80 characters is a 400. Allowed while a turn runs.
Returns \`{ "ok": true, "id", "title" }\`.

Read \`id\` back: renaming an unregistered tmux terminal (\`t_<tmux name>\`)
renames the tmux session, so its derived id moves with it. A colon is replaced
with \`-\` (tmux could not target the session otherwise), and a name another
terminal already holds is a 409. A registered session keeps its id.

### POST /api/agent/sessions/{id}/upload

\`{ "files": [{ "name": "report.pdf", "data": "<base64>" }], "text"?: "...", "images"?: [...] }\` —
share files with a session. Up to 10 per call, 25 MB each; a bigger one is a 413
naming its size. \`images\` takes the send endpoint's shape and goes inline with
the same turn, so pictures and files can travel in one message.

The files are written under deck's data dir (never into the worktree, so sharing
cannot dirty a repo) and the session is sent a message naming their absolute
paths, with \`text\` above it when given. The agent reads them from disk. Use the
send endpoint's \`images\` instead for pictures you want the model to see inline.

Returns \`{ "ok": true, "files": [{ "path", "name", "bytes" }] }\`. The stored
name is sanitised, so read \`path\` back rather than rebuilding it. A session's
uploads are deleted with the session.

### POST /api/agent/sessions/{id}/hidden

\`{ "hidden": true }\` — move one session into the "Hidden" section, or \`false\`
to bring it back. A hidden session keeps running and stops notifying; it is not
deleted. Returns \`{ "ok": true, "id", "hidden" }\`.

A session is also hidden when its project is (see
\`POST /api/agent/projects/hidden\`), and unhiding it on its own will not bring
it back while that holds. Either way the session list reports the answer as
\`hidden\` on the digest.

### POST /api/agent/sessions/read

\`{ "ids": ["c_abc123"] }\` — mark sessions read, clearing \`unread\`. Unknown
or already-read ids are ignored. Returns \`{ "ok": true, "unreadCount" }\`, the
new badge count. Opening a session in a client should call this.

### POST /api/agent/sessions/{id}/restart

Empty body. Drop a claude session's process so the next message respawns it
with the current CLI config (CLAUDE.md, settings, skills, MCP) and resumes the
same conversation. Idle-only (409 if a turn is running); a non-claude session is
a 400 (those kinds spawn per turn and need no restart). Returns \`{ "ok": true }\`.

### POST /api/agent/sessions/{id}/review

\`{ "decision": "approve" | "request-changes" | "comment", "body": "..." }\` —
submit a GitHub review on the session's PR (body required except approve).
Returns \`{ "pr": <pr> }\`; a gh failure is a 400 with the message.

### POST /api/agent/sessions/{id}/merge

\`{ "method": "squash" | "merge" | "rebase", "deleteBranch": true }\` — merge
the session's PR (method defaults to squash). Returns \`{ "pr": <pr> }\`.

### DELETE /api/agent/sessions/{id}/pr

Empty body. Dismiss the PR captured on the session (the chip goes away).
Capture is forward-only: the next GitHub PR link the agent prints captures a PR
again. Returns \`{ "ok": true }\`.

### GET /api/agent/sessions/{id}/zed

\`{ "command": "zed ssh://user@host/path/to/worktree" }\`: the command that opens
the session's directory in Zed over SSH on the deck host (the host is the one
you reached deck on, unless the user set a Zed SSH target). \`command\` is null
for a session with no directory.

### DELETE /api/agent/sessions/{id}

\`{ "deleteWorktree": true, "deleteBranch": true }\` (JSON body, or query
\`?worktree=1&branch=1\`) — stop everything and remove the session.

## Terminals

A shell session is a tmux pane: read its screen and type into it. These routes
answer 400 for an agent session and 404 for an unknown id. Capability token:
\`terminal\`.

**Disclosure**: any holder of the token can drive every shell session deck
lists, including deck-spawned agents (they have \`$DECK_TOKEN\`) and including
terminals deck did not start (\`managed: false\`: the machine's other tmux
sessions, which may have a person attached). Typed text runs as the user who
runs deck, with no confirmation. Only drive a terminal you started, or one you
were asked to.

### GET /api/agent/sessions/{id}/terminal?lines=<n>&h=<tag>

The pane's current screen: \`{ "text": "<ANSI text>", "cleared": false,
"dead": false, "h": "<tag>" }\`. \`lines\` is the scrollback depth (default
500, at most 5000). Pass the last \`h\` back to poll cheaply: an unchanged pane
answers \`{ "unchanged": true, "h" }\`. \`cleared: true\` means the program
cleared the screen and \`text\` is its last non-empty output. A dead session
answers \`{ "text": "(session is dead)", "dead": true }\`.

### POST /api/agent/sessions/{id}/terminal

\`{ "text": "ls -la", "submit"?: true }\` types literal text (at most 4096
UTF-8 bytes) and presses Enter unless \`submit\` is false; empty text with
submit is a bare Enter. With \`submit: false\` the text must not contain a
carriage return or newline (it would press Enter anyway): that is a 400. \`{ "key": "C-c" }\` presses one key instead, by its
tmux name: Enter, Escape, Tab, BTab, BSpace, DC, Space, Up, Down, Left, Right,
Home, End, PPage, NPage, or C-a through C-z. Any other key is a 400. Returns
\`{ "ok": true }\`; read the result with GET a moment later.

## Completion semantics

Poll (a session digest, or the event log below) to know when it's safe to
proceed:

- A **turn** is finished when the session's \`status\` goes running → idle and a
  \`turn-finished\` event fires (subtype "success" = clean end); \`cost.results\`
  advances. Read the reply via \`lastResult\` / the transcript endpoint.

## Asks (blocking questions)

### GET /api/agent/asks

Every MCP \`ask\` waiting on a human answer, oldest first:

\`\`\`json
[{ "sessionId": "c_abc123", "source": "mcp", "askId": "toolu_...", "askedAt": 0,
	"questions": [{ "question": "...", "header": "...", "multiSelect": false,
		"options": [{ "label": "...", "description": "..." }] }] }]
\`\`\`

\`askId\` is the ask's tool-call id (absent in the rare case deck couldn't
match the call on the transcript). Pass it back with a structured answer so
the picks persist on the session's transcript.

A blocked workflow run is listed here too, as
\`{ "source": "run", "runId", "sessionId"?, "questions": [{ "question", "header", "options": [] }], "askedAt" }\`.
\`sessionId\` is the run's latest phase session; answering through that
session's answer route (below) answers the run, or use
\`POST /api/agent/runs/{id}/answer\`.

### POST /api/agent/sessions/{id}/answer

\`{ "text": "...", "askId"?: "toolu_...", "answers"?: [{ "header": "...", "labels": ["..."] }] }\`
resolves the pending ask. \`text\` is what the agent receives and is required;
\`answers\` (one entry per question, in order) records the picks on the
transcript the same way the web ask card does, so every client shows the
question as answered with those labels. On success \`{ "ok": true, "seq": <n> }\`
(\`seq\` correlates the resulting turn). On failure
\`{ "ok": false, "reason": "no-pending-ask" }\` means nothing was waiting (already
answered, or a race).

## Workflow runs

A run is a dev or review loop driven by deck itself: a state machine with one
fresh agent session per phase, all in the run's worktree. Phases invoke skills
(\`/dev-workflow\`, \`/dev-review\`, \`/address-feedback\`); every gate is
computed (an exit code, a review finding's severity, or a \`gh\` query), never
judged by a model. A run survives a deck restart. One run per worktree.

### GET /api/agent/workflows

\`{ "workflows": [<definition>], "problems": ["..."] }\`. Built-ins (\`dev\`,
\`review\`) merged with \`~/.deck/workflows.json\` (\`{ "workflows": [...] }\`,
same shape; a matching \`id\` replaces a built-in). Each definition is
\`{ id, name, category: "dev"|"review", default, steps }\`; each step is
\`{ id, label, role, skill?, args?, command?, agent?, repeatAgent?,
escalateAgent?, gate, next, onFail?, retries?, cap? }\`. \`problems\` lists
user definitions that were skipped as malformed.

### GET /api/agent/runs

Every run's digest, newest first. A digest is everything a client needs to
draw the board and a run's phases, with no HTML:

\`\`\`json
{ "id": "r_...", "url": "${baseUrl}/runs/r_...",
	"workflow": { "id": "dev", "name": "Dev workflow", "category": "dev" },
	"title": "#7", "projectPath": "...", "cwd": "...", "branch": "...", "base": "main",
	"issue": { "source": "github", "id": "owner/repo#7", "url": "..." },
	"pr": { "repo": "owner/repo", "number": 9, "url": "..." },
	"status": "running|waiting|paused|blocked|done|cancelled",
	"phase": "review", "round": 2, "cap": 5, "loop": true, "blockers": 1,
	"findings": [{ "file", "line", "severity", "defect", "fix", "keep" }],
	"escalations": { "implementer": false, "disagreement": false, "cap": false },
	"humanTouched": false,
	"phases": [{ "id": "review", "label": "Review", "role": "review",
		"status": "pending|active|pass|fail|skipped", "visits": 2, "cap": 5,
		"next": "pr", "onFail": "fix",
		"sessions": [{ "sessionId": "c_...", "visit": 1, "result": "fail", "detail": "...",
			"startedAt": 0, "endedAt": 0, "humanTouched": false }],
		"decisions": [{ "at": 0, "by": "overseer|human|engine", "step": "review",
			"action": "retry", "reason": "..." }] }],
	"block": { "question": "...", "at": 0, "by": "engine", "step": "pr" },
	"handoff": { "text": "...", "tree": "<git tree>", "at": 0 },
	"createdAt": 0, "updatedAt": 0 }
\`\`\`

\`waiting\` means the run is waiting on a PR reviewer (deck polls \`gh\`).
\`phases[].sessions\` holds one entry per visit, so a review phase that ran four
rounds lists four sessions. \`GET /api/agent/runs/{id}\` returns one digest plus
\`handoffStale\` when the working tree has moved since the handoff was written.

### POST /api/agent/runs

\`{ "cwd": "<project path or one of its worktrees>", "workflow"?: "<id>",
"category"?: "dev"|"review", "issue"?: { "source", "id", "url"? },
"pr"?: { "repo", "number", "baseRefName"? }, "base"?: "<branch>", "title"? }\`
starts a run and returns its digest (201). Without \`workflow\` the category's
default runs. A dev run started at a project root makes a worktree on the
issue's branch; a review run checks the PR out; a run started inside a
worktree works there. 409 when that worktree already has an active run.

### DELETE /api/agent/runs?finished=1

Remove every done or cancelled run and their phase sessions (add
\`keepSessions=1\` to keep the sessions). Live runs and every worktree and
branch are untouched. Returns \`{ "deleted": n }\`; 400 without
\`finished=1\`. Each removed run emits \`run-deleted\`.

### DELETE /api/agent/runs/{id}

Remove a run and its phase sessions (\`?keepSessions=1\` keeps the sessions).
A live run is stopped first (its phase session's turn and any verify command).
A session you took over is never deleted or stopped. The worktree and branch
are always kept, since the run's PR may still be open. Returns \`{ "ok": true }\`, 404 for an unknown run.

### POST /api/agent/runs/{id}/{action}

Body fields are optional unless noted. Every action takes \`reason\` and \`by\`
(\`"human"\`, the default, or \`"overseer"\`) and is recorded as a decision on
the run's current phase. Returns the run digest.

- \`pause\`: the engine stops reacting; the phase session keeps working. If
  its turn ends while paused, resuming that phase settles the turn rather than
  running the phase again. 409 on a blocked run (take it over instead).
- \`takeover\`: pause, stop the phase session's turn so you can drive it, and
  flag the phase as hand edited. Review scope comes from working-tree
  snapshots, so the next review round includes your edits.
- \`resume\` \`{ "phase"? }\`: start the given phase (default: the current one)
  in a fresh session. Works on any run that isn't done or cancelled; on a
  running one it stops the live phase session first.
- \`retry\`: resume at the current phase.
- \`cancel\`: stop the run for good.
- \`answer\` \`{ "text" }\` (required): answer a blocked run; it resumes at its
  phase with the answer handed to the next session.
- \`block\` \`{ "question" }\` (required): block the run on a question and notify.
- \`agent\` \`{ "step"?, "kind"?, "model"?, "provider"?, "effort"? }\`: change what a
  step runs on for this run. All fields blank clears the override.
- \`note\`: record a decision without acting.
- \`handoff\` \`{ "text" }\`: leave an intent note for whoever drives next,
  stamped with the current working tree.
- \`fix-findings\`: on a done dev run with an open PR and leftover findings (nits,
  or blockers a closer left), start one fix session in the run's worktree. It
  addresses every finding, gets the tests green, commits once, and pushes to the
  PR branch. The gate is git and the tests, not the reply: a new commit on the
  run's branch, history kept, nothing left uncommitted, pushed to that branch's
  upstream, and the verify command green on it. The run is then done again with
  no findings; if not, it blocks. 409 on any other run, when the PR is no longer
  open, or when another run is active in the worktree. The digest's
  \`followUp\` is true meanwhile.
- \`message\` \`{ "text" }\`: send to the current phase session of a paused run
  whose session is idle (409 otherwise). 409 for a review phase: reviewers are
  never steered.

### The overseer

\`GET /api/agent/overseer\` → \`{ "sessionId"?, "active", "busy" }\` (\`active\`:
an overseer is watching; \`busy\`: it is mid-turn). \`POST\`
(\`{ "kind"?, "model"? }\`) starts one long-lived session that deck wakes with
a note when a run blocks, a phase errors, or a run finishes; it acts through
the run actions above with \`"by": "overseer"\`. \`DELETE\` stops waking it.
Runs never depend on it.

## Schedules

A prompt that runs on a clock, for the recurring jobs that want an agent rather
than a shell script. A schedule carries a five-field cron expression, read in
the deck machine's local time, and exactly one target:

- \`cwd\`: a fresh session per run, in that directory, with its first turn the
  prompt. Agent/model/effort resolve like an automation lane (the schedule's
  own pick, else the project's remembered one, else the CLI default). No
  worktree is created.
- \`sessionId\`: the prompt goes to that session every run, so what it worked
  out last time is still loaded. Agent sessions only.

Rules worth knowing before relying on one:

- The due time is **stored**, not matched against the clock. A window that went
  by while deck was down fires once, not once per minute it was away.
- A window missed by more than an hour is recorded as skipped rather than caught
  up: after an outage you want the next run, not yesterday's.
- A run is skipped while the previous one is still mid-turn, so a job slower
  than its own interval cannot pile up sessions.
- Starting a run is silent (the same bargain automation makes). Only a schedule
  deck has had to switch off pushes, as \`needs-you\`.

### GET /api/agent/schedules

Every schedule, newest first:

\`\`\`json
{ "id": "sch_...", "title": "Morning sweep", "cron": "0 9 * * mon-fri",
	"prompt": "Summarise what changed overnight.", "enabled": true,
	"cwd": "/path/to/project", "projectName": "example",
	"agent": { "kind": "claude", "model": "opus" },
	"createdAt": 0, "nextRunAt": 0, "lastRunAt": 0,
	"lastOutcome": "ran", "lastNote": null, "lastSessionId": "c_...", "runs": 12 }
\`\`\`

\`lastOutcome\` is \`ran\`, \`skipped\` or \`failed\`, and \`lastNote\` says why
for the latter two. A session-targeted schedule also carries \`sessionTitle\`;
its absence means that session is gone, which is why the schedule stopped.

### POST /api/agent/schedules

\`{ "cron", "prompt", "cwd" | "sessionId", "title"?, "enabled"?, "agent"? }\`
→ 201 with the digest. \`title\` defaults to the prompt's first line. 400 on an
unreadable expression (the message names the field), on naming both targets or
neither, on a directory that does not exist, on a session that does not exist or
is a terminal, and on an agent pick that breaks the per-kind contracts
(\`effort\` is claude-only, \`provider\` pi-only).

### GET /api/agent/schedules/preview?cron=<expr>&count=3

What an expression would do, without saving anything:
\`{ "cron", "problem": null, "next": [<epoch ms>, ...] }\`. \`problem\` is the
one-line reason it could not be read, and \`next\` is then empty — as it also is
for an expression that reads fine but can never happen (30 February), which is
why the two are separate fields. \`count\` is clamped to 1..10.

### PATCH /api/agent/schedules/{id}

Any subset of the POST fields; only what the body mentions is applied, so an
old client cannot wipe a field it has never heard of. Moving the target means
sending both halves. Changing the expression, or switching a schedule back on,
re-books the next run from now.

### POST /api/agent/schedules/{id}/run

Run it now, whatever the due time says and whether or not it is enabled; the
next due time still moves to the next real window, so this does not shift the
schedule. 409 while the previous run is still going.

### DELETE /api/agent/schedules/{id}

Forget the schedule. The sessions it has already started are kept.

## Watches

A timer a claude session sets on itself, with an optional quick check. Use one
instead of sleeping or looping in the shell: a watch survives a deck restart,
shows in the session with its countdown, and can be cancelled from any client.
When it falls due, deck runs the check once in the session's directory (60 s
limit, killed past it, output tail capped) and sends the session one message:
the title, the prompt, the exit code and the output tail. If a turn is running
it waits for the turn to end, and a turn that starts during the check means the
check runs again once that turn ends. A watch fires once; set a new one if the thing is
not ready yet. One that fell due while deck was down fires on the first poll after startup
(within 10 s).

The agent sets them through deck's MCP server:

- \`mcp__deck__watch\` \`{ title, prompt, in | at, command? }\`: exactly one of
  \`in\` (\`"30s"\`, \`"10m"\`, \`"2h"\`, \`"1h30m"\`) or \`at\` (ISO time or epoch
  ms), at most 24 hours ahead. At most 5 active per session. Returns the id and
  the fire time. A \`command\` runs outside the agent's own permission checks,
  so it is only accepted, and only run, while the session is in
  \`bypassPermissions\` mode; otherwise the watch is refused, or fires with a
  "not run" note if the mode changed after it was set.
- \`mcp__deck__watches\`: this session's active watches.
- \`mcp__deck__unwatch\` \`{ id }\`: cancel one of this session's watches.

Ready-made checks:

- CI on a PR: \`gh pr checks <n>\`
- New reviews: \`gh pr view <n> --json reviews\`
- A URL coming up: \`curl -sf http://localhost:3000/health\`

A session's active watches are also on its digest as \`watches\` (newest first,
omitted when none), and a \`watches\` event on the cursor carries the new list
whenever it changes.

### GET /api/agent/watches[?sessionId=]

\`{ "watches": [Watch] }\`, newest first: the active ones plus those that ended
in the last 24 hours.

\`\`\`json
{ "id": "wat_...", "sessionId": "c_...", "title": "CI on #42",
	"prompt": "If CI passed, merge; otherwise fix it.", "command": "gh pr checks 42",
	"createdAt": 0, "dueAt": 0, "state": "fired", "endedAt": 0,
	"result": { "exitCode": 0, "output": "...", "timedOut": false } }
\`\`\`

\`state\` is \`active\`, \`fired\` or \`cancelled\`. \`result\` is set once a
watch with a command has fired; \`exitCode\` is null when the check timed out
(\`timedOut: true\`) or could not run.

### DELETE /api/agent/watches/{id}

Cancel it; the agent is not woken. Returns the watch, unchanged if it had
already ended. 404 when unknown. Deleting a session cancels its watches.

### POST /api/agent/watches/{id}/run

Fire it now rather than at its due time: its due time becomes now and the next
check of due watches runs straight away, so it runs its check and wakes the
agent exactly as the timer would. While the session's turn is running it fires
when the turn ends. Returns the watch, unchanged if it had already ended. 404
when unknown.

## Issue sources

Where a project's issues come from (\`GET /api/agent/issues\`): a GitHub repo,
a Linear team or a ClickUp list. Linear and ClickUp need an API key. **Keys are
write-only**: one goes in on a POST and is kept in the OS keyring, and no
response, list or error message ever carries a key value back. A key saved for
one project can be reused by another through its \`credentialId\`, so it only
needs entering once. Capability token: \`issue-sources\`.

### GET /api/agent/credentials?type=linear|clickup

The saved keys, labels only, one entry per distinct key (\`type\` optional):

\`\`\`json
[{ "id": "<credentialId>", "type": "linear", "label": "someone@example.com", "projects": ["example"] }]
\`\`\`

\`label\` is who the key authenticates as when known, else the team or the
provider name. A key is listed while at least one source uses it.

### POST /api/agent/projects/sources/lookup

Provider lookups for filling in a new source before saving it:
\`{ "type": "linear" | "clickup", "action": "...", "apiKey" | "credentialId", ...ids }\`.
Linear actions: \`me\`, \`teams\`, \`states\` (+ \`teamId\`). ClickUp actions:
\`me\`, \`teams\`, \`spaces\` (+ \`teamId\`), \`folders\` (+ \`spaceId\`),
\`lists\` (+ \`folderId\` or \`spaceId\`), \`statuses\` (+ \`listId\`). Returns
the provider's rows as JSON. Pass a saved \`credentialId\` instead of an
\`apiKey\` to look up with a key you never see. A provider failure (most often
a bad key) is a 400 whose message is the provider's, with the key cut out.

### POST /api/agent/projects/sources

Add a source to a registered project; 201 with the stored source (its
\`credentialId\`, never the key). Body by \`type\`:

- \`github\`: \`{ "projectPath", "type": "github", "owner", "repo" }\`
- \`linear\`: \`{ "projectPath", "type": "linear", "teamId", "teamName"?,
	"assigneeEmail"?, "stateIds"?: [...] }\`
- \`clickup\`: \`{ "projectPath", "type": "clickup", "teamId", "spaceId",
	"listId", "assigneeUserId": <number>, "folderId"?, "statuses"?: [...],
	"teamName"?, "spaceName"?, "folderName"?, "listName"?, "assigneeName"? }\`

Linear and ClickUp also take exactly one of \`apiKey\` (stored under a new
credential) or \`credentialId\` (reuse a saved key; nothing is written). 400 on
a missing field or a \`credentialId\` that is no longer saved, 404 on an
unregistered \`projectPath\`.

### DELETE /api/agent/projects/sources?project=<path>&id=<sourceId>

Remove a source. Its key goes from the keyring too, unless another source still
uses it. Returns \`{ "ok": true }\`; 404 on an unregistered project.

## Dev servers

The dev servers a project configures in its dev config, run per session
in that session's own worktree. deck resolves the worktree from the stored
session; no request names a path.

### GET /api/agent/servers

Every session's server states from the monitor's last poll (no fresh probing):
\`{ "<sessionId>": ["running", "stopped", ...] }\`. A state is one of stopped |
setup | starting | running | stalled | errored | dead. Sessions without
configured servers are absent.

### GET /api/agent/sessions/{id}/servers

\`{ "servers": [{ "name", "state", "tmuxName", "ports": [{ "port", "label"?,
"primary"?, "listening" }], "previewUrl"?, "setup": [{ "label", "state":
"pending"|"running"|"ok"|"failed", "exitCode"?, "output"? }], "error"?,
"warning"? }] }\`, probed live. 404 for an unknown session.

### POST /api/agent/sessions/{id}/servers/{name}

\`{ "action": "start" | "stop" | "restart" | "resetup" }\`, or
\`{ "action": "step", "step": <index>, "label"?: "<step label>" }\` to re-run one
setup step (\`label\`, when sent, must still match the step at that index, which
catches a stale step list). Returns the server's runtime as in the list above.
400 for an unknown action, a bad step, an unknown server, or a bring-up already
in flight, with the reason in \`message\`.

### GET /api/agent/sessions/{id}/servers/{name}/logs?h=<tag>

A snapshot of the server's terminal pane: \`{ "text", "cleared"?, "dead"?, "h" }\`,
or \`{ "text": "(not running)", "dead": true }\` when it has no pane. Send the
last \`h\` back to get \`{ "unchanged": true, "h" }\` when nothing changed, so a
poller can skip re-rendering. 404 for an unknown session or server.

## Voice

Voice mode reads replies aloud and takes push-to-talk input through a local
speech server, and the operator is a hands-free assistant over all sessions.
Both are off until configured in deck's settings.

### GET /api/agent/speech

\`{ "tts": bool, "stt": bool, "stream": bool, "voice": "<name>"|null, "voices": [...], "config":
{ "ttsUrl"?, "sttUrl"?, "streamUrl"?, "voice"? } }\`: which halves are configured and
answering. Hide voice features when both are false. \`stream\` says a streaming
speech-to-text server is up, so takes can use the stream routes below.

### POST /api/agent/speech/segments

\`{ "text": "<markdown reply>", "readOut"?: "brief" | "summary" }\` → \`{ "segments": [{ "id", "text" }] }\`,
the sentences voice mode plays, with code blocks and tables replaced by a short
spoken marker. \`readOut: "brief"\` (or the older \`brief: true\`) reads only a
long reply's opening (up to its first heading, list, table or code block, or
about 300 characters) and ends with "The rest is on screen."
\`readOut: "summary"\` reads a long reply as a two or three sentence summary from
the operator's model, cached per reply; with no operator model, or when it fails
or takes over 4 seconds, it reads the brief opening instead. Audio is made when a segment is fetched, so play the first while
fetching the rest. 400 when no text-to-speech server is configured.

### GET /api/agent/speech/audio/{id}

One segment's audio as \`audio/wav\`, synthesised on first fetch. The id is a
content hash, so the bytes never change: cache it. 404 for an unknown id, 502
when synthesis fails.

### POST /api/agent/speech/transcribe

The recording as the raw body with its \`audio/*\` (or \`video/*\`,
\`application/octet-stream\`) content-type, up to 25 MB →
\`{ "text", "seconds" }\`. 400 when no speech-to-text server is configured or the
body is empty, 413 when too large, 502 when transcription fails.

### POST /api/agent/speech/stream

Open a streaming transcription for one take → \`{ "id" }\`. 400 when no
streaming server is configured, 502 when it can't be reached. A stream with no
chunk for 15 s is closed.

### POST /api/agent/speech/stream/{id}

The next stretch of the take as the raw body: 16 kHz 16-bit little-endian mono
PCM, \`content-type: audio/pcm\`. Send chunks in order, one request at a time →
\`{ "text" }\`, the live transcript so far. 404 for an unknown or expired
stream, 502 when the stream failed (upload the take to /transcribe instead).

### POST /api/agent/speech/stream/{id}/end

Any remaining PCM (may be empty), then the final transcript →
\`{ "text", "seconds" }\`, as /transcribe returns. Ends the stream.

### GET /api/agent/operator

\`{ "configured": bool, "model": "<id>"|null, "provider": "anthropic"|"openai", "listening": bool }\`.
\`listening\` is true while some client holds the events stream open.

### POST /api/agent/operator

\`{ "text": "<utterance>", "source"?: "voice" | "<label>" }\`, one user turn →
\`{ "text": "<what the operator said>", "actions": [{ "tool", "args",
"result" }] }\`. The operator can read sessions and act on them (send, answer,
start), so this drives deck the way the user's voice would.

### GET /api/agent/operator/events

Server-sent events: \`ready\` \`{ "at" }\` on open, then \`announcement\`
\`{ "text", "sessionId", "kind": "ask"|"turn"|"status", "at" }\` whenever the
operator speaks unprompted. Holding the stream open turns those announcements
on; they stop when the last listener leaves.

### GET /api/agent/operator/history?limit=<n>

\`{ "turns": [{ "role": "user"|"assistant", "content", "at", "source"? }] }\`,
oldest first; \`limit\` defaults to 50, clamped to 1..200.

### POST /api/agent/operator/reset

Start a new conversation. The old log is archived, not deleted:
\`{ "ok": true, "archived": "<archive path>"|null }\` (null when there was
nothing to archive).

## Reviews

### GET /api/agent/reviews

The morabot PR reviewer's state from the monitor's last poll: \`{ "status":
"ok"|"offline"|"unconfigured", "updatedAt"?, "inFlight": { "repo", "pr",
"headSha", "phase", "startedAt" }|null, "recent": [{ "repo", "pr", "headSha",
"decision", "reviewId", "url", "reviewedAt" }], "recentErrors": [{ "repo",
"pr", "headSha", "phase", "message", "url", "failedAt" }] }\`. \`unconfigured\`
means no reviewer is set up on this machine.

## Settings

App-wide preferences (\`~/.deck/settings.json\`). Gate on the \`settings\`
capability. Deck-spawned agents may read and change these too.

### GET /api/agent/settings

\`\`\`json
{ "speech": { "ttsUrl": "http://127.0.0.1:8000", "sttUrl": "...", "streamUrl": "ws://...", "voice": "..." },
  "operator": { "url": "...", "model": "...", "provider": "openai", "apiKeyFile": "...", "hasApiKey": true },
  "modelProfiles": [{ "id": "local", "label": "Local", "model": "...", "envKeys": ["ANTHROPIC_BASE_URL"] }],
  "lastModels": { "claude": { "model": "opus" } }, "lastEffort": "high",
  "zedSshTarget": "user@host", "autoCompact": { "enabled": true, "percent": 80 } }
\`\`\`

Secrets never leave the server: the operator key reads only as \`hasApiKey\`,
and a model profile's env only as its variable names (\`envKeys\`). Each block
is absent when unset.

### PATCH /api/agent/settings

\`{ "speech"?, "operator"?, "autoCompact"?, "zedSshTarget"? }\`: send only what
you change; the server merges it into the file as it is now. Within a block an
omitted field keeps its value (a PATCH without \`apiKey\` keeps the stored key),
a field set to \`null\` or \`""\` clears it, and a whole block set to \`null\`
clears the block. Fields: \`speech { ttsUrl, sttUrl, streamUrl, voice }\`,
\`operator { url, model, provider: "openai" | "anthropic", apiKey, apiKeyFile }\`
(\`apiKey\` is write-only), \`autoCompact { enabled: boolean, percent: number }\`
(\`percent\` is clamped to 50..95), \`zedSshTarget: "user@host[:port]" | null\`.
An unknown key or a wrongly typed field is a 400 and nothing is written.
\`operator.apiKeyFile\` must name a file inside \`~/.secrets/\` (after \`~\`
expansion and following symlinks); anything else is a 400, and the operator
refuses to read a stored key file outside it. Changing \`operator.url\` to a
different origin (scheme, host and port) drops the stored \`apiKey\` and
\`apiKeyFile\` unless the same PATCH sets them, so a key can't be redirected
to another host. Returns the redacted settings, as GET.

### POST /api/agent/settings/speech/detect

Probe for a local speech server on this machine:
\`{ "found": true, "url", "voices": [...], "voice", "stt": true }\` or
\`{ "found": false }\`. Nothing is saved; PATCH \`speech\` with what you want.

### GET /api/agent/settings/skill

The shipped deck skill's install state per harness:
\`[{ "kind": "claude", "available": true, "supported": true, "installed": true,
"installedVersion": "...", "shippedVersion": "...", "upToDate": true }]\`.

### POST /api/agent/settings/skill

\`{ "kind": "claude" }\`: install or update the deck skill for that harness.
Returns its row as above; 400 for an unknown or unsupported kind.

## Pairing

A new device asks for access through the public pairing flow and shows a
six-digit code; a signed-in client approves it. Gate on the \`pairing\`
capability, and follow the \`pairing\` event (see the event log) instead of
polling.

### GET /api/agent/pairing

Live requests: \`{ "pending": [{ "id": "...", "code": "123456" }] }\`. Check
the code against the one the new device shows before approving.

### POST /api/agent/pairing/{id}

\`{ "approve": true }\` (or \`false\` to deny). Returns \`{ "ok": true }\`;
\`ok\` is false when the request expired or was already decided.

## Push notifications

Native iOS, watchOS and macOS clients register a device token to receive the same nudges
the installed PWA gets over web push (question asked, turn finished, session
crashed/exited, PR updates). Disabled server-side until an APNs key is
configured; registering is harmless either way.

### POST /api/push/apns/register

\`{ "token": "...", "platform": "ios" | "watchos" | "macos", "env": "development" | "production" }\`,
upsert this device (\`token\` is the hex APNs device token). Returns
\`{ "ok": true }\`. \`macos\` is accepted when \`GET /api/agent\` lists the
\`apns-macos\` capability; the Mac app shares the iOS bundle id, so it is sent
on the same topic.

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
- \`awaiting-input\`: { awaitingInput, source: mcp, askId?, questions? }
- \`turn-finished\` — { subtype, cost } (subtype "success" = clean turn end)
- \`pr\` — { pr } (captured PR seen or its GitHub state changed)
- \`session-created\` — { session: <digest> }
- \`session-renamed\` — { title, id } (\`id\` is where the session moved to, which
	differs from the event's \`sessionId\` only for a renamed tmux terminal)
- \`session-hidden\` — { hidden, project?, projectHidden? } (\`hidden\` is the
	session's effective state, so one hidden on its own stays hidden when its
	project comes back. A project's hide sends one event per session it owns,
	naming the \`project\` and its own \`projectHidden\`, which cannot be read back
	off the sessions for that same reason)
- \`session-unread\` — { unread } (the session notified, or was read)
- \`session-deleted\` — {}
- \`watches\`: { watches } (the session's active watches changed; the full new
	list, empty when none are left)
- \`run-updated\`: { runId, status, phase, updatedAt } (a workflow run changed;
	fetch \`GET /api/agent/runs/{id}\` for its digest;
	\`sessionId\` carries the run id)
- \`run-deleted\`: { runId } (a run was removed; drop it from your list)
- \`pairing\`: { pairingId, code?, state: pending|approved|denied } (a device asked
	for access, or a request was decided; \`sessionId\` carries the pairing id)

Apply deltas idempotently: after a gap re-snapshot (or bootstrap) an overlapping
event may repeat state the snapshot already reflects.

## Notes

- Sessions are the unit of work; there is no separate job queue.
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
