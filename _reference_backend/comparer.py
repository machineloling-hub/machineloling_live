"""Champion-vs-champion correlation comparer.

Mirrors the static `explorer.html` ("Champion Correlation Explorer") at
machineloling-hub.github.io/champion-ecosystem/explorer.html, but driven by
the live FastAPI data layer so PR-floor / PR-weighted / patch / shrink
controls in the sidebar all flow through.

For a selected (role, champion):
  - Builds the champion's matchup vector (pp deltas vs every opponent
    across all 5 roles) and synergy vector (pp deltas with every partner
    across the other 4 roles), filtered by the PR floor.
  - Computes Pearson correlation of those vectors against every other
    champion at the same role: matchup-only, synergy-only, and average
    (the "total" sort key).
  - For each comparison champ B, picks top-3 "Both Strong / Both Weak /
    Most Different" matchup or synergy columns to display alongside.
  - Looks up B's aggregate blindability z from `ports.blind_stats`.

Heavy lift is one np.hstack of column-z-scored slabs and one masked
matrix-vector multiply, so a single request scales linearly with the
number of eligible champions × columns (~150 × ~600 = trivial).
"""
from __future__ import annotations

from typing import Optional

import numpy as np

import ports
from data import DataStore, ROLES


def _weighted_corr_with_row(M: np.ndarray, sel_idx: int,
                            weights: Optional[np.ndarray]) -> np.ndarray:
    """Correlation of M[sel_idx] against every row of M (Pearson, optional weights).

    Returns shape (n_rows,) with NaN for rows whose weighted variance is 0.
    """
    n_rows, n_cols = M.shape
    if n_cols < 2:
        return np.full(n_rows, np.nan)

    if weights is None:
        # Plain Pearson — center each row, divide by row-norm.
        row_mean = M.mean(axis=1, keepdims=True)
        Mc = M - row_mean
        row_norm = np.linalg.norm(Mc, axis=1)
        sel = Mc[sel_idx]
        sel_norm = row_norm[sel_idx]
        if sel_norm == 0:
            return np.full(n_rows, np.nan)
        out = (Mc @ sel) / np.where(row_norm == 0, np.nan, row_norm) / sel_norm
        return out

    w = np.asarray(weights, dtype=np.float64)
    sw = w.sum()
    if sw <= 0:
        return np.full(n_rows, np.nan)
    row_mean = (M * w).sum(axis=1, keepdims=True) / sw
    Mc = M - row_mean
    row_var = (w * Mc * Mc).sum(axis=1) / sw
    row_sd = np.sqrt(np.where(row_var > 0, row_var, np.nan))
    sel = Mc[sel_idx]
    sel_sd = row_sd[sel_idx]
    if not np.isfinite(sel_sd) or sel_sd == 0:
        return np.full(n_rows, np.nan)
    cov = (Mc * w * sel).sum(axis=1) / sw
    out = cov / (row_sd * sel_sd)
    return out


