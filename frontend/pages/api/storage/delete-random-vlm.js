import { listStorageObjects } from "../../../lib/storageServer";
import { isDatasetVisible } from "../../../lib/datasetVisibility";

const masterEndpoint = process.env.MASTER_ENDPOINT || "http://localhost:9002";

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
    const selected = shuffled.slice(0, Math.min(count, shuffled.length));
    const objectIDs = selected.map((item) => item.object_id).filter(Boolean);
    if (objectIDs.length === 0) {
      return res.status(200).json({
        selected_images: 0,
        reset_vlm_annotations: 0,
      });
    }
    const response = await fetch(`${masterEndpoint}/vlm/annotations/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ object_ids: objectIDs }),
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
      selected_images: selected.length,
      reset_vlm_annotations: Number(payload?.requested || 0),
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Unknown error" });
  }
}
