import { createReadStream } from "fs";
import { access, mkdir, readFile } from "fs/promises";
import path from "path";
import readline from "readline";

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
  extractTarGzToDirectory,
  readMasterJson,
  writeRequestToFile,
} from "../../../../lib/storageTransfer";

const DEFAULT_MAX_IMPORT_BYTES = 4 * 1024 * 1024 * 1024;
const EMBEDDINGS_BATCH_SIZE = 128;
const VLM_BATCH_SIZE = 500;

export const config = {
  api: {
    bodyParser: false,
    responseLimit: false,
  },
};

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

async function processNdjson(filePath, onItem) {
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

async function uploadObjectFromArchive(extractRoot, item) {
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

async function importEmbeddingsFromNdjson(filePath) {
  let received = 0;
  let valid = 0;
  let upserted = 0;
  let batch = [];

  const flushBatch = async () => {
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
  });

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
  });

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

async function importObjectsFromArchive(extractRoot) {
  const objectsPath = resolveArchivePath(extractRoot, "objects.ndjson");

  let received = 0;
  let uploaded = 0;
  const errors = [];

  await processNdjson(objectsPath, async (row) => {
    received += 1;
    const result = await uploadObjectFromArchive(extractRoot, row);
    if (result.uploaded) {
      uploaded += 1;
      return;
    }
    errors.push({ object_id: result.object_id, error: result.error });
  });

  return {
    received,
    uploaded,
    failed: errors.length,
    errors: errors.slice(0, 50),
  };
}

async function importSnapshotFromArchive(extractRoot, manifest) {
  const format = String(manifest?.format || "").trim();

  if (format === SNAPSHOT_FORMAT_EMBEDDINGS) {
    return {
      format,
      embeddings: await importEmbeddingsFromNdjson(
        resolveArchivePath(extractRoot, "embeddings.ndjson")
      ),
    };
  }

  if (format === SNAPSHOT_FORMAT_VLM) {
    return {
      format,
      vlm: await importVlmFromArchive(extractRoot),
    };
  }

  if (format === SNAPSHOT_FORMAT_FULL) {
    return {
      format,
      objects: await importObjectsFromArchive(extractRoot),
      embeddings: await importEmbeddingsFromNdjson(
        resolveArchivePath(extractRoot, "embeddings.ndjson")
      ),
      vlm: await importVlmFromArchive(extractRoot),
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

  const workDir = await createTempDir("avsp-transfer-import-");

  try {
    const parsedMaxBytes = Number(
      process.env.STORAGE_TRANSFER_IMPORT_MAX_BYTES || DEFAULT_MAX_IMPORT_BYTES
    );
    const maxBytes =
      Number.isFinite(parsedMaxBytes) && parsedMaxBytes > 0
        ? parsedMaxBytes
        : DEFAULT_MAX_IMPORT_BYTES;

    const archivePath = path.join(workDir, "snapshot.tar.gz");
    await writeRequestToFile(req, archivePath, maxBytes);

    const extractRoot = path.join(workDir, "extracted");
    await mkdir(extractRoot, { recursive: true });
    await extractTarGzToDirectory(archivePath, extractRoot);

    const manifestPath = resolveArchivePath(extractRoot, "manifest.json");
    const manifest = await readJsonFileOrDefault(manifestPath, null);
    if (!manifest || typeof manifest !== "object") {
      const error = new Error("Archive manifest.json is required");
      error.status = 400;
      throw error;
    }

    const result = await importSnapshotFromArchive(extractRoot, manifest);

    return res.status(200).json({
      status: "ok",
      imported_at: new Date().toISOString(),
      result,
    });
  } catch (error) {
    return res
      .status(error.status || 500)
      .json(error.payload || { error: error.message || "Failed to import snapshot" });
  } finally {
    await cleanupTempDir(workDir);
  }
}
