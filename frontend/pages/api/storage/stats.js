import { buildStorageStats, listStorageObjects } from "../../../lib/storageServer";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const objects = await listStorageObjects();
    return res.status(200).json(buildStorageStats(objects));
  } catch (error) {
    return res.status(error.status || 500).json(error.payload || { error: error.message });
  }
}
