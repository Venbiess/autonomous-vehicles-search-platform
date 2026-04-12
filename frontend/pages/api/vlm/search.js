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

    const results = (payload.results || [])
      .map((item, index) => {
        const objectId = item.object_id || "";
        if (!objectId) return null;
        const url = `/api/objects/${encodeURIComponent(objectId)}`;
        if (!url) return null;
        const attributes = item.attributes || {};
        const title =
          Object.keys(attributes).length > 0
            ? Object.entries(attributes)
                .map(([key, value]) => `${key}: ${value}`)
                .join(" | ")
            : objectId;
        return {
          id: `${objectId}-${index}`,
          title,
          url,
          attributes,
          object_id: objectId,
        };
      })
      .filter(Boolean);

    return res.status(200).json(results);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
