export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  return res.status(501).json({
    error:
      "Deleting source-table duplicates is not supported by the storage server API.",
  });
}
