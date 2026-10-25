use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::conflict::{has_contentful_canonical, parse_conflict_markers, resolve_keep_incoming};
use crate::git::git;

/// One finished task whose commit should land on the target branch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeInput {
    pub work_unit_id: String,
    pub commit_hash: Option<String>,
    pub branch: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SequencerResult {
    pub task_id: String,
    pub success: bool,
    pub commit_hash: Option<String>,
    pub error: Option<String>,
    /// Tier that produced the merge (1 clean, 2 keep-incoming); `None` when nothing was merged.
    pub resolved_tier: Option<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MergeHistoryEntry {
    pub tier: u8,
    pub success: bool,
    pub timestamp: u64,
}

pub type MergeHistory = BTreeMap<String, Vec<MergeHistoryEntry>>;

const HISTORY_PER_FILE: usize = 20;

/// Cherry-picks task commits one by one onto the target branch.
///
/// Tier 1: clean cherry-pick. Tier 2: keep the incoming side, only if the target side of every
/// conflict is blank. Tiers 3 (AI resolve) and 4 (rewrite) are not implemented, as in the TS
/// reference: a conflict that tier 2 cannot resolve aborts the cherry-pick and is reported.
pub struct CommitSequencer {
    repo: PathBuf,
    target_branch: String,
    results: Vec<SequencerResult>,
    history_path: PathBuf,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl CommitSequencer {
    pub fn new(repo: impl Into<PathBuf>, target_branch: impl Into<String>) -> Self {
        let repo = repo.into();
        let history_path = repo.join(".fsc").join("merge-history.json");
        Self {
            repo,
            target_branch: target_branch.into(),
            results: vec![],
            history_path,
        }
    }

    pub fn results(&self) -> &[SequencerResult] {
        &self.results
    }

    fn push(&mut self, r: SequencerResult) -> SequencerResult {
        self.results.push(r.clone());
        r
    }

    /// Cherry-pick one task commit onto the target branch.
    pub fn apply(&mut self, input: &MergeInput) -> SequencerResult {
        let id = input.work_unit_id.clone();
        let fail = |hash: Option<String>, error: String| SequencerResult {
            task_id: id.clone(),
            success: false,
            commit_hash: hash,
            error: Some(error),
            resolved_tier: None,
        };

        let Some(hash) = input.commit_hash.clone() else {
            return self.push(SequencerResult {
                task_id: id,
                success: true,
                commit_hash: None,
                error: Some("no changes".into()),
                resolved_tier: None,
            });
        };

        match self.pre_merge_check(&hash) {
            PreMerge::Ok => {}
            PreMerge::AlreadyMerged => {
                return self.push(SequencerResult {
                    task_id: id,
                    success: true,
                    commit_hash: Some(hash),
                    error: Some("already merged".into()),
                    resolved_tier: None,
                });
            }
            PreMerge::Blocked(msg) => return self.push(fail(None, msg)),
        }

        git(&["checkout", &self.target_branch], &self.repo);

        // Tier 1: clean cherry-pick.
        let pick = git(&["cherry-pick", &hash], &self.repo);
        if pick.ok() {
            let new_hash = self.head();
            return self.push(SequencerResult {
                task_id: id,
                success: true,
                commit_hash: Some(new_hash),
                error: None,
                resolved_tier: Some(1),
            });
        }

        let conflicts = self.conflicted_files();
        if conflicts.is_empty() {
            git(&["cherry-pick", "--abort"], &self.repo);
            let msg: String = pick.stderr.chars().take(200).collect();
            return self.push(fail(
                Some(hash),
                format!("cherry-pick failed (not a conflict): {msg}"),
            ));
        }

        // Tier 2: keep incoming, guarded by "canonical side is blank".
        let blockers = self.tier2_keep_incoming(&conflicts);
        if blockers.is_empty() {
            git(&["add", "-A"], &self.repo);
            git(&["cherry-pick", "--continue", "--no-edit"], &self.repo);
            let new_hash = self.head();
            self.record_history(&conflicts, 2, true);
            return self.push(SequencerResult {
                task_id: id,
                success: true,
                commit_hash: Some(new_hash),
                error: None,
                resolved_tier: Some(2),
            });
        }

        self.record_history(&conflicts, 2, false);
        git(&["cherry-pick", "--abort"], &self.repo);
        self.push(fail(
            Some(hash),
            format!("MERGE_CONFLICT (tier2 blocked): {}", blockers.join(", ")),
        ))
    }

    /// Apply every input that has a commit, ordered by work-unit id.
    pub fn apply_all(&mut self, inputs: &[MergeInput]) -> Vec<SequencerResult> {
        let mut sorted: Vec<&MergeInput> =
            inputs.iter().filter(|r| r.commit_hash.is_some()).collect();
        sorted.sort_by(|a, b| a.work_unit_id.cmp(&b.work_unit_id));
        sorted.into_iter().map(|r| self.apply(r)).collect()
    }

    /// Lowest tier worth trying for `file`: a tier is skipped once it failed at least twice
    /// and never succeeded.
    pub fn effective_start_tier(&self, file: &str) -> u8 {
        let history = self.load_history();
        let Some(entries) = history.get(file).filter(|e| !e.is_empty()) else {
            return 1;
        };
        for tier in 1..=4u8 {
            let of_tier = entries.iter().filter(|e| e.tier == tier);
            let successes = of_tier.clone().filter(|e| e.success).count();
            let failures = of_tier.filter(|e| !e.success).count();
            if failures >= 2 && successes == 0 {
                continue;
            }
            return tier;
        }
        4
    }

    /// Human-readable recovery steps for a conflict the sequencer could not resolve.
    pub fn conflict_guide(&self, task_id: &str, commit_hash: &str, branch: &str) -> String {
        [
            String::new(),
            format!("MERGE CONFLICT: {task_id}"),
            "  To resolve:".into(),
            format!("    cd {}", self.repo.display()),
            format!("    git cherry-pick {commit_hash}"),
            "    # fix conflicts".into(),
            "    git add -A && git cherry-pick --continue".into(),
            "  To skip:".into(),
            "    git cherry-pick --abort".into(),
            "  To review:".into(),
            format!("    git diff {}...{branch}", self.target_branch),
            String::new(),
        ]
        .join("\n")
    }

    fn head(&self) -> String {
        git(&["rev-parse", "HEAD"], &self.repo)
            .stdout
            .trim()
            .to_string()
    }

    fn conflicted_files(&self) -> Vec<String> {
        git(&["diff", "--name-only", "--diff-filter=U"], &self.repo)
            .stdout
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(String::from)
            .collect()
    }

    /// Returns the files that block tier 2 (target side has real content).
    fn tier2_keep_incoming(&self, files: &[String]) -> Vec<String> {
        let mut blockers = vec![];
        for file in files {
            let path = self.repo.join(file);
            let Ok(content) = fs::read_to_string(&path) else {
                continue;
            };
            if parse_conflict_markers(&content)
                .iter()
                .any(has_contentful_canonical)
            {
                blockers.push(file.clone());
                continue;
            }
            // Best effort, as in the reference: a failed write leaves markers, which the
            // continue step would then commit; the caller verifies via the returned hash.
            let _ = fs::write(&path, resolve_keep_incoming(&content));
        }
        blockers
    }

    fn pre_merge_check(&self, hash: &str) -> PreMerge {
        // Only tracked changes make the tree dirty: untracked files (logs, `.fsc/` state) do not
        // block a cherry-pick, and git itself refuses if one would be overwritten.
        let status = git(
            &[
                "status",
                "--porcelain",
                "--untracked-files=no",
                "--",
                ".",
                ":(exclude).fsc",
            ],
            &self.repo,
        );
        if !status.stdout.trim().is_empty() {
            return PreMerge::Blocked("working tree is dirty".into());
        }
        if !git(&["cat-file", "-t", hash], &self.repo).ok() {
            return PreMerge::Blocked(format!("commit {hash} does not exist"));
        }
        if git(&["merge-base", "--is-ancestor", hash, "HEAD"], &self.repo).ok() {
            return PreMerge::AlreadyMerged;
        }
        PreMerge::Ok
    }

    fn load_history(&self) -> MergeHistory {
        fs::read_to_string(&self.history_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn record_history(&self, files: &[String], tier: u8, success: bool) {
        let mut history = self.load_history();
        let entry = MergeHistoryEntry {
            tier,
            success,
            timestamp: now_ms(),
        };
        for file in files {
            let list = history.entry(file.clone()).or_default();
            list.push(entry.clone());
            if list.len() > HISTORY_PER_FILE {
                let drop = list.len() - HISTORY_PER_FILE;
                list.drain(..drop);
            }
        }
        self.save_history(&history);
    }

    fn save_history(&self, history: &MergeHistory) {
        if let Some(dir) = self.history_path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(history) {
            let _ = fs::write(&self.history_path, json);
        }
    }

    pub fn repo(&self) -> &Path {
        &self.repo
    }
}

enum PreMerge {
    Ok,
    AlreadyMerged,
    Blocked(String),
}
