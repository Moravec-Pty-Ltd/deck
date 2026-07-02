#!/usr/bin/env bash
# deck-notify.sh - harness stop-hook helper. On turn-finish it sends an ntfy
# push whose click-through opens the deck session that launched the agent.
#
# deck stamps DECK_SESSION_ID into every agent it spawns (claude / pi / codex),
# and passes its own environment through, so anything you export where you start
# deck reaches this script. It builds <DECK_BASE_URL>/s/<id> and hands ntfy a
# Click header for the deep-link. Wire it up per harness in docs/hooks.md.
#
# Everything comes from the environment, so no secret lives in the repo:
#   DECK_SESSION_ID  set by deck for agents it launched (unset otherwise)
#   DECK_BASE_URL    your deck origin, e.g. https://your-deck-host:4818
#   NTFY_TOPIC       ntfy topic to publish to (or set NTFY_URL for a full URL)
#   NTFY_TOKEN       optional bearer token for a protected topic
#
# Harnesses hand stop hooks extra data (claude on stdin, codex as a JSON
# argument). This script ignores both and reads only the environment.

set -eu

# No session id means deck did not launch this agent. Do nothing so the harness
# behaves exactly as it would without the hook.
[ -n "${DECK_SESSION_ID:-}" ] || exit 0

base_url="${DECK_BASE_URL:-}"
ntfy_url="${NTFY_URL:-${NTFY_TOPIC:+https://ntfy.sh/$NTFY_TOPIC}}"

# Missing config is a setup problem, not a reason to fail the turn. Warn, exit 0.
if [ -z "$base_url" ] || [ -z "$ntfy_url" ]; then
	echo "deck-notify: set DECK_BASE_URL and NTFY_TOPIC (or NTFY_URL) to enable pushes" >&2
	exit 0
fi

session_url="$base_url/s/$DECK_SESSION_ID"

set -- \
	-fsS -m 10 \
	-H "Title: deck session ready" \
	-H "Click: $session_url" \
	-H "Tags: bell" \
	-d "A turn finished. Open the session in deck."
if [ -n "${NTFY_TOKEN:-}" ]; then
	set -- "$@" -H "Authorization: Bearer $NTFY_TOKEN"
fi

curl "$@" "$ntfy_url" >/dev/null || echo "deck-notify: ntfy push failed" >&2
