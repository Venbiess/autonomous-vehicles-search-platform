import {
  readStorageJson,
  storageWriteHeaders,
} from "../../../../lib/storageServer";
import { isDatasetVisible } from "../../../../lib/datasetVisibility";

export default async function handler(req, res) {
  const { objectId } = req.query;
  if (!objectId || typeof objectId !== "string") {
    return res.status(400).json({ error: "objectId is required" });
  }

  try {
    if (req.method === "GET") {
      const payload = await readStorageJson(
        `/objects/${encodeURIComponent(objectId)}`
      );
      return res.status(200).json(payload);
    }

    if (req.method === "DELETE") {
      const objectPayload = await readStorageJson(
        `/objects/${encodeURIComponent(objectId)}`
      );
      const bucket = String(objectPayload?.bucket || "").trim();
      if (bucket && !isDatasetVisible(bucket)) {
        return res.status(400).json({
          error: `dataset '${bucket}' is hidden; delete is blocked`,
        });
      }
      const payload = await readStorageJson(
        `/objects/${encodeURIComponent(objectId)}`,
        {
          method: "DELETE",
          headers: storageWriteHeaders(),
        }
      );
      return res.status(200).json(payload);
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    return res
      .status(error.status || 500)
      .json(error.payload || { error: error.message });
  }
}
