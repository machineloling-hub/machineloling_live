"""Pool coverage computation — port of compute_coverage() from app.R.

Same per-cell noise discount + per-column z-scoring + top-X scoring logic.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np

from data import DataStore, PairMats

# Default scoring uses the bilateral hierarchical Bayesian shrinkage with
# the wide τ prior (delta_pp_shrunk_hier_wide from 02d_hier_shrink.py with
# HIER_PRIOR_SCALE=0.6). The user-facing "shrink_alpha" slider linearly
# blends the shrunk values with the raw deltas:
#     mat = alpha * shrunk_hier_wide + (1 - alpha) * raw
# alpha = 1.0 → full hier shrinkage (collapses low-N cells to ~0)
# alpha = 0.0 → raw observed deltas (max noise, no shrinkage)
# alpha = 0.7 → mostly trust the model but let low-N cells keep some signal
# Reverting blindability default to SD-based: with shrink_alpha < 1 the
# low-PR rows no longer artifactually collapse, so the original SD metric
# works as intended.
FIXED_NOISE_Z = 0.0
FIXED_USE_EB = False
FIXED_USE_HIER = False
FIXED_USE_HIER_WIDE = True
FIXED_USE_TAU_BLIND = False
FIXED_SHRINK_ALPHA = 1.0
MATCHUP_THRESHOLD = 0.75
SYNERGY_THRESHOLD = 0.5


@dataclass
class Coverage:
    rows: list[str]              # pool champions, in input order
    cols: list[str]              # opponents/partners, sorted by score desc
    mat: np.ndarray              # delta_pp, shape (n_pool, n_cols)
    mat_z: np.ndarray            # per-column z-scored deltas
    col_max_pp: np.ndarray       # per-col max delta in pp
    col_max_z: np.ndarray        # per-col max z (drives covered/uncovered)
    col_score_z: np.ndarray      # mean of top-X z values per col
    col_score_pp: np.ndarray     # mean of top-X delta values per col
    best_row_idx: np.ndarray     # int row index of the best pool pick per col
    top_idx_mat: np.ndarray      # shape (top_x, n_cols) — indices for outlines
    top_x: int


def _adjusted_matrix(pair: PairMats, noise_z: float, use_eb: bool,
                     use_hier: bool = FIXED_USE_HIER,
                     use_hier_wide: bool = FIXED_USE_HIER_WIDE,
                     shrink_alpha: float = FIXED_SHRINK_ALPHA) -> np.ndarray:
    """Return the per-cell shrunk delta matrix used for scoring.

    `shrink_alpha` linearly blends the chosen shrunk matrix with the raw
    deltas: `alpha * shrunk + (1 - alpha) * raw`. Only applied to the hier
    variants (where strong shrinkage of low-N cells is the issue); the
    SE/EB/raw modes ignore it.
    """
    if use_hier_wide:
        shrunk = pair.shrunk_hier_wide
    elif use_hier:
        shrunk = pair.shrunk_hier
    elif use_eb:
        return pair.shrunk.copy()
    elif noise_z <= 0:
        return pair.raw.copy()
    else:
        return np.sign(pair.raw) * np.maximum(
            0.0, np.abs(pair.raw) - noise_z * pair.se_pp
        )
    # Hier branch: optional blend with raw to soften shrinkage on low-N cells.
    a = float(np.clip(shrink_alpha, 0.0, 1.0))
    if a >= 1.0:
        return shrunk.copy()
    if a <= 0.0:
        return pair.raw.copy()
    return (a * shrunk + (1.0 - a) * pair.raw).astype(shrunk.dtype)


def _zscored_columns(mat: np.ndarray) -> np.ndarray:
    """Per-column (axis=0) z-score across the FULL role distribution."""
    means = np.nanmean(mat, axis=0)
    sds = np.nanstd(mat, axis=0, ddof=1)
    safe = np.where(np.isnan(sds) | (sds < 1e-9), 1.0, sds)
    z = (mat - means) / safe
    z[~np.isfinite(z)] = 0.0
    return z


def compute_coverage(
    store: DataStore,
    my_role: str,
    other_role: str,
    mode: str,                # "matchup" | "synergy"
    pool: list[str],
    pr_floor: float,          # fraction (0.0075 = 0.75%)
    noise_z: float = FIXED_NOISE_Z,
    use_eb: bool = FIXED_USE_EB,
    use_hier: bool = FIXED_USE_HIER,
    use_hier_wide: bool = FIXED_USE_HIER_WIDE,
    shrink_alpha: float = FIXED_SHRINK_ALPHA,
    top_x: int = 1,
    extra_rows: Optional[list[str]] = None,   # display-only rows appended
                                              # AFTER scoring is locked in;
                                              # don't influence top_idx_mat /
                                              # col_score_z / col_score_pp
) -> Optional[Coverage]:
    if not pool:
        return None

    pairs = store.matchup if mode == "matchup" else store.synergy
    pair = pairs.get(my_role, {}).get(other_role)
    if pair is None:
        return None

    mat_full = _adjusted_matrix(pair, noise_z, use_eb, use_hier, use_hier_wide, shrink_alpha)
    z_full = _zscored_columns(mat_full)

    rows_full = pair.rows
    cols_full = pair.cols
    row_idx = {ch: i for i, ch in enumerate(rows_full)}
    col_idx = {ch: j for j, ch in enumerate(cols_full)}

    # filter columns by user PR floor (relative to OTHER role)
    pr_other = store.pr_by_role.get(other_role, {})
    keep_cols = [c for c in cols_full if pr_other.get(c, 0.0) >= pr_floor]

    pool_in_mat = [ch for ch in pool if ch in row_idx]
    if not pool_in_mat or not keep_cols:
        return None

    pool_idx = np.array([row_idx[ch] for ch in pool_in_mat])
    kept_idx = np.array([col_idx[c] for c in keep_cols])
    sub = mat_full[np.ix_(pool_idx, kept_idx)]
    sub_z = z_full[np.ix_(pool_idx, kept_idx)]

    # mirror matchup (same role on both sides): a pool member CAN appear as
    # a comparator opponent for the others — only the self-cell (row champ
    # == col champ) is meaningless. Mask those cells with -inf so they're
    # excluded from max/argsort but the column itself stays.
    if mode == "matchup" and my_role == other_role:
        diag_mask = np.zeros_like(sub, dtype=bool)
        col_pos = {c: j for j, c in enumerate(keep_cols)}
        for i, row_ch in enumerate(pool_in_mat):
            j = col_pos.get(row_ch)
            if j is not None:
                diag_mask[i, j] = True
        if diag_mask.any():
            sub_for_score = np.where(diag_mask, -np.inf, sub)
            sub_z_for_score = np.where(diag_mask, -np.inf, sub_z)
        else:
            sub_for_score = sub
            sub_z_for_score = sub_z
    else:
        sub_for_score = sub
        sub_z_for_score = sub_z

    if sub.shape[1] == 0:
        return None

    n_pool = sub.shape[0]
    eff_x = max(1, min(int(top_x), n_pool))

    col_max_pp = sub_for_score.max(axis=0)
    col_max_z = sub_z_for_score.max(axis=0)

    # top-X row indices per column, picked on z-score
    # argsort ascending, take last eff_x, reverse to descending. Masked
    # (-inf) rows naturally land at the bottom; we then nan-out any -inf
    # picks so the mean reflects only valid pool members.
    top_idx_mat = np.argsort(sub_z_for_score, axis=0)[-eff_x:][::-1]

    cols_arange = np.arange(sub.shape[1])
    picked_z = sub_z_for_score[top_idx_mat, cols_arange]
    picked_pp = sub[top_idx_mat, cols_arange]
    finite = np.isfinite(picked_z)
    picked_z_clean = np.where(finite, picked_z, np.nan)
    picked_pp_clean = np.where(finite, picked_pp, np.nan)
    col_score_z = np.nanmean(picked_z_clean, axis=0)
    col_score_pp = np.nanmean(picked_pp_clean, axis=0)
    best_row_idx = top_idx_mat[0]

    # sort columns by descending top-X mean z
    ord_ = np.argsort(-col_score_z, kind="stable")
    sorted_cols = [keep_cols[i] for i in ord_]

    final_rows = list(pool_in_mat)
    final_mat = sub[:, ord_]
    final_mat_z = sub_z[:, ord_]

    # Append display-only rows for any champion in `extra_rows` (used by the
    # Replacement Finder to show the dropped champ as a reference row at the
    # bottom of the heatmap). These rows do NOT participate in scoring —
    # top_idx_mat, col_score_z/pp, best_row_idx all index only into the
    # actual pool above.
    if extra_rows:
        extra_in_mat = [c for c in extra_rows if c in row_idx and c not in pool_in_mat]
        if extra_in_mat:
            extra_idx = np.array([row_idx[c] for c in extra_in_mat])
            extra_sub = mat_full[np.ix_(extra_idx, kept_idx)][:, ord_]
            extra_z   = z_full  [np.ix_(extra_idx, kept_idx)][:, ord_]
            final_rows = final_rows + extra_in_mat
            final_mat   = np.vstack([final_mat, extra_sub])
            final_mat_z = np.vstack([final_mat_z, extra_z])

    return Coverage(
        rows=final_rows,
        cols=sorted_cols,
        mat=final_mat,
        mat_z=final_mat_z,
        col_max_pp=col_max_pp[ord_],
        col_max_z=col_max_z[ord_],
        col_score_z=col_score_z[ord_],
        col_score_pp=col_score_pp[ord_],
        best_row_idx=best_row_idx[ord_],
        top_idx_mat=top_idx_mat[:, ord_],
        top_x=eff_x,
    )


def coverage_stats(
    cov: Coverage,
    other_role: str,
    threshold: float,
    pr_by_role: dict[str, dict[str, float]],
    pr_weighted: bool,
) -> dict:
    """Summary stats for the banner above each heatmap."""
    n_total = len(cov.col_max_z)
    n_cov = int((cov.col_max_z >= threshold).sum())
    n_unc = n_total - n_cov

    if pr_weighted:
        prs = pr_by_role.get(other_role, {})
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

    return {
        "n_total": n_total,
        "n_covered": n_cov,
        "n_uncovered": n_unc,
        "threshold": threshold,
        "mean_topx_z": mean_topx_z,
        "mean_topx_pp": mean_topx_pp,
        "mean_best_pp": mean_best_pp,
        "top_x": cov.top_x,
    }


def uncovered_list(cov: Coverage, threshold: float) -> list[dict]:
    """Sorted-worst-first list of uncovered columns with best-pool-pick context."""
    mask = cov.col_max_z < threshold
    if not mask.any():
        return []
    out = []
    idx = np.where(mask)[0]
    # sort worst-first (lowest z first)
    idx = idx[np.argsort(cov.col_max_z[idx])]
    for j in idx:
        out.append({
            "champion": cov.cols[j],
            "best_pool_pick": cov.rows[int(cov.best_row_idx[j])],
            "max_z": float(cov.col_max_z[j]),
            "max_pp": float(cov.col_max_pp[j]),
        })
    return out
