#!/bin/sh
# Minimal client for deck's agent API, for harnesses without a native skill
# (the claude skill ships in .claude/skills/deck). Full contract: /llms.txt.
#
#   deck-api.sh projects                     # registered projects (every valid cwd)
#   deck-api.sh kinds                        # installed agent CLIs + models
#   deck-api.sh issues <project>             # open issues for a project path
#   deck-api.sh prs <project>                # open PRs for a project path
#   deck-api.sh workflows <project>          # startable workflow ids
#   deck-api.sh sessions                     # digest of every session
#   deck-api.sh session <id>                 # one session's digest (+ lastResult)
#   deck-api.sh transcript <id>              # readable turn output
#   deck-api.sh work <cwd> <prompt>          # add work (session in cwd)
#   deck-api.sh review <cwd> <owner/repo> <n> [prompt]   # start a PR review
#   deck-api.sh message <id> <text>          # steer a session
#   deck-api.sh stop <id>                    # interrupt the turn
#   deck-api.sh workflow <id> <workflowId>   # start a workflow run on a session
#   deck-api.sh cancel-workflow <id>         # cancel/dismiss the run
#   deck-api.sh asks                         # pending questions
#   deck-api.sh answer <id> <text> [askId]   # answer one
#   deck-api.sh events [since]               # cursor read of the event log
#   deck-api.sh delete <id>                  # remove (keeps worktree/branch)
#
# Uses $DECK_BASE_URL / $DECK_TOKEN (stamped into deck-spawned agents), falling
# back to the local defaults.

set -eu

BASE="${DECK_BASE_URL:-http://localhost:4818}"
TOKEN="${DECK_TOKEN:-$(cat "$HOME/.deck/token" 2>/dev/null || true)}"
AUTH="Authorization: Bearer $TOKEN"
JSON='content-type: application/json'

# curl wrapper that surfaces the response body on a non-2xx status instead of
# swallowing it: -f would discard the { "message": ... } error body deck returns,
# which is exactly what a caller needs to see. Body goes to a temp file; -w prints
# just the status code, which we check and exit non-zero on >=400.
req() {
	tmp=$(mktemp)
	code=$(curl -sS -o "$tmp" -w '%{http_code}' "$@")
	cat "$tmp"
	rm -f "$tmp"
	[ "$code" -lt 400 ] || { printf 'HTTP %s\n' "$code" >&2; return 1; }
}

# jq builds every body so arbitrary prompt text can't break the JSON.
cmd="${1:?usage: deck-api.sh <command> [args]}"
shift
case "$cmd" in
	projects) req -H "$AUTH" "$BASE/api/agent/projects" ;;
	kinds) req -H "$AUTH" "$BASE/api/agent/kinds" ;;
	issues) req -H "$AUTH" "$BASE/api/agent/issues?project=${1:?project path}" ;;
	prs) req -H "$AUTH" "$BASE/api/agent/prs?project=${1:?project path}" ;;
	workflows) req -H "$AUTH" "$BASE/api/agent/workflows?project=${1:?project path}" ;;
	sessions) req -H "$AUTH" "$BASE/api/agent/sessions" ;;
	session) req -H "$AUTH" "$BASE/api/agent/sessions/${1:?id}" ;;
	transcript) req -H "$AUTH" "$BASE/api/agent/sessions/${1:?id}/transcript" ;;
	work)
		body=$(jq -n --arg cwd "${1:?cwd}" --arg prompt "${2:?prompt}" \
			'{mode:"work", cwd:$cwd, prompt:$prompt}')
		# Idempotency-Key makes a retried create safe (no duplicate session).
		req -X POST -H "$AUTH" -H "$JSON" -H "Idempotency-Key: $(date +%s)-$$" \
			-d "$body" "$BASE/api/agent/sessions"
		;;
	review)
		body=$(jq -n --arg cwd "${1:?cwd}" --arg repo "${2:?owner/repo}" \
			--argjson n "${3:?pr number}" --arg prompt "${4:-}" \
			'{mode:"review", cwd:$cwd, pr:{repo:$repo, number:$n}} + (if $prompt != "" then {prompt:$prompt} else {} end)')
		req -X POST -H "$AUTH" -H "$JSON" -d "$body" "$BASE/api/agent/sessions"
		;;
	message)
		body=$(jq -n --arg text "${2:?text}" '{text:$text}')
		req -X POST -H "$AUTH" -H "$JSON" -d "$body" "$BASE/api/agent/sessions/${1:?id}/message"
		;;
	stop) req -X POST -H "$AUTH" "$BASE/api/agent/sessions/${1:?id}/stop" ;;
	workflow)
		body=$(jq -n --arg wf "${2:?workflowId}" '{workflowId:$wf}')
		req -X POST -H "$AUTH" -H "$JSON" -d "$body" "$BASE/api/agent/sessions/${1:?id}/workflow"
		;;
	cancel-workflow)
		req -X POST -H "$AUTH" -H "$JSON" -d '{"action":"cancel"}' "$BASE/api/agent/sessions/${1:?id}/workflow"
		;;
	asks) req -H "$AUTH" "$BASE/api/agent/asks" ;;
	answer)
		body=$(jq -n --arg text "${2:?text}" --arg askId "${3:-}" \
			'{text:$text} + (if $askId != "" then {askId:$askId} else {} end)')
		req -X POST -H "$AUTH" -H "$JSON" -d "$body" "$BASE/api/agent/sessions/${1:?id}/answer"
		;;
	# Cursor read of the durable event log: no arg = bootstrap snapshot + seq;
	# with a seq = the events after it. Track the returned seq and pass it next
	# time (locally you can tail ~/.deck/events.jsonl instead).
	events)
		if [ "$#" -ge 1 ]; then req -H "$AUTH" "$BASE/api/agent/events?since=${1}"
		else req -H "$AUTH" "$BASE/api/agent/events"; fi
		;;
	delete) req -X DELETE -H "$AUTH" "$BASE/api/agent/sessions/${1:?id}" ;;
	*) echo "unknown command: $cmd" >&2; exit 2 ;;
esac
