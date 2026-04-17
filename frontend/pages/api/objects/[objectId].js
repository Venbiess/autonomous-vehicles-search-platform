import { storageEndpoint } from "../../../lib/storageServer";

export const config = {
  api: {
    responseLimit: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { objectId } = req.query;
  if (!objectId || typeof objectId !== "string") {
    return res.status(400).json({ error: "objectId is required" });
  }

  try {
    const response = await fetch(
      `${storageEndpoint()}/objects/${encodeURIComponent(objectId)}/content`
    );
    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).send(text);
    }
    const contentType =
      response.headers.get("content-type") || "application/octet-stream";
    const buffer = Buffer.from(await response.arrayBuffer());
    res.setHeader("Content-Type", contentType);
    return res.status(200).send(buffer);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
