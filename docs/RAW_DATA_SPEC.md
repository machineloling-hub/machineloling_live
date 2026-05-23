# Raw match-data spec for the pool-designer pipeline

Authoritative contract between the **Riot API puller** (upstream producer) and
the **pool-designer refresh pipeline** (downstream consumer in this repo,
`data_prep/refresh.py`).

If a producer writes feathers conforming to this spec into the documented S3
layout, the downstream `refresh.py` cron will pick them up automatically — no
code changes needed on the consumer side.

---

## 1. Storage layout

All raw data lives in **one S3 bucket** (default name in our deployment:
`machineloling`). The puller writes Apache Arrow `.feather` files under a
prefix that the consumer reads via `S3_PREFIX_RAW` (default `raw/feather/`):

```
s3://{bucket}/{S3_PREFIX_RAW}{queue}/{patch}/{region}/match_results_part_{N}.feather
```

Concrete example:

```
s3://machineloling/raw/feather/ranked_solo/16.3/NA1/match_results_part_00042.feather
```

### Path segment rules

| Segment        | Allowed values                                                  | Notes |
| -------------- | --------------------------------------------------------------- | ----- |
| `{queue}`      | `ranked_solo`, `ranked_flex`, `normals`                         | Lowercase, snake_case. |
| `{patch}`      | `16.1`, `16.2`, …, `26.05`                                      | Match Riot's `gameVersion` major.minor. No leading zero unless minor ≥ 10. |
| `{region}`     | `NA1`, `KR`, `EUW1`, `EUNE1`, `BR1`, …                          | Uppercase Riot platform code. The consumer filters by `REFRESH_REGIONS`. |
| `{N}`          | Zero-padded integer, length producer's choice (`00000`–`99999`) | Monotone within a `(queue, patch, region)` shard so newer files sort last. Filename must start with `match_results_part_` and end with `.feather`. |

### Idempotency

Files are **append-only**. A producer must never rewrite an existing key.
To add more matches for an already-published `(queue, patch, region)`, write
the next sequential part number. The consumer has an incremental cache keyed
on the feather path; rewriting a file would silently use stale counts.

---

## 2. Feather schema

Each `.feather` file is an Arrow IPC v2 (Feather v2) file, one row per match.
Rows may appear in any order. The pipeline reads with
`pyarrow.feather.read_table(...).to_pandas()`.

### Required top-level columns

| Column                | Type     | Description |
| --------------------- | -------- | ----------- |
| `match_id`            | `string` | Full Riot match id including region prefix (`NA1_5234982134`). Used as a dedupe key. |
| `winner`              | `int8`   | `0` = blue team (`teamId=100`) won, `1` = red team (`teamId=200`) won. |
| `game_creation`       | `int64`  | Epoch milliseconds. Used for stale-data pruning. |
| `game_duration`       | `int32`  | Seconds. Producer should drop remakes (`< 300`). |
| `game_version`        | `string` | Full Riot version (`16.3.547.1234`). Must agree with the `{patch}` segment's `major.minor`. |
| `queue_id`            | `int16`  | Riot queue id (`420` solo, `440` flex, `400`/`430` normals). |
| `platform_id`         | `string` | Riot platform code, must equal the `{region}` segment. |
| `participants_data`   | `string` | **JSON string** (UTF-8) encoding a length-10 array of participant objects. Schema below. |

Additional columns are tolerated and ignored. Do **not** rename the above.

### `participants_data` element schema

`json.loads(row.participants_data)` must yield a `list[dict]` of length 10.
Each participant object must include:

| Key             | Type     | Allowed values / notes |
| --------------- | -------- | ---------------------- |
| `participantId` | `int`    | 1–10. Unique within a match. |
| `teamId`        | `int`    | `100` (blue) or `200` (red). 5 of each per match. |
| `teamPosition`  | `string` | `TOP`, `JUNGLE`, `MIDDLE`, `BOTTOM`, `UTILITY`. Empty string means "unable to assign"; such matches are skipped. |
| `championName`  | `string` | Riot's display spelling (`"Aurelion Sol"`, `"Kai'Sa"`, etc.). The downstream pipeline normalises spaces/apostrophes — do **not** pre-strip them. |
| `tier`          | `string` | One of: `IRON`, `BRONZE`, `SILVER`, `GOLD`, `PLATINUM`, `EMERALD`, `DIAMOND`, `MASTER`, `GRANDMASTER`, `CHALLENGER`. Use the participant's solo-queue tier at match time. May be null/missing for unranked accounts — those participants are excluded from tier bucketing but the row is still consumed. |

