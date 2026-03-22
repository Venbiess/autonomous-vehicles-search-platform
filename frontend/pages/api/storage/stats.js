const masterEndpoint = process.env.MASTER_ENDPOINT || "http://localhost:9002";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const params = new URLSearchParams();
    Object.entries(req.query || {}).forEach(([key, value]) => {
      if (Array.isArray(value)) {
        value.forEach((item) => params.append(key, String(item)));
      } else if (value !== undefined) {
        params.set(key, String(value));
      }
    });
    const qs = params.toString();
    const response = await fetch(
      `${masterEndpoint}/storage/stats${qs ? `?${qs}` : ""}`
    );
    const payload = await response.json();
    return res.status(response.status).json(payload);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
