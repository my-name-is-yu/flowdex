use crate::adapter_result::{agent_task_status_for_result, sanitize_adapter_result_for_storage};
use crate::canonical::{stable_stringify, to_canonical_value};
use crate::manifest::is_safe_id;
use crate::types::{
    AdapterResult, AgentTaskRecord, ArtifactRecord, NativeDispatch, WorkflowManifest,
};
use anyhow::{Result, anyhow, bail};
use chrono::{Duration, Utc};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde_json::{Value, json};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub struct FlowdexState {
    conn: Connection,
    jsonl_path: PathBuf,
}

impl FlowdexState {
    pub fn open_run(root: &Path, run_id: &str) -> Result<Self> {
        let directory = Self::run_directory(root, run_id)?;
        fs::create_dir_all(&directory)?;
        Self::open_file(directory.join("state.sqlite"))
    }

    pub fn open_existing_run(root: &Path, run_id: &str) -> Result<Option<Self>> {
        let file_path = Self::run_directory(root, run_id)?.join("state.sqlite");
        if !file_path.is_file() {
            return Ok(None);
        }
        let state = Self::open_file(file_path)?;
        if state.get_run(run_id)?.is_some() {
            Ok(Some(state))
        } else {
            Ok(None)
        }
    }

    fn open_file(path: PathBuf) -> Result<Self> {
        let conn = Connection::open(&path)?;
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA busy_timeout = 5000;
            CREATE TABLE IF NOT EXISTS runs (
              id TEXT PRIMARY KEY,
              manifest_json TEXT NOT NULL,
              source_hash TEXT NOT NULL,
              manifest_hash TEXT NOT NULL,
              approval_hash TEXT NOT NULL,
              status TEXT NOT NULL,
              pid INTEGER,
              heartbeat_at TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS events (
              seq INTEGER PRIMARY KEY AUTOINCREMENT,
              run_id TEXT NOT NULL,
              type TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS task_results (
              run_id TEXT NOT NULL,
              op_key TEXT NOT NULL,
              result_json TEXT NOT NULL,
              status TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              PRIMARY KEY (run_id, op_key)
            );
            CREATE TABLE IF NOT EXISTS artifacts (
              run_id TEXT NOT NULL,
              artifact_id TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              PRIMARY KEY (run_id, artifact_id)
            );
            CREATE TABLE IF NOT EXISTS agent_tasks (
              run_id TEXT NOT NULL,
              child_key TEXT NOT NULL,
              parent_op_key TEXT NOT NULL,
              task_id TEXT NOT NULL,
              phase TEXT NOT NULL,
              adapter TEXT NOT NULL,
              mode TEXT NOT NULL,
              order_index INTEGER NOT NULL,
              status TEXT NOT NULL,
              task_json TEXT NOT NULL,
              context_cwd TEXT,
              lease_token TEXT,
              lease_expires_at TEXT,
              agent_ref TEXT,
              result_json TEXT,
              error TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              PRIMARY KEY (run_id, child_key)
            );
            "#,
        )?;
        let jsonl_path = path
            .parent()
            .ok_or_else(|| anyhow!("state path has no parent"))?
            .join("events.jsonl");
        Ok(Self { conn, jsonl_path })
    }

    pub fn run_directory(root: &Path, run_id: &str) -> Result<PathBuf> {
        if !is_safe_run_id(run_id) {
            bail!("unsafe Flowdex run id: {run_id}");
        }
        Ok(root.join(".flowdex").join("runs").join(run_id))
    }

    pub fn run_directory_exists(root: &Path, run_id: &str) -> Result<bool> {
        Ok(Self::run_directory(root, run_id)?.is_dir())
    }

    pub fn list_run_ids(root: &Path) -> Result<Vec<String>> {
        let directory = root.join(".flowdex").join("runs");
        if !directory.is_dir() {
            return Ok(vec![]);
        }
        let mut ids = fs::read_dir(directory)?
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        ids.sort();
        Ok(ids)
    }

    pub fn create_run(
        &self,
        id: &str,
        manifest: &WorkflowManifest,
        source_hash: &str,
        manifest_hash: &str,
        approval_hash: &str,
    ) -> Result<()> {
        let now = now_iso();
        self.conn.execute(
            r#"INSERT INTO runs
            (id, manifest_json, source_hash, manifest_hash, approval_hash, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'running', ?, ?)"#,
            params![
                id,
                stable_stringify(&to_canonical_value(manifest)?)?,
                source_hash,
                manifest_hash,
                approval_hash,
                now,
                now
            ],
        )?;
        self.add_event(id, "run.created", &to_canonical_value(manifest)?)?;
        Ok(())
    }

    pub fn set_run_status(&self, run_id: &str, status: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE runs SET status = ?, updated_at = ? WHERE id = ?",
            params![status, now_iso(), run_id],
        )?;
        self.add_event(run_id, "run.status", &json!({ "status": status }))?;
        Ok(())
    }

