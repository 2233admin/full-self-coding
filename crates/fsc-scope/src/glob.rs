//! Glob matching. Reproduces the TS `matchGlob` branch order exactly, including its quirks
//! (a mid-pattern `*` crosses `/`), because the golden tests pin that behaviour.

use regex::Regex;

pub fn match_glob(path: &str, pattern: &str) -> bool {
    if path == pattern {
        return true;
    }
    if let Some(prefix) = pattern.strip_suffix("/**") {
        return path == prefix || path.starts_with(&format!("{prefix}/"));
    }
    if pattern.starts_with("*.") {
        return path.ends_with(&pattern[1..]);
    }
    if pattern.contains(".*") {
        let base = pattern.replacen(".*", "", 1);
        return path == base || path.starts_with(&format!("{base}."));
    }
    if pattern.ends_with('/') {
        return path.starts_with(pattern);
    }
    if pattern.contains('*') && !pattern.contains("**") {
        let mut re = String::from("^");
        for c in pattern.chars() {
            match c {
                '*' => re.push_str(".*"),
                '.' | '+' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | '\\' => {
                    re.push('\\');
                    re.push(c);
                }
                _ => re.push(c),
            }
        }
        re.push('$');
        return Regex::new(&re).map(|r| r.is_match(path)).unwrap_or(false);
    }
    false
}

pub fn matches_any(path: &str, patterns: &[String]) -> bool {
    patterns.iter().any(|p| match_glob(path, p))
}
