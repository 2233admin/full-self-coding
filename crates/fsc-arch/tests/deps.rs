//! Crate dependency direction gate (see MODULE_STRUCTURE.md). Fails when a workspace crate
//! depends on a sibling that is not listed in `ALLOWED`.

use std::collections::{BTreeMap, BTreeSet};
use std::process::Command;

/// crate -> fsc crates it may depend on. Layers: core < {scope, exec, merge} < sched < dist < cli.
const ALLOWED: &[(&str, &[&str])] = &[
    ("fsc-core", &[]),
    ("fsc-scope", &["fsc-core"]),
    ("fsc-exec", &["fsc-core"]),
    ("fsc-merge", &["fsc-core"]),
    (
        "fsc-sched",
        &["fsc-core", "fsc-scope", "fsc-exec", "fsc-merge"],
    ),
    ("fsc-dist", &["fsc-core", "fsc-sched"]),
    (
        "fsc-cli",
        &[
            "fsc-core",
            "fsc-scope",
            "fsc-exec",
            "fsc-merge",
            "fsc-sched",
            "fsc-dist",
        ],
    ),
    ("fsc-arch", &[]),
];

/// One message per violation.
fn violations(graph: &BTreeMap<String, BTreeSet<String>>) -> Vec<String> {
    let allowed: BTreeMap<&str, BTreeSet<&str>> = ALLOWED
        .iter()
        .map(|(k, v)| (*k, v.iter().copied().collect()))
        .collect();
    let mut out = vec![];
    for (name, deps) in graph {
        let Some(ok) = allowed.get(name.as_str()) else {
            out.push(format!("{name}: crate not registered in ALLOWED"));
            continue;
        };
        for d in deps.iter().filter(|d| d.starts_with("fsc-")) {
            if !ok.contains(d.as_str()) {
                out.push(format!("{name}: forbidden dependency on {d}"));
            }
        }
    }
    out
}

fn workspace_graph() -> BTreeMap<String, BTreeSet<String>> {
    let out = Command::new(env!("CARGO"))
        .args(["metadata", "--format-version", "1", "--no-deps"])
        .output()
        .expect("cargo metadata");
    assert!(out.status.success(), "cargo metadata failed");
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).expect("json");
    v["packages"]
        .as_array()
        .expect("packages")
        .iter()
        .map(|p| {
            let deps = p["dependencies"]
                .as_array()
                .expect("dependencies")
                .iter()
                .map(|d| d["name"].as_str().expect("name").to_string())
                .collect();
            (p["name"].as_str().expect("name").to_string(), deps)
        })
        .collect()
}

#[test]
fn workspace_respects_dependency_direction() {
    assert_eq!(violations(&workspace_graph()), Vec::<String>::new());
}

#[test]
fn gate_goes_red_on_a_reverse_dependency() {
    let mut g = BTreeMap::new();
    g.insert(
        "fsc-core".to_string(),
        BTreeSet::from(["fsc-scope".to_string()]),
    );
    assert_eq!(
        violations(&g),
        vec!["fsc-core: forbidden dependency on fsc-scope"]
    );
}

#[test]
fn gate_flags_unregistered_crates() {
    let mut g = BTreeMap::new();
    g.insert("fsc-mystery".to_string(), BTreeSet::new());
    assert_eq!(
        violations(&g),
        vec!["fsc-mystery: crate not registered in ALLOWED"]
    );
}
