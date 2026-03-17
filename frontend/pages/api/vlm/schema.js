const masterEndpoint = process.env.MASTER_ENDPOINT || "http://localhost:9002";

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const response = await fetch(`${masterEndpoint}/vlm/fields`);
      const payload = await response.json();
      return res.status(response.status).json(payload);
    }

    if (req.method === "POST") {
      const response = await fetch(`${masterEndpoint}/vlm/fields`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body),
      });
      const payload = await response.json();
      return res.status(response.status).json(payload);
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
