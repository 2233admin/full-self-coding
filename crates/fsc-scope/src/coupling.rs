//! Co-change coupling mined from `git log` (commit-prophet algorithm).

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoChangeEntry {
    pub file: String,
    pub coupling: f64,
    pub co_changes: usize,
}

fn git(repo: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

fn lines(s: &str) -> Vec<&str> {
    s.lines().map(str::trim).filter(|l| !l.is_empty()).collect()
}

/// coupling(A,B) = co_changes(A,B) / max(changes(A), changes(B)); keep >= min_coupling and >= min_co_changes.
pub fn co_changed_files_with(
    file: &str,
    repo: &Path,
    days: u32,
    min_coupling: f64,
    min_co_changes: usize,
) -> Vec<CoChangeEntry> {
    let since = format!("--since={days}.days.ago");
    let Some(hashes_out) = git(repo, &["log", "--format=%H", &since, "--", file]) else {
        return vec![];
    };
    let hashes = lines(&hashes_out);
    if hashes.is_empty() {
        return vec![];
    }
    let total_a = hashes.len();

    let mut co_count: HashMap<String, usize> = HashMap::new();
    for h in &hashes {
        let Some(out) = git(
            repo,
            &["diff-tree", "--no-commit-id", "--name-only", "-r", h],
        ) else {
            continue;
        };
        for f in lines(&out) {
            if f != file {
                *co_count.entry(f.to_string()).or_default() += 1;
            }
        }
    }

    let mut results = vec![];
    for (f, co) in co_count {
        if co < min_co_changes {
            continue;
        }
        let total_b = git(repo, &["rev-list", "--count", &since, "HEAD", "--", &f])
            .and_then(|s| s.trim().parse::<usize>().ok())
            .filter(|n| *n > 0)
            .unwrap_or(1);
        let coupling = co as f64 / total_a.max(total_b) as f64;
        if coupling >= min_coupling {
            results.push(CoChangeEntry {
                file: f,
                coupling: (coupling * 1000.0).round() / 1000.0,
                co_changes: co,
            });
        }
    }
    results.sort_by(|a, b| {
        b.coupling
            .total_cmp(&a.coupling)
            .then_with(|| a.file.cmp(&b.file))
    });
    results
}

pub fn co_changed_files(file: &str, repo: &Path, days: u32) -> Vec<CoChangeEntry> {
    co_changed_files_with(file, repo, days, 0.3, 3)
}

/// Companions of `core_files` that are not already in the set, strongest first per file.
pub fn expand_with_coupling(core_files: &[String], repo: &Path, days: u32) -> Vec<String> {
    let mut seen: Vec<String> = core_files.to_vec();
    let mut expanded = vec![];
    for f in core_files {
        for c in co_changed_files(f, repo, days) {
            if !seen.contains(&c.file) {
                seen.push(c.file.clone());
                expanded.push(c.file);
            }
        }
    }
    expanded
}
