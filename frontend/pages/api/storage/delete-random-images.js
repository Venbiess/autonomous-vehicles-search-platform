import {
  listStorageObjects,
  readStorageJson,
  storageWriteHeaders,
} from "../../../lib/storageServer";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    if (!req.body?.confirm) {
      return res.status(400).json({ error: "confirm=true is required" });
    }
    const count = Math.max(1, Number(req.body?.count || 1));
    const objects = await listStorageObjects();
    const shuffled = [...objects].sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, Math.min(count, shuffled.length));
    const errors = [];
    let deletedImages = 0;

    for (const object of selected) {
      try {
        const payload = await readStorageJson(
          `/objects/${encodeURIComponent(object.object_id)}`,
          { method: "DELETE", headers: storageWriteHeaders() }
        );
        if (payload.deleted) deletedImages += 1;
      } catch (error) {
        errors.push({
          object_id: object.object_id,
          storage_path: object.storage_path,
          error: error.message,
        });
      }
    }

    return res.status(errors.length ? 207 : 200).json({
      selected_images: selected.length,
      deleted_images: deletedImages,
      deleted_source_rows: 0,
      failed_images: errors.length,
      errors,
    });
  } catch (error) {
    return res.status(error.status || 500).json(error.payload || { error: error.message });
  }
}
