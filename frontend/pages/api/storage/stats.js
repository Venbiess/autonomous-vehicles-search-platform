import {
  buildStorageStats,
  listStorageObjects,
  readStorageJson,
} from "../../../lib/storageServer";

const DEFAULT_ANALYTICS_ENDPOINTS = [
  process.env.ANALYTICS_SERVER_ENDPOINT,
  process.env.ANALYTICS_ENDPOINT,
  "http://analytics-server:9012",
  "http://localhost:9014",
]
  .filter(Boolean)
  .map((value) => String(value).replace(/\/$/, ""));

function chunkArray(values, chunkSize) {
  const out = [];
  for (let i = 0; i < values.length; i += chunkSize) {
    out.push(values.slice(i, i + chunkSize));
  }
  return out;
}

async function readAnalyticsJson(path, init = {}) {
  let lastError = null;
  for (const endpoint of DEFAULT_ANALYTICS_ENDPOINTS) {
    try {
      const response = await fetch(`${endpoint}${path}`, init);
      const payload = await response.json();
      if (!response.ok) {
        const error = new Error(payload?.detail || payload?.error || response.statusText);
        error.status = response.status;
        error.payload = payload;
        throw error;
      }
      return payload;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("analytics endpoint is unavailable");
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const objects = await listStorageObjects();
    const stats = buildStorageStats(objects);
    const totalObjects = objects.length;
    const warnings = [];

    // Embeddings coverage from vector index.
    try {
      const vectorPayload = await readStorageJson("/vectors/count");
      const annotated = Math.max(
        0,
        Math.min(totalObjects, Number(vectorPayload?.count || 0))
      );
      const pending = Math.max(0, totalObjects - annotated);
      stats.embeddings.annotated_rows = annotated;
      stats.embeddings.pending_rows = pending;
      stats.embeddings.annotated_percent =
        totalObjects > 0 ? (annotated / totalObjects) * 100 : 0;
      stats.embeddings.pending_percent =
        totalObjects > 0 ? (pending / totalObjects) * 100 : 0;
    } catch (error) {
      warnings.push(`vector stats unavailable: ${error.message}`);
    }

    // VLM coverage from analytics service.
    try {
      const fieldsPayload = await readAnalyticsJson("/fields");
      const fields = Array.isArray(fieldsPayload?.fields) ? fieldsPayload.fields : [];
      const fieldNames = fields
        .map((field) => String(field.field_name || "").trim())
        .filter(Boolean);
      stats.vlm.configured_fields = fieldNames.length;

      if (fieldNames.length > 0 && totalObjects > 0) {
        const completed = new Set();
        const objectIDs = objects.map((item) => item.object_id).filter(Boolean);
        const chunks = chunkArray(objectIDs, 500);
        for (const objectIDsChunk of chunks) {
          const payload = await readAnalyticsJson("/annotations/completed-object-ids", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              object_ids: objectIDsChunk,
              field_names: fieldNames,
            }),
          });
          const ids = Array.isArray(payload?.object_ids) ? payload.object_ids : [];
          for (const id of ids) {
            if (id) {
              completed.add(String(id));
            }
          }
        }
        const annotated = Math.max(0, Math.min(totalObjects, completed.size));
        const pending = Math.max(0, totalObjects - annotated);
        stats.vlm.annotated_rows = annotated;
        stats.vlm.pending_rows = pending;
        stats.vlm.annotated_percent =
          totalObjects > 0 ? (annotated / totalObjects) * 100 : 0;
        stats.vlm.pending_percent =
          totalObjects > 0 ? (pending / totalObjects) * 100 : 0;
      } else {
        stats.vlm.annotated_rows = 0;
        stats.vlm.pending_rows = totalObjects;
        stats.vlm.annotated_percent = 0;
        stats.vlm.pending_percent = totalObjects > 0 ? 100 : 0;
      }
    } catch (error) {
      warnings.push(`vlm stats unavailable: ${error.message}`);
    }

    if (warnings.length > 0) {
      stats.warning = warnings.join("; ");
    }

    return res.status(200).json(stats);
  } catch (error) {
    return res.status(error.status || 500).json(error.payload || { error: error.message });
  }
}
