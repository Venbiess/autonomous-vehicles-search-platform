import { loadDatasetVisibility } from "../../lib/datasetVisibility";

const MASTER_PROXY_TIMEOUT_MS = Number(process.env.MASTER_PROXY_TIMEOUT_MS || 15000);
const MASTER_PROXY_RETRY_ATTEMPTS = Math.max(
  1,
  Number.parseInt(process.env.MASTER_PROXY_RETRY_ATTEMPTS || "2", 10) || 2
);
const DEFAULT_VISIBLE_LIMIT = 100;
const MAX_VISIBLE_LIMIT = Math.max(
  DEFAULT_VISIBLE_LIMIT,
  Number.parseInt(process.env.SEARCH_VISIBLE_LIMIT_MAX || "5000", 10) || 5000
);
const MAX_PROBE_TOP_K = Math.max(
  DEFAULT_VISIBLE_LIMIT,
  Number.parseInt(process.env.SEARCH_VISIBLE_PROBE_MAX || "5000", 10) || 5000
);
const MIN_PROBE_TOP_K = 100;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

async function fetchMasterWithRetry(url, init = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= MASTER_PROXY_RETRY_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MASTER_PROXY_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
      if (!response.ok && isRetryableStatus(response.status) && attempt < MASTER_PROXY_RETRY_ATTEMPTS) {
        await sleep(Math.min(250 * attempt, 1000));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt >= MASTER_PROXY_RETRY_ATTEMPTS) {
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
  throw new Error("master request failed");
}

function buildImageUrl(storagePath, defaultBucket) {
  if (!storagePath || typeof storagePath !== "string") return null;
  if (storagePath.startsWith("http://") || storagePath.startsWith("https://")) {
    return storagePath;
  }

  let normalized = storagePath.replace(/\\/g, "/");
  if (normalized.startsWith("s3://")) {
    normalized = normalized.slice(5);
  }
  normalized = normalized.replace(/^\/+/, "");

  let bucket = "";
  let key = "";
  if (!normalized.includes("/") && defaultBucket) {
    bucket = defaultBucket;
    key = normalized;
  } else if (normalized.includes("/")) {
    const [first, ...rest] = normalized.split("/");
    bucket = first;
    key = rest.join("/");
  }
  if (!bucket || !key) return null;

  const baseUrl =
    process.env.OBJECT_STORE_PUBLIC_ENDPOINT ||
    process.env.MINIO_PUBLIC_ENDPOINT ||
    "http://localhost:9000";
  const safeKey = key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${baseUrl.replace(/\/$/, "")}/${bucket}/${safeKey}`;
}

function storageEndpoint() {
  return (process.env.STORAGE_SERVER_ENDPOINT || "http://localhost:9013").replace(
    /\/$/,
    ""
  );
}

function readSingleQueryParam(value) {
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}

function parsePositiveInt(rawValue, fallbackValue, maxValue) {
  const parsed = Number.parseInt(readSingleQueryParam(rawValue), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackValue;
  return Math.max(1, Math.min(parsed, maxValue));
}

function parseOptionalFiniteNumber(rawValue) {
  const raw = String(readSingleQueryParam(rawValue) || "").trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractStoragePath(item) {
  const candidate =
    item.storage_path ||
    item.storagePath ||
    item?.storage?.path ||
    item?.metadata?.storage_path ||
    "";
  return typeof candidate === "string" ? candidate.trim() : "";
}

async function loadObjectMetadata(objectId, endpoint) {
  if (!objectId) return null;
  try {
    const response = await fetch(
      `${endpoint}/objects/${encodeURIComponent(objectId)}`
    );
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function mapWithConcurrency(items, worker, concurrency = 16) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];
  const limit = Math.max(1, Math.min(64, Number(concurrency) || 16));
  const out = new Array(list.length);
  let nextIndex = 0;
  const runWorker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= list.length) {
        return;
      }
      out[index] = await worker(list[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, list.length) }, () => runWorker())
  );
  return out;
}

export const config = {
  api: {
    bodyParser: false,
  },
};

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

async function normalizeResults(results, defaultBucket) {
  const items = Array.isArray(results) ? results : [];
  const endpoint = storageEndpoint();
  const metadataByObjectId = new Map();
  const hiddenDatasets = new Set(loadDatasetVisibility().hidden_datasets || []);

  const missingPathObjectIds = Array.from(
    new Set(
      items
        .map((item) => item.object_id || item.objectId || "")
        .filter(
          (objectId, index) =>
            typeof objectId === "string" &&
            objectId.trim().length > 0 &&
            extractStoragePath(items[index]).length === 0
        )
    )
  );

  if (missingPathObjectIds.length > 0) {
    const metadataEntries = await mapWithConcurrency(
      missingPathObjectIds,
      async (objectId) => {
        const payload = await loadObjectMetadata(objectId, endpoint);
        return [objectId, payload];
      },
      Number.parseInt(process.env.SEARCH_METADATA_LOOKUP_CONCURRENCY || "16", 10) || 16
    );
    for (const [objectId, payload] of metadataEntries) {
      metadataByObjectId.set(objectId, payload);
    }
  }

  return items
    .map((item, index) => {
      const objectId = item.object_id || item.objectId || "";
      const directUrl = item.url || item.image_url || item.imageUrl || null;
      const metadata = objectId ? metadataByObjectId.get(objectId) : null;
      const storagePath =
        extractStoragePath(item) ||
        extractStoragePath(metadata || {}) ||
        "";
      const storageBucket = (() => {
        if (metadata && typeof metadata.bucket === "string" && metadata.bucket.trim()) {
          return metadata.bucket.trim();
        }
        const normalized = storagePath.replace(/^s3:\/\//, "").replace(/^\/+/, "");
        const first = normalized.split("/")[0] || "";
        return first.trim();
      })();
      if (storageBucket && hiddenDatasets.has(storageBucket)) {
        return null;
      }
      const storageUrl = buildImageUrl(storagePath, defaultBucket);
      const url =
        (objectId && `/api/objects/${encodeURIComponent(objectId)}`) ||
        (typeof directUrl === "string" && directUrl.length > 0 ? directUrl : null) ||
        storageUrl;
      if (!url) return null;
      const identity = objectId || storagePath || url;
      return {
        id: `${identity}-${index}`,
        title: item.title || objectId || storagePath || url,
        url,
        score: item.similarity ?? item.distance ?? null,
        object_id: objectId || undefined,
        storage_path: storagePath || undefined,
        storage_url: storageUrl || undefined,
      };
    })
    .filter(Boolean);
}

export default async function handler(req, res) {
  const { q, filter, limit, count_min_score: countMinScoreQuery, count_only: countOnlyQuery } =
    req.query;
  const query = String(readSingleQueryParam(q || filter) || "").trim();
  const requestedVisibleLimit = parsePositiveInt(
    limit,
    DEFAULT_VISIBLE_LIMIT,
    MAX_VISIBLE_LIMIT
  );
  const requestedCountMinScore = parseOptionalFiniteNumber(countMinScoreQuery);
  const countOnlyRaw = String(readSingleQueryParam(countOnlyQuery) || "").trim().toLowerCase();
  const countOnly = countOnlyRaw === "1" || countOnlyRaw === "true";

  try {
    const masterEndpoint = process.env.MASTER_ENDPOINT || "http://localhost:9002";
    const defaultBucket =
      process.env.OBJECT_STORE_DEFAULT_BUCKET ||
      process.env.MINIO_BUCKET ||
      "avsp";
    const maxProbeTopK = Math.max(requestedVisibleLimit, MAX_PROBE_TOP_K);

    const runMasterSearch = async ({ topK, countMinScore, imageBytes }) => {
      if (imageBytes) {
        const countParam =
          countMinScore === null
            ? ""
            : `&count_min_similarity=${encodeURIComponent(countMinScore)}`;
        const response = await fetchMasterWithRetry(
          `${masterEndpoint}/search/image_bytes?top_k=${topK}&max_rows=10000${countParam}`,
          {
            method: "POST",
            headers: {
              "Content-Type":
                req.headers["content-type"] || "application/octet-stream",
            },
            body: imageBytes,
          }
        );
        if (!response.ok) {
          const text = await response.text();
          throw new Error(text || "master image search failed");
        }
        return response.json();
      }
      const body = {
        query,
        top_k: topK,
        max_rows: 10000,
      };
      if (countMinScore !== null) {
        body.count_min_similarity = countMinScore;
      }
      const response = await fetchMasterWithRetry(`${masterEndpoint}/search/text`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || "master text search failed");
      }
      return response.json();
    };

    let imageBytes = null;
    if (req.method === "POST") {
      imageBytes = await readRawBody(req);
      if (!imageBytes.length) {
        return res.status(400).json({ error: "Image is required" });
      }
    } else if (!query || query.trim().length === 0) {
      return res.status(200).json({
        items: [],
        pagination: {
          requested_visible_limit: requestedVisibleLimit,
          returned_visible: 0,
          probed_top_k: 0,
          has_more: false,
        },
      });
    }

    if (countOnly) {
      if (requestedCountMinScore === null) {
        return res.status(200).json({
          items: [],
          total_matching_count: null,
          total_matching_min_similarity: null,
          pagination: {
            requested_visible_limit: 0,
            returned_visible: 0,
            visible_loaded: 0,
            raw_loaded: 0,
            probed_top_k: 0,
            has_more: false,
            max_probe_top_k: maxProbeTopK,
            raw_exhausted: true,
          },
        });
      }
      const payload = await runMasterSearch({
        topK: 1,
        countMinScore: requestedCountMinScore,
        imageBytes,
      });
      const warning =
        payload?.warning && typeof payload.warning === "object" ? payload.warning : null;
      const totalCountRaw = Number(payload?.total_matching_count);
      const totalMinRaw = Number(payload?.total_matching_min_similarity);
      return res.status(200).json({
        items: [],
        warning,
        total_matching_count: Number.isFinite(totalCountRaw) ? totalCountRaw : null,
        total_matching_min_similarity: Number.isFinite(totalMinRaw) ? totalMinRaw : null,
        pagination: {
          requested_visible_limit: 0,
          returned_visible: 0,
          visible_loaded: 0,
          raw_loaded: 0,
          probed_top_k: 1,
          has_more: false,
          max_probe_top_k: maxProbeTopK,
          raw_exhausted: true,
        },
      });
    }

    let probeTopK = Math.min(
      maxProbeTopK,
      Math.max(requestedVisibleLimit, MIN_PROBE_TOP_K)
    );
    let lastRawResults = [];
    let normalized = [];
    let warning = null;
    while (true) {
      const payload = await runMasterSearch({
        topK: probeTopK,
        countMinScore: null,
        imageBytes,
      });
      const results = Array.isArray(payload?.results) ? payload.results : [];
      lastRawResults = results;
      warning =
        payload?.warning && typeof payload.warning === "object"
          ? payload.warning
          : warning;
      normalized = await normalizeResults(results, defaultBucket);
      const rawExhausted = results.length < probeTopK;
      if (
        normalized.length >= requestedVisibleLimit ||
        rawExhausted ||
        probeTopK >= maxProbeTopK
      ) {
        break;
      }
      const nextProbeTopK = Math.min(
        maxProbeTopK,
        Math.max(probeTopK + 100, probeTopK * 2)
      );
      if (nextProbeTopK <= probeTopK) {
        break;
      }
      probeTopK = nextProbeTopK;
    }

    let totalMatchingCount = null;
    let totalMatchingMinSimilarity = null;
    if (requestedCountMinScore !== null) {
      const payload = await runMasterSearch({
        topK: 1,
        countMinScore: requestedCountMinScore,
        imageBytes,
      });
      const totalCountRaw = Number(payload?.total_matching_count);
      if (Number.isFinite(totalCountRaw)) {
        totalMatchingCount = totalCountRaw;
      }
      const totalMinRaw = Number(payload?.total_matching_min_similarity);
      if (Number.isFinite(totalMinRaw)) {
        totalMatchingMinSimilarity = totalMinRaw;
      }
      warning =
        payload?.warning && typeof payload.warning === "object"
          ? payload.warning
          : warning;
    }

    const rawExhausted = lastRawResults.length < probeTopK;
    const hasMoreVisibleInPayload = normalized.length > requestedVisibleLimit;
    const mayHaveMoreRaw = !rawExhausted && probeTopK < maxProbeTopK;
    const hasMore = hasMoreVisibleInPayload || mayHaveMoreRaw;

    return res
      .status(200)
      .json({
        items: normalized.slice(0, requestedVisibleLimit),
        warning,
        pagination: {
          requested_visible_limit: requestedVisibleLimit,
          returned_visible: Math.min(normalized.length, requestedVisibleLimit),
          visible_loaded: normalized.length,
          raw_loaded: lastRawResults.length,
          probed_top_k: probeTopK,
          has_more: hasMore,
          max_probe_top_k: maxProbeTopK,
          raw_exhausted: rawExhausted,
        },
        total_matching_count: totalMatchingCount,
        total_matching_min_similarity: totalMatchingMinSimilarity,
      });
  } catch (error) {
    return res.status(500).json({ error: error.message || "search failed" });
  }
}
