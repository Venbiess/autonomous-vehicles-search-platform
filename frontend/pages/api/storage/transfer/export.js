import { createReadStream, createWriteStream } from "fs";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { once } from "events";

import { listStorageObjects, readStorageJson } from "../../../../lib/storageServer";
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
  packDirectoryToTarGz,
  readMasterJson,
} from "../../../../lib/storageTransfer";

export const config = {
  api: {
    responseLimit: false,
  },
};

const OBJECT_CONTENT_BATCH_SIZE = 8;
const VECTOR_BATCH_SIZE = 256;
const VLM_BATCH_SIZE = 500;

function normalizeKind(rawKind) {
  const kind = String(rawKind || "").trim().toLowerCase();
  if (kind === SNAPSHOT_KIND_VLM) return SNAPSHOT_KIND_VLM;
  if (kind === SNAPSHOT_KIND_EMBEDDINGS) return SNAPSHOT_KIND_EMBEDDINGS;
  return SNAPSHOT_KIND_FULL;
}

function createNdjsonWriter(filePath) {
  const stream = createWriteStream(filePath, { flags: "w", encoding: "utf8" });

  return {
    async writeObject(item) {
      const line = `${JSON.stringify(item)}\n`;
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
    destroy() {
      stream.destroy();
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

async function exportEmbeddingsToNdjson(filePath, objectIDs) {
  const writer = createNdjsonWriter(filePath);
  let count = 0;
  try {
    for (const chunk of chunkArray(objectIDs, VECTOR_BATCH_SIZE)) {
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
  } finally {
    await writer.close();
  }
  return count;
}

async function exportVlmAnnotationsToNdjson(filePath, objectIDs) {
  const writer = createNdjsonWriter(filePath);
  let count = 0;

  try {
    for (const chunk of chunkArray(objectIDs, VLM_BATCH_SIZE)) {
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
  } finally {
    await writer.close();
  }

  return count;
}

async function exportObjectsToArchive(rootDir, objects) {
  const objectsDir = path.join(rootDir, "objects");
  await mkdir(objectsDir, { recursive: true });

  const objectsNdjsonPath = path.join(rootDir, "objects.ndjson");
  const writer = createNdjsonWriter(objectsNdjsonPath);
  const objectMetas = objects.map(normalizeObjectMeta).filter((item) => item.object_id);
  const metaByID = new Map(objectMetas.map((item) => [item.object_id, item]));
  const objectIDs = objectMetas.map((item) => item.object_id);
  let count = 0;

  try {
    for (const chunk of chunkArray(objectIDs, OBJECT_CONTENT_BATCH_SIZE)) {
      const payload = await readStorageJson("/objects/get-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ object_ids: chunk }),
      });
      const items = Array.isArray(payload?.items) ? payload.items : [];
      const itemsByID = new Map(
        items
          .map((item) => [String(item?.object_id || "").trim(), item])
          .filter(([objectID]) => objectID)
      );

      for (const objectID of chunk) {
        const meta = metaByID.get(objectID);
        const contentItem = itemsByID.get(objectID);
        if (!meta || !contentItem) {
          throw new Error(`Missing object payload for ${objectID}`);
        }
        if (contentItem?.error) {
          throw new Error(`Failed to fetch object content for ${objectID}: ${String(contentItem.error)}`);
        }

        const contentBase64 = String(contentItem?.content_base64 || "").trim();
        if (!contentBase64) {
          throw new Error(`Object content is empty for ${objectID}`);
        }

        const buffer = Buffer.from(contentBase64, "base64");
        const objectFile = path.posix.join("objects", `${objectID}.bin`);
        const objectFilePath = path.join(rootDir, objectFile);
        await writeFile(objectFilePath, buffer);

        await writer.writeObject({
          ...meta,
          size_bytes: Number(contentItem?.size_bytes || meta.size_bytes || buffer.length),
          content_type: String(contentItem?.content_type || meta.content_type || "application/octet-stream").trim(),
          object_file: objectFile,
        });
        count += 1;
      }
    }
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
  await writeFile(path.join(rootDir, "manifest.json"), JSON.stringify(payload, null, 2), "utf8");
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const kind = normalizeKind(req.query?.kind);
  const workDir = await createTempDir("avsp-transfer-export-");
  const archiveDir = await createTempDir("avsp-transfer-archive-");

  try {
    const createdAt = new Date().toISOString();
    const objects = await listStorageObjects();
    const objectIDs = objects
      .map((item) => String(item?.object_id || "").trim())
      .filter(Boolean);

    if (kind === SNAPSHOT_KIND_EMBEDDINGS) {
      await writeManifest(workDir, {
        format: SNAPSHOT_FORMAT_EMBEDDINGS,
        kind,
        created_at: createdAt,
        archive_type: "tar.gz",
      });
      await exportEmbeddingsToNdjson(path.join(workDir, "embeddings.ndjson"), objectIDs);
    } else if (kind === SNAPSHOT_KIND_VLM) {
      const fieldsPayload = await readMasterJson("/vlm/fields");
      const fields = Array.isArray(fieldsPayload?.fields) ? fieldsPayload.fields : [];

      await writeManifest(workDir, {
        format: SNAPSHOT_FORMAT_VLM,
        kind,
        created_at: createdAt,
        archive_type: "tar.gz",
      });
      await writeFile(path.join(workDir, "fields.json"), JSON.stringify(fields), "utf8");
      await exportVlmAnnotationsToNdjson(path.join(workDir, "vlm.ndjson"), objectIDs);
    } else {
      const fieldsPayload = await readMasterJson("/vlm/fields");
      const fields = Array.isArray(fieldsPayload?.fields) ? fieldsPayload.fields : [];

      await writeManifest(workDir, {
        format: SNAPSHOT_FORMAT_FULL,
        kind: SNAPSHOT_KIND_FULL,
        created_at: createdAt,
        archive_type: "tar.gz",
      });
      await writeFile(path.join(workDir, "fields.json"), JSON.stringify(fields), "utf8");
      await exportObjectsToArchive(workDir, objects);
      await exportEmbeddingsToNdjson(path.join(workDir, "embeddings.ndjson"), objectIDs);
      await exportVlmAnnotationsToNdjson(path.join(workDir, "vlm.ndjson"), objectIDs);
    }

    const archivePath = path.join(archiveDir, "snapshot.tar.gz");
    await packDirectoryToTarGz(workDir, archivePath);

    const filename = buildSnapshotFilename(`${kind}-snapshot`, createdAt);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    await streamArchiveFile(res, archivePath);
  } catch (error) {
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
