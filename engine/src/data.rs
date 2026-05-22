//! Load matrices.bin + index.json + champions.json into in-memory structs.
//!
//! Mirrors `_reference_backend/data.py` but reads from the binary blob
//! produced by `data_prep/pack_matrices.py` instead of CSVs.

use std::collections::HashMap;

use half::f16;
use ndarray::Array2;
use serde::Deserialize;

pub const ROLES: &[&str] = &["TOP", "JUNGLE", "MID", "ADC", "SUP"];

#[derive(Deserialize)]
pub struct PairMatsIndex {
    pub offset: usize,
    pub rows_n: usize,
    pub cols_n: usize,
    pub rows: Vec<String>,
    pub cols: Vec<String>,
}

#[derive(Deserialize)]
pub struct Index {
    pub champions: HashMap<String, Vec<String>>,
    pub matchup: HashMap<String, HashMap<String, PairMatsIndex>>,
    pub synergy: HashMap<String, HashMap<String, PairMatsIndex>>,
}

#[derive(Deserialize)]
pub struct ChampionRow {
    pub champion: String,
    pub pick_rate: f32,
    #[serde(default)]
    pub win_rate: f32,
}

#[derive(Deserialize)]
pub struct ChampionsFile {
    pub patches: Vec<String>,
    pub latest_patch: Option<String>,
    pub by_patch: HashMap<String, HashMap<String, Vec<ChampionRow>>>,
    pub default: HashMap<String, Vec<ChampionRow>>,
}

pub struct PairMats {
    pub rows: Vec<String>,
    pub cols: Vec<String>,
    pub shrunk: Array2<f32>,
    pub raw: Array2<f32>,
    #[allow(dead_code)]
    pub tau_rows: Vec<f32>,
    #[allow(dead_code)]
    pub tau_cols: Vec<f32>,
}

pub struct DataStore {
    pub matchup: HashMap<String, HashMap<String, PairMats>>,
    pub synergy: HashMap<String, HashMap<String, PairMats>>,
    #[allow(dead_code)]
    pub valid_champs: HashMap<String, Vec<String>>,
    /// Cross-patch overall pick-rate, from `individual_wr.csv`.
    pub pr_by_role: HashMap<String, HashMap<String, f32>>,
    /// Per-patch pick-rate from lolalytics. Keyed patch → role → champ.
    pub pr_by_patch: HashMap<String, HashMap<String, HashMap<String, f32>>>,
    /// Cross-patch win-rate (used by /api/comparer info block).
    pub wr_by_role: HashMap<String, HashMap<String, f32>>,
    pub patches: Vec<String>,
    pub latest_patch: Option<String>,
    /// Borrowed by `pr_for_role` when a role has no entry, so callers can
    /// keep a `&HashMap` API instead of `Option`.
    _empty_pr: HashMap<String, f32>,
}

impl DataStore {
    pub fn load(
        matrices_bin: &[u8],
        index_json: &str,
        champions_json: &str,
    ) -> Result<Self, String> {
        let index: Index = serde_json::from_str(index_json)
            .map_err(|e| format!("parse index.json: {e}"))?;
        let champions: ChampionsFile = serde_json::from_str(champions_json)
            .map_err(|e| format!("parse champions.json: {e}"))?;

        let matchup = decode_pair_map(matrices_bin, &index.matchup)?;
        let synergy = decode_pair_map(matrices_bin, &index.synergy)?;

        let pr_by_role = champions
            .default
            .iter()
            .map(|(role, rows)| {
                let map: HashMap<String, f32> = rows
                    .iter()
                    .map(|r| (r.champion.clone(), r.pick_rate))
                    .collect();
                (role.clone(), map)
            })
            .collect();

        let wr_by_role = champions
            .default
            .iter()
            .map(|(role, rows)| {
                let map: HashMap<String, f32> = rows
                    .iter()
                    .map(|r| (r.champion.clone(), r.win_rate))
                    .collect();
                (role.clone(), map)
            })
            .collect();

        let pr_by_patch = champions
            .by_patch
            .iter()
            .map(|(patch, by_role)| {
                let inner: HashMap<String, HashMap<String, f32>> = by_role
                    .iter()
                    .map(|(role, rows)| {
                        let map: HashMap<String, f32> = rows
                            .iter()
                            .map(|r| (r.champion.clone(), r.pick_rate))
                            .collect();
                        (role.clone(), map)
                    })
                    .collect();
                (patch.clone(), inner)
            })
            .collect();

        Ok(DataStore {
            matchup,
            synergy,
            valid_champs: index.champions,
            pr_by_role,
            pr_by_patch,
            wr_by_role,
            patches: champions.patches,
            latest_patch: champions.latest_patch,
            _empty_pr: HashMap::new(),
        })
    }

