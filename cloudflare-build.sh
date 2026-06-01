#!/usr/bin/env bash
# Cloudflare Pages build entrypoint.
#
# Pages' V2 build image (Ubuntu 22.04) ships with rustup/cargo. We only need
# to add the wasm32 target and fetch a pinned wasm-bindgen CLI that matches
# the `wasm-bindgen` crate version in engine/Cargo.toml (schemas must match
# exactly, see the comment in engine/Cargo.toml).
#
# Output: a populated frontend/ directory ready to serve as static assets.
# Set the Pages "Build output directory" to `frontend`.

set -euo pipefail
cd "$(dirname "$0")"

WASM_BINDGEN_VERSION="0.2.120"

echo "==> rust toolchain"
if ! command -v cargo >/dev/null 2>&1; then
  echo "    installing rustup (cargo not found in build image)"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal
  # shellcheck disable=SC1090
  source "$HOME/.cargo/env"
fi
rustup target add wasm32-unknown-unknown

echo "==> wasm-bindgen CLI v${WASM_BINDGEN_VERSION}"
WB_DIR=".wasm-bindgen-cli"
WB_BIN="$WB_DIR/wasm-bindgen"
if [[ ! -x "$WB_BIN" ]]; then
  mkdir -p "$WB_DIR"
  TARBALL="wasm-bindgen-${WASM_BINDGEN_VERSION}-x86_64-unknown-linux-musl.tar.gz"
  URL="https://github.com/rustwasm/wasm-bindgen/releases/download/${WASM_BINDGEN_VERSION}/${TARBALL}"
  curl -fSL "$URL" -o "$WB_DIR/$TARBALL"
  tar -xzf "$WB_DIR/$TARBALL" -C "$WB_DIR" --strip-components=1
  rm "$WB_DIR/$TARBALL"
fi
WASM_BINDGEN="$PWD/$WB_BIN"

echo "==> cargo build (wasm32, release)"
( cd engine && cargo build --release --target wasm32-unknown-unknown )

echo "==> wasm-bindgen"
"$WASM_BINDGEN" \
  engine/target/wasm32-unknown-unknown/release/pool_designer_engine.wasm \
  --target web \
  --out-dir frontend/pkg \
  --no-typescript

echo
echo "Done. frontend/ is ready to publish."
ls -la frontend/pkg
