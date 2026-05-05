import { createReadStream, createWriteStream } from "fs";
import { mkdir, stat, writeFile } from "fs/promises";
import path from "path";
import { once } from "events";
import { randomUUID } from "crypto";

import { readStorageJson } from "../../../../lib/storageServer";
import {
  SNAPSHOT_FORMAT_EMBEDDINGS,
  SNAPSHOT_FORMAT_FULL,
  SNAPSHOT_FORMAT_VLM,
  SNAPSHOT_KIND_EMBEDDINGS,
  SNAPSHOT_KIND_FULL,
  SNAPSHOT_KIND_VLM,
  buildSnapshotFilename,
  chunkArray,
  cleanupTempDir,
  createTempDir,
  createTransferCancelledError,
  packDirectoryToTarGz,
  readMasterJson,
} from "../../../../lib/storageTransfer";
import {
  clearSnapshotExportProgress,
  setSnapshotExportProgress,
} from "../../../../lib/snapshotExportProgress";
import {
  appendSnapshotTransferJobLog,
  ensureSnapshotTransferJob,
  isSnapshotTransferJobCancelRequested,
  setSnapshotTransferJobError,
  updateSnapshotTransferJob,
} from "../../../../lib/snapshotTransferJobs";

export const config = {
  api: {
    responseLimit: false,
  },
};

const OBJECTS_PAGE_SIZE = 256;
const OBJECT_CONTENT_BATCH_SIZE = 2;
const VECTOR_BATCH_SIZE = 256;
const VLM_BATCH_SIZE = 400;

function normalizeKind(rawKind) {
  const kind = String(rawKind || "").trim().toLowerCase();
  if (kind === SNAPSHOT_KIND_VLM) return SNAPSHOT_KIND_VLM;
  if (kind === SNAPSHOT_KIND_EMBEDDINGS) return SNAPSHOT_KIND_EMBEDDINGS;
  return SNAPSHOT_KIND_FULL;
}

function normalizeExportId(rawExportId) {
  return String(rawExportId || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "")
    .slice(0, 128);
}

function createAbortState(req, res) {
  const state = { aborted: false };
  const markAborted = () => {
    state.aborted = true;
  };
  req.on("aborted", markAborted);
  req.on("close", () => {
    if (!req.complete || req.aborted) {
      markAborted();
    }
  });
  res.on("close", () => {
    if (!res.writableEnded) {
      markAborted();
    }
  });
  return {
    isAborted: () => state.aborted,
    assertNotAborted: () => {
      if (state.aborted) {
        throw createTransferCancelledError();
      }
    },
  };
}

