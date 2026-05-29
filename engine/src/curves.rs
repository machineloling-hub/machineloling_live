//! Live Monte-Carlo strength curves — port of `_reference_backend/live_curves.py`
//! plus the helpers from `precompute_pool_distributions.py` it depends on.
//!
//! For a given (role, patch, pool_size, top_x, pr_floor, pr_weighted, shrink_alpha)
//! we sample K random pools of eligible champions and score each pool against
//! the matchup/synergy matrices to produce 4 component sample arrays:
//!
//!   in_lane_matchup, out_of_lane_matchup, overall_synergy, blindability
//!
//! The frontend reduces these to slot stats (mean/sd/percentiles/KDE density)
//! and computes total_score from the user's weight sliders, so we ship the
//! raw samples — no scipy/KDE port required.

use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use ndarray::Array2;
use rand::rngs::StdRng;
use rand::seq::index::sample as sample_indices;
use rand::SeedableRng;
use serde::{Deserialize, Serialize};

use crate::data::{DataStore, ROLES};
use crate::endpoints::blind::{blind_stats, blind_z_lookup};
use crate::util::defaults;
use crate::ports::{blend_pair, lane_roles, z_score_columns};

const PERCENTILE_GRID: [u32; 21] = [
    0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100,
];
const N_HIST_BINS: u32 = 30;
const DEFAULT_K: usize = 1000;

#[derive(Deserialize)]
pub struct StrengthCurvesRequest {
    pub my_role: String,
    #[serde(default)]
    pub patch: Option<String>,
    pub pool_size: usize,
    pub top_x: usize,
    #[serde(default = "defaults::pr_floor_default")]
    pub pr_floor: f32,
    #[serde(default)]
    pub pr_weighted: bool,
    #[serde(default = "defaults::alpha")]
    pub shrink_alpha: f32,
    #[serde(default)]
    pub extra_pool_size: Option<usize>,
    #[serde(default)]
    pub extra_top_x: Option<usize>,
    /// Override sample count; defaults to 500 to match `live_curves.py`.
    #[serde(default)]
    pub n_samples: Option<usize>,
}

#[derive(Serialize)]
pub struct CurvesConfig {
    pub percentile_grid: Vec<u32>,
    pub n_hist_bins: u32,
    pub n_samples: usize,
}

#[derive(Serialize)]
pub struct ComponentSamples {
    pub in_lane_matchup: Vec<f32>,
    pub out_of_lane_matchup: Vec<f32>,
    pub overall_synergy: Vec<f32>,
    pub blindability: Vec<f32>,
}

#[derive(Serialize)]
pub struct ScenarioBlock {
    pub pool_size: usize,
    pub top_x: usize,
    pub samples: ComponentSamples,
}

#[derive(Serialize)]
pub struct StrengthCurvesResponse {
    pub config: CurvesConfig,
    pub primary: ScenarioBlock,
    pub extra: Option<ScenarioBlock>,
}

pub fn strength_curves(
    store: &DataStore,
    req: &StrengthCurvesRequest,
) -> Option<StrengthCurvesResponse> {
    let n_samples = req.n_samples.unwrap_or(DEFAULT_K).max(1);

    // z_subs and blind_z depend on (role, patch, pr_floor, pr_weighted, shrink_alpha)
    // — invariant across pool_size / top_x. Build once and reuse for primary + extra.
    // Use pr_for_role so per-patch data gaps (e.g. SUP missing for high tiers)
    // fall back to the cross-patch default instead of returning an empty pool.
    let patch = req.patch.as_deref();
    let eligible: Vec<String> = {
        let mut e: Vec<String> = store
            .pr_for_role(&req.my_role, patch)
            .iter()
            .filter(|(_, &pr)| pr >= req.pr_floor)
            .map(|(ch, _)| ch.clone())
            .collect();
        e.sort();
        e
    };
    if eligible.len() < 2 {
        return None;
    }

    let mut z_subs: Vec<(String, String, ZSubset)> = Vec::new();
    for &mode in &["matchup", "synergy"] {
        for &opp in ROLES.iter() {
            if mode == "synergy" && opp == req.my_role {
                continue;
            }
            if let Some(zs) = build_z_subset(
                store,
                mode,
                &req.my_role,
                opp,
                &eligible,
                patch,
                req.pr_floor,
                req.shrink_alpha,
            ) {
                z_subs.push((mode.to_string(), opp.to_string(), zs));
            }
        }
    }

    let blind_z = build_blind_z_array(
        store,
        &req.my_role,
        &eligible,
        req.patch.as_deref(),
        req.pr_floor,
        req.pr_weighted,
        req.shrink_alpha,
    );

    let primary = run_scenario(
        &z_subs,
        &blind_z,
        &eligible,
        req,
        req.pool_size,
        req.top_x,
        n_samples,
    )?;

    let extra = req.extra_pool_size.and_then(|ps| {
        let tx = req.extra_top_x.unwrap_or(req.top_x);
        run_scenario(&z_subs, &blind_z, &eligible, req, ps, tx, n_samples)
    });

    Some(StrengthCurvesResponse {
        config: CurvesConfig {
            percentile_grid: PERCENTILE_GRID.to_vec(),
            n_hist_bins: N_HIST_BINS,
            n_samples,
        },
        primary,
        extra,
    })
}

