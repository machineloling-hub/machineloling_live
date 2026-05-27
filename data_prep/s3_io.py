"""Thin S3 wrapper used by the refresh pipeline.

Imports boto3 lazily so unit tests / local-only runs don't require it.
All operations accept either an S3 URI string or a (bucket, key) tuple.
"""
from __future__ import annotations

import datetime as _dt
import json as _json
from pathlib import Path
from typing import Iterable

from refresh_config import RefreshConfig

MANIFEST_KEY_SUFFIX = "manifest.json"


def _client(cfg: RefreshConfig):
    import boto3  # type: ignore
    session = boto3.Session(profile_name=cfg.aws_profile) if cfg.aws_profile else boto3.Session()
    return session.client("s3", region_name=cfg.aws_region)


def list_keys(cfg: RefreshConfig, prefix: str) -> list[str]:
    """List all object keys under `prefix` within cfg.s3_bucket."""
    if not cfg.s3_bucket:
        raise RuntimeError("S3_BUCKET not configured")
    s3 = _client(cfg)
    paginator = s3.get_paginator("list_objects_v2")
    out: list[str] = []
    for page in paginator.paginate(Bucket=cfg.s3_bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            out.append(obj["Key"])
    return out


def download(cfg: RefreshConfig, key: str, dest: Path) -> Path:
    """Download s3://bucket/key to a local Path. Skips if dest already exists
    and is non-empty (idempotent re-runs)."""
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    s3 = _client(cfg)
    s3.download_file(cfg.s3_bucket, key, str(dest))
    return dest


def upload(cfg: RefreshConfig, src: Path, key: str, content_type: str | None = None) -> str:
    """Upload a local file to s3://bucket/key. Returns the full s3:// URI."""
    if not cfg.s3_bucket:
        raise RuntimeError("S3_BUCKET not configured")
    s3 = _client(cfg)
    extra = {"ContentType": content_type} if content_type else {}
    s3.upload_file(str(src), cfg.s3_bucket, key, ExtraArgs=extra)
    return f"s3://{cfg.s3_bucket}/{key}"


def _expand_patch_range(spec: str) -> list[str] | None:
    """Parse a patch-range spec into a list of patch strings.

    Accepts:
      - "16.1-16.5"      → ["16.1","16.2","16.3","16.4","16.5"]
      - "16.1,16.3,16.7" → ["16.1","16.3","16.7"]
      - "16.1"           → ["16.1"]
      - "*" or "" or None → None  (meaning: no filter)
    Returns None if the spec is unparseable — caller falls back to no filter.
    """
    if not spec or spec.strip() in ("*", "all"):
        return None
    if "," in spec:
        return [p.strip() for p in spec.split(",") if p.strip()]
    if "-" in spec:
        try:
            lo, hi = spec.split("-", 1)
            major_lo, minor_lo = lo.strip().split(".")
            major_hi, minor_hi = hi.strip().split(".")
            if major_lo != major_hi:
                return None  # cross-major ranges: too ambiguous, skip
            return [f"{major_lo}.{m}" for m in
                    range(int(minor_lo), int(minor_hi) + 1)]
        except (ValueError, IndexError):
            return None
    return [spec.strip()]


def pull_feathers(cfg: RefreshConfig, dest_root: Path) -> list[Path]:
    """Mirror match-result feathers for the configured queue + patch range
    + regions to a local directory tree. Returns the list of local paths.

    Expected S3 layout:
        {S3_PREFIX_RAW}{queue}/{patch}/{region}/*.feather

    The puller writes to s3://{bucket}/raw/feather/..., so set
    S3_PREFIX_RAW=raw/feather/ (no trailing slash needed; from_env normalises).
    """
    out: list[Path] = []
    patches = _expand_patch_range(cfg.patch_range)

    if not cfg.use_s3:
        # Local mode: glob the LOCAL_RAW_DIR copy.
        # Tries both legacy {root}/matchResults_v2/{queue}/... and the
        # current {root}/{queue}/... layouts.
        candidates = [
            cfg.local_raw_dir / "matchResults_v2" / cfg.queue,
            cfg.local_raw_dir / cfg.queue,
        ]
        for root in candidates:
            if not root.exists():
                continue
            for region in cfg.regions:
                for p in root.rglob(f"{region}/match_results_part_*.feather"):
                    if patches is not None:
                        # Path: {root}/{patch}/{region}/file
                        try:
                            patch = p.parent.parent.name
                            if patch not in patches:
                                continue
                        except Exception:
                            pass
                    out.append(p)
        return out

    # S3 mode: list everything under {prefix}{queue}/ then filter by
    # (patch, region). Cheaper than per-(patch, region) ListObjectsV2
    # calls when patches and regions are small.
    base = f"{cfg.s3_prefix_raw}{cfg.queue}/"
    for key in list_keys(cfg, base):
        if not key.endswith(".feather"):
            continue
        # Path-relative-to-prefix: {queue}/{patch}/{region}/{filename}
        parts = key[len(cfg.s3_prefix_raw):].split("/")
        if len(parts) < 4:
            continue
        _, patch, region, _ = parts[0], parts[1], parts[2], parts[3]
        if region not in cfg.regions:
            continue
        if patches is not None and patch not in patches:
            continue
        local = dest_root / Path(*parts)
        download(cfg, key, local)
        out.append(local)
    return out


def _content_type(suffix: str) -> str | None:
    if suffix == ".bin":
        return "application/octet-stream"
    if suffix == ".json":
        return "application/json"
    return None


def upload_artifacts(cfg: RefreshConfig, files: Iterable[Path]) -> dict:
    """Upload each artifact to two locations:
      1. {prefix_out}{tier}/v/{version}/{filename}  — immutable, long cache.
      2. {prefix_out}{tier}/latest/{filename}       — mutable mirror, no cache.

    The versioned path is what the manifest will point at; the `latest/`
    mirror keeps the pre-Phase-1 read path working unchanged.

    Returns {'version': str, 'tier': str, 'uris': [...]}.
    """
    if not cfg.s3_bucket:
        return {"version": cfg.version, "tier": cfg.tier, "uris": []}

    files = list(files)
    s3 = _client(cfg)
    versioned_prefix = f"{cfg.s3_prefix_out}{cfg.tier}/v/{cfg.version}/"
    latest_prefix = f"{cfg.s3_prefix_out}{cfg.tier}/latest/"
    uris: list[str] = []

    for f in files:
        ct = _content_type(f.suffix)

        # 1. Versioned, immutable — safe to cache forever.
        vkey = versioned_prefix + f.name
        extra_v = {"CacheControl": "public, max-age=31536000, immutable"}
        if ct:
            extra_v["ContentType"] = ct
        s3.upload_file(str(f), cfg.s3_bucket, vkey, ExtraArgs=extra_v)
        uris.append(f"s3://{cfg.s3_bucket}/{vkey}")

        # 2. Latest mirror — overwrites previous, force revalidation.
        lkey = latest_prefix + f.name
        extra_l = {"CacheControl": "no-cache"}
        if ct:
            extra_l["ContentType"] = ct
        s3.upload_file(str(f), cfg.s3_bucket, lkey, ExtraArgs=extra_l)
        uris.append(f"s3://{cfg.s3_bucket}/{lkey}")

    return {"version": cfg.version, "tier": cfg.tier, "uris": uris}


# ────────────────────────────────────────────────────────────────────────
# Phase-2b: partials cache sync (so cron runners share state)
# ────────────────────────────────────────────────────────────────────────
#
# On-disk layout under {LOCAL_OUT_DIR}/partials/{tier}/ is mirrored to
# s3://{bucket}/{S3_PREFIX_OUT}partials/{tier}/. The cache is content-
# deterministic per (feather, tier), so mirroring is a plain blob sync —
# no merge, no conflict.

def _partials_prefix(cfg: RefreshConfig) -> str:
    return f"{cfg.s3_prefix_out}partials/{cfg.tier}/"


def download_partials(cfg: RefreshConfig, dest_root: Path) -> int:
    """Pull the partials cache for cfg.tier from S3 into `dest_root`.

    Idempotent: skips files that already exist locally with non-zero size
    (partials are content-deterministic, so size match is sufficient).
    Returns the number of objects newly downloaded.
    """
    if not cfg.s3_bucket:
        return 0
    s3 = _client(cfg)
    prefix = _partials_prefix(cfg)
    n = 0
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=cfg.s3_bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            rel = key[len(prefix):]
            if not rel:
                continue
            dest = dest_root / rel
            if dest.exists() and dest.stat().st_size > 0:
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            s3.download_file(cfg.s3_bucket, key, str(dest))
            n += 1
    return n


def upload_partials(cfg: RefreshConfig, src_root: Path) -> int:
    """Mirror the local partials cache for cfg.tier up to S3.

    Idempotent: skips objects already present at the same size on the
    remote. Always re-uploads `_state.json` (small, must be current).
    Returns the number of objects newly uploaded.
    """
    if not cfg.s3_bucket or not src_root.exists():
        return 0
    s3 = _client(cfg)
    prefix = _partials_prefix(cfg)

    remote_sizes: dict[str, int] = {}
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=cfg.s3_bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            remote_sizes[obj["Key"][len(prefix):]] = int(obj["Size"])

    n = 0
    for f in src_root.rglob("*"):
        if not f.is_file():
            continue
        rel = f.relative_to(src_root).as_posix()
        size = f.stat().st_size
        if rel != "_state.json" and remote_sizes.get(rel) == size:
            continue
        key = prefix + rel
        ct = "application/json" if rel == "_state.json" else "application/octet-stream"
        s3.upload_file(str(f), cfg.s3_bucket, key,
                       ExtraArgs={"ContentType": ct})
        n += 1
    return n


def delete_partial_dirs(cfg: RefreshConfig, hashes: list[str]) -> int:
    """Delete partial directories from S3 for the given hash names.
    Used by the local retention pass to keep the remote cache from
    growing unboundedly. Returns count of objects deleted."""
    if not cfg.s3_bucket or not hashes:
        return 0
    s3 = _client(cfg)
    prefix = _partials_prefix(cfg)
    n = 0
    for h in hashes:
        sub = f"{prefix}{h}/"
        paginator = s3.get_paginator("list_objects_v2")
        keys: list[dict] = []
        for page in paginator.paginate(Bucket=cfg.s3_bucket, Prefix=sub):
            for obj in page.get("Contents", []):
                keys.append({"Key": obj["Key"]})
                if len(keys) == 1000:
                    s3.delete_objects(Bucket=cfg.s3_bucket,
                                      Delete={"Objects": keys})
                    n += len(keys)
                    keys = []
        if keys:
            s3.delete_objects(Bucket=cfg.s3_bucket, Delete={"Objects": keys})
            n += len(keys)
    return n


def _manifest_key(cfg: RefreshConfig) -> str:
    return f"{cfg.s3_prefix_out}{MANIFEST_KEY_SUFFIX}"


# ─────────────────────────────────────────────────────────────────────
# Cross-tier PR parquet share
# ─────────────────────────────────────────────────────────────────────
# Per-tier refresh jobs run on ephemeral runners (GH Actions matrix). Each
# only writes its own pr_table_{tier}.parquet, so without cross-tier sync
# the resulting champions.json lists only one rank in `patches`. We mirror
# each tier's staged parquet to a shared prefix and pull every sibling's
# down before packing, so champions.json always enumerates all tiers that
# have ever been refreshed.

def _shared_pr_prefix(cfg: RefreshConfig) -> str:
    return f"{cfg.s3_prefix_out}_shared_pr/"


def upload_shared_pr(cfg: RefreshConfig, src: Path) -> str | None:
    """Upload this tier's staged pr_table_{tier}.parquet to the shared prefix.
    Returns the s3:// URI, or None if no bucket / file missing."""
    if not cfg.s3_bucket or not src.exists():
        return None
    s3 = _client(cfg)
    key = f"{_shared_pr_prefix(cfg)}pr_table_{cfg.tier}.parquet"
    s3.upload_file(str(src), cfg.s3_bucket, key, ExtraArgs={
        "ContentType": "application/octet-stream",
        "CacheControl": "no-cache",
    })
    return f"s3://{cfg.s3_bucket}/{key}"


def download_shared_pr(cfg: RefreshConfig, dest_dir: Path) -> list[Path]:
    """Pull every other tier's pr_table_{tier}.parquet from the shared
    prefix into `dest_dir`. Skips files already present locally with
    non-zero size (the current tier's file is written by the local
    collect step and shouldn't be clobbered)."""
    if not cfg.s3_bucket:
        return []
    s3 = _client(cfg)
    prefix = _shared_pr_prefix(cfg)
    out: list[Path] = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=cfg.s3_bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            name = key[len(prefix):]
            if not name.startswith("pr_table_") or not name.endswith(".parquet"):
                continue
            dest = dest_dir / name
            if dest.exists() and dest.stat().st_size > 0:
                out.append(dest)
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            s3.download_file(cfg.s3_bucket, key, str(dest))
            out.append(dest)
    return out


def update_manifest(cfg: RefreshConfig, refresh_kind: str = "full") -> dict:
    """Read-modify-write the top-level manifest with this tier's new version.
    Last step of a refresh — readers tolerate stale, never broken.

    Race note: concurrent refreshes of different tiers can clobber each
    other's manifest entry. Phase 1 assumption is one refresh at a time;
    add ETag-conditional writes if you parallelize tiers.
    """
    if not cfg.s3_bucket:
        return {}
    s3 = _client(cfg)
    key = _manifest_key(cfg)

    manifest: dict = {"schema": 1, "tiers": {}}
    try:
        obj = s3.get_object(Bucket=cfg.s3_bucket, Key=key)
        loaded = _json.loads(obj["Body"].read())
        if isinstance(loaded, dict):
            manifest = loaded
            manifest.setdefault("schema", 1)
            manifest.setdefault("tiers", {})
    except s3.exceptions.NoSuchKey:
        pass
    except Exception as e:
        # Don't silently lose other tiers if the manifest is unreadable —
        # surface it so the operator can investigate before the write
        # overwrites real data with a fresh-empty one.
        raise RuntimeError(f"failed to read existing manifest at s3://{cfg.s3_bucket}/{key}: {e}")

    manifest["tiers"][cfg.tier] = {
        "version": cfg.version,
        "refresh_kind": refresh_kind,
    }
    manifest["generated_at"] = _dt.datetime.now(
        _dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    body = _json.dumps(manifest, indent=2, sort_keys=True).encode("utf-8")
    s3.put_object(
        Bucket=cfg.s3_bucket,
        Key=key,
        Body=body,
        ContentType="application/json",
        CacheControl="no-cache",
    )
    return manifest
