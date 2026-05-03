import { isDatasetVisible } from "../../lib/datasetVisibility";
const masterEndpoint = process.env.MASTER_ENDPOINT || "http://localhost:9002";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const dataset = String(req.body?.dataset || "").trim();
    if (dataset && !isDatasetVisible(dataset)) {
      return res.status(400).json({ error: `dataset '${dataset}' is hidden` });
    }
    const response = await fetch(`${masterEndpoint}/embeddings/backfill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const payload = await response.json();
    return res.status(response.status).json(payload);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
