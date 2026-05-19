"""Live computation of the 4 pool-strength reference curves.

Replaces the precomputed `pool_distributions.json` lookup with a fresh
sample for the user's exact (role, patch, pool_size, top_x, pr_floor,
pr_weighted) state. Returns slots in the same shape the frontend renderer
expects:

    [mean, sd, min, max, p0..p100 (21), h0..h29 (30)]

The "histogram" tail is actually a KDE evaluated at 30 evenly-spaced
points and renormalized to sum to 1, so visually it looks smooth even at
K=500 samples — the frontend's 3-point smoother further softens it.
"""
from __future__ import annotations

import dataclasses
from typing import Optional

import numpy as np
from scipy.stats import gaussian_kde

from data import DataStore
from precompute_pool_distributions import (
    LANE_MATCH_OPPONENTS,
    N_HIST_BINS,
    PERCENTILE_GRID,
    _build_blind_z_array,
    _build_z_subset,
    _sample_pool_indices,
    _score_pools,
    _score_pools_blind,
)

# Re-export so main.py can import these from live_curves directly.
__all__ = [
    "DEFAULT_K", "PERCENTILE_GRID", "N_HIST_BINS",
    "compute_live_curves", "get_component_sigmas",
]

DEFAULT_K = 500
KDE_BW = 0.35   # generous bandwidth for smoothing at low K

# Per-scenario σ cache. Populated as a side effect of compute_live_curves
# (runs the same Monte Carlo). Other endpoints (pool_summary, replacements,
# build) call get_component_sigmas to read from this cache so every request
# uses the same σs that the displayed reference curves were built with.
_SIGMA_CACHE: dict[tuple, dict[str, float]] = {}
_SIGMA_CACHE_MAX = 64


def _make_sigma_key(my_role, patch, pool_size, top_x, pr_floor, pr_weighted, shrink_alpha):
    return (
        str(my_role), str(patch) if patch else None,
        int(pool_size), int(top_x),
        round(float(pr_floor), 6), bool(pr_weighted),
        round(float(shrink_alpha), 6),
    )


def _store_sigmas(key, sigmas):
    if key in _SIGMA_CACHE:
        _SIGMA_CACHE[key] = dict(sigmas)
        return
    if len(_SIGMA_CACHE) >= _SIGMA_CACHE_MAX:
        _SIGMA_CACHE.pop(next(iter(_SIGMA_CACHE)))
    _SIGMA_CACHE[key] = dict(sigmas)


def _sd_or_one(arr) -> float:
    if arr is None:
        return 1.0
    valid = arr[np.isfinite(arr)]
    if valid.size < 2:
        return 1.0
    sd = float(valid.std(ddof=1))
    return sd if sd > 1e-9 else 1.0


def get_component_sigmas(
    store, my_role, patch, pool_size, top_x,
    pr_floor, pr_weighted, shrink_alpha=1.0,
) -> dict[str, float]:
    """Return cached per-component σs for the scenario; compute on miss.

    Cache miss runs compute_live_curves (~50–80 ms) which populates the cache
    as a side effect. Cache hit is ~0 ms. Returns dict keyed by:
    in_lane, out_lane, synergy, blind (each → float, default 1.0)."""
    key = _make_sigma_key(my_role, patch, pool_size, top_x, pr_floor, pr_weighted, shrink_alpha)
    if key in _SIGMA_CACHE:
        return dict(_SIGMA_CACHE[key])
    # Cache miss — run a curves call to populate. Weights don't affect σs,
    # so any values work; use 1.0 to keep it cheap and deterministic.
    compute_live_curves(
        store, my_role, patch, pool_size, top_x, pr_floor, pr_weighted,
        shrink_alpha=shrink_alpha,
    )
    return dict(_SIGMA_CACHE.get(key, {"in_lane": 1.0, "out_lane": 1.0, "synergy": 1.0, "blind": 1.0}))


def _aggregate_stats_kde(scores: np.ndarray) -> Optional[list[float]]:
    """Same shape as the precompute `_aggregate_stats`, but the 30-bin
    "histogram" tail is a KDE evaluated at 30 points and normalized so the
    values sum to 1 (so the frontend's existing renderer can plot them
    as densities)."""
    valid = scores[np.isfinite(scores)]
    if valid.size == 0:
        return None
    mn = float(valid.min())
    mx = float(valid.max())
    sd = float(valid.std(ddof=1)) if valid.size > 1 else 0.0

    if mx > mn and valid.size >= 8:
        try:
            kde = gaussian_kde(valid, bw_method=KDE_BW)
            xs = np.linspace(mn, mx, N_HIST_BINS)
            ys = kde(xs)
            total = ys.sum()
            density = [round(float(v / total), 5) for v in ys] if total > 0 else [0.0] * N_HIST_BINS
        except Exception:
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


