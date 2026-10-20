#!/bin/sh
# Ship to TestFlight via fastlane. Loads secrets from the gitignored .env so
# nothing sensitive lives in the repo.
# Usage: ./ship.sh [ios|mac|all|bootstrap]  (default: ios)
set -e
cd "$(dirname "$0")"
if [ -f .env ]; then
	set -a
	. ./.env
	set +a
fi
: "${ASC_KEY_ID:?set ASC_KEY_ID in .env}"
: "${ASC_ISSUER_ID:?set ASC_ISSUER_ID in .env (App Store Connect -> Users and Access -> Integrations -> Keys)}"
: "${ASC_KEY_PATH:?set ASC_KEY_PATH in .env}"
: "${DEVELOPMENT_TEAM:?set DEVELOPMENT_TEAM in .env}"
case "${1:-ios}" in
ios) exec fastlane ios beta ;;
mac) exec fastlane mac beta ;;
# One after the other: each lane reads the latest build number of both
# platforms, so the Mac build lands one past the iOS one.
all) fastlane ios beta && exec fastlane mac beta ;;
bootstrap) exec fastlane ios bootstrap ;;
*)
	echo "usage: ./ship.sh [ios|mac|all|bootstrap]" >&2
	exit 64
	;;
esac
