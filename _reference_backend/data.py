"""Load matchup/synergy CSVs into in-memory matrices at startup.

Mirrors the R loader in ../../deploy_pool_designer_shinylive/app.R lines 113-258.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Optional

import numpy as np
import pandas as pd

ROLES = ["TOP", "JUNGLE", "MID", "ADC", "SUP"]
PR_LOAD_FLOOR = 0.001  # 0.1% — same as R

DEFAULT_DATA_DIR = (
    Path(__file__).resolve().parents[2] / "deploy_pool_designer_shinylive" / "data"
)


@dataclass
class PairMats:
    """Aligned matrices for a single (role_a, role_b) pair.

    Rows = champions at role_a (pool side); cols = champions at role_b.
    """
    rows: list[str]
    cols: list[str]
    shrunk: np.ndarray            # delta_pp_shrunk (file-level empirical Bayes)
    shrunk_hier: np.ndarray       # delta_pp_shrunk_hier (per-champion HMC, σ_τ~HN(0.3))
    shrunk_hier_wide: np.ndarray  # delta_pp_shrunk_hier_wide (HMC, σ_τ~HN(0.6))
    raw: np.ndarray               # delta * 100 (raw delta in percentage points)
    games: np.ndarray             # sample size per cell
    se_pp: np.ndarray             # binomial SE in pp
    # Per-champion τ from the bilateral hierarchical fit. NaN where the
    # sidecar file is missing or a champion isn't in it. Used by the
    # τ-based blindability metric (low τ = blindable). Two variants:
    # tight prior (σ_τ~HN(0.3)) and wide prior (σ_τ~HN(0.6)).
    tau_rows: np.ndarray          # shape (len(rows),) — τ_a per row champion
    tau_cols: np.ndarray          # shape (len(cols),) — τ_b per col champion
    tau_rows_wide: np.ndarray     # wide-prior τ_a
    tau_cols_wide: np.ndarray     # wide-prior τ_b


@dataclass
class DataStore:
    ind_wr: pd.DataFrame
    pr_by_role: Dict[str, Dict[str, float]]
    matchup: Dict[str, Dict[str, PairMats]] = field(default_factory=dict)
    synergy: Dict[str, Dict[str, PairMats]] = field(default_factory=dict)
    valid_champs: Dict[str, list[str]] = field(default_factory=dict)
    # Per-patch pick-rate tables loaded from lolalytics CSV. Keyed by
    # patch (str like "16.8") → role (str) → champion (str) → pick_rate (frac).
    pr_by_patch: Dict[str, Dict[str, Dict[str, float]]] = field(default_factory=dict)
    patches: list[str] = field(default_factory=list)
    latest_patch: Optional[str] = None


# Lolalytics champion-name → our champion-name mapping
LOL_TO_OURS = {
    "Aurelion Sol":   "AurelionSol",
    "Bel'Veth":       "Belveth",
    "Cho'Gath":       "Chogath",
    "Dr. Mundo":      "DrMundo",
    "Fiddlesticks":   "FiddleSticks",
    "Jarvan IV":      "JarvanIV",
    "K'Sante":        "KSante",
    "Kai'Sa":         "Kaisa",
    "Kha'Zix":        "Khazix",
    "Kog'Maw":        "KogMaw",
    "LeBlanc":        "Leblanc",
    "Lee Sin":        "LeeSin",
    "Master Yi":      "MasterYi",
    "Miss Fortune":   "MissFortune",
    "Nunu & Willump": "Nunu",
    "Rek'Sai":        "RekSai",
    "Renata Glasc":   "Renata",
    "Tahm Kench":     "TahmKench",
    "Twisted Fate":   "TwistedFate",
    "Vel'Koz":        "Velkoz",
    # "Wukong" stays "Wukong" — see DISPLAY_RENAMES below.
    "Xin Zhao":       "XinZhao",
}

LOL_LANE_TO_ROLE = {
    "top":      "TOP",
    "jungle":   "JUNGLE",
    "middle":   "MID",
    "bottom":   "ADC",
    "support":  "SUP",  # lolalytics legacy scrape
    "utility":  "SUP",  # refreshed pipeline (inverse of RIOT_LANE_TO_ROLE)
}


def _load_ind_wr(data_dir: Path) -> pd.DataFrame:
    df = pd.read_csv(data_dir / "individual_wr.csv")
    # add total_games + pick_rate per role
    df["total_games"] = df.groupby("role")["games"].transform("sum")
    df["pick_rate"] = df["games"] / df["total_games"]
    return df


def _valid_champs(ind_wr: pd.DataFrame, role: str, floor: float) -> list[str]:
    sub = ind_wr[(ind_wr["role"] == role) & (ind_wr["pick_rate"] >= floor)]
    return sub["champion"].tolist()


def _load_tau_sidecar(
    data_dir: Path, csv_filename: str, role_a: str, role_b: str,
    variant: str = "",
) -> tuple[Dict[str, float], Dict[str, float]]:
    """Load tau{variant}_<csv_filename> sidecar; return (tau_a_by_champ, tau_b_by_champ).

    `variant=""` loads the default prior fit; `variant="_wide"` loads the
    wide-prior variant. Empty dicts if the file is missing.
    """
    path = data_dir / f"tau{variant}_{csv_filename}"
    if not path.exists():
        return {}, {}
    df = pd.read_csv(path)
    tau_a: Dict[str, float] = {}
    tau_b: Dict[str, float] = {}
    for ch, role, t in zip(df["champion"], df["role"], df["tau"]):
        if role == role_a:
            tau_a[str(ch)] = float(t)
        if role == role_b:
            tau_b[str(ch)] = float(t)
    # Same-role: file has only role_a rows, so mirror them as role_b too.
    if role_a == role_b and not tau_b:
        tau_b = dict(tau_a)
    return tau_a, tau_b


def _build_pair(
    df: pd.DataFrame,
    role_a: str,
    role_b: str,
    valid_a: list[str],
    valid_b: list[str],
    mirror_diag: bool,
    transpose: bool,
    tau_a_lookup: Dict[str, float] | None = None,
    tau_b_lookup: Dict[str, float] | None = None,
    tau_a_wide_lookup: Dict[str, float] | None = None,
    tau_b_wide_lookup: Dict[str, float] | None = None,
) -> PairMats | None:
    """Build aligned matrices from a long-form CSV.

    The CSV's first column is the row champion, second is the column champion.
    `transpose=True` means the file stores (b, a) but we want (a, b).
    """
    cols = list(df.columns)
    a_col, b_col = (cols[1], cols[0]) if transpose else (cols[0], cols[1])

    df = df[df[a_col].isin(valid_a) & df[b_col].isin(valid_b)]
    if df.empty:
        return None

    # se_pp: prefer column from CSV; fall back to binomial SE
    if "se_pp" in df.columns:
        se_vals = df["se_pp"].to_numpy()
    else:
        p = df["observed_wr"].clip(0, 1).to_numpy()
        n = df["games"].clip(lower=1).to_numpy()
        se_vals = 100.0 * np.sqrt(p * (1.0 - p) / n)

    # pivot to wide for each metric
    def _pivot(values: np.ndarray, fill: float = 0.0) -> tuple[list[str], list[str], np.ndarray]:
        tmp = pd.DataFrame({"a": df[a_col].to_numpy(), "b": df[b_col].to_numpy(), "v": values})
        wide = tmp.pivot_table(index="a", columns="b", values="v", aggfunc="first")
        wide = wide.fillna(fill)
        rows = list(wide.index)
        cols_ = list(wide.columns)
        # Newer pandas returns a read-only view from to_numpy(); force a
        # writable copy so the mirror_diag zero-out below doesn't blow up.
        mat = np.array(wide.to_numpy(dtype=np.float32), copy=True)
        return rows, cols_, mat

    rows, cols_, mat_shrunk = _pivot(df["delta_pp_shrunk"].to_numpy())
    _, _, mat_raw = _pivot((df["delta"] * 100.0).to_numpy())
    _, _, mat_games = _pivot(df["games"].to_numpy(), fill=0.0)
    _, _, mat_se = _pivot(se_vals)

    # Hierarchical (bilateral HMC) shrunk values — fall back to file-level
    # EB if the column isn't present yet (older CSVs from before 02d_*).
    if "delta_pp_shrunk_hier" in df.columns:
        _, _, mat_shrunk_hier = _pivot(df["delta_pp_shrunk_hier"].to_numpy())
    else:
        mat_shrunk_hier = mat_shrunk.copy()
    # Wide-prior variant (σ_τ ~ HN(0.6)) — falls back to the tight-prior
    # version when its column isn't present.
    if "delta_pp_shrunk_hier_wide" in df.columns:
        _, _, mat_shrunk_hier_wide = _pivot(df["delta_pp_shrunk_hier_wide"].to_numpy())
    else:
        mat_shrunk_hier_wide = mat_shrunk_hier.copy()

    # alignment: pivot_table sorts both axes alphabetically, so all share rows/cols
    if mirror_diag:
        # zero out self-cells (Caitlyn vs Caitlyn etc.) to avoid spurious diag
        for ch in set(rows) & set(cols_):
            i = rows.index(ch)
            j = cols_.index(ch)
            mat_shrunk[i, j] = 0.0
            mat_shrunk_hier[i, j] = 0.0
            mat_shrunk_hier_wide[i, j] = 0.0
            mat_raw[i, j] = 0.0
            mat_games[i, j] = 0.0
            mat_se[i, j] = 0.0

    # NOTE: don't transpose the result — we already swapped a_col/b_col so the
    # pivot's index already corresponds to role_a (rows) and columns to role_b.

    # Per-champion τ from the bilateral hier fit; NaN where missing.
    if tau_a_lookup is None: tau_a_lookup = {}
    if tau_b_lookup is None: tau_b_lookup = {}
    if tau_a_wide_lookup is None: tau_a_wide_lookup = {}
    if tau_b_wide_lookup is None: tau_b_wide_lookup = {}
    tau_rows = np.array(
        [float(tau_a_lookup.get(c, np.nan)) for c in rows], dtype=np.float32,
    )
    tau_cols = np.array(
        [float(tau_b_lookup.get(c, np.nan)) for c in cols_], dtype=np.float32,
    )
    tau_rows_wide = np.array(
        [float(tau_a_wide_lookup.get(c, np.nan)) for c in rows], dtype=np.float32,
    )
    tau_cols_wide = np.array(
        [float(tau_b_wide_lookup.get(c, np.nan)) for c in cols_], dtype=np.float32,
    )

    return PairMats(
        rows=rows,
        cols=cols_,
        shrunk=mat_shrunk,
        shrunk_hier=mat_shrunk_hier,
        shrunk_hier_wide=mat_shrunk_hier_wide,
        raw=mat_raw,
        games=mat_games,
        se_pp=mat_se,
        tau_rows=tau_rows,
        tau_cols=tau_cols,
        tau_rows_wide=tau_rows_wide,
        tau_cols_wide=tau_cols_wide,
    )


def load_all(data_dir: str | Path | None = None) -> DataStore:
    """Load every matchup/synergy CSV and build the in-memory store."""
    data_dir = Path(data_dir) if data_dir else DEFAULT_DATA_DIR
    if not data_dir.exists():
        raise FileNotFoundError(f"Data dir not found: {data_dir}")

    print(f"[data] loading from {data_dir}")
    ind_wr = _load_ind_wr(data_dir)

    pr_by_role: Dict[str, Dict[str, float]] = {}
    valid_champs: Dict[str, list[str]] = {}
    for r in ROLES:
        sub = ind_wr[ind_wr["role"] == r]
        pr_by_role[r] = dict(zip(sub["champion"], sub["pick_rate"]))
        valid_champs[r] = _valid_champs(ind_wr, r, PR_LOAD_FLOOR)

    matchup: Dict[str, Dict[str, PairMats]] = {r: {} for r in ROLES}
    synergy: Dict[str, Dict[str, PairMats]] = {r: {} for r in ROLES}

    for ra in ROLES:
        for rb in ROLES:
            mp_path = data_dir / f"matchup_{ra}_vs_{rb}.csv"
            if mp_path.exists():
                df = pd.read_csv(mp_path)
                tau_a, tau_b = _load_tau_sidecar(data_dir, mp_path.name, ra, rb)
                tau_a_w, tau_b_w = _load_tau_sidecar(
                    data_dir, mp_path.name, ra, rb, variant="_wide",
                )
                pair = _build_pair(
                    df, ra, rb, valid_champs[ra], valid_champs[rb],
                    mirror_diag=(ra == rb), transpose=False,
                    tau_a_lookup=tau_a, tau_b_lookup=tau_b,
                    tau_a_wide_lookup=tau_a_w, tau_b_wide_lookup=tau_b_w,
                )
                if pair is not None:
                    matchup[ra][rb] = pair
            if ra != rb:
                # synergy CSV may be stored as (ra, rb) or (rb, ra) — try both
                sp_path = data_dir / f"synergy_{ra}_{rb}.csv"
                transpose = False
                if not sp_path.exists():
                    sp_path = data_dir / f"synergy_{rb}_{ra}.csv"
                    transpose = True
                if sp_path.exists():
                    df = pd.read_csv(sp_path)
                    # τ sidecar is keyed by the FILE's role_a/role_b. When we
                    # transpose for a (rb, ra)-stored file, the file's role_a
                    # is rb and role_b is ra, so swap the lookups.
                    if transpose:
                        file_ra, file_rb = rb, ra
                        ta_f, tb_f = _load_tau_sidecar(
                            data_dir, sp_path.name, file_ra, file_rb,
                        )
                        ta_fw, tb_fw = _load_tau_sidecar(
                            data_dir, sp_path.name, file_ra, file_rb, variant="_wide",
                        )
                        tau_a, tau_b = tb_f, ta_f
                        tau_a_w, tau_b_w = tb_fw, ta_fw
                    else:
                        tau_a, tau_b = _load_tau_sidecar(
                            data_dir, sp_path.name, ra, rb,
                        )
                        tau_a_w, tau_b_w = _load_tau_sidecar(
                            data_dir, sp_path.name, ra, rb, variant="_wide",
                        )
                    pair = _build_pair(
                        df, ra, rb, valid_champs[ra], valid_champs[rb],
                        mirror_diag=False, transpose=transpose,
                        tau_a_lookup=tau_a, tau_b_lookup=tau_b,
                        tau_a_wide_lookup=tau_a_w, tau_b_wide_lookup=tau_b_w,
                    )
                    if pair is not None:
                        synergy[ra][rb] = pair

    n_matchup = sum(len(v) for v in matchup.values())
    n_synergy = sum(len(v) for v in synergy.values())
    print(f"[data] loaded {n_matchup} matchup pairs, {n_synergy} synergy pairs")

    # Per-patch pick-rate table from lolalytics CSV (sibling to backend dir).
    pr_by_patch, patches, latest_patch = _load_patch_pr_table()

    store = DataStore(
        ind_wr=ind_wr,
        pr_by_role=pr_by_role,
        matchup=matchup,
        synergy=synergy,
        valid_champs=valid_champs,
        pr_by_patch=pr_by_patch,
        patches=patches,
        latest_patch=latest_patch,
    )
    _apply_display_renames(store)
    return store


# Display-name overrides. CSVs use Riot's internal IDs (e.g. "MonkeyKing"),
# but users know champions by their in-game name (e.g. "Wukong"). Rename
# at load time so the rest of the codebase — and every API response —
# uses the user-facing name. The frontend's CDRAGON_NAME_FIX maps these
# back to the icon-CDN slug ("Wukong" → "monkeyking").
DISPLAY_RENAMES = {
    "MonkeyKing": "Wukong",
}


def _apply_display_renames(store: DataStore) -> None:
    """In-place rename of every champion-name occurrence in the store."""
    if not DISPLAY_RENAMES:
        return
    rn = DISPLAY_RENAMES

    # ind_wr DataFrame
    store.ind_wr["champion"] = store.ind_wr["champion"].replace(rn)

    # pr_by_role: dict[role, dict[champion, pr]]
    for role, prs in store.pr_by_role.items():
        store.pr_by_role[role] = {rn.get(c, c): v for c, v in prs.items()}

    # valid_champs: dict[role, list[champion]]
    for role, champs in store.valid_champs.items():
        store.valid_champs[role] = [rn.get(c, c) for c in champs]

    # matchup / synergy: PairMats.rows and .cols are lists of champion names.
    # PairMats is frozen=False dataclass so direct mutation works.
    for pair_dict in (store.matchup, store.synergy):
        for ra in pair_dict:
            for rb, pair in pair_dict[ra].items():
                pair.rows = [rn.get(c, c) for c in pair.rows]
                pair.cols = [rn.get(c, c) for c in pair.cols]

    # pr_by_patch: dict[patch, dict[role, dict[champion, pr]]]
    for patch, by_role in store.pr_by_patch.items():
        for role, prs in by_role.items():
            by_role[role] = {rn.get(c, c): v for c, v in prs.items()}


def _load_patch_pr_table() -> tuple[Dict[str, Dict[str, Dict[str, float]]], list[str], Optional[str]]:
    """Load per-rank lolalytics PR parquets for the active patch (16.9).

    The historical version of this function loaded a single all-patches CSV
    and returned a per-patch dict. The app has since shifted from a patch
    dropdown to a rank dropdown — same dict shape (keyed at the top by a
    string label), but the labels are now rank brackets instead of patches.
    Field names and method signatures stay `pr_by_patch` / `patches` /
    `latest_patch` to keep the engine + frontend wiring unchanged; treat
    each "patch" key as a rank label.

    Lookup order for each rank's parquet:
      1. ${POOL_DESIGNER_DATA_DIR}/pr_table_{rank}.parquet  (refreshed pipeline output)
      2. _reference_backend/lolalytics_s16_{rank}_16.9.parquet  (legacy)
    """
    data_dir = get_data_dir_from_env()
    backend_dir = Path(__file__).resolve().parent
    ranks = ["silver", "gold", "platinum", "emerald", "diamond", "master_plus"]
    default_rank = "diamond"

    pr_by_rank: Dict[str, Dict[str, Dict[str, float]]] = {}
    for rank in ranks:
        path = data_dir / f"pr_table_{rank}.parquet"
        if not path.exists():
            # Legacy manual-scrape filename: lolalytics_s16_{rank}_{patch}.parquet.
            # Glob for any patch suffix so the loader auto-picks the newest
            # without anyone editing a hardcoded version each cycle.
            cands = sorted(backend_dir.glob(f"lolalytics_s16_{rank}_*.parquet"))
            if cands:
                path = cands[-1]
        if not path.exists():
            print(f"[data] missing PR parquet for rank={rank}")
            continue
        df = pd.read_parquet(path)
        df = df[df["lane"].isin(LOL_LANE_TO_ROLE.keys())].copy()
        df["role"] = df["lane"].map(LOL_LANE_TO_ROLE)
        df["champion"] = df["champion_name"].map(lambda n: LOL_TO_OURS.get(n, n))
        df["games"] = df["games"].astype("Int64").fillna(0).astype(int)

        per_role: Dict[str, Dict[str, float]] = {}
        for role in LOL_LANE_TO_ROLE.values():
            ssub = df[df["role"] == role]
            total_games = int(ssub["games"].sum()) or 1
            # Per-role share: games_for_champ / total_role_games. Sums to 100%
            # per (rank, role) by construction; lolalytics' raw "Pick %"
            # column is overall (cross-lane) and inflates flex picks across
            # multiple lanes, so we derive PR weights from the game counts
            # directly to avoid that double-count.
            shares = ssub["games"].astype(float) / total_games
            per_role[role] = dict(zip(ssub["champion"], shares))
        pr_by_rank[rank] = per_role

    available = list(pr_by_rank.keys())
    default = default_rank if default_rank in pr_by_rank else (available[-1] if available else None)
    print(f"[data] loaded {len(available)} rank PR tables (default={default})")
    return pr_by_rank, available, default


def get_data_dir_from_env() -> Path:
    env = os.environ.get("POOL_DESIGNER_DATA_DIR")
    return Path(env) if env else DEFAULT_DATA_DIR
