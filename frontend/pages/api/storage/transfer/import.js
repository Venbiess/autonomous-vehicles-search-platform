import {
  storageEndpoint,
  storageWriteHeaders,
  readStorageJson,
} from "../../../../lib/storageServer";
import {
  SNAPSHOT_FORMAT_EMBEDDINGS,
  SNAPSHOT_FORMAT_FULL,
  SNAPSHOT_FORMAT_VLM,
  chunkArray,
  parseSnapshotBuffer,
  readMasterJson,
  readRequestBuffer,
} from "../../../../lib/storageTransfer";

const DEFAULT_MAX_IMPORT_BYTES = 512 * 1024 * 1024;

export const config = {
  api: {
    bodyParser: false,
    responseLimit: false,
  },
};

function extractImportItems(value) {
  return Array.isArray(value) ? value : [];
}

function parseStoragePath(pathValue) {
  const value = String(pathValue || "").trim();
  if (!value.toLowerCase().startsWith("s3://")) {
    return { bucket: "", key: "" };
  }
  const withoutPrefix = value.slice("s3://".length);
  const slash = withoutPrefix.indexOf("/");
  if (slash <= 0 || slash >= withoutPrefix.length - 1) {
    return { bucket: "", key: "" };
  }
  return {
    bucket: withoutPrefix.slice(0, slash),
    key: withoutPrefix.slice(slash + 1),
  };
}

async function importObjects(objects) {
  let uploaded = 0;
  const errors = [];

  for (const item of objects) {
    const objectID = String(item?.object_id || "").trim();
    const fallback = parseStoragePath(item?.storage_path);
    const bucket = String(item?.bucket || fallback.bucket).trim();
    const key = String(item?.key || fallback.key).trim();
    const contentType = String(item?.content_type || "application/octet-stream").trim();
    const contentBase64 = String(item?.content_base64 || "").trim();

    if (!bucket || !key || !contentBase64) {
      errors.push({
        object_id: objectID,
        error: "bucket/key/content_base64 are required",
      });
      continue;
    }

    let bytes;
    try {
      bytes = Buffer.from(contentBase64, "base64");
    } catch {
      errors.push({ object_id: objectID, error: "invalid base64 content" });
      continue;
    }

    if (!bytes || bytes.length === 0) {
      errors.push({ object_id: objectID, error: "empty object payload" });
      continue;
    }

    const form = new FormData();
    form.append("bucket", bucket);
    form.append("key", key);
    form.append("file", new Blob([bytes], { type: contentType }), key.split("/").pop() || `${objectID || "object"}.bin`);

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
        let message = response.statusText;
        if (payload) {
          try {
            const parsed = JSON.parse(payload);
            message = parsed?.detail || parsed?.error || message;
          } catch {
            message = payload;
          }
        }
        throw new Error(String(message || "upload failed"));
      }
      uploaded += 1;
    } catch (error) {
      errors.push({ object_id: objectID, error: error.message || "upload failed" });
    }
  }

  return { uploaded, errors };
}

function normalizeVectorRows(rows) {
  const normalized = [];
  for (const row of rows) {
    const objectID = String(row?.object_id || "").trim();
    const embedding = Array.isArray(row?.embedding)
      ? row.embedding.map((value) => Number(value)).filter((value) => Number.isFinite(value))
      : [];
    if (!objectID || embedding.length === 0) {
      continue;
    }
    normalized.push({ object_id: objectID, embedding });
  }
  return normalized;
}

async function importEmbeddings(vectors) {
  const normalized = normalizeVectorRows(vectors);
  let upserted = 0;

  for (const chunk of chunkArray(normalized, 128)) {
    const payload = await readStorageJson("/vectors/upsert", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...storageWriteHeaders(),
      },
      body: JSON.stringify({ vectors: chunk }),
    });
    upserted += Number(payload?.upserted || 0);
  }

  return {
    received: vectors.length,
    valid: normalized.length,
    upserted,
  };
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

function normalizeAnnotationRows(rows) {
  const normalized = [];
  for (const row of rows) {
    const objectID = String(row?.object_id || "").trim();
    const rawValues = row?.values;
    if (!objectID || !rawValues || typeof rawValues !== "object" || Array.isArray(rawValues)) {
      continue;
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
      continue;
    }
    normalized.push({ object_id: objectID, values });
  }
  return normalized;
}

async function importVlm(fields, annotations) {
  const normalizedFields = normalizeFieldRows(fields);
  const normalizedAnnotations = normalizeAnnotationRows(annotations);

  let savedFields = 0;
  if (normalizedFields.length > 0) {
    const fieldsPayload = await readMasterJson("/vlm/fields", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: normalizedFields }),
    });
    savedFields = Array.isArray(fieldsPayload?.fields) ? fieldsPayload.fields.length : 0;
  }

  let upserted = 0;
  for (const chunk of chunkArray(normalizedAnnotations, 500)) {
    const payload = await readMasterJson("/vlm/annotations/upsert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows: chunk }),
    });
    upserted += Number(payload?.upserted || 0);
  }

  return {
    received_fields: fields.length,
    valid_fields: normalizedFields.length,
    saved_fields: savedFields,
    received_annotations: annotations.length,
    valid_annotations: normalizedAnnotations.length,
    upserted_annotations: upserted,
  };
}

async function importSnapshot(snapshot) {
  const format = String(snapshot?.format || "").trim();

  if (format === SNAPSHOT_FORMAT_EMBEDDINGS) {
    const vectors = extractImportItems(snapshot?.vectors);
    return {
      format,
      embeddings: await importEmbeddings(vectors),
    };
  }

  if (format === SNAPSHOT_FORMAT_VLM) {
    const fields = extractImportItems(snapshot?.fields);
    const annotations = extractImportItems(snapshot?.annotations);
    return {
      format,
      vlm: await importVlm(fields, annotations),
    };
  }

  if (format === SNAPSHOT_FORMAT_FULL) {
    const objects = extractImportItems(snapshot?.objects);
    const vectors = extractImportItems(snapshot?.embeddings?.vectors);
    const fields = extractImportItems(snapshot?.vlm?.fields);
    const annotations = extractImportItems(snapshot?.vlm?.annotations);

    const objectResult = await importObjects(objects);
    const embeddingsResult = await importEmbeddings(vectors);
    const vlmResult = await importVlm(fields, annotations);

    return {
      format,
      objects: {
        received: objects.length,
        uploaded: objectResult.uploaded,
        failed: objectResult.errors.length,
        errors: objectResult.errors.slice(0, 50),
      },
      embeddings: embeddingsResult,
      vlm: vlmResult,
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

  try {
    const parsedMaxBytes = Number(
      process.env.STORAGE_TRANSFER_IMPORT_MAX_BYTES || DEFAULT_MAX_IMPORT_BYTES
    );
    const maxBytes =
      Number.isFinite(parsedMaxBytes) && parsedMaxBytes > 0
        ? parsedMaxBytes
        : DEFAULT_MAX_IMPORT_BYTES;
    const rawBuffer = await readRequestBuffer(req, maxBytes);
    const snapshot = parseSnapshotBuffer(rawBuffer);
    const result = await importSnapshot(snapshot);

    return res.status(200).json({
      status: "ok",
      imported_at: new Date().toISOString(),
      result,
    });
  } catch (error) {
    return res
      .status(error.status || 500)
      .json(error.payload || { error: error.message || "Failed to import snapshot" });
  }
}
