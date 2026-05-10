import { createReadStream } from "fs";
import { access, mkdir, readFile } from "fs/promises";
import path from "path";
import readline from "readline";
import { spawn } from "child_process";
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
const EXTRACT_CHECKPOINT_RECORDS = 4096;
const STORAGE_LIST_PAGE_SIZE = 1000;

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

function normalizeImportMode(rawMode) {
  const mode = String(rawMode || "").trim().toLowerCase();
  return mode === "append" ? "append" : "replace";
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

async function readManifestFromArchive(archivePath, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xOf", archivePath, "manifest.json"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        LC_ALL: "C",
        LANG: "C",
      },
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    let abortTimer = null;

    const cleanupAbortTimer = () => {
      if (abortTimer) {
        clearInterval(abortTimer);
        abortTimer = null;
      }
    };

    const rejectCancelled = () => {
      if (finished) return;
      finished = true;
      cleanupAbortTimer();
      child.kill("SIGTERM");
      reject(createTransferCancelledError());
    };

    if (typeof options.isAborted === "function") {
      abortTimer = setInterval(() => {
        if (options.isAborted()) {
          rejectCancelled();
        }
      }, 200);
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      cleanupAbortTimer();
      reject(error);
    });
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      cleanupAbortTimer();
      if (code !== 0) {
        reject(new Error(stderr.trim() || `tar exited with code ${code}`));
        return;
      }
      const raw = stdout.trim();
      if (!raw) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
  });
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

function buildObjectKey(bucket, key) {
  const normalizedBucket = String(bucket || "").trim();
  const normalizedKey = String(key || "").trim();
  if (!normalizedBucket || !normalizedKey) {
    return "";
  }
  return `${normalizedBucket}/${normalizedKey}`;
}

