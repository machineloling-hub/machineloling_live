//! Ban Recommender — port of `_reference_backend/ports.ban_candidates`.
//!
//! For each opponent role, scan opponent champions that pass the PR floor
//! and ask: "what's the best response your pool has against them, and how
//! much worse than typical does that look?" Higher ban_score = banning
//! this opponent helps more.
//!
//! In `pr_weighted` mode the score is the *expected lift* in your pool's
//! matchup quality at this role if the opponent is removed from the
//! distribution: `(pr / (W - pr)) * (mu - best_response)`.

use std::collections::HashSet;

use ndarray::Array2;
use serde::{Deserialize, Serialize};

use crate::data::{DataStore, ROLES};
use crate::ports::blend_pair;

#[derive(Deserialize)]
pub struct BansRequest {
    pub my_role: String,
    pub pool: Vec<String>,
    #[serde(default = "default_pr_floor")]
    pub pr_floor: f32,
    #[serde(default)]
    pub pr_weighted: bool,
    #[serde(default)]
    pub patch: Option<String>,
    #[serde(default = "default_alpha")]
    pub shrink_alpha: f32,
}
fn default_pr_floor() -> f32 {
    0.0075
}
fn default_alpha() -> f32 {
    1.0
}

#[derive(Serialize)]
pub struct BanRow {
    pub position: String,
    pub opponent: String,
    pub pr: f32,
    pub best_response: f32,
    pub best_champ: String,
    pub ban_score: f32,
}

#[derive(Serialize)]
pub struct BansResponse {
    pub empty: bool,
    pub rows: Vec<BanRow>,
}

pub fn ban_candidates(store: &DataStore, req: &BansRequest) -> Option<BansResponse> {
    if req.pool.is_empty() {
        return None;
    }
    let mut rows: Vec<BanRow> = Vec::new();
    for &pos in ROLES.iter() {
        let pair = match store.matchup.get(&req.my_role).and_then(|m| m.get(pos)) {
            Some(p) => p,
            None => continue,
        };
        let mat = blend_pair(pair, req.shrink_alpha);
        let pr_pos = store.pr_for_role(pos, req.patch.as_deref());

        let keep_cols_idx: Vec<usize> = pair
            .cols
            .iter()
            .enumerate()
            .filter(|(_, c)| pr_pos.get(c.as_str()).copied().unwrap_or(0.0) >= req.pr_floor)
            .map(|(i, _)| i)
            .collect();
        let mut keep_cols: Vec<String> =
            keep_cols_idx.iter().map(|&i| pair.cols[i].clone()).collect();

        let pool_in: Vec<(usize, String)> = req
            .pool
            .iter()
            .filter_map(|ch| {
                pair.rows
                    .iter()
                    .position(|r| r == ch)
                    .map(|i| (i, ch.clone()))
            })
            .collect();
        if pool_in.is_empty() || keep_cols.is_empty() {
            continue;
        }

        let n_rows = pool_in.len();
        let mut n_cols = keep_cols_idx.len();
        let mut sub = Array2::<f32>::zeros((n_rows, n_cols));
        for (r_i, (src_r, _)) in pool_in.iter().enumerate() {
            for (c_i, &src_c) in keep_cols_idx.iter().enumerate() {
                sub[[r_i, c_i]] = mat[[*src_r, src_c]];
            }
        }

        // Mirror matchup: don't suggest banning a pool member.
        if pos == req.my_role {
            let pool_set: HashSet<&str> = pool_in.iter().map(|(_, n)| n.as_str()).collect();
            let mask: Vec<bool> = keep_cols
                .iter()
                .map(|c| !pool_set.contains(c.as_str()))
                .collect();
            if !mask.iter().any(|&b| b) {
                continue;
            }
            let kept: Vec<usize> = mask
                .iter()
                .enumerate()
                .filter(|(_, &b)| b)
                .map(|(i, _)| i)
                .collect();
            let mut new_sub = Array2::<f32>::zeros((n_rows, kept.len()));
            for (c_new, &c_old) in kept.iter().enumerate() {
                for r in 0..n_rows {
                    new_sub[[r, c_new]] = sub[[r, c_old]];
                }
            }
            sub = new_sub;
            keep_cols = kept.iter().map(|&i| keep_cols[i].clone()).collect();
            n_cols = keep_cols.len();
        }
        if n_cols == 0 {
            continue;
        }

        let mut best_response = vec![0.0_f32; n_cols];
        let mut best_idx = vec![0_usize; n_cols];
        for j in 0..n_cols {
            let mut max_val = sub[[0, j]];
            let mut max_idx = 0_usize;
            for i in 1..n_rows {
                if sub[[i, j]] > max_val {
                    max_val = sub[[i, j]];
                    max_idx = i;
                }
            }
            best_response[j] = max_val;
            best_idx[j] = max_idx;
        }

        let pr_vals: Vec<f32> = keep_cols
            .iter()
            .map(|c| pr_pos.get(c.as_str()).copied().unwrap_or(0.0))
            .collect();

        let ban_score: Vec<f32> = if req.pr_weighted {
            let w_total: f32 = pr_vals.iter().sum();
            if w_total <= 0.0 {
                let mu: f32 = best_response.iter().sum::<f32>() / n_cols as f32;
                best_response.iter().map(|&r| mu - r).collect()
            } else {
                let mu: f32 = pr_vals
                    .iter()
                    .zip(best_response.iter())
                    .map(|(p, r)| p * r)
                    .sum::<f32>()
                    / w_total;
                pr_vals
                    .iter()
                    .zip(best_response.iter())
                    .map(|(&p, &r)| {
                        let denom = (w_total - p).max(1e-9);
                        (p / denom) * (mu - r)
                    })
                    .collect()
            }
        } else {
            let mu: f32 = best_response.iter().sum::<f32>() / n_cols as f32;
            best_response.iter().map(|&r| mu - r).collect()
        };

        for j in 0..n_cols {
            rows.push(BanRow {
                position: pos.to_string(),
                opponent: keep_cols[j].clone(),
                pr: pr_vals[j],
                best_response: best_response[j],
                best_champ: pool_in[best_idx[j]].1.clone(),
                ban_score: ban_score[j],
            });
        }
    }

    if rows.is_empty() {
        return None;
    }
    rows.sort_by(|a, b| {
        b.ban_score
            .partial_cmp(&a.ban_score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Some(BansResponse { empty: false, rows })
}
