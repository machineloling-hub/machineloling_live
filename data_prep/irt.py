"""Item-response theta model.

Fits a per-(champion, role) latent strength θ from raw match feathers, on
the log-odds scale. For each match we build a design row x ∈ {-1, 0, +1}
indexed by (champ, role) keys: +1 for each blue-team pick, -1 for each
red-team pick. The model is

    logit P(blue wins) = Σ_{c,r} x[c,r] · θ[c,r]

which is plain L2-regularised logistic regression with sparse features.

Why a separate model: the matchup/synergy CSVs only see pairwise wins,
which conflates a champion's own contribution with the teammates and
opponents it tends to be picked alongside. IRT controls for the full
10-pick context, so θ approximates the marginal log-odds a champion adds
to its team's win probability — a much cleaner quantity for downstream
"intrinsic strength" displays.

Outputs:
    theta_table.parquet — columns (champion, role, theta, se_theta, games)

Tier filter: only counts matches where at least one participant is in
cfg.tier (same convention as aggregate_matches.py); θ is fit on those
matches' full rosters since pick co-occurrence is what makes IRT work.
"""
from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd

from aggregate_matches import (_is_blue, _norm_champ,
                                _participant_tier_bucket, _team_won)
from refresh_config import RIOT_LANE_TO_ROLE, RefreshConfig

# L2 regularisation strength. C=1.0 / λ=1.0 on log-odds with ~roles*champs
# (~800) features and tens of thousands of matches keeps θ in a sane range
# (typical ±0.3 logits ≈ ±7 pp) without crushing the signal.
_C = 1.0
_MIN_GAMES = 30  # champ-role keys with fewer games are dropped post-fit


def _iter_match_rosters(cfg: RefreshConfig, feather_paths: list[Path]):
    """Yield (blue_keys, red_keys, blue_won) for each in-tier non-dup match.

    blue_keys / red_keys are lists of (champion, role) tuples — the five
    picks per side. blue_won is 1/0.
    """
    tier = cfg.tier
    for fp in feather_paths:
        df = pd.read_feather(fp)
        for row in df.itertuples(index=False):
            try:
                parts = json.loads(row.participants_data)
            except Exception:
                continue
            buckets = [_participant_tier_bucket(p) for p in parts]
            if tier not in buckets:
                continue
            by_role: dict[str, list[dict]] = defaultdict(list)
            for p in parts:
                role = RIOT_LANE_TO_ROLE.get(p.get("teamPosition"))
                if role:
                    by_role[role].append(p)
            # Drop duplicate-role matches (auto-fill bugs etc.).
            dup = False
            for plist in by_role.values():
                blue = sum(1 for p in plist if _is_blue(p))
                if blue > 1 or (len(plist) - blue) > 1:
                    dup = True
                    break
            if dup:
                continue
            blue_keys: list[tuple[str, str]] = []
            red_keys: list[tuple[str, str]] = []
            for role, plist in by_role.items():
                for p in plist:
                    champ = _norm_champ(p.get("championName") or "")
                    if not champ:
                        continue
                    if _is_blue(p):
                        blue_keys.append((champ, role))
                    else:
                        red_keys.append((champ, role))
            if len(blue_keys) != 5 or len(red_keys) != 5:
                continue
            winner = int(row.winner)
            # winner: 0 = blue wins, 1 = red wins.
            blue_won = 1 if winner == 0 else 0
            yield blue_keys, red_keys, blue_won


def fit_theta(cfg: RefreshConfig, feather_paths: list[Path]) -> pd.DataFrame:
    """Build the sparse design and fit. Returns the theta table DataFrame.

    SE comes from the diagonal of (XᵀWX + λI)⁻¹ where W is diag(p·(1-p))
    at the fitted probabilities — a standard Wald approximation. We
    compute it lazily by only inverting the relevant block (sklearn
    doesn't surface SEs, so we re-derive them from the design).
    """
    from scipy import sparse  # type: ignore
    from sklearn.linear_model import LogisticRegression  # type: ignore

    # First pass: collect rosters and discover the (champ, role) key set.
    rosters: list[tuple[list[tuple[str, str]], list[tuple[str, str]], int]] = []
    games: dict[tuple[str, str], int] = defaultdict(int)
    for blue, red, y in _iter_match_rosters(cfg, feather_paths):
        rosters.append((blue, red, y))
        for k in blue:
            games[k] += 1
        for k in red:
            games[k] += 1
    if not rosters:
        return pd.DataFrame(columns=["champion", "role", "theta", "se_theta", "games"])

    # Stable column order.
    keys = sorted(games.keys())
    col_idx = {k: i for i, k in enumerate(keys)}
    n_feat = len(keys)
    n_rows = len(rosters)
    print(f"[irt] {n_rows} matches, {n_feat} (champ,role) features")

    # Build CSR sparse design.
    row_ind: list[int] = []
    col_ind: list[int] = []
    data: list[int] = []
    y_arr = np.zeros(n_rows, dtype=np.int8)
    for r, (blue, red, y) in enumerate(rosters):
        y_arr[r] = y
        for k in blue:
            row_ind.append(r); col_ind.append(col_idx[k]); data.append(1)
        for k in red:
            row_ind.append(r); col_ind.append(col_idx[k]); data.append(-1)
    X = sparse.csr_matrix(
        (np.array(data, dtype=np.float32),
         (np.array(row_ind, dtype=np.int32),
          np.array(col_ind, dtype=np.int32))),
        shape=(n_rows, n_feat))

    clf = LogisticRegression(
        penalty="l2", C=_C, fit_intercept=False, solver="lbfgs",
        max_iter=200)
    clf.fit(X, y_arr)
    theta = clf.coef_.ravel().astype(np.float32)
    # Wald SEs from the regularised information matrix diagonal.
    p = clf.predict_proba(X)[:, 1]
    w = (p * (1 - p)).astype(np.float32)
    # (XᵀWX + λI)⁻¹ — compute diagonal only via solve against identity columns
    # is expensive at 800 features; do the full inverse since it's small.
    Xw = X.multiply(w[:, None])
    info = (Xw.T @ X).toarray() + (1.0 / _C) * np.eye(n_feat, dtype=np.float32)
    try:
        cov = np.linalg.inv(info)
        se = np.sqrt(np.clip(np.diag(cov), 0.0, None)).astype(np.float32)
    except np.linalg.LinAlgError:
        se = np.full(n_feat, np.nan, dtype=np.float32)

    out = pd.DataFrame({
        "champion": [k[0] for k in keys],
        "role": [k[1] for k in keys],
        "theta": theta,
        "se_theta": se,
        "games": [games[k] for k in keys],
    })
    out = out[out["games"] >= _MIN_GAMES].reset_index(drop=True)
    out = out.sort_values(["role", "theta"], ascending=[True, False]
                          ).reset_index(drop=True)
    return out


def write_theta(out_dir: Path, df: pd.DataFrame) -> Path:
    """Write theta_table.parquet to the per-tier staging directory."""
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "theta_table.parquet"
    df.to_parquet(path, index=False)
    return path