    /// Pick-rate map for a (role, patch) — patch-specific if available, else cross-patch default.
    /// Returns an empty map (the `_empty_pr` field) if `role` is missing
    /// entirely; this keeps WASM fault-tolerant against a malformed
    /// `champions.json` that omits a role, instead of trapping the whole engine.
    pub fn pr_for_role(&self, role: &str, patch: Option<&str>) -> &HashMap<String, f32> {
        if let Some(p) = patch {
            if let Some(by_role) = self.pr_by_patch.get(p) {
                if let Some(map) = by_role.get(role) {
                    return map;
                }
            }
        }
        if let Some(m) = self.pr_by_role.get(role) {
            return m;
        }
        &self._empty_pr
    }
}

fn decode_pair_map(
    bin: &[u8],
    index: &HashMap<String, HashMap<String, PairMatsIndex>>,
) -> Result<HashMap<String, HashMap<String, PairMats>>, String> {
    let mut out = HashMap::new();
    for (ra, rb_map) in index {
        let mut inner = HashMap::new();
        for (rb, pi) in rb_map {
            inner.insert(rb.clone(), decode_pair(bin, pi)?);
        }
        out.insert(ra.clone(), inner);
    }
    Ok(out)
}

fn decode_pair(bin: &[u8], pi: &PairMatsIndex) -> Result<PairMats, String> {
    let bound = || "matrices.bin: pair offsets overflow usize".to_string();
    let n_cells = pi
        .rows_n
        .checked_mul(pi.cols_n)
        .ok_or_else(bound)?;
    let cells_bytes = n_cells.checked_mul(2).ok_or_else(bound)?;
    let row_bytes = pi.rows_n.checked_mul(2).ok_or_else(bound)?;
    let col_bytes = pi.cols_n.checked_mul(2).ok_or_else(bound)?;

    let shrunk_start = pi.offset;
    let shrunk_end = shrunk_start.checked_add(cells_bytes).ok_or_else(bound)?;
    let raw_start = shrunk_end;
    let raw_end = raw_start.checked_add(cells_bytes).ok_or_else(bound)?;
    let tau_r_start = raw_end;
    let tau_r_end = tau_r_start.checked_add(row_bytes).ok_or_else(bound)?;
    let tau_c_start = tau_r_end;
    let tau_c_end = tau_c_start.checked_add(col_bytes).ok_or_else(bound)?;

    if tau_c_end > bin.len() {
        return Err(format!(
            "matrices.bin: pair extends past end of buffer (need {}, have {})",
            tau_c_end,
            bin.len()
        ));
    }

    Ok(PairMats {
        rows: pi.rows.clone(),
        cols: pi.cols.clone(),
        shrunk: decode_array2(&bin[shrunk_start..shrunk_end], pi.rows_n, pi.cols_n)?,
        raw: decode_array2(&bin[raw_start..raw_end], pi.rows_n, pi.cols_n)?,
        tau_rows: decode_vec(&bin[tau_r_start..tau_r_end]),
        tau_cols: decode_vec(&bin[tau_c_start..tau_c_end]),
    })
}

fn decode_array2(bytes: &[u8], rows: usize, cols: usize) -> Result<Array2<f32>, String> {
    let n = rows * cols;
    if bytes.len() != n * 2 {
        return Err(format!(
            "decode_array2: expected {} bytes got {}",
            n * 2,
            bytes.len()
        ));
    }
    let mut data = Vec::with_capacity(n);
    for chunk in bytes.chunks_exact(2) {
        let bits = u16::from_le_bytes([chunk[0], chunk[1]]);
        data.push(f32::from(f16::from_bits(bits)));
    }
    Array2::from_shape_vec((rows, cols), data).map_err(|e| e.to_string())
}

fn decode_vec(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(2)
        .map(|c| f32::from(f16::from_bits(u16::from_le_bytes([c[0], c[1]]))))
        .collect()
}
