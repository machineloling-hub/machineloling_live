"""Flatten the per-role / per-patch champion tables into a single static
JSON, replacing the live `/api/champions/{role}` endpoint.

Scrape-gap interpolation: lolalytics occasionally drops a champion from a
single rank's table even though the champ has plenty of games elsewhere.
We patch those gaps by synthesizing a row with `pick_rate` = mean of the
nearest 1–2 ranks' pick rates, when at least one neighbor sits ≥0.1%.
Synthesized rows are flagged `interpolated: true` so the frontend can
list them; downstream consumers (wasm engine PR-floor + PR-weighting,
etc.) just see them as regular rows.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "_reference_backend"))
from data import ROLES, load_all  # noqa: E402

DATA_DIR = Path(os.environ.get("POOL_DESIGNER_DATA_DIR",
                               str(ROOT / "_data")))
DIST_DIR = Path(os.environ.get("POOL_DESIGNER_DIST_DIR",
                               str(ROOT / "dist")))

INTERP_NEIGHBOR_MIN = 0.001  # 0.1% — at least one neighbor must clear this


def _load_data_meta() -> dict:
    """Stamped by refresh.py during the collect stage (and overridable per
    invocation by POOL_DESIGNER_DATA_PATCH). Returns {} if neither exists
    so legacy local runs without a refresh keep working."""
    meta: dict = {}
    meta_path = DATA_DIR / "data_meta.json"
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text())
        except Exception as e:
            print(f"[pack_champions] warning: data_meta.json unreadable ({e})")
    env_patch = os.environ.get("POOL_DESIGNER_DATA_PATCH")
    if env_patch:
        meta["data_patch"] = env_patch
    return meta


def _interpolate_scrape_gaps(out: dict) -> list[dict]:
    """Mutate out['by_patch'] in place to fill missing (rank, role, champ)
    rows with neighbor-averaged pick rates. Returns a flat log of fills."""
    ranks = out["patches"]
    log: list[dict] = []
    for role in ROLES:
        # champ → rank → row reference (real rows only)
        present: dict[str, dict[str, dict]] = {}
        for rank in ranks:
            for row in out["by_patch"][rank][role]:
                if row["pick_rate"] > 0:
                    present.setdefault(row["champion"], {})[rank] = row
        for champ, by_rank in present.items():
            for i, rank in enumerate(ranks):
                if rank in by_rank:
                    continue
                neighbors: list[tuple[str, dict]] = []
                for j in range(i - 1, -1, -1):
                    if ranks[j] in by_rank:
                        neighbors.append((ranks[j], by_rank[ranks[j]]))
                        break
                for j in range(i + 1, len(ranks)):
                    if ranks[j] in by_rank:
                        neighbors.append((ranks[j], by_rank[ranks[j]]))
                        break
                if not neighbors:
                    continue
                if max(n[1]["pick_rate"] for n in neighbors) < INTERP_NEIGHBOR_MIN:
                    continue
                interp_pr = sum(n[1]["pick_rate"] for n in neighbors) / len(neighbors)
                interp_wr = sum(n[1]["win_rate"] for n in neighbors) / len(neighbors)
                # Cap at 50% to keep the synth_games denominator (1 - interp_pr)
                # from blowing up; a single champ above 50% PR is already a
                # data-quality red flag and shouldn't be auto-synthesized.
                interp_pr = min(interp_pr, 0.5)
                # Games count: chosen so `synth_games / new_total ≈ interp_pr`
                # post-insertion (i.e. share-by-games matches the displayed
                # pick-rate). Safe even when many champs are filled in one rank.
                real_total = sum(r["games"] for r in out["by_patch"][rank][role])
                # Approximation that's stable enough for visual stacking; tiny
                # cross-coupling between multiple synthesized entries in the
                # same rank is acceptable.
                synth_games = (
                    int(round(interp_pr * real_total / max(1.0 - interp_pr, 1e-3)))
                    if real_total > 0 else 0
                )
                new_row = {
                    "champion": champ,
                    "pick_rate": interp_pr,
                    "games": synth_games,
                    "win_rate": interp_wr,
                    "interpolated": True,
                }
                out["by_patch"][rank][role].append(new_row)
                log.append({
                    "role": role,
                    "rank": rank,
                    "champion": champ,
                    "pick_rate": interp_pr,
                    "neighbors": [
                        {"rank": rk, "pick_rate": rw["pick_rate"]}
                        for rk, rw in neighbors
                    ],
                })
        # Re-sort each rank's list by pick_rate desc (matches the original
        # build step's sort).
        for rank in ranks:
            out["by_patch"][rank][role].sort(key=lambda r: -r["pick_rate"])
    return log


def main() -> None:
    DIST_DIR.mkdir(exist_ok=True)
    store = load_all(DATA_DIR)
    data_meta = _load_data_meta()

    out: dict = {
        "patches":      store.patches,
        "latest_patch": store.latest_patch,
        # Actual game-patch version of the source data (e.g. "16.10"). The
        # legacy `latest_patch` field is overloaded: after the rank refactor
        # it carries the default rank label ("diamond"), not a patch number.
        # Frontend reads `data_patch` for UI strings.
        "data_patch":   data_meta.get("data_patch"),
        "data_regions": data_meta.get("regions"),
        "refreshed_at": data_meta.get("refreshed_at"),
        "by_patch":     {},
        "default":      {},   # PR from individual_wr.csv (cross-patch overall)
    }

    # Default (no patch selected) — overall pick rate from ind_wr.
    for role in ROLES:
        sub = store.ind_wr[store.ind_wr["role"] == role]
        out["default"][role] = [
            {"champion": str(c), "pick_rate": float(p), "win_rate": float(w)}
            for c, p, w in zip(sub["champion"], sub["pick_rate"], sub["win_rate"], strict=True)
        ]

    # Per-rank — uses lolalytics PR table for ranking, ind_wr for WR. We also
    # emit raw `games` from the scrape so charts can compute true per-role
    # share = champ_games / Σ(role_games), which sums to exactly 100% per
    # (rank, role) by construction (no flex-pick double-counting).
    backend_dir = (ROOT / "_reference_backend").resolve()
    for patch in store.patches:
        # Read the source parquet once per rank to pull `games` alongside PR.
        # `patch` here is a rank label after the rank refactor.
        games_lookup: dict[tuple[str, str], int] = {}
        from data import LOL_LANE_TO_ROLE, LOL_TO_OURS, get_data_dir_from_env
        try:
            import pandas as _pd
            data_dir = get_data_dir_from_env()
            pq = data_dir / f"pr_table_{patch}.parquet"
            if not pq.exists():
                # Legacy manual-scrape filename: lolalytics_s16_{rank}_{patch}.parquet.
                # Glob for any patch suffix so cycling forward doesn't require
                # a code edit.
                cands = sorted(backend_dir.glob(f"lolalytics_s16_{patch}_*.parquet"))
                if cands:
                    pq = cands[-1]
            if pq.exists():
                _df = _pd.read_parquet(pq)
                _df = _df[_df["lane"].isin(LOL_LANE_TO_ROLE.keys())]
                # Vectorized: replace the per-row iterrows() loop with a
                # single .map + groupby over the filtered DataFrame.
                _df = _df.assign(
                    _role=_df["lane"].map(LOL_LANE_TO_ROLE),
                    _champ=_df["champion_name"].map(
                        lambda n: LOL_TO_OURS.get(n, n)),
                )
                games_lookup = (
                    _df.set_index(["_role", "_champ"])["games"].astype(int)
                    .to_dict()
                )
        except Exception as e:
            print(f"  warning: games lookup for {patch} failed ({e})")

        out["by_patch"][patch] = {}
        for role in ROLES:
            wr_lookup = (
                store.ind_wr[store.ind_wr["role"] == role]
                     .set_index("champion")["win_rate"].to_dict()
            )
            prs = store.pr_by_patch[patch].get(role, {})
            rows = []
            for ch, pr in prs.items():
                rows.append({
                    "champion": str(ch),
                    "pick_rate": float(pr),
                    "games": int(games_lookup.get((role, ch), 0)),
                    "win_rate": float(wr_lookup.get(ch, 0.0)),
                })
            rows.sort(key=lambda r: -r["pick_rate"])
            out["by_patch"][patch][role] = rows

    interpolations = _interpolate_scrape_gaps(out)
    out["interpolations"] = interpolations
    if interpolations:
        per_role: dict[str, int] = {}
        for it in interpolations:
            per_role[it["role"]] = per_role.get(it["role"], 0) + 1
        breakdown = ", ".join(f"{r}: {n}" for r, n in sorted(per_role.items()))
        print(f"[pack_champions] interpolated {len(interpolations)} scrape gaps ({breakdown})")

    # Prune ranks where every role's slice has zero games — those parquets
    # carry the champion roster but no actual match data (the puller seeds
    # from high-tier players, so low brackets see ~no games). Keeping them
    # would force the frontend to fall back to the cross-tier `default`
    # distribution, making the meta-summary ribbons identical across those
    # ranks. Dropping them is cleaner than showing duplicate data.
    empty_ranks = []
    for rank in list(out["by_patch"].keys()):
        per_role = out["by_patch"][rank]
        total_games = sum(
            sum(int(r.get("games", 0)) for r in (per_role.get(role) or []))
            for role in ROLES
        )
        if total_games == 0:
            empty_ranks.append(rank)
            del out["by_patch"][rank]
    if empty_ranks:
        out["patches"] = [p for p in out["patches"] if p not in empty_ranks]
        if out.get("latest_patch") in empty_ranks:
            out["latest_patch"] = out["patches"][-1] if out["patches"] else None
        print(f"[pack_champions] pruned empty ranks: {', '.join(empty_ranks)}")

    out_path = DIST_DIR / "champions.json"
    with out_path.open("w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"[pack_champions] wrote {out_path} ({out_path.stat().st_size / 1e3:.1f} KB)")


if __name__ == "__main__":
    main()
