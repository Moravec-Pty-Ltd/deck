#!/bin/sh
# Ship to TestFlight via fastlane. Loads secrets from the gitignored .env so
# nothing sensitive lives in the repo. Usage: ./ship.sh [lane]  (default: beta)
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
exec fastlane "${1:-beta}"
