use anyhow::{Result, anyhow, bail};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

const SKILL_NAME: &str = "flowdex";
const BUNDLED_SKILL_PATH: &str = "skills/flowdex";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallSummary {
    pub skill: String,
    pub source: PathBuf,
    pub destination: PathBuf,
    pub files_copied: usize,
    pub directories_created: usize,
}

pub fn bundled_skill_source() -> Result<PathBuf> {
    if let Some(source) = read_env_path("FLOWDEX_SKILL_SOURCE") {
        return validate_skill_source(source);
    }

    let mut roots = Vec::new();
    if let Some(root) = read_env_path("FLOWDEX_PACKAGE_ROOT") {
        roots.push(root);
    }
    roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    if let Ok(exe) = std::env::current_exe() {
        for ancestor in exe.ancestors() {
            roots.push(ancestor.to_path_buf());
        }
    }

    for root in roots {
        let candidate = root.join(BUNDLED_SKILL_PATH);
        if candidate.join("SKILL.md").is_file() {
            return Ok(candidate);
        }
    }

    bail!("could not locate bundled Flowdex skill directory")
}

pub fn default_skill_destination() -> Result<PathBuf> {
    if let Some(codex_home) = read_env_path("CODEX_HOME") {
        return Ok(codex_home.join("skills").join(SKILL_NAME));
    }
    let home = read_env_path("HOME")
        .or_else(|| read_env_path("USERPROFILE"))
        .ok_or_else(|| anyhow!("CODEX_HOME or HOME must be set to install the Flowdex skill"))?;
    Ok(home.join(".codex").join("skills").join(SKILL_NAME))
}

pub fn install_bundled_skill(destination: Option<PathBuf>) -> Result<SkillInstallSummary> {
    let source = bundled_skill_source()?;
    let destination = match destination {
        Some(destination) => destination,
        None => default_skill_destination()?,
    };
    install_skill_from(&source, &destination)
}

pub fn install_skill_from(source: &Path, destination: &Path) -> Result<SkillInstallSummary> {
    let source = validate_skill_source(source.to_path_buf())?;
    if destination.exists() && source.canonicalize()? == destination.canonicalize()? {
        bail!("skill destination is the bundled source directory");
    }

    let mut summary = SkillInstallSummary {
        skill: SKILL_NAME.to_string(),
        source: source.clone(),
        destination: destination.to_path_buf(),
        files_copied: 0,
        directories_created: 0,
    };
    copy_skill_directory(&source, destination, &mut summary)?;
    Ok(summary)
}

fn copy_skill_directory(
    source: &Path,
    destination: &Path,
    summary: &mut SkillInstallSummary,
) -> Result<()> {
    if !destination.exists() {
        fs::create_dir_all(destination)?;
        summary.directories_created += 1;
    }

    let mut entries = fs::read_dir(source)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            copy_skill_directory(&source_path, &destination_path, summary)?;
        } else if file_type.is_file() {
            if let Some(parent) = destination_path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(&source_path, &destination_path)?;
            summary.files_copied += 1;
        }
    }
    Ok(())
}

fn validate_skill_source(source: PathBuf) -> Result<PathBuf> {
    if !source.join("SKILL.md").is_file() {
        bail!(
            "Flowdex skill source must contain SKILL.md: {}",
            source.to_string_lossy()
        );
    }
    Ok(source)
}

fn read_env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}
