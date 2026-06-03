# Champion Pool Designer

A zero-backend League of Legends draft-analytics app. All compute runs
client-side in WebAssembly, so the site is a bag of static files that can be
served from any CDN and scales for free. Match data is sourced from the
[riot-api-pull-pipeline](https://github.com/machineloling-hub/riot-api-pull-pipeline)
(a separate repo that lands raw match feathers in S3) and refreshed into
compact binary artifacts by the `data_prep/` pipeline.

The app answers the questions a player asks when building a champion pool:
matchup/synergy coverage, blindability, ban recommendations, pool health and
redundancy, replacement suggestions, and live strength curves.

## How it works

```
┌──────── riot-api-pull-pipeline (separate repo) ────────┐
│  Riot API → match feathers → s3://bucket/raw/...        │
└────────────────────────────┬───────────────────────────┘
                             │  data_prep/refresh.py
                             ▼  aggregate → empirical-Bayes → hier-Bayes → pack → upload
                  s3://bucket/artifacts/{tier}/matrices.bin
                             │  (CDN)
┌────────────────────────────▼───────────────────────────┐
│  browser                                                │
│    frontend/  (ES modules + CSS)                        │
│        │ calls                                          │
│    pkg/pool_designer_engine.{js,wasm}   (Rust → WASM)   │
│        │ reads                                          │
│    data/matrices.bin, index.json, champions.json        │
└─────────────────────────────────────────────────────────┘
```

First paint is roughly 1.5 MB; strength curves are computed live in the WASM
engine rather than shipped, which keeps the payload small. The CDN's gzip
trims the rest by about 70% on the wire.

## Project layout

| Path | Purpose |
| --- | --- |
| `frontend/` | Static site. ES modules under `src/` (`api.js`, `state.js`, `bus.js`, plus `views/` and `widgets/`), `index.html`, `style.css`. Calls the WASM engine directly — no server. |
| `engine/` | Rust crate compiled to `pool_designer_engine.wasm`. One module per endpoint family under `src/endpoints/` (`compute`, `blind`, `comparer`, `bans`, `health`, `redundancy`, `pool`), with shared helpers in `src/util/`. |
| `data_prep/` | Python refresh pipeline: pulls feathers from S3, aggregates, runs Bayesian shrinkage, packs binary artifacts, uploads. See [data_prep/README.md](data_prep/README.md). |
| `_reference_backend/` | The original FastAPI implementation. It is the port oracle the Rust engine's doc comments reference **and** a live dependency — `data_prep/pack_matrices.py` and `pack_champions.py` reuse its data loader (`data.py`). Treat as read-only. |
| `scripts/` | Frontend sanity checks: `check_imports.mjs` (every import resolves to a real export) and `check_undefs.mjs` (best-effort undefined-reference scan). |
| `build.sh`, `build_pages.sh`, `cloudflare-build.sh` | Build entry points — see below. |
| `dist/` | Generated build artifacts (`matrices.bin`, `index.json`, `champions.json` and working dirs). Not committed. |
| `deploy/` | Final static bundle produced by the build scripts. Not committed. |

## Prerequisites

- Python 3.11+ (`pip install -r data_prep/requirements.txt` for the data pipeline)
- Rust stable with the `wasm32-unknown-unknown` target
  (`rustup target add wasm32-unknown-unknown`)
- `wasm-bindgen-cli` 0.2.120 — it must match the `wasm-bindgen` crate version
  pinned in `engine/Cargo.toml`, so install it explicitly:
  `cargo install wasm-bindgen-cli --version 0.2.120 --locked`

## Build

There are three entry points for different situations:

| Script | What it does | When to use |
| --- | --- | --- |
| `build.sh` | Full build: runs the `data_prep/` packers to regenerate `dist/*`, compiles the engine to WASM, stages the data into `frontend/data/`, and mirrors `frontend/` to `deploy/`. | Local builds when the source data or the engine changed. |
| `build_pages.sh` | Engine + frontend only. Skips `data_prep/`; the deployed site fetches data at runtime from the public S3 bucket. | CI deploys (used by the GitHub Pages workflow) and engine/frontend-only changes. |
| `cloudflare-build.sh` | Cloudflare Pages entry point: installs the toolchain if missing, builds the engine, and emits `frontend/` as the publish directory. | Cloudflare Pages builds. |

```bash
# Full local build (regenerates data, engine, and the deploy bundle):
bash build.sh

# Engine + frontend only (data fetched at runtime):
bash build_pages.sh
```

Strength curves are produced live by the WASM engine, so the legacy
`data_prep/precompute_curves.py` step is opt-in via
`INCLUDE_PRECOMPUTE_CURVES=1 bash build.sh` and is only needed to revive the
old precompute path.

Both `build.sh` and `build_pages.sh` build into a temp directory and swap
`deploy/` atomically, so a failed build can never publish an empty site.

### Frontend checks

The frontend has no bundler, so two lightweight scripts guard against broken
imports. Run them after editing `frontend/src/`:

```bash
node scripts/check_imports.mjs
node scripts/check_undefs.mjs
```

Formatting is handled by Prettier (`frontend/.prettierrc.json`) for the
frontend and Ruff (`pyproject.toml`) for Python.

## Deploy

### GitHub Pages (automated)

`.github/workflows/deploy.yml` builds on every push to `main` (and on manual
dispatch): it installs the toolchain, runs `build_pages.sh`, and publishes
`deploy/` to GitHub Pages. To set it up, push the whole project to a repo and
set **Settings → Pages → Source: GitHub Actions**.

### GitHub Pages (manual)

```bash
bash build.sh
cd deploy
git init && git add -A && git commit -m 'initial'
git branch -M main
git remote add origin <repo-url>
git push -u origin main
```

Then set **Settings → Pages → Source: Deploy from branch → main → /(root)**.

### Cloudflare Pages

Point the project at `cloudflare-build.sh` and set the build output directory
to `frontend`.

## Data refresh

`.github/workflows/refresh.yml` keeps the artifacts current on a schedule
(a fast cadence every two hours, a full hierarchical-Bayes pass nightly) and
uploads versioned `matrices.bin` / `index.json` / `champions.json` to S3. It
needs the AWS credentials and bucket secrets documented at the top of that
workflow.

To run the pipeline by hand — from S3 or a local mirror, and to control which
stages run — see [data_prep/README.md](data_prep/README.md).

## Notes on the port

The Rust engine is a faithful port of `_reference_backend/`. A few backend
concerns are intentionally dropped because they don't apply client-side:

- **Server-side LRU caching** is replaced by per-tab memoization in JS.
- **Alternative shrinkage methods** (`noise_z`, `eb`, `hier_tight`) are not
  shipped; only the production default `hier_wide` is, which trims the payload.
- **Total-score density curves** can't be precomputed because they depend on
  the user's live weight sliders, so per-component σ curves ship instead.
