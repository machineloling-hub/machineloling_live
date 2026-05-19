//! Pool redundancy — port of `_reference_backend/ports.redundancy_data` plus
//! the redundancy payload shaping from `_reference_backend/main.health`.
//!
//! Pipeline:
//! 1. `build_pool_profile`: stack the per-(mode, pos) shrunk-blended pp
//!    matrices into 4 tall arrays (matchup-only, synergy-only, full, lane),
//!    each (n_pool, total_cols).
//! 2. `scope_stats`: pairwise Pearson correlation of the rows (champs),
//!    plus closest/avg/top-X correlation per row.
//! 3. Average-linkage hierarchical clustering on (1 − r) distances; produce
//!    a leaf order and the U-shaped dendrogram segments for the heatmap.
//! 4. Per-champ unique-best count over the full profile.
//! 5. Per-champ aggregate blindability z (mean across slices).
//!
//! Pool size is always small (≤10 in practice), so a naïve O(n³) clustering
//! loop is fine — adding scipy/kodama is not worth the wasm payload bytes.

use std::collections::{HashMap, HashSet};

use ndarray::{s, Array2};
use serde::Serialize;

use super::blind::{blind_stats, blind_z_lookup};
use crate::data::{DataStore, ROLES};
use crate::ports::{blend_pair, lane_roles};

#[derive(Serialize, Clone)]
pub struct DendroSegment {
    pub x: Vec<f32>,
    pub y: Vec<f32>,
}

#[derive(Serialize)]
pub struct RedundancyPayload {
    pub rows: Vec<String>,
    pub cor: Vec<Vec<Option<f32>>>,
    pub order: Vec<usize>,
    pub dendro_segments: Vec<DendroSegment>,
    pub closest_cor: Vec<Option<f32>>,
    pub closest_idx: Vec<usize>,
    pub avg_cor: Vec<Option<f32>>,
    pub topx_cor: Vec<Option<f32>>,
    pub unique_best: Vec<usize>,
    pub matchup_topx: Option<Vec<Option<f32>>>,
    pub synergy_topx: Option<Vec<Option<f32>>>,
    pub lane_topx: Option<Vec<Option<f32>>>,
    pub lane_roles: Vec<String>,
    pub blind_z: Vec<Option<f32>>,
}

pub fn redundancy(
    store: &DataStore,
    my_role: &str,
    pool: &[String],
    patch: Option<&str>,
    pr_floor: f32,
    pr_weighted: bool,
    shrink_alpha: f32,
    top_x: usize,
) -> Option<RedundancyPayload> {
    let profs = build_pool_profile(store, my_role, pool, patch, pr_floor, shrink_alpha)?;
    let full_prof = profs.full.as_ref()?;
    let full = scope_stats(profs.full.as_ref(), top_x)?;
    let matchup = scope_stats(profs.matchup.as_ref(), top_x);
    let synergy = scope_stats(profs.synergy.as_ref(), top_x);
    let lane = scope_stats(profs.lane.as_ref(), top_x);

    // Unique-best per champ: count cols where this champ has the max value
    // (only on cols where at least one champ has positive pp).
    let n = pool.len();
    let mut unique_best = vec![0_usize; n];
    for j in 0..full_prof.ncols() {
        let any_pos = (0..n).any(|i| full_prof[[i, j]] > 0.0);
        if !any_pos {
            continue;
        }
        let mut max_val = full_prof[[0, j]];
        let mut max_idx = 0_usize;
        for i in 1..n {
            if full_prof[[i, j]] > max_val {
                max_val = full_prof[[i, j]];
                max_idx = i;
            }
        }
        unique_best[max_idx] += 1;
    }

    let (order, dendro_segs) = if n >= 2 {
        let dist = full.cor.mapv(|v| 1.0 - v);
        let lz = linkage_matrix(&dist);
        let leaves = leaves_list(&lz, n);
        let segs = dendro_segments(&lz, &leaves);
        (leaves, segs)
    } else {
        ((0..n).collect(), vec![])
    };

    let blind = blind_stats(store, my_role, patch, pr_floor, pr_weighted, shrink_alpha);
    let bz = blind_z_lookup(&blind);
    let blind_z: Vec<Option<f32>> = pool
        .iter()
        .map(|ch| {
            bz.get(ch)
                .copied()
                .and_then(|v| if v.is_finite() { Some(round3(v)) } else { None })
        })
        .collect();

    let lane_role_strs: Vec<String> = lane_roles(my_role).iter().map(|s| s.to_string()).collect();

    Some(RedundancyPayload {
        rows: pool.to_vec(),
        cor: array2_to_rounded(&full.cor),
        order,
        dendro_segments: dendro_segs,
        closest_cor: round_vec_opt(&full.closest_cor),
        closest_idx: full.closest_idx,
        avg_cor: round_vec_opt(&full.avg_cor),
        topx_cor: round_vec_opt(&full.topx_cor),
        unique_best,
        matchup_topx: matchup.as_ref().map(|s| round_vec_opt(&s.topx_cor)),
        synergy_topx: synergy.as_ref().map(|s| round_vec_opt(&s.topx_cor)),
        lane_topx: lane.as_ref().map(|s| round_vec_opt(&s.topx_cor)),
        lane_roles: lane_role_strs,
        blind_z,
    })
}

