//! Replacement Finder + Pool Builder — port of `_reference_backend/ports.ranked_candidates`,
//! `built_pools`, `pb_combo_count`, and `replacement_candidates`.
//!
//! Both endpoints score candidate pools with `pool_stats` (from `ports.rs`)
//! and `total_score_from_stats`. Replacement Finder iterates one-candidate
//! changes (add or best-of-N replace); Pool Builder enumerates combinations
//! of (definite ∪ maybe) up to `target` size, scored under user weights.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use super::blind::{blind_stats, blind_z_lookup};
use crate::data::DataStore;
use crate::ports::{pool_stats, total_score_from_stats, z_matrices, PoolStats};
use crate::util::consts;
use crate::util::defaults;

const POOL_BUILDER_CAP: u64 = 10_000;

// ── Replacement Finder ───────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ReplacementsRequest {
    pub my_role: String,
    pub pool: Vec<String>,
    /// "add" | "replace"
    pub mode: String,
    #[serde(default)]
    pub locked: Vec<String>,
    #[serde(default = "defaults::top_x")]
    pub top_x: usize,
    #[serde(default = "defaults::pr_floor_default")]
    pub pr_floor: f32,
    #[serde(default)]
    pub pr_weighted: bool,
    #[serde(default)]
    pub patch: Option<String>,
    #[serde(default = "defaults::alpha")]
    pub shrink_alpha: f32,
    #[serde(default = "defaults::one_f32")]
    pub w_in_lane: f32,
    #[serde(default = "defaults::one_f32")]
    pub w_out_lane: f32,
    #[serde(default = "defaults::one_f32")]
    pub w_synergy: f32,
    #[serde(default = "default_w_blind")]
    pub w_blind: f32,
    #[serde(default = "defaults::one_f32")]
    pub sigma_in_lane: f32,
    #[serde(default = "defaults::one_f32")]
    pub sigma_out_lane: f32,
    #[serde(default = "defaults::one_f32")]
    pub sigma_synergy: f32,
    #[serde(default = "defaults::one_f32")]
    pub sigma_blind: f32,
    /// Optional per-component σs for the post-add pool (size N+1). When
    /// missing or in `replace` mode, falls back to base σs.
    #[serde(default)]
    pub new_sigma_in_lane: Option<f32>,
    #[serde(default)]
    pub new_sigma_out_lane: Option<f32>,
    #[serde(default)]
    pub new_sigma_synergy: Option<f32>,
    #[serde(default)]
    pub new_sigma_blind: Option<f32>,
}

fn default_w_blind() -> f32 {
    0.3
}

#[derive(Serialize)]
pub struct ReplacementRow {
    pub candidate: String,
    pub remove: Option<String>,
    pub new_score: f32,
    pub delta_matchup: Option<f32>,
    pub delta_matchup_in_lane: Option<f32>,
    pub delta_matchup_out_of_lane: Option<f32>,
    pub delta_synergy: Option<f32>,
    pub delta_blind: Option<f32>,
    pub delta_total: Option<f32>,
    pub base_score: f32,
}

#[derive(Serialize)]
pub struct BaseScores {
    pub overall_matchup: Option<f32>,
    pub overall_synergy: Option<f32>,
    pub in_lane_matchup: Option<f32>,
    pub out_of_lane_matchup: Option<f32>,
    pub blindability: Option<f32>,
    pub total_score: Option<f32>,
    pub total_score_new_sigma: Option<f32>,
}

#[derive(Serialize)]
pub struct ReplacementsResponse {
    pub empty: bool,
    pub rows: Vec<ReplacementRow>,
    pub base_scores: BaseScores,
    pub pool_size: usize,
}

