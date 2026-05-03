import { getSnapshotExportProgress } from "../../../../lib/snapshotExportProgress";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const exportId = String(req.query?.export_id || "").trim();
  if (!exportId) {
    return res.status(400).json({ error: "export_id is required" });
  }

  const progress = getSnapshotExportProgress(exportId);
  if (!progress) {
    return res.status(200).json({
      export_id: exportId,
      phase: "unknown",
      bytes_written: 0,
      archive_bytes: null,
      status: "unknown",
    });
  }

  return res.status(200).json(progress);
}
