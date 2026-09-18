# Web and native parity audit

Scope: web/server and the separate native iOS/watchOS checkout. This audit
traced discovery, creation, prompt dispatch, messaging, session controls,
question answering, and transcript rendering. No live tracker credentials or
production sessions were used for validation.

## Root cause: issue context

Both creation routes already call `createSessionFromRequest` in
`src/lib/server/create-session.ts`. That pipeline fetches issue detail and
expands the raw first-prompt template before dispatch. A separate expansion
endpoint would duplicate behavior that is already on the server.

The actual contract was broken at both ends:

1. `issueDigest` dropped `sourceId` from agent issue discovery.
2. Native `DeckIssue` did not decode that field, and `createWorkSession` did
   not send it. Siri's `IssueEntity` also discarded it.
3. Creation used the missing identifier to read Linear/ClickUp credentials.
   Fetching failed silently, leaving rich issue placeholders empty.

GitHub uses `gh` authentication and is unaffected by this credential defect.
Native creation already submits raw templates; it does not expand them locally.
ClickUp comments have a separate shared limitation described below.

The patch preserves source identity through discovery, native DTOs, Siri,
creation, and stored session metadata. For older clients, the server resolves
an omitted identifier through the registered project: its sole matching source,
or an unambiguous issue-discovery match when multiple accounts exist. It does
not guess between accounts. Context assembly lives in `server/issues/prompt.ts`;
asset writes remain confined to registered projects and worktrees.

## Changes implemented

| Area | Finding | Change |
| --- | --- | --- |
| Multiple issues | Agent creation discarded `issues`; phone selected only one | Route preserves the array and its precedence over `issue`; phone supports up to ten issues in one session |
| Message behavior | Web and agent routes separately prepared messages | Both use `sendAgentMessage`, including validation, recency, metadata, expansion, and asynchronous error reporting |
| Quick-message context | Rich issue tokens were blank after creation | Opt-in expansion fetches context when the template requests rich issue tokens |
| Image messages | Native photo attachment enabled expansion of literal text | Ordinary messages preserve literal brackets with or without images; quick messages explicitly opt in |
| Unsupported images | Non-Claude runners silently ignored attachments | Shared message service returns a clear error before dispatch |
| Draft retention | Phone cleared text and photos before send succeeded | Clear only after acknowledgment; retain the draft on failure and disable duplicate sends |
| Review base | Native review omitted the PR base branch | Shared native client sends it, including Siri's preserved PR metadata |
| Cold-start defaults | Phone read base/effort before loading project details | Populate those values after loading the project record |
| Start retries | Issue-based keys could replay a different deliberate start for ten minutes | Phone/watch use a per-sheet operation key, retained for retries; independent starts and Siri invocations get new keys |
| Agent switching | Server supported handoffs; native client had no control | Phone can select an installed agent while idle, refreshes session state, and renders the handoff marker |
| Chat/Thread | Native displayed only the full transcript | Device-local mode selection; Chat collapses consecutive tool calls and intervening thinking, preserving prose and questions |
| Multi-question answers | Phone submitted an entire ask after selecting an answer to one question; selections shared one set | Collect selections/replies per question and submit all together; inbox quick-answer shortcuts apply only to single, single-select questions |
| Missing context was silent | `issues/detail.ts` dropped failed fetches, so an empty `[issue_body]` read like an empty issue | Each failed issue yields a reason (no credential, not found, request error); the create and message paths record one `deck.warning` on the transcript when the prompt reads rich tokens. Web and native render it as a warning row |
| Older native history | The phone kept only the recent snapshot and reset it on reconnect | The stream keeps the snapshot's `start`; the phone loads earlier slices from the transcript range endpoint on back-scroll (or a Load earlier button), holds the reader's place, and merges a reconnect's tail over already loaded pages. Row ids derive from absolute indexes |
| Watch answers | `AskDetailView` answered only the first question | The watch steps through every question with the shared `AskAnswerDraft`; a lone single-choice question still answers on one tap |
| Creation defaults | Native `StartDefaults.resolve` mirrored the web selection rules | `GET /api/agent/defaults?project=` publishes the resolved model/provider/effort/permission mode per kind, base branch, and prompt templates from one `start-defaults-core.ts` the web modal also uses. Phone, watch, and Siri read it; only the keyboardless fallback prompt stays native |
| ClickUp comments | `detail-core.ts` returned `comments: []` | The adapter fetches `/task/{id}/comment` alongside the task; a comment failure loses the comments only |
| Structured answers | Agent `/answer` resolved text only; the web route recorded picks by `toolUseId` | Both routes share `answer.ts`. `registerAsk` looks up the ask's tool-call id, lists it as `askId`, and the routes record `answers` against it (falling back to the pending id). Phone, watch, and inbox shortcuts send the same text and picks as the web card |
| Transcript rendering | Native rows lacked attachment thumbnails, turn footers, answered questions, and `message_start` resets | Attachments render through the authenticated image endpoint; `result` events print duration/turns/cost; ask calls render as question cards with recorded picks; `deck.agent` shows the handoff source; a new turn clears streamed text |
| Native workflows | `DeckClient.workflows` called an endpoint the server removed | Workflow models, picker, and `workflowId` plumbing are gone |
| Auto-scroll | Native followed output on every item change | Only offset changes update the near-bottom state, so content growth never moves a reader who scrolled up; the first load still lands at the bottom |
| Existing worktrees | Phone offered new branch or none | The start sheet lists a project's existing worktrees (starting there as the session's cwd) and picks the base branch from the repo's branches |
| Changes view | Web-only | The session menu opens a Changes sheet: per-file summary from the diff endpoint, then each file's patch parsed by `DiffPatch` |
| Dev servers | Web-only | A Dev servers sheet lists configured servers with state, ports, preview link, setup progress, start/stop/restart/re-run setup, and a polling log pane, on the existing session server routes |
| Automation config | Web-only | Settings lists projects; each opens the automation toggles and lane agents, saved through the projects route while preserving the project name |

