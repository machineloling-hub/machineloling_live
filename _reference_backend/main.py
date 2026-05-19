"""FastAPI server for the Champion Pool Designer port.

Loads all matchup/synergy CSVs into memory at startup, then serves stateless
JSON endpoints. Frontend is served as static files from ../frontend/.
"""
from __future__ import annotations

import dataclasses
from collections import OrderedDict
from contextlib import asynccontextmanager
from functools import lru_cache
from pathlib import Path
from typing import Optional

import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import ports
from comparer import champion_correlation
from compute import (
    MATCHUP_THRESHOLD,
    SYNERGY_THRESHOLD,
    compute_coverage,
    coverage_stats,
    uncovered_list,
)
from data import ROLES, DataStore, get_data_dir_from_env, load_all
from live_curves import (
    DEFAULT_K, PERCENTILE_GRID, N_HIST_BINS,
    compute_live_curves, get_component_sigmas,
)

STORE: Optional[DataStore] = None
FRONTEND_DIR = Path(__file__).resolve().parents[1] / "frontend"
DISTRIBUTIONS_PATH = Path(__file__).resolve().parent / "pool_distributions.json"

# Direct lane opponent(s) per role — drives the in_lane_matchup score and
# must match precompute_pool_distributions.LANE_MATCH_OPPONENTS.
LANE_MATCH_OPPONENTS: dict[str, set[str]] = {
    "TOP": {"TOP"},
    "JUNGLE": {"JUNGLE"},
    "MID": {"MID"},
    "ADC": {"ADC", "SUP"},
    "SUP": {"ADC", "SUP"},
}


@asynccontextmanager
async def lifespan(app: FastAPI):
    global STORE
    STORE = load_all(get_data_dir_from_env())
    yield


app = FastAPI(title="Champion Pool Designer API", lifespan=lifespan)
# CSV-derived JSON heatmap payloads compress 5–10x with gzip
app.add_middleware(GZipMiddleware, minimum_size=1024)


def _store() -> DataStore:
    if STORE is None:
        raise HTTPException(503, "Data not loaded yet")
    return STORE


@lru_cache(maxsize=16)
def _store_for_patch(patch: Optional[str]) -> DataStore:
    """Return a store whose `pr_by_role` reflects the requested patch's
    lolalytics PR table. If patch is None or unknown, returns the original
    store (which has pr_by_role computed from individual_wr.csv totals).

    Memoized so the same patch returns the SAME DataStore instance — this
    stabilizes id(store), which the downstream _CallCache uses as cache key.
    """
    s = _store()
    if patch and patch in s.pr_by_patch:
        return dataclasses.replace(s, pr_by_role=s.pr_by_patch[patch])
    return s


# ── Caching layer for pool-independent heavy NumPy work ───────────────────
class _CallCache:
    """LRU cache for functions whose first arg is an unhashable DataStore.

    Keys on id(store) + remaining args/kwargs. Safe because _store_for_patch
    is memoized → same patch → same id. STORE is loaded once at startup and
    never mutated, so cache entries stay valid for the process lifetime.
    """
    def __init__(self, fn, maxsize: int = 128):
        self.fn = fn
        self.maxsize = maxsize
        self.cache: OrderedDict = OrderedDict()
        self.hits = 0
        self.misses = 0

    def __call__(self, store, *args, **kwargs):
        key = (id(store), args, tuple(sorted(kwargs.items())))
        try:
            result = self.cache[key]
            self.cache.move_to_end(key)
            self.hits += 1
            return result
        except KeyError:
            self.misses += 1
            result = self.fn(store, *args, **kwargs)
            self.cache[key] = result
            if len(self.cache) > self.maxsize:
                self.cache.popitem(last=False)
            return result


# Monkey-patch the two heaviest pool-independent helpers. Internal calls
# inside ports.ranked_candidates / health_table / built_pools resolve
# `blind_stats` / `z_matrices` from the module globals at call time, so
# they benefit from the cache without further changes.
ports.blind_stats = _CallCache(ports.blind_stats, maxsize=128)
ports.z_matrices = _CallCache(ports.z_matrices, maxsize=128)


# ── helpers ───────────────────────────────────────────────────────────────
def _round(a: np.ndarray, places: int = 3) -> list:
    a = np.round(a.astype(np.float32), places)
    # Replace NaN/Inf with None so the response is JSON-compliant.
    # Frontend already handles null cells (renders as blank/grey).
    return np.where(np.isfinite(a), a, None).tolist()


def _safe_float(v) -> Optional[float]:
    if v is None:
        return None
    f = float(v)
    return f if np.isfinite(f) else None


# ── /api/meta ─────────────────────────────────────────────────────────────
@app.get("/api/meta")
def meta():
    s = _store()
    return {
        "roles": ROLES,
        "matchup_threshold": MATCHUP_THRESHOLD,
        "synergy_threshold": SYNERGY_THRESHOLD,
        "pool_builder_cap": ports.POOL_BUILDER_CAP,
        "patches": s.patches,
        "latest_patch": s.latest_patch,
    }


