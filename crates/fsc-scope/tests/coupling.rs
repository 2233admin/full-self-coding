//! Coupling is checked against a throwaway git repo (the TS test uses the live repo history).

use std::fs;
use std::path::Path;
use std::process::Command;

use fsc_scope::{co_changed_files, expand_with_coupling};

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .current_dir(dir)
        .output()
        .expect("git");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn commit(dir: &Path, files: &[(&str, &str)], msg: &str) {
    for (f, content) in files {
        fs::write(dir.join(f), content).expect("write");
    }
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", msg]);
}

fn repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().expect("tmp");
    git(d.path(), &["init", "-q"]);
    d
}

#[test]
fn files_that_change_together_are_coupled() {
    let d = repo();
    // a.txt + b.txt change together 4 times; c.txt changes alone once.
    // `git diff-tree` prints nothing for the root commit, so (as in the TS reference) that
    // first pair is not counted: co_changes is 3, coupling 3 / max(4, 4) = 0.75.
    for i in 0..4 {
        commit(
            d.path(),
            &[("a.txt", &format!("a{i}")), ("b.txt", &format!("b{i}"))],
            "pair",
        );
    }
    commit(d.path(), &[("c.txt", "c")], "solo");

    let got = co_changed_files("a.txt", d.path(), 90);
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].file, "b.txt");
    assert_eq!(got[0].co_changes, 3);
    assert!((got[0].coupling - 0.75).abs() < 1e-9);
}

#[test]
fn below_min_co_changes_is_dropped() {
    let d = repo();
    for i in 0..2 {
        commit(
            d.path(),
            &[("a.txt", &format!("a{i}")), ("b.txt", &format!("b{i}"))],
            "pair",
        );
    }
    assert!(co_changed_files("a.txt", d.path(), 90).is_empty());
}

#[test]
fn weak_coupling_is_dropped() {
    let d = repo();
    // b changes with a 3 times but also alone 10 times: 3 / max(3, 13) < 0.3.
    for i in 0..3 {
        commit(
            d.path(),
            &[("a.txt", &format!("a{i}")), ("b.txt", &format!("b{i}"))],
            "pair",
        );
    }
    for i in 0..10 {
        commit(d.path(), &[("b.txt", &format!("solo{i}"))], "b only");
    }
    assert!(co_changed_files("a.txt", d.path(), 90).is_empty());
}

#[test]
fn unknown_file_and_non_repo_yield_nothing() {
    let d = repo();
    commit(d.path(), &[("a.txt", "x")], "init");
    assert!(co_changed_files("missing.txt", d.path(), 90).is_empty());
    let plain = tempfile::tempdir().expect("tmp");
    assert!(co_changed_files("a.txt", plain.path(), 90).is_empty());
}

#[test]
fn expand_skips_files_already_in_the_core_set() {
    let d = repo();
    for i in 0..4 {
        commit(
            d.path(),
            &[
                ("a.txt", &format!("a{i}")),
                ("b.txt", &format!("b{i}")),
                ("c.txt", &format!("c{i}")),
            ],
            "trio",
        );
    }
    let core = vec!["a.txt".to_string(), "b.txt".to_string()];
    assert_eq!(
        expand_with_coupling(&core, d.path(), 90),
        vec!["c.txt".to_string()]
    );
}
