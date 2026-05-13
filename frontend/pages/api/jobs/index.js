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

async function readPayloadSafe(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const localSnapshotJobs = listSnapshotTransferJobs();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), masterTimeoutMs);
    const response = await fetch(`${masterEndpoint}/jobs`, { signal: controller.signal }).finally(
      () => clearTimeout(timeout)
    );
    const rawPayload = await readPayloadSafe(response);
    const payload = normalizeJobsPayload(rawPayload);
    const merged = [...localSnapshotJobs, ...payload.jobs];
    merged.sort((left, right) => Number(right?.created_at || 0) - Number(left?.created_at || 0));
    if (!response.ok) {
      const upstreamError =
        typeof payload?.error === "string" && payload.error.trim()
          ? payload.error
          : `Master service responded with status=${response.status}`;
      return res.status(200).json({
        ...payload,
        ok: false,
        upstream_status: response.status,
        error: upstreamError,
        jobs: merged,
      });
    }
    return res.status(200).json({ ...payload, ok: true, jobs: merged });
  } catch (error) {
    const localSnapshotJobs = listSnapshotTransferJobs();
    if (error?.name === "AbortError") {
      return res.status(200).json({
        ok: false,
        upstream_status: 504,
        error: `Timed out waiting for master service (${masterTimeoutMs}ms)`,
        jobs: localSnapshotJobs,
      });
    }
    return res.status(200).json({
      ok: false,
      upstream_status: 500,
      error: error.message || "Unknown error",
      jobs: localSnapshotJobs,
    });
  }
}