@app.get("/api/patches")
def patches():
    s = _store()
    return {"patches": s.patches, "latest": s.latest_patch}


# ── /api/champions/{role} ─────────────────────────────────────────────────
@app.get("/api/champions/{role}")
def champions(role: str,
              pr_floor: float = Query(0.001, ge=0.0, le=1.0),
              patch: Optional[str] = Query(None)):
    s = _store()
    if role not in ROLES:
        raise HTTPException(404, f"unknown role {role}")
    # Pull win-rate from ind_wr (we only have overall WR data, not per-patch).
    wr_lookup = (
        s.ind_wr[s.ind_wr["role"] == role]
         .set_index("champion")["win_rate"].to_dict()
    )
    if patch and patch in s.pr_by_patch:
        prs = s.pr_by_patch[patch].get(role, {})
        rows = [
            {"champion": ch, "pick_rate": float(pr), "win_rate": float(wr_lookup.get(ch, 0.0))}
            for ch, pr in prs.items() if pr >= pr_floor
        ]
        rows.sort(key=lambda r: -r["pick_rate"])
        return rows
    sub = s.ind_wr[(s.ind_wr["role"] == role) & (s.ind_wr["pick_rate"] >= pr_floor)]
    sub = sub.sort_values("pick_rate", ascending=False)
    return [
        {"champion": str(c), "pick_rate": float(p), "win_rate": float(w)}
        for c, p, w in zip(sub["champion"], sub["pick_rate"], sub["win_rate"])
    ]


# ── /api/coverage ─────────────────────────────────────────────────────────
class CoverageRequest(BaseModel):
    my_role: str
    other_role: str
    mode: str  # "matchup" | "synergy"
    pool: list[str]
    top_x: int = 1
    pr_floor: float = 0.0075
    pr_weighted: bool = False
    patch: Optional[str] = None
    # Variance correction. "hier_wide" = wide-prior bilateral hier Bayes
    # with τ-based blindability (default). "hier" = tight-prior + τ blind,
    # "hier_tau" = tight-prior + τ blind, "se" = sign(d)*max(0,|d|-noise_z*SE),
    # "eb" = file-level EB, "raw" = none. The frontend no longer exposes a
    # picker — these are kept for direct API use.
    shrink_method: str = "hier_wide"
    noise_z: float = 0.75
    shrink_alpha: float = 1.0   # 1.0 = full hier shrinkage; 0.0 = raw
    # Extra champions to render as DISPLAY-ONLY rows beneath the pool — they
    # don't influence top-X picks, col scores, or column ordering. Used by
    # the Replacement Finder to show the dropped champ for comparison.
    extra_rows: list[str] = []


def _shrink_kwargs(method: str, noise_z: float, shrink_alpha: float = 1.0) -> dict:
    """Matrix shrinkage kwargs (passed to compute_coverage / adjusted_matrix).

    Each method explicitly sets every flag so the new defaults
    (FIXED_USE_HIER_WIDE=True, etc.) can't bleed through — picking "hier"
    must yield the tight-prior matrix, not the wide one.
    `shrink_alpha` only applies to hier methods; it controls the linear
    blend between the shrunk matrix (alpha=1) and the raw deltas (alpha=0).
    """
    a = float(shrink_alpha)
    if method in ("hier", "hier_tau"):
        return dict(use_hier=True, use_hier_wide=False, use_eb=False, noise_z=0.0, shrink_alpha=a)
    if method == "hier_wide":
        return dict(use_hier=False, use_hier_wide=True, use_eb=False, noise_z=0.0, shrink_alpha=a)
    if method == "eb":
        return dict(use_hier=False, use_hier_wide=False, use_eb=True, noise_z=0.0, shrink_alpha=1.0)
    if method == "se":
        return dict(use_hier=False, use_hier_wide=False, use_eb=False, noise_z=noise_z, shrink_alpha=1.0)
    if method == "raw":
        return dict(use_hier=False, use_hier_wide=False, use_eb=False, noise_z=0.0, shrink_alpha=1.0)
    raise HTTPException(400, f"bad shrink_method {method!r}")


def _blind_kwargs(method: str) -> dict:
    """Extra kwargs for blind_stats and the helpers that wrap it.

    Default is now SD-based blindability — combined with the shrink_alpha
    slider (which de-shrinks low-PR cells), the original SD-collapse
    artifact is controllable by the user.

    `hier_tau` is the only method that explicitly opts into τ-based
    blindability (kept for diagnostic comparison; not exposed in the UI).
    """
    if method == "hier_tau":
        return dict(use_tau_blind=True)
    return dict(use_tau_blind=False)


