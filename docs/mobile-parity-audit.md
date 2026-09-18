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

The native client continues to use the browser send route for images and quick
messages, preserving compatibility with older servers. Those routes now share
the same business logic as the agent message route. The new multi-issue and
handoff features require a server with the corresponding support.

## Existing native support confirmed

The phone already has live SSE transcripts, tool-result pairing, photo/paste
attachments, shared quick messages, dynamic model lists, model/effort switching,
PR review and merge, and bulk session deletion. These did not need to be rebuilt.
Watch and Siri share `DeckKit`, so source-identity and review-base fixes apply
there too. The watch remains a smaller interface with Claude-only quick starts.

## Remaining differences and recommended next work

| Priority | Finding | Evidence and next step |
| --- | --- | --- |
| High | Rich-context failures remain best effort and can be silent | `issues/detail.ts` returns empty results on fetch failure. Expose context readiness/warnings in session events so users can distinguish missing context from an empty issue |
| High | Older native transcript history is unavailable | `SessionStream.swift` discards snapshot pagination metadata; `SessionDetailViewModel` replaces history on reconnect. Preserve cursors and add back-scroll via the existing transcript range endpoint |
| High | Watch answers show only the first question | `Apps/DeckWatch/Views/AskDetailView.swift` uses `questions.first`. Port the complete-question flow with an appropriate watch layout |
| Medium | Defaults are still implemented in two places | Native `StartDefaults.resolve` mirrors web selection rules and adds watch/Siri fallback prompts. Publish creation defaults/capabilities from a shared server resolver, retaining explicit choices and intentional idle creation |
| Medium | ClickUp comments are never fetched | `issues/detail-core.ts` returns `comments: []`; the adapter only requests task detail. Add the separate comment request in the shared tracker adapter |
| Medium | Structured answer persistence differs | Web `/answer` can call `recordAnswer` with a tool-use ID; agent `/answer` only resolves text. Expose a stable question identifier and share recording/resolution behavior |
| Medium | Transcript rendering still differs | Native rows do not render attached image thumbnails and omit some result/runtime events; tool streaming only extracts text deltas. Define a normalized display contract or maintain fixtures for each supported runtime |
| Medium | Native workflows refer to an absent API | `DeckClient.workflows` calls `/api/agent/workflows`, which this server checkout does not implement; failures are swallowed. Remove obsolete UI/models or implement a real supported contract rather than silently offering nothing |
| Medium | Some web surfaces have no native equivalent | Development servers/logs, diff viewing, automation configuration, and existing-worktree selection remain web-only. Prioritize these separately from request consistency |
| Low | Transcript auto-scroll can disrupt reading | Native view scrolls whenever item count changes. Track whether the reader is near the bottom before following output |

There is no need to make every automation-oriented endpoint return the full web
state. Share business services, keep route adapters compatible, and expose
explicit capabilities/defaults where native UI needs them. Avoid adding a third
set of behavioral rules to the phone.

## Validation

Server regressions cover discovery source identity, legacy credential resolution,
worktree project matching, multiple/ambiguous accounts, GitHub authentication,
confinement, fetch failures, multi-issue creation, and identical message behavior
through both routes. Native request tests cover raw templates, source identity,
multiple issues, retry headers, literal image messages, quick-message expansion,
review bases, and agent switching. Transcript tests cover grouping and handoff
markers.

Validation uses unit/request tests and an unsigned iOS simulator build (including
the embedded watch app). Live tracker integration, interactive simulator flows,
physical-device testing, and TestFlight publication remain unperformed.
