import { readStorageJson, storageWriteHeaders } from "../../../lib/storageServer";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    if (!req.body?.confirm) {
      return res.status(400).json({ error: "confirm=true is required" });
    }
    const pageSize = Math.max(100, Math.min(5000, Number(req.body?.page_size || 1000)));
    const payload = await readStorageJson("/vectors/clear", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...storageWriteHeaders(),
      },
      body: JSON.stringify({ page_size: pageSize }),
    });
    let orphanRemoved = 0;
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
    return res.status(200).json({
      reset_embeddings: Number(payload?.deleted ?? payload?.requested ?? 0),
      orphan_embeddings_removed: orphanRemoved,
    });
  } catch (error) {
    return res
      .status(error.status || 500)
      .json(error.payload || { error: error.message });
  }
}
