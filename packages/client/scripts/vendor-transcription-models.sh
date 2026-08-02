#!/bin/bash
#
# Fetch the speech model and ONNX runtime that on-device call transcription
# needs, into the directory the app serves them from.
#
# These are NOT in git, on purpose: whisper plus the runtime is ~120MB, this
# repository is public, and git history is permanent — a disproportionate,
# irreversible cost for a feature most people never turn on. The consequence is
# that a fresh clone, a rebuilt machine, or a new deployment target has NOTHING
# behind `/models/` and transcription fails at the moment someone presses the
# button. This script is how that is repaired, so run it as part of setting a
# machine up rather than discovering it later.
#
#   bash packages/client/scripts/vendor-transcription-models.sh
#
# Override the destination with SLOGA_MODELS_DIR (models.plugin.ts reads the
# same variable, so both must agree).
#
set -euo pipefail

ASSETS="${SLOGA_MODELS_DIR:-/home/mcp/frontend-assets/models}"
MODEL="whisper-tiny"
HF="https://huggingface.co/onnx-community/${MODEL}/resolve/main"

# q8 weights. Kept in step with `transcriptionEngine.ts` — it asks for
# `dtype: q8`, which resolves to the `_quantized` files below.
WEIGHTS=(
  "onnx/encoder_model_quantized.onnx"
  "onnx/decoder_model_merged_quantized.onnx"
)
# The tokeniser and its configs. transformers.js reads all of these.
CONFIGS=(
  config.json generation_config.json preprocessor_config.json
  tokenizer.json tokenizer_config.json special_tokens_map.json
  added_tokens.json merges.txt vocab.json normalizer.json
)

say() { printf '  %-52s %s\n' "$1" "$2"; }

echo "==> destination: $ASSETS"
mkdir -p "$ASSETS/$MODEL/onnx" "$ASSETS/ort"

echo "==> model files"
for f in "${CONFIGS[@]}" "${WEIGHTS[@]}"; do
  dest="$ASSETS/$MODEL/$f"
  if [ ! -s "$dest" ]; then
    curl -fsSL --retry 3 --max-time 900 -o "$dest" "$HF/$f"
  fi
  say "$f" "$(du -h "$dest" | cut -f1)"
done

# A failed fetch that lands an HTML error page is the nastiest outcome: the
# files exist, the sizes look plausible, and the model fails to parse at
# runtime with something unrelated-looking.
echo "==> sanity"
for f in "${WEIGHTS[@]}"; do
  head -c 4 "$ASSETS/$MODEL/$f" | grep -qi '<!DO\|<htm' &&
    { echo "ERROR: $f is an HTML error page, not a model"; exit 1; }
done
head -c 1 "$ASSETS/$MODEL/config.json" | grep -q '{' ||
  { echo "ERROR: config.json is not JSON"; exit 1; }
say "weights are binary, config is JSON" "ok"

# 🔴 The runtime MUST come from the exact onnxruntime-web that
# @huggingface/transformers resolves to. The pnpm store keeps old copies, so a
# bare `find` happily returns a different version — and a mismatched runtime
# fails at session creation with an error that points at the model instead.
echo "==> onnx runtime (version-matched)"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

# Follow the client's own symlink into the store, then read the manifest off
# disk. `require("@huggingface/transformers/package.json")` looks like the
# obvious way and does NOT work — the package's `exports` field does not
# publish ./package.json, so Node refuses. Resolving through the symlink also
# guarantees the version the CLIENT resolves, which matters because the store
# happily holds several at once.
TPKG="$(readlink -f "$ROOT/packages/client/node_modules/@huggingface/transformers" || true)"
[ -n "$TPKG" ] && [ -d "$TPKG" ] ||
  { echo "ERROR: @huggingface/transformers is not installed — run pnpm install"; exit 1; }

read -r TRANSFORMERS_VERSION ORT_VERSION <<<"$(node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync(process.argv[1] + "/package.json", "utf8"));
  const v = p.dependencies && p.dependencies["onnxruntime-web"];
  if (!v) { console.error("no onnxruntime-web dependency"); process.exit(1); }
  process.stdout.write(p.version + " " + v);
' "$TPKG")"
say "transformers" "$TRANSFORMERS_VERSION"
say "wants onnxruntime-web" "$ORT_VERSION"

DIST="$ROOT/node_modules/.pnpm/onnxruntime-web@$ORT_VERSION/node_modules/onnxruntime-web/dist"
[ -d "$DIST" ] || { echo "ERROR: no onnxruntime-web@$ORT_VERSION in the store — run pnpm install"; exit 1; }

# Only the runtime pairs are fetched at runtime via `wasmPaths`; the ort.*.mjs
# entry points are bundled by vite from node_modules and are not needed here.
rm -f "$ASSETS"/ort/*.wasm "$ASSETS"/ort/*.mjs
cp -f "$DIST"/ort-wasm*.wasm "$DIST"/ort-wasm*.mjs "$ASSETS/ort/"
for f in "$ASSETS"/ort/*; do say "$(basename "$f")" "$(du -h "$f" | cut -f1)"; done

echo "==> total: $(du -sh "$ASSETS" | cut -f1)"
echo "done."
