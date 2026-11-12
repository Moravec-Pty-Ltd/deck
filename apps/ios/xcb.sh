#!/bin/bash
# xcodebuild with one DerivedData shared by every worktree. The default path is
# per-worktree, and those folders (about 3 GB each) outlive the worktree.
# xcodebuild refuses two builds in one DerivedData, so builds wait their turn;
# lockf frees the lock even if a build is killed.
set -euo pipefail
DD="$HOME/Library/Developer/Xcode/DerivedData/Deck-shared"
mkdir -p "$(dirname "$DD")"
exec lockf "$DD.lock" xcodebuild -derivedDataPath "$DD" "$@"
