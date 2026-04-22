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
  readMasterJson,
} from "../../../../lib/storageTransfer";

export const config = {
  api: {
    responseLimit: false,
  },
};

const OBJECT_CONTENT_BATCH_SIZE = 16;
const VECTOR_BATCH_SIZE = 256;
const VLM_BATCH_SIZE = 500;

function normalizeKind(rawKind) {
  const kind = String(rawKind || "").trim().toLowerCase();
  if (kind === SNAPSHOT_KIND_VLM) return SNAPSHOT_KIND_VLM;
  if (kind === SNAPSHOT_KIND_EMBEDDINGS) return SNAPSHOT_KIND_EMBEDDINGS;
  return SNAPSHOT_KIND_FULL;
}

function writeJsonItem(res, state, item) {
  if (state.first) {
    state.first = false;
  } else {
    res.write(",");
  }
  res.write(JSON.stringify(item));
}

async function streamEmbeddingsArray(res, objectIDs) {
  const state = { first: true };
  if (objectIDs.length === 0) {
    return 0;
  }

  let count = 0;
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
      writeJsonItem(res, state, { object_id: objectID, embedding });
      count += 1;
    }
  }

  return count;
}

async function streamVlmAnnotationsArray(res, objectIDs) {
  const state = { first: true };
  if (objectIDs.length === 0) {
    return 0;
  }

  let count = 0;
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
      writeJsonItem(res, state, { object_id: objectID, values });
      count += 1;
    }
  }

  return count;
}

async function streamObjectsArray(res, objects) {
  const state = { first: true };
  if (objects.length === 0) {
    return 0;
  }

  let count = 0;
  const metaByID = new Map(
    objects
      .map((item) => [String(item?.object_id || "").trim(), item])
      .filter(([id]) => id)
  );
  const objectIDs = objects
    .map((item) => String(item?.object_id || "").trim())
    .filter(Boolean);

  for (const idsChunk of chunkArray(objectIDs, OBJECT_CONTENT_BATCH_SIZE)) {
    const payload = await readStorageJson("/objects/get-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ object_ids: idsChunk }),
    });
    const batchItems = Array.isArray(payload?.items) ? payload.items : [];
    const byID = new Map(
      batchItems
        .map((item) => [String(item?.object_id || "").trim(), item])
        .filter(([id]) => id)
    );

    for (const objectID of idsChunk) {
      const meta = metaByID.get(objectID);
      if (!meta) {
        continue;
      }
      const batchItem = byID.get(objectID);
      if (!batchItem) {
        throw new Error(`Missing object content in batch response for ${objectID}`);
      }
      if (batchItem?.error) {
        throw new Error(`Failed to fetch object content for ${objectID}: ${String(batchItem.error)}`);
      }

      writeJsonItem(res, state, {
        object_id: objectID,
        storage_path: String(meta?.storage_path || "").trim(),
        bucket: String(meta?.bucket || "").trim(),
        key: String(meta?.key || "").trim(),
        size_bytes: Number(batchItem?.size_bytes || meta?.size_bytes || 0),
        content_type: String(
          batchItem?.content_type || meta?.content_type || "application/octet-stream"
        ).trim(),
        created_at: meta?.created_at || "",
        content_base64: String(batchItem?.content_base64 || "").trim(),
      });
      count += 1;
    }
  }

  return count;
}

function initDownloadResponse(res, filename) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const kind = normalizeKind(req.query?.kind);

  try {
    const createdAt = new Date().toISOString();
    const objects = await listStorageObjects();
    const objectIDs = objects
      .map((item) => String(item?.object_id || "").trim())
      .filter(Boolean);

    if (kind === SNAPSHOT_KIND_EMBEDDINGS) {
      const filename = buildSnapshotFilename("embeddings-snapshot", createdAt);
      initDownloadResponse(res, filename);
      res.write(
        `{"format":${JSON.stringify(SNAPSHOT_FORMAT_EMBEDDINGS)},"kind":${JSON.stringify(
          kind
        )},"created_at":${JSON.stringify(createdAt)},"vectors":[`
      );
      await streamEmbeddingsArray(res, objectIDs);
      res.write("]}");
      return res.end();
    }

    if (kind === SNAPSHOT_KIND_VLM) {
      const fieldsPayload = await readMasterJson("/vlm/fields");
      const fields = Array.isArray(fieldsPayload?.fields) ? fieldsPayload.fields : [];

      const filename = buildSnapshotFilename("vlm-snapshot", createdAt);
      initDownloadResponse(res, filename);
      res.write(
        `{"format":${JSON.stringify(SNAPSHOT_FORMAT_VLM)},"kind":${JSON.stringify(
          kind
        )},"created_at":${JSON.stringify(createdAt)},"fields":${JSON.stringify(
          fields
        )},"annotations":[`
      );
      await streamVlmAnnotationsArray(res, objectIDs);
      res.write("]}");
      return res.end();
    }

    const fieldsPayload = await readMasterJson("/vlm/fields");
    const fields = Array.isArray(fieldsPayload?.fields) ? fieldsPayload.fields : [];

    const filename = buildSnapshotFilename("storage-full-snapshot", createdAt);
    initDownloadResponse(res, filename);

    res.write(
      `{"format":${JSON.stringify(SNAPSHOT_FORMAT_FULL)},"kind":${JSON.stringify(
        SNAPSHOT_KIND_FULL
      )},"created_at":${JSON.stringify(createdAt)},"objects":[`
    );
    await streamObjectsArray(res, objects);

    res.write(
      `],"embeddings":{"vectors":[`
    );
    await streamEmbeddingsArray(res, objectIDs);

    res.write(`]},"vlm":{"fields":${JSON.stringify(fields)},"annotations":[`);
    await streamVlmAnnotationsArray(res, objectIDs);

    res.write("]}}");
    return res.end();
  } catch (error) {
    if (!res.headersSent) {
      return res
        .status(error.status || 500)
        .json(error.payload || { error: error.message || "Failed to export snapshot" });
    }
    res.end();
  }
}