@app.post("/api/coverage")
def coverage(req: CoverageRequest):
    s = _store_for_patch(req.patch)
    if req.my_role not in ROLES or req.other_role not in ROLES:
        raise HTTPException(400, "bad role")
    if req.mode not in ("matchup", "synergy"):
        raise HTTPException(400, "bad mode")
    if req.mode == "synergy" and req.my_role == req.other_role:
        raise HTTPException(400, "synergy requires different roles")

    cov = compute_coverage(
        s, req.my_role, req.other_role, req.mode, req.pool,
        pr_floor=req.pr_floor, top_x=req.top_x,
        extra_rows=req.extra_rows or None,
        **_shrink_kwargs(req.shrink_method, req.noise_z, req.shrink_alpha),
    )
    if cov is None:
        return {"empty": True}

    threshold = MATCHUP_THRESHOLD if req.mode == "matchup" else SYNERGY_THRESHOLD
    stats = coverage_stats(
        cov, req.other_role, threshold, s.pr_by_role, req.pr_weighted,
    )
    uncov = uncovered_list(cov, threshold)
    pr_other = s.pr_by_role.get(req.other_role, {})

    return {
        "empty": False,
        "rows": cov.rows,
        "cols": cov.cols,
        "col_pick_rates": [float(pr_other.get(c, 0.0)) for c in cov.cols],
        "mat": _round(cov.mat),
        "mat_z": _round(cov.mat_z),
        "col_max_pp": _round(cov.col_max_pp),
        "col_max_z": _round(cov.col_max_z),
        "col_score_z": _round(cov.col_score_z),
        "col_score_pp": _round(cov.col_score_pp),
        "best_row_idx": [int(i) for i in cov.best_row_idx],
        "top_idx_mat": cov.top_idx_mat.astype(int).tolist(),
        "top_x": cov.top_x,
        "stats": stats,
        "uncovered": uncov,
        "threshold": threshold,
    }


# ── /api/health ───────────────────────────────────────────────────────────
class HealthRequest(BaseModel):
    my_role: str
    pool: list[str]
    top_x: int = 1
    pr_floor: float = 0.0075
    pr_weighted: bool = False
    blind_weight: float = 1.0  # for redundancy rank score
    patch: Optional[str] = None
    shrink_method: str = "hier_wide"
    noise_z: float = 0.75
    shrink_alpha: float = 1.0   # 1.0 = full hier shrinkage; 0.0 = raw


@app.post("/api/health")
def health(req: HealthRequest):
    s = _store_for_patch(req.patch)
    if req.my_role not in ROLES:
        raise HTTPException(400, "bad role")
    if not req.pool:
        return {"empty": True}

    sk = _shrink_kwargs(req.shrink_method, req.noise_z, req.shrink_alpha)
    bk = _blind_kwargs(req.shrink_method)
    matchup_rows = ports.health_table(
        s, req.my_role, req.pool, "matchup",
        pr_floor=req.pr_floor, top_x=req.top_x, pr_weighted=req.pr_weighted, **sk, **bk,
    ) or []
    synergy_rows = ports.health_table(
        s, req.my_role, req.pool, "synergy",
        pr_floor=req.pr_floor, top_x=req.top_x, pr_weighted=req.pr_weighted, **sk, **bk,
    ) or []

    red = ports.redundancy_data(
        s, req.my_role, req.pool,
        pr_floor=req.pr_floor, top_x=req.top_x, **sk,
    )
    if red is None:
        red_payload = None
    else:
        # blind aggregate per pool champ for redundancy rank
        blind = ports.blind_stats(s, req.my_role, pr_weighted=req.pr_weighted, pr_floor=req.pr_floor, **sk, **bk)
        bz = ports.blind_z_lookup(blind, req.my_role)
        rows = red["rows"]
        red_payload = {
            "rows": rows,
            "cor": _round(red["cor"], 3),
            "order": red["order"],
            "dendro_segments": red["dendro_segments"],
            "closest_cor":  _round(red["closest_cor"], 3),
            "closest_idx":  [int(i) for i in red["closest_idx"]],
            "avg_cor":      _round(red["avg_cor"], 3),
            "topx_cor":     _round(red["topx_cor"], 3),
            "unique_best":  [int(i) for i in red["unique_best"]],
            "matchup_topx": _round(red["matchup"]["topx_cor"], 3) if red["matchup"] else None,
            "synergy_topx": _round(red["synergy"]["topx_cor"], 3) if red["synergy"] else None,
            "lane_topx":    _round(red["lane"]["topx_cor"], 3) if red["lane"] else None,
            "lane_roles":   red["lane_roles"],
            "blind_z":      [_safe_float(bz.get(ch)) for ch in rows],
        }

    return {
        "empty": False,
        "matchup_rows": matchup_rows,
        "synergy_rows": synergy_rows,
        "redundancy": red_payload,
        "matchup_threshold": MATCHUP_THRESHOLD,
        "synergy_threshold": SYNERGY_THRESHOLD,
        "top_x": req.top_x,
    }


