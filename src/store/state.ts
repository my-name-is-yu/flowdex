import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AdapterResult, AgentTaskRecord, AgentTaskStatus, CanonicalValue, NativeDispatch } from "../types.js";
import type { ArtifactRecord } from "../types.js";
import { agentTaskStatusForResult } from "../runtime/adapterResult.js";
import { stableStringify } from "../util/hash.js";

export class FlowdexState {
  readonly db: DatabaseSync;
  readonly jsonlPath: string;

  constructor(readonly filePath: string) {
    this.jsonlPath = path.join(path.dirname(filePath), "events.jsonl");
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
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
    `);
    try {
      this.db.exec("ALTER TABLE runs ADD COLUMN pid INTEGER");
    } catch {}
    try {
      this.db.exec("ALTER TABLE runs ADD COLUMN heartbeat_at TEXT");
    } catch {}
  }

  static async openRun(root: string, runId: string): Promise<FlowdexState> {
    const directory = FlowdexState.runDirectory(root, runId);
    await mkdir(directory, { recursive: true });
    return new FlowdexState(path.join(directory, "state.sqlite"));
  }

  static async openExistingRun(root: string, runId: string): Promise<FlowdexState | undefined> {
    const filePath = path.join(FlowdexState.runDirectory(root, runId), "state.sqlite");
    try {
      if (!(await stat(filePath)).isFile()) return undefined;
    } catch {
      return undefined;
    }
    const state = new FlowdexState(filePath);
    if (state.getRun(runId)) return state;
    state.close();
    return undefined;
  }

  static async runDirectoryExists(root: string, runId: string): Promise<boolean> {
    try {
      return (await stat(FlowdexState.runDirectory(root, runId))).isDirectory();
    } catch {
      return false;
    }
  }

  static runDirectory(root: string, runId: string): string {
    if (!isSafeRunId(runId)) throw new Error(`unsafe Flowdex run id: ${runId}`);
    return path.join(root, ".flowdex", "runs", runId);
  }

  static async listRunIds(root: string): Promise<string[]> {
    const directory = path.join(root, ".flowdex", "runs");
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    } catch {
      return [];
    }
  }

  createRun(metadata: {
    id: string;
    manifest: unknown;
    sourceHash: string;
    manifestHash: string;
    approvalHash: string;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO runs (id, manifest_json, source_hash, manifest_hash, approval_hash, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`
      )
      .run(
        metadata.id,
        stableStringify(metadata.manifest),
        metadata.sourceHash,
        metadata.manifestHash,
        metadata.approvalHash,
        now,
        now
      );
    this.addEvent(metadata.id, "run.created", metadata.manifest);
  }

  setRunStatus(runId: string, status: string): void {
    this.db.prepare("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?").run(status, new Date().toISOString(), runId);
    this.addEvent(runId, "run.status", { status });
  }

  heartbeat(runId: string, pid = process.pid): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE runs SET pid = ?, heartbeat_at = ?, updated_at = ? WHERE id = ?").run(pid, now, now, runId);
    this.addEvent(runId, "run.heartbeat", { pid });
  }

  getRunStatus(runId: string): string | undefined {
    const row = this.db.prepare("SELECT status FROM runs WHERE id = ?").get(runId);
    return row ? String(row.status) : undefined;
  }

  addEvent(runId: string, type: string, payload: unknown): void {
    const result = this.db
      .prepare("INSERT INTO events (run_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)")
      .run(runId, type, JSON.stringify(payload), new Date().toISOString());
    appendFileSync(
      this.jsonlPath,
      `${JSON.stringify({ seq: Number(result.lastInsertRowid), runId, type, payload, createdAt: new Date().toISOString() })}\n`
    );
  }

  saveTaskResult(runId: string, opKey: string, status: string, result: unknown): void {
    this.db
      .prepare(
        `INSERT INTO task_results (run_id, op_key, result_json, status, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(run_id, op_key) DO UPDATE SET result_json = excluded.result_json, status = excluded.status, updated_at = excluded.updated_at`
      )
      .run(runId, opKey, stableStringify(result), status, new Date().toISOString());
    this.addEvent(runId, "task.result", { opKey, status });
  }

  saveArtifact(runId: string, artifact: ArtifactRecord): void {
    this.db
      .prepare(
        `INSERT INTO artifacts (run_id, artifact_id, payload_json)
         VALUES (?, ?, ?)
         ON CONFLICT(run_id, artifact_id) DO UPDATE SET payload_json = excluded.payload_json`
      )
      .run(runId, artifact.id, JSON.stringify(artifact));
    this.addEvent(runId, "artifact.written", { artifactId: artifact.id, mediaType: artifact.mediaType, size: artifact.size });
  }

  listArtifacts(runId: string): ArtifactRecord[] {
    return this.db.prepare("SELECT payload_json FROM artifacts WHERE run_id = ?").all(runId).map((row) => JSON.parse(String(row.payload_json)) as ArtifactRecord);
  }

  getCompletedResults(runId: string): Record<string, CanonicalValue> {
    const rows = this.db.prepare("SELECT op_key, result_json FROM task_results WHERE run_id = ? AND status = 'completed'").all(runId);
    const results: Record<string, CanonicalValue> = Object.create(null);
    for (const row of rows) {
      results[String(row.op_key)] = JSON.parse(String(row.result_json)) as CanonicalValue;
    }
    return results;
  }

  listEvents(runId: string): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT seq, type, payload_json, created_at FROM events WHERE run_id = ? ORDER BY seq").all(runId);
  }

  getRun(runId: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
  }

  getLatestCompletedReport(runId: string): unknown {
    const row = this.db
      .prepare("SELECT payload_json FROM events WHERE run_id = ? AND type = 'workflow.completed' ORDER BY seq DESC LIMIT 1")
      .get(runId);
    return row ? JSON.parse(String(row.payload_json)) : undefined;
  }

  deleteTaskResult(runId: string, opKey: string): void {
    const task = this.getAgentTask(runId, opKey);
    const resultKeys = new Set([opKey]);
    if (task) resultKeys.add(task.parentOpKey);
    for (const resultKey of resultKeys) {
      this.db.prepare("DELETE FROM task_results WHERE run_id = ? AND op_key = ?").run(runId, resultKey);
    }
    this.db
      .prepare(
        `UPDATE agent_tasks
         SET status = 'pending', lease_token = NULL, lease_expires_at = NULL, agent_ref = NULL,
             result_json = NULL, error = NULL, updated_at = ?
         WHERE run_id = ? AND (child_key = ? OR parent_op_key = ?)`
      )
      .run(new Date().toISOString(), runId, opKey, opKey);
    this.addEvent(runId, "task.invalidated", { opKey, resultKeys: [...resultKeys] });
  }

  ensureAgentTask(record: {
    runId: string;
    childKey: string;
    parentOpKey: string;
    taskId: string;
    phase: string;
    adapter: string;
    mode: "read-only" | "write";
    orderIndex: number;
    task: unknown;
    contextCwd?: string | undefined;
    status?: AgentTaskStatus | undefined;
  }): AgentTaskRecord {
    const existing = this.getAgentTask(record.runId, record.childKey);
    if (existing) return existing;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO agent_tasks
         (run_id, child_key, parent_op_key, task_id, phase, adapter, mode, order_index, status,
          task_json, context_cwd, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.runId,
        record.childKey,
        record.parentOpKey,
        record.taskId,
        record.phase,
        record.adapter,
        record.mode,
        record.orderIndex,
        record.status ?? "pending",
        stableStringify(record.task),
        record.contextCwd ?? null,
        now,
        now
      );
    this.addEvent(record.runId, "agent.task.created", {
      childKey: record.childKey,
      parentOpKey: record.parentOpKey,
      taskId: record.taskId,
      phase: record.phase,
      adapter: record.adapter,
      mode: record.mode,
      status: record.status ?? "pending"
    });
    return this.getAgentTask(record.runId, record.childKey)!;
  }

  updateAgentTaskStatus(
    runId: string,
    childKey: string,
    status: AgentTaskStatus,
    updates: {
      contextCwd?: string | undefined;
      result?: AdapterResult | undefined;
      error?: string | null | undefined;
    } = {}
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE agent_tasks
         SET status = ?,
             context_cwd = COALESCE(?, context_cwd),
             result_json = COALESCE(?, result_json),
             error = ?,
             updated_at = ?
         WHERE run_id = ? AND child_key = ?`
      )
      .run(
        status,
        updates.contextCwd ?? null,
        updates.result ? stableStringify(updates.result) : null,
        updates.error ?? null,
        now,
        runId,
        childKey
      );
    this.addEvent(runId, agentEventType(status), {
      childKey,
      status,
      ...(updates.contextCwd ? { contextCwd: updates.contextCwd } : {}),
      ...(updates.result ? { summary: updates.result.summary, adapterStatus: updates.result.status } : {}),
      ...(updates.error ? { error: updates.error } : {})
    });
  }

  markAgentDispatchable(runId: string, childKey: string, contextCwd: string): void {
    this.db
      .prepare(
        `UPDATE agent_tasks
         SET status = 'dispatchable', context_cwd = ?, updated_at = ?
         WHERE run_id = ? AND child_key = ? AND status IN ('pending', 'dispatchable')`
      )
      .run(contextCwd, new Date().toISOString(), runId, childKey);
    this.addEvent(runId, "native.dispatch.created", { childKey, contextCwd });
  }

  leaseDispatches(runId: string, limit: number, leaseMs = 30 * 60 * 1000): NativeDispatch[] {
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
    const dispatches: NativeDispatch[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const runStatus = this.getRunStatus(runId);
      if (runStatus === "paused" || runStatus === "stopped") {
        throw new Error(`cannot lease native dispatches for ${runStatus} run: ${runId}`);
      }
      const active = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM agent_tasks
           WHERE run_id = ?
             AND status IN ('leased', 'dispatched')
             AND (lease_expires_at IS NULL OR lease_expires_at >= ?)`
        )
        .get(runId, nowIso);
      const available = Math.max(0, limit - Number(active?.count ?? 0));
      if (available === 0) {
        this.db.exec("COMMIT");
        return dispatches;
      }
      const rows = this.db
        .prepare(
          `SELECT * FROM agent_tasks
           WHERE run_id = ?
             AND (
               status = 'dispatchable'
               OR (status IN ('leased', 'dispatched') AND lease_expires_at IS NOT NULL AND lease_expires_at < ?)
           )
           ORDER BY order_index, child_key
           LIMIT ?`
        )
        .all(runId, nowIso, available);
      const update = this.db.prepare(
        `UPDATE agent_tasks
         SET status = 'leased', lease_token = ?, lease_expires_at = ?, updated_at = ?
         WHERE run_id = ? AND child_key = ?
           AND (
             status = 'dispatchable'
             OR (status IN ('leased', 'dispatched') AND lease_expires_at IS NOT NULL AND lease_expires_at < ?)
           )`
      );
      for (const row of rows) {
        const leaseToken = randomUUID();
        const result = update.run(leaseToken, expiresAt, nowIso, runId, String(row.child_key), nowIso);
        if (result.changes !== 1) continue;
        const record = rowToAgentTaskRecord({ ...row, status: "leased", lease_token: leaseToken, lease_expires_at: expiresAt });
        dispatches.push(recordToDispatch(record, leaseToken, expiresAt));
        this.addEvent(runId, "native.dispatch.leased", { childKey: record.childKey, leaseToken, leaseExpiresAt: expiresAt });
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return dispatches;
  }

  attachAgent(runId: string, childKey: string, leaseToken: string, agentRef: string): void {
    const task = this.getAgentTask(runId, childKey);
    if (!task) throw new Error(`unknown child task: ${childKey}`);
    if (task.leaseToken !== leaseToken) throw new Error(`lease token mismatch for ${childKey}`);
    if (task.status !== "leased" && task.status !== "dispatched") throw new Error(`child task is not leased: ${childKey}`);
    this.db
      .prepare("UPDATE agent_tasks SET status = 'dispatched', agent_ref = ?, updated_at = ? WHERE run_id = ? AND child_key = ?")
      .run(agentRef, new Date().toISOString(), runId, childKey);
    this.addEvent(runId, "native.dispatch.attached", { childKey, agentRef });
  }

  completeAgentTask(runId: string, childKey: string, leaseToken: string, result: AdapterResult): void {
    const task = this.getAgentTask(runId, childKey);
    if (!task) throw new Error(`unknown child task: ${childKey}`);
    if (task.leaseToken !== leaseToken) throw new Error(`lease token mismatch for ${childKey}`);
    if (task.status !== "leased" && task.status !== "dispatched") throw new Error(`child task is not leased: ${childKey}`);
    const status = agentTaskStatusForResult(result);
    this.updateAgentTaskStatus(runId, childKey, status, { result, error: result.error });
    if (task.parentOpKey === childKey) {
      this.saveTaskResult(runId, task.parentOpKey, "completed", result);
    }
  }

  getAgentTask(runId: string, childKey: string): AgentTaskRecord | undefined {
    const row = this.db.prepare("SELECT * FROM agent_tasks WHERE run_id = ? AND child_key = ?").get(runId, childKey);
    return row ? rowToAgentTaskRecord(row) : undefined;
  }

  listAgentTasks(runId: string, parentOpKey?: string): AgentTaskRecord[] {
    const rows = parentOpKey
      ? this.db
          .prepare("SELECT * FROM agent_tasks WHERE run_id = ? AND parent_op_key = ? ORDER BY order_index, child_key")
          .all(runId, parentOpKey)
      : this.db.prepare("SELECT * FROM agent_tasks WHERE run_id = ? ORDER BY parent_op_key, order_index, child_key").all(runId);
    return rows.map(rowToAgentTaskRecord);
  }

  getRunSummary(runId: string): { run: Record<string, unknown> | undefined; tasks: AgentTaskRecord[] } {
    return { run: this.getRun(runId), tasks: this.listAgentTasks(runId) };
  }

  close(): void {
    this.db.close();
  }
}

