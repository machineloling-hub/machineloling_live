//! Tiny numeric helpers used by multiple endpoints.
//!
//! Each function previously had 2-3 copy/pasted definitions across
//! `endpoints/*.rs`; they're consolidated here. Behaviour is identical to the
//! originals (verified by inspection): NaN/infinite values are skipped, an
//! empty input returns `NaN` (or `None` for the `_or_none` variant).

/// Round to one decimal place.
pub fn round1(v: f32) -> f32 {
    (v * 10.0).round() / 10.0
}

/// Round to three decimal places.
pub fn round3(v: f32) -> f32 {
    (v * 1000.0).round() / 1000.0
}

/// Round to two decimal places (f64 variant used by comparer).
pub fn round2_f64(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

/// Round to three decimal places, returning `None` for non-finite input.
pub fn round3_opt(v: f32) -> Option<f32> {
    if v.is_finite() {
        Some(round3(v))
    } else {
        None
    }
}

/// Mean of finite values in `values`. Returns `NaN` if none are finite.
pub fn mean_finite(values: &[f32]) -> f32 {
    let (sum, count) = values
        .iter()
        .filter(|v| v.is_finite())
        .fold((0.0_f32, 0_usize), |(s, c), &v| (s + v, c + 1));
    if count > 0 {
        sum / count as f32
    } else {
        f32::NAN
    }
}

/// Mean of finite `Some(_)` values. Returns `NaN` if none are finite.
pub fn mean_finite_opt(values: &[Option<f32>]) -> f32 {
    let (sum, count) = values.iter().fold((0.0_f32, 0_usize), |(s, c), v| match v {
        Some(x) if x.is_finite() => (s + *x, c + 1),
        _ => (s, c),
    });
    if count > 0 {
        sum / count as f32
    } else {
        f32::NAN
    }
}

/// Simple arithmetic mean of `x`. Returns `None` on empty input. Does **not**
/// filter non-finite values — callers that need that should use [`mean_finite`].
pub fn mean_or_none(x: &[f32]) -> Option<f32> {
    if x.is_empty() {
        None
    } else {
        Some(x.iter().sum::<f32>() / x.len() as f32)
    }
}

/// Weighted mean of finite values. Caller supplies `w_sum` (pre-computed).
pub fn weighted_mean(values: &[f32], weights: &[f32], w_sum: f32) -> f32 {
    let s: f32 = values
        .iter()
        .zip(weights.iter())
        .filter(|(v, _)| v.is_finite())
        .map(|(v, w)| v * w)
        .sum();
    s / w_sum
}

/// Weighted mean over `Option<f32>` values (skips `None` and non-finite).
pub fn weighted_mean_opt(values: &[Option<f32>], weights: &[f32], w_sum: f32) -> f32 {
    let s: f32 = values
        .iter()
        .zip(weights.iter())
        .filter_map(|(v, w)| v.and_then(|x| if x.is_finite() { Some(x * w) } else { None }))
        .sum();
    s / w_sum
}
