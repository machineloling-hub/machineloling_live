//! Pool Health — port of `_reference_backend/ports.health_table` and the
//! `/api/health` endpoint logic from `_reference_backend/main.health`.
//!
//! For each opponent role (matchup) or partner role (synergy), runs the
//! same `coverage` pass the Coverage tab uses, then aggregates
//! into a row: covered / uncovered counts, mean top-X stats, blindability,
//! worst-uncovered champion. Frontend renders one table per mode.
//!
//! `redundancy` is **not yet ported** — frontend gracefully degrades when
//! the field is absent. Will land in a follow-up.

use serde::{Deserialize, Serialize};

use super::blind::blind_stats;
use super::compute::{coverage, CoverageRequest, MATCHUP_THRESHOLD, SYNERGY_THRESHOLD};
use super::redundancy::{redundancy, RedundancyPayload};
use crate::data::{DataStore, ROLES};

#[derive(Deserialize)]
pub struct HealthRequest {
    pub my_role: String,
    pub pool: Vec<String>,
    #[serde(default = "default_top_x")]
    pub top_x: usize,
    #[serde(default = "default_pr_floor")]
    pub pr_floor: f32,
    #[serde(default)]
    pub pr_weighted: bool,
    #[serde(default)]
    pub patch: Option<String>,
    #[serde(default = "default_alpha")]
    pub shrink_alpha: f32,
}

fn default_top_x() -> usize {
    1
}
fn default_pr_floor() -> f32 {
    0.0075
}
fn default_alpha() -> f32 {
    1.0
}

#[derive(Serialize)]
pub struct WorstChamp {
    pub champion: String,
    pub z: f32,
}

#[derive(Serialize)]
pub struct HealthRow {
    pub position: String,
    pub n_total: usize,
    pub n_covered: usize,
    pub n_uncovered: usize,
    pub pct_covered: f32,
    pub mean_topx_z: f32,
    pub mean_topx_pp: f32,
    pub mean_best_pp: f32,
    pub blind_z: Option<f32>,
    pub worst: Option<WorstChamp>,
}

#[derive(Serialize)]
pub struct HealthResponse {
    pub empty: bool,
    pub matchup_rows: Vec<HealthRow>,
    pub synergy_rows: Vec<HealthRow>,
    pub redundancy: Option<RedundancyPayload>,
    pub matchup_threshold: f32,
    pub synergy_threshold: f32,
    pub top_x: usize,
}

pub fn health(store: &DataStore, req: &HealthRequest) -> Option<HealthResponse> {
    if req.pool.is_empty() {
        return None;
    }
    let blind = blind_stats(
        store,
        &req.my_role,
        req.patch.as_deref(),
        req.pr_floor,
        req.pr_weighted,
        req.shrink_alpha,
    );

    let matchup_rows = build_rows(store, req, "matchup", &blind);
    let synergy_rows = build_rows(store, req, "synergy", &blind);

    let redundancy = redundancy(
        store,
        &req.my_role,
        &req.pool,
        req.patch.as_deref(),
        req.pr_floor,
        req.pr_weighted,
        req.shrink_alpha,
        req.top_x,
    );

    Some(HealthResponse {
        empty: false,
        matchup_rows,
        synergy_rows,
        redundancy,
        matchup_threshold: MATCHUP_THRESHOLD,
        synergy_threshold: SYNERGY_THRESHOLD,
        top_x: req.top_x,
    })
}