fn run_scenario(
    z_subs: &[(String, String, ZSubset)],
    blind_z: &[f32],
    eligible: &[String],
    req: &StrengthCurvesRequest,
    pool_size: usize,
    top_x: usize,
    n_samples: usize,
) -> Option<ScenarioBlock> {
    if pool_size == 0 || pool_size > eligible.len() {
        return None;
    }
    let eff_top_x = top_x.max(1).min(pool_size);

    let mut rng = make_rng(req, pool_size);
    let pool_idxs = sample_pool_indices(eligible.len(), pool_size, n_samples, &mut rng);
    if pool_idxs.is_empty() {
        return None;
    }
    let k = pool_idxs.len();

    // Score each (mode, opp_role); collect per-(K) sample arrays.
    let lane_set = lane_roles(&req.my_role);

    let mut lane_arrays: Vec<Vec<f32>> = Vec::new();
    let mut out_lane_arrays: Vec<Vec<f32>> = Vec::new();
    let mut synergy_arrays: Vec<Vec<f32>> = Vec::new();

    for (mode, opp, zs) in z_subs.iter() {
        let scored = score_pools(
            zs,
            &pool_idxs,
            pool_size,
            req.pr_weighted,
        );
        let sc = match scored.into_iter().nth(eff_top_x - 1) {
            Some(v) => v,
            None => continue,
        };
        if mode == "matchup" {
            if lane_set.contains(&opp.as_str()) {
                lane_arrays.push(sc);
            } else {
                out_lane_arrays.push(sc);
            }
        } else {
            synergy_arrays.push(sc);
        }
    }

    let in_lane_matchup = stack_nanmean(&lane_arrays, k);
    let out_of_lane_matchup = stack_nanmean(&out_lane_arrays, k);
    let overall_synergy = stack_nanmean(&synergy_arrays, k);
    let blindability = score_pools_blind(blind_z, &pool_idxs);

    Some(ScenarioBlock {
        pool_size,
        top_x: eff_top_x,
        samples: ComponentSamples {
            in_lane_matchup,
            out_of_lane_matchup,
            overall_synergy,
            blindability,
        },
    })
}

// ── pool sampling ─────────────────────────────────────────────────────────

/// Random K-subsets of [0, n). Exhaustive enumeration if C(n, k) <= n_samples,
/// else random distinct k-subsets via partial Fisher-Yates per row.
fn sample_pool_indices(
    n: usize,
    k: usize,
    n_samples: usize,
    rng: &mut StdRng,
) -> Vec<Vec<usize>> {
    if k == 0 || k > n {
        return Vec::new();
    }
    let n_combos = saturating_combinations(n, k);
    if n_combos <= n_samples as u64 {
        return enumerate_combinations(n, k);
    }
    (0..n_samples)
        .map(|_| sample_indices(rng, n, k).into_vec())
        .collect()
}

fn saturating_combinations(n: usize, k: usize) -> u64 {
    if k > n {
        return 0;
    }
    let k = k.min(n - k);
    let mut acc: u64 = 1;
    for i in 0..k {
        // acc *= (n - i); acc /= (i + 1)
        let num = (n - i) as u64;
        let den = (i + 1) as u64;
        // avoid intermediate overflow when possible via saturating_mul
        match acc.checked_mul(num) {
            Some(v) => acc = v / den,
            None => return u64::MAX,
        }
    }
    acc
}

