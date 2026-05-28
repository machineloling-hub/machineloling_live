//! Blindability — port of `_reference_backend/ports.blind_stats` plus the
//! per-champ aggregation done inline in `_reference_backend/main.blindability`.
//!
//! "Blindable" champion = consistent across opponents = low spread of their
//! delta-pp row over a fixed set of opponent columns. We score each champ's
//! spread (unbiased SD, or reliability-weighted SD if `pr_weighted`) across
//! the columns above `pr_floor`, then population-z-score the spreads and
//! flip the sign so HIGH z = LOW spread = blindable.
//!
//! We only ship the SD-based metric (no τ-blind variant — that's the
//! `hier_tau` shrink method which isn't shipped, see README).

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::data::{DataStore, ROLES};

#[derive(Deserialize)]
pub struct BlindabilityRequest {
    pub my_role: String,
    #[serde(default)]
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
    0.005
}
fn default_alpha() -> f32 {
    1.0
}

#[derive(Serialize)]
pub struct BlindabilityRow {
    pub champion: String,
    pub in_pool: bool,
    pub matchup_mean: Option<f32>,
    pub synergy_mean: Option<f32>,
    pub lane_matchup: Option<f32>,
    pub out_of_lane_matchup: Option<f32>,
    pub lane_synergy: Option<f32>,
    pub out_of_lane_synergy: Option<f32>,
    pub aggregate: Option<f32>,
}

#[derive(Serialize)]
pub struct BlindabilityResponse {
    pub empty: bool,
    pub rows: Vec<BlindabilityRow>,
    pub lane_matchup_pos: Vec<String>,
    pub lane_synergy_pos: Option<String>,
}

/// Per-(mode, pos) blindability slice — used both by `/api/blindability`
/// and (later) by Pool Health for the redundancy "blind aggregate" column.
pub struct BlindSlice {
    pub champs: Vec<String>,
    pub z: Vec<f32>,
}

pub struct BlindStats {
    pub matchup: HashMap<String, BlindSlice>,
    pub synergy: HashMap<String, BlindSlice>,
}

pub fn blind_stats(
    store: &DataStore,
    my_role: &str,
    patch: Option<&str>,
    pr_floor: f32,
    pr_weighted: bool,
    shrink_alpha: f32,
) -> BlindStats {
    let mut result = BlindStats {
        matchup: HashMap::new(),
        synergy: HashMap::new(),
    };

    for &mode in &["matchup", "synergy"] {
        let pairs_map = if mode == "matchup" {
            &store.matchup
        } else {
            &store.synergy
        };
        let role_pairs = match pairs_map.get(my_role) {
            Some(m) => m,
            None => continue,
        };
        for &pos in ROLES.iter() {
            if mode == "synergy" && pos == my_role {
                continue;
            }
            let pair = match role_pairs.get(pos) {
                Some(p) => p,
                None => continue,
            };
            // Blindability measures *spread* of a row across opponents. We
            // intentionally use the RAW (pre-shrinkage) matrix here: hier
            // shrinkage pulls low-sample cells toward 0, which artificially
            // compresses the row of low-PR champs (making them look very
            // blindable) and leaves high-PR rows alone (making them look
            // unblindable by comparison). The aggregation pipeline already
            // filters pairs by `min_games_cell` (default 50), so the
            // remaining sampling noise contributes ≤ ~0.07 SD per cell —
            // small relative to true between-opponent variation.
            // `shrink_alpha` is intentionally ignored here.
            let _ = shrink_alpha;
            let mat = &pair.raw;
            let pr_pos = store.pr_for_role(pos, patch);

            let keep_idx: Vec<usize> = pair
                .cols
                .iter()
                .enumerate()
                .filter(|(_, c)| pr_pos.get(c.as_str()).copied().unwrap_or(0.0) >= pr_floor)
                .map(|(i, _)| i)
                .collect();
            if keep_idx.len() < 3 {
                continue;
            }

            let n_rows = mat.nrows();
            let n_cols_kept = keep_idx.len();

            // Per-row spread (SD or weighted SD)
            let weights: Option<Vec<f32>> = if pr_weighted {
                let mut w: Vec<f32> = keep_idx
                    .iter()
                    .map(|&i| {
                        pr_pos
                            .get(pair.cols[i].as_str())
                            .copied()
                            .unwrap_or(0.0)
                            .max(0.0)
                    })
                    .collect();
                if w.iter().sum::<f32>() <= 0.0 {
                    w = vec![1.0; n_cols_kept];
                }
                Some(w)
            } else {
                None
            };

            let sds: Vec<f32> = (0..n_rows)
                .map(|r| {
                    let row: Vec<f32> = keep_idx.iter().map(|&c| mat[[r, c]]).collect();
                    match &weights {
                        Some(w) => weighted_sd(&row, w),
                        None => unbiased_sd(&row),
                    }
                })
                .collect();

            // Population z-score, flipped: high z = low spread = blindable.
            let m = mean_finite(&sds);
            let s = unbiased_sd(&sds);
            let safe_s = if !s.is_finite() || s < 1e-9 { 1.0 } else { s };
            let z: Vec<f32> = sds
                .iter()
                .map(|&v| {
                    if v.is_finite() {
                        -((v - m) / safe_s)
                    } else {
                        f32::NAN
                    }
                })
                .collect();

            let slice = BlindSlice {
                champs: pair.rows.clone(),
                z,
            };
            if mode == "matchup" {
                result.matchup.insert(pos.to_string(), slice);
            } else {
                result.synergy.insert(pos.to_string(), slice);
            }
        }
    }

    result
}