function createNdjsonWriter(filePath, options = {}) {
  const stream = createWriteStream(filePath, { flags: "w", encoding: "utf8" });

  return {
    async writeObject(item) {
      const line = `${JSON.stringify(item)}\n`;
      if (typeof options.onBytesWritten === "function") {
        options.onBytesWritten(Buffer.byteLength(line, "utf8"));
      }
      if (!stream.write(line)) {
        await once(stream, "drain");
      }
    },
    async close() {
      await new Promise((resolve, reject) => {
        stream.end((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

function normalizeObjectMeta(item) {
  return {
    object_id: String(item?.object_id || "").trim(),
    storage_path: String(item?.storage_path || "").trim(),
    bucket: String(item?.bucket || "").trim(),
    key: String(item?.key || "").trim(),
    size_bytes: Number(item?.size_bytes || 0),
    content_type: String(item?.content_type || "application/octet-stream").trim(),
    created_at: item?.created_at || "",
  };
}

async function forEachObjectPage({ pageSize = OBJECTS_PAGE_SIZE, assertNotAborted, onPage }) {
  let cursor = "";
  let guard = 0;
  while (guard < 10_000) {
    guard += 1;
    assertNotAborted();
    const params = new URLSearchParams({ limit: String(pageSize) });
    if (cursor) {
      params.set("cursor", cursor);
    }
    const payload = await readStorageJson(`/objects?${params.toString()}`);
    const items = Array.isArray(payload?.items) ? payload.items : [];
    if (items.length > 0) {
      await onPage(items);
    }
    cursor = String(payload?.next_cursor || "").trim();
    if (!cursor) {
      break;
    }
  }
}

async function exportEmbeddingsToNdjson(filePath, { assertNotAborted, onPreparedBytes }) {
  const writer = createNdjsonWriter(filePath, {
    onBytesWritten: (bytes) => {
      if (typeof onPreparedBytes === "function") {
        onPreparedBytes(bytes);
      }
    },
  });
  let count = 0;
  let pendingObjectIds = [];

  const flushPending = async () => {
    if (pendingObjectIds.length === 0) {
      return;
    }
    for (const chunk of chunkArray(pendingObjectIds, VECTOR_BATCH_SIZE)) {
      assertNotAborted();
      const payload = await readStorageJson("/vectors/get", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ object_ids: chunk }),
      });
      const items = Array.isArray(payload?.items) ? payload.items : [];
      for (const item of items) {
        const objectID = String(item?.object_id || "").trim();
        const embedding = Array.isArray(item?.embedding)
          ? item.embedding
              .map((value) => Number(value))
              .filter((value) => Number.isFinite(value))
          : [];
        if (!objectID || embedding.length === 0) {
          continue;
        }
        await writer.writeObject({ object_id: objectID, embedding });
        count += 1;
      }
    }
    pendingObjectIds = [];
  };

  try {
    await forEachObjectPage({
      assertNotAborted,
      onPage: async (items) => {
        for (const raw of items) {
          const objectID = String(raw?.object_id || "").trim();
          if (!objectID) continue;
          pendingObjectIds.push(objectID);
          if (pendingObjectIds.length >= VECTOR_BATCH_SIZE) {
            await flushPending();
          }
        }
      },
    });
    await flushPending();
  } finally {
    await writer.close();
  }

  return count;
}

async function exportVlmAnnotationsToNdjson(filePath, { assertNotAborted, onPreparedBytes }) {
  const writer = createNdjsonWriter(filePath, {
    onBytesWritten: (bytes) => {
      if (typeof onPreparedBytes === "function") {
        onPreparedBytes(bytes);
      }
    },
  });
  let count = 0;
  let pendingObjectIds = [];

  const flushPending = async () => {
    if (pendingObjectIds.length === 0) {
      return;
    }
    for (const chunk of chunkArray(pendingObjectIds, VLM_BATCH_SIZE)) {
      assertNotAborted();
      const payload = await readMasterJson("/vlm/annotations/get", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ object_ids: chunk }),
      });
      const rows = Array.isArray(payload?.rows) ? payload.rows : [];
      for (const row of rows) {
        const objectID = String(row?.object_id || "").trim();
        const rawValues = row?.values;
        const values = {};
        if (rawValues && typeof rawValues === "object" && !Array.isArray(rawValues)) {
          for (const [key, value] of Object.entries(rawValues)) {
            const normalizedKey = String(key || "").trim();
            const normalizedValue = String(value || "").trim();
            if (!normalizedKey || !normalizedValue) {
              continue;
            }
            values[normalizedKey] = normalizedValue;
          }
        }
        if (!objectID || Object.keys(values).length === 0) {
          continue;
        }
        await writer.writeObject({ object_id: objectID, values });
        count += 1;
      }
    }
    pendingObjectIds = [];
  };

  try {
    await forEachObjectPage({
      assertNotAborted,
      onPage: async (items) => {
        for (const raw of items) {
          const objectID = String(raw?.object_id || "").trim();
          if (!objectID) continue;
          pendingObjectIds.push(objectID);
          if (pendingObjectIds.length >= VLM_BATCH_SIZE) {
            await flushPending();
          }
        }
      },
    });
    await flushPending();
  } finally {
    await writer.close();
  }

  return count;
}

async function exportObjectsToArchive(
  rootDir,
  { assertNotAborted, onPreparedBytes, onPreparedObject }
) {
  const objectsDir = path.join(rootDir, "objects");
  await mkdir(objectsDir, { recursive: true });

  const objectsNdjsonPath = path.join(rootDir, "objects.ndjson");
  const writer = createNdjsonWriter(objectsNdjsonPath, {
    onBytesWritten: (bytes) => {
      if (typeof onPreparedBytes === "function") {
        onPreparedBytes(bytes);
      }
    },
  });
  let count = 0;

  try {
    await forEachObjectPage({
      assertNotAborted,
      onPage: async (rawItems) => {
        const metas = rawItems.map(normalizeObjectMeta).filter((item) => item.object_id);
        for (const metaChunk of chunkArray(metas, OBJECT_CONTENT_BATCH_SIZE)) {
          assertNotAborted();
          const chunkIDs = metaChunk.map((item) => item.object_id);
          const payload = await readStorageJson("/objects/get-batch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ object_ids: chunkIDs }),
          });
          const items = Array.isArray(payload?.items) ? payload.items : [];
          const itemsByID = new Map(
            items
              .map((item) => [String(item?.object_id || "").trim(), item])
              .filter(([objectID]) => objectID)
          );

          for (const meta of metaChunk) {
            const contentItem = itemsByID.get(meta.object_id);
            if (!contentItem) {
              throw new Error(`Missing object payload for ${meta.object_id}`);
            }
            if (contentItem?.error) {
              throw new Error(
                `Failed to fetch object content for ${meta.object_id}: ${String(contentItem.error)}`
              );
            }

            const contentBase64 = String(contentItem?.content_base64 || "").trim();
            if (!contentBase64) {
              throw new Error(`Object content is empty for ${meta.object_id}`);
            }

            const buffer = Buffer.from(contentBase64, "base64");
            const objectFile = path.posix.join("objects", `${meta.object_id}.bin`);
            const objectFilePath = path.join(rootDir, objectFile);
            await writeFile(objectFilePath, buffer);
            if (typeof onPreparedBytes === "function") {
              onPreparedBytes(buffer.length);
            }

            await writer.writeObject({
              ...meta,
              size_bytes: Number(contentItem?.size_bytes || meta.size_bytes || buffer.length),
              content_type: String(
                contentItem?.content_type || meta.content_type || "application/octet-stream"
              ).trim(),
              object_file: objectFile,
            });
            count += 1;
            if (typeof onPreparedObject === "function") {
              onPreparedObject(1);
            }
          }
        }
      },
    });
  } finally {
    await writer.close();
  }

  return count;
}

