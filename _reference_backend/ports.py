"""Port of every non-coverage helper from app.R.

Kept separate from compute.py so the surface area is obvious:
- adjusted_matrix, zscored_matrix         (per-cell shrinkage helpers)
- blind_stats                             (per-(mode,pos) blindability z)
- z_matrices                              (cached per-(mode,pos) z + pp matrices for scoring)
- score_pool_fast, pool_pos_scores        (Pool Builder / Replacement scoring)
- build_pool_profile, scope_stats,
  redundancy_data                         (Pool Health / Redundancy)
- replacement_candidates, ranked_candidates  (Replacement Finder)
- ban_candidates                          (Ban Recommender)
- built_pools                             (Pool Builder enumeration)
- health_table                            (Pool Health summary tables)
"""
from __future__ import annotations

from itertools import combinations
from typing import Optional

import numpy as np
from scipy.cluster.hierarchy import dendrogram, linkage, leaves_list

from compute import (
    FIXED_NOISE_Z,
    FIXED_SHRINK_ALPHA,
    FIXED_USE_EB,
    FIXED_USE_HIER,
    FIXED_USE_HIER_WIDE,
    FIXED_USE_TAU_BLIND,
    MATCHUP_THRESHOLD,
    SYNERGY_THRESHOLD,
    Coverage,
    _adjusted_matrix as _adjusted_pair_matrix,
    _zscored_columns,
    compute_coverage,
)
from data import ROLES, DataStore, PairMats

POOL_BUILDER_CAP = 10_000
DEFAULT_TOP_OPP_PR = 0.01  # 1% — fallback floor when caller passes no pr_floor


# ── adjusted_matrix / zscored_matrix ──────────────────────────────────────
def adjusted_matrix(
    store: DataStore, mode: str, my_role: str, pos: str,
    noise_z: float = FIXED_NOISE_Z, use_eb: bool = FIXED_USE_EB,
    use_hier: bool = FIXED_USE_HIER,
    use_hier_wide: bool = FIXED_USE_HIER_WIDE,
    shrink_alpha: float = FIXED_SHRINK_ALPHA,
) -> Optional[tuple[np.ndarray, list[str], list[str]]]:
    """Return (mat, rows, cols) for the (my_role, pos) slice in the given mode."""
    pairs = store.matchup if mode == "matchup" else store.synergy
    pair = pairs.get(my_role, {}).get(pos)
    if pair is None:
        return None
    return _adjusted_pair_matrix(pair, noise_z, use_eb, use_hier, use_hier_wide, shrink_alpha), pair.rows, pair.cols


def zscored_matrix(mat: np.ndarray) -> np.ndarray:
    return _zscored_columns(mat)


# ── Blindability ──────────────────────────────────────────────────────────
def _weighted_sd_row(x: np.ndarray, w: np.ndarray) -> float:
    """Reliability-weighted unbiased SD (R weighted_sd_row)."""
    valid = np.isfinite(x) & np.isfinite(w) & (w > 0)
    if valid.sum() < 2:
        return float("nan")
    x = x[valid]; w = w[valid]
    sw = w.sum()
    mw = (w * x).sum() / sw
    denom = sw - (w ** 2).sum() / sw
    if denom <= 0:
        return float("nan")
    return float(np.sqrt((w * (x - mw) ** 2).sum() / denom))


def blind_stats(
    store: DataStore, my_role: str,
    noise_z: float = FIXED_NOISE_Z, use_eb: bool = FIXED_USE_EB,
    use_hier: bool = FIXED_USE_HIER,
    use_hier_wide: bool = FIXED_USE_HIER_WIDE,
    shrink_alpha: float = FIXED_SHRINK_ALPHA,
    use_tau_blind: bool = FIXED_USE_TAU_BLIND,
    pr_weighted: bool = False,
    pr_floor: float = DEFAULT_TOP_OPP_PR,
) -> dict:
    """Per-(mode, pos) blindability stats: high z = consistent across opponents.

    When `use_tau_blind` is True, the per-champion spread metric is the
    posterior-mean τ_c from the bilateral hierarchical fit (low τ = blindable),
    instead of the empirical row-SD over the shrunk matrix. The SD-based
    metric collapses for low-PR champs under strong shrinkage (their row goes
    to ~0 → SD ≈ 0 → spuriously "most blindable"); τ_c is the model's
    explicit per-champion variance scale and doesn't suffer from this.
    """
    result = {"matchup": {}, "synergy": {}}
    pairs_by_mode = {"matchup": store.matchup, "synergy": store.synergy}
    for mv in ("matchup", "synergy"):
        for pos in ROLES:
            if mv == "synergy" and pos == my_role:
                continue
            adj = adjusted_matrix(store, mv, my_role, pos, noise_z, use_eb,
                                  use_hier, use_hier_wide, shrink_alpha)
            if adj is None:
                continue
            mat, rows, cols = adj
            top_opp = [c for c in cols if store.pr_by_role.get(pos, {}).get(c, 0.0) >= pr_floor]
            keep_idx = [i for i, c in enumerate(cols) if c in top_opp]
            if len(keep_idx) < 3:
                continue
            sub = mat[:, keep_idx]
            if use_tau_blind:
                pair = pairs_by_mode[mv].get(my_role, {}).get(pos)
                # Pair the τ source with the matrix source: wide-prior matrix
                # uses wide-prior τ; tight-prior matrix uses tight-prior τ.
                if pair is None:
                    tau = None
                elif use_hier_wide:
                    tau = pair.tau_rows_wide
                else:
                    tau = pair.tau_rows
                if tau is None or tau.shape[0] != len(rows) or not np.isfinite(tau).any():
                    # fall back to SD if τ sidecar is missing for this pair
                    sds = np.nanstd(sub, axis=1, ddof=1)
                else:
                    sds = tau.astype(np.float64)
            elif pr_weighted:
                prs = store.pr_by_role.get(pos, {})
                w = np.array([max(prs.get(cols[i], 0.0), 0.0) for i in keep_idx])
                if w.sum() <= 0:
                    w = np.ones_like(w)
                sds = np.array([_weighted_sd_row(sub[r], w) for r in range(sub.shape[0])])
            else:
                sds = np.nanstd(sub, axis=1, ddof=1)

            # Population z-normalization. For the τ-based metric, pr_weighted
            # makes the baseline reflect the *typical popular champ* by
            # weighting mean/std by champ PR at my_role — otherwise the
            # weighting wouldn't show up at all (τ is intrinsic per-champ).
            # SD-based already incorporates pr_weighted via per-row weighted
            # SD above, so we leave its normalization unweighted.
            if use_tau_blind and pr_weighted:
                prs_my = store.pr_by_role.get(my_role, {})
                w_my = np.array([max(prs_my.get(c, 0.0), 0.0) for c in rows])
                valid = np.isfinite(sds) & (w_my > 0)
                if valid.sum() >= 2 and w_my[valid].sum() > 0:
                    ww = w_my[valid]; sw = ww.sum()
                    m = float((ww * sds[valid]).sum() / sw)
                    var = float((ww * (sds[valid] - m) ** 2).sum() / sw)
                    s = float(np.sqrt(var))
                else:
                    m = np.nanmean(sds); s = np.nanstd(sds, ddof=1)
            else:
                m = np.nanmean(sds)
                s = np.nanstd(sds, ddof=1)
            if not np.isfinite(s) or s < 1e-9:
                s = 1.0
            z = -((sds - m) / s)  # flip so high = low spread = blindable
            result[mv][pos] = {
                "champs": list(rows),
                "z": z,
                "sd": sds,
            }
    return result


