//! Helpers shared by multiple endpoint ports — mirrors `_reference_backend/ports.py`.
//!
//! Currently exposes the `z_matrices` builder (per-(mode, pos) z-scored +
//! pp matrices for the user's role), and small linear-algebra utilities
//! used by `comparer`, `bans`, and the upcoming `redundancy` / `pool_stats`
//! ports.

use std::collections::HashMap;

use ndarray::Array2;

use crate::data::{DataStore, PairMats, ROLES};

pub struct ZMatrix {
    /// Per-column z-score across the FULL role distribution. Shape (n_rows, n_cols_kept).
    pub z: Array2<f32>,
    /// Alpha-blended deltas (raw shape — pp = percentage points). Same shape as `z`.
    pub pp: Array2<f32>,
    /// Champion list at `my_role`.
    pub rows: Vec<String>,
    /// Opponent/partner champions, filtered to those above `pr_floor`.
    pub cols: Vec<String>,
    pub mode: &'static str,
    pub pos: String,
    pub is_mirror: bool,
}

/// Build the per-(mode, pos) z-score and pp matrices for `my_role`.
/// Keys in the output are `"matchup_TOP"`, `"synergy_ADC"`, etc.
pub fn z_matrices(
    store: &DataStore,
    my_role: &str,
    patch: Option<&str>,
    pr_floor: f32,
    shrink_alpha: f32,
) -> HashMap<String, ZMatrix> {
    let mut out = HashMap::new();
    for &pos in ROLES.iter() {
        for &mv in &["matchup", "synergy"] {
            if mv == "synergy" && pos == my_role {
                continue;
            }
            let pairs = if mv == "matchup" {
                &store.matchup
            } else {
                &store.synergy
            };
            let pair = match pairs.get(my_role).and_then(|m| m.get(pos)) {
                Some(p) => p,
                None => continue,
            };
            let mat = blend_pair(pair, shrink_alpha);
            let z_full = z_score_columns(&mat);
            let pr_pos = store.pr_for_role(pos, patch);
            let keep_idx: Vec<usize> = pair
                .cols
                .iter()
                .enumerate()
                .filter(|(_, c)| pr_pos.get(c.as_str()).copied().unwrap_or(0.0) >= pr_floor)
                .map(|(i, _)| i)
                .collect();
            if keep_idx.is_empty() {
                continue;
            }
            let n_rows = mat.nrows();
            let mut z_kept = Array2::<f32>::zeros((n_rows, keep_idx.len()));
            let mut pp_kept = Array2::<f32>::zeros((n_rows, keep_idx.len()));
            for (k, &c) in keep_idx.iter().enumerate() {
                for r in 0..n_rows {
                    z_kept[[r, k]] = z_full[[r, c]];
                    pp_kept[[r, k]] = mat[[r, c]];
                }
            }
            let cols_kept: Vec<String> =
                keep_idx.iter().map(|&i| pair.cols[i].clone()).collect();
            out.insert(
                format!("{}_{}", mv, pos),
                ZMatrix {
                    z: z_kept,
                    pp: pp_kept,
                    rows: pair.rows.clone(),
                    cols: cols_kept,
                    mode: if mv == "matchup" { "matchup" } else { "synergy" },
                    pos: pos.to_string(),
                    is_mirror: mv == "matchup" && pos == my_role,
                },
            );
        }
    }
    out
}

pub fn blend_pair(pair: &PairMats, alpha: f32) -> Array2<f32> {
    if alpha >= 1.0 {
        return pair.shrunk.clone();
    }
    if alpha <= 0.0 {
        return pair.raw.clone();
    }
    &pair.shrunk * alpha + &pair.raw * (1.0 - alpha)
}

/// Lane definition per role — used by Pool Health and Pool Summary to
/// split matchup scores into in-lane vs out-of-lane components.
pub fn lane_roles(my_role: &str) -> &'static [&'static str] {
    match my_role {
        "TOP" => &["TOP"],
        "JUNGLE" => &["JUNGLE"],
        "MID" => &["MID"],
        "ADC" => &["ADC", "SUP"],
        "SUP" => &["ADC", "SUP"],
        _ => &[],
    }
}

