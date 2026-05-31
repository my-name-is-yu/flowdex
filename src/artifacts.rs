use crate::canonical::sha256_bytes;
use crate::types::ArtifactRecord;
use anyhow::Result;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct ArtifactStore {
    root: PathBuf,
}

impl ArtifactStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn write(
        &self,
        content: impl AsRef<[u8]>,
        media_type: &str,
        producer: Option<&str>,
    ) -> Result<ArtifactRecord> {
        let bytes = content.as_ref();
        let sha256 = sha256_bytes(bytes);
        let directory = self.root.join("sha256");
        fs::create_dir_all(&directory)?;
        let final_path = directory.join(&sha256);
        if !final_path.exists() {
            let temp_path = directory.join(format!("{sha256}.{}.tmp", std::process::id()));
            let mut file = fs::File::create(&temp_path)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            fs::rename(&temp_path, &final_path)?;
        }
        let size = fs::metadata(&final_path)?.len();
        Ok(ArtifactRecord {
            id: sha256.clone(),
            sha256,
            media_type: media_type.to_string(),
            size,
            path: final_path.to_string_lossy().into_owned(),
            producer: producer.map(str::to_string),
            redaction_status: "none".to_string(),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}
