//! Coverage computation — port of `_reference_backend/compute.py`.
//!
//! Same logic as the Python reference: hier-wide shrunk matrix optionally
//! blended with raw deltas via `shrink_alpha`, per-column z-score across
//! the full role distribution, top-X row selection per opponent column,
//! mirror-matchup self-cell masking. Only `hier_wide` is supported (other
//! shrinkage methods aren't shipped to clients — see README).

use std::collections::{HashMap, HashSet};

use ndarray::Array2;
use serde::{Deserialize, Serialize};

use crate::data::DataStore;
use crate::ports::{blend_pair, z_score_columns};
use crate::util::consts;
use crate::util::defaults;
use crate::util::math::{mean_finite, round3, weighted_mean};

pub const MATCHUP_THRESHOLD: f32 = consts::MATCHUP_THRESHOLD;
pub const SYNERGY_THRESHOLD: f32 = consts::SYNERGY_THRESHOLD;

#[derive(Deserialize)]
pub struct CoverageRequest {
    pub my_role: String,
    pub other_role: String,
    /// "matchup" | "synergy"
    pub mode: String,
    pub pool: Vec<String>,
    #[serde(default = "defaults::top_x")]
    pub top_x: usize,
    #[serde(default = "defaults::pr_floor_default")]
    pub pr_floor: f32,
    #[serde(default = "defaults::alpha")]
    pub shrink_alpha: f32,
    #[serde(default)]
    pub patch: Option<String>,
    #[serde(default)]
    pub extra_rows: Vec<String>,
    #[serde(default)]
    pub pr_weighted: bool,
}

#[derive(Serialize)]
pub struct CoverageStats {
    pub n_total: usize,
    pub n_covered: usize,
    pub n_uncovered: usize,
    pub threshold: f32,
    pub mean_topx_z: f32,
    pub mean_topx_pp: f32,
    pub mean_best_pp: f32,
    pub top_x: usize,
}

#[derive(Serialize)]
pub struct UncoveredRow {
    pub champion: String,
    pub best_pool_pick: String,
    pub max_z: f32,
    pub max_pp: f32,
}

#[derive(Serialize)]
pub struct CoverageResponse {
    pub empty: bool,
    pub rows: Vec<String>,
    pub cols: Vec<String>,
    pub col_pick_rates: Vec<f32>,
    pub mat: Vec<Vec<Option<f32>>>,
    pub mat_z: Vec<Vec<Option<f32>>>,
    pub col_max_pp: Vec<Option<f32>>,
    pub col_max_z: Vec<Option<f32>>,
    pub col_score_z: Vec<Option<f32>>,
    pub col_score_pp: Vec<Option<f32>>,
    pub best_row_idx: Vec<usize>,
    pub top_idx_mat: Vec<Vec<usize>>,
    pub top_x: usize,
    pub stats: CoverageStats,
    pub uncovered: Vec<UncoveredRow>,
    pub threshold: f32,
}