fn build_rows(
    store: &DataStore,
    req: &HealthRequest,
    mode: &str,
    blind: &crate::blind::BlindStats,
) -> Vec<HealthRow> {
    let threshold = if mode == "matchup" {
        MATCHUP_THRESHOLD
    } else {
        SYNERGY_THRESHOLD
    };
    let positions: Vec<&'static str> = if mode == "matchup" {
        ROLES.to_vec()
    } else {
        ROLES.iter().copied().filter(|&r| r != req.my_role).collect()
    };

    let mut rows = Vec::new();
    for &pos in positions.iter() {
        let cov_req = CoverageRequest {
            my_role: req.my_role.clone(),
            other_role: pos.to_string(),
            mode: mode.to_string(),
            pool: req.pool.clone(),
            top_x: req.top_x,
            pr_floor: req.pr_floor,
            shrink_alpha: req.shrink_alpha,
            patch: req.patch.clone(),
            extra_rows: vec![],
            pr_weighted: req.pr_weighted,
        };
        let cov = match coverage(store, &cov_req) {
            Some(c) => c,
            None => continue,
        };

        let n_total = cov.cols.len();
        let max_z_finite: Vec<f32> = cov
            .col_max_z
            .iter()
            .map(|v| v.unwrap_or(f32::NEG_INFINITY))
            .collect();
        let n_covered = max_z_finite.iter().filter(|&&v| v >= threshold).count();
        let n_uncovered = n_total - n_covered;
        let pct_covered = if n_total > 0 {
            100.0 * n_covered as f32 / n_total as f32
        } else {
            0.0
        };

        let worst = if n_uncovered > 0 {
            let mut worst_idx = None;
            let mut worst_val = f32::INFINITY;
            for (j, &v) in max_z_finite.iter().enumerate() {
                if v < threshold && v < worst_val {
                    worst_val = v;
                    worst_idx = Some(j);
                }
            }
            worst_idx.map(|j| WorstChamp {
                champion: cov.cols[j].clone(),
                z: cov.col_max_z[j].unwrap_or(f32::NAN),
            })
        } else {
            None
        };

        // Mean stats — match `coverage_stats` weighting logic.
        let pr_pos = store.pr_for_role(pos, req.patch.as_deref());
        let (mean_topx_z, mean_topx_pp, mean_best_pp) = if req.pr_weighted {
            let weights: Vec<f32> = cov
                .cols
                .iter()
                .map(|c| pr_pos.get(c.as_str()).copied().unwrap_or(0.0).max(0.0))
                .collect();
            let w_sum: f32 = weights.iter().sum();
            if w_sum > 0.0 {
                (
                    weighted_mean(&cov.col_score_z, &weights, w_sum),
                    weighted_mean(&cov.col_score_pp, &weights, w_sum),
                    weighted_mean(&cov.col_max_pp, &weights, w_sum),
                )
            } else {
                (
                    mean_finite_opt(&cov.col_score_z),
                    mean_finite_opt(&cov.col_score_pp),
                    mean_finite_opt(&cov.col_max_pp),
                )
            }
        } else {
            (
                mean_finite_opt(&cov.col_score_z),
                mean_finite_opt(&cov.col_score_pp),
                mean_finite_opt(&cov.col_max_pp),
            )
        };

        let pos_blind_slice = if mode == "matchup" {
            blind.matchup.get(pos)
        } else {
            blind.synergy.get(pos)
        };
        let blind_z = pos_blind_slice.and_then(|slice| {
            let zs: Vec<f32> = req
                .pool
                .iter()
                .filter_map(|ch| {
                    slice
                        .champs
                        .iter()
                        .position(|c| c == ch)
                        .map(|i| slice.z[i])
                })
                .filter(|v| v.is_finite())
                .collect();
            if zs.is_empty() {
                None
            } else {
                Some(zs.iter().sum::<f32>() / zs.len() as f32)
            }
        });

        rows.push(HealthRow {
            position: pos.to_string(),
            n_total,
            n_covered,
            n_uncovered,
            pct_covered,
            mean_topx_z,
            mean_topx_pp,
            mean_best_pp,
            blind_z,
            worst,
        });
    }
    rows
}

// ── /api/pool_summary ─────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct PoolSummaryRequest {
    pub my_role: String,
    pub pool: Vec<String>,
    #[serde(default = "default_top_x")]
    pub top_x: usize,
    #[serde(default = "default_summary_pr_floor")]
    pub pr_floor: f32,
    #[serde(default)]
    pub pr_weighted: bool,
    #[serde(default)]
    pub patch: Option<String>,
    #[serde(default = "default_alpha")]
    pub shrink_alpha: f32,
    #[serde(default = "one")]
    pub w_in_lane: f32,
    #[serde(default = "one")]
    pub w_out_lane: f32,
    #[serde(default = "one")]
    pub w_synergy: f32,
    #[serde(default = "default_w_blind")]
    pub w_blind: f32,
    #[serde(default = "one")]
    pub sigma_in_lane: f32,
    #[serde(default = "one")]
    pub sigma_out_lane: f32,
    #[serde(default = "one")]
    pub sigma_synergy: f32,
    #[serde(default = "one")]
    pub sigma_blind: f32,
}

fn default_summary_pr_floor() -> f32 {
    0.005
}
fn one() -> f32 {
    1.0
}
fn default_w_blind() -> f32 {
    0.2
}

#[derive(Serialize)]
pub struct PoolSummaryScores {
    pub overall_matchup: Option<f32>,
    pub overall_synergy: Option<f32>,
    pub in_lane_matchup: Option<f32>,
    pub out_of_lane_matchup: Option<f32>,
    pub blindability: Option<f32>,
    pub total_score: f32,
}

#[derive(Serialize)]
pub struct PoolSummaryResponse {
    pub empty: bool,
    pub pool_size: usize,
    pub top_x: usize,
    pub scores: PoolSummaryScores,
}

