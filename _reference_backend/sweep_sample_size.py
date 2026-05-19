"""Compare pool-strength curve quality at decreasing sample counts.

Picks one scenario (SUP, patch 16.8, pr_weighted=False, pool_size=6, top_x=3)
and recomputes the 4 strength curves at K ∈ {200, 500, 1k, 2k, 5k, 10k, 20k}.
Plots all curves overlaid per metric so you can eyeball when the noise floor
becomes acceptable.

Output: ./sweep_sample_size.png (4-panel figure)
"""
from __future__ import annotations

import time
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

from data import get_data_dir_from_env, load_all
from precompute_pool_distributions import (
    _build_blind_z_array,
    _build_z_subset,
    _sample_pool_indices,
    _score_pools,
    _score_pools_blind,
    LANE_MATCH_OPPONENTS,
    PR_FLOOR,
)

ROLE = "SUP"
PATCH = "16.8"
PR_WEIGHTED = False
POOL_SIZE = 6
TOP_X = 3
SAMPLE_SIZES = [200, 500, 1000, 2000, 5000, 10000, 20000]
SEED = 42

OUT_PATH = Path(__file__).parent / "sweep_sample_size.png"


def aggregate_per_metric(z_subs, blind_z, pool_idxs, lane_opps, pr_weighted):
    """Return dict: metric → 1-D array of per-pool scores."""
    matchup_per_role: list[np.ndarray] = []
    synergy_per_role: list[np.ndarray] = []
    lane_per_role: list[np.ndarray] = []

    for (mode, opp_role), (z_sub, col_pr, mirror_col_for_row) in z_subs.items():
        scored = _score_pools(
            z_sub, col_pr, pool_idxs, POOL_SIZE, pr_weighted,
            mirror_col_for_row=mirror_col_for_row,
        )
        sc = scored[TOP_X]
        if mode == "matchup":
            matchup_per_role.append(sc)
            if opp_role in lane_opps:
                lane_per_role.append(sc)
        else:
            synergy_per_role.append(sc)

    def mean_or_nan(arrs):
        if not arrs:
            return None
        stk = np.vstack(arrs)
        return np.nanmean(stk, axis=0)

    blind_scored = _score_pools_blind(blind_z, pool_idxs, POOL_SIZE)[TOP_X]

    return {
        "Overall Matchup":  mean_or_nan(matchup_per_role),
        "Overall Synergy":  mean_or_nan(synergy_per_role),
        "In-Lane Matchup":  mean_or_nan(lane_per_role),
        "Blindability":     blind_scored,
    }


def main():
    print("Loading data store...")
    store = load_all(get_data_dir_from_env())
    pr_table = store.pr_by_patch[PATCH] if PATCH in store.pr_by_patch else store.pr_by_role

    eligible = sorted(ch for ch, pr in pr_table.get(ROLE, {}).items() if pr >= PR_FLOOR)
    print(f"Eligible at {ROLE} (PR >= {PR_FLOOR*100:.1f}% on patch {PATCH}): {len(eligible)} champs")

    # Build z subsets once (independent of K)
    print("Building z subsets...")
    z_subs = {}
    for mode in ("matchup", "synergy"):
        for opp_role in ["TOP", "JUNGLE", "MID", "ADC", "SUP"]:
            if mode == "synergy" and opp_role == ROLE:
                continue
            res = _build_z_subset(store, mode, ROLE, opp_role, eligible, pr_table)
            if res is not None:
                z_subs[(mode, opp_role)] = res
    print(f"  {len(z_subs)} z_subsets")

    # Build blind z array once
    blind_z = _build_blind_z_array(store, ROLE, eligible, pr_table, PR_WEIGHTED)
    print(f"  blind z range [{np.nanmin(blind_z):.3f}, {np.nanmax(blind_z):.3f}]")

    lane_opps = LANE_MATCH_OPPONENTS[ROLE]
    rng = np.random.default_rng(SEED)

    # Run each sample size
    results: dict[int, dict[str, np.ndarray]] = {}
    timings: dict[int, float] = {}
    for K in SAMPLE_SIZES:
        t0 = time.time()
        pool_idxs = _sample_pool_indices(len(eligible), POOL_SIZE, K, rng)
        scores = aggregate_per_metric(z_subs, blind_z, pool_idxs, lane_opps, PR_WEIGHTED)
        timings[K] = time.time() - t0
        results[K] = scores
        print(f"K={K:>5}: {timings[K]*1000:.0f}ms")

    # Plot: grid of (metrics × K), each cell is one smoothed curve.
    # Smoothing = scipy.stats.gaussian_kde with a generous bandwidth so the
    # curves look like the precompute UI would render them.
    from scipy.stats import gaussian_kde
    metrics = ["Overall Matchup", "Overall Synergy", "In-Lane Matchup", "Blindability"]
    n_rows = len(metrics)
    n_cols = len(SAMPLE_SIZES)
    fig, axes = plt.subplots(n_rows, n_cols, figsize=(2.8 * n_cols, 2.4 * n_rows),
                             sharey="row")
    fig.suptitle(
        f"Smoothed strength curves vs sample size  ·  {ROLE} pool {POOL_SIZE} top-{TOP_X}  ·  "
        f"patch {PATCH}  ·  pr_weighted={PR_WEIGHTED}",
        fontsize=12,
    )

    BW_MULT = 0.35    # higher = more smoothing (default Scott's rule ~ 0.05-0.1)

    for r, metric in enumerate(metrics):
        gt = results[20000][metric]
        gt = gt[np.isfinite(gt)]
        if gt.size == 0:
            for c in range(n_cols):
                axes[r, c].set_title(f"{metric} (no data)")
            continue
        lo, hi = np.percentile(gt, [0.5, 99.5])
        pad = 0.05 * (hi - lo)
        x = np.linspace(lo - pad, hi + pad, 300)
        # Reference KDE from K=20000 for comparison
        ref_kde = gaussian_kde(gt, bw_method=BW_MULT)
        ref_y = ref_kde(x)

        for c, K in enumerate(SAMPLE_SIZES):
            ax = axes[r, c]
            arr = results[K][metric]
            arr = arr[np.isfinite(arr)]
            if arr.size < 2:
                ax.set_title(f"K={K} (n/a)")
                continue
            kde = gaussian_kde(arr, bw_method=BW_MULT)
            y = kde(x)
            # Light reference curve underneath, then this K's curve on top
            ax.fill_between(x, 0, ref_y, color="lightgray", alpha=0.5,
                            label=("K=20000 ref" if c == 0 else None))
            ax.plot(x, y, color="tab:blue", lw=1.6,
                    label=f"K={K}")
            if r == 0:
                ax.set_title(f"K={K}\n{timings[K]*1000:.0f}ms", fontsize=10)
            ax.tick_params(axis='both', which='major', labelsize=8)
            ax.grid(True, alpha=0.25)
            if c == 0:
                ax.set_ylabel(metric, fontsize=10)
            ax.set_xlim(lo - pad, hi + pad)

    plt.tight_layout(rect=[0, 0, 1, 0.95])
    fig.savefig(OUT_PATH, dpi=110)
    print(f"\nWrote {OUT_PATH}")


if __name__ == "__main__":
    main()