async function streamArchiveFile(res, archivePath) {
  await new Promise((resolve, reject) => {
    const stream = createReadStream(archivePath);
    stream.on("error", reject);
    res.on("error", reject);
    res.on("close", resolve);
    stream.pipe(res);
  });
}

async function writeManifest(rootDir, payload) {
  const raw = JSON.stringify(payload, null, 2);
  await writeFile(path.join(rootDir, "manifest.json"), raw, "utf8");
  return Buffer.byteLength(raw, "utf8");
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const kind = normalizeKind(req.query?.kind);
  const exportId = normalizeExportId(req.query?.export_id);
  const workDir = await createTempDir("avsp-transfer-export-");
  const archiveDir = await createTempDir("avsp-transfer-archive-");
  const { isAborted, assertNotAborted: assertClientNotAborted } = createAbortState(req, res);
  const jobId = randomUUID().replace(/-/g, "").slice(0, 16);
  const jobType = `snapshot_export_${kind}`;
  let preparedBytes = 0;
  let preparedObjects = 0;
  let nextPreparedLogAt = 64 * 1024 * 1024;

  const updateProgress = (patch) => {
    if (!exportId) return;
    setSnapshotExportProgress(exportId, patch);
  };
  const updateJob = (patch) => {
    updateSnapshotTransferJob(jobId, patch);
  };
  const appendLog = (text) => {
    appendSnapshotTransferJobLog(jobId, text);
  };
  const updateJobByteProgress = (seenBytes, plannedBytes) => {
    const seen = Math.max(0, Number(seenBytes || 0));
    const planned = Math.max(0, Number(plannedBytes || 0));
    const normalizedSeen = planned > 0 ? Math.min(seen, planned) : seen;
    const progress = planned > 0 ? Math.min(99, Math.round((normalizedSeen / planned) * 100)) : 0;
    updateJob({
      progress,
      total_seen: normalizedSeen,
      total_limit: planned,
      total_planned: planned,
      total_inserted: preparedObjects,
      total_tasks_completed: preparedObjects,
      total_tasks_planned: 0,
    });
  };
  const bumpPreparedBytes = (deltaBytes) => {
    preparedBytes += Math.max(0, Number(deltaBytes || 0));
    updateProgress({
      phase: "preparing",
      status: "running",
      bytes_written: preparedBytes,
      archive_bytes: null,
      prepared_bytes: preparedBytes,
      prepared_objects: preparedObjects,
    });
    updateJobByteProgress(preparedBytes, 0);
    if (preparedBytes >= nextPreparedLogAt) {
      appendLog(`Preparing snapshot: ${preparedObjects} objects, ${preparedBytes} bytes staged.`);
      nextPreparedLogAt += 64 * 1024 * 1024;
    }
  };
  const bumpPreparedObjects = (deltaCount = 1) => {
    preparedObjects += Math.max(0, Number(deltaCount || 0));
    updateProgress({
      phase: "preparing",
      status: "running",
      bytes_written: preparedBytes,
      archive_bytes: null,
      prepared_bytes: preparedBytes,
      prepared_objects: preparedObjects,
    });
    updateJob({
      total_inserted: preparedObjects,
      total_tasks_completed: preparedObjects,
      total_seen: preparedBytes,
    });
  };
  const assertNotAborted = () => {
    assertClientNotAborted();
    if (isSnapshotTransferJobCancelRequested(jobId)) {
      throw createTransferCancelledError("Transfer cancelled by user");
    }
  };
  const isStopped = () => isAborted() || isSnapshotTransferJobCancelRequested(jobId);

  try {
    const createdAt = new Date().toISOString();
    ensureSnapshotTransferJob(jobId, jobType, {
      export_id: exportId,
      kind,
    });
    updateJob({
      status: "running",
      progress: 0,
      total_seen: 0,
      total_inserted: 0,
      total_limit: 0,
      total_planned: 0,
      total_tasks_completed: 0,
      total_tasks_planned: 0,
    });
    appendLog(`Snapshot export started: kind=${kind}.`);
    updateProgress({
      job_id: jobId,
      kind,
      phase: "preparing",
      status: "running",
      bytes_written: 0,
      archive_bytes: null,
      prepared_bytes: 0,
      prepared_objects: 0,
      created_at: createdAt,
    });

    if (kind === SNAPSHOT_KIND_EMBEDDINGS) {
      appendLog("Preparing embeddings snapshot files...");
      const manifestBytes = await writeManifest(workDir, {
        format: SNAPSHOT_FORMAT_EMBEDDINGS,
        kind,
        created_at: createdAt,
        archive_type: "tar.gz",
      });
      bumpPreparedBytes(manifestBytes);
      await exportEmbeddingsToNdjson(path.join(workDir, "embeddings.ndjson"), {
        assertNotAborted,
        onPreparedBytes: bumpPreparedBytes,
      });
      appendLog("Embeddings snapshot data prepared.");
    } else if (kind === SNAPSHOT_KIND_VLM) {
      appendLog("Preparing VLM snapshot files...");
      const fieldsPayload = await readMasterJson("/vlm/fields");
      const fields = Array.isArray(fieldsPayload?.fields) ? fieldsPayload.fields : [];

      const manifestBytes = await writeManifest(workDir, {
        format: SNAPSHOT_FORMAT_VLM,
        kind,
        created_at: createdAt,
        archive_type: "tar.gz",
      });
      bumpPreparedBytes(manifestBytes);
      const fieldsRaw = JSON.stringify(fields);
      await writeFile(path.join(workDir, "fields.json"), fieldsRaw, "utf8");
      bumpPreparedBytes(Buffer.byteLength(fieldsRaw, "utf8"));
      await exportVlmAnnotationsToNdjson(path.join(workDir, "vlm.ndjson"), {
        assertNotAborted,
        onPreparedBytes: bumpPreparedBytes,
      });
      appendLog("VLM snapshot data prepared.");
    } else {
      appendLog("Preparing full snapshot files...");
      const fieldsPayload = await readMasterJson("/vlm/fields");
      const fields = Array.isArray(fieldsPayload?.fields) ? fieldsPayload.fields : [];

      const manifestBytes = await writeManifest(workDir, {
        format: SNAPSHOT_FORMAT_FULL,
        kind: SNAPSHOT_KIND_FULL,
        created_at: createdAt,
        archive_type: "tar.gz",
      });
      bumpPreparedBytes(manifestBytes);
      const fieldsRaw = JSON.stringify(fields);
      await writeFile(path.join(workDir, "fields.json"), fieldsRaw, "utf8");
      bumpPreparedBytes(Buffer.byteLength(fieldsRaw, "utf8"));
      const fullObjectsCount = await exportObjectsToArchive(workDir, {
        assertNotAborted,
        onPreparedBytes: bumpPreparedBytes,
        onPreparedObject: bumpPreparedObjects,
      });
      appendLog(`Objects prepared: ${fullObjectsCount}.`);
      await exportEmbeddingsToNdjson(path.join(workDir, "embeddings.ndjson"), {
        assertNotAborted,
        onPreparedBytes: bumpPreparedBytes,
      });
      await exportVlmAnnotationsToNdjson(path.join(workDir, "vlm.ndjson"), {
        assertNotAborted,
        onPreparedBytes: bumpPreparedBytes,
      });
      appendLog("Full snapshot data prepared.");
    }

    assertNotAborted();
    const archivePath = path.join(archiveDir, "snapshot.tar.gz");
    appendLog(`Archiving started (${preparedBytes} bytes staged).`);
    updateProgress({
      phase: "archiving",
      status: "running",
      bytes_written: 0,
      archive_bytes: null,
      prepared_bytes: Math.max(0, preparedBytes),
      prepared_objects: preparedObjects,
    });
    updateJobByteProgress(0, Math.max(0, preparedBytes));
    const archiveSizePoll = setInterval(async () => {
      try {
        const archiveStat = await stat(archivePath);
        const archiveNow = Math.max(0, Number(archiveStat.size || 0));
        updateProgress({
          phase: "archiving",
          status: "running",
          bytes_written: archiveNow,
          archive_bytes: null,
          prepared_bytes: Math.max(0, preparedBytes),
          prepared_objects: preparedObjects,
        });
        updateJobByteProgress(archiveNow, Math.max(0, preparedBytes));
      } catch {
        updateProgress({
          phase: "archiving",
          status: "running",
          bytes_written: 0,
          archive_bytes: null,
          prepared_bytes: Math.max(0, preparedBytes),
          prepared_objects: preparedObjects,
        });
        updateJobByteProgress(0, Math.max(0, preparedBytes));
      }
    }, 300);
    try {
      await packDirectoryToTarGz(workDir, archivePath, { isAborted: isStopped });
    } finally {
      clearInterval(archiveSizePoll);
    }
    assertNotAborted();
    const archiveStat = await stat(archivePath);
    const archiveBytes = Math.max(0, Number(archiveStat.size || 0));
    appendLog(`Archive created: ${archiveBytes} bytes.`);
    updateProgress({
      phase: "streaming",
      status: "running",
      bytes_written: archiveBytes,
      archive_bytes: archiveBytes,
      prepared_objects: preparedObjects,
    });
    updateJob({
      progress: 100,
      total_seen: archiveBytes,
      total_limit: archiveBytes,
      total_planned: archiveBytes,
      total_inserted: preparedObjects,
      status: "running",
    });

    const filename = buildSnapshotFilename(`${kind}-snapshot`, createdAt);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename=\"${filename}\"`);
    if (Number.isFinite(Number(archiveStat.size)) && archiveStat.size > 0) {
      res.setHeader("Content-Length", String(archiveStat.size));
    }
    await streamArchiveFile(res, archivePath);
    appendLog("Snapshot export completed.");
    updateProgress({
      phase: "done",
      status: "done",
      bytes_written: archiveBytes,
      archive_bytes: archiveBytes,
      prepared_objects: preparedObjects,
      finished_at: new Date().toISOString(),
    });
    updateJob({
      status: "success",
      progress: 100,
      total_seen: archiveBytes,
      total_limit: archiveBytes,
      total_planned: archiveBytes,
      total_inserted: preparedObjects,
    });
    setTimeout(() => clearSnapshotExportProgress(exportId), 60_000);
  } catch (error) {
    if (isStopped()) {
      appendLog("Snapshot export cancelled.");
      updateProgress({
        phase: "cancelled",
        status: "cancelled",
        bytes_written: preparedBytes,
        prepared_objects: preparedObjects,
        finished_at: new Date().toISOString(),
      });
      updateJob({
        status: "cancelled",
        progress: 0,
        total_seen: preparedBytes,
        total_inserted: preparedObjects,
      });
      setTimeout(() => clearSnapshotExportProgress(exportId), 60_000);
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
    const message = error?.message || "Failed to export snapshot";
    appendLog(`Snapshot export failed: ${message}`);
    setSnapshotTransferJobError(jobId, message);
    updateProgress({
      phase: "error",
      status: "error",
      error: message,
      bytes_written: preparedBytes,
      prepared_objects: preparedObjects,
      finished_at: new Date().toISOString(),
    });
    updateJob({
      status: "error",
      total_seen: preparedBytes,
      total_inserted: preparedObjects,
    });
    setTimeout(() => clearSnapshotExportProgress(exportId), 2 * 60_000);
    if (!res.headersSent) {
      return res
        .status(error.status || 500)
        .json(error.payload || { error: error.message || "Failed to export snapshot" });
    }
    res.end();
  } finally {
    await cleanupTempDir(archiveDir);
    await cleanupTempDir(workDir);
  }
}
