import { createReadStream } from "fs";
import { access, mkdir, readFile } from "fs/promises";
import path from "path";
import readline from "readline";
import { randomUUID } from "crypto";

import {
  storageEndpoint,
  storageWriteHeaders,
  readStorageJson,
} from "../../../../lib/storageServer";
import {
  SNAPSHOT_FORMAT_EMBEDDINGS,
  SNAPSHOT_FORMAT_FULL,
  SNAPSHOT_FORMAT_VLM,
  cleanupTempDir,
  createTempDir,
  createTransferCancelledError,
  extractTarGzToDirectory,
  readMasterJson,
  writeRequestToFile,
} from "../../../../lib/storageTransfer";
import {
  appendSnapshotTransferJobLog,
  ensureSnapshotTransferJob,
  isSnapshotTransferJobCancelRequested,
  setSnapshotTransferJobError,
  updateSnapshotTransferJob,
} from "../../../../lib/snapshotTransferJobs";

const DEFAULT_MAX_IMPORT_BYTES = 16 * 1024 * 1024 * 1024;
const EMBEDDINGS_BATCH_SIZE = 128;
const VLM_BATCH_SIZE = 500;

export const config = {
  api: {
    bodyParser: false,
    responseLimit: false,
  },
};

function normalizeImportId(rawImportId) {
  return String(rawImportId || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "")
    .slice(0, 128);
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveArchivePath(rootDir, relativePath) {
  const normalized = path.normalize(String(relativePath || "").trim());
  const resolved = path.resolve(rootDir, normalized);
  const base = path.resolve(rootDir);
  if (!resolved.startsWith(`${base}${path.sep}`) && resolved !== base) {
    throw new Error(`Unsafe archive path: ${relativePath}`);
  }
  return resolved;
}

async function readJsonFileOrDefault(filePath, fallbackValue) {
  if (!(await fileExists(filePath))) {
    return fallbackValue;
  }
  const raw = await readFile(filePath, "utf8");
  if (!raw.trim()) {
    return fallbackValue;
  }
  const parsed = JSON.parse(raw);
  return parsed;
}

function createAbortState(req, res) {
  const state = { aborted: false, reason: "" };
  const markAborted = (reason) => {
    state.aborted = true;
    if (!state.reason && reason) {
      state.reason = String(reason);
    }
  };
  req.on("aborted", () => markAborted("request_aborted"));
  req.on("close", () => {
    if (!req.complete || req.aborted) {
      markAborted("request_closed_incomplete");
    }
  });
  res.on("close", () => {
    if (!res.writableEnded) {
      markAborted("response_closed_early");
    }
  });
  return {
    isAborted: () => state.aborted,
    reason: () => state.reason || "",
    assertNotAborted: () => {
      if (state.aborted) {
        throw createTransferCancelledError();
      }
    },
  };
}

async function processNdjson(filePath, onItem, options = {}) {
  if (!(await fileExists(filePath))) {
    return 0;
  }

  const input = createReadStream(filePath, { encoding: "utf8" });
  const reader = readline.createInterface({
    input,
    crlfDelay: Infinity,
  });

  let processed = 0;
  for await (const rawLine of reader) {
    if (typeof options.assertNotAborted === "function") {
      options.assertNotAborted();
    }
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    await onItem(parsed);
    processed += 1;
  }

  return processed;
}

async function uploadObjectFromArchive(extractRoot, item, options = {}) {
  if (typeof options.assertNotAborted === "function") {
    options.assertNotAborted();
  }
  const objectID = String(item?.object_id || "").trim();
  const bucket = String(item?.bucket || "").trim();
  const key = String(item?.key || "").trim();
  const contentType = String(item?.content_type || "application/octet-stream").trim();
  const objectFile = String(item?.object_file || "").trim();

  if (!bucket || !key || !objectFile) {
    return { object_id: objectID, uploaded: false, error: "bucket/key/object_file are required" };
  }

  const objectFilePath = resolveArchivePath(extractRoot, objectFile);
  if (!(await fileExists(objectFilePath))) {
    return { object_id: objectID, uploaded: false, error: `missing object file: ${objectFile}` };
  }

  const bytes = await readFile(objectFilePath);
  if (!bytes || bytes.length === 0) {
    return { object_id: objectID, uploaded: false, error: "empty object payload" };
  }

  const form = new FormData();
  form.append("bucket", bucket);
  form.append("key", key);
  form.append(
    "file",
    new Blob([bytes], { type: contentType }),
    key.split("/").pop() || `${objectID || "object"}.bin`
  );

  try {
    const response = await fetch(`${storageEndpoint()}/objects/upload`, {
      method: "POST",
      headers: {
        ...storageWriteHeaders(),
      },
      body: form,
    });
    const payload = await response.text();
    if (!response.ok) {
      let message = response.statusText || "upload failed";
      if (payload) {
        try {
          const parsed = JSON.parse(payload);
          message = parsed?.detail || parsed?.error || message;
        } catch {
          message = payload || message;
        }
      }
      return { object_id: objectID, uploaded: false, error: message };
    }
    return { object_id: objectID, uploaded: true, error: "" };
  } catch (error) {
    return { object_id: objectID, uploaded: false, error: error.message || "upload failed" };
  }
}

function normalizeVectorRow(row) {
  const objectID = String(row?.object_id || "").trim();
  const embedding = Array.isArray(row?.embedding)
    ? row.embedding.map((value) => Number(value)).filter((value) => Number.isFinite(value))
    : [];
  if (!objectID || embedding.length === 0) {
    return null;
  }
  return { object_id: objectID, embedding };
}

async function importEmbeddingsFromNdjson(filePath, options = {}) {
  let received = 0;
  let valid = 0;
  let upserted = 0;
  let batch = [];

  const flushBatch = async () => {
    if (typeof options.assertNotAborted === "function") {
      options.assertNotAborted();
    }
    if (batch.length === 0) {
      return;
    }
    const payload = await readStorageJson("/vectors/upsert", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...storageWriteHeaders(),
      },
      body: JSON.stringify({ vectors: batch }),
    });
    upserted += Number(payload?.upserted || 0);
    batch = [];
  };

  await processNdjson(filePath, async (row) => {
    received += 1;
    const normalized = normalizeVectorRow(row);
    if (!normalized) {
      return;
    }
    valid += 1;
    batch.push(normalized);
    if (batch.length >= EMBEDDINGS_BATCH_SIZE) {
      await flushBatch();
    }
    if (typeof options.onProgress === "function" && received % 2000 === 0) {
      options.onProgress({ section: "embeddings", received, valid, upserted });
    }
  }, options);

  await flushBatch();
  return { received, valid, upserted };
}

