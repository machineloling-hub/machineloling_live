"""Precompute the per-pool Monte Carlo samples for the strength-curve grid.

Outputs the *raw component arrays* (4 per scenario, one per metric) instead
of the precomputed slot stats. This lets the frontend:
  1. Compute each component's curve (mean / sd / percentiles / KDE-ish hist)
     client-side from its sample array — same numbers the live endpoint
     produces, just done in JS.
  2. Compute total_score sample-by-sample using the user's *exact* weight
     sliders, then derive its curve too. This is the only way to make
     total_score work without recompute on the server, since its
     distribution depends on weights.

Output JSON:
    {
      "config": {n_samples, grid, ...},
      "data": { role: { "pN_tX_pfFFFF_wW_aAAA": {
                   "in_lane_matchup":     [n_samples floats],
                   "out_of_lane_matchup": [n_samples floats],
                   "overall_synergy":     [n_samples floats],
                   "blindability":        [n_samples floats]
              } } }
    }

A missing key inside a scenario means that metric had no eligible data
(rare — happens for synergy at lane partner edge cases).
"""
from __future__ import annotations

import json
import sys
import time
from itertools import product
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "_reference_backend"))
import dataclasses  # noqa: E402

import numpy as np  # noqa: E402
import precompute_pool_distributions as pcp  # noqa: E402
from data import ROLES, load_all  # noqa: E402
from precompute_pool_distributions import (  # noqa: E402
    LANE_MATCH_OPPONENTS,
    _build_blind_z_array,
    _build_z_subset,
    _sample_pool_indices,
    _score_pools,
    _score_pools_blind,
)

DATA_DIR = ROOT / "_data"
DIST_DIR = ROOT / "dist"

# Grid covers all reasonable slider positions. top_x extends to 6 because
# at top_x=4..6 the per-component metric is fundamentally different from
# top_x=3 (averaging more rows changes the random-pool distribution
# substantially). pr_floor trimmed to 4 levels to keep grid * samples *
# metrics under ~30 MB JSON. shrink_alpha is locked to 0.8 in the frontend
# (no UI control exposes it), so we only precompute that single value —
# adding [0.0, 1.0] would 3× the grid for never-queried scenarios.
GRID = {
    "pool_size":    [3, 4, 5, 6, 7, 8],            # 6
    "top_x":        [1, 2, 3, 4, 5, 6],            # 6
    "pr_floor":     [0.005, 0.0075, 0.01, 0.02],   # 4
    "pr_weighted":  [False, True],                 # 2
    "shrink_alpha": [0.8],                         # 1 (locked in frontend)
}
# 5 roles × 6 × 6 × 4 × 2 × 1 = 1440 entries per rank (was 4320; 3x cut)
N_SAMPLES = 250   # joint samples per scenario; KDE-smoothed in frontend


