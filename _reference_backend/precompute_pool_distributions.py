"""Precompute pool-score distributions for the Champion Pool Designer.

For each combination of (role, patch, pool_size, top_x) the script samples
random pools of champions at PR ≥ 0.5% and computes the pool's "top-X mean
z" score under four aggregated modes:

  - overall_matchup     mean across all 5 opponent roles
  - overall_synergy     mean across all 4 partner roles (≠ my_role)
  - in_lane_matchup     matchup vs your direct lane opponent(s)
                        TOP/MID/JG → vs same role; ADC/SUP → mean(ADC, SUP)
  - blindability        full-pool mean of aggregate blindability z
                        (pool-wide property, not top_x-dependent)

Per-(other_role) breakdowns are also emitted under data.matchup and
data.synergy for future drill-down panels.

Two patch buckets per patch + the "all data" bucket:
  - "<patch>" buckets use that patch's lolalytics PR table for
    eligibility, column filtering, AND PR-weighting (pr_weighted=True).
  - "all" bucket uses overall PR (from individual_wr.csv) and
    pr_weighted=False — i.e. the UI state when the box is unchecked.

Output: a JSON file the frontend loads at startup; histograms drive a
"where does your pool stand" panel that overlays the user's score as a
vertical line on the precomputed reference distribution.

Run:
    python -m precompute_pool_distributions \
        --output pool_distributions.json --n-samples 20000

Approximate runtime: a few minutes on a desktop CPU.
"""
from __future__ import annotations

import argparse
import dataclasses
import json
import math
import time
from itertools import combinations
from pathlib import Path
from typing import Optional

import numpy as np

from compute import _adjusted_matrix as adjusted_pair_matrix
from compute import _zscored_columns
from data import ROLES, DataStore, get_data_dir_from_env, load_all
from ports import blind_stats, blind_z_lookup

# ── config ────────────────────────────────────────────────────────────────
PR_FLOOR = 0.005                      # 0.5% — eligibility threshold
POOL_SIZES = list(range(1, 9))        # 1..8
TOP_XS    = list(range(1, 9))         # 1..8
PERCENTILE_GRID = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50,
                   55, 60, 65, 70, 75, 80, 85, 90, 95, 100]
N_HIST_BINS = 30                      # density bins for smoothed curve
DEFAULT_N_SAMPLES = 20_000
DEFAULT_SEED = 42

# Direct lane opponent(s) per role — drives the in_lane_matchup curve.
# TOP/MID/JUNGLE: 1v1 lane against the same role.
# ADC/SUP: bot-lane shares both positions, so the matchup includes both.
LANE_MATCH_OPPONENTS: dict[str, set[str]] = {
    "TOP": {"TOP"},
    "JUNGLE": {"JUNGLE"},
    "MID": {"MID"},
    "ADC": {"ADC", "SUP"},
    "SUP": {"ADC", "SUP"},
}


# ── stats helper ──────────────────────────────────────────────────────────
def _aggregate_stats(scores: np.ndarray) -> Optional[list[float]]:
    """[mean, sd, min, max, p0..p100, h0..h{N-1}] for a 1-D scores array.

    Histogram bins are evenly spaced over [min, max] and stored as
    normalized densities (sum = 1.0). None if no finite samples.
    """
    valid = scores[np.isfinite(scores)]
    if valid.size == 0:
        return None
    sd = float(valid.std(ddof=1)) if valid.size > 1 else 0.0
    mn = float(valid.min())
    mx = float(valid.max())
    if mx > mn and valid.size >= N_HIST_BINS:
        counts, _ = np.histogram(valid, bins=N_HIST_BINS, range=(mn, mx))
        total = counts.sum() or 1
        density = [round(c / total, 5) for c in counts.tolist()]
    else:
        density = [0.0] * N_HIST_BINS
        density[0] = 1.0
    return [
        float(valid.mean()), sd, mn, mx,
        *[float(np.percentile(valid, p)) for p in PERCENTILE_GRID],
        *density,
    ]