fn enumerate_combinations(n: usize, k: usize) -> Vec<Vec<usize>> {
    let mut out = Vec::new();
    let mut idx: Vec<usize> = (0..k).collect();
    loop {
        out.push(idx.clone());
        // Find rightmost index that can be incremented.
        let mut i = k;
        while i > 0 {
            i -= 1;
            if idx[i] != i + n - k {
                idx[i] += 1;
                for j in (i + 1)..k {
                    idx[j] = idx[j - 1] + 1;
                }
                break;
            }
            if i == 0 {
                return out;
            }
        }
        if idx[0] > n - k {
            return out;
        }
    }
}

// ── per-(mode, other_role) z subset ───────────────────────────────────────

pub struct ZSubset {
    /// (n_eligible, n_cols_kept) — z-scores for eligible champs, NaN where the
    /// eligible champ isn't in this pair's row index.
    z: Array2<f32>,
    col_pr: Vec<f32>,
    /// Mirror matchup only: per-eligible-row, the col index that matches the
    /// row's champ (or -1). Used to mask self-cells in `score_pools` so a
    /// pool member isn't graded as countering itself.
    mirror_col_for_row: Option<Vec<i32>>,
}

#[allow(clippy::too_many_arguments)]
fn build_z_subset(
    store: &DataStore,
    mode: &str,
    my_role: &str,
    other_role: &str,
    eligible: &[String],
    patch: Option<&str>,
    pr_floor: f32,
    shrink_alpha: f32,
) -> Option<ZSubset> {
    let pairs = if mode == "matchup" {
        &store.matchup
    } else {
        &store.synergy
    };
    let pair = pairs.get(my_role).and_then(|m| m.get(other_role))?;

    let mat = blend_pair(pair, shrink_alpha);
    let z_full = z_score_columns(&mat);

    let row_idx: HashMap<&str, usize> = pair
        .rows
        .iter()
        .enumerate()
        .map(|(i, ch)| (ch.as_str(), i))
        .collect();

    let pr_other = store.pr_for_role(other_role, patch);

    let keep_cols_idx: Vec<usize> = pair
        .cols
        .iter()
        .enumerate()
        .filter(|(_, c)| pr_other.get(c.as_str()).copied().unwrap_or(0.0) >= pr_floor)
        .map(|(i, _)| i)
        .collect();
    if keep_cols_idx.is_empty() {
        return None;
    }

    let col_pr: Vec<f32> = keep_cols_idx
        .iter()
        .map(|&i| pr_other.get(pair.cols[i].as_str()).copied().unwrap_or(0.0))
        .collect();

    let n_e = eligible.len();
    let n_cols_kept = keep_cols_idx.len();
    let mut z = Array2::<f32>::from_elem((n_e, n_cols_kept), f32::NAN);
    for (i, ch) in eligible.iter().enumerate() {
        if let Some(&r) = row_idx.get(ch.as_str()) {
            for (k, &c) in keep_cols_idx.iter().enumerate() {
                z[[i, k]] = z_full[[r, c]];
            }
        }
    }

    let mirror_col_for_row = if mode == "matchup" && my_role == other_role {
        let col_pos: HashMap<&str, usize> = keep_cols_idx
            .iter()
            .enumerate()
            .map(|(j, &c)| (pair.cols[c].as_str(), j))
            .collect();
        let mut m = vec![-1_i32; n_e];
        for (i, ch) in eligible.iter().enumerate() {
            if let Some(&j) = col_pos.get(ch.as_str()) {
                m[i] = j as i32;
            }
        }
        Some(m)
    } else {
        None
    };

    Some(ZSubset {
        z,
        col_pr,
        mirror_col_for_row,
    })
}

// ── per-pool top-X scoring ────────────────────────────────────────────────

