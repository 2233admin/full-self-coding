use std::path::Path;
use std::process::{Command, Stdio};

#[derive(Debug, Clone)]
pub struct GitOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

impl GitOutput {
    pub fn ok(&self) -> bool {
        self.exit_code == 0
    }
}

/// Run `git <args>` in `cwd`. Never prompts and never opens an editor.
/// A spawn failure is reported as exit code 1 with the OS error in `stderr`.
pub fn git(args: &[&str], cwd: &Path) -> GitOutput {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        .stdin(Stdio::null())
        .output();
    match out {
        Ok(o) => GitOutput {
            stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
            exit_code: o.status.code().unwrap_or(1),
        },
        Err(e) => GitOutput {
            stdout: String::new(),
            stderr: e.to_string(),
            exit_code: 1,
        },
    }
}