def blind_z_lookup(blind: dict, my_role: str) -> dict[str, float]:
    """Per-champ aggregate blindability z (mean across all available slices)."""
    agg: dict[str, list[float]] = {}
    for mv in ("matchup", "synergy"):
        for pos, payload in blind[mv].items():
            for ch, v in zip(payload["champs"], payload["z"]):
                if np.isfinite(v):
                    agg.setdefault(ch, []).append(float(v))
    return {ch: float(np.mean(vs)) for ch, vs in agg.items()}


# ── z_matrices: precomputed scoring matrices for every (mode, pos) slice ──
def z_matrices(
    store: DataStore, my_role: str,
    noise_z: float = FIXED_NOISE_Z, use_eb: bool = FIXED_USE_EB,
    use_hier: bool = FIXED_USE_HIER,
    use_hier_wide: bool = FIXED_USE_HIER_WIDE,
    shrink_alpha: float = FIXED_SHRINK_ALPHA,
    pr_floor: float = 0.0075,
) -> dict:
    """Mirrors the R `z_matrices` reactive — keys are 'matchup_TOP', etc."""
    out: dict = {}
    for pos in ROLES:
        for mv in ("matchup", "synergy"):
            if mv == "synergy" and pos == my_role:
                continue
            adj = adjusted_matrix(store, mv, my_role, pos, noise_z, use_eb,
                                  use_hier, use_hier_wide, shrink_alpha)
            if adj is None:
                continue
            mat, rows, cols = adj
            z = _zscored_columns(mat)
            # filter to PR-floor cols
            prs = store.pr_by_role.get(pos, {})
            keep_mask = np.array([prs.get(c, 0.0) >= pr_floor for c in cols])
            if not keep_mask.any():
                continue
            keep_cols = [c for c, m in zip(cols, keep_mask) if m]
            out[f"{mv}_{pos}"] = {
                "z": z[:, keep_mask],
                "pp": mat[:, keep_mask],
                "rows": rows,
                "cols": keep_cols,
                "mode": mv,
                "pos": pos,
                "is_mirror": (mv == "matchup" and pos == my_role),
            }
    return out


# ── Pool scoring ──────────────────────────────────────────────────────────
def _mask_mirror_diagonal(sub: np.ndarray, have: list[str], cols: list[str]) -> np.ndarray:
    """For mirror matchup: replace cells where row champ == col champ with -inf.

    Pool members appear as opponents for the rest of the pool; only the
    self-cell is meaningless. Returns sub unchanged if no overlap exists.
    """
    col_pos = {c: j for j, c in enumerate(cols)}
    diag_mask = np.zeros_like(sub, dtype=bool)
    for i, row_ch in enumerate(have):
        j = col_pos.get(row_ch)
        if j is not None:
            diag_mask[i, j] = True
    if not diag_mask.any():
        return sub
    return np.where(diag_mask, -np.inf, sub)


def _topx_col_score(sub: np.ndarray, eff_x: int) -> np.ndarray:
    """Per-column mean of top-X (sorted desc).

    Cells set to -inf are treated as masked (e.g. mirror-matchup self-cells)
    and excluded from the mean — so when fewer than eff_x rows are valid for
    a column, the score is the mean of just the valid ones. Columns with no
    valid rows return NaN.
    """
    if eff_x == 1:
        out = sub.max(axis=0)
        return np.where(np.isfinite(out), out, np.nan)
    top = np.sort(sub, axis=0)[-eff_x:]      # ascending → top eff_x rows
    top_clean = np.where(np.isfinite(top), top, np.nan)
    return np.nanmean(top_clean, axis=0)