# ── /api/pool_strength_curves ─────────────────────────────────────────────
class PoolStrengthCurvesRequest(BaseModel):
    my_role: str
    pool_size: int
    top_x: int = 1
    pr_floor: float = 0.01
    pr_weighted: bool = False
    shrink_alpha: float = 1.0    # 1.0 = full hier shrinkage; 0.0 = raw
    # Score weights for the total_score curve.
    w_in_lane: float = 1.0
    w_out_lane: float = 1.0
    w_synergy: float = 1.0
    w_blind: float = 0.2
    # Per-component reference σ. Used to rescale each weighted contribution
    # to "σ-equivalent units" so a slider value of 1.0 means "1σ of natural
    # variation in this component." Default 1.0 = no rescaling (raw).
    sigma_in_lane: float = 1.0
    sigma_out_lane: float = 1.0
    sigma_synergy: float = 1.0
    sigma_blind: float = 1.0
    patch: Optional[str] = None
    n_samples: int = DEFAULT_K   # 500 by default — KDE smoothing makes this enough
    # Optional secondary pool_size for the Replacement panel (so add-mode can
    # render curves for both base and new pool sizes in one call). If None,
    # only `pool_size` is computed.
    extra_pool_size: Optional[int] = None
    extra_top_x: Optional[int] = None


@app.post("/api/pool_strength_curves")
def pool_strength_curves(req: PoolStrengthCurvesRequest):
    """Live computation of the 6 reference strength curves for the user's
    exact (role, patch, pool_size, top_x, pr_floor, pr_weighted, shrink_alpha,
    weights) state.

    Returns the same slot shape the precomputed pool_distributions used —
    `[mean, sd, min, max, *21 percentiles, *30 KDE-density bins]` per
    metric — so the frontend renderer is unchanged.
    """
    s = _store_for_patch(req.patch)
    if req.my_role not in ROLES:
        raise HTTPException(400, "bad role")

    common = dict(
        shrink_alpha=req.shrink_alpha, n_samples=req.n_samples,
        w_in_lane=req.w_in_lane, w_out_lane=req.w_out_lane,
        w_synergy=req.w_synergy, w_blind=req.w_blind,
        sigma_in_lane=req.sigma_in_lane, sigma_out_lane=req.sigma_out_lane,
        sigma_synergy=req.sigma_synergy, sigma_blind=req.sigma_blind,
    )
    primary = compute_live_curves(
        s, req.my_role, req.patch, req.pool_size, req.top_x,
        req.pr_floor, req.pr_weighted, **common,
    )
    payload: dict = {
        "config": {
            "percentile_grid": PERCENTILE_GRID,
            "n_hist_bins": N_HIST_BINS,
            "n_samples": req.n_samples,
        },
        "primary": {"pool_size": req.pool_size, "top_x": req.top_x, "data": primary},
    }
    if req.extra_pool_size is not None:
        extra_top_x = req.extra_top_x if req.extra_top_x is not None else req.top_x
        extra = compute_live_curves(
            s, req.my_role, req.patch, req.extra_pool_size, extra_top_x,
            req.pr_floor, req.pr_weighted, **common,
        )
        payload["extra"] = {
            "pool_size": req.extra_pool_size, "top_x": extra_top_x, "data": extra,
        }
    return payload


# ── /api/pool_distributions ───────────────────────────────────────────────
@app.get("/api/pool_distributions")
def pool_distributions():
    """Static JSON of precomputed reference distributions for pool strength.

    Frontend caches the file once at first Pool Health visit and uses it to
    plot density curves with the user's vertical marker. Generated by
    precompute_pool_distributions.py.
    """
    if not DISTRIBUTIONS_PATH.exists():
        raise HTTPException(503, "pool_distributions.json missing — run "
                                  "precompute_pool_distributions.py first")
    return FileResponse(DISTRIBUTIONS_PATH, media_type="application/json")


# ── /api/pool_summary ─────────────────────────────────────────────────────
class PoolSummaryRequest(BaseModel):
    my_role: str
    pool: list[str]
    top_x: int = 1
    pr_floor: float = 0.005
    pr_weighted: bool = False
    patch: Optional[str] = None
    shrink_method: str = "hier_wide"
    noise_z: float = 0.75
    shrink_alpha: float = 1.0   # 1.0 = full hier shrinkage; 0.0 = raw
    # Score weights (for the optional total_score). Defaults: 1 for the three
    # coverage components, 0.2 for blindability — matches the legacy
    # blind_penalty default. Total = w_in × in_lane/σ_in + w_out × out_lane/σ_out
    # + w_syn × synergy/σ_syn + w_blind × blindability/σ_blind.
    w_in_lane: float = 1.0
    w_out_lane: float = 1.0
    w_synergy: float = 1.0
    w_blind: float = 0.2
    # Per-component reference σ (default 1.0 = raw weighting).
    sigma_in_lane: float = 1.0
    sigma_out_lane: float = 1.0
    sigma_synergy: float = 1.0
    sigma_blind: float = 1.0


