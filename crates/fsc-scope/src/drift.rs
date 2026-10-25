use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::contract::ExecutionContract;
use crate::glob::matches_any;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriftReport {
    pub task_id: String,
    pub score: u32,
    pub in_scope_files: Vec<String>,
    pub soft_scope_files: Vec<String>,
    pub out_of_scope_files: Vec<String>,
    pub protected_violations: Vec<String>,
    pub excess_files: usize,
    pub fingerprints: BTreeMap<String, String>,
}

const OUT_OF_SCOPE: u32 = 5;
const PROTECTED: u32 = 40;
const EXCESS: u32 = 2;

fn sha256_file(path: &Path) -> String {
    match fs::read(path) {
        Ok(bytes) => Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
        Err(_) => String::new(),
    }
}

/// Classify each changed file and score the result:
/// out-of-scope +5, protected +40, +2 per file beyond `max_files_changed`.
pub fn detect_drift(
    contract: &ExecutionContract,
    files_changed: &[String],
    worktree: &Path,
) -> DriftReport {
    let mut rep = DriftReport {
        task_id: contract.task_id.clone(),
        score: 0,
        in_scope_files: vec![],
        soft_scope_files: vec![],
        out_of_scope_files: vec![],
        protected_violations: vec![],
        excess_files: 0,
        fingerprints: BTreeMap::new(),
    };
    for file in files_changed {
        rep.fingerprints
            .insert(file.clone(), sha256_file(&worktree.join(file)));
        if matches_any(file, &contract.protected_paths) {
            rep.protected_violations.push(file.clone());
        } else if matches_any(file, &contract.excluded_paths) {
            rep.out_of_scope_files.push(file.clone());
        } else if contract.allowed_paths.is_empty() || matches_any(file, &contract.allowed_paths) {
            rep.in_scope_files.push(file.clone());
        } else if matches_any(file, &contract.soft_allowed_paths) {
            rep.soft_scope_files.push(file.clone());
        } else {
            rep.out_of_scope_files.push(file.clone());
        }
    }
    rep.excess_files = files_changed
        .len()
        .saturating_sub(contract.max_files_changed);
    rep.score = rep.out_of_scope_files.len() as u32 * OUT_OF_SCOPE
        + rep.protected_violations.len() as u32 * PROTECTED
        + rep.excess_files as u32 * EXCESS;
    rep
}

pub fn is_fatal_drift(report: &DriftReport) -> bool {
    !report.protected_violations.is_empty()
}

pub fn exceeds_threshold(report: &DriftReport, threshold: u32) -> bool {
    report.score >= threshold
}