async function loadExistingObjectIndex(options = {}) {
  const objectIds = new Set();
  const objectKeys = new Set();
  let total = 0;
  let cursor = "";

  do {
    if (typeof options.assertNotAborted === "function") {
      options.assertNotAborted();
    }
    const params = new URLSearchParams({ limit: String(STORAGE_LIST_PAGE_SIZE) });
    if (cursor) {
      params.set("cursor", cursor);
    }
    const payload = await readStorageJson(`/objects?${params.toString()}`);
    const items = Array.isArray(payload?.items) ? payload.items : [];
    for (const item of items) {
      const objectID = String(item?.object_id || "").trim();
      const bucket = String(item?.bucket || "").trim();
      const key = String(item?.key || "").trim();
      if (objectID) {
        objectIds.add(objectID);
      }
      const objectKey = buildObjectKey(bucket, key);
      if (objectKey) {
        objectKeys.add(objectKey);
      }
      total += 1;
    }
    cursor = String(payload?.next_cursor || "").trim();
  } while (cursor);

  return { objectIds, objectKeys, total };
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

function fieldSignature(field) {
  const name = String(field?.name || field?.field_name || "").trim();
  const prompt = String(field?.prompt || "").trim();
  const responseType = String(field?.response_type || "text").trim();
  if (!name) return "";
  return `${name}::${responseType}::${prompt}`;
}

function diffVlmFields(existingFields, snapshotFields) {
  const existingByName = new Map();
  const snapshotByName = new Map();
  for (const item of Array.isArray(existingFields) ? existingFields : []) {
    const name = String(item?.field_name || item?.name || "").trim();
    if (!name) continue;
    existingByName.set(name, {
      field_name: name,
      prompt: String(item?.prompt || "").trim(),
      response_type: String(item?.response_type || "text").trim(),
    });
  }
  for (const item of Array.isArray(snapshotFields) ? snapshotFields : []) {
    const name = String(item?.name || item?.field_name || "").trim();
    if (!name) continue;
    snapshotByName.set(name, {
      field_name: name,
      prompt: String(item?.prompt || "").trim(),
      response_type: String(item?.response_type || "text").trim(),
    });
  }

  const missingInSnapshot = [];
  const missingInExisting = [];
  const changed = [];
  for (const [name, existing] of existingByName.entries()) {
    const snapshot = snapshotByName.get(name);
    if (!snapshot) {
      missingInSnapshot.push(name);
      continue;
    }
    if (fieldSignature(existing) !== fieldSignature(snapshot)) {
      changed.push(name);
    }
  }
  for (const name of snapshotByName.keys()) {
    if (!existingByName.has(name)) {
      missingInExisting.push(name);
    }
  }
  return {
    missing_in_snapshot: missingInSnapshot.sort((a, b) => a.localeCompare(b)),
    missing_in_existing: missingInExisting.sort((a, b) => a.localeCompare(b)),
    changed: changed.sort((a, b) => a.localeCompare(b)),
  };
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
  const mode = options.importMode === "append" ? "append" : "replace";

  const rawFields = await readJsonFileOrDefault(fieldsPath, []);
  const normalizedFields = normalizeFieldRows(Array.isArray(rawFields) ? rawFields : []);
  const existingFieldsPayload = await readMasterJson("/vlm/fields");
  const existingFields = Array.isArray(existingFieldsPayload?.fields)
    ? existingFieldsPayload.fields
    : [];
  const fieldsDiff = diffVlmFields(existingFields, normalizedFields);
  const warnings = [];
  if (
    mode === "append" &&
    (fieldsDiff.missing_in_snapshot.length > 0 ||
      fieldsDiff.missing_in_existing.length > 0 ||
      fieldsDiff.changed.length > 0)
  ) {
    warnings.push(
      "VLM fields differ between current schema and imported snapshot (append mode keeps existing data)."
    );
  }

  let savedFields = 0;
  let schemaReplaceApplied = false;
  let clearedAnnotations = 0;
  if (normalizedFields.length > 0) {
    const fieldsPayload = await readMasterJson("/vlm/fields", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: normalizedFields,
        replace_missing: mode === "replace",
        purge_deleted_values: mode === "replace",
      }),
    });
    savedFields = Array.isArray(fieldsPayload?.fields) ? fieldsPayload.fields.length : 0;
    schemaReplaceApplied = mode === "replace";
  } else if (mode === "replace") {
    warnings.push(
      "Snapshot has no fields: field catalog was not replaced because /vlm/fields requires non-empty list."
    );
  }

  if (mode === "replace") {
    const clearPayload = await readMasterJson("/vlm/annotations/clear", {
      method: "POST",
    });
    clearedAnnotations = Number(clearPayload?.deleted ?? clearPayload?.requested ?? 0);
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
    mode,
    received_fields: Array.isArray(rawFields) ? rawFields.length : 0,
    valid_fields: normalizedFields.length,
    saved_fields: savedFields,
    fields_diff: fieldsDiff,
    schema_replace_applied: schemaReplaceApplied,
    cleared_annotations_before_import: clearedAnnotations,
    received_annotations: receivedAnnotations,
    valid_annotations: validAnnotations,
    upserted_annotations: upsertedAnnotations,
    warnings,
  };
}

