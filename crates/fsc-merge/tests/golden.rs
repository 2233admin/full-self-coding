//! Golden tests: the Rust sequencer must produce the same outcomes as the TypeScript one on
//! real git repositories. Regenerate with `bun script/gen-merge-golden.ts` (only when the TS
//! reference changes on purpose).

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use fsc_merge::git::git;
use fsc_merge::{CommitSequencer, MergeInput, SequencerResult};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct Scenario {
    name: String,
    target: String,
    #[serde(default)]
    mode: String,
    steps: Vec<Value>,
    applies: Vec<Apply>,
    #[serde(default)]
    inspect: Vec<String>,
    #[serde(default)]
    history_files: Vec<String>,
    #[serde(default)]
    start_tier_files: Vec<String>,
    expected: Expected,
}

#[derive(Deserialize)]
struct Apply {
    id: String,
    hash: Option<String>,
    branch: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Expected {
    results: Vec<ExpectedResult>,
    files: BTreeMap<String, Option<String>>,
    history: BTreeMap<String, Vec<HistEntry>>,
    start_tiers: BTreeMap<String, u8>,
    porcelain_clean: bool,
    cherry_pick_in_progress: bool,
}

#[derive(Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ExpectedResult {
    task_id: String,
    success: bool,
    resolved_tier: Option<u8>,
    error: Option<String>,
    has_commit_hash: bool,
}

#[derive(Deserialize, Debug, PartialEq)]
struct HistEntry {
    tier: u8,
    success: bool,
}

fn sub(s: &str, vars: &BTreeMap<String, String>) -> String {
    let mut out = s.to_string();
    for (k, v) in vars {
        out = out.replace(&format!("${{{k}}}"), v);
    }
    out
}

fn run(repo: &Path, args: &[String]) -> String {
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let o = git(&refs, repo);
    assert!(o.ok(), "git {args:?} failed: {}", o.stderr);
    o.stdout
}

fn normalize(err: &str) -> String {
    let mut out = String::new();
    let mut run_len = 0;
    let mut buf = String::new();
    for c in err.chars() {
        if c.is_ascii_hexdigit() && c.is_ascii_lowercase() || c.is_ascii_digit() {
            run_len += 1;
            buf.push(c);
            continue;
        }
        flush(&mut out, &mut buf, &mut run_len);
        out.push(c);
    }
    flush(&mut out, &mut buf, &mut run_len);
    out
}

fn flush(out: &mut String, buf: &mut String, run_len: &mut usize) {
    if *run_len == 40 {
        out.push_str("<hash>");
    } else {
        out.push_str(buf);
    }
    buf.clear();
    *run_len = 0;
}

#[test]
fn sequencer_matches_typescript() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/merge.json");
    let scenarios: Vec<Scenario> =
        serde_json::from_str(&fs::read_to_string(path).expect("golden")).expect("json");
    assert!(!scenarios.is_empty());

    for sc in scenarios {
        let tmp = tempfile::tempdir().expect("tmp");
        let repo = tmp.path();
        let s = |a: &[&str]| a.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        run(repo, &s(&["init", "-q"]));
        run(repo, &s(&["checkout", "-q", "-b", "main"]));
        for (k, v) in [
            ("user.name", "t"),
            ("user.email", "t@t"),
            ("commit.gpgsign", "false"),
            ("core.autocrlf", "false"),
        ] {
            run(repo, &s(&["config", k, v]));
        }

        let mut vars = BTreeMap::new();
        for step in &sc.steps {
            if let Some(args) = step.get("git").and_then(Value::as_array) {
                let args: Vec<String> = args
                    .iter()
                    .map(|a| sub(a.as_str().expect("str"), &vars))
                    .collect();
                run(repo, &args);
            } else if let Some(w) = step.get("write").and_then(Value::as_array) {
                let p = repo.join(w[0].as_str().expect("path"));
                fs::create_dir_all(p.parent().expect("parent")).expect("mkdir");
                fs::write(p, w[1].as_str().expect("content")).expect("write");
            } else if let Some(name) = step.get("rev").and_then(Value::as_str) {
                vars.insert(
                    name.to_string(),
                    run(repo, &s(&["rev-parse", "HEAD"])).trim().to_string(),
                );
            }
        }

        let inputs: Vec<MergeInput> = sc
            .applies
            .iter()
            .map(|a| MergeInput {
                work_unit_id: a.id.clone(),
                commit_hash: a.hash.as_ref().map(|h| sub(h, &vars)),
                branch: a.branch.clone(),
            })
            .collect();
        let mut seq = CommitSequencer::new(repo, sc.target.clone());
        let results: Vec<SequencerResult> = if sc.mode == "all" {
            seq.apply_all(&inputs)
        } else {
            inputs.iter().map(|i| seq.apply(i)).collect()
        };

        let got: Vec<ExpectedResult> = results
            .iter()
            .map(|r| ExpectedResult {
                task_id: r.task_id.clone(),
                success: r.success,
                resolved_tier: r.resolved_tier,
                error: r.error.as_deref().map(normalize),
                has_commit_hash: r.commit_hash.is_some(),
            })
            .collect();
        assert_eq!(got, sc.expected.results, "scenario {}: results", sc.name);

        for f in &sc.inspect {
            let actual = fs::read_to_string(repo.join(f)).ok();
            assert_eq!(
                &actual, &sc.expected.files[f],
                "scenario {}: file {f}",
                sc.name
            );
        }

        let hist_json = fs::read_to_string(repo.join(".fsc/merge-history.json"))
            .unwrap_or_else(|_| "{}".into());
        let hist: BTreeMap<String, Vec<Value>> =
            serde_json::from_str(&hist_json).expect("history json");
        for f in &sc.history_files {
            let actual: Vec<HistEntry> = hist
                .get(f)
                .map(|v| {
                    v.iter()
                        .map(|e| HistEntry {
                            tier: e["tier"].as_u64().expect("tier") as u8,
                            success: e["success"].as_bool().expect("success"),
                        })
                        .collect()
                })
                .unwrap_or_default();
            assert_eq!(
                actual, sc.expected.history[f],
                "scenario {}: history {f}",
                sc.name
            );
        }

        for f in &sc.start_tier_files {
            assert_eq!(
                seq.effective_start_tier(f),
                sc.expected.start_tiers[f],
                "scenario {}: start tier {f}",
                sc.name
            );
        }

        let porcelain = run(repo, &s(&["status", "--porcelain", "--untracked-files=no"]));
        assert_eq!(
            porcelain.trim().is_empty(),
            sc.expected.porcelain_clean,
            "scenario {}: clean tree",
            sc.name
        );
        assert_eq!(
            repo.join(".git/CHERRY_PICK_HEAD").exists(),
            sc.expected.cherry_pick_in_progress,
            "scenario {}: cherry-pick state",
            sc.name
        );
    }
}