def _coverage_topx_z(s: DataStore, my_role: str, other_role: str, mode: str,
                     pool: list[str], pr_floor: float, top_x: int,
                     pr_weighted: bool, shrink_kwargs: dict) -> Optional[float]:
    """Reduce a (mode, my_role, other_role) coverage to its scalar mean top-X z."""
    cov = compute_coverage(s, my_role, other_role, mode, pool,
                           pr_floor=pr_floor, top_x=top_x, **shrink_kwargs)
    if cov is None:
        return None
    threshold = MATCHUP_THRESHOLD if mode == "matchup" else SYNERGY_THRESHOLD
    stats = coverage_stats(cov, other_role, threshold, s.pr_by_role, pr_weighted)
    return stats["mean_topx_z"]


@app.post("/api/pool_summary")
def pool_summary(req: PoolSummaryRequest):
    """Compute the user's 4 strength scores: overall_matchup, overall_synergy,
    in_lane_matchup, blindability. Each is the same scalar metric the
    precompute uses, so it lines up with /api/pool_distributions reference."""
    s = _store_for_patch(req.patch)
    if req.my_role not in ROLES:
        raise HTTPException(400, "bad role")
    if not req.pool:
        return {"empty": True}

    sk = _shrink_kwargs(req.shrink_method, req.noise_z, req.shrink_alpha)
    bk = _blind_kwargs(req.shrink_method)
    matchup_scores: list[float] = []
    lane_scores: list[float] = []
    out_lane_scores: list[float] = []
    synergy_scores: list[float] = []
    lane_opponents = LANE_MATCH_OPPONENTS.get(req.my_role, set())
    for other in ROLES:
        m = _coverage_topx_z(s, req.my_role, other, "matchup", req.pool,
                             req.pr_floor, req.top_x, req.pr_weighted, sk)
        if m is not None and np.isfinite(m):
            matchup_scores.append(m)
            if other in lane_opponents:
                lane_scores.append(m)
            else:
                out_lane_scores.append(m)
        if other != req.my_role:
            sy = _coverage_topx_z(s, req.my_role, other, "synergy", req.pool,
                                  req.pr_floor, req.top_x, req.pr_weighted, sk)
            if sy is not None and np.isfinite(sy):
                synergy_scores.append(sy)

    # Blindability: full-pool mean of aggregate blind z. Pool-wide property,
    # so this ignores top_x by design — mirrors precompute behavior.
    blind = ports.blind_stats(s, req.my_role, pr_weighted=req.pr_weighted, pr_floor=req.pr_floor, **sk, **bk)
    agg = ports.blind_z_lookup(blind, req.my_role)
    pool_z = [float(agg[c]) for c in req.pool if c in agg and np.isfinite(agg[c])]
    blind_score = float(np.mean(pool_z)) if pool_z else None

    def _mean_or_none(xs: list[float]) -> Optional[float]:
        return float(np.mean(xs)) if xs else None

    in_lane_z   = _mean_or_none(lane_scores)
    out_lane_z  = _mean_or_none(out_lane_scores)
    overall_syn = _mean_or_none(synergy_scores)
    # Weighted total: divide each component by its cached/computed σ, then
    # apply the user's weight. Cached σs guarantee consistency with the
    # reference curves the user is looking at (computed once per scenario).
    sigmas = get_component_sigmas(
        s, req.my_role, req.patch, len(req.pool), req.top_x,
        req.pr_floor, req.pr_weighted, req.shrink_alpha,
    )
    def _w(v, w, sig):
        if v is None or not np.isfinite(v):
            return 0.0
        return w * float(v) / sig
    total_score = (
        _w(in_lane_z,   req.w_in_lane,  sigmas["in_lane"]) +
        _w(out_lane_z,  req.w_out_lane, sigmas["out_lane"]) +
        _w(overall_syn, req.w_synergy,  sigmas["synergy"]) +
        _w(blind_score, req.w_blind,    sigmas["blind"])
    )

    return {
        "empty": False,
        "pool_size": len(req.pool),
        "top_x": req.top_x,
        "scores": {
            "overall_matchup":     _mean_or_none(matchup_scores),
            "overall_synergy":     overall_syn,
            "in_lane_matchup":     in_lane_z,
            "out_of_lane_matchup": out_lane_z,
            "blindability":        blind_score,
            "total_score":         float(total_score),
        },
    }


# ── /api/blindability ─────────────────────────────────────────────────────
class BlindabilityRequest(BaseModel):
    my_role: str
    pool: list[str] = []
    pr_floor: float = 0.005
    pr_weighted: bool = False
    patch: Optional[str] = None
    shrink_method: str = "hier_wide"
    noise_z: float = 0.75
    shrink_alpha: float = 1.0   # 1.0 = full hier shrinkage; 0.0 = raw