def _pos_score(sub: np.ndarray, cols: list[str], pos: str,
               pr_by_role: dict, eff_x: int, pr_weighted: bool) -> float:
    col_score = _topx_col_score(sub, eff_x)
    valid = np.isfinite(col_score)
    if not valid.any():
        return float("nan")
    if pr_weighted:
        prs = pr_by_role.get(pos, {})
        w = np.array([max(prs.get(c, 0.0), 0.0) for c in cols])
        # NaN-safe weighted mean: drop cols with NaN scores from both sides.
        w = np.where(valid, w, 0.0)
        if w.sum() > 0:
            cs = np.where(valid, col_score, 0.0)
            return float((cs * w).sum() / w.sum())
    return float(np.nanmean(col_score))


def score_pool_fast(
    pool: list[str], z_mats: dict, pr_by_role: dict,
    top_x: int, my_role: Optional[str] = None,
    blind_penalty: float = 0.0,
    pr_weighted: bool = False,
    blind_lookup: Optional[dict[str, float]] = None,
) -> float:
    """Mean of (mean top-X z per column) across all slices, + blind_penalty * mean blind z."""
    if not pool:
        return float("nan")
    pos_scores: list[float] = []
    for entry in z_mats.values():
        rows = entry["rows"]; cols = entry["cols"]; zm = entry["z"]
        row_idx = {ch: i for i, ch in enumerate(rows)}
        have = [ch for ch in pool if ch in row_idx]
        if not have or zm.shape[1] == 0:
            continue
        cols_used = cols
        sub = zm[[row_idx[ch] for ch in have], :]
        if entry["is_mirror"]:
            sub = _mask_mirror_diagonal(sub, have, cols)
        eff_x = max(1, min(int(top_x), sub.shape[0]))
        pos_scores.append(
            _pos_score(sub, cols_used, entry["pos"], pr_by_role, eff_x, pr_weighted)
        )
    if not pos_scores:
        return float("nan")
    coverage = float(np.mean(pos_scores))
    if blind_penalty != 0 and blind_lookup is not None:
        zs = [blind_lookup[ch] for ch in pool if ch in blind_lookup and np.isfinite(blind_lookup[ch])]
        if zs:
            coverage += blind_penalty * float(np.mean(zs))
    return coverage


def pool_pos_scores(
    pool: list[str], z_mats: dict, pr_by_role: dict,
    top_x: int, pr_weighted: bool = False,
) -> dict[str, float]:
    """Per-position scores; key = 'matchup_POS' or 'synergy_POS'."""
    out: dict[str, float] = {}
    for nm, entry in z_mats.items():
        rows = entry["rows"]; cols = entry["cols"]; zm = entry["z"]
        row_idx = {ch: i for i, ch in enumerate(rows)}
        have = [ch for ch in pool if ch in row_idx]
        if not have or zm.shape[1] == 0:
            out[nm] = float("nan"); continue
        cols_used = cols
        sub = zm[[row_idx[ch] for ch in have], :]
        if entry["is_mirror"]:
            sub = _mask_mirror_diagonal(sub, have, cols)
        eff_x = max(1, min(int(top_x), sub.shape[0]))
        out[nm] = _pos_score(sub, cols_used, entry["pos"], pr_by_role, eff_x, pr_weighted)
    return out


def pool_stats(
    pool: list[str], z_mats: dict, pr_by_role: dict,
    top_x: int, my_role: str, pr_weighted: bool = False,
    blind_lookup: Optional[dict[str, float]] = None,
) -> dict:
    """Per-pool overall + by-mode + in-lane vs out-of-lane + blindability."""
    lane_set = set(LANE_ROLES.get(my_role, []))
    matchup_scores: list[float] = []
    matchup_in_lane: list[float] = []
    matchup_out_of_lane: list[float] = []
    synergy_scores: list[float] = []
    for entry in z_mats.values():
        rows = entry["rows"]; cols = entry["cols"]; zm = entry["z"]
        row_idx = {ch: i for i, ch in enumerate(rows)}
        have = [ch for ch in pool if ch in row_idx]
        if not have or zm.shape[1] == 0:
            continue
        cols_used = cols
        sub = zm[[row_idx[ch] for ch in have], :]
        if entry["is_mirror"]:
            sub = _mask_mirror_diagonal(sub, have, cols)
        eff_x = max(1, min(int(top_x), sub.shape[0]))
        s = _pos_score(sub, cols_used, entry["pos"], pr_by_role, eff_x, pr_weighted)
        if entry["mode"] == "matchup":
            matchup_scores.append(s)
            if entry["pos"] in lane_set:
                matchup_in_lane.append(s)
            else:
                matchup_out_of_lane.append(s)
        else:
            synergy_scores.append(s)

    blind_z: float = float("nan")
    if blind_lookup is not None:
        zs = [blind_lookup[ch] for ch in pool if ch in blind_lookup and np.isfinite(blind_lookup[ch])]
        if zs:
            blind_z = float(np.mean(zs))

    overall_raw = float("nan")
    if matchup_scores or synergy_scores:
        overall_raw = float(np.mean(matchup_scores + synergy_scores))

    def _m(xs: list[float]) -> float:
        return float(np.mean(xs)) if xs else float("nan")

    return {
        "overall":             overall_raw,
        "matchup_z":           _m(matchup_scores),
        "matchup_in_lane":     _m(matchup_in_lane),
        "matchup_out_of_lane": _m(matchup_out_of_lane),
        "synergy_z":           _m(synergy_scores),
        "lane_z":              _m(matchup_in_lane),  # alias kept for compatibility
        "blind_z":             blind_z,
    }