async function importObjectsFromArchive(extractRoot, options = {}) {
  const objectsPath = resolveArchivePath(extractRoot, "objects.ndjson");
  const mode = options.importMode === "append" ? "append" : "replace";
  const shouldAppend = mode === "append";

  let received = 0;
  let uploaded = 0;
  let skippedExisting = 0;
  const errors = [];
  let existingIndex = null;

  if (shouldAppend) {
    existingIndex = await loadExistingObjectIndex(options);
    if (typeof options.onProgress === "function") {
      options.onProgress({
        section: "objects",
        mode,
        existing_before_import: Number(existingIndex.total || 0),
      });
    }
  }

  await processNdjson(objectsPath, async (row) => {
    received += 1;
    if (shouldAppend && existingIndex) {
      const objectID = String(row?.object_id || "").trim();
      const bucket = String(row?.bucket || "").trim();
      const key = String(row?.key || "").trim();
      const objectKey = buildObjectKey(bucket, key);
      if (
        (objectID && existingIndex.objectIds.has(objectID)) ||
        (objectKey && existingIndex.objectKeys.has(objectKey))
      ) {
        skippedExisting += 1;
        if (typeof options.onProgress === "function" && received % 500 === 0) {
          options.onProgress({
            section: "objects",
            mode,
            received,
            uploaded,
            skipped_existing: skippedExisting,
            failed: errors.length,
          });
        }
        return;
      }
    }

    const result = await uploadObjectFromArchive(extractRoot, row, options);
    if (result.uploaded) {
      uploaded += 1;
      if (shouldAppend && existingIndex) {
        const objectID = String(row?.object_id || "").trim();
        const bucket = String(row?.bucket || "").trim();
        const key = String(row?.key || "").trim();
        const objectKey = buildObjectKey(bucket, key);
        if (objectID) {
          existingIndex.objectIds.add(objectID);
        }
        if (objectKey) {
          existingIndex.objectKeys.add(objectKey);
        }
      }
      if (typeof options.onProgress === "function" && received % 500 === 0) {
        options.onProgress({
          section: "objects",
          mode,
          received,
          uploaded,
          skipped_existing: skippedExisting,
          failed: errors.length,
        });
      }
      return;
    }
    errors.push({ object_id: result.object_id, error: result.error });
  }, options);

  return {
    received,
    uploaded,
    skipped_existing: skippedExisting,
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
      mode: options.importMode === "append" ? "append" : "replace",
      embeddings: await importEmbeddingsFromNdjson(
        resolveArchivePath(extractRoot, "embeddings.ndjson"),
        options
      ),
    };
  }

  if (format === SNAPSHOT_FORMAT_VLM) {
    const vlm = await importVlmFromArchive(extractRoot, options);
    return {
      format,
      mode: options.importMode === "append" ? "append" : "replace",
      vlm,
      warnings: Array.isArray(vlm?.warnings) ? vlm.warnings : [],
    };
  }

  if (format === SNAPSHOT_FORMAT_FULL) {
    const vlm = await importVlmFromArchive(extractRoot, options);
    return {
      format,
      mode: options.importMode === "append" ? "append" : "replace",
      objects: await importObjectsFromArchive(extractRoot, options),
      embeddings: await importEmbeddingsFromNdjson(
        resolveArchivePath(extractRoot, "embeddings.ndjson"),
        options
      ),
      vlm,
      warnings: Array.isArray(vlm?.warnings) ? vlm.warnings : [],
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
  const importMode = normalizeImportMode(req.query?.mode);
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
      import_mode: importMode,
      content_length: expectedBytes,
    });
    updateJob({
      status: "running",
      progress: 0,
      phase: "uploading",
      total_seen: 0,
      total_limit: expectedBytes,
      total_planned: expectedBytes,
      upload_bytes_seen: 0,
      upload_bytes_total: expectedBytes,
      upload_progress: 0,
      extract_bytes_seen: 0,
      extract_bytes_total: 0,
      extract_progress: 0,
    });
    appendLog(`Snapshot import started (mode=${importMode}).`);
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
          upload_bytes_seen: uploaded,
          upload_bytes_total: expectedBytes,
          upload_progress:
            expectedBytes > 0 ? Math.max(0, Math.min(100, Math.round((uploaded / expectedBytes) * 100))) : 0,
        });
      },
    });
    appendLog(`Archive uploaded (${uploadedBytes} bytes). Extracting...`);

    let archiveManifest = null;
    try {
      archiveManifest = await readManifestFromArchive(archivePath, { isAborted: isStopped });
      if (archiveManifest && typeof archiveManifest === "object") {
        appendLog("Manifest preview read before extraction.");
      }
    } catch (manifestError) {
      const message = manifestError?.message || "unable to read manifest before extraction";
      appendLog(`Manifest preview failed before extraction: ${message}`);
    }
    const extractTotalEstimateRaw = Number(
      archiveManifest?.extract_total_bytes_estimate ||
        archiveManifest?.prepared_bytes ||
        archiveManifest?.total_bytes ||
        uploadedBytes ||
        expectedBytes
    );
    const extractTotalEstimate =
      Number.isFinite(extractTotalEstimateRaw) && extractTotalEstimateRaw > 0
        ? extractTotalEstimateRaw
        : Math.max(uploadedBytes, expectedBytes, 1);

    updateJob({
      phase: "processing",
      total_seen: uploadedBytes,
      total_limit: expectedBytes > 0 ? expectedBytes : uploadedBytes,
      total_planned: expectedBytes > 0 ? expectedBytes : uploadedBytes,
      upload_bytes_seen: uploadedBytes,
      upload_bytes_total: expectedBytes > 0 ? expectedBytes : uploadedBytes,
      upload_progress: 100,
      extract_bytes_seen: 0,
      extract_bytes_total: extractTotalEstimate,
      extract_progress: 0,
    });
    appendLog(
      `Extract stage started: estimated ${extractTotalEstimate} bytes to process.`
    );

    assertNotAborted();
    const extractRoot = path.join(workDir, "extracted");
    await mkdir(extractRoot, { recursive: true });
    let lastExtractProgressBucket = -1;
    let lastExtractSeenBytes = 0;
    const extractResult = await extractTarGzToDirectory(archivePath, extractRoot, {
      isAborted: isStopped,
      checkpointRecords: EXTRACT_CHECKPOINT_RECORDS,
      onProgress: (event) => {
        const extractSeen = Math.max(0, Number(event?.bytes_read_estimate || 0));
        lastExtractSeenBytes = Math.max(lastExtractSeenBytes, extractSeen);
        const extractProgress = Math.max(
          0,
          Math.min(100, Math.round((Math.min(extractSeen, extractTotalEstimate) / extractTotalEstimate) * 100))
        );
        const overallProgress = 55 + Math.round(extractProgress * 0.3);
        const bucket = Math.floor(extractProgress / 10) * 10;
        if (bucket > lastExtractProgressBucket) {
          lastExtractProgressBucket = bucket;
          appendLog(
            `Extract progress: ${extractProgress}% (${Math.min(extractSeen, extractTotalEstimate)} / ${extractTotalEstimate} bytes est).`
          );
        }
        updateJob({
          progress: Math.max(55, Math.min(85, overallProgress)),
          phase: "processing",
          total_seen: expectedBytes > 0 ? expectedBytes : uploadedBytes,
          total_limit: expectedBytes > 0 ? expectedBytes : uploadedBytes,
          total_planned: expectedBytes > 0 ? expectedBytes : uploadedBytes,
          extract_bytes_seen: Math.min(extractSeen, extractTotalEstimate),
          extract_bytes_total: extractTotalEstimate,
          extract_progress: extractProgress,
        });
      },
    });
    if (extractResult?.checkpointEnabled) {
      appendLog(
        `Extract stage finished: checkpoints=${Number(extractResult.progressEvents || 0)}, estimated bytes processed=${Math.min(
          lastExtractSeenBytes,
          extractTotalEstimate
        )}/${extractTotalEstimate}.`
      );
    } else {
      appendLog(
        "Extract stage finished (tar checkpoint progress is unavailable on this system; used fallback extraction mode)."
      );
    }
    appendLog("Archive extracted. Applying snapshot data...");
    updateJob({
      progress: 86,
      phase: "processing",
      total_seen: expectedBytes > 0 ? expectedBytes : uploadedBytes,
      total_limit: expectedBytes > 0 ? expectedBytes : uploadedBytes,
      total_planned: expectedBytes > 0 ? expectedBytes : uploadedBytes,
      extract_bytes_seen: extractTotalEstimate,
      extract_bytes_total: extractTotalEstimate,
      extract_progress: 100,
    });

    assertNotAborted();
    const manifestPath = resolveArchivePath(extractRoot, "manifest.json");
    const manifest =
      archiveManifest && typeof archiveManifest === "object"
        ? archiveManifest
        : await readJsonFileOrDefault(manifestPath, null);
    if (!manifest || typeof manifest !== "object") {
      const error = new Error("Archive manifest.json is required");
      error.status = 400;
      throw error;
    }
    appendLog(`Manifest loaded: format=${String(manifest?.format || "unknown")}.`);

    const manifestFormat = String(manifest?.format || "").trim();
    const updateImportPhaseProgress = (section) => {
      if (section === "objects") {
        updateJob({ progress: 90, phase: "processing", extract_progress: 100 });
        return;
      }
      if (section === "embeddings") {
        updateJob({
          progress: manifestFormat === SNAPSHOT_FORMAT_EMBEDDINGS ? 98 : 95,
          phase: "processing",
          extract_progress: 100,
        });
        return;
      }
      if (section === "vlm") {
        updateJob({ progress: 98, phase: "processing", extract_progress: 100 });
      }
    };

    const result = await importSnapshotFromArchive(extractRoot, manifest, {
      importMode,
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
      upload_progress: 100,
      extract_progress: 100,
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
