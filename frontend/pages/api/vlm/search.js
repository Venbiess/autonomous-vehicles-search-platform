import { loadDatasetVisibility } from "../../lib/datasetVisibility";
const masterEndpoint = process.env.MASTER_ENDPOINT || "http://localhost:9002";

function buildImageUrl(storagePath, defaultBucket) {
  if (!storagePath || typeof storagePath !== "string") return null;
  if (storagePath.startsWith("http://") || storagePath.startsWith("https://")) {
    return storagePath;
  }
  let normalized = storagePath.replace(/\\/g, "/");
  if (normalized.startsWith("s3://")) {
    normalized = normalized.slice(5);
  }
  normalized = normalized.replace(/^\/+/, "");
  if (!normalized.includes("/")) return null;
  const [bucket, ...rest] = normalized.split("/");
  const key = rest.join("/");
  if (!bucket || !key) return null;
  const baseUrl = process.env.MINIO_PUBLIC_ENDPOINT || "http://localhost:9000";
  return `${baseUrl.replace(/\/$/, "")}/${bucket || defaultBucket}/${key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const hiddenDatasets = new Set(loadDatasetVisibility().hidden_datasets || []);
    const defaultBucket = process.env.MINIO_BUCKET || "avsp";
    const response = await fetch(`${masterEndpoint}/search/vlm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const payload = await response.json();
    if (!response.ok) {
      return res.status(response.status).json(payload);
    }

    const results = (payload.results || [])
      .map((item, index) => {
        const objectId = item.object_id || "";
        const storagePath = item.storage_path || "";
        const normalized = String(storagePath || "")
          .replace(/^s3:\/\//, "")
          .replace(/^\/+/, "");
        const storageBucket = normalized.split("/")[0] || "";
        if (storageBucket && hiddenDatasets.has(storageBucket)) {
          return null;
        }
        const directUrl = item.url || item.image_url || item.imageUrl || null;
        const url =
          (objectId && `/api/objects/${encodeURIComponent(objectId)}`) ||
          (typeof directUrl === "string" && directUrl.length > 0 ? directUrl : null) ||
          buildImageUrl(storagePath, defaultBucket);
        if (!url && !storagePath) return null;
        const attributes = item.attributes || {};
        const title =
          Object.keys(attributes).length > 0
            ? Object.entries(attributes)
                .map(([key, value]) => `${key}: ${value}`)
                .join(" | ")
            : objectId || storagePath;
        const identity = objectId || storagePath || url || `item-${index}`;
        return {
          id: `${identity}-${index}`,
          title,
          url: url || "",
          attributes,
          object_id: objectId || undefined,
          storage_path: storagePath || undefined,
        };
      })
      .filter(Boolean);

    return res.status(200).json(results);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
