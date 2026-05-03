import { listSnapshotTransferJobs } from "../../../lib/snapshotTransferJobs";

const masterEndpoint = process.env.MASTER_ENDPOINT || "http://localhost:9002";
const masterTimeoutMs = Number(process.env.MASTER_PROXY_TIMEOUT_MS || 10000);

function normalizeJobsPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return { jobs: [] };
  }
  const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
  return { ...payload, jobs };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), masterTimeoutMs);
    const response = await fetch(`${masterEndpoint}/jobs`, { signal: controller.signal }).finally(
      () => clearTimeout(timeout)
    );
    const payload = normalizeJobsPayload(await response.json());
    const localSnapshotJobs = listSnapshotTransferJobs();
    const merged = [...localSnapshotJobs, ...payload.jobs];
    merged.sort((left, right) => Number(right?.created_at || 0) - Number(left?.created_at || 0));
    return res.status(response.status).json({ ...payload, jobs: merged });
  } catch (error) {
    const localSnapshotJobs = listSnapshotTransferJobs();
    if (error?.name === "AbortError") {
      return res.status(504).json({
        error: `Timed out waiting for master service (${masterTimeoutMs}ms)`,
        jobs: localSnapshotJobs,
      });
    }
    return res.status(500).json({ error: error.message || "Unknown error", jobs: localSnapshotJobs });
  }
}