    pub fn heartbeat(&self, run_id: &str) -> Result<()> {
        let now = now_iso();
        self.conn.execute(
            "UPDATE runs SET pid = ?, heartbeat_at = ?, updated_at = ? WHERE id = ?",
            params![std::process::id(), now, now, run_id],
        )?;
        self.add_event(
            run_id,
            "run.heartbeat",
            &json!({ "pid": std::process::id() }),
        )?;
        Ok(())
    }

    pub fn get_run_status(&self, run_id: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT status FROM runs WHERE id = ?", [run_id], |row| {
                row.get(0)
            })
            .optional()?)
    }

    pub fn get_run(&self, run_id: &str) -> Result<Option<Value>> {
        self.conn
            .query_row(
                "SELECT * FROM runs WHERE id = ?",
                [run_id],
                run_row_to_value,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn add_event(&self, run_id: &str, kind: &str, payload: &Value) -> Result<()> {
        let created_at = now_iso();
        self.conn.execute(
            "INSERT INTO events (run_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)",
            params![run_id, kind, serde_json::to_string(payload)?, created_at],
        )?;
        let seq = self.conn.last_insert_rowid();
        let line = json!({
            "seq": seq,
            "runId": run_id,
            "type": kind,
            "payload": payload,
            "createdAt": created_at
        });
        if let Some(parent) = self.jsonl_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.jsonl_path)?;
        writeln!(file, "{}", serde_json::to_string(&line)?)?;
        Ok(())
    }

    pub fn rebuild_event_projection(&self, run_id: &str) -> Result<usize> {
        let mut statement = self.conn.prepare(
            "SELECT seq, run_id, type, payload_json, created_at FROM events WHERE run_id = ? ORDER BY seq",
        )?;
        let rows = statement.query_map([run_id], |row| {
            Ok(json!({
                "seq": row.get::<_, i64>(0)?,
                "runId": row.get::<_, String>(1)?,
                "type": row.get::<_, String>(2)?,
                "payload": serde_json::from_str::<Value>(&row.get::<_, String>(3)?).unwrap_or(Value::Null),
                "createdAt": row.get::<_, String>(4)?
            }))
        })?;
        let mut lines = Vec::new();
        for row in rows {
            lines.push(serde_json::to_string(&row?)?);
        }
        fs::write(
            &self.jsonl_path,
            if lines.is_empty() {
                String::new()
            } else {
                format!("{}\n", lines.join("\n"))
            },
        )?;
        Ok(lines.len())
    }

    pub fn save_task_result(
        &self,
        run_id: &str,
        op_key: &str,
        status: &str,
        result: &Value,
    ) -> Result<()> {
        self.conn.execute(
            r#"INSERT INTO task_results (run_id, op_key, result_json, status, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(run_id, op_key) DO UPDATE SET
              result_json = excluded.result_json,
              status = excluded.status,
              updated_at = excluded.updated_at"#,
            params![run_id, op_key, stable_stringify(result)?, status, now_iso()],
        )?;
        self.add_event(
            run_id,
            "task.result",
            &json!({ "opKey": op_key, "status": status }),
        )?;
        Ok(())
    }

    pub fn save_artifact(&self, run_id: &str, artifact: &ArtifactRecord) -> Result<()> {
        self.conn.execute(
            r#"INSERT INTO artifacts (run_id, artifact_id, payload_json)
            VALUES (?, ?, ?)
            ON CONFLICT(run_id, artifact_id) DO UPDATE SET payload_json = excluded.payload_json"#,
            params![run_id, artifact.id, serde_json::to_string(artifact)?],
        )?;
        self.add_event(
            run_id,
            "artifact.written",
            &json!({
                "artifactId": artifact.id,
                "mediaType": artifact.media_type,
                "size": artifact.size
            }),
        )?;
        Ok(())
    }

    pub fn list_artifacts(&self, run_id: &str) -> Result<Vec<ArtifactRecord>> {
        let mut statement = self
            .conn
            .prepare("SELECT payload_json FROM artifacts WHERE run_id = ?")?;
        let rows = statement.query_map([run_id], |row| row.get::<_, String>(0))?;
        let mut artifacts = Vec::new();
        for row in rows {
            artifacts.push(serde_json::from_str(&row?)?);
        }
        Ok(artifacts)
    }

    pub fn get_completed_results(
        &self,
        run_id: &str,
    ) -> Result<std::collections::BTreeMap<String, Value>> {
        let mut statement = self
            .conn
            .prepare("SELECT op_key, result_json FROM task_results WHERE run_id = ? AND status = 'completed'")?;
        let rows = statement.query_map([run_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut output = std::collections::BTreeMap::new();
        for row in rows {
            let (key, value) = row?;
            output.insert(key, serde_json::from_str(&value)?);
        }
        Ok(output)
    }

    pub fn get_task_result(&self, run_id: &str, op_key: &str) -> Result<Option<Value>> {
        let value = self
            .conn
            .query_row(
                "SELECT result_json FROM task_results WHERE run_id = ? AND op_key = ? AND status = 'completed'",
                params![run_id, op_key],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        Ok(value.map(|raw| serde_json::from_str(&raw)).transpose()?)
    }

    pub fn list_events(&self, run_id: &str) -> Result<Vec<Value>> {
        let mut statement = self.conn.prepare(
            "SELECT seq, type, payload_json, created_at FROM events WHERE run_id = ? ORDER BY seq",
        )?;
        let rows = statement.query_map([run_id], |row| {
            Ok(json!({
                "seq": row.get::<_, i64>(0)?,
                "type": row.get::<_, String>(1)?,
                "payload_json": serde_json::from_str::<Value>(&row.get::<_, String>(2)?).unwrap_or(Value::Null),
                "created_at": row.get::<_, String>(3)?
            }))
        })?;
        let mut events = Vec::new();
        for row in rows {
            events.push(row?);
        }
        Ok(events)
    }

    pub fn latest_completed_report(&self, run_id: &str) -> Result<Option<Value>> {
        let raw = self
            .conn
            .query_row(
                "SELECT payload_json FROM events WHERE run_id = ? AND type = 'workflow.completed' ORDER BY seq DESC LIMIT 1",
                [run_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        Ok(raw.map(|value| serde_json::from_str(&value)).transpose()?)
    }

    pub fn delete_task_result(&self, run_id: &str, op_key: &str) -> Result<()> {
        let task = self.get_agent_task(run_id, op_key)?;
        let mut keys = vec![op_key.to_string()];
        if let Some(task) = task {
            keys.push(task.parent_op_key);
        }
        for key in &keys {
            self.conn.execute(
                "DELETE FROM task_results WHERE run_id = ? AND op_key = ?",
                params![run_id, key],
            )?;
        }
        self.conn.execute(
            r#"UPDATE agent_tasks
            SET status = 'pending', lease_token = NULL, lease_expires_at = NULL, agent_ref = NULL,
                result_json = NULL, error = NULL, context_cwd = NULL, updated_at = ?
            WHERE run_id = ? AND (child_key = ? OR parent_op_key = ?)"#,
            params![now_iso(), run_id, op_key, op_key],
        )?;
        self.conn.execute(
            "UPDATE runs SET status = 'pending', updated_at = ? WHERE id = ?",
            params![now_iso(), run_id],
        )?;
        self.add_event(
            run_id,
            "task.invalidated",
            &json!({ "opKey": op_key, "resultKeys": keys }),
        )?;
        Ok(())
    }

    pub fn ensure_agent_task(&self, record: EnsureAgentTask<'_>) -> Result<AgentTaskRecord> {
        if let Some(existing) = self.get_agent_task(record.run_id, record.child_key)? {
            return Ok(existing);
        }
        let now = now_iso();
        self.conn.execute(
            r#"INSERT INTO agent_tasks
            (run_id, child_key, parent_op_key, task_id, phase, adapter, mode, order_index, status,
             task_json, context_cwd, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
            params![
                record.run_id,
                record.child_key,
                record.parent_op_key,
                record.task_id,
                record.phase,
                record.adapter,
                record.mode,
                record.order_index,
                record.status.unwrap_or("pending"),
                stable_stringify(record.task)?,
                record.context_cwd,
                now,
                now
            ],
        )?;
        self.add_event(
            record.run_id,
            "agent.task.created",
            &json!({
                "childKey": record.child_key,
                "parentOpKey": record.parent_op_key,
                "taskId": record.task_id,
                "phase": record.phase,
                "adapter": record.adapter,
                "mode": record.mode,
                "status": record.status.unwrap_or("pending")
            }),
        )?;
        self.get_agent_task(record.run_id, record.child_key)?
            .ok_or_else(|| anyhow!("failed to create agent task"))
    }

    pub fn update_agent_task_status(
        &self,
        run_id: &str,
        child_key: &str,
        status: &str,
        result: Option<&AdapterResult>,
        error: Option<&str>,
    ) -> Result<()> {
        self.conn.execute(
            r#"UPDATE agent_tasks
            SET status = ?, result_json = COALESCE(?, result_json), error = ?, updated_at = ?
            WHERE run_id = ? AND child_key = ?"#,
            params![
                status,
                result
                    .map(serde_json::to_value)
                    .transpose()?
                    .as_ref()
                    .map(stable_stringify)
                    .transpose()?,
                error,
                now_iso(),
                run_id,
                child_key
            ],
        )?;
        self.add_event(
            run_id,
            agent_event_type(status),
            &json!({
                "childKey": child_key,
                "status": status,
                "summary": result.map(|item| item.summary.clone()),
                "adapterStatus": result.map(|item| item.status.clone()),
                "error": error
            }),
        )?;
        Ok(())
    }

    pub fn mark_agent_dispatchable(
        &self,
        run_id: &str,
        child_key: &str,
        context_cwd: Option<&str>,
    ) -> Result<()> {
        self.conn.execute(
            r#"UPDATE agent_tasks
            SET status = 'dispatchable', context_cwd = ?, updated_at = ?
            WHERE run_id = ? AND child_key = ? AND status IN ('pending', 'dispatchable')"#,
            params![context_cwd, now_iso(), run_id, child_key],
        )?;
        self.add_event(
            run_id,
            "native.dispatch.created",
            &json!({ "childKey": child_key, "contextCwd": context_cwd }),
        )?;
        Ok(())
    }

    pub fn set_agent_task_context_cwd(
        &self,
        run_id: &str,
        child_key: &str,
        context_cwd: &str,
    ) -> Result<()> {
        let changes = self.conn.execute(
            "UPDATE agent_tasks SET context_cwd = ?, updated_at = ? WHERE run_id = ? AND child_key = ?",
            params![context_cwd, now_iso(), run_id, child_key],
        )?;
        if changes != 1 {
            bail!("unknown child task: {child_key}");
        }
        self.add_event(
            run_id,
            "native.dispatch.snapshot",
            &json!({ "childKey": child_key, "contextCwd": context_cwd }),
        )?;
        Ok(())
    }

    pub fn lease_dispatches(&self, run_id: &str, limit: usize) -> Result<Vec<NativeDispatch>> {
        let now = Utc::now();
        let now_iso_value = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let expires_at =
            (now + Duration::minutes(30)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let status = self.get_run_status(run_id)?.unwrap_or_default();
        if status == "paused" || status == "stopped" {
            bail!("cannot lease native dispatches for {status} run: {run_id}");
        }
        let active: i64 = self.conn.query_row(
            r#"SELECT COUNT(*) FROM agent_tasks
            WHERE run_id = ?
              AND status IN ('leased', 'dispatched')
              AND (lease_expires_at IS NULL OR lease_expires_at >= ?)"#,
            params![run_id, now_iso_value],
            |row| row.get(0),
        )?;
        let available = limit.saturating_sub(active.max(0) as usize);
        if available == 0 {
            return Ok(vec![]);
        }
        let mut statement = self.conn.prepare(
            r#"SELECT * FROM agent_tasks
            WHERE run_id = ?
              AND (
                status = 'dispatchable'
                OR (status IN ('leased', 'dispatched') AND lease_expires_at IS NOT NULL AND lease_expires_at < ?)
              )
            ORDER BY order_index, child_key
            LIMIT ?"#,
        )?;
        let rows = statement.query_map(
            params![run_id, now_iso_value, available as i64],
            row_to_agent_task_record,
        )?;
        let mut dispatches = Vec::new();
        for row in rows {
            let mut record = row?;
            let reclaimed = record.status == "leased" || record.status == "dispatched";
            let lease_token = Uuid::new_v4().to_string();
            let changes = self.conn.execute(
                r#"UPDATE agent_tasks
                SET status = 'leased',
                    lease_token = ?,
                    lease_expires_at = ?,
                    context_cwd = CASE WHEN status IN ('leased', 'dispatched') THEN NULL ELSE context_cwd END,
                    updated_at = ?
                WHERE run_id = ? AND child_key = ?
                  AND (
                    status = 'dispatchable'
                    OR (status IN ('leased', 'dispatched') AND lease_expires_at IS NOT NULL AND lease_expires_at < ?)
                  )"#,
                params![
                    lease_token,
                    expires_at,
                    now_iso_value,
                    run_id,
                    record.child_key,
                    now_iso_value
                ],
            )?;
            if changes != 1 {
                continue;
            }
            record.status = "leased".to_string();
            record.lease_token = Some(lease_token.clone());
            record.lease_expires_at = Some(expires_at.clone());
            if reclaimed {
                record.context_cwd = None;
            }
            self.add_event(
                run_id,
                if reclaimed {
                    "native.dispatch.reclaimed"
                } else {
                    "native.dispatch.leased"
                },
                &json!({
                    "childKey": record.child_key,
                    "leaseToken": lease_token,
                    "leaseExpiresAt": expires_at,
                    "reclaimed": reclaimed
                }),
            )?;
            dispatches.push(record_to_dispatch(&record)?);
        }
        Ok(dispatches)
    }

    pub fn release_lease(
        &self,
        run_id: &str,
        child_key: &str,
        lease_token: &str,
        error: &str,
    ) -> Result<()> {
        let changes = self.conn.execute(
            r#"UPDATE agent_tasks
            SET status = 'dispatchable', lease_token = NULL, lease_expires_at = NULL, agent_ref = NULL,
                context_cwd = NULL, error = ?, updated_at = ?
            WHERE run_id = ? AND child_key = ? AND lease_token = ? AND status IN ('leased', 'dispatched')"#,
            params![error, now_iso(), run_id, child_key, lease_token],
        )?;
        if changes != 1 {
            bail!("cannot release lease for {child_key}");
        }
        self.add_event(
            run_id,
            "native.dispatch.released",
            &json!({ "childKey": child_key, "error": error }),
        )?;
        Ok(())
    }

    pub fn attach_agent(
        &self,
        run_id: &str,
        child_key: &str,
        lease_token: &str,
        agent_ref: &str,
    ) -> Result<()> {
        let task = self
            .get_agent_task(run_id, child_key)?
            .ok_or_else(|| anyhow!("unknown child task: {child_key}"))?;
        if task.lease_token.as_deref() != Some(lease_token) {
            bail!("lease token mismatch for {child_key}");
        }
        if task.status != "leased" && task.status != "dispatched" {
            bail!("child task is not leased: {child_key}");
        }
        self.conn.execute(
            "UPDATE agent_tasks SET status = 'dispatched', agent_ref = ?, updated_at = ? WHERE run_id = ? AND child_key = ?",
            params![agent_ref, now_iso(), run_id, child_key],
        )?;
        self.add_event(
            run_id,
            "native.dispatch.attached",
            &json!({ "childKey": child_key, "agentRef": agent_ref }),
        )?;
        Ok(())
    }

    pub fn complete_agent_task(
        &self,
        run_id: &str,
        child_key: &str,
        lease_token: &str,
        result: &AdapterResult,
    ) -> Result<()> {
        let task = self
            .get_agent_task(run_id, child_key)?
            .ok_or_else(|| anyhow!("unknown child task: {child_key}"))?;
        if task.lease_token.as_deref() != Some(lease_token) {
            bail!("lease token mismatch for {child_key}");
        }
        if task.status != "leased" && task.status != "dispatched" {
            bail!("child task is not leased: {child_key}");
        }
        let stored = sanitize_adapter_result_for_storage(result);
        let status = agent_task_status_for_result(&stored);
        let stored_json = serde_json::to_value(&stored)?;
        self.conn.execute(
            r#"UPDATE agent_tasks
            SET status = ?, result_json = ?, error = ?, updated_at = ?
            WHERE run_id = ? AND child_key = ?"#,
            params![
                status,
                stable_stringify(&stored_json)?,
                stored.error.as_str(),
                now_iso(),
                run_id,
                child_key
            ],
        )?;
        self.add_event(
            run_id,
            agent_event_type(status),
            &json!({
                "childKey": child_key,
                "status": status,
                "summary": stored.summary,
                "adapterStatus": stored.status,
                "error": stored.error
            }),
        )?;
        if task.parent_op_key == child_key {
            self.save_task_result(run_id, &task.parent_op_key, "completed", &stored_json)?;
        }
        Ok(())
    }

    pub fn ensure_single_agent_task_result(&self, run_id: &str, child_key: &str) -> Result<bool> {
        let Some(task) = self.get_agent_task(run_id, child_key)? else {
            return Ok(false);
        };
        if task.parent_op_key != child_key || task.result.is_none() {
            return Ok(false);
        }
        if self.get_task_result(run_id, &task.parent_op_key)?.is_some() {
            return Ok(false);
        }
        self.save_task_result(
            run_id,
            &task.parent_op_key,
            "completed",
            &serde_json::to_value(task.result.unwrap())?,
        )?;
        Ok(true)
    }

    pub fn record_agent_task_collection_error(
        &self,
        run_id: &str,
        child_key: &str,
        error: &str,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE agent_tasks SET error = ?, updated_at = ? WHERE run_id = ? AND child_key = ?",
            params![error, now_iso(), run_id, child_key],
        )?;
        self.add_event(
            run_id,
            "native.result.error",
            &json!({ "childKey": child_key, "error": error }),
        )?;
        Ok(())
    }

    pub fn get_agent_task(&self, run_id: &str, child_key: &str) -> Result<Option<AgentTaskRecord>> {
        self.conn
            .query_row(
                "SELECT * FROM agent_tasks WHERE run_id = ? AND child_key = ?",
                params![run_id, child_key],
                row_to_agent_task_record,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn list_agent_tasks(
        &self,
        run_id: &str,
        parent_op_key: Option<&str>,
    ) -> Result<Vec<AgentTaskRecord>> {
        let sql = if parent_op_key.is_some() {
            "SELECT * FROM agent_tasks WHERE run_id = ? AND parent_op_key = ? ORDER BY order_index, child_key"
        } else {
            "SELECT * FROM agent_tasks WHERE run_id = ? ORDER BY parent_op_key, order_index, child_key"
        };
        let mut statement = self.conn.prepare(sql)?;
        let rows = if let Some(parent) = parent_op_key {
            statement.query_map(params![run_id, parent], row_to_agent_task_record)?
        } else {
            statement.query_map(params![run_id], row_to_agent_task_record)?
        };
        let mut tasks = Vec::new();
        for row in rows {
            tasks.push(row?);
        }
        Ok(tasks)
    }

    pub fn get_run_summary(&self, run_id: &str) -> Result<(Option<Value>, Vec<AgentTaskRecord>)> {
        Ok((self.get_run(run_id)?, self.list_agent_tasks(run_id, None)?))
    }
}

pub struct EnsureAgentTask<'a> {
    pub run_id: &'a str,
    pub child_key: &'a str,
    pub parent_op_key: &'a str,
    pub task_id: &'a str,
    pub phase: &'a str,
    pub adapter: &'a str,
    pub mode: &'a str,
    pub order_index: i64,
    pub task: &'a Value,
    pub context_cwd: Option<&'a str>,
    pub status: Option<&'a str>,
}

fn run_row_to_value(row: &Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>("id")?,
        "manifest_json": row.get::<_, String>("manifest_json")?,
        "source_hash": row.get::<_, String>("source_hash")?,
        "manifest_hash": row.get::<_, String>("manifest_hash")?,
        "approval_hash": row.get::<_, String>("approval_hash")?,
        "status": row.get::<_, String>("status")?,
        "pid": row.get::<_, Option<i64>>("pid")?,
        "heartbeat_at": row.get::<_, Option<String>>("heartbeat_at")?,
        "created_at": row.get::<_, String>("created_at")?,
        "updated_at": row.get::<_, String>("updated_at")?
    }))
}

fn row_to_agent_task_record(row: &Row<'_>) -> rusqlite::Result<AgentTaskRecord> {
    let task_json: String = row.get("task_json")?;
    let result_json: Option<String> = row.get("result_json")?;
    Ok(AgentTaskRecord {
        run_id: row.get("run_id")?,
        child_key: row.get("child_key")?,
        parent_op_key: row.get("parent_op_key")?,
        task_id: row.get("task_id")?,
        phase: row.get("phase")?,
        adapter: row.get("adapter")?,
        mode: row.get("mode")?,
        order_index: row.get("order_index")?,
        status: row.get("status")?,
        task: serde_json::from_str(&task_json).unwrap_or(Value::Null),
        context_cwd: row.get("context_cwd")?,
        lease_token: row.get("lease_token")?,
        lease_expires_at: row.get("lease_expires_at")?,
        agent_ref: row.get("agent_ref")?,
        result: result_json.and_then(|raw| serde_json::from_str::<AdapterResult>(&raw).ok()),
        error: row.get("error")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn record_to_dispatch(record: &AgentTaskRecord) -> Result<NativeDispatch> {
    let task = record
        .task
        .as_object()
        .ok_or_else(|| anyhow!("agent task JSON must be an object"))?;
    Ok(NativeDispatch {
        run_id: record.run_id.clone(),
        child_key: record.child_key.clone(),
        parent_op_key: record.parent_op_key.clone(),
        task_id: record.task_id.clone(),
        phase: record.phase.clone(),
        adapter: record.adapter.clone(),
        mode: record.mode.clone(),
        prompt: task
            .get("prompt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        schema: task
            .get("schema")
            .and_then(Value::as_str)
            .map(str::to_string),
        data: task.get("data").cloned(),
        cwd: record.context_cwd.clone().unwrap_or_default(),
        lease_token: record
            .lease_token
            .clone()
            .ok_or_else(|| anyhow!("leased dispatch has no lease token"))?,
        lease_expires_at: record
            .lease_expires_at
            .clone()
            .ok_or_else(|| anyhow!("leased dispatch has no lease expiry"))?,
        model: task
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_string),
        reasoning_effort: task
            .get("reasoningEffort")
            .and_then(Value::as_str)
            .map(str::to_string),
        network: task
            .get("network")
            .and_then(Value::as_str)
            .map(str::to_string),
        role: task.get("role").and_then(Value::as_str).map(str::to_string),
        nickname: task
            .get("nickname")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn agent_event_type(status: &str) -> &'static str {
    match status {
        "completed" => "agent.completed",
        "failed" => "agent.failed",
        "blocked" => "agent.blocked",
        _ => "agent.status",
    }
}

fn is_safe_run_id(value: &str) -> bool {
    is_safe_id(value) && value.len() <= 160
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