struct PoolProfile {
    matchup: Option<Array2<f32>>,
    synergy: Option<Array2<f32>>,
    full: Option<Array2<f32>>,
    lane: Option<Array2<f32>>,
}

fn build_pool_profile(
    store: &DataStore,
    my_role: &str,
    pool: &[String],
    patch: Option<&str>,
    pr_floor: f32,
    shrink_alpha: f32,
) -> Option<PoolProfile> {
    if pool.len() < 2 {
        return None;
    }
    let lane_set: HashSet<&str> = lane_roles(my_role).iter().copied().collect();

    let slice = |mode: &str, pos: &str| -> Option<Array2<f32>> {
        let pairs = if mode == "matchup" {
            &store.matchup
        } else {
            &store.synergy
        };
        let pair = pairs.get(my_role).and_then(|m| m.get(pos))?;
        let mat = blend_pair(pair, shrink_alpha);
        let pr_pos = store.pr_for_role(pos, patch);
        let keep_idx: Vec<usize> = pair
            .cols
            .iter()
            .enumerate()
            .filter(|(_, c)| pr_pos.get(c.as_str()).copied().unwrap_or(0.0) >= pr_floor)
            .map(|(i, _)| i)
            .collect();
        if keep_idx.is_empty() {
            return None;
        }
        let row_idx: HashMap<&str, usize> = pair
            .rows
            .iter()
            .enumerate()
            .map(|(i, c)| (c.as_str(), i))
            .collect();
        let mut out = Array2::<f32>::zeros((pool.len(), keep_idx.len()));
        for (k, ch) in pool.iter().enumerate() {
            if let Some(&r_i) = row_idx.get(ch.as_str()) {
                for (c_new, &c_old) in keep_idx.iter().enumerate() {
                    out[[k, c_new]] = mat[[r_i, c_old]];
                }
            }
        }
        Some(out)
    };

    let mut matchup_pieces: Vec<Array2<f32>> = Vec::new();
    let mut synergy_pieces: Vec<Array2<f32>> = Vec::new();
    let mut lane_pieces: Vec<Array2<f32>> = Vec::new();

    for &pos in ROLES.iter() {
        if let Some(s) = slice("matchup", pos) {
            if lane_set.contains(pos) {
                lane_pieces.push(s.clone());
            }
            matchup_pieces.push(s);
        }
    }
    for &pos in ROLES.iter() {
        if pos == my_role {
            continue;
        }
        if let Some(s) = slice("synergy", pos) {
            synergy_pieces.push(s);
        }
    }

    let concat = |pieces: &[Array2<f32>]| -> Option<Array2<f32>> {
        if pieces.is_empty() {
            return None;
        }
        let total_cols: usize = pieces.iter().map(|p| p.ncols()).sum();
        if total_cols == 0 {
            return None;
        }
        let mut out = Array2::<f32>::zeros((pool.len(), total_cols));
        let mut offset = 0;
        for p in pieces {
            let nc = p.ncols();
            out.slice_mut(s![.., offset..offset + nc]).assign(p);
            offset += nc;
        }
        Some(out)
    };

    let matchup = concat(&matchup_pieces);
    let synergy = concat(&synergy_pieces);
    let full_pieces: Vec<Array2<f32>> = matchup_pieces
        .iter()
        .chain(synergy_pieces.iter())
        .cloned()
        .collect();
    let full = concat(&full_pieces);
    let lane = concat(&lane_pieces);

    Some(PoolProfile {
        matchup,
        synergy,
        full,
        lane,
    })
}

