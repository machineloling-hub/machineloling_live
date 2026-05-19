# Data prep — refresh pipeline

These scripts live between the **riot-api-pull-pipeline** (which deposits
raw match feathers in S3) and the static **frontend** (which loads
`matrices.bin` + JSON files). They turn raw match data into the binary
artifacts the WASM engine consumes.

## Output layout (`../dist/`)

```
dist/
├── matrices.bin        # Binary blob: float16 shrunk-hier-wide deltas + tau
├── index.json          # Champion lookup, role-pair byte offsets, dims
├── champions.json      # Per-tier champion list with PR / WR
├── refreshed/{tier}/   # Per-tier intermediate CSVs (one dir per refresh)
└── staged/             # Pooled staging dir read by pack_*.py
```

## Two paths

### A — Refresh from S3 (live data)

`refresh.py` is the orchestrator. It pulls match feathers, aggregates them
for one rank tier, runs empirical-Bayes + hierarchical-Bayes shrinkage,
packs the artifacts, and uploads them back to S3.

```bash
pip install -r requirements.txt

REFRESH_TIER=diamond \
REFRESH_PATCH_RANGE=26.01-26.05 \
REFRESH_QUEUE=ranked_solo \
REFRESH_REGIONS=NA1,KR,EUW1 \
S3_BUCKET=my-bucket \
S3_PREFIX_RAW=puller/ \
S3_PREFIX_OUT=artifacts/ \
python data_prep/refresh.py
```

For local dev (no S3), point at a local mirror of the puller's
`matchResults_v2/` tree:

```bash
LOCAL_RAW_DIR=./sample-data REFRESH_TIER=diamond \
REFRESH_PATCH_RANGE=26.01-26.05 \
python data_prep/refresh.py --skip upload
```

Stages can be skipped or run individually:

```bash
python data_prep/refresh.py --only aggregate,eb,hier,collect,pack
python data_prep/refresh.py --skip pull,aggregate    # rerun shrinkage only
```

### B — Pack pre-existing CSVs (legacy)

If you already have matchup/synergy CSVs + per-rank PR parquets in a
directory, point `POOL_DESIGNER_DATA_DIR` at it and run the packers
directly:

```bash
POOL_DESIGNER_DATA_DIR=./my-data python data_prep/pack_matrices.py
POOL_DESIGNER_DATA_DIR=./my-data python data_prep/pack_champions.py
```

## Modules

| File | Responsibility |
|---|---|
| `refresh_config.py` | Env-var driven config (S3, tier, patch range, MCMC params) |
| `s3_io.py` | boto3 wrapper: `pull_feathers()`, `upload_artifacts()` |
| `aggregate_matches.py` | Match feathers → raw matchup/synergy/PR counts CSVs |
| `shrinkage.py` | Empirical Bayes + bilateral hierarchical Bayes (numpyro) |
| `refresh.py` | End-to-end orchestrator |
| `pack_matrices.py` | CSVs → `matrices.bin` + `index.json` (unchanged from legacy) |
| `pack_champions.py` | PR parquets → `champions.json` (unchanged from legacy) |

## Schema produced by aggregator

For each rank tier, `aggregate_matches.aggregate_tier()` writes:

| File | Columns |
|---|---|
| `matchup_{ROLE_A}_vs_{ROLE_B}.csv` | `champion_{ra}, opponent_{rb}, games, wins, observed_wr, wr_champ, wr_opp, expected_wr, delta, se_pp` |
| `synergy_{ROLE_A}_{ROLE_B}.csv` (ra < rb only) | `champion_{ra}, champion_{rb}, games, wins, observed_wr, wr_{ra}, wr_{rb}, expected_wr, delta, se_pp` |
| `individual_wr.csv` | `champion, role, games, wins, win_rate` |
| `pr_table.parquet` | `champion_name, lane, games` (lolalytics-shaped) |

Then `shrinkage.add_eb_columns()` appends:

- `delta_pp_shrunk` — empirical Bayes (MLE prior)
- `delta_pp_shrunk_mom` — empirical Bayes (method of moments)

And `shrinkage.add_hier_columns()` appends:

- `delta_pp_shrunk_hier` — bilateral hier Bayes, tight prior `HN(0.3)`
- `delta_pp_shrunk_hier_wide` — bilateral hier Bayes, wide prior `HN(0.6)`

Plus per-pair sidecars (`tau_matchup_*.csv`, `tau_wide_matchup_*.csv`,
`tau_synergy_*.csv`, `tau_wide_synergy_*.csv`) with one row per
`(champion, role)` of posterior-mean τ.

## Tier handling

`refresh.py` runs ONE tier per invocation:

- Per-tier matchup CSVs are written to `dist/refreshed/{tier}/` and copied
  into `dist/staged/`, where they overwrite any prior tier's matrices.
- Per-tier PR parquets are renamed to `pr_table_{tier}.parquet` so all
  six tiers' PR tables coexist in `dist/staged/` and feed `champions.json`.
- `matrices.bin` therefore reflects the **most recently refreshed tier's**
  matchup/synergy data. To serve different matrix data per tier you'd
  upload each tier's artifacts to its own S3 prefix and teach the
  frontend to fetch the tier-specific URL — not covered here.

## Hierarchical Bayes model

Per `(role_a, role_b)` slice in `shrinkage._hier_fit()`:

```
δ_obs[k]   ~ N(true_δ[k], se[k]²)
true_δ[k]  ~ N(0, sqrt(τ_a[i_k]² + τ_b[j_k]²))
τ_a[i]     ~ HalfNormal(σ_τ_a)
τ_b[j]     ~ HalfNormal(σ_τ_b)        # same population if role_a == role_b
σ_τ_a/b    ~ HalfNormal(prior_scale)  # 0.3 tight, 0.6 wide
```

NUTS via numpyro, non-centered parameterization. Defaults: 1000 warmup +
1000 draws, 2 chains. Knobs: `REFRESH_HMC_WARMUP`, `REFRESH_HMC_DRAWS`,
`REFRESH_HMC_CHAINS`. Runtime is dominated by this stage — tens of
minutes per tier on CPU; install jaxlib with CUDA to cut ~10×.