pub fn coverage(store: &DataStore, req: &CoverageRequest) -> Option<CoverageResponse> {
    if req.pool.is_empty() {
        return None;
    }

    let pairs = match req.mode.as_str() {
        "matchup" => &store.matchup,
        "synergy" => &store.synergy,
        _ => return None,
    };
    let pair = pairs.get(&req.my_role)?.get(&req.other_role)?;

    let alpha = req.shrink_alpha.clamp(0.0, 1.0);
    let mat_full = blend_pair(pair, alpha);
    let z_full = z_score_columns(&mat_full);

    let row_idx: HashMap<&str, usize> = pair
        .rows
        .iter()
        .enumerate()
        .map(|(i, ch)| (ch.as_str(), i))
        .collect();

    let pr_other = store.pr_for_role(&req.other_role, req.patch.as_deref());

    // Filter columns by PR floor against the (patch-specific) other-role PR table.
    let keep_cols_idx: Vec<usize> = pair
        .cols
        .iter()
        .enumerate()
        .filter(|(_, c)| {
            pr_other.get(c.as_str()).copied().unwrap_or(0.0) >= req.pr_floor
        })
        .map(|(i, _)| i)
        .collect();
    let keep_cols: Vec<String> = keep_cols_idx
        .iter()
        .map(|&i| pair.cols[i].clone())
        .collect();

    // Filter pool to champs present in this pair's row index, preserve input order.
    let pool_rows: Vec<(usize, String)> = req
        .pool
        .iter()
        .filter_map(|ch| row_idx.get(ch.as_str()).map(|&i| (i, ch.clone())))
        .collect();

    if pool_rows.is_empty() || keep_cols.is_empty() {
        return None;
    }

    let n_rows = pool_rows.len();
    let n_cols = keep_cols_idx.len();

    let mut sub = Array2::<f32>::zeros((n_rows, n_cols));
    let mut sub_z = Array2::<f32>::zeros((n_rows, n_cols));
    for (r_i, (src_r, _)) in pool_rows.iter().enumerate() {
        for (c_i, &src_c) in keep_cols_idx.iter().enumerate() {
            sub[[r_i, c_i]] = mat_full[[*src_r, src_c]];
            sub_z[[r_i, c_i]] = z_full[[*src_r, src_c]];
        }
    }

    // Mirror-matchup masking: in TOP_vs_TOP etc., a pool member can appear as
    // an opponent column too — the diagonal cell (champ vs itself) is meaningless.
    // Mask those cells with -inf so they're ignored in max/argsort.
    let same_role = req.mode == "matchup" && req.my_role == req.other_role;
    let mut sub_for_score = sub.clone();
    let mut sub_z_for_score = sub_z.clone();
    if same_role {
        let col_pos: HashMap<&str, usize> = keep_cols
            .iter()
            .enumerate()
            .map(|(j, c)| (c.as_str(), j))
            .collect();
        for (i, (_, name)) in pool_rows.iter().enumerate() {
            if let Some(&j) = col_pos.get(name.as_str()) {
                sub_for_score[[i, j]] = f32::NEG_INFINITY;
                sub_z_for_score[[i, j]] = f32::NEG_INFINITY;
            }
        }
    }

    let eff_x = req.top_x.max(1).min(n_rows);

    // Per-column max, top-X indices, and per-column score (mean of top-X picks).
    let (col_max_pp, col_max_z, per_col_top, col_score_z, col_score_pp) =
        score_columns_top_x(&sub_for_score, &sub_z_for_score, n_rows, n_cols, eff_x);

    let best_row_idx: Vec<usize> = per_col_top.iter().map(|v| v[0]).collect();

    // Sort columns by descending col_score_z (stable so equal scores preserve input order).
    let mut order: Vec<usize> = (0..n_cols).collect();
    order.sort_by(|&a, &b| {
        col_score_z[b]
            .partial_cmp(&col_score_z[a])
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let sorted_cols: Vec<String> = order.iter().map(|&i| keep_cols[i].clone()).collect();
    let sorted_col_pick_rates: Vec<f32> = sorted_cols
        .iter()
        .map(|c| pr_other.get(c.as_str()).copied().unwrap_or(0.0))
        .collect();
    let sorted_col_max_pp: Vec<f32> = order.iter().map(|&i| col_max_pp[i]).collect();
    let sorted_col_max_z: Vec<f32> = order.iter().map(|&i| col_max_z[i]).collect();
    let sorted_col_score_z: Vec<f32> = order.iter().map(|&i| col_score_z[i]).collect();
    let sorted_col_score_pp: Vec<f32> = order.iter().map(|&i| col_score_pp[i]).collect();
    let sorted_best_row_idx: Vec<usize> = order.iter().map(|&i| best_row_idx[i]).collect();
    // Apply column reordering to per_col_top, then transpose to wire shape
    // (eff_x rows × n_cols cols) so frontend code reads top_idx_mat[k][j] as
    // the k-th best row for column j (matches Python numpy behavior).
    let reordered_per_col: Vec<Vec<usize>> =
        order.iter().map(|&i| per_col_top[i].clone()).collect();
    let mut sorted_top_idx_mat: Vec<Vec<usize>> = vec![vec![0; n_cols]; eff_x];
    for (j, col_picks) in reordered_per_col.iter().enumerate() {
        for (k, &row_idx) in col_picks.iter().enumerate() {
            sorted_top_idx_mat[k][j] = row_idx;
        }
    }

    let mut final_rows: Vec<String> = pool_rows.iter().map(|(_, n)| n.clone()).collect();
    let mut final_mat: Vec<Vec<f32>> = (0..n_rows)
        .map(|r| order.iter().map(|&j| sub[[r, j]]).collect())
        .collect();
    let mut final_mat_z: Vec<Vec<f32>> = (0..n_rows)
        .map(|r| order.iter().map(|&j| sub_z[[r, j]]).collect())
        .collect();

    // Display-only extra rows (Replacement Finder uses this for the dropped champ).
    append_extra_rows(
        &req.extra_rows,
        &req.pool,
        &row_idx,
        &keep_cols_idx,
        &order,
        &mat_full,
        &z_full,
        &mut final_rows,
        &mut final_mat,
        &mut final_mat_z,
    );

    let threshold = if req.mode == "matchup" {
        MATCHUP_THRESHOLD
    } else {
        SYNERGY_THRESHOLD
    };
    let n_cov = sorted_col_max_z
        .iter()
        .filter(|&&v| v >= threshold)
        .count();

    let stats = compute_stats(
        &sorted_cols,
        &sorted_col_score_z,
        &sorted_col_score_pp,
        &sorted_col_max_pp,
        threshold,
        n_cov,
        pr_other,
        req.pr_weighted,
        eff_x,
    );

    let uncov = uncovered(
        &sorted_cols,
        &sorted_col_max_z,
        &sorted_col_max_pp,
        &sorted_best_row_idx,
        &final_rows,
        threshold,
    );

    Some(CoverageResponse {
        empty: false,
        rows: final_rows,
        cols: sorted_cols,
        col_pick_rates: sorted_col_pick_rates,
        mat: round_mat(&final_mat),
        mat_z: round_mat(&final_mat_z),
        col_max_pp: round_vec(&sorted_col_max_pp),
        col_max_z: round_vec(&sorted_col_max_z),
        col_score_z: round_vec(&sorted_col_score_z),
        col_score_pp: round_vec(&sorted_col_score_pp),
        best_row_idx: sorted_best_row_idx,
        top_idx_mat: sorted_top_idx_mat,
        top_x: eff_x,
        stats,
        uncovered: uncov,
        threshold,
    })
}

/// Per-column aggregates from a sub-matrix of shape (n_rows, n_cols):
/// returns `(col_max_pp, col_max_z, per_col_top_idx, col_score_z, col_score_pp)`.
/// `per_col_top_idx[j]` holds the row indices of the `top_x` best (highest-z)
/// rows for column `j`, descending. `col_score_*` is the NaN-skipping mean of
/// those picks (so masked -inf cells don't pollute the score).
#[allow(clippy::type_complexity)]
fn score_columns_top_x(
    sub_for_score: &Array2<f32>,
    sub_z_for_score: &Array2<f32>,
    n_rows: usize,
    n_cols: usize,
    top_x: usize,
) -> (Vec<f32>, Vec<f32>, Vec<Vec<usize>>, Vec<f32>, Vec<f32>) {
    let col_max_pp: Vec<f32> = (0..n_cols)
        .map(|j| {
            (0..n_rows)
                .map(|i| sub_for_score[[i, j]])
                .fold(f32::NEG_INFINITY, f32::max)
        })
        .collect();
    let col_max_z: Vec<f32> = (0..n_cols)
        .map(|j| {
            (0..n_rows)
                .map(|i| sub_z_for_score[[i, j]])
                .fold(f32::NEG_INFINITY, f32::max)
        })
        .collect();

    // Internally indexed col-major (per_col_top[j][k]); transposed at the
    // call site to match Python's (top_x, n_cols) wire shape.
    let per_col_top: Vec<Vec<usize>> = (0..n_cols)
        .map(|j| {
            let mut indices: Vec<usize> = (0..n_rows).collect();
            indices.sort_by(|&a, &b| {
                sub_z_for_score[[b, j]]
                    .partial_cmp(&sub_z_for_score[[a, j]])
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            indices.truncate(top_x);
            indices
        })
        .collect();

    let mut col_score_z = vec![f32::NAN; n_cols];
    let mut col_score_pp = vec![f32::NAN; n_cols];
    for j in 0..n_cols {
        let mut z_sum = 0.0_f32;
        let mut pp_sum = 0.0_f32;
        let mut count = 0_usize;
        for &i in &per_col_top[j] {
            let z_val = sub_z_for_score[[i, j]];
            let pp_val = sub_for_score[[i, j]];
            if z_val.is_finite() {
                z_sum += z_val;
                pp_sum += pp_val;
                count += 1;
            }
        }
        if count > 0 {
            col_score_z[j] = z_sum / count as f32;
            col_score_pp[j] = pp_sum / count as f32;
        }
    }

    (col_max_pp, col_max_z, per_col_top, col_score_z, col_score_pp)
}

/// Append display-only "extra rows" to the response matrices. Used by the
/// Replacement Finder UI to show the dropped champion alongside the pool.
/// Skips champs not present in this pair's row index and any that are
/// already part of the pool.
#[allow(clippy::too_many_arguments)]
fn append_extra_rows(
    extra_rows: &[String],
    pool: &[String],
    row_idx: &HashMap<&str, usize>,
    keep_cols_idx: &[usize],
    order: &[usize],
    mat_full: &Array2<f32>,
    z_full: &Array2<f32>,
    final_rows: &mut Vec<String>,
    final_mat: &mut Vec<Vec<f32>>,
    final_mat_z: &mut Vec<Vec<f32>>,
) {
    if extra_rows.is_empty() {
        return;
    }
    let pool_set: HashSet<&str> = pool.iter().map(|s| s.as_str()).collect();
    for ch in extra_rows {
        if let Some(&r_idx) = row_idx.get(ch.as_str()) {
            if pool_set.contains(ch.as_str()) {
                continue;
            }
            let mat_row: Vec<f32> = order
                .iter()
                .map(|&j| mat_full[[r_idx, keep_cols_idx[j]]])
                .collect();
            let z_row: Vec<f32> = order
                .iter()
                .map(|&j| z_full[[r_idx, keep_cols_idx[j]]])
                .collect();
            final_rows.push(ch.clone());
            final_mat.push(mat_row);
            final_mat_z.push(z_row);
        }
    }
}

fn round_mat(m: &[Vec<f32>]) -> Vec<Vec<Option<f32>>> {
    m.iter()
        .map(|r| {
            r.iter()
                .map(|&v| if v.is_finite() { Some(round3(v)) } else { None })
                .collect()
        })
        .collect()
}

fn round_vec(v: &[f32]) -> Vec<Option<f32>> {
    v.iter()
        .map(|&v| if v.is_finite() { Some(round3(v)) } else { None })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn compute_stats(
    cols: &[String],
    score_z: &[f32],
    score_pp: &[f32],
    max_pp: &[f32],
    threshold: f32,
    n_cov: usize,
    pr_other: &HashMap<String, f32>,
    pr_weighted: bool,
    top_x: usize,
) -> CoverageStats {
    let n_total = cols.len();
    let n_uncovered = n_total - n_cov;

    let (mean_topx_z, mean_topx_pp, mean_best_pp) = if pr_weighted {
        let weights: Vec<f32> = cols
            .iter()
            .map(|c| pr_other.get(c.as_str()).copied().unwrap_or(0.0).max(0.0))
            .collect();
        let w_sum: f32 = weights.iter().sum();
        if w_sum > 0.0 {
            (
                weighted_mean(score_z, &weights, w_sum),
                weighted_mean(score_pp, &weights, w_sum),
                weighted_mean(max_pp, &weights, w_sum),
            )
        } else {
            (
                mean_finite(score_z),
                mean_finite(score_pp),
                mean_finite(max_pp),
            )
        }
    } else {
        (
            mean_finite(score_z),
            mean_finite(score_pp),
            mean_finite(max_pp),
        )
    };

    CoverageStats {
        n_total,
        n_covered: n_cov,
        n_uncovered,
        threshold,
        mean_topx_z,
        mean_topx_pp,
        mean_best_pp,
        top_x,
    }
}

fn uncovered(
    cols: &[String],
    max_z: &[f32],
    max_pp: &[f32],
    best_row_idx: &[usize],
    rows: &[String],
    threshold: f32,
) -> Vec<UncoveredRow> {
    let mut indices: Vec<usize> = (0..cols.len()).filter(|&i| max_z[i] < threshold).collect();
    indices.sort_by(|&a, &b| {
        max_z[a]
            .partial_cmp(&max_z[b])
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    indices
        .iter()
        .map(|&i| UncoveredRow {
            champion: cols[i].clone(),
            best_pool_pick: rows[best_row_idx[i]].clone(),
            max_z: round3(max_z[i]),
            max_pp: round3(max_pp[i]),
        })
        .collect()
}