# ── Replacement Finder ────────────────────────────────────────────────────
def replacement_candidates(store: DataStore, my_role: str, pool: list[str]) -> list[str]:
    """All champs at my_role with PR ≥ 0.5%, not already in pool, ordered by PR desc."""
    sub = store.ind_wr[(store.ind_wr["role"] == my_role) & (store.ind_wr["pick_rate"] >= 0.005)]
    sub = sub.sort_values("pick_rate", ascending=False)
    pool_set = set(pool)
    return [c for c in sub["champion"].tolist() if c not in pool_set]


def _total_score_from_stats(
    st: dict,
    w_in_lane: float = 1.0,
    w_out_lane: float = 1.0,
    w_synergy: float = 1.0,
    w_blind: float = 0.0,
    sigma_in_lane: float = 1.0,
    sigma_out_lane: float = 1.0,
    sigma_synergy: float = 1.0,
    sigma_blind: float = 1.0,
) -> float:
    """Weighted total: w_in × in-lane/σ_in + w_out × out-of-lane/σ_out
    + w_syn × synergy/σ_syn + w_blind × blindability/σ_blind. Components
    missing for this pool drop to 0. Default σ=1.0 reproduces the
    pre-σ-scaling behavior."""
    def _safe_sigma(s):
        return float(s) if (s is not None and np.isfinite(s) and s > 1e-9) else 1.0
    def _w(v, w, s):
        if v is None or not np.isfinite(v) or w == 0:
            return 0.0
        return float(w) * float(v) / _safe_sigma(s)
    total = (
        _w(st.get("matchup_in_lane"),     w_in_lane,  sigma_in_lane)
        + _w(st.get("matchup_out_of_lane"), w_out_lane, sigma_out_lane)
        + _w(st.get("synergy_z"),         w_synergy,  sigma_synergy)
        + _w(st.get("blind_z"),           w_blind,    sigma_blind)
    )
    return float(total)


def _delta(new: float, old: float) -> Optional[float]:
    """Return None if either side is non-finite (so JSON gets null)."""
    if not (np.isfinite(new) and np.isfinite(old)):
        return None
    return float(new - old)


def _stats_delta(
    new_stats: dict, base_stats: dict,
    w_in_lane: float, w_out_lane: float, w_synergy: float, w_blind: float,
    sigma_in_lane: float = 1.0, sigma_out_lane: float = 1.0,
    sigma_synergy: float = 1.0, sigma_blind: float = 1.0,
    new_sigma_in_lane: Optional[float] = None,
    new_sigma_out_lane: Optional[float] = None,
    new_sigma_synergy: Optional[float] = None,
    new_sigma_blind: Optional[float] = None,
) -> dict:
    """Per-component deltas between candidate-pool and base-pool stats.

    `new_sigma_*` (when provided) override `sigma_*` for the new-pool side
    of the total. Use this in add-mode where new and base pools differ in
    size and therefore in reference σs."""
    new_sks = dict(
        sigma_in_lane=new_sigma_in_lane if new_sigma_in_lane is not None else sigma_in_lane,
        sigma_out_lane=new_sigma_out_lane if new_sigma_out_lane is not None else sigma_out_lane,
        sigma_synergy=new_sigma_synergy if new_sigma_synergy is not None else sigma_synergy,
        sigma_blind=new_sigma_blind if new_sigma_blind is not None else sigma_blind,
    )
    # delta_total uses NEW σs on BOTH sides so the frontend can do
    # `newScore = baseScore_new_σ + delta` and have it equal the new pool's
    # total in new σs. Mixing σ-bases (new_total_new_σ - base_total_base_σ)
    # would make `baseScore + delta` meaningless and break the strength
    # panel projection in add mode.
    return {
        "delta_matchup":             _delta(new_stats["matchup_z"], base_stats["matchup_z"]),
        "delta_matchup_in_lane":     _delta(new_stats["matchup_in_lane"], base_stats["matchup_in_lane"]),
        "delta_matchup_out_of_lane": _delta(new_stats["matchup_out_of_lane"], base_stats["matchup_out_of_lane"]),
        "delta_synergy":             _delta(new_stats["synergy_z"], base_stats["synergy_z"]),
        "delta_blind":               _delta(new_stats["blind_z"], base_stats["blind_z"]),
        "delta_total":               _delta(
            _total_score_from_stats(new_stats,  w_in_lane, w_out_lane, w_synergy, w_blind, **new_sks),
            _total_score_from_stats(base_stats, w_in_lane, w_out_lane, w_synergy, w_blind, **new_sks),
        ),
    }