@app.post("/api/blindability")
def blindability(req: BlindabilityRequest):
    s = _store_for_patch(req.patch)
    if req.my_role not in ROLES:
        raise HTTPException(400, "bad role")

    sk = _shrink_kwargs(req.shrink_method, req.noise_z, req.shrink_alpha)
    bk = _blind_kwargs(req.shrink_method)
    blind = ports.blind_stats(s, req.my_role, pr_weighted=req.pr_weighted, pr_floor=req.pr_floor, **sk, **bk)
    if not blind["matchup"] and not blind["synergy"]:
        return {"empty": True}

    # Eligible champs at role with PR ≥ floor; union with pool. Uses the
    # patch-specific PR table (s.pr_by_role is swapped to req.patch above) so
    # the eligibility floor matches what the matchup/synergy heatmaps use.
    # Underlying delta values still come from the full cross-patch dataset.
    prs = s.pr_by_role.get(req.my_role, {})
    eligible = {ch for ch, pr in prs.items() if pr >= req.pr_floor} | set(req.pool)

    # Lane definitions for this role
    if req.my_role in ("ADC", "SUP"):
        lane_match_pos = {"ADC", "SUP"}
        lane_synergy_pos = "SUP" if req.my_role == "ADC" else "ADC"
    else:
        lane_match_pos = {req.my_role}
        lane_synergy_pos = None

    # Per-champ vectors (matchup mean, synergy mean, etc.)
    rows = []
    for ch in eligible:
        # Collect per-slice z values
        match_zs: list[float] = []
        match_lane_zs: list[float] = []
        match_outlane_zs: list[float] = []
        for pos, payload in blind["matchup"].items():
            ch_to_z = dict(zip(payload["champs"], payload["z"]))
            v = ch_to_z.get(ch)
            if v is None or not np.isfinite(v):
                continue
            match_zs.append(float(v))
            if pos in lane_match_pos:
                match_lane_zs.append(float(v))
            else:
                match_outlane_zs.append(float(v))
        syn_zs: list[float] = []
        syn_lane_zs: list[float] = []
        syn_outlane_zs: list[float] = []
        for pos, payload in blind["synergy"].items():
            ch_to_z = dict(zip(payload["champs"], payload["z"]))
            v = ch_to_z.get(ch)
            if v is None or not np.isfinite(v):
                continue
            syn_zs.append(float(v))
            if pos == lane_synergy_pos:
                syn_lane_zs.append(float(v))
            else:
                syn_outlane_zs.append(float(v))

        # Skip champs with no data in either mode (matches scatter behaviour)
        if not match_zs and not syn_zs:
            continue

        def _m(xs: list[float]) -> Optional[float]:
            return float(np.mean(xs)) if xs else None

        rows.append({
            "champion":             ch,
            "in_pool":              ch in set(req.pool),
            "matchup_mean":         _m(match_zs),
            "synergy_mean":         _m(syn_zs),
            "lane_matchup":         _m(match_lane_zs),
            "out_of_lane_matchup":  _m(match_outlane_zs),
            "lane_synergy":         _m(syn_lane_zs),
            "out_of_lane_synergy":  _m(syn_outlane_zs),
            "aggregate":            _m(match_zs + syn_zs),
        })

    rows.sort(key=lambda r: (r["aggregate"] is None, -(r["aggregate"] or 0)))
    return {
        "empty": False,
        "rows": rows,
        "lane_matchup_pos": sorted(lane_match_pos),
        "lane_synergy_pos": lane_synergy_pos,
    }


# ── /api/comparer ─────────────────────────────────────────────────────────
class ComparerRequest(BaseModel):
    my_role: str
    champion: str
    pr_floor: float = 0.01
    pr_weighted: bool = False
    patch: Optional[str] = None
    shrink_method: str = "hier_wide"
    noise_z: float = 0.75
    shrink_alpha: float = 1.0   # 1.0 = full hier shrinkage; 0.0 = raw


@app.post("/api/comparer")
def comparer(req: ComparerRequest):
    """Champion-vs-champion correlation table — see comparer.py docstring."""
    s = _store_for_patch(req.patch)
    if req.my_role not in ROLES:
        raise HTTPException(400, "bad role")
    payload = champion_correlation(
        s, req.my_role, req.champion,
        pr_floor=req.pr_floor, pr_weighted=req.pr_weighted,
        shrink_kwargs=_shrink_kwargs(req.shrink_method, req.noise_z, req.shrink_alpha),
        blind_kwargs=_blind_kwargs(req.shrink_method),
    )
    if payload is None:
        return {"empty": True}
    return {"empty": False, **payload}


