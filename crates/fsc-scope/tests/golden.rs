//! Golden tests: the Rust port must reproduce the TypeScript salacia outputs exactly.
//! Regenerate fixtures with `bun script/gen-golden.ts` (only when the TS reference changes on purpose).

use std::path::PathBuf;

use fsc_core::Task;
use fsc_scope::{detect_drift, generate_contract, DriftReport, ExecutionContract, GenerateOptions};
use serde::Deserialize;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests")
}

fn load<T: for<'de> Deserialize<'de>>(name: &str) -> T {
    let s = std::fs::read_to_string(dir().join("golden").join(name)).expect("golden file");
    serde_json::from_str(&s).expect("golden json")
}

#[derive(Deserialize)]
struct DriftCase {
    contract: ExecutionContract,
    files: Vec<String>,
    expected: DriftReport,
}

#[test]
fn drift_matches_typescript() {
    let cases: Vec<DriftCase> = load("drift.json");
    assert!(!cases.is_empty());
    let wt = dir().join("fixtures").join("wt");
    for (i, c) in cases.iter().enumerate() {
        let got = detect_drift(&c.contract, &c.files, &wt);
        assert_eq!(got, c.expected, "drift case {i}: {:?}", c.files);
    }
}

#[derive(Deserialize)]
struct ContractCase {
    task: Task,
    expected: Expected,
}

#[derive(Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Expected {
    task_id: String,
    allowed_paths: Vec<String>,
    soft_allowed_paths: Vec<String>,
    excluded_paths: Vec<String>,
    protected_paths: Vec<String>,
    max_files_changed: usize,
    generated_by: String,
}

#[test]
fn contract_matches_typescript() {
    let cases: Vec<ContractCase> = load("contract.json");
    assert!(!cases.is_empty());
    for c in &cases {
        let g = generate_contract(&c.task, &GenerateOptions::default());
        let got = Expected {
            task_id: g.task_id,
            allowed_paths: g.allowed_paths,
            soft_allowed_paths: g.soft_allowed_paths,
            excluded_paths: g.excluded_paths,
            protected_paths: g.protected_paths,
            max_files_changed: g.max_files_changed,
            generated_by: g.generated_by,
        };
        assert_eq!(got, c.expected, "contract for task {}", c.task.id);
    }
}
