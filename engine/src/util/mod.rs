//! Shared crate-internal utilities (math, named constants, serde defaults).
//!
//! These helpers used to be duplicated across `endpoints/*.rs`. Centralising
//! them keeps thresholds and rounding behaviour in one place.

pub mod consts;
pub mod defaults;
pub mod math;
