const masterTimeoutMs = Number(process.env.MASTER_PROXY_TIMEOUT_MS || 10000);

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const masterEndpoint =
      process.env.MASTER_ENDPOINT || "http://localhost:9002";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), masterTimeoutMs);
    const response = await fetch(`${masterEndpoint}/system-info`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!response.ok) {
      const text = await response.text();
      return res.status(502).json({ error: text });
    }

    const data = await response.json();
    return res.status(200).json(data);
  } catch (error) {
    if (error?.name === "AbortError") {
      return res.status(504).json({
        error: `Timed out waiting for master service (${masterTimeoutMs}ms)`,
      });
    }
    return res.status(500).json({ error: error.message || "Unknown error" });
  }
}
