//! `#[serde(default = "...")]` helpers.
//!
//! Serde requires a free function path; we keep these one-liners here so
//! every endpoint references the same value via [`crate::util::consts`].

use super::consts;

pub fn pr_floor_default() -> f32 {
    consts::PR_FLOOR_DEFAULT
}
pub fn pr_floor_blind() -> f32 {
    consts::PR_FLOOR_BLIND
}
pub fn pr_floor_comparer() -> f32 {
    consts::PR_FLOOR_COMPARER
}
pub fn alpha() -> f32 {
    consts::ALPHA_DEFAULT
}
pub fn top_x() -> usize {
    consts::TOP_X_DEFAULT
}
pub fn one_f32() -> f32 {
    1.0
}