/// For each top_x in [1..=pool_size], score every sampled pool against this
/// (mode, opp_role) z subset. Returns `out[top_x - 1] = Vec<f32>` of length K.
///
/// Mirrors `_score_pools` from `precompute_pool_distributions.py`:
///  * NaN cells (champ not in pair) and -inf (mirror self-mask) both excluded
///    from the per-column top-X.
///  * Per-column top-X mean → per-pool aggregate (mean, or PR-weighted nansum
///    when pr_weighted and col_pr.sum > 0).
fn score_pools(
    zs: &ZSubset,
    pool_idxs: &[Vec<usize>],
    pool_size: usize,
    pr_weighted: bool,
) -> Vec<Vec<f32>> {
    let n_cols = zs.z.ncols();
    let k = pool_idxs.len();

    let weights: Option<Vec<f32>> = if pr_weighted {
        let s: f32 = zs.col_pr.iter().sum();
        if s > 0.0 {
            Some(zs.col_pr.iter().map(|&w| w / s).collect())
        } else {
            None
        }
    } else {
        None
    };

    let mut out: Vec<Vec<f32>> = (0..pool_size).map(|_| vec![f32::NAN; k]).collect();

    // Per-pool scratch: pool_size × n_cols. Reuse across iterations.
    let mut pool_z = vec![0.0_f32; pool_size * n_cols];
    // Per-(top_x, col) running mean of finite values in top top_x rows.
    let mut per_col_mean = vec![f32::NAN; pool_size * n_cols];
    // Sorted column slice scratch.
    let mut col_sorted = vec![f32::NEG_INFINITY; pool_size];

    for (sample_k, pool_rows) in pool_idxs.iter().enumerate() {
        // Fill pool_z[i, j] = z[row, j], NaN → -inf so sort puts them at bottom.
        for (i, &row) in pool_rows.iter().enumerate() {
            for j in 0..n_cols {
                let v = zs.z[[row, j]];
                pool_z[i * n_cols + j] = if v.is_nan() { f32::NEG_INFINITY } else { v };
            }
        }
        // Mirror mask: self-cells become -inf so they're excluded from top-X.
        if let Some(mirror) = &zs.mirror_col_for_row {
            for (i, &row) in pool_rows.iter().enumerate() {
                let self_col = mirror[row];
                if self_col >= 0 {
                    pool_z[i * n_cols + self_col as usize] = f32::NEG_INFINITY;
                }
            }
        }

        // For each column: sort descending, then for each top_x compute the
        // mean of finite values among the first top_x.
        for j in 0..n_cols {
            for i in 0..pool_size {
                col_sorted[i] = pool_z[i * n_cols + j];
            }
            col_sorted.sort_by(|a, b| {
                b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal)
            });
            let mut sum = 0.0_f32;
            let mut count = 0_u32;
            for x in 0..pool_size {
                if col_sorted[x].is_finite() {
                    sum += col_sorted[x];
                    count += 1;
                }
                per_col_mean[x * n_cols + j] =
                    if count > 0 { sum / count as f32 } else { f32::NAN };
            }
        }

        // For each top_x, aggregate per-col means into a single scalar.
        for top_x_minus1 in 0..pool_size {
            let row = &per_col_mean[top_x_minus1 * n_cols..(top_x_minus1 + 1) * n_cols];
            let score = match &weights {
                Some(w) => {
                    // np.nansum(per_col * w) — NaN cells contribute 0.
                    let mut s = 0.0_f32;
                    for j in 0..n_cols {
                        if row[j].is_finite() {
                            s += row[j] * w[j];
                        }
                    }
                    s
                }
                None => {
                    let mut sum = 0.0_f32;
                    let mut count = 0_u32;
                    for &v in row.iter() {
                        if v.is_finite() {
                            sum += v;
                            count += 1;
                        }
                    }
                    if count > 0 {
                        sum / count as f32
                    } else {
                        f32::NAN
                    }
                }
            };
            out[top_x_minus1][sample_k] = score;
        }
    }
    out
}

// ── blindability scoring ──────────────────────────────────────────────────

fn build_blind_z_array(
    store: &DataStore,
    my_role: &str,
    eligible: &[String],
    patch: Option<&str>,
    pr_floor: f32,
    pr_weighted: bool,
    shrink_alpha: f32,
) -> Vec<f32> {
    let blind = blind_stats(store, my_role, patch, pr_floor, pr_weighted, shrink_alpha);
    let lookup = blind_z_lookup(&blind);
    eligible
        .iter()
        .map(|ch| lookup.get(ch).copied().unwrap_or(f32::NAN))
        .collect()
}

fn score_pools_blind(agg_z: &[f32], pool_idxs: &[Vec<usize>]) -> Vec<f32> {
    pool_idxs
        .iter()
        .map(|rows| {
            let mut sum = 0.0_f32;
            let mut count = 0_u32;
            for &r in rows.iter() {
                let v = agg_z[r];
                if v.is_finite() {
                    sum += v;
                    count += 1;
                }
            }
            if count > 0 {
                sum / count as f32
            } else {
                f32::NAN
            }
        })
        .collect()
}

// ── helpers ───────────────────────────────────────────────────────────────