pub fn replacements(
    store: &DataStore,
    req: &ReplacementsRequest,
) -> Option<ReplacementsResponse> {
    if req.pool.is_empty() {
        return None;
    }
    if req.mode != "add" && req.mode != "replace" {
        return None;
    }
    let cands = replacement_candidates(store, &req.my_role, &req.pool);
    if cands.is_empty() {
        return None;
    }
    let zmats = z_matrices(
        store,
        &req.my_role,
        req.patch.as_deref(),
        req.pr_floor,
        req.shrink_alpha,
    );
    if zmats.is_empty() {
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
    let bz = blind_z_lookup(&blind);

    let base_stats = pool_stats(
        &req.pool,
        &zmats,
        store,
        req.top_x,
        &req.my_role,
        req.pr_weighted,
        Some(&bz),
        req.patch.as_deref(),
    );
    let base_total = total_score_from_stats(
        &base_stats,
        req.w_in_lane,
        req.w_out_lane,
        req.w_synergy,
        req.w_blind,
        req.sigma_in_lane,
        req.sigma_out_lane,
        req.sigma_synergy,
        req.sigma_blind,
    );

    // New-pool σs default to base when not provided (replace mode behavior).
    let n_sig_in = req.new_sigma_in_lane.unwrap_or(req.sigma_in_lane);
    let n_sig_out = req.new_sigma_out_lane.unwrap_or(req.sigma_out_lane);
    let n_sig_syn = req.new_sigma_synergy.unwrap_or(req.sigma_synergy);
    let n_sig_blind = req.new_sigma_blind.unwrap_or(req.sigma_blind);

    let mut rows: Vec<ReplacementRow> = Vec::new();

    if req.mode == "add" {
        for c in &cands {
            let mut new_pool = req.pool.clone();
            new_pool.push(c.clone());
            let st = pool_stats(
                &new_pool,
                &zmats,
                store,
                req.top_x,
                &req.my_role,
                req.pr_weighted,
                Some(&bz),
                req.patch.as_deref(),
            );
            let total = total_score_from_stats(
                &st,
                req.w_in_lane,
                req.w_out_lane,
                req.w_synergy,
                req.w_blind,
                n_sig_in,
                n_sig_out,
                n_sig_syn,
                n_sig_blind,
            );
            if !total.is_finite() {
                continue;
            }
            rows.push(make_row(
                c.clone(),
                None,
                total,
                &st,
                &base_stats,
                req.w_in_lane,
                req.w_out_lane,
                req.w_synergy,
                req.w_blind,
                n_sig_in,
                n_sig_out,
                n_sig_syn,
                n_sig_blind,
            ));
        }
    } else {
        let locked_set: HashSet<&str> = req.locked.iter().map(|s| s.as_str()).collect();
        let removable: Vec<&String> = req
            .pool
            .iter()
            .filter(|p| !locked_set.contains(p.as_str()))
            .collect();
        if removable.is_empty() {
            return None;
        }
        for c in &cands {
            let mut best_total = f32::NEG_INFINITY;
            let mut best_stats: Option<PoolStats> = None;
            let mut rm_best: Option<String> = None;
            for rem in &removable {
                let new_pool: Vec<String> = req
                    .pool
                    .iter()
                    .filter(|p| p.as_str() != rem.as_str())
                    .cloned()
                    .chain(std::iter::once(c.clone()))
                    .collect();
                let st = pool_stats(
                    &new_pool,
                    &zmats,
                    store,
                    req.top_x,
                    &req.my_role,
                    req.pr_weighted,
                    Some(&bz),
                    req.patch.as_deref(),
                );
                let total = total_score_from_stats(
                    &st,
                    req.w_in_lane,
                    req.w_out_lane,
                    req.w_synergy,
                    req.w_blind,
                    req.sigma_in_lane,
                    req.sigma_out_lane,
                    req.sigma_synergy,
                    req.sigma_blind,
                );
                if total.is_finite() && total > best_total {
                    best_total = total;
                    best_stats = Some(st);
                    rm_best = Some((*rem).clone());
                }
            }
            if let Some(st) = best_stats {
                rows.push(make_row(
                    c.clone(),
                    rm_best,
                    best_total,
                    &st,
                    &base_stats,
                    req.w_in_lane,
                    req.w_out_lane,
                    req.w_synergy,
                    req.w_blind,
                    req.sigma_in_lane,
                    req.sigma_out_lane,
                    req.sigma_synergy,
                    req.sigma_blind,
                ));
            }
        }
    }

    // Sort by delta_total desc; None last.
    rows.sort_by(|a, b| match (a.delta_total, b.delta_total) {
        (Some(av), Some(bv)) => bv
            .partial_cmp(&av)
            .unwrap_or(std::cmp::Ordering::Equal),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
    for r in &mut rows {
        r.base_score = base_total;
    }

    let base_total_new_sigma = if req.mode == "add" {
        Some(total_score_from_stats(
            &base_stats,
            req.w_in_lane,
            req.w_out_lane,
            req.w_synergy,
            req.w_blind,
            n_sig_in,
            n_sig_out,
            n_sig_syn,
            n_sig_blind,
        ))
    } else {
        None
    };

    let to_opt = |v: f32| if v.is_finite() { Some(v) } else { None };
    let base_scores = BaseScores {
        overall_matchup: to_opt(base_stats.matchup_z),
        overall_synergy: to_opt(base_stats.synergy_z),
        in_lane_matchup: to_opt(base_stats.matchup_in_lane),
        out_of_lane_matchup: to_opt(base_stats.matchup_out_of_lane),
        blindability: to_opt(base_stats.blind_z),
        total_score: to_opt(base_total),
        total_score_new_sigma: base_total_new_sigma.and_then(to_opt),
    };

    Some(ReplacementsResponse {
        empty: false,
        rows,
        base_scores,
        pool_size: req.pool.len(),
    })
}

#[allow(clippy::too_many_arguments)]
fn make_row(
    candidate: String,
    remove: Option<String>,
    new_score: f32,
    new_stats: &PoolStats,
    base_stats: &PoolStats,
    w_in_lane: f32,
    w_out_lane: f32,
    w_synergy: f32,
    w_blind: f32,
    sigma_in_lane: f32,
    sigma_out_lane: f32,
    sigma_synergy: f32,
    sigma_blind: f32,
) -> ReplacementRow {
    let delta = |a: f32, b: f32| -> Option<f32> {
        if a.is_finite() && b.is_finite() {
            Some(a - b)
        } else {
            None
        }
    };
    let new_total = total_score_from_stats(
        new_stats,
        w_in_lane,
        w_out_lane,
        w_synergy,
        w_blind,
        sigma_in_lane,
        sigma_out_lane,
        sigma_synergy,
        sigma_blind,
    );
    let base_total_new = total_score_from_stats(
        base_stats,
        w_in_lane,
        w_out_lane,
        w_synergy,
        w_blind,
        sigma_in_lane,
        sigma_out_lane,
        sigma_synergy,
        sigma_blind,
    );
    ReplacementRow {
        candidate,
        remove,
        new_score,
        delta_matchup: delta(new_stats.matchup_z, base_stats.matchup_z),
        delta_matchup_in_lane: delta(new_stats.matchup_in_lane, base_stats.matchup_in_lane),
        delta_matchup_out_of_lane: delta(
            new_stats.matchup_out_of_lane,
            base_stats.matchup_out_of_lane,
        ),
        delta_synergy: delta(new_stats.synergy_z, base_stats.synergy_z),
        delta_blind: delta(new_stats.blind_z, base_stats.blind_z),
        delta_total: delta(new_total, base_total_new),
        base_score: 0.0, // overwritten by caller after sorting
    }
}

/// Champs at `my_role` with PR ≥ 0.5%, not already in pool, sorted by PR desc.
/// Mirrors `ports.replacement_candidates`. Uses cross-patch pr_by_role
/// (matches the Python which reads `store.ind_wr` directly, not the
/// patch-swapped table).
fn replacement_candidates(store: &DataStore, my_role: &str, pool: &[String]) -> Vec<String> {
    let pr_my = match store.pr_by_role.get(my_role) {
        Some(m) => m,
        None => return vec![],
    };
    let pool_set: HashSet<&str> = pool.iter().map(|s| s.as_str()).collect();
    let mut champs: Vec<(String, f32)> = pr_my
        .iter()
        .filter(|(ch, &pr)| pr >= consts::PR_FLOOR_REPLACEMENTS && !pool_set.contains(ch.as_str()))
        .map(|(ch, &pr)| (ch.clone(), pr))
        .collect();
    champs.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    champs.into_iter().map(|(ch, _)| ch).collect()
}

// ── Pool Builder ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct BuildRequest {
    pub my_role: String,
    #[serde(default)]
    pub definite: Vec<String>,
    #[serde(default)]
    pub maybe: Vec<String>,
    #[serde(default = "default_target")]
    pub target: usize,
    #[serde(default = "defaults::top_x")]
    pub top_x: usize,
    #[serde(default = "defaults::pr_floor_default")]
    pub pr_floor: f32,
    #[serde(default)]
    pub pr_weighted: bool,
    #[serde(default)]
    pub patch: Option<String>,
    #[serde(default = "defaults::alpha")]
    pub shrink_alpha: f32,
    #[serde(default = "defaults::one_f32")]
    pub w_in_lane: f32,
    #[serde(default = "defaults::one_f32")]
    pub w_out_lane: f32,
    #[serde(default = "defaults::one_f32")]
    pub w_synergy: f32,
    #[serde(default = "default_w_blind")]
    pub w_blind: f32,
    #[serde(default = "defaults::one_f32")]
    pub sigma_in_lane: f32,
    #[serde(default = "defaults::one_f32")]
    pub sigma_out_lane: f32,
    #[serde(default = "defaults::one_f32")]
    pub sigma_synergy: f32,
    #[serde(default = "defaults::one_f32")]
    pub sigma_blind: f32,
}

fn default_target() -> usize {
    6
}

#[derive(Serialize)]
pub struct BuildRow {
    pub id: usize,
    pub pool: Vec<String>,
    pub pool_text: String,
    pub score: Option<f32>,
    pub overall: Option<f32>,
    pub matchup_z: Option<f32>,
    pub matchup_in_lane: Option<f32>,
    pub matchup_out_of_lane: Option<f32>,
    pub synergy_z: Option<f32>,
    pub lane_z: Option<f32>,
    pub blind_z: Option<f32>,
}

#[derive(Serialize)]
pub struct BuildResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows: Option<Vec<BuildRow>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub n_combos: Option<u64>,
}

pub fn build(store: &DataStore, req: &BuildRequest) -> BuildResponse {
    let keeps: Vec<String> = req.definite.clone();
    let keeps_set: HashSet<&str> = keeps.iter().map(|s| s.as_str()).collect();
    let maybes: Vec<String> = req
        .maybe
        .iter()
        .filter(|m| !keeps_set.contains(m.as_str()))
        .cloned()
        .collect();

    if keeps.len() + maybes.len() < 2 {
        return error("Pick at least 2 total champions across Definite + Maybe.");
    }
    if keeps.len() > req.target {
        return error(&format!(
            "You marked {} definite keeps but target size is {}. Reduce keeps or raise target.",
            keeps.len(),
            req.target
        ));
    }
    let remaining = req.target - keeps.len();
    if maybes.len() < remaining {
        return error(&format!(
            "Need {} more slot(s) filled from Maybe, but only {} Maybe champ(s) available.",
            remaining,
            maybes.len()
        ));
    }

    let n_combos = combo_count(maybes.len(), remaining);
    if n_combos > POOL_BUILDER_CAP {
        return error(&format!(
            "Too many combinations ({:?} > {}). Mark more Definites, raise target size, or remove some Maybes.",
            n_combos, POOL_BUILDER_CAP
        ));
    }

    let zmats = z_matrices(
        store,
        &req.my_role,
        req.patch.as_deref(),
        req.pr_floor,
        req.shrink_alpha,
    );
    if zmats.is_empty() {
        return error("No coverage data for this role.");
    }
    let blind = blind_stats(
        store,
        &req.my_role,
        req.patch.as_deref(),
        req.pr_floor,
        req.pr_weighted,
        req.shrink_alpha,
    );
    let bz = blind_z_lookup(&blind);

    let to_opt = |v: f32| if v.is_finite() { Some(v) } else { None };
    let mut rows: Vec<BuildRow> = Vec::new();
    let combos: Vec<Vec<usize>> = if remaining == 0 {
        vec![vec![]]
    } else {
        combinations(&maybes, remaining)
    };

    for (i, combo_idx) in combos.iter().enumerate() {
        let mut pool: Vec<String> = keeps.clone();
        for &k in combo_idx {
            pool.push(maybes[k].clone());
        }
        let st = pool_stats(
            &pool,
            &zmats,
            store,
            req.top_x,
            &req.my_role,
            req.pr_weighted,
            Some(&bz),
            req.patch.as_deref(),
        );
        let score = total_score_from_stats(
            &st,
            req.w_in_lane,
            req.w_out_lane,
            req.w_synergy,
            req.w_blind,
            req.sigma_in_lane,
            req.sigma_out_lane,
            req.sigma_synergy,
            req.sigma_blind,
        );
        if !score.is_finite() {
            continue;
        }
        let mut sorted_pool = pool.clone();
        sorted_pool.sort();
        let pool_text = sorted_pool.join(", ");
        rows.push(BuildRow {
            id: i + 1,
            pool: sorted_pool,
            pool_text,
            score: to_opt(score),
            overall: to_opt(st.overall),
            matchup_z: to_opt(st.matchup_z),
            matchup_in_lane: to_opt(st.matchup_in_lane),
            matchup_out_of_lane: to_opt(st.matchup_out_of_lane),
            synergy_z: to_opt(st.synergy_z),
            // lane_z = matchup_in_lane (alias kept for compat with Python)
            lane_z: to_opt(st.matchup_in_lane),
            blind_z: to_opt(st.blind_z),
        });
    }
    rows.sort_by(|a, b| {
        let av = a.score.unwrap_or(f32::NEG_INFINITY);
        let bv = b.score.unwrap_or(f32::NEG_INFINITY);
        bv.partial_cmp(&av).unwrap_or(std::cmp::Ordering::Equal)
    });

    BuildResponse {
        error: None,
        rows: Some(rows),
        n_combos: Some(n_combos),
    }
}

fn error(msg: &str) -> BuildResponse {
    BuildResponse {
        error: Some(msg.to_string()),
        rows: None,
        n_combos: None,
    }
}

/// nCr — used by /api/combo_count for the live "X possibilities" UI label.
pub fn combo_count(n: usize, r: usize) -> u64 {
    if r > n {
        return 0;
    }
    let r = r.min(n - r);
    let mut result: u64 = 1;
    for i in 0..r {
        result = result * (n - i) as u64 / (i + 1) as u64;
    }
    result
}

/// All k-subsets of `items.len()` items, returned as index lists (faster than
/// cloning strings each step). Caller maps indices back to names.
fn combinations<T>(items: &[T], k: usize) -> Vec<Vec<usize>> {
    let n = items.len();
    if k == 0 || k > n {
        return if k == 0 { vec![vec![]] } else { vec![] };
    }
    let mut out: Vec<Vec<usize>> = Vec::new();
    let mut idx: Vec<usize> = (0..k).collect();
    loop {
        out.push(idx.clone());
        // Bump the rightmost index that can still advance.
        let mut i = k;
        loop {
            if i == 0 {
                return out;
            }
            i -= 1;
            if idx[i] != i + n - k {
                break;
            }
        }
        idx[i] += 1;
        for j in (i + 1)..k {
            idx[j] = idx[j - 1] + 1;
        }
    }
}