function normalizeFieldRows(fields) {
  const normalized = [];
  for (const field of fields) {
    const name = String(field?.field_name || field?.name || "").trim();
    const prompt = String(field?.prompt || "").trim();
    const responseType = String(field?.response_type || "text").trim();
    if (!name || !prompt) {
      continue;
    }
    normalized.push({ name, prompt, response_type: responseType });
  }
  return normalized;
}

function normalizeVlmAnnotation(row) {
  const objectID = String(row?.object_id || "").trim();
  const rawValues = row?.values;
  if (!objectID || !rawValues || typeof rawValues !== "object" || Array.isArray(rawValues)) {
    return null;
  }
  const values = {};
  for (const [key, value] of Object.entries(rawValues)) {
    const normalizedKey = String(key || "").trim();
    const normalizedValue = String(value || "").trim();
    if (!normalizedKey || !normalizedValue) {
      continue;
    }
    values[normalizedKey] = normalizedValue;
  }
  if (Object.keys(values).length === 0) {
    return null;
  }
  return { object_id: objectID, values };
}

async function importVlmFromArchive(extractRoot, options = {}) {
  if (typeof options.assertNotAborted === "function") {
    options.assertNotAborted();
  }
  const fieldsPath = resolveArchivePath(extractRoot, options.fieldsFile || "fields.json");
  const annotationsPath = resolveArchivePath(extractRoot, options.annotationsFile || "vlm.ndjson");

  const rawFields = await readJsonFileOrDefault(fieldsPath, []);
  const normalizedFields = normalizeFieldRows(Array.isArray(rawFields) ? rawFields : []);

  let savedFields = 0;
  if (normalizedFields.length > 0) {
    const fieldsPayload = await readMasterJson("/vlm/fields", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: normalizedFields }),
    });
    savedFields = Array.isArray(fieldsPayload?.fields) ? fieldsPayload.fields.length : 0;
  }

  let receivedAnnotations = 0;
  let validAnnotations = 0;
  let upsertedAnnotations = 0;
  let batch = [];

  const flushBatch = async () => {
    if (typeof options.assertNotAborted === "function") {
      options.assertNotAborted();
    }
    if (batch.length === 0) {
      return;
    }
    const payload = await readMasterJson("/vlm/annotations/upsert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows: batch }),
    });
    upsertedAnnotations += Number(payload?.upserted || 0);
    batch = [];
  };

  await processNdjson(annotationsPath, async (row) => {
    receivedAnnotations += 1;
    const normalized = normalizeVlmAnnotation(row);
    if (!normalized) {
      return;
    }
    validAnnotations += 1;
    batch.push(normalized);
    if (batch.length >= VLM_BATCH_SIZE) {
      await flushBatch();
    }
    if (typeof options.onProgress === "function" && receivedAnnotations % 2000 === 0) {
      options.onProgress({
        section: "vlm",
        received_annotations: receivedAnnotations,
        valid_annotations: validAnnotations,
        upserted_annotations: upsertedAnnotations,
      });
    }
  }, options);

  await flushBatch();

  return {
    received_fields: Array.isArray(rawFields) ? rawFields.length : 0,
    valid_fields: normalizedFields.length,
    saved_fields: savedFields,
    received_annotations: receivedAnnotations,
    valid_annotations: validAnnotations,
    upserted_annotations: upsertedAnnotations,
  };
}

