use crate::snapshot::matches_glob;
use anyhow::{Result, bail};
use std::path::Path;
use std::process::{Command, Stdio};

pub fn apply_patches(repo_root: &Path, patches: &[String], allowed_globs: &[String]) -> Result<()> {
    if patches.is_empty() {
        return Ok(());
    }
    let combined = patches.join("\n");
    let changed_paths = patch_changed_paths(repo_root, &combined)?;
    for path in &changed_paths {
        if !allowed_globs.iter().any(|glob| matches_glob(path, glob)) {
            bail!("patch changes path outside manifest.permissions.write: {path}");
        }
    }
    run_git_apply(repo_root, &["apply", "--check", "--3way", "-"], &combined)?;
    run_git_apply(repo_root, &["apply", "--3way", "-"], &combined)?;
    Ok(())
}

pub fn patch_changed_paths(repo_root: &Path, patch: &str) -> Result<Vec<String>> {
    let output = run_git_apply(repo_root, &["apply", "--numstat", "-"], patch)?;
    Ok(String::from_utf8_lossy(&output)
        .lines()
        .filter_map(|line| line.split('\t').next_back())
        .filter(|item| !item.is_empty())
        .map(ToString::to_string)
        .collect())
}

fn run_git_apply(repo_root: &Path, args: &[&str], input: &str) -> Result<Vec<u8>> {
    let mut child = Command::new("git")
        .args(args)
        .current_dir(repo_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    {
        use std::io::Write;
        child
            .stdin
            .as_mut()
            .expect("stdin is piped")
            .write_all(input.as_bytes())?;
    }
    let output = child.wait_with_output()?;
    if !output.status.success() {
        bail!(
            "{}{}",
            String::from_utf8_lossy(&output.stderr),
            String::from_utf8_lossy(&output.stdout)
        );
    }
    Ok(output.stdout)
}