# ── /api/bans ─────────────────────────────────────────────────────────────
class BansRequest(BaseModel):
    my_role: str
    pool: list[str]
    pr_floor: float = 0.0075
    pr_weighted: bool = False
    patch: Optional[str] = None
    shrink_method: str = "hier_wide"
    noise_z: float = 0.75
    shrink_alpha: float = 1.0   # 1.0 = full hier shrinkage; 0.0 = raw


@app.post("/api/bans")
def bans(req: BansRequest):
    s = _store_for_patch(req.patch)
    if req.my_role not in ROLES:
        raise HTTPException(400, "bad role")
    if not req.pool:
        return {"empty": True}
    rows = ports.ban_candidates(s, req.my_role, req.pool,
                                pr_floor=req.pr_floor, pr_weighted=req.pr_weighted,
                                **_shrink_kwargs(req.shrink_method, req.noise_z, req.shrink_alpha))
    if not rows:
        return {"empty": True}
    return {"empty": False, "rows": rows}


# ── /api/replacements ─────────────────────────────────────────────────────
class ReplacementsRequest(BaseModel):
    my_role: str
    pool: list[str]
    mode: str  # "add" | "replace"
    locked: list[str] = []
    top_x: int = 1
    pr_floor: float = 0.0075
    pr_weighted: bool = False
    patch: Optional[str] = None
    shrink_method: str = "hier_wide"
    noise_z: float = 0.75
    shrink_alpha: float = 1.0   # 1.0 = full hier shrinkage; 0.0 = raw
    # Score weights for the ranking equation.
    w_in_lane: float = 1.0
    w_out_lane: float = 1.0
    w_synergy: float = 1.0
    w_blind: float = 0.3
    # Per-component reference σ (default 1.0 = raw weighting).
    sigma_in_lane: float = 1.0
    sigma_out_lane: float = 1.0
    sigma_synergy: float = 1.0
    sigma_blind: float = 1.0


@app.post("/api/replacements")
def replacements(req: ReplacementsRequest):
    s = _store_for_patch(req.patch)
    if req.my_role not in ROLES:
        raise HTTPException(400, "bad role")
    if req.mode not in ("add", "replace"):
        raise HTTPException(400, "mode must be 'add' or 'replace'")
    if not req.pool:
        return {"empty": True}
    sk = _shrink_kwargs(req.shrink_method, req.noise_z, req.shrink_alpha)
    bk = _blind_kwargs(req.shrink_method)
    weights = dict(
        w_in_lane=req.w_in_lane, w_out_lane=req.w_out_lane,
        w_synergy=req.w_synergy, w_blind=req.w_blind,
    )
    # Server-side σ cache — base σs for the user's current pool, plus
    # new σs for the post-add pool size (add mode only). Using the right
    # σ-base on each side is what makes the predicted "new score" match
    # what Pool Health shows after the user actually performs the add.
    cached = get_component_sigmas(
        s, req.my_role, req.patch, len(req.pool), req.top_x,
        req.pr_floor, req.pr_weighted, req.shrink_alpha,
    )
    sigmas = {
        "sigma_in_lane":  cached["in_lane"],
        "sigma_out_lane": cached["out_lane"],
        "sigma_synergy":  cached["synergy"],
        "sigma_blind":    cached["blind"],
    }
    if req.mode == "add":
        new_cached = get_component_sigmas(
            s, req.my_role, req.patch, len(req.pool) + 1, req.top_x,
            req.pr_floor, req.pr_weighted, req.shrink_alpha,
        )
        sigmas.update({
            "new_sigma_in_lane":  new_cached["in_lane"],
            "new_sigma_out_lane": new_cached["out_lane"],
            "new_sigma_synergy":  new_cached["synergy"],
            "new_sigma_blind":    new_cached["blind"],
        })
    rows = ports.ranked_candidates(
        s, req.my_role, req.pool, req.mode, req.locked,
        top_x=req.top_x,
        pr_weighted=req.pr_weighted, pr_floor=req.pr_floor, **sk, **bk, **weights, **sigmas,
    )
    if rows is None:
        return {"empty": True}

    # Base pool's strength scores — frontend uses these + delta_* on each
    # row to derive the new pool's σ on the live reference curves.
    zmats = ports.z_matrices(s, req.my_role, pr_floor=req.pr_floor, **sk)
    blind = ports.blind_stats(s, req.my_role, pr_weighted=req.pr_weighted, pr_floor=req.pr_floor, **sk, **bk)
    bz = ports.blind_z_lookup(blind, req.my_role)
    base_stats = ports.pool_stats(
        req.pool, zmats, s.pr_by_role, req.top_x, req.my_role,
        pr_weighted=req.pr_weighted, blind_lookup=bz,
    )
    base_total = ports._total_score_from_stats(
        base_stats, req.w_in_lane, req.w_out_lane, req.w_synergy, req.w_blind,
        sigma_in_lane=cached["in_lane"], sigma_out_lane=cached["out_lane"],
        sigma_synergy=cached["synergy"], sigma_blind=cached["blind"],
    )
    base_scores = {
        "overall_matchup":     _safe_float(base_stats["matchup_z"]),
        "overall_synergy":     _safe_float(base_stats["synergy_z"]),
        "in_lane_matchup":     _safe_float(base_stats["matchup_in_lane"]),
        "out_of_lane_matchup": _safe_float(base_stats["matchup_out_of_lane"]),
        "blindability":        _safe_float(base_stats["blind_z"]),
        "total_score":         _safe_float(base_total),
    }
    # Add-mode: also project the base pool's total onto the new (size N+1)
    # σ-base so the frontend can plot "where you started" on the same curve
    # as the new pool. Per-component values (matchup_in_lane etc.) don't
    # depend on σs, so they project trivially via (raw − new_curve.mean)
    # / new_curve.sd in the frontend; only total_score needs this rescore.
    if req.mode == "add":
        base_total_new = ports._total_score_from_stats(
            base_stats, req.w_in_lane, req.w_out_lane, req.w_synergy, req.w_blind,
            sigma_in_lane=new_cached["in_lane"], sigma_out_lane=new_cached["out_lane"],
            sigma_synergy=new_cached["synergy"], sigma_blind=new_cached["blind"],
        )
        base_scores["total_score_new_sigma"] = _safe_float(base_total_new)
    return {
        "empty": False,
        "rows": rows,
        "base_scores": base_scores,
        "pool_size": len(req.pool),
    }


