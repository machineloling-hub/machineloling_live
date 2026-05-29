"""Per-feather incremental aggregation cache.

Phase 2 of the refresh plan: turn re-aggregation from O(all feathers) per
2h tick into O(only-new-feathers). The expensive work is the inner
participants_data JSON parsing in `aggregate_matches._count_feather_rows`;
its output for one (feather, tier) is deterministic, so we memoize it as
four parquet files on disk and merge across feathers at the end.

On-disk layout (under cfg.local_out_dir / "partials" / cfg.tier):

    _state.json
        {
          "schema": 1,
          "tier": "diamond",
          "feathers": {
              "<feather_id>": {
                  "hash": "<sha256[:16]>",
                  "n_rows": <int>,
                  "size": <int bytes>,
                  "processed_at": "<iso8601 UTC>"
              },
              ...
          }
        }
    <hash>/matchup.parquet
    <hash>/synergy.parquet
    <hash>/individual.parquet
    <hash>/pr.parquet

`feather_id` is a stable string identifying the feather across runs:
  - S3 mode:   "s3://{bucket}/{prefix}{relative_path}"
  - local mode: "local://{relative_path}"
The hash is derived purely from the id, so the on-disk path is
deterministic and hash collisions across runs are impossible.

State invalidation: if (size, n_rows) on disk doesn't match the recorded
state, the partial is recomputed. This catches the case where the
upstream puller appends to a feather mid-batch. ETag-conditional checks
against S3 are deferred (puller currently writes-once).

Currently the cache lives only on the local filesystem; promoting to S3
(so cron runners on fresh VMs can share it) is the next sub-phase. The
state file format is forward-compatible with that move.
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import json
from pathlib import Path

import pandas as pd
from aggregate_matches import count_one_feather, merge_partials, read_partial, write_partial
from refresh_config import RefreshConfig

_STATE_SCHEMA = 1


def _partials_root(cfg: RefreshConfig) -> Path:
    return cfg.local_out_dir / "partials" / cfg.tier


def _state_path(cfg: RefreshConfig) -> Path:
    return _partials_root(cfg) / "_state.json"


def feather_id(cfg: RefreshConfig, feather_path: Path) -> str:
    """Stable identifier for a feather across runs.

    For S3 inputs we use the absolute s3:// URI so the cache key survives
    re-downloads to a different local cache root. For local inputs we use
    the path relative to LOCAL_RAW_DIR so moving the project doesn't
    invalidate everything.
    """
    if cfg.use_s3:
        # _stage_pull mirrors keys to dist/raw_cache/{key-relative-to-prefix}.
        cache_root = cfg.local_out_dir / "raw_cache"
        try:
            rel = feather_path.resolve().relative_to(cache_root.resolve())
        except ValueError:
            rel = Path(feather_path.name)
        rel_str = rel.as_posix()
        return f"s3://{cfg.s3_bucket}/{cfg.s3_prefix_raw}{rel_str}"
    if cfg.local_raw_dir:
        try:
            rel = feather_path.resolve().relative_to(cfg.local_raw_dir.resolve())
        except ValueError:
            rel = Path(feather_path.name)
        return f"local://{rel.as_posix()}"
    return f"local://{feather_path.as_posix()}"


def _hash(fid: str) -> str:
    return hashlib.sha256(fid.encode("utf-8")).hexdigest()[:16]


def _load_state(cfg: RefreshConfig) -> dict:
    p = _state_path(cfg)
    if not p.exists():
        return {"schema": _STATE_SCHEMA, "tier": cfg.tier, "feathers": {}}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        # Corrupted state — treat as empty; partials on disk will be
        # rediscovered/recomputed lazily.
        return {"schema": _STATE_SCHEMA, "tier": cfg.tier, "feathers": {}}
    data.setdefault("schema", _STATE_SCHEMA)
    data.setdefault("tier", cfg.tier)
    data.setdefault("feathers", {})
    return data


def _save_state(cfg: RefreshConfig, state: dict) -> None:
    p = _state_path(cfg)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")
    tmp.replace(p)


def _partial_dir(cfg: RefreshConfig, h: str) -> Path:
    return _partials_root(cfg) / h


def _partial_complete(d: Path) -> bool:
    return all((d / f"{k}.parquet").exists()
               for k in ("matchup", "synergy", "individual", "pr"))


def aggregate_incremental(
    cfg: RefreshConfig,
    feather_paths: list[Path],
    *,
    sync_s3: bool = True,
) -> dict[str, pd.DataFrame]:
    """Memoized version of `aggregate_tier`.

    For each feather: reuse the cached partial if (size, n_rows) match the
    recorded state and all four parquets exist; otherwise recompute and
    write the partial. Then merge all partials.

    When `sync_s3` is true and an S3 bucket is configured, the partials
    cache is downloaded from S3 before the pass and uploaded back after,
    so cron runners on fresh VMs share the cache.
    """
    root = _partials_root(cfg)
    root.mkdir(parents=True, exist_ok=True)

    if sync_s3 and cfg.use_s3 and cfg.s3_bucket:
        try:
            import s3_io  # local import: keep boto3 optional for unit tests
            n_dl = s3_io.download_partials(cfg, root)
            print(f"[incremental] s3 cache: downloaded {n_dl} object(s)")
        except Exception as e:
            print(f"[incremental] s3 cache download failed (continuing local-only): {e}")

    state = _load_state(cfg)
    feathers = state["feathers"]

    n_total = len(feather_paths)
    n_cached = 0
    n_computed = 0
    partials: list[dict[str, pd.DataFrame]] = []
    seen_ids: set[str] = set()
    seen_hashes: set[str] = set()

    for fp in feather_paths:
        try:
            size = fp.stat().st_size
        except FileNotFoundError:
            print(f"  [incremental] missing feather, skipping: {fp}")
            continue
        fid = feather_id(cfg, fp)
        seen_ids.add(fid)
        h = _hash(fid)
        seen_hashes.add(h)
        d = _partial_dir(cfg, h)
        rec = feathers.get(fid)

        cached = (
            rec is not None
            and rec.get("hash") == h
            and rec.get("size") == size
            and _partial_complete(d)
        )
        if cached:
            try:
                partials.append(read_partial(d))
                n_cached += 1
                continue
            except Exception as e:
                print(f"  [incremental] cached partial unreadable, recomputing"
                      f" ({e}): {fid}")

        try:
            partial = count_one_feather(cfg, fp)
        except Exception as e:
            print(f"  [incremental] failed to process {fp.name}: {e}")
            continue
        write_partial(d, partial)
        partials.append(partial)
        n_computed += 1

        n_rows = int(
            partial["matchup"]["games"].sum()
            + partial["synergy"]["games"].sum()
            + partial["individual"]["games"].sum()
            + partial["pr"]["games"].sum()
        )
        feathers[fid] = {
            "hash": h,
            "n_rows": n_rows,
            "size": size,
            "processed_at": _dt.datetime.now(_dt.UTC).strftime(
                "%Y-%m-%dT%H:%M:%SZ"),
        }

    # Drop state entries for feathers not in this batch.
    stale_ids = [fid for fid in feathers if fid not in seen_ids]
    stale_hashes = [feathers[fid].get("hash") for fid in stale_ids
                    if feathers[fid].get("hash")]
    state["feathers"] = {fid: rec for fid, rec in feathers.items()
                         if fid in seen_ids}
    _save_state(cfg, state)

    # Local-disk retention: drop partial dirs no longer referenced.
    n_pruned_local = 0
    for sub in root.iterdir():
        if not sub.is_dir():
            continue
        if sub.name not in seen_hashes:
            try:
                for f in sub.iterdir():
                    f.unlink(missing_ok=True)
                sub.rmdir()
                n_pruned_local += 1
            except OSError:
                pass

    if sync_s3 and cfg.use_s3 and cfg.s3_bucket:
        try:
            import s3_io
            n_ul = s3_io.upload_partials(cfg, root)
            n_del = s3_io.delete_partial_dirs(cfg, [h for h in stale_hashes if h])
            print(f"[incremental] s3 cache: uploaded {n_ul} object(s), "
                  f"deleted {n_del} stale object(s)")
        except Exception as e:
            print(f"[incremental] s3 cache upload failed: {e}")

    print(f"[incremental] tier={cfg.tier} feathers={n_total} "
          f"cached={n_cached} computed={n_computed} pruned_local={n_pruned_local}")

    return merge_partials(cfg, partials)