def ranked_candidates(
    store: DataStore, my_role: str, pool: list[str],
    mode: str,                             # "add" | "replace"
    locked: list[str],
    top_x: int = 1, pr_weighted: bool = False,
    pr_floor: float = 0.0075,
    noise_z: float = FIXED_NOISE_Z, use_eb: bool = FIXED_USE_EB,
    use_hier: bool = FIXED_USE_HIER,
    use_hier_wide: bool = FIXED_USE_HIER_WIDE,
    shrink_alpha: float = FIXED_SHRINK_ALPHA,
    use_tau_blind: bool = False,
    w_in_lane: float = 1.0, w_out_lane: float = 1.0,
    w_synergy: float = 1.0, w_blind: float = 0.3,
    sigma_in_lane: float = 1.0, sigma_out_lane: float = 1.0,
    sigma_synergy: float = 1.0, sigma_blind: float = 1.0,
    # New-pool σs (for add mode where new pool size differs from base).
    # Default to base σs when not provided (replace mode behavior).
    new_sigma_in_lane: Optional[float] = None,
    new_sigma_out_lane: Optional[float] = None,
    new_sigma_synergy: Optional[float] = None,
    new_sigma_blind: Optional[float] = None,
) -> Optional[list[dict]]:
    if not pool:
        return None
    cands = replacement_candidates(store, my_role, pool)
    if not cands:
        return None
    zmats = z_matrices(store, my_role, pr_floor=pr_floor,
                       noise_z=noise_z, use_eb=use_eb, use_hier=use_hier,
                       use_hier_wide=use_hier_wide, shrink_alpha=shrink_alpha)
    blind = blind_stats(store, my_role, pr_weighted=pr_weighted,
                        noise_z=noise_z, use_eb=use_eb, use_hier=use_hier,
                        use_hier_wide=use_hier_wide, shrink_alpha=shrink_alpha,
                        use_tau_blind=use_tau_blind, pr_floor=pr_floor)
    bz = blind_z_lookup(blind, my_role)

    base_sks = dict(
        sigma_in_lane=sigma_in_lane, sigma_out_lane=sigma_out_lane,
        sigma_synergy=sigma_synergy, sigma_blind=sigma_blind,
    )
    # New-pool σs default to base when not provided (replace mode = same size).
    new_sks = dict(
        sigma_in_lane=new_sigma_in_lane if new_sigma_in_lane is not None else sigma_in_lane,
        sigma_out_lane=new_sigma_out_lane if new_sigma_out_lane is not None else sigma_out_lane,
        sigma_synergy=new_sigma_synergy if new_sigma_synergy is not None else sigma_synergy,
        sigma_blind=new_sigma_blind if new_sigma_blind is not None else sigma_blind,
    )
    delta_sks = dict(
        sigma_in_lane=sigma_in_lane, sigma_out_lane=sigma_out_lane,
        sigma_synergy=sigma_synergy, sigma_blind=sigma_blind,
        new_sigma_in_lane=new_sks["sigma_in_lane"], new_sigma_out_lane=new_sks["sigma_out_lane"],
        new_sigma_synergy=new_sks["sigma_synergy"], new_sigma_blind=new_sks["sigma_blind"],
    )
    base_stats = pool_stats(pool, zmats, store.pr_by_role, top_x, my_role,
                            pr_weighted=pr_weighted, blind_lookup=bz)
    base_total = _total_score_from_stats(base_stats, w_in_lane, w_out_lane, w_synergy, w_blind, **base_sks)

    rows: list[dict] = []
    if mode == "add":
        for c in cands:
            new_pool = [*pool, c]
            st = pool_stats(new_pool, zmats, store.pr_by_role, top_x, my_role,
                            pr_weighted=pr_weighted, blind_lookup=bz)
            # New pool is size N+1 → use new σs (matches Pool Health after add).
            total = _total_score_from_stats(st, w_in_lane, w_out_lane, w_synergy, w_blind, **new_sks)
            if np.isfinite(total):
                rows.append({
                    "candidate": c, "remove": None,
                    "new_score": total,
                    **_stats_delta(st, base_stats, w_in_lane, w_out_lane, w_synergy, w_blind, **delta_sks),
                })
    else:
        removable = [p for p in pool if p not in set(locked)]
        if not removable:
            return None
        for c in cands:
            best_total = -float("inf"); best_stats = None; rm_best = None
            for rem in removable:
                new_pool = [x for x in pool if x != rem] + [c]
                st = pool_stats(new_pool, zmats, store.pr_by_role, top_x, my_role,
                                pr_weighted=pr_weighted, blind_lookup=bz)
                # Replace mode: pool size unchanged → base σs.
                total = _total_score_from_stats(st, w_in_lane, w_out_lane, w_synergy, w_blind, **base_sks)
                if np.isfinite(total) and total > best_total:
                    best_total = total; best_stats = st; rm_best = rem
            if best_stats is not None:
                rows.append({
                    "candidate": c, "remove": rm_best,
                    "new_score": best_total,
                    **_stats_delta(best_stats, base_stats, w_in_lane, w_out_lane, w_synergy, w_blind, **base_sks),
                })

    # Sort by total delta desc; secondary tiebreak by new_score
    rows.sort(key=lambda r: (r["delta_total"] is None, -(r["delta_total"] or 0)))
    return [{**r, "base_score": float(base_total)} for r in rows]


