#!/usr/bin/env bash
# Bundle the static deploy. Output goes to ./deploy/, ready to push to a
# GitHub Pages branch (or any static host).
#
# Steps, in order:
#   1. Run data_prep/ scripts to (re)generate dist/{matrices.bin, index.json,
#      champions.json}. Strength curves are now computed live in wasm
#      (engine/src/curves.rs) so the precompute_curves.py step is opt-in
#      via INCLUDE_PRECOMPUTE_CURVES=1 (only needed if temporarily reviving
#      the legacy precompute path with ?live_mc=0).
#   2. Compile engine/ to wasm + run wasm-bindgen â†’ frontend/pkg/.
#   3. Copy dist/* into frontend/data/ so the static layout is self-contained.
#   4. Mirror frontend/ to deploy/ for the final upload.
#
# Re-run any time the source CSVs in _data/ or the engine/ Rust changes.

set -euo pipefail
cd "$(dirname "$0")"

PYTHON="${PYTHON:-python}"
CARGO="${CARGO:-cargo}"
WASM_BINDGEN="${WASM_BINDGEN:-wasm-bindgen}"

echo "==> 1. data_prep"
"$PYTHON" data_prep/pack_matrices.py
"$PYTHON" data_prep/pack_champions.py
if [[ "${INCLUDE_PRECOMPUTE_CURVES:-0}" == "1" ]]; then
  echo "    (running data_prep/precompute_curves.py â€” INCLUDE_PRECOMPUTE_CURVES=1)"
  "$PYTHON" data_prep/precompute_curves.py
fi

echo "==> 2. wasm build"
( cd engine && "$CARGO" build --release --target wasm32-unknown-unknown )
"$WASM_BINDGEN" \
  engine/target/wasm32-unknown-unknown/release/pool_designer_engine.wasm \
  --target web \
  --out-dir frontend/pkg \
  --no-typescript

echo "==> 3. stage data into frontend/data/"
mkdir -p frontend/data
cp dist/matrices.bin       frontend/data/
cp dist/index.json         frontend/data/
cp dist/champions.json     frontend/data/
# Strength curve JSONs are no longer staged â€” wasm engine produces them live.
# Only emit them when explicitly requested (legacy ?live_mc=0 path).
if [[ "${INCLUDE_PRECOMPUTE_CURVES:-0}" == "1" ]]; then
  shopt -s nullglob
  for f in dist/strength_curves_*.json; do
    cp "$f" frontend/data/
  done
  shopt -u nullglob
fi

echo "==> 4. mirror frontend/ -> deploy/"
# Build into a temp dir and atomically swap so a mid-build failure can't
# leave an empty deploy/ that GitHub Pages would happily publish.
DEPLOY_TMP="deploy.tmp.$$"
trap 'rm -rf "$DEPLOY_TMP"' EXIT
rm -rf "$DEPLOY_TMP"
mkdir -p "$DEPLOY_TMP"
cp -r frontend/. "$DEPLOY_TMP"/
rm -rf deploy
mv "$DEPLOY_TMP" deploy
trap - EXIT

echo
echo "Done. Upload contents of deploy/ to GitHub Pages or any static host."
echo "Sizes:"
du -sh deploy/ deploy/data deploy/pkg
