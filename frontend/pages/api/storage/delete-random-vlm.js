import { listStorageObjects } from "../../../lib/storageServer";
import { isDatasetVisible } from "../../../lib/datasetVisibility";

const MASTER_ENDPOINTS = [
  process.env.MASTER_ENDPOINT,
  process.env.MASTER_SERVER_ENDPOINT,
  "http://localhost:9002",
  "http://master-server:9002",
  "http://master:9002",
]
  .map((value) => String(value || "").trim().replace(/\/$/, ""))
  .filter(Boolean);
const CHUNK_SIZE = 500;
const DELETE_CHUNK_SIZE = 250;
const masterTimeoutMs = Math.max(1000, Number(process.env.MASTER_PROXY_TIMEOUT_MS || 30000));
const retryableStatuses = new Set([408, 429, 500, 502, 503, 504]);

function chunkArray(values, chunkSize) {
  const out = [];
  for (let i = 0; i < values.length; i += chunkSize) {
    out.push(values.slice(i, i + chunkSize));
  }
  return out;
}

function describeFetchError(error) {
  const message = String(error?.message || "").trim();
  const cause = error?.cause;
  if (!cause || typeof cause !== "object") {
    return message || "fetch failed";
  }
  const code = String(cause.code || cause.errno || "").trim();
  const syscall = String(cause.syscall || "").trim();
  const address = String(cause.address || "").trim();
  const port = Number(cause.port || 0);
  const bits = [message || "fetch failed"];
  if (code) bits.push(`code=${code}`);
  if (syscall) bits.push(`syscall=${syscall}`);
  if (address) bits.push(`address=${address}${port > 0 ? `:${port}` : ""}`);
  return bits.join("; ");
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

async function readMasterJson(pathname, body, options = {}) {
  const attempts = Math.max(1, Number(options.attempts || 3));
  let lastError = null;

  for (const endpoint of MASTER_ENDPOINTS) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), masterTimeoutMs);
      try {
        const response = await fetch(`${endpoint}${pathname}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body || {}),
          signal: controller.signal,
        });
        const payload = await readJsonResponse(response);
        if (!response.ok) {
          const status = Number(response.status || 0);
          const detail = payload?.detail;
          const message =
            (typeof detail === "string" && detail) ||
            payload?.error ||
            response.statusText ||
            `HTTP ${status}`;
          const error = new Error(message);
          error.status = status || 500;
          error.payload = payload;
          throw error;
        }
        return payload;
      } catch (error) {
        lastError = error;
        const status = Number(error?.status || 0);
        const retryableStatus = retryableStatuses.has(status);
        const transientNetwork = /fetch failed|network|timeout|aborted|ECONNRESET|ECONNREFUSED/i.test(
          String(error?.message || "")
        );
        const shouldRetry = retryableStatus || transientNetwork;
        if (shouldRetry && attempt < attempts) {
          await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
          continue;
        }
        break;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  const fallbackError =
    lastError instanceof Error ? lastError : new Error("master endpoint is unavailable");
  if (!fallbackError.message.includes("tried:")) {
    fallbackError.message = `${fallbackError.message}; tried: ${MASTER_ENDPOINTS.join(", ")}`;
  }
  throw fallbackError;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    if (!req.body?.confirm) {
      return res.status(400).json({ error: "confirm=true is required" });
    }
    const count = Math.max(1, Number(req.body?.count || 1));
    const dataset = String(req.body?.dataset || "").trim();
    if (dataset && !isDatasetVisible(dataset)) {
      return res.status(400).json({ error: `dataset '${dataset}' is hidden` });
    }

    const objects = await listStorageObjects();
    const scoped = (dataset
      ? objects.filter((item) => String(item?.bucket || "").trim() === dataset)
      : objects
    ).filter((item) => isDatasetVisible(String(item?.bucket || "").trim()));

    const shuffled = [...scoped].sort(() => Math.random() - 0.5);
    const candidateObjectIDs = shuffled
      .map((item) => String(item?.object_id || "").trim())
      .filter(Boolean);

    const selectedIDs = [];
    let availableAnnotations = 0;
    const chunks = chunkArray(candidateObjectIDs, CHUNK_SIZE);

    for (const chunk of chunks) {
      if (chunk.length === 0) continue;
      const probePayload = await readMasterJson("/vlm/annotations/get", { object_ids: chunk });
      const rows = Array.isArray(probePayload?.rows) ? probePayload.rows : [];
      const annotatedIDs = new Set(
        rows
          .map((row) => String(row?.object_id || "").trim())
          .filter(Boolean)
      );
      if (annotatedIDs.size > 0) {
        availableAnnotations += annotatedIDs.size;
        for (const objectID of chunk) {
          if (!annotatedIDs.has(objectID)) continue;
          if (selectedIDs.length < count) {
            selectedIDs.push(objectID);
          }
        }
      }
      if (selectedIDs.length >= count) {
        break;
      }
    }

    if (selectedIDs.length === 0) {
      return res.status(200).json({
        requested_count: count,
        available_vlm_annotations: availableAnnotations,
        selected_images: 0,
        reset_vlm_annotations: 0,
      });
    }

    let requestedTotal = 0;
    for (const chunk of chunkArray(selectedIDs, DELETE_CHUNK_SIZE)) {
      if (chunk.length === 0) continue;
      const payload = await readMasterJson("/vlm/annotations/delete", {
        object_ids: chunk,
      });
      requestedTotal += Number(payload?.deleted ?? payload?.requested ?? chunk.length);
    }

    return res.status(200).json({
      requested_count: count,
      available_vlm_annotations: availableAnnotations,
      selected_images: selectedIDs.length,
      reset_vlm_annotations: requestedTotal,
    });
  } catch (error) {
    const status = Number(error?.status || 500);
    const payload = error?.payload && typeof error.payload === "object" ? error.payload : null;
    const baseMessage = String(error?.message || "").trim() || "Unknown error";
    const message = /fetch failed/i.test(baseMessage) ? describeFetchError(error) : baseMessage;
    return res.status(status).json(payload || { error: message });
  }
}
