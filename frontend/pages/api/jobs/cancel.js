const masterEndpoint = process.env.MASTER_ENDPOINT || "http://localhost:9002";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const response = await fetch(`${masterEndpoint}/jobs/cancel`, {
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