struct ScopeStats {
    cor: Array2<f32>,
    closest_cor: Vec<f32>,
    closest_idx: Vec<usize>,
    avg_cor: Vec<f32>,
    topx_cor: Vec<f32>,
}

fn scope_stats(profile: Option<&Array2<f32>>, top_x: usize) -> Option<ScopeStats> {
    let prof = profile?;
    if prof.nrows() < 2 || prof.ncols() == 0 {
        return None;
    }
    let cmat = pearson_corr_rows(prof);
    let n = cmat.nrows();
    let mut closest_cor = vec![f32::NAN; n];
    let mut closest_idx = vec![0_usize; n];
    let mut avg_cor = vec![0.0_f32; n];
    let mut topx_cor = vec![0.0_f32; n];
    for i in 0..n {
        let mut others: Vec<(usize, f32)> = (0..n)
            .filter(|&j| j != i)
            .map(|j| (j, cmat[[i, j]]))
            .collect();
        if others.is_empty() {
            continue;
        }
        let mut max_val = others[0].1;
        let mut max_idx = others[0].0;
        for &(j, v) in &others {
            if v > max_val {
                max_val = v;
                max_idx = j;
            }
        }
        closest_cor[i] = max_val;
        closest_idx[i] = max_idx;
        avg_cor[i] = others.iter().map(|&(_, v)| v).sum::<f32>() / others.len() as f32;
        others.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        let eff_x = top_x.max(1).min(others.len());
        topx_cor[i] = others.iter().take(eff_x).map(|&(_, v)| v).sum::<f32>() / eff_x as f32;
    }
    Some(ScopeStats {
        cor: cmat,
        closest_cor,
        closest_idx,
        avg_cor,
        topx_cor,
    })
}

fn pearson_corr_rows(mat: &Array2<f32>) -> Array2<f32> {
    let n = mat.nrows();
    let m = mat.ncols();
    let mut row_norm = vec![0.0_f32; n];
    let mut centered = mat.clone();
    for r in 0..n {
        let mu = mat.row(r).sum() / m as f32;
        let mut sq = 0.0_f32;
        for c in 0..m {
            centered[[r, c]] -= mu;
            sq += centered[[r, c]] * centered[[r, c]];
        }
        row_norm[r] = sq.sqrt();
    }
    let mut cor = Array2::<f32>::zeros((n, n));
    for i in 0..n {
        for j in 0..n {
            if row_norm[i] == 0.0 || row_norm[j] == 0.0 {
                cor[[i, j]] = 0.0;
                continue;
            }
            let mut dot = 0.0_f32;
            for c in 0..m {
                dot += centered[[i, c]] * centered[[j, c]];
            }
            cor[[i, j]] = dot / (row_norm[i] * row_norm[j]);
        }
    }
    for v in cor.iter_mut() {
        if !v.is_finite() {
            *v = 0.0;
        }
    }
    cor
}