/// Per-champion aggregate blindability z (mean across all available slices).
/// Mirrors `ports.blind_z_lookup`. Used by Pool Health redundancy and the
/// total-score blind component.
pub fn blind_z_lookup(blind: &BlindStats) -> HashMap<String, f32> {
    let mut agg: HashMap<String, Vec<f32>> = HashMap::new();
    for slice in blind.matchup.values() {
        for (ch, &z) in slice.champs.iter().zip(slice.z.iter()) {
            if z.is_finite() {
                agg.entry(ch.clone()).or_default().push(z);
            }
        }
    }
    for slice in blind.synergy.values() {
        for (ch, &z) in slice.champs.iter().zip(slice.z.iter()) {
            if z.is_finite() {
                agg.entry(ch.clone()).or_default().push(z);
            }
        }
    }
    agg.iter()
        .map(|(ch, vs)| {
            let mean = vs.iter().sum::<f32>() / vs.len() as f32;
            (ch.clone(), mean)
        })
        .collect()
}

pub fn blindability(
    store: &DataStore,
    req: &BlindabilityRequest,
) -> Option<BlindabilityResponse> {
    if !ROLES.contains(&req.my_role.as_str()) {
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
    if blind.matchup.is_empty() && blind.synergy.is_empty() {
        return Some(BlindabilityResponse {
            empty: true,
            rows: vec![],
            lane_matchup_pos: vec![],
            lane_synergy_pos: None,
        });
    }

    // Eligibility: champs at my_role with PR >= pr_floor (patch-aware), unioned with the pool.
    let pr_my = store.pr_for_role(&req.my_role, req.patch.as_deref());
    let mut eligible: HashSet<String> = pr_my
        .iter()
        .filter(|(_, &pr)| pr >= req.pr_floor)
        .map(|(ch, _)| ch.clone())
        .collect();
    for ch in &req.pool {
        eligible.insert(ch.clone());
    }
    let pool_set: HashSet<&str> = req.pool.iter().map(|s| s.as_str()).collect();

    // Lane definitions for this role.
    let (lane_match_pos, lane_synergy_pos): (Vec<&'static str>, Option<&'static str>) =
        match req.my_role.as_str() {
            "ADC" => (vec!["ADC", "SUP"], Some("SUP")),
            "SUP" => (vec!["ADC", "SUP"], Some("ADC")),
            "TOP" => (vec!["TOP"], None),
            "JUNGLE" => (vec!["JUNGLE"], None),
            "MID" => (vec!["MID"], None),
            _ => (vec![], None),
        };
    let lane_match_set: HashSet<&'static str> = lane_match_pos.iter().copied().collect();

    let mut rows: Vec<BlindabilityRow> = Vec::new();
    for ch in &eligible {
        let mut match_zs: Vec<f32> = Vec::new();
        let mut match_lane_zs: Vec<f32> = Vec::new();
        let mut match_outlane_zs: Vec<f32> = Vec::new();
        for (pos, slice) in &blind.matchup {
            if let Some(idx) = slice.champs.iter().position(|c| c == ch) {
                let v = slice.z[idx];
                if v.is_finite() {
                    match_zs.push(v);
                    if lane_match_set.contains(pos.as_str()) {
                        match_lane_zs.push(v);
                    } else {
                        match_outlane_zs.push(v);
                    }
                }
            }
        }
        let mut syn_zs: Vec<f32> = Vec::new();
        let mut syn_lane_zs: Vec<f32> = Vec::new();
        let mut syn_outlane_zs: Vec<f32> = Vec::new();
        for (pos, slice) in &blind.synergy {
            if let Some(idx) = slice.champs.iter().position(|c| c == ch) {
                let v = slice.z[idx];
                if v.is_finite() {
                    syn_zs.push(v);
                    if Some(pos.as_str()) == lane_synergy_pos {
                        syn_lane_zs.push(v);
                    } else {
                        syn_outlane_zs.push(v);
                    }
                }
            }
        }
        if match_zs.is_empty() && syn_zs.is_empty() {
            continue;
        }
        let mut all_zs = match_zs.clone();
        all_zs.extend(syn_zs.iter());
        rows.push(BlindabilityRow {
            champion: ch.clone(),
            in_pool: pool_set.contains(ch.as_str()),
            matchup_mean: mean_or_none(&match_zs),
            synergy_mean: mean_or_none(&syn_zs),
            lane_matchup: mean_or_none(&match_lane_zs),
            out_of_lane_matchup: mean_or_none(&match_outlane_zs),
            lane_synergy: mean_or_none(&syn_lane_zs),
            out_of_lane_synergy: mean_or_none(&syn_outlane_zs),
            aggregate: mean_or_none(&all_zs),
        });
    }

    // Sort by aggregate desc; None goes last.
    rows.sort_by(|a, b| match (a.aggregate, b.aggregate) {
        (Some(av), Some(bv)) => bv
            .partial_cmp(&av)
            .unwrap_or(std::cmp::Ordering::Equal),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });

    let mut sorted_lane: Vec<String> = lane_match_pos.iter().map(|s| s.to_string()).collect();
    sorted_lane.sort();

    Some(BlindabilityResponse {
        empty: false,
        rows,
        lane_matchup_pos: sorted_lane,
        lane_synergy_pos: lane_synergy_pos.map(String::from),
    })
}

fn weighted_sd(x: &[f32], w: &[f32]) -> f32 {
    let valid: Vec<usize> = (0..x.len())
        .filter(|&i| x[i].is_finite() && w[i].is_finite() && w[i] > 0.0)
        .collect();
    if valid.len() < 2 {
        return f32::NAN;
    }
    let xv: Vec<f32> = valid.iter().map(|&i| x[i]).collect();
    let wv: Vec<f32> = valid.iter().map(|&i| w[i]).collect();
    let sw: f32 = wv.iter().sum();
    let mw: f32 = wv.iter().zip(xv.iter()).map(|(w, x)| w * x).sum::<f32>() / sw;
    let denom = sw - wv.iter().map(|w| w * w).sum::<f32>() / sw;
    if denom <= 0.0 {
        return f32::NAN;
    }
    let var: f32 = wv
        .iter()
        .zip(xv.iter())
        .map(|(w, x)| w * (x - mw).powi(2))
        .sum::<f32>()
        / denom;
    var.sqrt()
}

fn unbiased_sd(x: &[f32]) -> f32 {
    let valid: Vec<f32> = x.iter().copied().filter(|v| v.is_finite()).collect();
    if valid.len() < 2 {
        return f32::NAN;
    }
    let m: f32 = valid.iter().sum::<f32>() / valid.len() as f32;
    let var: f32 =
        valid.iter().map(|&v| (v - m).powi(2)).sum::<f32>() / (valid.len() - 1) as f32;
    var.sqrt()
}

fn mean_finite(x: &[f32]) -> f32 {
    let v: Vec<f32> = x.iter().copied().filter(|v| v.is_finite()).collect();
    if v.is_empty() {
        f32::NAN
    } else {
        v.iter().sum::<f32>() / v.len() as f32
    }
}

fn mean_or_none(x: &[f32]) -> Option<f32> {
    if x.is_empty() {
        None
    } else {
        Some(x.iter().sum::<f32>() / x.len() as f32)
    }
}