function agentEventType(status: AgentTaskStatus): string {
  if (status === "completed") return "agent.completed";
  if (status === "failed") return "agent.failed";
  if (status === "blocked") return "agent.blocked";
  return "agent.status";
}

function rowToAgentTaskRecord(row: Record<string, unknown>): AgentTaskRecord {
  const resultJson = row.result_json === null || row.result_json === undefined ? undefined : String(row.result_json);
  return {
    runId: String(row.run_id),
    childKey: String(row.child_key),
    parentOpKey: String(row.parent_op_key),
    taskId: String(row.task_id),
    phase: String(row.phase),
    adapter: String(row.adapter),
    mode: row.mode === "write" ? "write" : "read-only",
    orderIndex: Number(row.order_index),
    status: String(row.status) as AgentTaskStatus,
    task: JSON.parse(String(row.task_json)) as CanonicalValue,
    contextCwd: row.context_cwd === null || row.context_cwd === undefined ? undefined : String(row.context_cwd),
    leaseToken: row.lease_token === null || row.lease_token === undefined ? undefined : String(row.lease_token),
    leaseExpiresAt: row.lease_expires_at === null || row.lease_expires_at === undefined ? undefined : String(row.lease_expires_at),
    agentRef: row.agent_ref === null || row.agent_ref === undefined ? undefined : String(row.agent_ref),
    result: resultJson ? (JSON.parse(resultJson) as AdapterResult) : undefined,
    error: row.error === null || row.error === undefined ? undefined : String(row.error),
    createdAt: row.created_at === null || row.created_at === undefined ? undefined : String(row.created_at),
    updatedAt: row.updated_at === null || row.updated_at === undefined ? undefined : String(row.updated_at)
  };
}

