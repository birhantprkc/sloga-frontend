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
# deploy swaps; putting 64MB inside it would bloat every dist swap and every
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

# The jsep pair ONLY. This used to copy both pairs on the belief that ORT picks
# its binary from what the webview reports it can do, so a shell on a different
# webview might ask for the other one. That belief is wrong, and it cost 11MB in
# every installer.
#
# The filename is a BUILD-TIME constant, not a runtime choice. onnxruntime-web
# ships several entry points; the plain `onnxruntime-web` specifier that
# @huggingface/transformers imports resolves to the JSEP (WebGPU-capable) build,
# and that build has the name compiled into it — in the shipped bundle it reads
# literally `let s="ort-wasm-simd-threaded.jsep.mjs"`, with no branch in front
# of it. Only `onnxruntime-web/wasm` would name the plain variant, and nothing
# imports that. So `ort-wasm-simd-threaded.{wasm,mjs}` cannot be requested by
# ANY webview, and shipping it is dead weight rather than insurance.
#
# Verified on the deployed bundle, both directions: the jsep name appears in
# `dist/assets/transformers.web-*.js`, and the plain name appears NOWHERE in
# `dist/` at all. Re-run that negative control after any transformers or
# onnxruntime-web version change — the entry-point mapping is theirs, not ours,
# and a 404 for a wasm binary is a confusing thing to debug inside a shell.
echo "==> onnx runtime -> $DEST/ort"
cp -f "$ASSETS/ort"/ort-wasm-simd-threaded.jsep.wasm \
      "$ASSETS/ort"/ort-wasm-simd-threaded.jsep.mjs "$DEST/ort/"

# Belt and braces: if a previous run of the old script staged the plain pair
# into this target, leave it behind rather than shipping a stale copy.
rm -f "$DEST/ort/ort-wasm-simd-threaded.wasm" "$DEST/ort/ort-wasm-simd-threaded.mjs"

echo "==> staged"
printf '  %-46s %s\n' "whisper-tiny" "$(du -sh "$DEST/whisper-tiny" | cut -f1)"
printf '  %-46s %s\n' "ort" "$(du -sh "$DEST/ort" | cut -f1)"
printf '  %-46s %s\n' "TOTAL ADDED" "$(du -sh "$DEST" | cut -f1)"

# The one file the app asks for by name first. If this is missing the model
# never even starts loading.
[ -s "$DEST/whisper-tiny/config.json" ] || { echo "ERROR: config.json missing"; exit 1; }

# And the runtime it asks for by name second. Now that only one variant is
# staged there is no other copy to fall back to, so assert it landed — a
# missing wasm here surfaces as a session-creation failure deep inside ORT,
# nowhere near the cause.
[ -s "$DEST/ort/ort-wasm-simd-threaded.jsep.wasm" ] ||
  { echo "ERROR: ort-wasm-simd-threaded.jsep.wasm missing"; exit 1; }
echo "done."