pub fn pool_summary(store: &DataStore, req: &PoolSummaryRequest) -> Option<PoolSummaryResponse> {
    if req.pool.is_empty() {
        return None;
    }
    use crate::blind::blind_z_lookup;
    use crate::ports::lane_roles;
    use std::collections::HashSet;

    let lane_set: HashSet<&str> = lane_roles(&req.my_role).iter().copied().collect();
    let mut matchup_scores: Vec<f32> = Vec::new();
    let mut lane_scores: Vec<f32> = Vec::new();
    let mut out_lane_scores: Vec<f32> = Vec::new();
    let mut synergy_scores: Vec<f32> = Vec::new();

    for &other in ROLES.iter() {
        if let Some(v) =
            coverage_topx_z(store, &req.my_role, other, "matchup", req)
        {
            if v.is_finite() {
                matchup_scores.push(v);
                if lane_set.contains(other) {
                    lane_scores.push(v);
                } else {
                    out_lane_scores.push(v);
                }
            }
        }
        if other != req.my_role {
            if let Some(v) =
                coverage_topx_z(store, &req.my_role, other, "synergy", req)
            {
                if v.is_finite() {
                    synergy_scores.push(v);
                }
            }
        }
    }

    // Blindability = mean of pool's per-champ aggregate blind z
    let blind = blind_stats(
        store,
        &req.my_role,
        req.patch.as_deref(),
        req.pr_floor,
        req.pr_weighted,
        req.shrink_alpha,
    );
    let agg = blind_z_lookup(&blind);
    let pool_z: Vec<f32> = req
        .pool
        .iter()
        .filter_map(|ch| agg.get(ch).copied())
        .filter(|v| v.is_finite())
        .collect();
    let blind_score = if pool_z.is_empty() {
        None
    } else {
        Some(pool_z.iter().sum::<f32>() / pool_z.len() as f32)
    };

    let mean_or = |xs: &[f32]| -> Option<f32> {
        if xs.is_empty() {
            None
        } else {
            Some(xs.iter().sum::<f32>() / xs.len() as f32)
        }
    };

    let in_lane_z = mean_or(&lane_scores);
    let out_lane_z = mean_or(&out_lane_scores);
    let overall_match = mean_or(&matchup_scores);
    let overall_syn = mean_or(&synergy_scores);

    let safe_sigma = |s: f32| if s.is_finite() && s > 1e-9 { s } else { 1.0 };
    let weighted = |v: Option<f32>, w: f32, sig: f32| -> f32 {
        match v {
            Some(x) if x.is_finite() && w != 0.0 => w * x / safe_sigma(sig),
            _ => 0.0,
        }
    };
    let total = weighted(in_lane_z, req.w_in_lane, req.sigma_in_lane)
        + weighted(out_lane_z, req.w_out_lane, req.sigma_out_lane)
        + weighted(overall_syn, req.w_synergy, req.sigma_synergy)
        + weighted(blind_score, req.w_blind, req.sigma_blind);

    Some(PoolSummaryResponse {
        empty: false,
        pool_size: req.pool.len(),
        top_x: req.top_x,
        scores: PoolSummaryScores {
            overall_matchup: overall_match,
            overall_synergy: overall_syn,
            in_lane_matchup: in_lane_z,
            out_of_lane_matchup: out_lane_z,
            blindability: blind_score,
            total_score: total,
        },
    })
}

fn coverage_topx_z(
    store: &DataStore,
    my_role: &str,
    other_role: &str,
    mode: &str,
    req: &PoolSummaryRequest,
) -> Option<f32> {
    let cov_req = CoverageRequest {
        my_role: my_role.to_string(),
        other_role: other_role.to_string(),
        mode: mode.to_string(),
        pool: req.pool.clone(),
        top_x: req.top_x,
        pr_floor: req.pr_floor,
        shrink_alpha: req.shrink_alpha,
        patch: req.patch.clone(),
        extra_rows: vec![],
        pr_weighted: req.pr_weighted,
    };
    let cov = coverage(store, &cov_req)?;
    // Mirror coverage_stats's mean_topx_z calculation.
    let pr_pos = store.pr_for_role(other_role, req.patch.as_deref());
    if req.pr_weighted {
        let weights: Vec<f32> = cov
            .cols
            .iter()
            .map(|c| pr_pos.get(c.as_str()).copied().unwrap_or(0.0).max(0.0))
            .collect();
        let w_sum: f32 = weights.iter().sum();
        if w_sum > 0.0 {
            return Some(weighted_mean(&cov.col_score_z, &weights, w_sum));
        }
    }
    Some(mean_finite_opt(&cov.col_score_z))
}

fn weighted_mean(values: &[Option<f32>], weights: &[f32], w_sum: f32) -> f32 {
    let s: f32 = values
        .iter()
        .zip(weights.iter())
        .filter_map(|(v, w)| v.and_then(|x| if x.is_finite() { Some(x * w) } else { None }))
        .sum();
    s / w_sum
}

fn mean_finite_opt(values: &[Option<f32>]) -> f32 {
    let xs: Vec<f32> = values
        .iter()
        .filter_map(|v| v.and_then(|x| if x.is_finite() { Some(x) } else { None }))
        .collect();
    if xs.is_empty() {
        f32::NAN
    } else {
        xs.iter().sum::<f32>() / xs.len() as f32
    }
}
