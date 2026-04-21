import { listStorageObjects } from "../../../lib/storageServer";

const masterEndpoint = process.env.MASTER_ENDPOINT || "http://localhost:9002";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    if (!req.body?.confirm) {
      return res.status(400).json({ error: "confirm=true is required" });
    }
    const dataset = String(req.body?.dataset || "").trim();
    if (!dataset) {
      return res.status(400).json({ error: "dataset is required" });
    }
    const errors = [];
    let deleted = 0;
    let selectedTotal = 0;
    let attempts = 0;
    let remainingInDataset = 0;

    while (attempts < 3) {
      attempts += 1;
      const objects = await listStorageObjects();
      const selected = objects.filter((item) => String(item.bucket || "") === dataset);
      if (attempts === 1) {
        selectedTotal = selected.length;
      }
      if (selected.length === 0) {
        remainingInDataset = 0;
        break;
      }

      let deletedInAttempt = 0;
      for (const item of selected) {
        try {
          const response = await fetch(
            `${masterEndpoint}/objects/${encodeURIComponent(item.object_id)}`,
            { method: "DELETE" }
          );
          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload?.detail?.message || payload?.detail || payload?.error || response.statusText);
          }
          if (payload?.result?.object?.deleted) {
            deleted += 1;
            deletedInAttempt += 1;
          }
        } catch (error) {
          errors.push({
            attempt: attempts,
            object_id: item.object_id,
            storage_path: item.storage_path,
            error: error.message || "Unknown error",
          });
        }
      }

      const refreshed = await listStorageObjects();
      remainingInDataset = refreshed.filter(
        (item) => String(item.bucket || "") === dataset
      ).length;
      if (remainingInDataset === 0 || deletedInAttempt === 0) {
        break;
      }
    }

    return res.status(errors.length ? 207 : 200).json({
      dataset,
      selected_images: selectedTotal,
      deleted_images: deleted,
      remaining_images: remainingInDataset,
      attempts,
      failed_images: errors.length,
      errors,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Unknown error" });
  }
}