/// Per-column mean of top-X (descending). Cells set to -inf (mirror-matchup
/// self-cell mask) are excluded; columns with no valid rows return NaN.
pub fn topx_col_score(sub: &Array2<f32>, eff_x: usize) -> Vec<f32> {
    let n_rows = sub.nrows();
    let n_cols = sub.ncols();
    let mut out = vec![f32::NAN; n_cols];
    for j in 0..n_cols {
        let mut col: Vec<f32> = (0..n_rows).map(|i| sub[[i, j]]).collect();
        col.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
        let take = eff_x.min(n_rows);
        let valid: Vec<f32> = col.iter().take(take).copied().filter(|v| v.is_finite()).collect();
        if !valid.is_empty() {
            out[j] = valid.iter().sum::<f32>() / valid.len() as f32;
        }
    }
    out
}

/// Mirror-matchup mask: where row champ == col champ, replace with -inf.
pub fn mask_mirror_diagonal(sub: &mut Array2<f32>, have: &[String], cols: &[String]) {
    use std::collections::HashMap;
    let col_pos: HashMap<&str, usize> =
        cols.iter().enumerate().map(|(j, c)| (c.as_str(), j)).collect();
    for (i, row_ch) in have.iter().enumerate() {
        if let Some(&j) = col_pos.get(row_ch.as_str()) {
            sub[[i, j]] = f32::NEG_INFINITY;
        }
    }
}

/// Single (mode, pos) score for a pool: PR-weighted or unweighted mean of
/// per-column top-X scores.
pub fn pos_score(
    sub: &Array2<f32>,
    cols: &[String],
    pr_pos: &std::collections::HashMap<String, f32>,
    eff_x: usize,
    pr_weighted: bool,
) -> f32 {
    let col_score = topx_col_score(sub, eff_x);
    let valid: Vec<bool> = col_score.iter().map(|v| v.is_finite()).collect();
    if !valid.iter().any(|&b| b) {
        return f32::NAN;
    }
    if pr_weighted {
        let mut w: Vec<f32> = cols
            .iter()
            .map(|c| pr_pos.get(c.as_str()).copied().unwrap_or(0.0).max(0.0))
            .collect();
        for (i, &v) in valid.iter().enumerate() {
            if !v {
                w[i] = 0.0;
            }
        }
        let sw: f32 = w.iter().sum();
        if sw > 0.0 {
            let s: f32 = (0..cols.len())
                .filter(|&i| valid[i])
                .map(|i| col_score[i] * w[i])
                .sum();
            return s / sw;
        }
    }
    let xs: Vec<f32> = col_score.iter().copied().filter(|v| v.is_finite()).collect();
    xs.iter().sum::<f32>() / xs.len() as f32
}

/// Pool stats — overall coverage, by-mode, in-lane vs out-of-lane, blindability.
/// Mirrors `_reference_backend/ports.pool_stats`.
pub struct PoolStats {
    pub overall: f32,
    pub matchup_z: f32,
    pub matchup_in_lane: f32,
    pub matchup_out_of_lane: f32,
    pub synergy_z: f32,
    pub blind_z: f32,
}

