# Champion Pool Designer — static / WASM build

Zero-backend port of `../deploy_pool_designer_fastapi_v2/`. All compute runs
client-side in WebAssembly; deploys to GitHub Pages (or any static host) and
scales infinitely on the CDN. Match data is sourced live from the
[riot-api-pull-pipeline](https://github.com/machineloling-hub/riot-api-pull-pipeline)
(separate repo; S3-hosted feathers) and refreshed by `data_prep/refresh.py`.

## Architecture

```
┌─────── riot-api-pull-pipeline (out-of-band) ───────┐
│  Riot API → match feathers →  S3://bucket/raw/...           │
└─────────────────────────────────┬──────────────────────┘
                              ↓ (data_prep/refresh.py)
            aggregate → EB → hier-Bayes → pack → upload
                              ↓
              S3://bucket/artifacts/{tier}/matrices.bin
                              ↓ (CDN)
┌─────────────── browser ───────────────┐
│  index.html / app.js / style.css      │  ~200 KB
│                ↓ calls                │
│  pkg/pool_designer_engine.{js,wasm}   │  ~480 KB total (28 + 455)
│                ↓ reads                │
│  data/matrices.bin       (~750 KB)    │
│  data/index.json         (~64 KB)     │
│  data/champions.json     (~310 KB)    │
│  data/strength_curves.json (~31 MB)   │  lazy-loaded on Pool Health visit
└───────────────────────────────────────┘
```

First-paint payload is ~1.5 MB (the strength curves are deferred). Total
budget across all features is ~33 MB uncompressed; gzip on the CDN cuts
that ~70% (~10 MB on the wire). The strength curve file is large because
we ship raw Monte Carlo samples (250 per scenario × 4 metrics × 4320 grid
points) rather than precomputed slot stats — the frontend computes the
slot stats client-side and derives `total_score` sample-by-sample under
the user's exact weight sliders, which is the only way to make
`total_score` σ work for arbitrary weights without re-running the MC at
request time.

## Layout

| Dir | Purpose |
|---|---|
| `frontend/` | HTML / JS / CSS — calls the wasm engine instead of any backend. Self-contained for static hosting. |
| `engine/` | Rust crate that compiles to `engine.wasm`. One module per ported endpoint family (`compute.rs`, `blind.rs`, `comparer.rs`, `bans.rs`, `health.rs`, `redundancy.rs`, `pool.rs`). |
| `data_prep/` | Python refresh pipeline — pulls match feathers from S3, aggregates, runs Bayesian shrinkage, packs binary artifacts, uploads. See [data_prep/README.md](data_prep/README.md). |
| `_reference_backend/` | Frozen copy of the FastAPI Python — source of truth for the math we ported. Don't edit. |
| `dist/` | Build output: `matrices.bin`, `index.json`, `champions.json` plus `refreshed/{tier}/` and `staged/` working dirs. |
| `deploy/` | Final upload bundle (mirror of `frontend/`) produced by `build.sh`. |

## Status

All FastAPI endpoints are ported and verified working zero-server:

| Endpoint | Module | Tab(s) it powers |
|---|---|---|
| `/api/meta`, `/api/champions/*` | apiFetch shim | Sidebar bootstrap |
| `/api/coverage` | `compute.rs` | Matchup Coverage, Synergy Coverage |
| `/api/blindability` | `blind.rs` | Blindability |
| `/api/comparer` | `comparer.rs` | Individual Champ Compare |
| `/api/bans` | `bans.rs` | Ban Recommender |
| `/api/health` | `health.rs` + `redundancy.rs` | Pool Health (full) |
| `/api/pool_summary` | `health.rs` | Pool Health strength panel |
| `/api/replacements` | `pool.rs` | Replacement Finder |
| `/api/build`, `/api/combo_count` | `pool.rs` | Pool Builder |
| `/api/pool_strength_curves` | static lookup | Strength panels (snap to grid) |

## Build

Prerequisites: Python 3.11+ (with `pandas`, `numpy`, `scipy`),
Rust stable + the `wasm32-unknown-unknown` target,
`wasm-bindgen-cli` 0.2.120 (`cargo install wasm-bindgen-cli --version 0.2.120`).

```bash
bash build.sh
# ...or with the slow strength-curve precompute skipped (keeps the existing
# strength_curves.json — fine for engine-only changes):
SKIP_CURVES=1 bash build.sh
```

Outputs `deploy/`. Upload it as-is to any static host.

## Deploy to GitHub Pages

Two paths.

### Manual one-shot

1. Create a new repo under your GitHub account, e.g. `pool-designer-static`.
2. Run `bash build.sh` locally. The deploy bundle lands in `deploy/`.
3. From inside `deploy/`: `git init && git add -A && git commit -m 'initial'
   && git branch -M main && git remote add origin <repo url> && git push -u origin main`.
4. GitHub repo → **Settings → Pages → Source: Deploy from branch → main → /(root)**.
5. Wait ~30s for the first build. Site is live at
   `https://<username>.github.io/pool-designer-static/`.

### Automated (recommended)

The `.github/workflows/deploy.yml` already wired here builds on every push to
`main` (and on manual dispatch).

1. Create a new repo and push the **whole project** (not just `frontend/`):
   ```
   git init
   git add -A
   git commit -m 'initial'
   git remote add origin <repo url>
   git push -u origin main
   ```
2. Repo → **Settings → Pages → Source: GitHub Actions**.
3. Push triggers the workflow, which runs `build.sh` on a runner and
   publishes `deploy/` to GitHub Pages.

### DNS cutover (when ready to retire Fly)

Site currently resolves at `https://pooldesigner.machineloling.com` via Fly.

1. In GitHub Pages settings, add `pooldesigner.machineloling.com` as the
   custom domain.
2. In your DNS provider, change the CNAME for `pooldesigner` from
   `<app>.fly.dev` to `<username>.github.io`.
3. Wait for DNS propagation (~5 min – 1 h).
4. Verify the new site loads + all tabs work.
5. Tear down the Fly app (`fly apps destroy champion-pool-designer`) — bill
   stops at the next billing cycle.

## What's intentionally not in this port

- **Server-side LRU cache** (`_CallCache` in the FastAPI version) — replaced
  by per-tab memoization in JS. Per-user cache hit rate is lower, but every
  call is now ~free CPU, so it doesn't matter.
- **`noise_z` / `eb` / `hier-tight` shrinkage methods** — only `hier_wide`
  (the production default) ships. Saves payload + complexity.
- **Total Score density curves** — the per-component σ curves precompute
  cleanly, but `total_score` depends on the user's weight sliders so its
  reference distribution can't be precomputed without the weight axes,
  which would 5–10× the strength_curves.json payload. The strength panel
  shows "no data" for that one cell; per-component σs are unaffected.
