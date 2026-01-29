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
    if (defaultBucket && ["data", "app", "tmp", "var"].includes(first)) {
      bucket = defaultBucket;
      key = rest.length > 0 ? rest[rest.length - 1] : first;
    } else {
      bucket = first;
      key = rest.join("/");
    }
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

export default async function handler(req, res) {
  const { q, filter } = req.query;
  const query = q || filter;
  if (!query || query.trim().length === 0) {
    return res.status(200).json([]);
  }

  try {
    const masterEndpoint =
      process.env.MASTER_ENDPOINT || "http://localhost:9002";
    const response = await fetch(`${masterEndpoint}/search/text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, top_k: 9, max_rows: 10000 }),
    });
    if (!response.ok) {
      const text = await response.text();
      return res.status(502).json({ error: text });
    }
    const payload = await response.json();
    const results = payload.results || [];
    const defaultBucket = process.env.MINIO_BUCKET || "avsp";
    const data = results
      .map((item, index) => {
        const directUrl = item.url || item.image_url || item.imageUrl || null;
        const url =
          typeof directUrl === "string" && directUrl.length > 0
            ? directUrl
            : buildImageUrl(item.storage_path, defaultBucket);
        if (!url) return null;
        return {
          id: `${item.storage_path}-${index}`,
          title: item.title || item.storage_path || url,
          url,
          score: item.similarity ?? item.distance ?? null,
        };
      })
      .filter(Boolean);

    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