pub fn pool_stats(
    pool: &[String],
    z_mats: &std::collections::HashMap<String, ZMatrix>,
    store: &DataStore,
    top_x: usize,
    my_role: &str,
    pr_weighted: bool,
    blind_lookup: Option<&std::collections::HashMap<String, f32>>,
    patch: Option<&str>,
) -> PoolStats {
    let lane_set: std::collections::HashSet<&str> = lane_roles(my_role).iter().copied().collect();
    let mut matchup_scores: Vec<f32> = Vec::new();
    let mut matchup_in_lane: Vec<f32> = Vec::new();
    let mut matchup_out_of_lane: Vec<f32> = Vec::new();
    let mut synergy_scores: Vec<f32> = Vec::new();

    for entry in z_mats.values() {
        if entry.z.ncols() == 0 {
            continue;
        }
        let row_idx_map: std::collections::HashMap<&str, usize> =
            entry.rows.iter().enumerate().map(|(i, c)| (c.as_str(), i)).collect();
        let have: Vec<(usize, String)> = pool
            .iter()
            .filter_map(|ch| row_idx_map.get(ch.as_str()).map(|&i| (i, ch.clone())))
            .collect();
        if have.is_empty() {
            continue;
        }
        let n_have = have.len();
        let n_cols = entry.z.ncols();
        let mut sub = Array2::<f32>::zeros((n_have, n_cols));
        for (r_i, (src_r, _)) in have.iter().enumerate() {
            for c in 0..n_cols {
                sub[[r_i, c]] = entry.z[[*src_r, c]];
            }
        }
        if entry.is_mirror {
            let names: Vec<String> = have.iter().map(|(_, n)| n.clone()).collect();
            mask_mirror_diagonal(&mut sub, &names, &entry.cols);
        }
        let eff_x = top_x.max(1).min(sub.nrows());
        let pr_pos = store.pr_for_role(&entry.pos, patch);
        let s = pos_score(&sub, &entry.cols, pr_pos, eff_x, pr_weighted);
        if entry.mode == "matchup" {
            matchup_scores.push(s);
            if lane_set.contains(entry.pos.as_str()) {
                matchup_in_lane.push(s);
            } else {
                matchup_out_of_lane.push(s);
            }
        } else {
            synergy_scores.push(s);
        }
    }

    let blind_z = if let Some(lookup) = blind_lookup {
        let zs: Vec<f32> = pool
            .iter()
            .filter_map(|ch| lookup.get(ch).copied())
            .filter(|v| v.is_finite())
            .collect();
        if zs.is_empty() {
            f32::NAN
        } else {
            zs.iter().sum::<f32>() / zs.len() as f32
        }
    } else {
        f32::NAN
    };

    let overall = if matchup_scores.is_empty() && synergy_scores.is_empty() {
        f32::NAN
    } else {
        let all: Vec<f32> = matchup_scores
            .iter()
            .copied()
            .chain(synergy_scores.iter().copied())
            .collect();
        all.iter().sum::<f32>() / all.len() as f32
    };

    let m = |xs: &[f32]| -> f32 {
        if xs.is_empty() {
            f32::NAN
        } else {
            xs.iter().sum::<f32>() / xs.len() as f32
        }
    };

    PoolStats {
        overall,
        matchup_z: m(&matchup_scores),
        matchup_in_lane: m(&matchup_in_lane),
        matchup_out_of_lane: m(&matchup_out_of_lane),
        synergy_z: m(&synergy_scores),
        blind_z,
    }
}

/// Weighted total: w_in × in-lane/σ_in + ... — mirrors `_total_score_from_stats`.
#[allow(clippy::too_many_arguments)]
pub fn total_score_from_stats(
    st: &PoolStats,
    w_in_lane: f32,
    w_out_lane: f32,
    w_synergy: f32,
    w_blind: f32,
    sigma_in_lane: f32,
    sigma_out_lane: f32,
    sigma_synergy: f32,
    sigma_blind: f32,
) -> f32 {
    let safe_sigma = |s: f32| if s.is_finite() && s > 1e-9 { s } else { 1.0 };
    let w = |v: f32, w: f32, s: f32| {
        if v.is_finite() && w != 0.0 {
            w * v / safe_sigma(s)
        } else {
            0.0
        }
    };
    w(st.matchup_in_lane, w_in_lane, sigma_in_lane)
        + w(st.matchup_out_of_lane, w_out_lane, sigma_out_lane)
        + w(st.synergy_z, w_synergy, sigma_synergy)
        // blind_z follows the blog convention: low = blindable. Negate so
        // a positive `w_blind` still means "I want my pool blindable".
        + w(-st.blind_z, w_blind, sigma_blind)
}

pub fn z_score_columns(mat: &Array2<f32>) -> Array2<f32> {
    let mut z = mat.clone();
    let n_rows_f = mat.nrows() as f32;
    if n_rows_f < 2.0 {
        return z;
    }
    for j in 0..mat.ncols() {
        let col = mat.column(j);
        let mean: f32 = col.sum() / n_rows_f;
        let var: f32 = col
            .iter()
            .map(|&v| {
                let d = v - mean;
                d * d
            })
            .sum::<f32>()
            / (n_rows_f - 1.0);
        let sd = var.sqrt();
        let safe_sd = if !sd.is_finite() || sd < 1e-9 { 1.0 } else { sd };
        for i in 0..mat.nrows() {
            let v = (mat[[i, j]] - mean) / safe_sd;
            z[[i, j]] = if v.is_finite() { v } else { 0.0 };
        }
    }
    z
}
