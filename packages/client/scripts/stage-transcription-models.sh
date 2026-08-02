#!/bin/bash
#
# Copy the transcription model + ONNX runtime into a SHELL's copy of the
# frontend, so the desktop and Android apps can transcribe offline.
#
#   bash packages/client/scripts/stage-transcription-models.sh <target-dir>
#
# The web does not need this: there, `/models/` is served from outside the
# repository by `models.plugin.ts` (dev and preview both). The shells have no
# such server — they load a bundled copy of `dist` off disk — so without this
# step `/models/` is empty in the app, the Transcribe button appears, and it
# fails the moment somebody presses it.
#
# 🔴 The target is the SHELL'S COPY, never `packages/client/dist` itself.
# That directory is what production serves (vite preview on :5174) and what the
# deploy swaps; putting 75MB inside it would bloat every dist swap and every
# rollback copy for no benefit, since the web already serves these from
# elsewhere. Desktop: stage into `acutest-desktop/frontend-dist`. Android:
# stage into `android/app/src/main/assets/public` AFTER `cap sync`.
#
set -euo pipefail

TARGET="${1:-}"
[ -n "$TARGET" ] || { echo "usage: $0 <target-dir>   (e.g. …/frontend-dist)"; exit 1; }
[ -d "$TARGET" ] || { echo "ERROR: $TARGET does not exist — build/sync first"; exit 1; }

ASSETS="${SLOGA_MODELS_DIR:-/home/mcp/frontend-assets/models}"
[ -d "$ASSETS/whisper-tiny" ] ||
  { echo "ERROR: no models at $ASSETS — run vendor-transcription-models.sh first"; exit 1; }

DEST="$TARGET/models"
mkdir -p "$DEST/whisper-tiny/onnx" "$DEST/ort"

echo "==> model -> $DEST/whisper-tiny"
cp -f "$ASSETS/whisper-tiny"/*.json "$ASSETS/whisper-tiny"/*.txt "$DEST/whisper-tiny/" 2>/dev/null || true
cp -f "$ASSETS/whisper-tiny/onnx"/*.onnx "$DEST/whisper-tiny/onnx/"

# Both runtime pairs, deliberately. ORT picks its binary from what the webview
# reports it can do, and the two shells are different webviews (WebView2 on
# Windows, Android System WebView) neither of which has been observed choosing.
# ~21MB of that is the jsep build, and a shell smoke test that shows which file
# is actually requested would let the other one be dropped — worth doing, but
# guessing wrong here means the button fails exactly where we are trying to fix
# it, and a 404 for a wasm binary is a confusing thing to debug in a shell.
echo "==> onnx runtime -> $DEST/ort"
cp -f "$ASSETS/ort"/ort-wasm-simd-threaded.wasm \
      "$ASSETS/ort"/ort-wasm-simd-threaded.mjs \
      "$ASSETS/ort"/ort-wasm-simd-threaded.jsep.wasm \
      "$ASSETS/ort"/ort-wasm-simd-threaded.jsep.mjs "$DEST/ort/"

echo "==> staged"
printf '  %-46s %s\n' "whisper-tiny" "$(du -sh "$DEST/whisper-tiny" | cut -f1)"
printf '  %-46s %s\n' "ort" "$(du -sh "$DEST/ort" | cut -f1)"
printf '  %-46s %s\n' "TOTAL ADDED" "$(du -sh "$DEST" | cut -f1)"

# The one file the app asks for by name first. If this is missing the model
# never even starts loading.
[ -s "$DEST/whisper-tiny/config.json" ] || { echo "ERROR: config.json missing"; exit 1; }
echo "done."