def champion_correlation(
    store: DataStore,
    my_role: str,
    selected_champ: str,
    pr_floor: float,
    pr_weighted: bool,
    shrink_kwargs: dict,
    blind_kwargs: dict,
) -> Optional[dict]:
    """See module docstring."""
    if my_role not in ROLES:
        return None

    z_mats = ports.z_matrices(store, my_role, pr_floor=pr_floor, **shrink_kwargs)
    if not z_mats:
        return None

    # Every slab returned by z_matrices shares the same `rows` (champs at
    # my_role from PairMats.rows, which load_all aligns at PR_LOAD_FLOOR).
    first_key = next(iter(z_mats))
    rows: list[str] = z_mats[first_key]["rows"]

    if selected_champ not in rows:
        return None
    sel_idx = rows.index(selected_champ)

    matchup_slabs: list[tuple[str, list[str], np.ndarray, np.ndarray]] = []
    synergy_slabs: list[tuple[str, list[str], np.ndarray, np.ndarray]] = []
    for key, slab in z_mats.items():
        mode, pos = key.split("_", 1)
        pp = slab["pp"].astype(np.float64)  # shape (n_rows, n_cols_pos)
        cols = slab["cols"]
        # Per-column pick-rate weights (PR-weighted correlation).
        prs = store.pr_by_role.get(pos, {})
        w = np.array([float(prs.get(c, 0.0)) for c in cols], dtype=np.float64)
        if mode == "matchup":
            matchup_slabs.append((pos, cols, pp, w))
        else:
            synergy_slabs.append((pos, cols, pp, w))

    M_match = (np.hstack([s[2] for s in matchup_slabs])
               if matchup_slabs else np.zeros((len(rows), 0), dtype=np.float64))
    M_syn = (np.hstack([s[2] for s in synergy_slabs])
             if synergy_slabs else np.zeros((len(rows), 0), dtype=np.float64))
    w_match = (np.concatenate([s[3] for s in matchup_slabs])
               if matchup_slabs else np.zeros(0))
    w_syn = (np.concatenate([s[3] for s in synergy_slabs])
             if synergy_slabs else np.zeros(0))

    # Per-column block descriptor — "vs ROLE_Champ" / "with ROLE_Champ".
    blocks: list[tuple[str, str, str]] = []
    for pos, cols, _, _ in matchup_slabs:
        blocks.extend(("vs", pos, c) for c in cols)
    for pos, cols, _, _ in synergy_slabs:
        blocks.extend(("with", pos, c) for c in cols)

    weights_arg = (
        (w_match if M_match.shape[1] else None,
         w_syn if M_syn.shape[1] else None)
        if pr_weighted else (None, None)
    )
    corr_match = _weighted_corr_with_row(M_match, sel_idx, weights_arg[0]) \
        if M_match.shape[1] else np.full(len(rows), np.nan)
    corr_syn = _weighted_corr_with_row(M_syn, sel_idx, weights_arg[1]) \
        if M_syn.shape[1] else np.full(len(rows), np.nan)
    # Total = mean of the two correlations (treats missing component as
    # absent from the average — same as the static explorer).
    have_m = ~np.isnan(corr_match)
    have_s = ~np.isnan(corr_syn)
    both = have_m & have_s
    only_m = have_m & ~have_s
    only_s = have_s & ~have_m
    corr_total = np.full(len(rows), np.nan)
    corr_total[both] = (corr_match[both] + corr_syn[both]) * 0.5
    corr_total[only_m] = corr_match[only_m]
    corr_total[only_s] = corr_syn[only_s]

    # Concatenate the matchup and synergy spaces for the per-row top-3
    # Strong/Weak/Disagree picks. We classify on raw pp (signed delta), not
    # z-scored — same convention as the original explorer.
    M_full = np.hstack([M_match, M_syn])
    sel_vec = M_full[sel_idx]
    blocks_arr = np.array(blocks, dtype=object)
    drop_self_per_col = blocks_arr[:, 2]  # column champion name

    # Blindability lookup
    blind = ports.blind_stats(
        store, my_role, pr_weighted=pr_weighted, pr_floor=pr_floor,
        **shrink_kwargs, **blind_kwargs,
    )
    blind_z = ports.blind_z_lookup(blind, my_role)

    rows_out = []
    for j, ch in enumerate(rows):
        if ch == selected_champ:
            continue
        ch_vec = M_full[j]
        # Mask out the self-cell column (where col-champion == this row's
        # champion in the mirror-matchup slab) so we don't recommend "vs Ezreal"
        # when the row IS Ezreal.
        self_mask = (drop_self_per_col == ch)

        # Both Strong: top 3 by min(sel, ch), among cols where both > 0.
        both_pos = (sel_vec > 0) & (ch_vec > 0) & ~self_mask
        # Both Weak: top 3 by -max(sel, ch) (most-negative max), among both < 0.
        both_neg = (sel_vec < 0) & (ch_vec < 0) & ~self_mask
        # Disagree: signs opposite, sort by |diff| desc.
        disagree = ((sel_vec > 0) & (ch_vec < 0)) | ((sel_vec < 0) & (ch_vec > 0))
        disagree &= ~self_mask

        def _pack(idxs: np.ndarray) -> list[dict]:
            return [
                {
                    "block": f"{blocks[i][0]} {blocks[i][1]}_{blocks[i][2]}",
                    "ch_delta": round(float(sel_vec[i]), 1),
                    "partner_delta": round(float(ch_vec[i]), 1),
                }
                for i in idxs
            ]

        strong: list[dict] = []
        if both_pos.any():
            cand = np.where(both_pos)[0]
            scores = np.minimum(sel_vec[cand], ch_vec[cand])
            strong = _pack(cand[np.argsort(-scores)[:3]])
        weak: list[dict] = []
        if both_neg.any():
            cand = np.where(both_neg)[0]
            scores = np.maximum(sel_vec[cand], ch_vec[cand])
            weak = _pack(cand[np.argsort(scores)[:3]])
        diff_rows: list[dict] = []
        if disagree.any():
            cand = np.where(disagree)[0]
            scores = np.abs(sel_vec[cand] - ch_vec[cand])
            diff_rows = _pack(cand[np.argsort(-scores)[:3]])

        bz = blind_z.get(ch)
        bz_val = (round(float(bz), 3)
                  if bz is not None and np.isfinite(bz) else None)
        rows_out.append({
            "champion": ch,
            "total": (round(float(corr_total[j]), 3)
                      if np.isfinite(corr_total[j]) else None),
            "matchup": (round(float(corr_match[j]), 3)
                        if np.isfinite(corr_match[j]) else None),
            "synergy": (round(float(corr_syn[j]), 3)
                        if np.isfinite(corr_syn[j]) else None),
            "blind_z": bz_val,
            "strong": strong,
            "weak": weak,
            "disagree": diff_rows,
        })

    # Selected champion's headline info — games / WR / PR for the current
    # patch's PR table (store is already swapped to req.patch upstream).
    ind_wr = store.ind_wr
    sel_row = ind_wr[(ind_wr["role"] == my_role) &
                     (ind_wr["champion"] == selected_champ)]
    if len(sel_row):
        info = {
            "games": int(sel_row["games"].iloc[0]),
            "win_rate": round(float(sel_row["win_rate"].iloc[0]) * 100, 2),
            "pick_rate": round(float(sel_row["pick_rate"].iloc[0]) * 100, 2),
        }
    else:
        info = {"games": 0, "win_rate": 0.0, "pick_rate": 0.0}
    sel_bz = blind_z.get(selected_champ)
    info["blind_z"] = (round(float(sel_bz), 3)
                       if sel_bz is not None and np.isfinite(sel_bz) else None)

    return {
        "champion": selected_champ,
        "role": my_role,
        "info": info,
        "rows": rows_out,
    }
