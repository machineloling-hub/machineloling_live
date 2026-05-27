"""Refresh pipeline orchestrator.

End-to-end flow for one rank tier:

    1.  Pull match feathers from S3 (or LOCAL_RAW_DIR) for the configured
        queue + patch range + regions.
    2.  Aggregate them into raw matchup/synergy/individual_wr/PR tables
        for cfg.tier (writes CSVs + parquet to dist/refreshed/{tier}/).
    3.  Run empirical Bayes shrinkage on every matchup/synergy CSV.
    4.  Run bilateral hierarchical Bayes (numpyro) on every matchup/synergy
        CSV under both tight and wide priors. Emit τ sidecar CSVs.
    5.  Stage all CSVs into dist/staged/, including the per-tier PR
        parquet renamed to pr_table_{tier}.parquet so the loader can
        find every previously-refreshed tier alongside this one.
    6.  Invoke pack_matrices.py + pack_champions.py against the staging
        dir to rebuild matrices.bin / index.json / champions.json.
    7.  Upload the three artifacts to s3://{bucket}/{prefix_out}{tier}/.

Per-tier independence: this script refreshes ONE tier per invocation. The
matchup/synergy CSVs in the staging dir are overwritten each time, so
matrices.bin always reflects the most recently refreshed tier. PR tables
are tier-keyed so all tiers' PR tables coexist in champions.json.

Usage:
    REFRESH_TIER=diamond REFRESH_PATCH_RANGE=26.01-26.05 \\
    S3_BUCKET=my-bucket python data_prep/refresh.py

Skip a stage with the --skip flag when iterating:
    python data_prep/refresh.py --skip aggregate,upload
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "data_prep"))
sys.path.insert(0, str(ROOT / "_reference_backend"))

from aggregate_matches import write_aggregates  # noqa: E402
from incremental import aggregate_incremental  # noqa: E402
import irt  # noqa: E402
from refresh_config import RefreshConfig  # noqa: E402
from shrinkage import (add_eb_columns, add_hier_columns,  # noqa: E402
                        tau_sidecar_rows)
import s3_io  # noqa: E402

STAGING_DIR = ROOT / "dist" / "staged"


def _max_patch_from_range(patch_range: str) -> str | None:
    """'16.1-16.10' → '16.10'. '16.9' → '16.9'. Handles open ranges too.
    Picks the lexically-greatest dotted token by numeric component order."""
    tokens = re.findall(r"\d+\.\d+", patch_range or "")
    if not tokens:
        return None
    def _key(t: str) -> tuple[int, int]:
        a, b = t.split(".", 1)
        return (int(a), int(b))
    return max(tokens, key=_key)


def _stage_pull(cfg: RefreshConfig) -> list[Path]:
    work = ROOT / "dist" / "raw_cache"
    print(f"[pull] sourcing feathers (s3={cfg.use_s3})")
    paths = s3_io.pull_feathers(cfg, work)
    print(f"[pull] {len(paths)} feather files")
    if not paths:
        raise SystemExit("no feathers found — check S3 prefix / LOCAL_RAW_DIR / regions")
    return paths


def _stage_aggregate(cfg: RefreshConfig, feather_paths: list[Path]) -> Path:
    out_dir = cfg.staging_dir
    print(f"[aggregate] tier={cfg.tier} → {out_dir} (incremental)")
    dfs = aggregate_incremental(cfg, feather_paths)
    write_aggregates(out_dir, dfs)
    print(f"[aggregate] wrote {len(dfs)} files")
    return out_dir


def _matchup_csvs(d: Path) -> list[Path]:
    return sorted(d.glob("matchup_*_vs_*.csv"))


def _synergy_csvs(d: Path) -> list[Path]:
    return sorted(d.glob("synergy_*_*.csv"))


def _stage_eb(refreshed_dir: Path) -> None:
    print("[eb] empirical-Bayes shrinkage")
    for csv in _matchup_csvs(refreshed_dir) + _synergy_csvs(refreshed_dir):
        df = pd.read_csv(csv)
        if df.empty:
            continue
        add_eb_columns(df)
        df.to_csv(csv, index=False)


def _parse_pair(name: str) -> tuple[str, str, str]:
    """('matchup_TOP_vs_JUNGLE.csv') → ('matchup', 'TOP', 'JUNGLE')."""
    stem = Path(name).stem
    if stem.startswith("matchup_") and "_vs_" in stem:
        body = stem[len("matchup_"):]
        ra, rb = body.split("_vs_")
        return "matchup", ra, rb
    if stem.startswith("synergy_"):
        ra, rb = stem[len("synergy_"):].split("_", 1)
        return "synergy", ra, rb
    raise ValueError(name)


def _stage_hier(cfg: RefreshConfig, refreshed_dir: Path) -> None:
    print(f"[hier] hierarchical Bayes (warmup={cfg.hmc_warmup}, "
          f"draws={cfg.hmc_draws}, chains={cfg.hmc_chains})")
    for csv in _matchup_csvs(refreshed_dir) + _synergy_csvs(refreshed_dir):
        df = pd.read_csv(csv)
        if df.empty:
            continue
        mode, ra, rb = _parse_pair(csv.name)
        a_col = f"champion_{ra}"
        b_col = f"opponent_{rb}" if mode == "matchup" else f"champion_{rb}"
        df, taus = add_hier_columns(
            df, ra, rb, a_col, b_col,
            cfg.hmc_warmup, cfg.hmc_draws, cfg.hmc_chains,
        )
        df.to_csv(csv, index=False)
        tau_sidecar_rows(ra, rb, taus["tight"]).to_csv(
            refreshed_dir / f"tau_{csv.name}", index=False)
        tau_sidecar_rows(ra, rb, taus["wide"]).to_csv(
            refreshed_dir / f"tau_wide_{csv.name}", index=False)
        print(f"  {csv.name}: {len(df)} cells")


_HIER_COLS = ("delta_pp_shrunk", "delta_pp_shrunk_mom",
              "delta_pp_shrunk_hier", "delta_pp_shrunk_hier_wide")


def _join_keys(name: str) -> list[str] | None:
    """Identify the columns uniquely keying a row in a matchup/synergy CSV."""
    stem = Path(name).stem
    if stem.startswith("matchup_") and "_vs_" in stem:
        body = stem[len("matchup_"):]
        ra, rb = body.split("_vs_")
        return [f"champion_{ra}", f"opponent_{rb}"]
    if stem.startswith("synergy_"):
        ra, rb = stem[len("synergy_"):].split("_", 1)
        return [f"champion_{ra}", f"champion_{rb}"]
    return None


def _merge_preserving_hier(new_csv: Path, staged_csv: Path) -> None:
    """Fast-tick safety: when the freshly-aggregated CSV lacks hier/shrunk
    columns but the previously-staged version has them, carry those
    columns across by left-joining on the matchup/synergy keys.

    No-op if `staged_csv` doesn't exist or new CSV already has hier columns.
    Modifies `new_csv` in place.
    """
    keys = _join_keys(new_csv.name)
    if keys is None or not staged_csv.exists():
        return
    new_df = pd.read_csv(new_csv)
    if any(c in new_df.columns for c in ("delta_pp_shrunk_hier",
                                          "delta_pp_shrunk_hier_wide")):
        return
    old_df = pd.read_csv(staged_csv)
    carry = [c for c in _HIER_COLS if c in old_df.columns]
    if not carry:
        return
    merged = new_df.merge(
        old_df[keys + carry], on=keys, how="left", suffixes=("", "_old"))
    merged.to_csv(new_csv, index=False)


def _stage_irt(cfg: RefreshConfig, feather_paths: list[Path],
               refreshed_dir: Path) -> Path | None:
    """Fit the IRT theta table from the raw feathers and drop it next to
    the aggregated CSVs. Empty result (no in-tier matches) → no-op."""
    print("[irt] fitting item-response theta")
    df = irt.fit_theta(cfg, feather_paths)
    if df.empty:
        print("[irt] no rows (empty in-tier roster) — skipped")
        return None
    path = irt.write_theta(refreshed_dir, df)
    print(f"[irt] wrote {path.name}: {len(df)} rows")
    return path


def _stage_collect(cfg: RefreshConfig) -> Path:
    """Copy this tier's CSVs into the shared staging dir, plus rename
    pr_table.parquet → pr_table_{tier}.parquet so other tiers' PR tables
    aren't clobbered.

    On a "fast" tick (hier was skipped), carry over hier/shrunk columns
    from the previously-staged CSV before overwriting it, so pack_matrices.py
    still has the columns it requires.
    """
    STAGING_DIR.mkdir(parents=True, exist_ok=True)
    src = cfg.staging_dir
    # Pull hier columns forward (no-op if new CSV already has them).
    for pat in ("matchup_*.csv", "synergy_*.csv"):
        for s in src.glob(pat):
            _merge_preserving_hier(s, STAGING_DIR / s.name)
    # Replace matchup/synergy/tau/individual files (per-tier matrices win).
    for pat in ("matchup_*.csv", "synergy_*.csv", "tau_*.csv",
                "individual_wr.csv"):
        for s in src.glob(pat):
            shutil.copy2(s, STAGING_DIR / s.name)
    # Per-tier IRT theta table (renamed so siblings can coexist alongside).
    theta = src / "theta_table.parquet"
    if theta.exists():
        shutil.copy2(theta, STAGING_DIR / f"theta_table_{cfg.tier}.parquet")
    # Rename PR parquet to tier-keyed filename.
    pr = src / "pr_table.parquet"
    if pr.exists():
        shutil.copy2(pr, STAGING_DIR / f"pr_table_{cfg.tier}.parquet")
    # Per-tier matrix jobs run on ephemeral runners, so each starts with
    # an empty STAGING_DIR. Without cross-tier sync the resulting
    # champions.json lists only this tier's rank in `patches`. Mirror our
    # PR parquet to a shared S3 prefix, then pull every sibling's down so
    # pack_champions.py sees all known tiers.
    own_pr = STAGING_DIR / f"pr_table_{cfg.tier}.parquet"
    if own_pr.exists():
        uri = s3_io.upload_shared_pr(cfg, own_pr)
        if uri:
            print(f"[collect] shared PR up: {uri}")
    siblings = s3_io.download_shared_pr(cfg, STAGING_DIR)
    sib_names = sorted(p.name for p in siblings if p.name != own_pr.name)
    if sib_names:
        print(f"[collect] shared PR down: {len(sib_names)} sibling(s) "
              f"({', '.join(n.removeprefix('pr_table_').removesuffix('.parquet') for n in sib_names)})")
    # Stamp a small metadata file the packers consume so the frontend can
    # show the real patch version (and region list) without anyone having
    # to hand-edit HTML each cycle. Written every collect so it always
    # reflects the most recent refresh's config.
    meta = {
        "data_patch": _max_patch_from_range(cfg.patch_range),
        "patch_range": cfg.patch_range,
        "regions": cfg.regions,
        "queue": cfg.queue,
        "refreshed_at": cfg.version,
    }
    (STAGING_DIR / "data_meta.json").write_text(json.dumps(meta, indent=2))
    print(f"[collect] staged into {STAGING_DIR} (patch={meta['data_patch']})")
    return STAGING_DIR


def _stage_pack(cfg: RefreshConfig, staging_dir: Path) -> list[Path]:
    print("[pack] running pack_matrices.py + pack_champions.py")
    env = os.environ.copy()
    env["POOL_DESIGNER_DATA_DIR"] = str(staging_dir)
    py = sys.executable
    for script in ("pack_matrices.py", "pack_champions.py"):
        subprocess.run([py, str(ROOT / "data_prep" / script)],
                       env=env, check=True, cwd=str(ROOT))
    dist = ROOT / "dist"
    out = [dist / "matrices.bin", dist / "index.json", dist / "champions.json"]
    # Ship this tier's theta table alongside the matrices so consumers can
    # opt in to IRT-based displays without a separate fetch path.
    theta = staging_dir / f"theta_table_{cfg.tier}.parquet"
    if theta.exists():
        out.append(theta)
    return out


def _stage_upload(cfg: RefreshConfig, artifacts: list[Path], refresh_kind: str) -> None:
    if not cfg.s3_bucket:
        print("[upload] skipped (S3_BUCKET unset)")
        return
    result = s3_io.upload_artifacts(cfg, artifacts)
    print(f"[upload] tier={cfg.tier} version={result['version']} kind={refresh_kind}")
    for u in result["uris"]:
        print(f"  → {u}")
    manifest = s3_io.update_manifest(cfg, refresh_kind=refresh_kind)
    print(f"[upload] manifest updated: {len(manifest.get('tiers', {}))} tier(s) tracked")


STAGES = ["pull", "aggregate", "irt", "eb", "hier", "collect", "pack",
          "upload"]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip", default="",
                    help="comma-separated stages to skip "
                         f"(choices: {','.join(STAGES)})")
    ap.add_argument("--only", default="",
                    help="comma-separated stages to run; everything else skipped")
    args = ap.parse_args()

    cfg = RefreshConfig.from_env()
    skip = {s.strip() for s in args.skip.split(",") if s.strip()}
    if args.only:
        keep = {s.strip() for s in args.only.split(",") if s.strip()}
        skip |= set(STAGES) - keep
    print(f"[refresh] tier={cfg.tier} queue={cfg.queue} "
          f"patches={cfg.patch_range} regions={cfg.regions}")
    print(f"[refresh] version={cfg.version}")
    print(f"[refresh] stages: {[s for s in STAGES if s not in skip]}")

    feathers: list[Path] = []
    refreshed = cfg.staging_dir
    artifacts: list[Path] = []

    if "pull" not in skip:
        feathers = _stage_pull(cfg)
    if "aggregate" not in skip:
        if not feathers:
            feathers = _stage_pull(cfg)
        refreshed = _stage_aggregate(cfg, feathers)
    if "irt" not in skip:
        if not feathers:
            feathers = _stage_pull(cfg)
        _stage_irt(cfg, feathers, refreshed)
    if "eb" not in skip:
        _stage_eb(refreshed)
    if "hier" not in skip:
        _stage_hier(cfg, refreshed)
    if "collect" not in skip:
        _stage_collect(cfg)
    if "pack" not in skip:
        artifacts = _stage_pack(cfg, STAGING_DIR)
    if "upload" not in skip:
        if not artifacts:
            dist = ROOT / "dist"
            artifacts = [dist / "matrices.bin", dist / "index.json",
                         dist / "champions.json"]
            theta = STAGING_DIR / f"theta_table_{cfg.tier}.parquet"
            if theta.exists():
                artifacts.append(theta)
        # "full" if hier-Bayes ran this tick, "fast" if we skipped it.
        refresh_kind = "fast" if "hier" in skip else "full"
        _stage_upload(cfg, artifacts, refresh_kind)


if __name__ == "__main__":
    main()
