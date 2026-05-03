const STORE_KEY = "__AVSP_SNAPSHOT_EXPORT_PROGRESS_STORE__";
const STALE_TTL_MS = 15 * 60 * 1000;

function nowMs() {
  return Date.now();
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
  for (const [key, value] of store.entries()) {
    const updatedAt = Number(value?.updated_at_ms || 0);
    if (updatedAt > 0 && updatedAt < threshold) {
      store.delete(key);
    }
  }
}

export function setSnapshotExportProgress(exportId, patch = {}) {
  const id = String(exportId || "").trim();
  if (!id) return;
  const store = getStore();
  cleanupStaleEntries(store);
  const prev = store.get(id) || {};
  const next = {
    ...prev,
    ...patch,
    export_id: id,
    updated_at_ms: nowMs(),
  };
  store.set(id, next);
}

export function getSnapshotExportProgress(exportId) {
  const id = String(exportId || "").trim();
  if (!id) return null;
  const store = getStore();
  cleanupStaleEntries(store);
  return store.get(id) || null;
}

export function clearSnapshotExportProgress(exportId) {
  const id = String(exportId || "").trim();
  if (!id) return;
  const store = getStore();
  store.delete(id);
}
