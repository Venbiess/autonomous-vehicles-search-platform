import {
  listStorageObjects,
  readStorageJson,
  storageWriteHeaders,
} from "../../../lib/storageServer";
import { isDatasetVisible } from "../../../lib/datasetVisibility";

function chunkArray(values, chunkSize) {
  const out = [];
  for (let i = 0; i < values.length; i += chunkSize) {
    out.push(values.slice(i, i + chunkSize));
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    if (!req.body?.confirm) {
      return res.status(400).json({ error: "confirm=true is required" });
    }
    const count = Math.max(1, Number(req.body?.count || 1));
    const dataset = String(req.body?.dataset || "").trim();
    if (dataset && !isDatasetVisible(dataset)) {
      return res.status(400).json({ error: `dataset '${dataset}' is hidden` });
    }
    const objects = await listStorageObjects();
    const scoped = (dataset
      ? objects.filter((item) => String(item?.bucket || "").trim() === dataset)
      : objects
    ).filter((item) => isDatasetVisible(String(item?.bucket || "").trim()));
    const shuffled = [...scoped].sort(() => Math.random() - 0.5);
    const candidateObjectIDs = shuffled.map((item) => item.object_id).filter(Boolean);
    if (candidateObjectIDs.length === 0) {
      return res.status(200).json({
        requested_count: count,
        available_embeddings: 0,
        selected_images: 0,
        reset_embeddings: 0,
        orphan_embeddings_removed: 0,
      });
    }
    const existingWithEmbeddings = [];
    const chunks = chunkArray(candidateObjectIDs, 500);
    for (const chunk of chunks) {
      if (chunk.length === 0) continue;
      const payload = await readStorageJson("/vectors/completed-object-ids", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ object_ids: chunk }),
      });
      const ids = Array.isArray(payload?.object_ids) ? payload.object_ids : [];
      for (const id of ids) {
        const normalized = String(id || "").trim();
        if (normalized) {
          existingWithEmbeddings.push(normalized);
        }
      }
    }
    const availableUnique = Array.from(new Set(existingWithEmbeddings));
    const selectedIDs = availableUnique.slice(0, Math.min(count, availableUnique.length));
    let orphanRemoved = 0;
    const cleanupOrphans = async () => {
      try {
        const cleanupPayload = await readStorageJson("/vectors/cleanup-orphans", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...storageWriteHeaders(),
          },
        });
        orphanRemoved = Number(cleanupPayload?.deleted ?? cleanupPayload?.requested ?? 0);
      } catch {
        orphanRemoved = 0;
      }
    };
    if (selectedIDs.length === 0) {
      await cleanupOrphans();
      return res.status(200).json({
        requested_count: count,
        available_embeddings: availableUnique.length,
        selected_images: 0,
        reset_embeddings: 0,
        orphan_embeddings_removed: orphanRemoved,
      });
    }
    const payload = await readStorageJson("/vectors/delete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...storageWriteHeaders(),
      },
      body: JSON.stringify({ object_ids: selectedIDs }),
    });
    await cleanupOrphans();
    return res.status(200).json({
      requested_count: count,
      available_embeddings: availableUnique.length,
      selected_images: selectedIDs.length,
      reset_embeddings: Number(payload?.deleted ?? payload?.requested ?? 0),
      orphan_embeddings_removed: orphanRemoved,
    });
  } catch (error) {
    return res
      .status(error.status || 500)
      .json(error.payload || { error: error.message });
  }
}