# ── Ban Recommender ───────────────────────────────────────────────────────
def ban_candidates(
    store: DataStore, my_role: str, pool: list[str],
    pr_floor: float, pr_weighted: bool,
    noise_z: float = FIXED_NOISE_Z, use_eb: bool = FIXED_USE_EB,
    use_hier: bool = FIXED_USE_HIER,
    use_hier_wide: bool = FIXED_USE_HIER_WIDE,
    shrink_alpha: float = FIXED_SHRINK_ALPHA,
) -> Optional[list[dict]]:
    if not pool:
        return None
    rows: list[dict] = []
    for pos in ROLES:
        adj = adjusted_matrix(store, "matchup", my_role, pos,
                              noise_z=noise_z, use_eb=use_eb, use_hier=use_hier,
                              use_hier_wide=use_hier_wide, shrink_alpha=shrink_alpha)
        if adj is None:
            continue
        mat, mat_rows, mat_cols = adj
        prs_pos = store.pr_by_role.get(pos, {})
        keep_cols_mask = np.array([prs_pos.get(c, 0.0) >= pr_floor for c in mat_cols])
        keep_cols = [c for c, k in zip(mat_cols, keep_cols_mask) if k]
        pool_in = [ch for ch in pool if ch in mat_rows]
        if not pool_in or not keep_cols:
            continue
        row_idx = [mat_rows.index(ch) for ch in pool_in]
        col_idx = [j for j, k in enumerate(keep_cols_mask) if k]
        sub = mat[np.ix_(row_idx, col_idx)]

        # Mirror matchup: don't suggest banning a pool member
        if pos == my_role:
            keep_mask = np.array([c not in pool_in for c in keep_cols])
            if not keep_mask.any():
                continue
            sub = sub[:, keep_mask]
            keep_cols = [c for c, k in zip(keep_cols, keep_mask) if k]
        if sub.shape[1] == 0:
            continue

        best_response = sub.max(axis=0)
        best_idx = sub.argmax(axis=0)
        best_champ = [pool_in[i] for i in best_idx]

        pr_vals = np.array([prs_pos.get(c, 0.0) for c in keep_cols])

        if pr_weighted:
            W = pr_vals.sum()
            if W <= 0:
                mu = float(best_response.mean())
                ban_score = mu - best_response
            else:
                mu = float((pr_vals * best_response).sum() / W)
                denom = np.maximum(W - pr_vals, 1e-9)
                ban_score = (pr_vals / denom) * (mu - best_response)
        else:
            mu = float(best_response.mean())
            ban_score = mu - best_response

        for j, opp in enumerate(keep_cols):
            rows.append({
                "position": pos,
                "opponent": opp,
                "pr": float(pr_vals[j]),
                "best_response": float(best_response[j]),
                "best_champ": best_champ[j],
                "ban_score": float(ban_score[j]),
            })

    if not rows:
        return None
    rows.sort(key=lambda r: r["ban_score"], reverse=True)
    return rows


# ── Pool Health: per-role coverage table + redundancy ─────────────────────
def health_table(
    store: DataStore, my_role: str, pool: list[str], mode: str,
    pr_floor: float, top_x: int, pr_weighted: bool,
    noise_z: float = FIXED_NOISE_Z, use_eb: bool = FIXED_USE_EB,
    use_hier: bool = FIXED_USE_HIER,
    use_hier_wide: bool = FIXED_USE_HIER_WIDE,
    shrink_alpha: float = FIXED_SHRINK_ALPHA,
    use_tau_blind: bool = False,
) -> Optional[list[dict]]:
    if not pool:
        return None
    threshold = MATCHUP_THRESHOLD if mode == "matchup" else SYNERGY_THRESHOLD
    positions = ROLES if mode == "matchup" else [r for r in ROLES if r != my_role]
    blind = blind_stats(store, my_role, pr_weighted=pr_weighted,
                        noise_z=noise_z, use_eb=use_eb, use_hier=use_hier,
                        use_hier_wide=use_hier_wide, shrink_alpha=shrink_alpha,
                        use_tau_blind=use_tau_blind, pr_floor=pr_floor)
    rows: list[dict] = []
    for pos in positions:
        cov = compute_coverage(store, my_role, pos, mode, pool,
                               pr_floor=pr_floor, top_x=top_x,
                               noise_z=noise_z, use_eb=use_eb, use_hier=use_hier,
                               use_hier_wide=use_hier_wide, shrink_alpha=shrink_alpha)
        if cov is None:
            continue
        n_total = len(cov.col_max_z)
        n_cov = int((cov.col_max_z >= threshold).sum())
        n_unc = n_total - n_cov
        pct = 100.0 * n_cov / n_total if n_total else 0.0
        worst = None
        if n_unc > 0:
            unc_idx = np.where(cov.col_max_z < threshold)[0]
            j = unc_idx[np.argmin(cov.col_max_z[unc_idx])]
            worst = {"champion": cov.cols[int(j)], "z": float(cov.col_max_z[j])}

        # PR-weighted means
        if pr_weighted:
            prs = store.pr_by_role.get(pos, {})
            w = np.array([max(prs.get(c, 0.0), 0.0) for c in cov.cols])
            if w.sum() > 0:
                mean_topx_z = float(np.average(cov.col_score_z, weights=w))
                mean_topx_pp = float(np.average(cov.col_score_pp, weights=w))
                mean_best_pp = float(np.average(cov.col_max_pp, weights=w))
            else:
                mean_topx_z = float(cov.col_score_z.mean())
                mean_topx_pp = float(cov.col_score_pp.mean())
                mean_best_pp = float(cov.col_max_pp.mean())
        else:
            mean_topx_z = float(cov.col_score_z.mean())
            mean_topx_pp = float(cov.col_score_pp.mean())
            mean_best_pp = float(cov.col_max_pp.mean())

        # Per-pool blindability for this (mode, pos)
        b = blind[mode].get(pos)
        blind_z = None
        if b is not None:
            ch_to_z = dict(zip(b["champs"], b["z"]))
            vs = [ch_to_z[ch] for ch in pool if ch in ch_to_z and np.isfinite(ch_to_z[ch])]
            if vs:
                blind_z = float(np.mean(vs))

        rows.append({
            "position": pos,
            "n_total": n_total, "n_covered": n_cov, "n_uncovered": n_unc,
            "pct_covered": pct,
            "mean_topx_z": mean_topx_z,
            "mean_topx_pp": mean_topx_pp,
            "mean_best_pp": mean_best_pp,
            "blind_z": blind_z,
            "worst": worst,
        })
    return rows


# ── Pool profile + redundancy ─────────────────────────────────────────────
LANE_ROLES = {
    "TOP":    ["TOP"],
    "JUNGLE": ["JUNGLE"],
    "MID":    ["MID"],
    "ADC":    ["ADC", "SUP"],
    "SUP":    ["ADC", "SUP"],
}