# ── pool sampling (vectorized) ────────────────────────────────────────────
def _sample_pool_indices(
    n: int, k: int, n_samples: int, rng: np.random.Generator,
) -> np.ndarray:
    """Return (K, k) array of pool indices into [0, n).

    Enumerates exhaustively if C(n, k) ≤ n_samples; else samples K random
    distinct subsets without replacement within each pool. Pools may repeat
    across rows when sampling — fine for distribution estimation.
    """
    if k > n:
        return np.empty((0, k), dtype=np.int32)
    n_combos = math.comb(n, k)
    if n_combos <= n_samples:
        return np.array(list(combinations(range(n), k)), dtype=np.int32)
    # Vectorized subset sample via partial argsort over uniform random matrix.
    rand = rng.random((n_samples, n))
    return np.argpartition(rand, k, axis=1)[:, :k].astype(np.int32)


# ── per-(mode, other_role) z-score subset ─────────────────────────────────
def _build_z_subset(
    store: DataStore, mode: str, my_role: str, other_role: str,
    eligible: list[str], pr_table: dict[str, dict[str, float]],
    shrink_alpha: float = 1.0,
) -> Optional[tuple[np.ndarray, np.ndarray, Optional[np.ndarray]]]:
    """(z_sub, col_pr, mirror_col_for_row) for this slice.

    z_sub shape: (n_eligible, n_cols_kept) — z-scores for eligible pool
      candidates as rows, in eligible-list order. Rows for champs not
      present in the pair data are NaN.
    col_pr shape: (n_cols_kept,) — column PR weights (for PR-weighting).
    mirror_col_for_row: only populated for mirror matchups (my_role ==
      other_role): array of shape (n_eligible,) giving the col index
      that matches each row's champ (-1 if not in cols). Used downstream
      to mask the self-cell when scoring sampled pools — pool members
      stay as comparators for everyone else but can't counter themselves.
    Returns None if the pair has no data or no columns survive the filter.
    """
    pairs = store.matchup if mode == "matchup" else store.synergy
    pair = pairs.get(my_role, {}).get(other_role)
    if pair is None:
        return None

    # Default to hier_wide via FIXED defaults (use_hier=False, use_hier_wide=True),
    # apply optional shrink_alpha blend with raw.
    mat = adjusted_pair_matrix(pair, 0.0, False, shrink_alpha=shrink_alpha)
    z_full = _zscored_columns(mat)

    row_idx = {ch: i for i, ch in enumerate(pair.rows)}
    col_idx = {ch: j for j, ch in enumerate(pair.cols)}

    pr_other = pr_table.get(other_role, {})
    keep_cols = [c for c in pair.cols if pr_other.get(c, 0.0) >= PR_FLOOR]
    if not keep_cols:
        return None

    keep_col_idxs = np.array([col_idx[c] for c in keep_cols])
    col_pr = np.array(
        [pr_other.get(c, 0.0) for c in keep_cols], dtype=np.float32
    )

    n_e = len(eligible)
    z_sub = np.full((n_e, len(keep_cols)), np.nan, dtype=np.float32)
    for i, ch in enumerate(eligible):
        if ch in row_idx:
            z_sub[i] = z_full[row_idx[ch], keep_col_idxs]

    mirror_col_for_row = None
    if mode == "matchup" and my_role == other_role:
        col_pos = {c: j for j, c in enumerate(keep_cols)}
        mirror_col_for_row = np.full(n_e, -1, dtype=np.int32)
        for i, ch in enumerate(eligible):
            j = col_pos.get(ch)
            if j is not None:
                mirror_col_for_row[i] = j
    return z_sub, col_pr, mirror_col_for_row


