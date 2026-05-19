//! Champion-vs-champion correlation comparer — port of
//! `_reference_backend/comparer.champion_correlation`.
//!
//! For a selected (role, champion):
//! 1. Stack the per-(mode, pos) pp matrices into M_match (matchup) and
//!    M_syn (synergy), flat along the column axis.
//! 2. Pearson correlation of selected row vs every other row, twice
//!    (matchup-only, synergy-only). Total = mean of the two when both
//!    components exist, otherwise the available one.
//! 3. For each comparison champ B, pick top-3 columns where (sel, B) are
//!    Both Strong / Both Weak / Most Different (signed pp; not z-scored —
//!    matches the static explorer's convention).
//! 4. Look up B's aggregate blindability z from `blind_stats`.

use std::collections::HashMap;

use ndarray::{s, Array1, Array2, Axis};
use serde::{Deserialize, Serialize};

use super::blind::{blind_stats, blind_z_lookup};
use crate::data::{DataStore, ROLES};
use crate::ports::z_matrices;

#[derive(Deserialize)]
pub struct ComparerRequest {
    pub my_role: String,
    pub champion: String,
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
    0.01
}
fn default_alpha() -> f32 {
    1.0
}

#[derive(Serialize)]
pub struct DetailCell {
    pub block: String,
    pub ch_delta: f32,
    pub partner_delta: f32,
}

#[derive(Serialize)]
pub struct ComparerRow {
    pub champion: String,
    pub total: Option<f32>,
    pub matchup: Option<f32>,
    pub synergy: Option<f32>,
    pub blind_z: Option<f32>,
    pub strong: Vec<DetailCell>,
    pub weak: Vec<DetailCell>,
    pub disagree: Vec<DetailCell>,
}

#[derive(Serialize)]
pub struct ComparerInfo {
    pub games: i32,
    /// f64 so the rounded value (e.g. 51.36) round-trips through JSON without
    /// f32 precision noise like 51.360000610... showing up in the UI.
    pub win_rate: f64,
    pub pick_rate: f64,
    pub blind_z: Option<f32>,
}

#[derive(Serialize)]
pub struct ComparerResponse {
    pub champion: String,
    pub role: String,
    pub info: ComparerInfo,
    pub rows: Vec<ComparerRow>,
}