The native client continues to use the browser send route for images and quick
messages, preserving compatibility with older servers. Those routes now share
the same business logic as the agent message route. The multi-issue, handoff,
defaults, structured-answer, diff, server, and automation features need a
server with the corresponding routes; on an older server the phone falls back
to CLI defaults and hides nothing it can't fetch.

## Existing native support confirmed

The phone already has live SSE transcripts, tool-result pairing, photo/paste
attachments, shared quick messages, dynamic model lists, model/effort switching,
PR review and merge, and bulk session deletion. These did not need to be rebuilt.
Watch and Siri share `DeckKit`, so source-identity and review-base fixes apply
there too. The watch remains a smaller interface with Claude-only quick starts.

## Remaining differences

| Priority | Finding | Note |
| --- | --- | --- |
| Low | The watch shows a session's last reply, not its transcript | Deliberate: the watch is a glanceable surface with quick starts and answers; the phone carries the full transcript |
| Low | Native has no project registration or issue-source setup | Both need local filesystem paths and API keys, which belong on the machine running deck. Configure them on the web; the phone reads the result |
| Low | Native shells are read-only | Shell (tmux) sessions appear in the list but have no terminal view; the agent API cannot drive them either |

Share business services, keep route adapters compatible, and expose explicit
capabilities/defaults where native UI needs them. Avoid adding a third set of
behavioral rules to the phone.

## Validation

Server regressions cover discovery source identity, legacy credential resolution,
worktree project matching, multiple/ambiguous accounts, GitHub authentication,
confinement, per-issue fetch reasons and the warning they produce, ClickUp
comment fetching, multi-issue creation, identical message behavior through both
routes, shared answer recording through both answer routes, the ask-id lookup,
and the start-defaults resolver and route. Native request tests cover raw
templates, source identity, multiple issues, retry headers, literal image
messages, quick-message expansion, review bases, agent switching, structured
answers, server defaults, existing-worktree starts, and automation saves.
Transcript tests cover grouping, handoff markers, stable ids across prepended
history, attachments, turn footers, warnings, answered questions, the answer
draft, and the diff parser.

Validation uses unit/request tests, an unsigned iOS simulator build (including
the embedded watch app), and the transcript UI test against a live deck server
(opens at the bottom, loads older history on back-scroll). Live tracker
integration and physical-device testing of the new sheets remain unperformed.