def build_pool_profile(
    store: DataStore, my_role: str, pool: list[str],
    noise_z: float = FIXED_NOISE_Z, use_eb: bool = FIXED_USE_EB,
    use_hier: bool = FIXED_USE_HIER,
    use_hier_wide: bool = FIXED_USE_HIER_WIDE,
    shrink_alpha: float = FIXED_SHRINK_ALPHA,
    pr_floor: float = 0.0075,
) -> Optional[dict]:
    """Return matchup/synergy/full/lane profile arrays (rows = pool, cols = concat slices)."""
    if len(pool) < 2:
        return None
    lane_set = set(LANE_ROLES.get(my_role, []))
    matchup_pieces: list[np.ndarray] = []
    synergy_pieces: list[np.ndarray] = []
    lane_pieces: list[np.ndarray] = []

    def _slice(mode: str, pos: str, prefix: str) -> Optional[np.ndarray]:
        adj = adjusted_matrix(store, mode, my_role, pos, noise_z, use_eb,
                              use_hier, use_hier_wide, shrink_alpha)
        if adj is None:
            return None
        mat, rows, cols = adj
        prs = store.pr_by_role.get(pos, {})
        keep_mask = np.array([prs.get(c, 0.0) >= pr_floor for c in cols])
        if not keep_mask.any():
            return None
        sub = mat[:, keep_mask]
        # build a (len(pool), ncols) matrix; rows missing in mat → 0
        out = np.zeros((len(pool), sub.shape[1]), dtype=np.float32)
        row_idx = {ch: i for i, ch in enumerate(rows)}
        for k, ch in enumerate(pool):
            if ch in row_idx:
                out[k] = sub[row_idx[ch]]
        return out

    for pos in ROLES:
        s = _slice("matchup", pos, f"vs_{pos}_")
        if s is not None:
            matchup_pieces.append(s)
            if pos in lane_set:
                lane_pieces.append(s)
    for pos in [r for r in ROLES if r != my_role]:
        s = _slice("synergy", pos, f"with_{pos}_")
        if s is not None:
            synergy_pieces.append(s)

    def _concat(pieces: list[np.ndarray]) -> Optional[np.ndarray]:
        if not pieces:
            return None
        return np.concatenate(pieces, axis=1)

    return {
        "rows": list(pool),
        "matchup": _concat(matchup_pieces),
        "synergy": _concat(synergy_pieces),
        "full":    _concat(matchup_pieces + synergy_pieces),
        "lane":    _concat(lane_pieces),
    }


def scope_stats(profile: Optional[np.ndarray], top_x: int) -> Optional[dict]:
    if profile is None or profile.shape[0] < 2 or profile.shape[1] == 0:
        return None
    # Pearson correlation across rows (champs)
    # np.corrcoef on the matrix (rows = champs)
    cmat = np.corrcoef(profile)
    cmat = np.where(np.isfinite(cmat), cmat, 0.0)
    n = cmat.shape[0]
    closest_cor = np.zeros(n)
    closest_idx = np.zeros(n, dtype=int)
    avg_cor = np.zeros(n)
    topx_cor = np.zeros(n)
    for i in range(n):
        others = np.delete(cmat[i], i)
        if others.size == 0:
            continue
        k = int(np.argmax(others))
        closest_cor[i] = float(others[k])
        closest_idx[i] = k if k < i else k + 1  # restore original index
        avg_cor[i] = float(others.mean())
        sorted_desc = np.sort(others)[::-1]
        eff_x = max(1, min(int(top_x), len(sorted_desc)))
        topx_cor[i] = float(sorted_desc[:eff_x].mean())
    return {
        "cor": cmat,
        "closest_cor": closest_cor,
        "closest_idx": closest_idx,
        "avg_cor": avg_cor,
        "topx_cor": topx_cor,
    }


def redundancy_data(
    store: DataStore, my_role: str, pool: list[str],
    pr_floor: float = 0.0075, top_x: int = 1,
    noise_z: float = FIXED_NOISE_Z, use_eb: bool = FIXED_USE_EB,
    use_hier: bool = FIXED_USE_HIER,
    use_hier_wide: bool = FIXED_USE_HIER_WIDE,
    shrink_alpha: float = FIXED_SHRINK_ALPHA,
) -> Optional[dict]:
    profs = build_pool_profile(store, my_role, pool, pr_floor=pr_floor,
                               noise_z=noise_z, use_eb=use_eb, use_hier=use_hier,
                               use_hier_wide=use_hier_wide, shrink_alpha=shrink_alpha)
    if profs is None or profs["full"] is None:
        return None
    full = scope_stats(profs["full"], top_x)
    if full is None:
        return None
    matchup = scope_stats(profs["matchup"], top_x)
    synergy = scope_stats(profs["synergy"], top_x)
    lane    = scope_stats(profs["lane"],    top_x)

    # Unique-best count per champ (cols where this champ has the max value)
    profile = profs["full"]
    any_pos = (profile > 0).any(axis=0)
    unique_best = np.zeros(profile.shape[0], dtype=int)
    if any_pos.any():
        sub = profile[:, any_pos]
        argmax = sub.argmax(axis=0)
        for j in argmax:
            unique_best[j] += 1

    # Hierarchical clustering for the redundancy heatmap (1 - r distance)
    cmat = full["cor"]
    n = cmat.shape[0]
    dendro_segments: list[dict] = []
    if n >= 2:
        dist = 1.0 - cmat
        iu = np.triu_indices(n, k=1)
        d = dist[iu]
        Z = linkage(d, method="average")
        order = leaves_list(Z).tolist()
        # scipy's dendrogram puts leaves at x=5,15,25,... — divide by 10 then
        # subtract 0.5 to match heatmap column indices [0..n-1].
        dgram = dendrogram(Z, no_plot=True)
        for icoord, dcoord in zip(dgram["icoord"], dgram["dcoord"]):
            dendro_segments.append({
                "x": [(v - 5.0) / 10.0 for v in icoord],
                "y": list(dcoord),
            })
    else:
        order = list(range(n))

    return {
        "rows": list(pool),
        "cor": cmat,
        "order": order,                      # dendrogram leaf order
        "dendro_segments": dendro_segments,  # list of {x: [4 vals], y: [4 vals]} per branch
        "closest_cor":  full["closest_cor"],
        "closest_idx":  full["closest_idx"],
        "avg_cor":      full["avg_cor"],
        "topx_cor":     full["topx_cor"],
        "unique_best":  unique_best,
        "matchup":      matchup,
        "synergy":      synergy,
        "lane":         lane,
        "lane_roles":   LANE_ROLES.get(my_role, []),
    }