async function importObjectsFromArchive(extractRoot, options = {}) {
  const objectsPath = resolveArchivePath(extractRoot, "objects.ndjson");

  let received = 0;
  let uploaded = 0;
  const errors = [];

  await processNdjson(objectsPath, async (row) => {
    received += 1;
    const result = await uploadObjectFromArchive(extractRoot, row, options);
    if (result.uploaded) {
      uploaded += 1;
      if (typeof options.onProgress === "function" && received % 500 === 0) {
        options.onProgress({ section: "objects", received, uploaded, failed: errors.length });
      }
      return;
    }
    errors.push({ object_id: result.object_id, error: result.error });
  }, options);

  return {
    received,
    uploaded,
    failed: errors.length,
    errors: errors.slice(0, 50),
  };
}

async function importSnapshotFromArchive(extractRoot, manifest, options = {}) {
  if (typeof options.assertNotAborted === "function") {
    options.assertNotAborted();
  }
  const format = String(manifest?.format || "").trim();

  if (format === SNAPSHOT_FORMAT_EMBEDDINGS) {
    return {
      format,
      embeddings: await importEmbeddingsFromNdjson(
        resolveArchivePath(extractRoot, "embeddings.ndjson"),
        options
      ),
    };
  }

  if (format === SNAPSHOT_FORMAT_VLM) {
    return {
      format,
      vlm: await importVlmFromArchive(extractRoot, options),
    };
  }

  if (format === SNAPSHOT_FORMAT_FULL) {
    return {
      format,
      objects: await importObjectsFromArchive(extractRoot, options),
      embeddings: await importEmbeddingsFromNdjson(
        resolveArchivePath(extractRoot, "embeddings.ndjson"),
        options
      ),
      vlm: await importVlmFromArchive(extractRoot, options),
    };
  }

  const error = new Error(`Unsupported snapshot format: ${format || "unknown"}`);
  error.status = 400;
  throw error;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const importId = normalizeImportId(req.query?.import_id);
  const jobId = randomUUID().replace(/-/g, "").slice(0, 16);
  const updateJob = (patch) => updateSnapshotTransferJob(jobId, patch);
  const appendLog = (text) => appendSnapshotTransferJobLog(jobId, text);
  const workDir = await createTempDir("avsp-transfer-import-");
  const { isAborted, reason: abortReason, assertNotAborted: assertClientNotAborted } =
    createAbortState(req, res);
  const assertNotAborted = () => {
    assertClientNotAborted();
    if (isSnapshotTransferJobCancelRequested(jobId)) {
      throw createTransferCancelledError("Transfer cancelled by user");
    }
  };
  const isStopped = () => isAborted() || isSnapshotTransferJobCancelRequested(jobId);
  const getCancelReason = () => {
    if (isSnapshotTransferJobCancelRequested(jobId)) {
      return "cancel_requested_by_user";
    }
    const reason = abortReason();
    return reason || "connection_interrupted";
  };

  try {
    const contentLength = Number(req.headers?.["content-length"] || 0);
    const expectedBytes = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0;
    ensureSnapshotTransferJob(jobId, "snapshot_import", {
      import_id: importId,
      content_length: expectedBytes,
    });
    updateJob({
      status: "running",
      progress: 0,
      phase: "uploading",
      total_seen: 0,
      total_limit: expectedBytes,
      total_planned: expectedBytes,
    });
    appendLog("Snapshot import started.");
    let lastUploadLoggedPct = -1;

    const parsedMaxBytes = Number(
      process.env.STORAGE_TRANSFER_IMPORT_MAX_BYTES || DEFAULT_MAX_IMPORT_BYTES
    );
    const maxBytes =
      Number.isFinite(parsedMaxBytes) && parsedMaxBytes > 0
        ? parsedMaxBytes
        : DEFAULT_MAX_IMPORT_BYTES;

    const archivePath = path.join(workDir, "snapshot.tar.gz");
    const uploadedBytes = await writeRequestToFile(req, archivePath, maxBytes, {
      isAborted: isStopped,
      onChunk: (_chunkSize, total) => {
        const uploaded = Math.max(0, Number(total || 0));
        const progress =
          expectedBytes > 0 ? Math.min(55, Math.round((uploaded / expectedBytes) * 55)) : 0;
        if (expectedBytes > 0) {
          const uploadPct = Math.max(0, Math.min(100, Math.floor((uploaded / expectedBytes) * 100)));
          const bucket = Math.floor(uploadPct / 10) * 10;
          if (bucket >= 0 && bucket !== lastUploadLoggedPct) {
            lastUploadLoggedPct = bucket;
            appendLog(
              `Upload progress: ${uploadPct}% (${uploaded} / ${expectedBytes} bytes).`
            );
          }
        }
        updateJob({
          progress,
          phase: "uploading",
          total_seen: uploaded,
          total_limit: expectedBytes,
          total_planned: expectedBytes,
        });
      },
    });
    appendLog(`Archive uploaded (${uploadedBytes} bytes). Extracting...`);
    updateJob({
      phase: "processing",
      total_seen: uploadedBytes,
      total_limit: expectedBytes > 0 ? expectedBytes : uploadedBytes,
      total_planned: expectedBytes > 0 ? expectedBytes : uploadedBytes,
    });

    assertNotAborted();
    const extractRoot = path.join(workDir, "extracted");
    await mkdir(extractRoot, { recursive: true });
    await extractTarGzToDirectory(archivePath, extractRoot, { isAborted: isStopped });
    appendLog("Archive extracted. Applying snapshot data...");
    updateJob({
      progress: 70,
      phase: "processing",
      total_seen: expectedBytes > 0 ? expectedBytes : uploadedBytes,
      total_limit: expectedBytes > 0 ? expectedBytes : uploadedBytes,
      total_planned: expectedBytes > 0 ? expectedBytes : uploadedBytes,
    });

    assertNotAborted();
    const manifestPath = resolveArchivePath(extractRoot, "manifest.json");
    const manifest = await readJsonFileOrDefault(manifestPath, null);
    if (!manifest || typeof manifest !== "object") {
      const error = new Error("Archive manifest.json is required");
      error.status = 400;
      throw error;
    }
    appendLog(`Manifest loaded: format=${String(manifest?.format || "unknown")}.`);

    const updateImportPhaseProgress = (section) => {
      if (section === "objects") {
        updateJob({ progress: 80, phase: "processing" });
        return;
      }
      if (section === "embeddings") {
        updateJob({ progress: 90, phase: "processing" });
        return;
      }
      if (section === "vlm") {
        updateJob({ progress: 97, phase: "processing" });
      }
    };

    const result = await importSnapshotFromArchive(extractRoot, manifest, {
      assertNotAborted,
      onProgress: (event) => {
        const section = String(event?.section || "").trim();
        if (section) {
          updateImportPhaseProgress(section);
          appendLog(`Applying ${section}: ${JSON.stringify(event)}`);
        }
      },
    });
    appendLog(`Snapshot import completed: format=${String(result?.format || "unknown")}.`);
    appendLog("Snapshot import data applied.");
    updateJob({
      status: "success",
      progress: 100,
      phase: "done",
      total_seen: expectedBytes > 0 ? expectedBytes : uploadedBytes,
      total_limit: expectedBytes > 0 ? expectedBytes : uploadedBytes,
      total_planned: expectedBytes > 0 ? expectedBytes : uploadedBytes,
    });

    return res.status(200).json({
      status: "ok",
      imported_at: new Date().toISOString(),
      result,
    });
  } catch (error) {
    if (isStopped()) {
      const cancelReason = getCancelReason();
      appendLog(`Snapshot import cancelled. reason=${cancelReason}`);
      updateJob({
        status: "cancelled",
        phase: "cancelled",
      });
      if (!res.headersSent && !res.destroyed) {
        return res.status(499).json({
          error: "Transfer cancelled",
          code: "TRANSFER_CANCELLED",
        });
      }
      if (!res.writableEnded && !res.destroyed) {
        res.end();
      }
      return;
    }
    const message = error?.message || "Failed to import snapshot";
    appendLog(`Snapshot import failed: ${message}`);
    setSnapshotTransferJobError(jobId, message);
    updateJob({
      status: "error",
    });
    return res
      .status(error.status || 500)
      .json(error.payload || { error: error.message || "Failed to import snapshot" });
  } finally {
    await cleanupTempDir(workDir);
  }
}
