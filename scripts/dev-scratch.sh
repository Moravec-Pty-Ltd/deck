#!/bin/bash
# A throwaway deck beside the real one, for trying a change without touching the
# server you actually use.
#
# Three things have to differ from the live instance, and forgetting any of them
# is what makes a mess:
#
#   --port      its own port, so it doesn't fight for 4818
#   DECK_DATA   its own data dir, so it can't write your sessions.json
#               (the instance lock refuses to share one, so this is enforced)
#   DECK_TOKEN  a known token, so you can curl it without reading the real one
#
# Usage:  pnpm dev:scratch [port] [data-dir]
# Then:   open http://localhost:<port>/?token=scratch
#
# The data dir is wiped on each start: it is scratch, not a second home. Point
# it somewhere under /tmp and register whatever projects the test needs by
# writing projects.json before the server reads it.
set -euo pipefail

PORT="${1:-4819}"
DATA="${2:-/tmp/deck-scratch-$PORT}"

if [ "$PORT" = "4818" ]; then
	echo "4818 is the live instance's port. Pick another." >&2
	exit 1
fi

rm -rf "$DATA"
mkdir -p "$DATA"
# An empty store, so the scratch instance starts with nothing of yours in it.
# Live tmux terminals still show up: they belong to the machine, not to deck.
printf '[]' > "$DATA/sessions.json"
[ -f "$DATA/projects.json" ] || printf '[]' > "$DATA/projects.json"

echo "scratch deck on http://localhost:$PORT/?token=scratch  (data: $DATA)"
exec env DECK_DATA="$DATA" DECK_TOKEN=scratch npx vite dev --port "$PORT" --strictPort