def compute_live_curves(
    store: DataStore,
    my_role: str,
    patch: Optional[str],
    pool_size: int,
    top_x: int,
    pr_floor: float,
    pr_weighted: bool,
    shrink_alpha: float = 1.0,
    w_in_lane: float = 1.0,
    w_out_lane: float = 1.0,
    w_synergy: float = 1.0,
    w_blind: float = 0.2,
    sigma_in_lane: float = 1.0,
    sigma_out_lane: float = 1.0,
    sigma_synergy: float = 1.0,
    sigma_blind: float = 1.0,
    n_samples: int = DEFAULT_K,
    seed: int = 42,
) -> dict:
    """Return {metric: slot, ...} for the 4 strength curves.

    metric ∈ {"overall_matchup", "overall_synergy", "in_lane_matchup",
              "blindability"}
    slot   = [mean, sd, min, max, *21 percentiles, *30 KDE-density bins]

    Empty dict if there's not enough data to fit any curve.
    """
    pr_table = store.pr_by_patch[patch] if patch and patch in store.pr_by_patch else store.pr_by_role
    eligible = sorted(ch for ch, pr in pr_table.get(my_role, {}).items() if pr >= pr_floor)
    if len(eligible) < pool_size:
        return {}

    # The precompute helpers hardcode PR_FLOOR module-level. Easiest fix:
    # build a store-shim with pr_by_role swapped to the patch table so the
    # _build_z_subset's column filter still uses the right PR. Actually
    # _build_z_subset takes pr_table directly — but its internal PR_FLOOR
    # constant is what filters cols. We monkey-patch it at runtime.
    import precompute_pool_distributions as pcp
    orig_floor = pcp.PR_FLOOR
    pcp.PR_FLOOR = pr_floor
    try:
        z_subs: dict = {}
        for mode in ("matchup", "synergy"):
            for opp_role in ["TOP", "JUNGLE", "MID", "ADC", "SUP"]:
                if mode == "synergy" and opp_role == my_role:
                    continue
                res = _build_z_subset(
                    store, mode, my_role, opp_role, eligible, pr_table,
                    shrink_alpha=shrink_alpha,
                )
                if res is not None:
                    z_subs[(mode, opp_role)] = res
        # Use a store shim so blind_stats sees the right PR table for
        # PR-weighted blindability.
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
    matchup_per_role: list[np.ndarray] = []
    synergy_per_role: list[np.ndarray] = []
    lane_per_role: list[np.ndarray] = []
    out_lane_per_role: list[np.ndarray] = []

    eff_top_x = max(1, min(int(top_x), pool_size))
    for (mode, opp_role), (z_sub, col_pr, mirror_col_for_row) in z_subs.items():
        scored = _score_pools(
            z_sub, col_pr, pool_idxs, pool_size, pr_weighted,
            mirror_col_for_row=mirror_col_for_row,
        )
        sc = scored.get(eff_top_x)
        if sc is None:
            continue
        if mode == "matchup":
            matchup_per_role.append(sc)
            if opp_role in lane_opps:
                lane_per_role.append(sc)
            else:
                out_lane_per_role.append(sc)
        else:
            synergy_per_role.append(sc)

    blind_scored = _score_pools_blind(blind_z, pool_idxs, pool_size).get(eff_top_x)

    def stack_mean(arrs: list[np.ndarray]) -> Optional[np.ndarray]:
        if not arrs:
            return None
        return np.nanmean(np.vstack(arrs), axis=0)

    in_lane_per_pool  = stack_mean(lane_per_role)
    out_lane_per_pool = stack_mean(out_lane_per_role)
    syn_per_pool      = stack_mean(synergy_per_role)
    matchup_per_pool  = stack_mean(matchup_per_role)

    # Compute σs from the actual component arrays we just built and cache
    # them. We ignore the σs the caller passed in — those are now advisory
    # only (kept in the signature for API back-compat). This guarantees
    # every endpoint sees consistent σs for a given scenario.
    canonical_sigmas = {
        "in_lane":  _sd_or_one(in_lane_per_pool),
        "out_lane": _sd_or_one(out_lane_per_pool),
        "synergy":  _sd_or_one(syn_per_pool),
        "blind":    _sd_or_one(blind_scored),
    }
    _store_sigmas(
        _make_sigma_key(my_role, patch, pool_size, top_x, pr_floor, pr_weighted, shrink_alpha),
        canonical_sigmas,
    )

    # Weighted total per pool: w_in × in-lane/σ_in + w_out × out-lane/σ_out
    # + w_syn × syn/σ_syn + w_blind × blind/σ_blind. NaN-safe — components
    # missing for a pool drop out.
    total_per_pool: Optional[np.ndarray] = None
    components: list[tuple[float, float, Optional[np.ndarray]]] = [
        (w_in_lane,  canonical_sigmas["in_lane"],  in_lane_per_pool),
        (w_out_lane, canonical_sigmas["out_lane"], out_lane_per_pool),
        (w_synergy,  canonical_sigmas["synergy"],  syn_per_pool),
        (w_blind,    canonical_sigmas["blind"],    blind_scored),
    ]
    accum = None
    for w, sig, arr in components:
        if w == 0 or arr is None:
            continue
        contrib = (w / sig) * np.where(np.isnan(arr), 0.0, arr)
        accum = contrib if accum is None else accum + contrib
    total_per_pool = accum

    out: dict = {}
    pairs = [
        ("overall_matchup",     matchup_per_pool),
        ("overall_synergy",     syn_per_pool),
        ("in_lane_matchup",     in_lane_per_pool),
        ("out_of_lane_matchup", out_lane_per_pool),
        ("blindability",        blind_scored),
        ("total_score",         total_per_pool),
    ]
    for name, scores in pairs:
        if scores is None:
            continue
        slot = _aggregate_stats_kde(scores)
        if slot is not None:
            out[name] = slot
    return out