pub fn champion_correlation(
    store: &DataStore,
    req: &ComparerRequest,
) -> Option<ComparerResponse> {
    if !ROLES.contains(&req.my_role.as_str()) {
        return None;
    }
    let z_mats = z_matrices(
        store,
        &req.my_role,
        req.patch.as_deref(),
        req.pr_floor,
        req.shrink_alpha,
    );
    if z_mats.is_empty() {
        return None;
    }

    // All slabs share the same `rows` (champs at my_role, alphabetized).
    let first = match z_mats.values().next() {
        Some(s) => s,
        None => return None,
    };
    let rows: Vec<String> = first.rows.clone();
    let sel_idx = match rows.iter().position(|c| c == &req.champion) {
        Some(i) => i,
        None => return None,
    };

    // Collect matchup + synergy slabs in canonical (ROLES) order so
    // results are deterministic regardless of HashMap iteration order.
    let mut matchup_slabs: Vec<(&'static str, &Vec<String>, &Array2<f32>, Vec<f32>)> = Vec::new();
    let mut synergy_slabs: Vec<(&'static str, &Vec<String>, &Array2<f32>, Vec<f32>)> = Vec::new();
    for &pos in ROLES.iter() {
        for &mv in &["matchup", "synergy"] {
            let key = format!("{}_{}", mv, pos);
            let slab = match z_mats.get(&key) {
                Some(s) => s,
                None => continue,
            };
            let pr_pos = store.pr_for_role(pos, req.patch.as_deref());
            let weights: Vec<f32> = slab
                .cols
                .iter()
                .map(|c| pr_pos.get(c.as_str()).copied().unwrap_or(0.0))
                .collect();
            if mv == "matchup" {
                matchup_slabs.push((pos, &slab.cols, &slab.pp, weights));
            } else {
                synergy_slabs.push((pos, &slab.cols, &slab.pp, weights));
            }
        }
    }

    // Horizontally stack matchup and synergy pp matrices.
    let m_match = hstack(&matchup_slabs.iter().map(|s| s.2).collect::<Vec<_>>(), rows.len());
    let m_syn = hstack(&synergy_slabs.iter().map(|s| s.2).collect::<Vec<_>>(), rows.len());
    let w_match: Vec<f32> = matchup_slabs.iter().flat_map(|s| s.3.clone()).collect();
    let w_syn: Vec<f32> = synergy_slabs.iter().flat_map(|s| s.3.clone()).collect();

    // Block descriptors: ("vs", pos, col) for matchup, ("with", pos, col) for synergy.
    let mut blocks: Vec<(&'static str, &'static str, String)> = Vec::new();
    for (pos, cols, _, _) in &matchup_slabs {
        for c in cols.iter() {
            blocks.push(("vs", static_role_str(pos), c.clone()));
        }
    }
    for (pos, cols, _, _) in &synergy_slabs {
        for c in cols.iter() {
            blocks.push(("with", static_role_str(pos), c.clone()));
        }
    }

    let corr_match = if m_match.ncols() > 0 {
        weighted_corr_with_row(&m_match, sel_idx, if req.pr_weighted { Some(&w_match) } else { None })
    } else {
        vec![f32::NAN; rows.len()]
    };
    let corr_syn = if m_syn.ncols() > 0 {
        weighted_corr_with_row(&m_syn, sel_idx, if req.pr_weighted { Some(&w_syn) } else { None })
    } else {
        vec![f32::NAN; rows.len()]
    };
    let corr_total: Vec<f32> = corr_match
        .iter()
        .zip(corr_syn.iter())
        .map(|(&m, &s)| match (m.is_finite(), s.is_finite()) {
            (true, true) => (m + s) * 0.5,
            (true, false) => m,
            (false, true) => s,
            _ => f32::NAN,
        })
        .collect();

    // Concatenate matchup + synergy pp for the per-row strong/weak/disagree picks.
    let m_full = hstack(
        &[&m_match, &m_syn]
            .iter()
            .filter(|m| m.ncols() > 0)
            .copied()
            .collect::<Vec<_>>(),
        rows.len(),
    );
    let sel_vec: Array1<f32> = m_full.row(sel_idx).to_owned();
    let drop_self_per_col: Vec<&str> = blocks.iter().map(|b| b.2.as_str()).collect();

    // Blindability lookup
    let blind = blind_stats(
        store,
        &req.my_role,
        req.patch.as_deref(),
        req.pr_floor,
        req.pr_weighted,
        req.shrink_alpha,
    );
    let blind_z = blind_z_lookup(&blind);

    let mut rows_out: Vec<ComparerRow> = Vec::new();
    for (j, ch) in rows.iter().enumerate() {
        if ch == &req.champion {
            continue;
        }
        let ch_vec = m_full.row(j);
        let n_blocks = sel_vec.len();
        let self_mask: Vec<bool> = drop_self_per_col.iter().map(|s| s == ch).collect();

        let both_pos: Vec<usize> = (0..n_blocks)
            .filter(|&i| !self_mask[i] && sel_vec[i] > 0.0 && ch_vec[i] > 0.0)
            .collect();
        let both_neg: Vec<usize> = (0..n_blocks)
            .filter(|&i| !self_mask[i] && sel_vec[i] < 0.0 && ch_vec[i] < 0.0)
            .collect();
        let disagree_idx: Vec<usize> = (0..n_blocks)
            .filter(|&i| {
                !self_mask[i]
                    && ((sel_vec[i] > 0.0 && ch_vec[i] < 0.0)
                        || (sel_vec[i] < 0.0 && ch_vec[i] > 0.0))
            })
            .collect();

        let pack = |idxs: &[usize]| -> Vec<DetailCell> {
            idxs.iter()
                .map(|&i| {
                    let (sep, pos, col) = (&blocks[i].0, blocks[i].1, &blocks[i].2);
                    DetailCell {
                        block: format!("{} {}_{}", sep, pos, col),
                        ch_delta: round1(sel_vec[i]),
                        partner_delta: round1(ch_vec[i]),
                    }
                })
                .collect()
        };

        let mut strong = both_pos.clone();
        strong.sort_by(|&a, &b| {
            let sa = sel_vec[a].min(ch_vec[a]);
            let sb = sel_vec[b].min(ch_vec[b]);
            sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal)
        });
        strong.truncate(3);

        let mut weak = both_neg.clone();
        weak.sort_by(|&a, &b| {
            let sa = sel_vec[a].max(ch_vec[a]);
            let sb = sel_vec[b].max(ch_vec[b]);
            sa.partial_cmp(&sb).unwrap_or(std::cmp::Ordering::Equal)
        });
        weak.truncate(3);

        let mut disagree = disagree_idx.clone();
        disagree.sort_by(|&a, &b| {
            let da = (sel_vec[a] - ch_vec[a]).abs();
            let db = (sel_vec[b] - ch_vec[b]).abs();
            db.partial_cmp(&da).unwrap_or(std::cmp::Ordering::Equal)
        });
        disagree.truncate(3);

        let bz = blind_z.get(ch).copied();
        rows_out.push(ComparerRow {
            champion: ch.clone(),
            total: round3_opt(corr_total[j]),
            matchup: round3_opt(corr_match[j]),
            synergy: round3_opt(corr_syn[j]),
            blind_z: bz.and_then(|v| if v.is_finite() { Some(round3(v)) } else { None }),
            strong: pack(&strong),
            weak: pack(&weak),
            disagree: pack(&disagree),
        });
    }

    // Selected champion's headline info — uses cross-patch overall PR/WR
    // (from individual_wr.csv → pr_by_role / wr_by_role), matching the live
    // FastAPI's `comparer.py` which reads from `store.ind_wr` regardless of
    // the active patch. The comment in the Python source claims "patch's PR
    // table" but the code disagrees — code wins.
    let pick_rate = store
        .pr_by_role
        .get(&req.my_role)
        .and_then(|m| m.get(&req.champion))
        .copied()
        .unwrap_or(0.0);
    let win_rate = store
        .wr_by_role
        .get(&req.my_role)
        .and_then(|m| m.get(&req.champion))
        .copied()
        .unwrap_or(0.0);
    // Round in f64 to avoid f32-precision noise leaking through to JSON.
    let info = ComparerInfo {
        games: 0, // unused by frontend; keep field for response shape compat
        win_rate: round2_f64(win_rate as f64 * 100.0),
        pick_rate: round2_f64(pick_rate as f64 * 100.0),
        blind_z: blind_z
            .get(&req.champion)
            .copied()
            .and_then(|v| if v.is_finite() { Some(round3(v)) } else { None }),
    };

    Some(ComparerResponse {
        champion: req.champion.clone(),
        role: req.my_role.clone(),
        info,
        rows: rows_out,
    })
}

fn static_role_str(s: &'static str) -> &'static str {
    s
}

fn round1(v: f32) -> f32 {
    (v * 10.0).round() / 10.0
}
fn round2_f64(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}
fn round3(v: f32) -> f32 {
    (v * 1000.0).round() / 1000.0
}
fn round3_opt(v: f32) -> Option<f32> {
    if v.is_finite() {
        Some(round3(v))
    } else {
        None
    }
}

fn hstack(slabs: &[&Array2<f32>], n_rows: usize) -> Array2<f32> {
    let total_cols: usize = slabs.iter().map(|m| m.ncols()).sum();
    if total_cols == 0 {
        return Array2::<f32>::zeros((n_rows, 0));
    }
    let mut out = Array2::<f32>::zeros((n_rows, total_cols));
    let mut offset = 0;
    for slab in slabs {
        let nc = slab.ncols();
        if nc == 0 {
            continue;
        }
        out.slice_mut(s![.., offset..offset + nc]).assign(*slab);
        offset += nc;
    }
    out
}

fn weighted_corr_with_row(
    m: &Array2<f32>,
    sel_idx: usize,
    weights: Option<&[f32]>,
) -> Vec<f32> {
    let (n_rows, n_cols) = m.dim();
    if n_cols < 2 {
        return vec![f32::NAN; n_rows];
    }

    if weights.is_none() {
        // Unweighted Pearson — center each row, divide by row-norm, dot vs sel row.
        let mut row_mean = vec![0.0_f32; n_rows];
        for r in 0..n_rows {
            row_mean[r] = m.row(r).sum() / n_cols as f32;
        }
        let mut row_norm = vec![0.0_f32; n_rows];
        let mut mc = Array2::<f32>::zeros((n_rows, n_cols));
        for r in 0..n_rows {
            let mu = row_mean[r];
            let mut sq = 0.0_f32;
            for c in 0..n_cols {
                let v = m[[r, c]] - mu;
                mc[[r, c]] = v;
                sq += v * v;
            }
            row_norm[r] = sq.sqrt();
        }
        let sel_norm = row_norm[sel_idx];
        if sel_norm == 0.0 {
            return vec![f32::NAN; n_rows];
        }
        let sel_row = mc.row(sel_idx).to_owned();
        let mut out = vec![f32::NAN; n_rows];
        for r in 0..n_rows {
            if row_norm[r] == 0.0 {
                continue;
            }
            let mut dot = 0.0_f32;
            for c in 0..n_cols {
                dot += mc[[r, c]] * sel_row[c];
            }
            out[r] = dot / row_norm[r] / sel_norm;
        }
        return out;
    }

    let w = match weights {
        Some(w) => w,
        None => return vec![f32::NAN; n_rows],
    };
    let sw: f32 = w.iter().sum();
    if sw <= 0.0 {
        return vec![f32::NAN; n_rows];
    }
    let mut row_mean = vec![0.0_f32; n_rows];
    for r in 0..n_rows {
        let mut s = 0.0_f32;
        for c in 0..n_cols {
            s += m[[r, c]] * w[c];
        }
        row_mean[r] = s / sw;
    }
    let mut mc = Array2::<f32>::zeros((n_rows, n_cols));
    let mut row_var = vec![0.0_f32; n_rows];
    for r in 0..n_rows {
        let mu = row_mean[r];
        let mut v = 0.0_f32;
        for c in 0..n_cols {
            let d = m[[r, c]] - mu;
            mc[[r, c]] = d;
            v += w[c] * d * d;
        }
        row_var[r] = v / sw;
    }
    let row_sd: Vec<f32> = row_var
        .iter()
        .map(|&v| if v > 0.0 { v.sqrt() } else { f32::NAN })
        .collect();
    let sel_sd = row_sd[sel_idx];
    if !sel_sd.is_finite() || sel_sd == 0.0 {
        return vec![f32::NAN; n_rows];
    }
    let sel_row = mc.row(sel_idx).to_owned();
    let mut out = vec![f32::NAN; n_rows];
    for r in 0..n_rows {
        let sd = row_sd[r];
        if !sd.is_finite() || sd == 0.0 {
            continue;
        }
        let mut cov = 0.0_f32;
        for c in 0..n_cols {
            cov += mc[[r, c]] * w[c] * sel_row[c];
        }
        cov /= sw;
        out[r] = cov / (sd * sel_sd);
    }
    out
}
