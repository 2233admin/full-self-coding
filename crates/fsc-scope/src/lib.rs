//! Scope contracts, drift scoring and co-change coupling (port of `packages/core/src/salacia`).

pub mod contract;
pub mod coupling;
pub mod drift;
pub mod glob;

pub use contract::{
    contract_to_prompt_suffix, generate_contract, ExecutionContract, GenerateOptions,
};
pub use coupling::{co_changed_files, expand_with_coupling, CoChangeEntry};
pub use drift::{detect_drift, exceeds_threshold, is_fatal_drift, DriftReport};
