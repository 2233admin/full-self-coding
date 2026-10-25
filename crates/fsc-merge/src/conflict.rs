//! Git conflict-marker parsing. Behaviour matches `utils/conflictParser.ts` line for line,
//! including that the separator must be exactly `=======` (a CRLF file leaves a trailing `\r`,
//! which the TS version also fails to recognise).

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConflictChunk {
    /// Line offset of the `<<<<<<<` line (0-based).
    pub start_line: usize,
    /// Content from HEAD (the canonical / target side).
    pub ours: String,
    /// Content from the incoming (agent) side.
    pub theirs: String,
}

fn is_ours(line: &str) -> bool {
    marker(line, '<')
}

fn is_theirs(line: &str) -> bool {
    marker(line, '>')
}

fn is_separator(line: &str) -> bool {
    line == "======="
}

/// Seven `c` followed by a whitespace character.
fn marker(line: &str, c: char) -> bool {
    let mut it = line.chars();
    for _ in 0..7 {
        if it.next() != Some(c) {
            return false;
        }
    }
    it.next().is_some_and(char::is_whitespace)
}

/// Parse conflict chunks. Empty when the content has no markers.
pub fn parse_conflict_markers(content: &str) -> Vec<ConflictChunk> {
    let lines: Vec<&str> = content.split('\n').collect();
    let mut chunks = vec![];
    let mut i = 0;
    while i < lines.len() {
        if !is_ours(lines[i]) {
            i += 1;
            continue;
        }
        let start_line = i;
        let (mut ours, mut theirs) = (vec![], vec![]);
        let mut in_ours = true;
        i += 1;
        while i < lines.len() {
            if is_separator(lines[i]) {
                in_ours = false;
                i += 1;
                continue;
            }
            if is_theirs(lines[i]) {
                break;
            }
            if in_ours {
                ours.push(lines[i]);
            } else {
                theirs.push(lines[i]);
            }
            i += 1;
        }
        chunks.push(ConflictChunk {
            start_line,
            ours: ours.join("\n"),
            theirs: theirs.join("\n"),
        });
        i += 1;
    }
    chunks
}

/// True when the HEAD side has non-whitespace content, i.e. keep-incoming would discard real work.
pub fn has_contentful_canonical(chunk: &ConflictChunk) -> bool {
    !chunk.ours.trim().is_empty()
}

/// Resolve every conflict by keeping the incoming side.
pub fn resolve_keep_incoming(content: &str) -> String {
    let lines: Vec<&str> = content.split('\n').collect();
    let mut out: Vec<&str> = vec![];
    let mut i = 0;
    while i < lines.len() {
        if !is_ours(lines[i]) {
            out.push(lines[i]);
            i += 1;
            continue;
        }
        i += 1;
        while i < lines.len() && !is_separator(lines[i]) {
            i += 1;
        }
        i += 1;
        while i < lines.len() && !is_theirs(lines[i]) {
            out.push(lines[i]);
            i += 1;
        }
        i += 1;
    }
    out.join("\n")
}