/// Average-linkage hierarchical clustering on a square distance matrix.
/// Returns linkage steps as `[a, b, dissim, size]` per merge in order.
/// Reproduces the relevant subset of `scipy.cluster.hierarchy.linkage(..., method='average')`.
fn linkage_matrix(distances: &Array2<f32>) -> Vec<[f32; 4]> {
    let n = distances.nrows();
    if n < 2 {
        return vec![];
    }
    let total = 2 * n - 1;
    let mut d = Array2::<f32>::from_elem((total, total), f32::INFINITY);
    for i in 0..n {
        for j in 0..n {
            if i != j {
                d[[i, j]] = distances[[i, j]];
            }
        }
    }
    let mut alive = vec![false; total];
    for i in 0..n {
        alive[i] = true;
    }
    let mut size = vec![0_usize; total];
    for i in 0..n {
        size[i] = 1;
    }

    let mut linkage = Vec::with_capacity(n - 1);
    for step in 0..(n - 1) {
        let mut best_dist = f32::INFINITY;
        let mut best_i = 0;
        let mut best_j = 0;
        for i in 0..total {
            if !alive[i] {
                continue;
            }
            for j in (i + 1)..total {
                if !alive[j] {
                    continue;
                }
                if d[[i, j]] < best_dist {
                    best_dist = d[[i, j]];
                    best_i = i;
                    best_j = j;
                }
            }
        }
        let new_id = n + step;
        let new_size = size[best_i] + size[best_j];
        size[new_id] = new_size;
        alive[best_i] = false;
        alive[best_j] = false;
        alive[new_id] = true;
        for m in 0..total {
            if !alive[m] || m == new_id {
                continue;
            }
            let d_new = (size[best_i] as f32 * d[[best_i, m]]
                + size[best_j] as f32 * d[[best_j, m]])
                / new_size as f32;
            d[[new_id, m]] = d_new;
            d[[m, new_id]] = d_new;
        }
        linkage.push([best_i as f32, best_j as f32, best_dist, new_size as f32]);
    }
    linkage
}

/// Leaf order for a dendrogram drawn left-to-right, matching scipy's
/// `leaves_list`. DFS from the root, visit the linkage's first child first.
fn leaves_list(linkage: &[[f32; 4]], n: usize) -> Vec<usize> {
    if n == 1 {
        return vec![0];
    }
    let root = 2 * n - 2;
    let mut result = Vec::with_capacity(n);
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        if node < n {
            result.push(node);
        } else {
            let merge = &linkage[node - n];
            let a = merge[0] as usize;
            let b = merge[1] as usize;
            // Push right first so left is popped/visited first.
            stack.push(b);
            stack.push(a);
        }
    }
    result
}

/// Each merge produces a U-shaped segment: from the left subtree's previous
/// merge height up to the new dissimilarity, across to the right subtree's
/// x position, then down to its previous merge height. X positions are in
/// heatmap-column-index space (0..n-1).
fn dendro_segments(linkage: &[[f32; 4]], leaves_order: &[usize]) -> Vec<DendroSegment> {
    let n = leaves_order.len();
    if n < 2 {
        return vec![];
    }
    let total = 2 * n - 1;
    let mut x_pos = vec![0.0_f32; total];
    let mut height = vec![0.0_f32; total];

    for (pos, &leaf) in leaves_order.iter().enumerate() {
        x_pos[leaf] = pos as f32;
    }

    let mut segments = Vec::with_capacity(n - 1);
    for (i, merge) in linkage.iter().enumerate() {
        let a = merge[0] as usize;
        let b = merge[1] as usize;
        let dissim = merge[2];
        let new_id = n + i;

        let xl = x_pos[a];
        let xr = x_pos[b];
        let yl = height[a];
        let yr = height[b];

        segments.push(DendroSegment {
            x: vec![xl, xl, xr, xr],
            y: vec![yl, dissim, dissim, yr],
        });

        x_pos[new_id] = (xl + xr) / 2.0;
        height[new_id] = dissim;
    }
    segments
}

fn round3(v: f32) -> f32 {
    (v * 1000.0).round() / 1000.0
}
fn round_vec_opt(v: &[f32]) -> Vec<Option<f32>> {
    v.iter()
        .map(|&x| if x.is_finite() { Some(round3(x)) } else { None })
        .collect()
}
fn array2_to_rounded(m: &Array2<f32>) -> Vec<Vec<Option<f32>>> {
    (0..m.nrows())
        .map(|i| {
            (0..m.ncols())
                .map(|j| {
                    let v = m[[i, j]];
                    if v.is_finite() {
                        Some(round3(v))
                    } else {
                        None
                    }
                })
                .collect()
        })
        .collect()
}