# ── /api/build (Pool Builder) ─────────────────────────────────────────────
class BuildRequest(BaseModel):
    my_role: str
    definite: list[str] = []
    maybe: list[str] = []
    target: int = 6
    top_x: int = 1
    pr_floor: float = 0.0075
    pr_weighted: bool = False
    patch: Optional[str] = None
    shrink_method: str = "hier_wide"
    noise_z: float = 0.75
    shrink_alpha: float = 1.0   # 1.0 = full hier shrinkage; 0.0 = raw
    # Score weights for the ranking equation.
    w_in_lane: float = 1.0
    w_out_lane: float = 1.0
    w_synergy: float = 1.0
    w_blind: float = 0.3
    # Per-component reference σ (default 1.0 = raw weighting).
    sigma_in_lane: float = 1.0
    sigma_out_lane: float = 1.0
    sigma_synergy: float = 1.0
    sigma_blind: float = 1.0


@app.post("/api/build")
def build(req: BuildRequest):
    s = _store_for_patch(req.patch)
    if req.my_role not in ROLES:
        raise HTTPException(400, "bad role")
    cached = get_component_sigmas(
        s, req.my_role, req.patch, req.target, req.top_x,
        req.pr_floor, req.pr_weighted, req.shrink_alpha,
    )
    res = ports.built_pools(
        s, req.my_role, req.definite, req.maybe, req.target,
        top_x=req.top_x,
        w_in_lane=req.w_in_lane, w_out_lane=req.w_out_lane,
        w_synergy=req.w_synergy, w_blind=req.w_blind,
        sigma_in_lane=cached["in_lane"], sigma_out_lane=cached["out_lane"],
        sigma_synergy=cached["synergy"], sigma_blind=cached["blind"],
        pr_weighted=req.pr_weighted, pr_floor=req.pr_floor,
        **_shrink_kwargs(req.shrink_method, req.noise_z, req.shrink_alpha),
        **_blind_kwargs(req.shrink_method),
    )
    return res


@app.get("/api/combo_count")
def combo_count(definite: str = Query(""), maybe: str = Query(""),
                target: int = Query(6, ge=2, le=10)):
    """Live combination count for the Pool Builder. CSV-encoded lists."""
    d = [c for c in definite.split(",") if c]
    m = [c for c in maybe.split(",") if c]
    n = ports.pb_combo_count(d, m, target)
    return {"count": n, "cap": ports.POOL_BUILDER_CAP, "over_cap": (n or 0) > ports.POOL_BUILDER_CAP}


# ── /api/cache_stats ──────────────────────────────────────────────────────
@app.get("/api/cache_stats")
def cache_stats():
    """Hit/miss counters for the pool-independent caches.
    Hit rate climbs toward 1.0 as users converge on common settings."""
    def _stats(c: _CallCache) -> dict:
        total = c.hits + c.misses
        return {
            "hits": c.hits, "misses": c.misses, "size": len(c.cache),
            "max": c.maxsize,
            "hit_rate": (c.hits / total) if total else None,
        }
    return {
        "blind_stats": _stats(ports.blind_stats),
        "z_matrices":  _stats(ports.z_matrices),
    }


# ── Static frontend ───────────────────────────────────────────────────────
@app.get("/")
def index():
    return FileResponse(FRONTEND_DIR / "index.html")


app.mount("/", StaticFiles(directory=FRONTEND_DIR), name="static")