# ── per-pool top-X scoring (vectorized over K samples) ────────────────────
def _score_pools(
    z_sub: np.ndarray, col_pr: np.ndarray, pool_idxs: np.ndarray,
    pool_size: int, pr_weighted: bool,
    mirror_col_for_row: Optional[np.ndarray] = None,
) -> dict[int, np.ndarray]:
    """Compute top-X reduced-to-scalar scores for each top_x in [1..pool_size].

    Returns {top_x: scores_1d_K} — one scalar per sampled pool.

    `mirror_col_for_row` (mirror matchup only): per-eligible row, the col
    index that matches that row's champ (or -1). For each sampled pool we
    set those self-cells to -inf so they're excluded from top-X picks but
    other pool members still appear as comparator opponents.
    """
    pool_z = z_sub[pool_idxs].astype(np.float32, copy=True)  # (K, pool_size, n_cols)

    if mirror_col_for_row is not None:
        # self_col[k, i] = col j of pool_idxs[k, i]'s champ, or -1
        self_col = mirror_col_for_row[pool_idxs]    # (K, pool_size)
        valid = self_col >= 0
        if valid.any():
            ks, is_ = np.where(valid)
            js = self_col[ks, is_]
            pool_z[ks, is_, js] = -np.inf

    # NaN (missing data) and -inf (self-mask) both mean "not a valid pick".
    # Convert NaN → -inf so np.sort puts both at the bottom; then the
    # top-X slice naturally picks valid values first.
    score_z = np.where(np.isnan(pool_z), -np.inf, pool_z)
    sorted_z = np.sort(score_z, axis=1)        # ascending; -inf at start

    out: dict[int, np.ndarray] = {}
    for top_x in range(1, pool_size + 1):
        slc = sorted_z[:, -top_x:, :]          # (K, top_x, n_cols)
        slc_clean = np.where(np.isfinite(slc), slc, np.nan)
        per_col = np.nanmean(slc_clean, axis=1)   # (K, n_cols)
        if pr_weighted and col_pr.sum() > 0:
            w = col_pr / col_pr.sum()
            scores = np.nansum(per_col * w[None, :], axis=1)
        else:
            scores = np.nanmean(per_col, axis=1)
        out[top_x] = scores
    return out


# ── blindability scoring ──────────────────────────────────────────────────
def _build_blind_z_array(
    store: DataStore, my_role: str, eligible: list[str],
    pr_table: dict[str, dict[str, float]], pr_weighted: bool,
    shrink_alpha: float = 1.0,
    pr_floor: float = 0.01,
) -> np.ndarray:
    """Aggregate-blindability z per eligible champ. NaN where no data."""
    s = store
    if pr_table is not store.pr_by_role:
        s = dataclasses.replace(store, pr_by_role=pr_table)
    blind = blind_stats(
        s, my_role, pr_weighted=pr_weighted,
        shrink_alpha=shrink_alpha, pr_floor=pr_floor,
    )
    lookup = blind_z_lookup(blind, my_role)
    return np.array([lookup.get(ch, np.nan) for ch in eligible], dtype=np.float32)


def _score_pools_blind(
    agg_z: np.ndarray, pool_idxs: np.ndarray, pool_size: int,
) -> dict[int, np.ndarray]:
    """Full-pool mean of aggregate blind z. Replicated across top_x slots so
    the (pool_size, top_x) schema matches the matchup/synergy modes — but the
    score is independent of top_x by design (blindability is a pool-wide
    property, not a "best X picks" question)."""
    pool_z = agg_z[pool_idxs]                              # (K, pool_size)
    # NaN-safe mean (NaN rows possible if no pool member has blind data)
    with np.errstate(invalid="ignore"):
        scores = np.nanmean(pool_z, axis=1)                # (K,)
    return {top_x: scores for top_x in range(1, pool_size + 1)}


