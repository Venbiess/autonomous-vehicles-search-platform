import {
  getSnapshotTransferJob,
  requestSnapshotTransferJobCancel,
} from "../../../lib/snapshotTransferJobs";

const masterEndpoint = process.env.MASTER_ENDPOINT || "http://localhost:9002";
const masterTimeoutMs = Number(process.env.MASTER_PROXY_TIMEOUT_MS || 10000);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const localJobId = String(req.body?.job_id || "").trim();
    if (localJobId) {
      const localJob = getSnapshotTransferJob(localJobId);
      if (localJob) {
        const updated = requestSnapshotTransferJobCancel(localJobId);
        return res.status(200).json({
          status: "ok",
          local: true,
          job: updated || localJob,
        });
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), masterTimeoutMs);
    const response = await fetch(`${masterEndpoint}/jobs/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
    const payload = await response.json();
    return res.status(response.status).json(payload);
  } catch (error) {
    if (error?.name === "AbortError") {
      return res.status(504).json({
        error: `Timed out waiting for master service (${masterTimeoutMs}ms)`,
      });
    }
    return res.status(500).json({ error: error.message || "Unknown error" });
  }
}
