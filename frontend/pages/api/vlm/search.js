function buildImageUrl(storagePath, defaultBucket) {
  if (storagePath.startsWith("http://") || storagePath.startsWith("https://")) {
    return storagePath;
  }

  let normalized = storagePath.replace(/\\/g, "/");
  if (normalized.startsWith("s3://")) {
    normalized = normalized.slice(5);
  }
  normalized = normalized.replace(/^\/+/, "");

  let bucket = "";
  let key = "";
  if (!normalized.includes("/") && defaultBucket) {
    bucket = defaultBucket;
    key = normalized;
  } else if (normalized.includes("/")) {
    const [first, ...rest] = normalized.split("/");
    bucket = first;
    key = rest.join("/");
  }

  if (!bucket || !key) return null;
  const baseUrl =
    process.env.MINIO_PUBLIC_ENDPOINT || "http://localhost:9000";
  const safeKey = key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${baseUrl.replace(/\/$/, "")}/${bucket}/${safeKey}`;
}

const masterEndpoint = process.env.MASTER_ENDPOINT || "http://localhost:9002";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const response = await fetch(`${masterEndpoint}/search/vlm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const payload = await response.json();
    if (!response.ok) {
      return res.status(response.status).json(payload);
    }

    const defaultBucket = process.env.MINIO_BUCKET || "avsp";
    const results = (payload.results || [])
      .map((item, index) => {
        const url = buildImageUrl(item.storage_path, defaultBucket);
        if (!url) return null;
        const attributes = item.attributes || {};
        const title =
          Object.keys(attributes).length > 0
            ? Object.entries(attributes)
                .map(([key, value]) => `${key}: ${value}`)
                .join(" | ")
            : item.storage_path;
        return {
          id: `${item.storage_path}-${index}`,
          title,
          url,
          attributes,
        };
      })
      .filter(Boolean);

    return res.status(200).json(results);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
