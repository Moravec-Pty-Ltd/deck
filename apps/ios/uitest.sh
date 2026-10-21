#!/bin/bash
# Runs the UI tests against a seeded throwaway deck, one simulator after another:
#   ./uitest.sh [device...] [-- xcodebuild args]
# A device is a simulator name or id (default: "iPhone 17 Pro" and
# "iPad Pro 11-inch (M5)"). Everything it starts or makes is removed on exit.
set -euo pipefail
cd "$(dirname "$0")"
IOS=$PWD
REPO=$(cd ../.. && pwd)
PORT=${DECK_UITEST_PORT:-4851}
SPEECH_PORT=$((PORT + 1))
SOCKET=deck-uitest

devices=()
extra=()
while [ $# -gt 0 ]; do
	if [ "$1" = -- ]; then
		shift
		extra=("$@")
		break
	fi
	devices+=("$1")
	shift
done
[ ${#devices[@]} -gt 0 ] || devices=("iPhone 17 Pro" "iPad Pro 11-inch (M5)")

ROOT=$(cd "$(mktemp -d /tmp/deck-uitest.XXXXXX)" && pwd -P)
# DECK_UITEST_DERIVED_DATA keeps the build between runs; otherwise it goes on exit.
DD=${DECK_UITEST_DERIVED_DATA:-$(mktemp -d /tmp/dd-uitest-XXXXXX)}
LOG=$(mktemp /tmp/deck-uitest-log.XXXXXX)
REAL_TMUX=$(command -v tmux)
TOKEN=$(openssl rand -hex 16)
pids=()
booted=()
deck=

tmux_() { DECK_E2E_REAL_TMUX=$REAL_TMUX DECK_E2E_TMUX_SOCKET=$SOCKET "$REPO/e2e/bin/tmux" "$@"; }

stop_deck() {
	[ -n "$deck" ] || return 0
	pkill -P "$deck" 2>/dev/null || true
	kill "$deck" 2>/dev/null || true
	wait "$deck" 2>/dev/null || true
	deck=
	tmux_ kill-server 2>/dev/null || true
}

cleanup() {
	stop_deck
	for pid in "${pids[@]+"${pids[@]}"}"; do kill "$pid" 2>/dev/null || true; done
	for id in "${booted[@]+"${booted[@]}"}"; do xcrun simctl shutdown "$id" 2>/dev/null || true; done
	rm -rf "$ROOT" "$LOG"
	[ -n "${DECK_UITEST_DERIVED_DATA:-}" ] || rm -rf "$DD"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# A name picks a simulator that is not already running, so one in use is left alone.
resolve() {
	if [[ $1 =~ ^[0-9A-F-]{36}$ ]]; then
		echo "$1"
		return
	fi
	# Newest runtime first: the app does not run on an older iOS than it targets.
	xcrun simctl list devices available -j | node -e '
		const byRuntime = JSON.parse(require("fs").readFileSync(0, "utf8")).devices;
		const version = (key) => (key.match(/iOS-([\d-]+)$/)?.[1] ?? "0").split("-").map(Number);
		const newer = (a, b) => { const x = version(a), y = version(b); for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0); return 0; };
		const all = Object.keys(byRuntime).filter((k) => k.includes(".iOS-")).sort(newer).flatMap((k) => byRuntime[k]);
		const named = all.filter((d) => d.name === process.argv[1]);
		const pick = named.find((d) => d.state === "Shutdown") ?? named[0];
		if (!pick) process.exit(1);
		console.log(pick.udid);
	' "$1" || { echo "no simulator named '$1'" >&2; exit 1; }
}

# A fresh fixture per device, since the tests add, hide and rename sessions.
start_deck() {
	rm -rf "${ROOT:?}"/*
	node "$IOS/uitest/seed.mjs" "$ROOT" "http://127.0.0.1:$SPEECH_PORT"
	HOME=$ROOT tmux_ new-session -d -s deck-dev -c "$ROOT/files-proj"
	# Built from scratch, so no DECK_* from this shell (a live server's URL, an
	# agent's session id) leaks into the server.
	(
		cd "$REPO"
		exec env -i PATH="$REPO/e2e/fake-harness:$REPO/e2e/bin:$PATH" HOME="$ROOT" TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-en_US.UTF-8}" \
			DECK_DATA="$ROOT/data" DECK_TOKEN="$TOKEN" DECK_SECRETS_FILE=1 \
			DECK_E2E_REAL_TMUX="$REAL_TMUX" DECK_E2E_TMUX_SOCKET=$SOCKET \
			node node_modules/vite/bin/vite.js dev --host 127.0.0.1 --port "$PORT" --strictPort
	) >"$LOG" 2>&1 &
	deck=$!
	for _ in $(seq 60); do
		curl -sf -o /dev/null "http://127.0.0.1:$PORT/login" && return
		sleep 1
	done
	cat "$LOG" >&2
	exit 1
}

[ -d "$REPO/node_modules" ] || (cd "$REPO" && pnpm install --frozen-lockfile)
# Regenerated every run, so a project from before a project.yml change is not built.
./generate.sh
build=(-project Deck.xcodeproj -scheme DeckApp -skipMacroValidation CODE_SIGNING_ALLOWED=NO -derivedDataPath "$DD")
xcodebuild "${build[@]}" -destination 'generic/platform=iOS Simulator' -quiet build-for-testing

node "$IOS/uitest/fake-speech.mjs" "$SPEECH_PORT" &
pids+=($!)
# The test runner sees these with the prefix stripped (DECK_UITEST_URL, ...).
export TEST_RUNNER_DECK_UITEST_URL="http://127.0.0.1:$PORT"
export TEST_RUNNER_DECK_UITEST_TOKEN=$TOKEN

status=0
for device in "${devices[@]}"; do
	id=$(resolve "$device")
	echo "== $device ($id)"
	if xcrun simctl list devices | grep -q "$id) (Shutdown)"; then
		booted+=("$id")
		xcrun simctl boot "$id"
	fi
	xcrun simctl bootstatus "$id" >/dev/null
	# Signed out, so the tests sign in to this deck rather than one from before.
	xcrun simctl uninstall "$id" tech.moravec.deck
	xcrun simctl keychain "$id" reset
	start_deck
	DECK_UITEST_TOKEN=$TOKEN node "$IOS/uitest/push-asks.mjs" "$TEST_RUNNER_DECK_UITEST_URL" "$id" &
	pusher=$!
	pids+=("$pusher")
	xcodebuild "${build[@]}" -destination "id=$id" test-without-building "${extra[@]+"${extra[@]}"}" || status=1
	kill "$pusher" 2>/dev/null || true
	stop_deck
done
exit $status
