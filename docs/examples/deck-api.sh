#!/bin/sh
# Minimal client for deck's agent API, for harnesses without a native skill
# (the claude skill ships in .claude/skills/deck). Full contract: /llms.txt.
#
#   deck-api.sh sessions                     # digest of every session
#   deck-api.sh session <id>                 # one session's digest
#   deck-api.sh work <cwd> <prompt>          # add work (session in cwd)
#   deck-api.sh review <cwd> <owner/repo> <n> [prompt]   # start a PR review
#   deck-api.sh message <id> <text>          # steer a session
#   deck-api.sh stop <id>                    # interrupt the turn
#   deck-api.sh asks                         # pending questions
#   deck-api.sh answer <id> <text> [askId]   # answer one
#   deck-api.sh events                       # follow the global SSE feed
#   deck-api.sh delete <id>                  # remove (keeps worktree/branch)
#
# Uses $DECK_BASE_URL / $DECK_TOKEN (stamped into deck-spawned agents), falling
# back to the local defaults.

set -eu

BASE="${DECK_BASE_URL:-http://localhost:4818}"
TOKEN="${DECK_TOKEN:-$(cat "$HOME/.deck/token" 2>/dev/null || true)}"
AUTH="Authorization: Bearer $TOKEN"
JSON='content-type: application/json'

# jq builds every body so arbitrary prompt text can't break the JSON.
cmd="${1:?usage: deck-api.sh <command> [args]}"
shift
case "$cmd" in
	sessions) curl -sf -H "$AUTH" "$BASE/api/agent/sessions" ;;
	session) curl -sf -H "$AUTH" "$BASE/api/agent/sessions/${1:?id}" ;;
	work)
		body=$(jq -n --arg cwd "${1:?cwd}" --arg prompt "${2:?prompt}" \
			'{mode:"work", cwd:$cwd, prompt:$prompt}')
		curl -sf -X POST -H "$AUTH" -H "$JSON" -d "$body" "$BASE/api/agent/sessions"
		;;
	review)
		body=$(jq -n --arg cwd "${1:?cwd}" --arg repo "${2:?owner/repo}" \
			--argjson n "${3:?pr number}" --arg prompt "${4:-}" \
			'{mode:"review", cwd:$cwd, pr:{repo:$repo, number:$n}} + (if $prompt != "" then {prompt:$prompt} else {} end)')
		curl -sf -X POST -H "$AUTH" -H "$JSON" -d "$body" "$BASE/api/agent/sessions"
		;;
	message)
		body=$(jq -n --arg text "${2:?text}" '{text:$text}')
		curl -sf -X POST -H "$AUTH" -H "$JSON" -d "$body" "$BASE/api/agent/sessions/${1:?id}/message"
		;;
	stop) curl -sf -X POST -H "$AUTH" "$BASE/api/agent/sessions/${1:?id}/stop" ;;
	asks) curl -sf -H "$AUTH" "$BASE/api/agent/asks" ;;
	answer)
		body=$(jq -n --arg text "${2:?text}" --arg askId "${3:-}" \
			'{text:$text} + (if $askId != "" then {askId:$askId} else {} end)')
		curl -sf -X POST -H "$AUTH" -H "$JSON" -d "$body" "$BASE/api/agent/sessions/${1:?id}/answer"
		;;
	events) curl -sN -H "$AUTH" "$BASE/api/agent/events" ;;
	delete) curl -sf -X DELETE -H "$AUTH" "$BASE/api/agent/sessions/${1:?id}" ;;
	*) echo "unknown command: $cmd" >&2; exit 2 ;;
esac
