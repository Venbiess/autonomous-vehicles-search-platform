import { listStorageObjects } from "../../../lib/storageServer";
import { isDatasetVisible } from "../../../lib/datasetVisibility";

const masterEndpoint = process.env.MASTER_ENDPOINT || "http://localhost:9002";
const CHUNK_SIZE = 500;

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
    const candidateObjectIDs = shuffled
      .map((item) => String(item?.object_id || "").trim())
      .filter(Boolean);
    const selectedIDs = [];
    let availableAnnotations = 0;
    const chunks = chunkArray(candidateObjectIDs, CHUNK_SIZE);
    for (const chunk of chunks) {
      if (chunk.length === 0) continue;
      const probeResponse = await fetch(`${masterEndpoint}/vlm/annotations/get`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ object_ids: chunk }),
      });
      const probePayload = await probeResponse.json();
      if (!probeResponse.ok) {
        const detail = probePayload?.detail;
        const message =
          (typeof detail === "string" && detail) ||
          probePayload?.error ||
          probeResponse.statusText;
        return res.status(probeResponse.status).json({ error: message });
      }
      const rows = Array.isArray(probePayload?.rows) ? probePayload.rows : [];
      const annotatedIDs = new Set(
        rows
          .map((row) => String(row?.object_id || "").trim())
          .filter(Boolean)
      );
      if (annotatedIDs.size > 0) {
        availableAnnotations += annotatedIDs.size;
        for (const objectID of chunk) {
          if (!annotatedIDs.has(objectID)) continue;
          if (selectedIDs.length < count) {
            selectedIDs.push(objectID);
          }
        }
      }
      if (selectedIDs.length >= count) {
        break
      }
    }
    if (selectedIDs.length === 0) {
      return res.status(200).json({
        requested_count: count,
        available_vlm_annotations: availableAnnotations,
        selected_images: 0,
        reset_vlm_annotations: 0,
      });
    }
    const response = await fetch(`${masterEndpoint}/vlm/annotations/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ object_ids: selectedIDs }),
    });
    const payload = await response.json();
    if (!response.ok) {
      const detail = payload?.detail;
      const message =
        (typeof detail === "string" && detail) ||
        payload?.error ||
        response.statusText;
      return res.status(response.status).json({ error: message });
    }
    return res.status(200).json({
      requested_count: count,
      available_vlm_annotations: availableAnnotations,
      selected_images: selectedIDs.length,
      reset_vlm_annotations: Number(payload?.deleted ?? payload?.requested ?? 0),
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Unknown error" });
  }
}
