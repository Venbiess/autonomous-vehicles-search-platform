import {
  listStorageObjects,
  readStorageJson,
  storageWriteHeaders,
} from "../../../lib/storageServer";
import { isDatasetVisible } from "../../../lib/datasetVisibility";

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
        reset_embeddings: 0,
      });
    }
    const payload = await readStorageJson("/vectors/delete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...storageWriteHeaders(),
      },
      body: JSON.stringify({ object_ids: objectIDs }),
    });
    return res.status(200).json({
      selected_images: selected.length,
      reset_embeddings: Number(payload?.requested || 0),
    });
  } catch (error) {
    return res
      .status(error.status || 500)
      .json(error.payload || { error: error.message });
  }
}
