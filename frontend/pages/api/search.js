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

  const baseUrl = process.env.MINIO_PUBLIC_ENDPOINT || "http://localhost:9000";
  const safeKey = key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${baseUrl.replace(/\/$/, "")}/${bucket}/${safeKey}`;
}

export const config = {
  api: {
    bodyParser: false,
  },
};

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function normalizeResults(results, defaultBucket) {
  return (results || [])
    .map((item, index) => {
      const objectId = item.object_id || item.objectId || "";
      const directUrl = item.url || item.image_url || item.imageUrl || null;
      const url =
        (objectId && `/api/objects/${encodeURIComponent(objectId)}`) ||
        (typeof directUrl === "string" && directUrl.length > 0 ? directUrl : null) ||
        buildImageUrl(item.storage_path, defaultBucket);
      if (!url) return null;
      const identity = objectId || item.storage_path || url;
      return {
        id: `${identity}-${index}`,
        title: item.title || objectId || item.storage_path || url,
        url,
        score: item.similarity ?? item.distance ?? null,
        object_id: objectId || undefined,
      };
    })
    .filter(Boolean);
}

export default async function handler(req, res) {
  const { q, filter, limit } = req.query;
  const query = q || filter;
  const parsedLimit = Number.parseInt(
    Array.isArray(limit) ? limit[0] : limit || "",
    10
  );
  const topK =
    Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, 500)
      : 100;

  try {
    const masterEndpoint = process.env.MASTER_ENDPOINT || "http://localhost:9002";
    const defaultBucket = process.env.MINIO_BUCKET || "avsp";

    if (req.method === "POST") {
      const imageBytes = await readRawBody(req);
      if (!imageBytes.length) {
        return res.status(400).json({ error: "Image is required" });
      }

      const response = await fetch(
        `${masterEndpoint}/search/image_bytes?top_k=${topK}&max_rows=10000`,
        {
          method: "POST",
          headers: {
            "Content-Type":
              req.headers["content-type"] || "application/octet-stream",
          },
          body: imageBytes,
        }
      );
      if (!response.ok) {
        const text = await response.text();
        return res.status(502).json({ error: text });
      }
      const payload = await response.json();
      return res.status(200).json(normalizeResults(payload.results, defaultBucket));
    }

    if (!query || query.trim().length === 0) {
      return res.status(200).json([]);
    }

    const response = await fetch(`${masterEndpoint}/search/text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, top_k: topK, max_rows: 10000 }),
    });
    if (!response.ok) {
      const text = await response.text();
      return res.status(502).json({ error: text });
    }
    const payload = await response.json();
    return res.status(200).json(normalizeResults(payload.results, defaultBucket));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