def sample_components(
    store, my_role, patch, pool_size, top_x,
    pr_floor, pr_weighted, shrink_alpha, n_samples, seed=42,
):
    """Run the same Monte Carlo `compute_live_curves` does, but return
    the raw component arrays (no slot reduction). Returns dict
    {metric: ndarray of shape (n_samples,)} for the 4 component metrics."""
    pr_table = (store.pr_by_patch[patch]
                if patch and patch in store.pr_by_patch
                else store.pr_by_role)
    eligible = sorted(ch for ch, pr in pr_table.get(my_role, {}).items()
                      if pr >= pr_floor)
    if len(eligible) < pool_size:
        return {}

    orig_floor = pcp.PR_FLOOR
    pcp.PR_FLOOR = pr_floor
    try:
        z_subs = {}
        for mode in ("matchup", "synergy"):
            for opp_role in ROLES:
                if mode == "synergy" and opp_role == my_role:
                    continue
                res = _build_z_subset(
                    store, mode, my_role, opp_role, eligible, pr_table,
                    shrink_alpha=shrink_alpha,
                )
                if res is not None:
                    z_subs[(mode, opp_role)] = res
        s_for_blind = store
        if pr_table is not store.pr_by_role:
            s_for_blind = dataclasses.replace(store, pr_by_role=pr_table)
        blind_z = _build_blind_z_array(
            s_for_blind, my_role, eligible, pr_table, pr_weighted,
            shrink_alpha=shrink_alpha, pr_floor=pr_floor,
        )
    finally:
        pcp.PR_FLOOR = orig_floor

    rng = np.random.default_rng(seed)
    pool_idxs = _sample_pool_indices(len(eligible), pool_size, n_samples, rng)
    if pool_idxs.shape[0] == 0:
        return {}

    lane_opps = LANE_MATCH_OPPONENTS.get(my_role, set())
    eff_top_x = max(1, min(int(top_x), pool_size))
    lane_per, out_lane_per, syn_per = [], [], []
    for (mode, opp_role), (z_sub, col_pr, mirror_col_for_row) in z_subs.items():
        scored = _score_pools(
            z_sub, col_pr, pool_idxs, pool_size, pr_weighted,
            mirror_col_for_row=mirror_col_for_row,
        )
        sc = scored.get(eff_top_x)
        if sc is None:
            continue
        if mode == "matchup":
            (lane_per if opp_role in lane_opps else out_lane_per).append(sc)
        else:
            syn_per.append(sc)

    blind_scored = _score_pools_blind(blind_z, pool_idxs, pool_size).get(eff_top_x)

    def stack_mean(arrs):
        if not arrs:
            return None
        return np.nanmean(np.vstack(arrs), axis=0)

    out = {}
    pairs = [
        ("in_lane_matchup",     stack_mean(lane_per)),
        ("out_of_lane_matchup", stack_mean(out_lane_per)),
        ("overall_synergy",     stack_mean(syn_per)),
        ("blindability",        blind_scored),
    ]
    for name, arr in pairs:
        if arr is None:
            continue
        # Round to 4 decimals to keep JSON compact; values are typically in
        # [-3, +3] range so 4 decimals = 0.01% precision.
        out[name] = [round(float(v), 4) if np.isfinite(v) else None
                     for v in arr]
    return out


def main() -> None:
    DIST_DIR.mkdir(exist_ok=True)
    print(f"[precompute_curves] loading from {DATA_DIR}")
    store = load_all(DATA_DIR)

    # `store.patches` is now a list of rank labels (silver, gold, ..., master_plus)
    # and `store.latest_patch` is the default rank. Loop over each rank and emit
    # one strength_curves_<rank>.json so the frontend can lazy-load only the one
    # the user has selected.
    ranks = list(store.patches)
    if not ranks:
        print("[precompute_curves] no ranks available; aborting")
        return

    keys = list(GRID.keys())
    combos = list(product(*GRID.values()))
    per_rank_total = len(ROLES) * len(combos)

    for rank in ranks:
        print(f"\n[precompute_curves] === rank={rank} ===")
        out: dict = {
            "config": {
                "n_samples": N_SAMPLES,
                "grid":      {k: list(v) for k, v in GRID.items()},
                "patch":     rank,   # field still named "patch" for engine compat
            },
            "data": {role: {} for role in ROLES},
        }

        done = 0
        t0 = time.time()

        for role in ROLES:
            for vals in combos:
                params = dict(zip(keys, vals, strict=True))
                samples = sample_components(
                    store, role, rank,
                    params["pool_size"], params["top_x"],
                    params["pr_floor"], params["pr_weighted"],
                    params["shrink_alpha"], N_SAMPLES,
                )
                k = (
                    f"p{params['pool_size']}_t{params['top_x']}"
                    f"_pf{int(params['pr_floor'] * 10000)}"
                    f"_w{int(params['pr_weighted'])}"
                    f"_a{int(params['shrink_alpha'] * 100)}"
                )
                out["data"][role][k] = samples
                done += 1
                if done % 200 == 0:
                    rate = done / (time.time() - t0)
                    eta = (per_rank_total - done) / rate
                    print(f"  {done}/{per_rank_total} — {rate:.1f}/s — ETA {eta:.0f}s")

        out_path = DIST_DIR / f"strength_curves_{rank}.json"
        with out_path.open("w") as f:
            json.dump(out, f, separators=(",", ":"))
        elapsed = time.time() - t0
        print(f"[precompute_curves] wrote {out_path.name} "
              f"({out_path.stat().st_size / 1e6:.1f} MB) in {elapsed:.0f}s")


if __name__ == "__main__":
    main()
