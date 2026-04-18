import {
  readStorageJson,
  storageWriteHeaders,
} from "../../../../lib/storageServer";

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
