//! Conflict-marker parser: the same cases as the TS `conflictParser` tests plus edge cases.

use fsc_merge::{
    has_contentful_canonical, parse_conflict_markers, resolve_keep_incoming, ConflictChunk,
};

fn sample() -> String {
    [
        "before",
        "<<<<<<< HEAD",
        "ours line",
        "=======",
        "theirs line",
        ">>>>>>> branch",
        "after",
    ]
    .join("\n")
}

#[test]
fn parse_extracts_ours_and_theirs() {
    let chunks = parse_conflict_markers(&sample());
    assert_eq!(
        chunks,
        vec![ConflictChunk {
            start_line: 1,
            ours: "ours line".into(),
            theirs: "theirs line".into()
        }]
    );
}

#[test]
fn no_markers_means_no_chunks() {
    assert!(parse_conflict_markers("plain\ntext\n").is_empty());
}

#[test]
fn contentful_canonical_ignores_blank_sides() {
    let c = |ours: &str| ConflictChunk {
        start_line: 0,
        ours: ours.into(),
        theirs: "x".into(),
    };
    assert!(has_contentful_canonical(&c("real code")));
    assert!(!has_contentful_canonical(&c("  \n  ")));
    assert!(!has_contentful_canonical(&c("")));
}

#[test]
fn keep_incoming_drops_ours_and_markers() {
    assert_eq!(
        resolve_keep_incoming(&sample()),
        "before\ntheirs line\nafter"
    );
}

#[test]
fn multiple_chunks_resolve_independently() {
    let s = [
        "a",
        "<<<<<<< HEAD",
        "o1",
        "=======",
        "t1",
        ">>>>>>> b",
        "m",
        "<<<<<<< HEAD",
        "=======",
        "t2",
        ">>>>>>> b",
        "z",
    ]
    .join("\n");
    assert_eq!(parse_conflict_markers(&s).len(), 2);
    assert_eq!(resolve_keep_incoming(&s), "a\nt1\nm\nt2\nz");
}

#[test]
fn marker_needs_trailing_whitespace_and_exactly_seven() {
    assert!(parse_conflict_markers("<<<<<<<\nx\n=======\ny\n>>>>>>>").is_empty());
    assert!(parse_conflict_markers("<<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> b").is_empty());
}