# ── main loop ─────────────────────────────────────────────────────────────
def precompute(args) -> dict:
    store = load_all(get_data_dir_from_env())

    # patch buckets: (label, pr_table, pr_weighted)
    patch_settings: list[tuple[str, dict[str, dict[str, float]], bool]] = []
    for p in store.patches:
        patch_settings.append((p, store.pr_by_patch[p], True))
    patch_settings.append(("all", store.pr_by_role, False))

    output: dict = {
        "version": 1,
        "config": {
            "n_samples": args.n_samples,
            "pr_floor": PR_FLOOR,
            "percentile_grid": PERCENTILE_GRID,
            "n_hist_bins": N_HIST_BINS,
            "pool_sizes": POOL_SIZES,
            "top_xs": TOP_XS,
            "schema": "[mean, sd, min, max, p0..p100 (21), h0..h{N-1} (30)]",
            "lane_match_opponents": {k: sorted(v) for k, v in LANE_MATCH_OPPONENTS.items()},
        },
        "data": {
            # 4 aggregate modes — keyed "my_role|patch|w/n" → {pK_tX: stats}
            "overall_matchup":  {},
            "overall_synergy":  {},
            "in_lane_matchup":  {},
            "blindability":     {},
        },
    }

    rng = np.random.default_rng(args.seed)
    t_start = time.time()

    for patch_label, pr_table, pr_weighted in patch_settings:
        prw_flag = "w" if pr_weighted else "n"
        for role in ROLES:
            eligible = sorted(
                ch for ch, pr in pr_table.get(role, {}).items() if pr >= PR_FLOOR
            )
            if len(eligible) < 2:
                continue

            # Pre-build z subsets once per role × patch (re-used across pool sizes).
            z_subs: dict[tuple[str, str], tuple[np.ndarray, np.ndarray, Optional[np.ndarray]]] = {}
            for mode in ("matchup", "synergy"):
                for other_role in ROLES:
                    if mode == "synergy" and other_role == role:
                        continue
                    res = _build_z_subset(store, mode, role, other_role, eligible, pr_table)
                    if res is not None:
                        z_subs[(mode, other_role)] = res

            agg_z = _build_blind_z_array(store, role, eligible, pr_table, pr_weighted)

            lane_opponents = LANE_MATCH_OPPONENTS.get(role, set())

            for pool_size in POOL_SIZES:
                if pool_size > len(eligible):
                    continue
                pool_idxs = _sample_pool_indices(
                    len(eligible), pool_size, args.n_samples, rng,
                )
                if pool_idxs.shape[0] == 0:
                    continue

                # Per-(other_role) raw scores, kept for both:
                #   1. emitting the per-other-role breakdowns
                #   2. averaging into the four aggregate modes below
                # Keyed by top_x → list[(K,) array per other_role].
                matchup_by_topx: dict[int, list[np.ndarray]] = {}
                synergy_by_topx: dict[int, list[np.ndarray]] = {}
                lane_by_topx: dict[int, list[np.ndarray]] = {}

                for (mode, other_role), (z_sub, col_pr, mirror_col_for_row) in z_subs.items():
                    scored = _score_pools(
                        z_sub, col_pr, pool_idxs, pool_size, pr_weighted,
                        mirror_col_for_row=mirror_col_for_row,
                    )
                    bucket = matchup_by_topx if mode == "matchup" else synergy_by_topx
                    for top_x, scores in scored.items():
                        bucket.setdefault(top_x, []).append(scores)
                        if mode == "matchup" and other_role in lane_opponents:
                            lane_by_topx.setdefault(top_x, []).append(scores)

                # Emit aggregates: per-pool mean across other_roles.
                agg_key = f"{role}|{patch_label}|{prw_flag}"
                for src, dest in (
                    (matchup_by_topx, "overall_matchup"),
                    (synergy_by_topx, "overall_synergy"),
                    (lane_by_topx,    "in_lane_matchup"),
                ):
                    slot = output["data"][dest].setdefault(agg_key, {})
                    for top_x, score_arrays in src.items():
                        stacked = np.vstack(score_arrays)            # (n_roles, K)
                        per_pool = np.nanmean(stacked, axis=0)       # (K,)
                        stats = _aggregate_stats(per_pool)
                        if stats is not None:
                            slot[f"p{pool_size}_t{top_x}"] = stats

                # Blindability (already an aggregate score)
                blind_scored = _score_pools_blind(agg_z, pool_idxs, pool_size)
                bslot = output["data"]["blindability"].setdefault(agg_key, {})
                for top_x, scores in blind_scored.items():
                    stats = _aggregate_stats(scores)
                    if stats is not None:
                        bslot[f"p{pool_size}_t{top_x}"] = stats

            n_z = len(z_subs)
            print(f"  [{patch_label} {prw_flag}] {role}: "
                  f"{len(eligible)} eligible, {n_z} z-subsets, done")

    print(f"\nTotal elapsed: {time.time() - t_start:.1f}s")
    return output


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--output", type=Path, default=Path("pool_distributions.json"))
    ap.add_argument("--n-samples", type=int, default=DEFAULT_N_SAMPLES)
    ap.add_argument("--seed", type=int, default=DEFAULT_SEED)
    args = ap.parse_args()

    output = precompute(args)
    args.output.write_text(json.dumps(output, separators=(",", ":")))
    n_bytes = args.output.stat().st_size
    print(f"Wrote {args.output} ({n_bytes/1024:.1f} KB)")


if __name__ == "__main__":
    main()
