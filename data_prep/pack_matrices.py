"""Pack matchup/synergy CSVs into a single binary blob + JSON index.

Output:
    ../dist/matrices.bin   — concatenated float16 matrices, no padding
    ../dist/index.json     — champion list, role-pair offsets, shapes

Layout of matrices.bin (all little-endian):
    [pair 0 shrunk-hier-wide, R0 rows × C0 cols, float16]
    [pair 0 raw,              R0 rows × C0 cols, float16]
    [pair 0 tau_rows,         R0 entries,        float16]
    [pair 0 tau_cols,         C0 entries,        float16]
    [pair 1 ...]
    ...

Both `shrunk` and `raw` matrices are shipped because the user-facing
`shrink_alpha` slider blends them live: mat = α·shrunk + (1-α)·raw.

The index.json tells the wasm engine where each pair lives:
    {
      "champions": {"TOP": ["Aatrox", "Akali", ...], ...},
      "matchup":  {"TOP": {"TOP": {"offset": 0, "rows_n": 92, "cols_n": 92, "rows": [...], "cols": [...]}, ...}, ...},
      "synergy":  {...}
    }

float16 is enough precision for delta-pp values (range ~[-15, +15]) and
halves the payload vs float32.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np

# matrices.bin is a raw little-endian f16 dump consumed verbatim by the
# WASM engine on any CPU. Bail loud on big-endian build hosts rather than
# silently shipping byte-swapped data.
assert sys.byteorder == "little", "pack_matrices.py requires a little-endian host"

# Reuse the existing tested loader.
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "_reference_backend"))
from data import ROLES, load_all  # noqa: E402

DATA_DIR = Path(os.environ.get("POOL_DESIGNER_DATA_DIR",
                               str(ROOT / "_data")))
DIST_DIR = Path(os.environ.get("POOL_DESIGNER_DIST_DIR",
                               str(ROOT / "dist")))


def main() -> None:
    DIST_DIR.mkdir(exist_ok=True)
    print(f"[pack_matrices] loading from {DATA_DIR}")
    store = load_all(DATA_DIR)

    bin_path = DIST_DIR / "matrices.bin"
    idx_path = DIST_DIR / "index.json"

    index: dict = {"champions": {}, "matchup": {}, "synergy": {}}
    # Champion list per role (alphabetized — same ordering wasm engine will use)
    for r in ROLES:
        index["champions"][r] = sorted(store.valid_champs[r])

    with bin_path.open("wb") as f:
        offset = 0
        for mode_name, store_dict in (("matchup", store.matchup), ("synergy", store.synergy)):
            index[mode_name] = {ra: {} for ra in ROLES}
            for ra in ROLES:
                for rb, pair in store_dict[ra].items():
                    shrunk = np.ascontiguousarray(pair.shrunk_hier_wide.astype('<f2'))
                    raw = np.ascontiguousarray(pair.raw.astype('<f2'))
                    tau_r = np.ascontiguousarray(pair.tau_rows_wide.astype('<f2'))
                    tau_c = np.ascontiguousarray(pair.tau_cols_wide.astype('<f2'))
                    index[mode_name][ra][rb] = {
                        "offset": offset,
                        "rows_n": shrunk.shape[0],
                        "cols_n": shrunk.shape[1],
                        "rows": pair.rows,
                        "cols": pair.cols,
                    }
                    f.write(shrunk.tobytes(order="C"))
                    f.write(raw.tobytes(order="C"))
                    f.write(tau_r.tobytes(order="C"))
                    f.write(tau_c.tobytes(order="C"))
                    offset += shrunk.nbytes + raw.nbytes + tau_r.nbytes + tau_c.nbytes

    with idx_path.open("w") as f:
        json.dump(index, f)

    print(f"[pack_matrices] wrote {bin_path} ({bin_path.stat().st_size / 1e6:.1f} MB)")
    print(f"[pack_matrices] wrote {idx_path} ({idx_path.stat().st_size / 1e3:.1f} KB)")


if __name__ == "__main__":
    main()
