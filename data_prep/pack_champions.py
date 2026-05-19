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
from data import load_all, ROLES  # noqa: E402

DATA_DIR = Path(os.environ.get("POOL_DESIGNER_DATA_DIR",
                               str(ROOT / "_data")))
DIST_DIR = Path(os.environ.get("POOL_DESIGNER_DIST_DIR",
                               str(ROOT / "dist")))

INTERP_NEIGHBOR_MIN = 0.001  # 0.1% — at least one neighbor must clear this


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

    out: dict = {
        "patches":      store.patches,
        "latest_patch": store.latest_patch,
        "by_patch":     {},
        "default":      {},   # PR from individual_wr.csv (cross-patch overall)
    }

    # Default (no patch selected) — overall pick rate from ind_wr.
    for role in ROLES:
        sub = store.ind_wr[store.ind_wr["role"] == role]
        out["default"][role] = [
            {"champion": str(c), "pick_rate": float(p), "win_rate": float(w)}
            for c, p, w in zip(sub["champion"], sub["pick_rate"], sub["win_rate"])
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
                pq = backend_dir / f"lolalytics_s16_{patch}_16.9.parquet"
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

    out_path = DIST_DIR / "champions.json"
    with out_path.open("w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"[pack_champions] wrote {out_path} ({out_path.stat().st_size / 1e3:.1f} KB)")


if __name__ == "__main__":
    main()