# ── Pool Builder ──────────────────────────────────────────────────────────
def pb_combo_count(definite: list[str], maybe: list[str], target: int) -> Optional[int]:
    keeps = list(definite)
    maybes = [m for m in maybe if m not in set(keeps)]
    remaining = target - len(keeps)
    if remaining < 0 or len(maybes) < remaining:
        return None
    if remaining == 0:
        return 1
    # nCr
    from math import comb
    return comb(len(maybes), remaining)


def built_pools(
    store: DataStore, my_role: str,
    definite: list[str], maybe: list[str], target: int,
    top_x: int = 1, pr_weighted: bool = False,
    pr_floor: float = 0.0075,
    noise_z: float = FIXED_NOISE_Z, use_eb: bool = FIXED_USE_EB,
    use_hier: bool = FIXED_USE_HIER,
    use_hier_wide: bool = FIXED_USE_HIER_WIDE,
    shrink_alpha: float = FIXED_SHRINK_ALPHA,
    use_tau_blind: bool = False,
    w_in_lane: float = 1.0, w_out_lane: float = 1.0,
    w_synergy: float = 1.0, w_blind: float = 0.3,
    sigma_in_lane: float = 1.0, sigma_out_lane: float = 1.0,
    sigma_synergy: float = 1.0, sigma_blind: float = 1.0,
) -> dict:
    keeps = list(definite)
    maybes = [m for m in maybe if m not in set(keeps)]
    if len(keeps) + len(maybes) < 2:
        return {"error": "Pick at least 2 total champions across Definite + Maybe."}
    if len(keeps) > target:
        return {"error": f"You marked {len(keeps)} definite keeps but target size is {target}. Reduce keeps or raise target."}
    remaining = target - len(keeps)
    if len(maybes) < remaining:
        return {"error": f"Need {remaining} more slot(s) filled from Maybe, but only {len(maybes)} Maybe champ(s) available."}

    n_combos = pb_combo_count(keeps, maybes, target) or 1
    if n_combos > POOL_BUILDER_CAP:
        return {"error": f"Too many combinations ({n_combos:,} > {POOL_BUILDER_CAP:,}). Mark more Definites, raise target size, or remove some Maybes."}

    zmats = z_matrices(store, my_role, pr_floor=pr_floor,
                       noise_z=noise_z, use_eb=use_eb, use_hier=use_hier,
                       use_hier_wide=use_hier_wide, shrink_alpha=shrink_alpha)
    if not zmats:
        return {"error": "No coverage data for this role."}

    blind = blind_stats(store, my_role, pr_weighted=pr_weighted,
                        noise_z=noise_z, use_eb=use_eb, use_hier=use_hier,
                        use_hier_wide=use_hier_wide, shrink_alpha=shrink_alpha,
                        use_tau_blind=use_tau_blind, pr_floor=pr_floor)
    bz = blind_z_lookup(blind, my_role)

    if remaining == 0:
        combos = [tuple()]
    else:
        combos = list(combinations(maybes, remaining))

    rows: list[dict] = []
    for i, combo in enumerate(combos, start=1):
        pool = [*keeps, *combo]
        st = pool_stats(pool, zmats, store.pr_by_role, top_x, my_role,
                        pr_weighted=pr_weighted, blind_lookup=bz)
        score = _total_score_from_stats(
            st, w_in_lane, w_out_lane, w_synergy, w_blind,
            sigma_in_lane=sigma_in_lane, sigma_out_lane=sigma_out_lane,
            sigma_synergy=sigma_synergy, sigma_blind=sigma_blind,
        )
        rows.append({
            "id": i,
            "pool": sorted(pool),
            "pool_text": ", ".join(sorted(pool)),
            "score":               float(score) if np.isfinite(score) else None,
            "overall":             float(st["overall"]) if np.isfinite(st["overall"]) else None,
            "matchup_z":           float(st["matchup_z"]) if np.isfinite(st["matchup_z"]) else None,
            "matchup_in_lane":     float(st["matchup_in_lane"]) if np.isfinite(st["matchup_in_lane"]) else None,
            "matchup_out_of_lane": float(st["matchup_out_of_lane"]) if np.isfinite(st["matchup_out_of_lane"]) else None,
            "synergy_z":           float(st["synergy_z"]) if np.isfinite(st["synergy_z"]) else None,
            "lane_z":              float(st["lane_z"]) if np.isfinite(st["lane_z"]) else None,
            "blind_z":             float(st["blind_z"]) if np.isfinite(st["blind_z"]) else None,
        })
    rows = [r for r in rows if r["score"] is not None]
    rows.sort(key=lambda r: r["score"], reverse=True)
    return {"rows": rows, "n_combos": n_combos}