Additional participant keys (rank, kda, items, etc.) are allowed and ignored.

### Validation rules enforced downstream (will silently drop the match)

- `participants_data` not valid JSON or not length 10 → skipped.
- Any team has two participants with the same `teamPosition` (Arena, role-swap
  bugs) → skipped (the pipeline counts these as `n_dup_role_skipped`).
- `winner` not in `{0, 1}` → row crashes; producer must filter.

---

## 3. Producer responsibilities

1. **Fetch matches** for the configured `(queue, patch, region)` from Riot's
   Match-V5 API. Respect Riot rate limits — the puller is the only piece of
   infrastructure that touches Riot; the consumer never does.
2. **Filter remakes** (`gameDuration < 300`) and any matches with missing
   `teamPosition` for all 10 participants.
3. **Batch into feathers** of ~10k–50k rows each (smaller = more S3 PUTs,
   larger = more memory in the consumer).
4. **Write to S3** at the exact prefix above using server-side encryption
   defaults; no ACL needed.
5. **Never re-upload** an existing key (see "Idempotency" above).
6. **Tag the bucket** with a lifecycle rule that expires raw feathers older
   than ~6 patches (~3 months) if storage cost matters — the consumer only
   reads the patches in `REFRESH_PATCH_RANGE`.

---

## 4. Required IAM for the puller user

Minimum policy for the producer's AWS credentials:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "WriteRawFeathers",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:AbortMultipartUpload"],
      "Resource": "arn:aws:s3:::machineloling/raw/feather/*"
    },
    {
      "Sid": "ListBucketScoped",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::machineloling",
      "Condition": {
        "StringLike": {"s3:prefix": ["raw/feather/*"]}
      }
    }
  ]
}
```

The producer does **not** need read access to `artifacts/*` or write access
anywhere outside `raw/feather/*`.

---

## 5. Cadence expectations

The consumer cron runs every 2h (fast tick) and nightly (full tick); see
`.github/workflows/refresh.yml`. The producer should publish often enough that
a 2h-old `(queue, patch, region)` shard has *some* new files, otherwise the
consumer's incremental cache yields a no-op refresh.

Recommended producer cadence: **every 30–60 minutes per region**, producing
one new `match_results_part_{N}.feather` per cycle.

---

## 6. Bootstrap checklist for a new puller repo

A coding agent starting a fresh puller repo should ship, at minimum:

1. A typed config (`PullerConfig`) accepting:
   - `RIOT_API_KEY` (env)
   - `S3_BUCKET`, `S3_PREFIX_RAW` (env; default `raw/feather/`)
   - `AWS_REGION` (default `us-east-2`)
   - `QUEUE` (default `ranked_solo` → Riot queue id `420`)
   - `PATCHES` (comma list, e.g. `16.1,16.2,16.3,16.4,16.5`)
   - `REGIONS` (comma list, default `NA1,KR,EUW1`)
   - `BATCH_SIZE` (default `25000` matches per feather)
2. A discovery loop that paginates Riot's match-history endpoints
   (`/lol/match/v5/matches/by-puuid/{puuid}/ids?queue=420&...`) seeded from a
   league-list endpoint per tier, deduplicating against the most-recent
   `match_id` already on S3.
3. A fetch loop that calls `/lol/match/v5/matches/{matchId}` for each new id
   and assembles rows matching §2.
4. A write step using `pyarrow.feather.write_feather(table, path,
   compression='zstd')` then `boto3.client('s3').upload_file(path, bucket,
   key)`.
5. A `.github/workflows/pull.yml` cron (`*/30 * * * *` per region or a single
   matrix) holding the AWS + Riot secrets.
6. **Tests** that round-trip a hand-built `participants_data` JSON through
   `json.dumps` → write_feather → read_table → `json.loads` and assert the
   structure matches §2.

---

## 7. Compatibility & versioning

This spec is **v1**. Any breaking change (column rename, new required field,
layout change) must:

1. Bump a `RAW_SPEC_VERSION` constant in both repos.
2. Be deployed first as an **additive** change (consumer accepts both old and
   new) before any producer starts writing the new shape.
3. Publish a migration window (≥ 1 full patch cycle) before the old shape is
   dropped.

Non-breaking additions (new optional columns, new tiers added to the
`tier` enum) do not require a version bump but should be noted in this file's
changelog.

### Changelog

- **v1 (initial)**: feather layout, `participants_data` JSON schema, S3 path
  contract, IAM policy.
