const STORE_KEY = "__AVSP_SNAPSHOT_TRANSFER_JOBS_STORE__";
const STALE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_LOG_LINES = 5000;
const DEFAULT_SNAPSHOT_JOB_TYPE = "snapshot_export";

function nowMs() {
  return Date.now();
}

function nowSec() {
  return Math.floor(nowMs() / 1000);
}

function formatLogTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function getStore() {
  const root = globalThis;
  if (!root[STORE_KEY]) {
    root[STORE_KEY] = new Map();
  }
  return root[STORE_KEY];
}

function cleanupStaleEntries(store) {
  const threshold = nowMs() - STALE_TTL_MS;
  for (const [key, job] of store.entries()) {
    const updatedAtSec = Number(job?.updated_at || 0);
    const updatedAtMs = updatedAtSec > 0 ? updatedAtSec * 1000 : 0;
    if (updatedAtMs > 0 && updatedAtMs < threshold) {
      store.delete(key);
    }
  }
}

function toStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (status === "running") return "running";
  if (status === "success") return "success";
  if (status === "error") return "error";
  if (status === "cancelled") return "cancelled";
  return "running";
}

function defaultJob(jobId, jobType, jobConfig = {}) {
  const ts = nowSec();
  return {
    job_id: jobId,
    job_type: jobType,
    status: "running",
    cancel_requested: false,
    progress: 0,
    total_seen: 0,
    total_inserted: 0,
    total_embeddings_inserted: 0,
    total_limit: 0,
    total_planned: 0,
    total_tasks_completed: 0,
    total_tasks_planned: 0,
    current_scene_tasks_completed: 0,
    current_scene_tasks_total: 0,
    current_scene_index: 0,
    extract_scene_tasks_completed: 0,
    extract_scene_tasks_total: 0,
    extract_scene_index: 0,
    embedding_tasks_completed: 0,
    embedding_tasks_total: 0,
    embedding_worker_running: false,
    job_log: [],
    job_log_path: "",
    errors: [],
    job_config: jobConfig,
    created_at: ts,
    updated_at: ts,
  };
}

export function ensureSnapshotTransferJob(jobId, jobType, jobConfig = {}) {
  const id = String(jobId || "").trim();
  if (!id) return null;
  const type = String(jobType || DEFAULT_SNAPSHOT_JOB_TYPE).trim() || DEFAULT_SNAPSHOT_JOB_TYPE;
  const store = getStore();
  cleanupStaleEntries(store);
  if (!store.has(id)) {
    store.set(id, defaultJob(id, type, jobConfig));
  }
  return store.get(id);
}

export function updateSnapshotTransferJob(jobId, patch = {}) {
  const id = String(jobId || "").trim();
  if (!id) return null;
  const store = getStore();
  cleanupStaleEntries(store);
  const prev =
    store.get(id) ||
    defaultJob(id, String(patch.job_type || DEFAULT_SNAPSHOT_JOB_TYPE));
  const next = {
    ...prev,
    ...patch,
    status: toStatus(patch.status ?? prev.status),
    updated_at: nowSec(),
  };
  store.set(id, next);
  return next;``
}

export function appendSnapshotTransferJobLog(jobId, line) {
  const id = String(jobId || "").trim();
  const text = String(line || "").trim();
  if (!id || !text) return null;
  const job = updateSnapshotTransferJob(id, {});
  const logs = Array.isArray(job.job_log) ? [...job.job_log] : [];
  logs.push(`[${formatLogTimestamp()}] ${text}`);
  if (logs.length > MAX_LOG_LINES) {
    logs.splice(0, logs.length - MAX_LOG_LINES);
  }
  return updateSnapshotTransferJob(id, { job_log: logs });
}

export function setSnapshotTransferJobError(jobId, errorText) {
  const text = String(errorText || "").trim();
  if (!text) return null;
  const job = updateSnapshotTransferJob(jobId, {});
  const errors = Array.isArray(job.errors) ? [...job.errors] : [];
  errors.push({ error: text });
  if (errors.length > 200) {
    errors.splice(0, errors.length - 200);
  }
  return updateSnapshotTransferJob(jobId, { errors });
}

export function listSnapshotTransferJobs() {
  const store = getStore();
  cleanupStaleEntries(store);
  return Array.from(store.values()).map((job) => ({ ...job }));
}

export function getSnapshotTransferJob(jobId) {
  const id = String(jobId || "").trim();
  if (!id) return null;
  const store = getStore();
  cleanupStaleEntries(store);
  const job = store.get(id);
  return job ? { ...job } : null;
}

export function isSnapshotTransferJobCancelRequested(jobId) {
  const job = getSnapshotTransferJob(jobId);
  return Boolean(job?.cancel_requested);
}

export function requestSnapshotTransferJobCancel(jobId) {
  const id = String(jobId || "").trim();
  if (!id) return null;
  const job = updateSnapshotTransferJob(id, { cancel_requested: true });
  if (!job) return null;
  appendSnapshotTransferJobLog(id, "Cancellation requested.");
  return updateSnapshotTransferJob(id, {});
}
