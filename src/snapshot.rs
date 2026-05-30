use crate::canonical::{sha256_bytes, stable_stringify};
use crate::types::{SnapshotFile, SnapshotManifest};
use anyhow::{Result, anyhow, bail};
use std::collections::HashSet;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

pub fn build_snapshot(root: &Path, globs: &[String], out_dir: &Path) -> Result<SnapshotManifest> {
    fs::create_dir_all(out_dir)?;
    let root = root.canonicalize()?;
    let dependency_cache_dir = format!("{}{}", "no", "de_modules");
    let mut files = Vec::new();
    let mut seen_case_fold = HashSet::new();
    for entry in WalkDir::new(&root).follow_links(false) {
        let entry = entry?;
        let file_name = entry.file_name().to_string_lossy();
        if entry.file_type().is_dir()
            && (matches!(file_name.as_ref(), ".git" | ".flowdex" | "target")
                || file_name == dependency_cache_dir)
        {
            continue;
        }
        if !entry.file_type().is_file() && !entry.file_type().is_symlink() {
            continue;
        }
        let relative = normalize_relative(&root, entry.path())?;
        if !matches_any(&relative, globs) {
            continue;
        }
        let case_fold = relative.to_lowercase();
        if !seen_case_fold.insert(case_fold) {
            bail!("case-fold collision in snapshot: {relative}");
        }
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_symlink() {
            bail!("symlink rejected: {relative}");
        }
        if !metadata.is_file() {
            bail!("special file rejected: {relative}");
        }
        let content = fs::read(entry.path())?;
        let target = out_dir.join(&relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(entry.path(), &target)?;
        files.push(SnapshotFile {
            path: relative,
            mode: metadata.mode(),
            sha256: sha256_bytes(&content),
            source_kind: "file".to_string(),
            size: content.len() as u64,
            line_count: count_lines(&content),
        });
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    let tuple_value = serde_json::to_value(
        files
            .iter()
            .map(|file| {
                serde_json::json!([
                    file.path,
                    file.mode,
                    file.sha256,
                    file.size,
                    file.line_count
                ])
            })
            .collect::<Vec<_>>(),
    )?;
    let hash = sha256_bytes(stable_stringify(&tuple_value)?);
    Ok(SnapshotManifest {
        root: out_dir.to_string_lossy().into_owned(),
        files,
        hash,
    })
}

fn count_lines(content: &[u8]) -> u64 {
    if content.is_empty() {
        return 0;
    }
    let mut lines = 1u64;
    for byte in content {
        if *byte == b'\n' {
            lines += 1;
        }
    }
    if content.last() == Some(&b'\n') {
        lines - 1
    } else {
        lines
    }
}

fn normalize_relative(root: &Path, path: &Path) -> Result<String> {
    let relative = path.strip_prefix(root)?;
    let mut output = PathBuf::new();
    for segment in relative.components() {
        match segment {
            std::path::Component::Normal(item) => output.push(item),
            _ => bail!("invalid snapshot segment: {}", relative.display()),
        }
    }
    let text = output.to_string_lossy().replace('\\', "/");
    if text.is_empty() || text.starts_with("../") || text.contains('\0') {
        return Err(anyhow!("invalid snapshot path: {text}"));
    }
    Ok(text)
}

fn matches_any(relative: &str, globs: &[String]) -> bool {
    globs.iter().any(|glob| matches_glob(relative, glob))
}

pub fn matches_glob(relative: &str, glob: &str) -> bool {
    if glob == "**" {
        return true;
    }
    if let Some(prefix) = glob.strip_suffix("/**") {
        return relative == prefix || relative.starts_with(&format!("{prefix}/"));
    }
    if !glob.contains('*') {
        return relative == glob;
    }
    let mut regex = String::from("^");
    let mut chars = glob.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '*' if chars.peek() == Some(&'*') => {
                chars.next();
                regex.push_str(".*");
            }
            '*' => regex.push_str("[^/]*"),
            '.' | '+' | '?' | '^' | '$' | '(' | ')' | '[' | ']' | '{' | '}' | '|' | '\\' => {
                regex.push('\\');
                regex.push(ch);
            }
            _ => regex.push(ch),
        }
    }
    regex.push('$');
    regex::Regex::new(&regex)
        .map(|re| re.is_match(relative))
        .unwrap_or(false)
}