function recordToDispatch(record: AgentTaskRecord, leaseToken: string, leaseExpiresAt: string): NativeDispatch {
  const task = record.task as Record<string, CanonicalValue>;
  return {
    runId: record.runId,
    childKey: record.childKey,
    parentOpKey: record.parentOpKey,
    taskId: record.taskId,
    phase: record.phase,
    adapter: record.adapter,
    mode: record.mode,
    prompt: String(task.prompt ?? ""),
    ...(typeof task.schema === "string" ? { schema: task.schema } : {}),
    ...(task.data !== undefined ? { data: task.data } : {}),
    cwd: record.contextCwd ?? "",
    leaseToken,
    leaseExpiresAt,
    ...(typeof task.model === "string" ? { model: task.model } : {}),
    ...(typeof task.reasoningEffort === "string" ? { reasoningEffort: task.reasoningEffort } : {}),
    ...(task.network === "none" || task.network === "web" ? { network: task.network } : {}),
    ...(typeof task.role === "string" ? { role: task.role } : {}),
    ...(typeof task.nickname === "string" ? { nickname: task.nickname } : {})
  };
}

function isSafeRunId(value: string): boolean {
  return /^[A-Za-z0-9_.-]{1,160}$/.test(value) && value !== "." && value !== "..";
}
