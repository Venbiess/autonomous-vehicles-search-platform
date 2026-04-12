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
  if (!query || query.trim().length === 0) {
    return res.status(200).json([]);
  }

  try {
    const masterEndpoint =
      process.env.MASTER_ENDPOINT || "http://localhost:9002";
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
    const results = payload.results || [];
    const data = results
      .map((item, index) => {
        const objectId = item.object_id || "";
        if (!objectId) return null;
        const url = `/api/objects/${encodeURIComponent(objectId)}`;
        if (!url) return null;
        return {
          id: `${objectId}-${index}`,
          title: item.title || objectId,
          url,
          score: item.similarity ?? item.distance ?? null,
          object_id: objectId,
        };
      })
      .filter(Boolean);

    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
