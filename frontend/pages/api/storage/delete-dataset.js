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
    const objects = await listStorageObjects();
    const selected = objects.filter((item) => String(item.bucket || "") === dataset);

    let deleted = 0;
    const errors = [];
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
        }
      } catch (error) {
        errors.push({
          object_id: item.object_id,
          storage_path: item.storage_path,
          error: error.message || "Unknown error",
        });
      }
    }

    return res.status(errors.length ? 207 : 200).json({
      dataset,
      selected_images: selected.length,
      deleted_images: deleted,
      failed_images: errors.length,
      errors,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Unknown error" });
  }
}
