#!/usr/bin/env bash
# Builds the deck Android thin client into build/deck.apk using the Android
# SDK command-line tools directly; no Gradle, no dependencies. Pass --install
# to also install onto a connected device via adb.
set -euo pipefail
cd "$(dirname "$0")"

VERSION_CODE=1
VERSION_NAME="0.1.0"
MIN_SDK=24
TARGET_SDK=34

SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
[ -d "$SDK/build-tools" ] || { echo "Android SDK not found at $SDK (set ANDROID_HOME)"; exit 1; }
BT="$SDK/build-tools/$(ls "$SDK/build-tools" | sort -V | tail -1)"
PLATFORM="$SDK/platforms/$(ls "$SDK/platforms" | sort -V | tail -1)"

# Prefer a JDK that still compiles to Java 8 bytecode (d8's sweet spot).
if [ -z "${JAVA_HOME:-}" ] && [ -x /usr/libexec/java_home ]; then
	for v in 17 21 11; do
		if JAVA_HOME="$(/usr/libexec/java_home -v "$v" 2>/dev/null)"; then break; fi
	done
	[ -n "${JAVA_HOME:-}" ] || JAVA_HOME="$(/usr/libexec/java_home)"
fi
export JAVA_HOME
export PATH="$JAVA_HOME/bin:$PATH"

OUT=build
rm -rf "$OUT"
mkdir -p "$OUT/obj" "$OUT/res"

# Launcher icons come from the web app's PWA icon, resized per density.
ICON=../static/icon-512.png
for entry in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
	dpi="${entry%%:*}" size="${entry##*:}"
	mkdir -p "$OUT/res/mipmap-$dpi"
	sips -z "$size" "$size" "$ICON" --out "$OUT/res/mipmap-$dpi/ic_launcher.png" >/dev/null
done

"$BT/aapt2" compile --dir "$OUT/res" -o "$OUT/res.zip"
"$BT/aapt2" link \
	-o "$OUT/deck-unsigned.apk" \
	-I "$PLATFORM/android.jar" \
	--manifest AndroidManifest.xml \
	--min-sdk-version "$MIN_SDK" \
	--target-sdk-version "$TARGET_SDK" \
	--version-code "$VERSION_CODE" \
	--version-name "$VERSION_NAME" \
	"$OUT/res.zip"

find src -name '*.java' > "$OUT/sources.txt"
# -classpath (not -bootclasspath): lambdas need the JDK's LambdaMetafactory
# at compile time; d8 desugars them for Android afterwards.
javac -nowarn -Xlint:-options -source 8 -target 8 -classpath "$PLATFORM/android.jar" \
	-d "$OUT/obj" @"$OUT/sources.txt"

find "$OUT/obj" -name '*.class' -print0 | xargs -0 "$BT/d8" --release \
	--lib "$PLATFORM/android.jar" --min-api "$MIN_SDK" --output "$OUT"
(cd "$OUT" && zip -qj deck-unsigned.apk classes.dex)

# A personal signing key, kept outside the repo so reinstalls keep working
# across worktrees and rebuilds.
KEYSTORE="$HOME/.deck/android.keystore"
if [ ! -f "$KEYSTORE" ]; then
	mkdir -p "$(dirname "$KEYSTORE")"
	keytool -genkeypair -keystore "$KEYSTORE" -alias deck -keyalg RSA -keysize 2048 \
		-validity 10000 -storepass deck-android -keypass deck-android -dname "CN=deck"
fi

"$BT/zipalign" -f 4 "$OUT/deck-unsigned.apk" "$OUT/deck-aligned.apk"
"$BT/apksigner" sign --ks "$KEYSTORE" --ks-pass pass:deck-android \
	--out "$OUT/deck.apk" "$OUT/deck-aligned.apk"
rm -f "$OUT/deck-unsigned.apk" "$OUT/deck-aligned.apk" "$OUT/deck.apk.idsig"

echo "Built $PWD/$OUT/deck.apk (versionName $VERSION_NAME, minSdk $MIN_SDK)"

if [ "${1:-}" = "--install" ]; then
	"$SDK/platform-tools/adb" install -r "$OUT/deck.apk"
fi
