import { readStorageJson } from "../../../../lib/storageServer";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const limit = Math.max(1, Math.min(256, Number(req.query?.limit || 20)));
  const cursor =
    typeof req.query?.cursor === "string" ? req.query.cursor.trim() : "";

  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) {
    params.set("cursor", cursor);
  }

  try {
    const payload = await readStorageJson(`/objects?${params.toString()}`);
    return res.status(200).json({
      items: payload.items || [],
      next_cursor: payload.next_cursor || "",
    });
  } catch (error) {
    return res
      .status(error.status || 500)
      .json(error.payload || { error: error.message });
  }
}
