"""Configuration for the S3 → matrices refresh pipeline.

All knobs are environment variables so the same code runs locally,
in CI, and in a Lambda/cron container.

Environment variables
---------------------
S3_BUCKET                  — bucket holding both raw puller output and
                             refreshed artifacts. Required for S3 mode.
S3_PREFIX_RAW              — prefix where the riot-api-pull-pipeline writes
                             feathers/parquets. Default: "raw/".
S3_PREFIX_OUT              — prefix where matrices.bin etc. are uploaded.
                             Default: "artifacts/".
AWS_REGION                 — AWS region for the bucket. Default: us-east-1.
AWS_PROFILE                — boto3 profile name (optional).

LOCAL_RAW_DIR              — local override for S3 raw input (skip S3 entirely).
                             When set, S3_BUCKET is ignored on the read path.
LOCAL_OUT_DIR              — local override for output. Default: ./dist.

REFRESH_TIER               — rank tier to refresh: silver|gold|platinum|
                             emerald|diamond|master_plus. Required.
REFRESH_QUEUE              — queue family: ranked_solo|ranked_flex|normals.
                             Default: ranked_solo.
REFRESH_PATCH_RANGE        — patch-range string used in the puller's
                             matchIds_v2/{patch_range}/ layout, e.g.
                             "26.01-26.05". Required.
REFRESH_REGIONS            — comma-separated list. Default: NA1,KR,EUW1.
REFRESH_PR_FLOOR           — minimum pick-rate to include a champion in
                             output matrices. Default: 0.001.
REFRESH_MIN_GAMES_CELL     — minimum games for a (champ_a, champ_b) cell
                             to be retained pre-shrinkage. Default: 50.
REFRESH_HMC_DRAWS          — NUTS draws per chain for hierarchical Bayes.
                             Default: 1000.
REFRESH_HMC_WARMUP         — NUTS warmup draws. Default: 1000.
REFRESH_HMC_CHAINS         — NUTS chains. Default: 2.
"""
from __future__ import annotations

import datetime as _dt
import os
from dataclasses import dataclass
from pathlib import Path

ROLES = ["TOP", "JUNGLE", "MID", "ADC", "SUP"]
TIERS = ["iron", "bronze", "silver", "gold", "platinum",
         "emerald", "diamond", "master_plus"]

# Maps the puller's TEAM_POSITION strings to our role labels.
RIOT_LANE_TO_ROLE = {
    "TOP":     "TOP",
    "JUNGLE":  "JUNGLE",
    "MIDDLE":  "MID",
    "BOTTOM":  "ADC",
    "UTILITY": "SUP",
}

# Tier-bucket mapping used to assign each participant to a single tier
# bracket. master/grandmaster/challenger collapse into "master_plus" to
# match the existing rank dropdown in the frontend.
TIER_TO_BUCKET = {
    "IRON":        "iron",
    "BRONZE":      "bronze",
    "SILVER":      "silver",
    "GOLD":        "gold",
    "PLATINUM":    "platinum",
    "EMERALD":     "emerald",
    "DIAMOND":     "diamond",
    "MASTER":      "master_plus",
    "GRANDMASTER": "master_plus",
    "CHALLENGER":  "master_plus",
}


@dataclass
class RefreshConfig:
    tier: str
    queue: str
    patch_range: str
    regions: list[str]
    s3_bucket: str | None
    s3_prefix_raw: str
    s3_prefix_out: str
    aws_region: str
    aws_profile: str | None
    local_raw_dir: Path | None
    local_out_dir: Path
    pr_floor: float
    min_games_cell: int
    hmc_draws: int
    hmc_warmup: int
    hmc_chains: int
    version: str

    @classmethod
    def from_env(cls) -> "RefreshConfig":
        tier = _require("REFRESH_TIER")
        if tier not in TIERS:
            raise SystemExit(f"REFRESH_TIER={tier!r} not in {TIERS}")
        local_raw = os.environ.get("LOCAL_RAW_DIR")
        return cls(
            tier=tier,
            queue=os.environ.get("REFRESH_QUEUE", "ranked_solo"),
            patch_range=_require("REFRESH_PATCH_RANGE"),
            regions=[r.strip() for r in
                     os.environ.get("REFRESH_REGIONS", "NA1,KR,EUW1").split(",") if r.strip()],
            s3_bucket=os.environ.get("S3_BUCKET"),
            s3_prefix_raw=os.environ.get("S3_PREFIX_RAW", "raw/feather/").rstrip("/") + "/",
            s3_prefix_out=os.environ.get("S3_PREFIX_OUT", "artifacts/").rstrip("/") + "/",
            aws_region=os.environ.get("AWS_REGION", "us-east-1"),
            aws_profile=os.environ.get("AWS_PROFILE"),
            local_raw_dir=Path(local_raw) if local_raw else None,
            local_out_dir=Path(os.environ.get("LOCAL_OUT_DIR", "dist")).resolve(),
            pr_floor=_pos_float("REFRESH_PR_FLOOR", 0.001),
            min_games_cell=_pos_int("REFRESH_MIN_GAMES_CELL", 50),
            hmc_draws=_pos_int("REFRESH_HMC_DRAWS", 1000),
            hmc_warmup=_pos_int("REFRESH_HMC_WARMUP", 1000),
            hmc_chains=_pos_int("REFRESH_HMC_CHAINS", 2),
            version=os.environ.get(
                "REFRESH_VERSION",
                _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ"),
            ),
        )

    @property
    def use_s3(self) -> bool:
        return self.local_raw_dir is None

    @property
    def staging_dir(self) -> Path:
        """Where intermediate CSVs land before being packed into matrices.bin."""
        return self.local_out_dir / "refreshed" / self.tier


def _require(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        raise SystemExit(f"missing required env var {name}")
    return v


def _pos_int(name: str, default: int) -> int:
    """Parse an int env var, requiring value > 0. Bad input fails loud rather
    than crashing deep inside numpyro / pandas with an opaque traceback."""
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        v = int(raw)
    except ValueError:
        raise SystemExit(f"{name}={raw!r} not an integer")
    if v <= 0:
        raise SystemExit(f"{name}={v} must be > 0")
    return v


def _pos_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        v = float(raw)
    except ValueError:
        raise SystemExit(f"{name}={raw!r} not a float")
    if v < 0:
        raise SystemExit(f"{name}={v} must be >= 0")
    return v
