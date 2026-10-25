use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use fsc_core::{RiskLevel, Task};
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::coupling::expand_with_coupling;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionContract {
    pub task_id: String,
    pub allowed_paths: Vec<String>,
    pub soft_allowed_paths: Vec<String>,
    pub excluded_paths: Vec<String>,
    pub protected_paths: Vec<String>,
    pub max_files_changed: usize,
    pub generated_at: u64,
    pub generated_by: String,
}

const DEFAULT_PROTECTED: &[&str] = &[
    ".env",
    ".env.*",
    "package-lock.json",
    "bun.lockb",
    "yarn.lock",
    "pnpm-lock.yaml",
    "*.pem",
    "*.key",
    "*.cert",
];

/// Order matters: hints are emitted in this order.
const KEYWORD_PATH_MAP: &[(&str, &[&str])] = &[
    ("execution", &["packages/core/src/execution/**"]),
    (
        "scheduler",
        &[
            "packages/core/src/execution/scheduler.ts",
            "packages/core/src/execution/**",
        ],
    ),
    (
        "agent",
        &[
            "packages/core/src/execution/**",
            "packages/core/src/modelRouter.ts",
        ],
    ),
    (
        "commit",
        &[
            "packages/core/src/codeCommitter.ts",
            "packages/core/src/execution/sequencer.ts",
        ],
    ),
    (
        "task",
        &[
            "packages/core/src/task.ts",
            "packages/core/src/taskSolver*.ts",
        ],
    ),
    ("config", &["packages/core/src/config*.ts"]),
    ("test", &["packages/core/tests/**", "tests/**"]),
    ("docker", &["packages/core/src/dockerInstance.ts"]),
    ("cli", &["packages/cli/**"]),
    ("prompt", &["packages/core/src/prompts/**"]),
    (
        "worktree",
        &[
            "packages/core/src/execution/worktree.ts",
            "packages/core/src/execution/pool.ts",
        ],
    ),
    ("quality", &["packages/core/src/codeCommitter.ts"]),
    ("trust", &["packages/core/src/codeCommitter.ts"]),
    (
        "style",
        &[
            "packages/core/src/codingStyle.ts",
            "packages/core/src/workStyle.ts",
        ],
    ),
    ("rag", &["packages/core/src/codeRAG.ts"]),
    (
        "distributed",
        &["packages/core/src/distributedScheduler.ts"],
    ),
    ("docs", &["README.md", "docs/**"]),
    ("readme", &["README.md"]),
    ("document", &["README.md", "docs/**"]),
];

const ALWAYS_ALLOWED: &[&str] = &[
    "packages/core/src/index.ts",
    "packages/core/test/**",
    "packages/*/test/**",
    "tests/**",
    ".gitignore",
];

#[derive(Debug, Clone, Default)]
pub struct GenerateOptions {
    /// Enables co-change coupling when set.
    pub repo_path: Option<PathBuf>,
    pub coupling_days: Option<u32>,
}

fn extract_path_hints(text: &str) -> Vec<String> {
    let quoted = Regex::new(r#"['"`]([a-zA-Z0-9_./-]+\.[a-zA-Z]+)['"`]"#).expect("static regex");
    let slashed =
        Regex::new(r"\b([a-zA-Z0-9_-]+(?:/[a-zA-Z0-9_.-]+){2,})\b").expect("static regex");
    let mut hints: Vec<String> = quoted
        .captures_iter(text)
        .map(|c| c[1].to_string())
        .collect();
    for c in slashed.captures_iter(text) {
        let h = c[1].to_string();
        if !hints.contains(&h) {
            hints.push(h);
        }
    }
    let lower = text.to_lowercase();
    for (keyword, paths) in KEYWORD_PATH_MAP {
        if lower.contains(keyword) {
            for p in *paths {
                if !hints.iter().any(|h| h == p) {
                    hints.push((*p).to_string());
                }
            }
        }
    }
    hints
}

fn max_files_for_risk(risk: RiskLevel) -> usize {
    match risk {
        RiskLevel::Critical => 30,
        RiskLevel::High => 20,
        RiskLevel::Medium => 10,
        RiskLevel::Low => 5,
    }
}

pub fn generate_contract(task: &Task, options: &GenerateOptions) -> ExecutionContract {
    let hints = extract_path_hints(&format!("{} {}", task.title, task.description));
    let mut allowed: Vec<String> = ALWAYS_ALLOWED.iter().map(|s| (*s).to_string()).collect();
    if hints.is_empty() {
        allowed.push("packages/core/src/**".into());
    } else {
        allowed.extend(hints.iter().cloned());
    }

    let mut soft: Vec<String> = vec![];
    if let Some(repo) = &options.repo_path {
        let core: Vec<String> = hints.iter().filter(|h| !h.contains('*')).cloned().collect();
        soft = expand_with_coupling(&core, repo, options.coupling_days.unwrap_or(90));
    }

    let mut sibling_dirs: Vec<String> = vec![];
    for f in hints.iter().filter(|h| !h.contains('*') && h.contains('/')) {
        let dir = &f[..f.rfind('/').expect("contains '/'")];
        if !dir.is_empty() && !sibling_dirs.iter().any(|d| d == dir) {
            sibling_dirs.push(dir.to_string());
            let pattern = format!("{dir}/**");
            if !allowed.contains(&pattern) && !soft.contains(&pattern) {
                soft.push(pattern);
            }
        }
    }

    ExecutionContract {
        task_id: task.id.clone(),
        allowed_paths: allowed,
        soft_allowed_paths: soft,
        excluded_paths: ["node_modules/**", ".git/**", "dist/**", ".fsc/**"]
            .map(String::from)
            .to_vec(),
        protected_paths: DEFAULT_PROTECTED.iter().map(|s| (*s).to_string()).collect(),
        max_files_changed: max_files_for_risk(task.risk_level),
        generated_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
        generated_by: "heuristic".into(),
    }
}

pub fn contract_to_prompt_suffix(c: &ExecutionContract) -> String {
    [
        "\n\n## Scope Contract (enforced)".to_string(),
        format!("- Allowed paths: {}", c.allowed_paths.join(", ")),
        format!("- Do NOT modify: {}", c.excluded_paths.join(", ")),
        format!(
            "- PROTECTED (will cause rejection): {}",
            c.protected_paths.join(", ")
        ),
        format!("- Max files to change: {}", c.max_files_changed),
    ]
    .join("\n")
}
