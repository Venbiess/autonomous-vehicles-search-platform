import {
  loadDatasetVisibility,
  setDatasetVisibility,
} from "../../../lib/datasetVisibility";

export default async function handler(req, res) {
  if (req.method === "GET") {
    const payload = loadDatasetVisibility();
    return res.status(200).json(payload);
  }

  if (req.method === "POST") {
    try {
      const dataset = String(req.body?.dataset || "").trim();
      const visible = Boolean(req.body?.visible);
      const payload = setDatasetVisibility(dataset, visible);
      return res.status(200).json(payload);
    } catch (error) {
      return res.status(400).json({ error: error.message || "Invalid payload" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
