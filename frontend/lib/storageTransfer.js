import { gunzipSync } from "zlib";

export const SNAPSHOT_FORMAT_FULL = "avsp.storage.snapshot.v1";
export const SNAPSHOT_FORMAT_VLM = "avsp.vlm.annotations.v1";
export const SNAPSHOT_FORMAT_EMBEDDINGS = "avsp.embedder.annotations.v1";

export const SNAPSHOT_KIND_FULL = "full";
export const SNAPSHOT_KIND_VLM = "vlm";
export const SNAPSHOT_KIND_EMBEDDINGS = "embeddings";

export function masterEndpoint() {
  return (process.env.MASTER_ENDPOINT || "http://localhost:9002").replace(/\/$/, "");
}

export function chunkArray(values, chunkSize) {
  const size = Math.max(1, Number(chunkSize || 1));
  const out = [];
  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size));
  }
  return out;
}

export async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

export async function readMasterJson(path, init = {}) {
  const response = await fetch(`${masterEndpoint()}${path}`, init);
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    const message = payload?.detail || payload?.error || response.statusText;
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export function buildSnapshotFilename(kind, timestampIso) {
  const safeKind = String(kind || "snapshot").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  const safeTime = String(timestampIso || new Date().toISOString()).replace(/[:.]/g, "-");
  return `avsp-${safeKind}-${safeTime}.json`;
}

export async function readRequestBuffer(req, maxBytes) {
  const limit = Math.max(1, Number(maxBytes || 1));
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += piece.length;
    if (total > limit) {
      const error = new Error(`Snapshot payload exceeds limit (${limit} bytes)`);
      error.status = 413;
      throw error;
    }
    chunks.push(piece);
  }

  return Buffer.concat(chunks);
}

export function parseSnapshotBuffer(rawBuffer) {
  if (!rawBuffer || rawBuffer.length === 0) {
    const error = new Error("Empty snapshot payload");
    error.status = 400;
    throw error;
  }

  let jsonBuffer = rawBuffer;
  const isGzip = rawBuffer.length >= 2 && rawBuffer[0] === 0x1f && rawBuffer[1] === 0x8b;
  if (isGzip) {
    try {
      jsonBuffer = gunzipSync(rawBuffer);
    } catch {
      const error = new Error("Invalid gzip snapshot payload");
      error.status = 400;
      throw error;
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonBuffer.toString("utf8"));
  } catch {
    const error = new Error("Snapshot file must be valid JSON");
    error.status = 400;
    throw error;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const error = new Error("Snapshot root must be a JSON object");
    error.status = 400;
    throw error;
  }
  return parsed;
}