/// Element-wise NaN-mean across the inner Vec<f32>'s. Returns vec of len `k`,
/// all NaN if `arrays` is empty (matches `np.nanmean(np.vstack([]), axis=0)` —
/// well, that errors in numpy, but the Python wrapper returns None and we
/// pass-through NaN for the same downstream effect).
fn stack_nanmean(arrays: &[Vec<f32>], k: usize) -> Vec<f32> {
    if arrays.is_empty() {
        return vec![f32::NAN; k];
    }
    let mut out = vec![f32::NAN; k];
    for i in 0..k {
        let mut sum = 0.0_f32;
        let mut count = 0_u32;
        for arr in arrays {
            let v = arr[i];
            if v.is_finite() {
                sum += v;
                count += 1;
            }
        }
        out[i] = if count > 0 {
            sum / count as f32
        } else {
            f32::NAN
        };
    }
    out
}

fn make_rng(req: &StrengthCurvesRequest, pool_size: usize) -> StdRng {
    let mut h = DefaultHasher::new();
    req.my_role.hash(&mut h);
    req.patch.as_deref().unwrap_or("").hash(&mut h);
    pool_size.hash(&mut h);
    ((req.pr_floor * 1.0e6) as u32).hash(&mut h);
    req.pr_weighted.hash(&mut h);
    ((req.shrink_alpha * 1000.0) as u32).hash(&mut h);
    StdRng::seed_from_u64(h.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn combinations_basic() {
        assert_eq!(saturating_combinations(5, 0), 1);
        assert_eq!(saturating_combinations(5, 5), 1);
        assert_eq!(saturating_combinations(5, 2), 10);
        // matches Python's math.comb(160, 8)
        assert_eq!(saturating_combinations(160, 8), 8_917_061_687_820);
    }

    #[test]
    fn enumerate_small() {
        let combos = enumerate_combinations(4, 2);
        assert_eq!(combos.len(), 6);
        assert!(combos.contains(&vec![0, 1]));
        assert!(combos.contains(&vec![2, 3]));
    }

    #[test]
    fn sample_pool_uses_exhaustive_when_small() {
        let mut rng = StdRng::seed_from_u64(0);
        let pools = sample_pool_indices(5, 2, 1000, &mut rng);
        assert_eq!(pools.len(), 10);
    }

    #[test]
    fn sample_pool_random_when_large() {
        let mut rng = StdRng::seed_from_u64(0);
        let pools = sample_pool_indices(50, 5, 100, &mut rng);
        assert_eq!(pools.len(), 100);
        for p in &pools {
            assert_eq!(p.len(), 5);
            // distinct indices
            let mut sorted = p.clone();
            sorted.sort();
            sorted.dedup();
            assert_eq!(sorted.len(), 5);
        }
    }

    #[test]
    fn score_pools_blind_skips_nan() {
        let agg_z = vec![1.0, f32::NAN, 3.0];
        let pools = vec![vec![0, 1, 2]];
        let s = score_pools_blind(&agg_z, &pools);
        assert!((s[0] - 2.0).abs() < 1e-6);
    }

    #[test]
    fn score_pools_top_x_unweighted() {
        // 3 eligible × 2 cols. Only one pool of all 3.
        let z = Array2::from_shape_vec((3, 2), vec![0.0, 1.0, 1.0, 2.0, 2.0, 3.0]).unwrap();
        let zs = ZSubset {
            z,
            col_pr: vec![0.5, 0.5],
            mirror_col_for_row: None,
        };
        let pools = vec![vec![0, 1, 2]];
        let scored = score_pools(&zs, &pools, 3, false);
        // top_x=1: per col best is 2 (col0) and 3 (col1), mean 2.5.
        assert!((scored[0][0] - 2.5).abs() < 1e-6);
        // top_x=3: per col mean is 1 and 2, overall 1.5.
        assert!((scored[2][0] - 1.5).abs() < 1e-6);
    }

    #[test]
    fn score_pools_mirror_self_mask() {
        // Pool member's self-col is masked. With pool=[0,1] and mirror[0]=0, mirror[1]=1:
        // col 0: rows [-inf, 1.0]   → top1 = 1.0
        // col 1: rows [1.0, -inf]   → top1 = 1.0
        // overall mean of cols = 1.0
        let z = Array2::from_shape_vec((2, 2), vec![1.0, 1.0, 1.0, 1.0]).unwrap();
        let zs = ZSubset {
            z,
            col_pr: vec![1.0, 1.0],
            mirror_col_for_row: Some(vec![0, 1]),
        };
        let pools = vec![vec![0, 1]];
        let scored = score_pools(&zs, &pools, 2, false);
        assert!((scored[0][0] - 1.0).abs() < 1e-6);
    }
}
