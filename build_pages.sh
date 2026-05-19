#!/usr/bin/env bash
# Pages-only build. Skips data_prep entirely — the deployed site fetches
# matrices/index/champions at runtime from the public S3 bucket configured
# in frontend/index.html (window.POOL_DESIGNER_DATA). Use this in CI when
# the only thing that changed is engine/ or frontend/.
#
# For a full local build that regenerates dist/* from S3 match feathers,
# use build.sh instead.

set -euo pipefail
cd "$(dirname "$0")"

CARGO="${CARGO:-cargo}"
WASM_BINDGEN="${WASM_BINDGEN:-wasm-bindgen}"

echo "==> 1. wasm build"
( cd engine && "$CARGO" build --release --target wasm32-unknown-unknown )
"$WASM_BINDGEN" \
  engine/target/wasm32-unknown-unknown/release/pool_designer_engine.wasm \
  --target web \
  --out-dir frontend/pkg \
  --no-typescript

echo "==> 2. mirror frontend/ -> deploy/ (no data/ staged; runtime fetch from S3)"
# Atomic swap so a mid-build failure can't publish an empty deploy/.
DEPLOY_TMP="deploy.tmp.$$"
trap 'rm -rf "$DEPLOY_TMP"' EXIT
rm -rf "$DEPLOY_TMP"
mkdir -p "$DEPLOY_TMP"
cp -r frontend/. "$DEPLOY_TMP"/
rm -rf deploy
mv "$DEPLOY_TMP" deploy
trap - EXIT

echo
echo "Done. deploy/ ready for GitHub Pages upload."
du -sh deploy/ deploy/pkg
