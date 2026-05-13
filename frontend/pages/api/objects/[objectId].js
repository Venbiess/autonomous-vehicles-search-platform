import { storageEndpoint } from "../../../lib/storageServer";

export const config = {
  api: {
    responseLimit: false,
  },
};

const OBJECT_PROXY_TIMEOUT_MS = Number(process.env.OBJECT_PROXY_TIMEOUT_MS || 12000);
const OBJECT_PROXY_RETRY_ATTEMPTS = Math.max(
  1,
  Number.parseInt(process.env.OBJECT_PROXY_RETRY_ATTEMPTS || "3", 10) || 3
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

async function fetchObjectContentWithRetry(url) {
  let lastError = null;
  for (let attempt = 1; attempt <= OBJECT_PROXY_RETRY_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OBJECT_PROXY_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
      });
      if (response.ok) {
        return response;
      }
      if (!isRetryableStatus(response.status) || attempt >= OBJECT_PROXY_RETRY_ATTEMPTS) {
        return response;
      }
      await sleep(Math.min(250 * attempt, 1000));
      continue;
    } catch (error) {
      lastError = error;
      if (attempt >= OBJECT_PROXY_RETRY_ATTEMPTS) {
        throw error;
      }
      await sleep(Math.min(250 * attempt, 1000));
    } finally {
      clearTimeout(timeout);
    }
  }
  if (lastError) {
    throw lastError;
  }
  throw new Error("object content proxy failed");
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { objectId } = req.query;
  if (!objectId || typeof objectId !== "string") {
    return res.status(400).json({ error: "objectId is required" });
  }

  try {
    const response = await fetchObjectContentWithRetry(
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
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=120");
    return res.status(200).send(buffer);
  } catch (error) {
    return res.status(502).json({ error: error.message || "Object proxy failed" });
  }
}
