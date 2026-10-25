//! Shared domain types. Depends on no other fsc crate.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum RiskLevel {
    #[default]
    Low,
    Medium,
    High,
    Critical,
}

/// A unit of work handed to an agent. Mirrors `packages/core/src/task.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Task {
    #[serde(rename = "ID")]
    pub id: String,
    pub title: String,
    pub description: String,
    #[serde(default)]
    pub priority: u32,
    #[serde(default, rename = "riskLevel")]
    pub risk_level: RiskLevel,
}
