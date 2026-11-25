#!/bin/sh
# Regenerates Deck.xcodeproj with local signing config from .env (gitignored).
set -e
cd "$(dirname "$0")"
if [ -f .env ]; then
	set -a
	. ./.env
	set +a
fi
if [ -z "$DEVELOPMENT_TEAM" ]; then
	echo "warning: DEVELOPMENT_TEAM not set (copy .env.example to .env); Xcode will ask for a team" >&2
fi
xcodegen generate
# The project starts from DeckKit's committed package versions, rather than
# whatever is newest on the day.
resolved=Deck.xcodeproj/project.xcworkspace/xcshareddata/swiftpm
mkdir -p "$resolved"
cp Packages/DeckKit/Package.resolved "$resolved/Package.resolved"
