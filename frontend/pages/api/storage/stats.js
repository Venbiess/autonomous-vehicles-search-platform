import {
  buildStorageStats,
  emptyStorageStats,
  storageEndpoint,
} from "../../../lib/storageServer";
import {
  filterVisibleObjects,
  loadDatasetVisibility,
  visibilityMapForBuckets,
} from "../../../lib/datasetVisibility";

const DEFAULT_ANALYTICS_ENDPOINTS = [
  process.env.ANALYTICS_SERVER_ENDPOINT,
  process.env.ANALYTICS_ENDPOINT,
  process.env.STORAGE_SERVER_ENDPOINT,
  "http://storage-server:9012",
]
  .filter(Boolean)
  .map((value) => String(value).replace(/\/$/, ""));
const MASTER_ENDPOINT = String(process.env.MASTER_ENDPOINT || "http://master:9002").replace(
  /\/$/,
  ""
);
const STORAGE_TIMEOUT_MS = Math.max(500, Number(process.env.STORAGE_STATS_TIMEOUT_MS || 6000));
const ANALYTICS_TIMEOUT_MS = Math.max(
  500,
  Number(process.env.STORAGE_ANALYTICS_TIMEOUT_MS || 4000)
);
const MASTER_TIMEOUT_MS = Math.max(
  500,
  Number(process.env.STORAGE_MASTER_TIMEOUT_MS || 4000)
);
const STORAGE_STATS_CACHE_TTL_MS = Math.max(
  1000,
  Number(process.env.STORAGE_STATS_CACHE_TTL_MS || 30000)
);
const STORAGE_STATS_LITE_CACHE_TTL_MS = Math.max(
  500,
  Number(process.env.STORAGE_STATS_LITE_CACHE_TTL_MS || 5000)
);
const STORAGE_LIST_PAGE_LIMIT = Math.max(
  100,
  Math.min(2000, Number(process.env.STORAGE_STATS_LIST_PAGE_LIMIT || 1000))
);
const EMBEDDINGS_PENDING_VERIFY_WINDOW = Math.max(
  1,
  Number(process.env.STORAGE_PENDING_VERIFY_WINDOW || 5000)
);
const statsCache = new Map();

function normalizeCategoryKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

function parseAllowedCategoryLabels(prompt) {
  const text = String(prompt || "");
  if (!text.trim()) return [];
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const labels = [];
  let collect = false;

  const pushLabelsFromLine = (line) => {
    const cleaned = String(line || "")
      .replace(/^[-*•]\s*/, "")
      .replace(/\.$/, "")
      .trim();
    if (!cleaned) return;
    for (const part of cleaned.split(",")) {
      const token = normalizeCategoryKey(part);
      if (!token) continue;
      labels.push(token);
    }
  };

  for (const line of lines) {
    const lowered = line.toLowerCase();
    if (!collect) {
      if (!lowered.startsWith("allowed labels")) continue;
      collect = true;
      const inline = line.split(":").slice(1).join(":").trim();
      if (inline) {
        pushLabelsFromLine(inline);
      }
      continue;
    }
    if (!line) break;
    if (/^(definitions?|examples?)\s*:?$/i.test(line)) break;
    if (/^(if|choose|consider|do not)\b/i.test(line)) break;
    pushLabelsFromLine(line);
  }

  return Array.from(new Set(labels));
}

function isValidByResponseType(responseType, value, allowedCategoryLabels) {
  const normalizedType = String(responseType || "").trim().toLowerCase();
  const normalizedValue = String(value ?? "").trim();
  if (!normalizedValue) return false;
  if (normalizedType === "yes_no") {
    const lowered = normalizedValue.toLowerCase();
    return lowered === "yes" || lowered === "no";
  }
  if (normalizedType === "number") {
    return /^-?\d+(?:[.,]\d+)?$/.test(normalizedValue);
  }
  if (normalizedType === "category") {
    if (!Array.isArray(allowedCategoryLabels) || allowedCategoryLabels.length === 0) {
      return true;
    }
    return allowedCategoryLabels.includes(normalizeCategoryKey(normalizedValue));
  }
  return normalizedValue.length > 0;
}

function chunkArray(values, chunkSize) {
  const out = [];
  for (let i = 0; i < values.length; i += chunkSize) {
    out.push(values.slice(i, i + chunkSize));
  }
  return out;
}

function parseBooleanFlag(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return defaultValue;
}

function makeTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}

async function fetchJsonWithTimeout(url, timeoutMs, init = {}) {
  const { signal, cleanup } = makeTimeoutSignal(timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal,
    });
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(payload?.detail || payload?.error || response.statusText);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  } finally {
    cleanup();
  }
}

async function readStorageJsonWithTimeout(path, timeoutMs, init = {}) {
  const url = `${storageEndpoint()}${path}`;
  return fetchJsonWithTimeout(url, timeoutMs, init);
}

async function listStorageObjectsWithTimeout(limit = STORAGE_LIST_PAGE_LIMIT) {
  const items = [];
  let cursor = "";
  do {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set("cursor", cursor);
    const payload = await readStorageJsonWithTimeout(
      `/objects?${params.toString()}`,
      STORAGE_TIMEOUT_MS
    );
    items.push(...(payload.items || []));
    cursor = payload.next_cursor || "";
  } while (cursor);
  return items;
}

async function countStorageObjectsWithTimeout() {
  const payload = await readStorageJsonWithTimeout("/objects/count", STORAGE_TIMEOUT_MS);
  const count = Number(payload?.count || 0);
  if (!Number.isFinite(count) || count < 0) {
    return 0;
  }
  return Math.floor(count);
}

async function countCompletedVectorsForObjectIds(objectIds, chunkSize = 500) {
  if (!Array.isArray(objectIds) || objectIds.length === 0) {
    return 0;
  }
  const normalizedChunkSize = Math.max(1, Math.min(2000, Number(chunkSize) || 500));
  let completedCount = 0;
  for (let index = 0; index < objectIds.length; index += normalizedChunkSize) {
    const chunk = objectIds.slice(index, index + normalizedChunkSize).filter(Boolean);
    if (chunk.length === 0) continue;
    const payload = await readStorageJsonWithTimeout(
      "/vectors/completed-object-ids",
      STORAGE_TIMEOUT_MS,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ object_ids: chunk }),
      }
    );
    const ids = Array.isArray(payload?.object_ids) ? payload.object_ids : [];
    completedCount += ids.filter(Boolean).length;
  }
  return completedCount;
}

async function readAnalyticsJson(path, timeoutMs, init = {}) {
  let lastError = null;
  for (const endpoint of DEFAULT_ANALYTICS_ENDPOINTS) {
    try {
      return await fetchJsonWithTimeout(`${endpoint}${path}`, timeoutMs, init);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("analytics endpoint is unavailable");
}

async function getCachedStats(key, ttlMs, loader) {
  const now = Date.now();
  const entry = statsCache.get(key);
  if (entry?.data && entry.expiresAt > now) {
    return entry.data;
  }
  if (entry?.inFlight) {
    return entry.inFlight;
  }
  const stale = entry?.data;
  const inFlight = loader()
    .then((data) => {
      statsCache.set(key, {
        data,
        expiresAt: Date.now() + ttlMs,
        inFlight: null,
      });
      return data;
    })
    .catch((error) => {
      const latest = statsCache.get(key);
      if (latest?.data || stale) {
        const fallback = latest?.data || stale;
        statsCache.set(key, {
          data: fallback,
          expiresAt: Date.now() + Math.max(1000, Math.floor(ttlMs / 3)),
          inFlight: null,
        });
        return fallback;
      }
      throw error;
    })
    .finally(() => {
      const latest = statsCache.get(key);
      if (latest) {
        statsCache.set(key, { ...latest, inFlight: null });
      }
    });
  statsCache.set(key, {
    data: entry?.data || null,
    expiresAt: entry?.expiresAt || 0,
    inFlight,
  });
  return inFlight;
}

async function buildLiteStats() {
  const stats = emptyStorageStats();
  const hiddenPayload = loadDatasetVisibility();
  stats.hidden_datasets = hiddenPayload.hidden_datasets || [];
  stats.dataset_visibility = {};
  stats.details_mode = "lite";
  stats.details_ready = false;

  try {
    const totalObjects = await countStorageObjectsWithTimeout();
    stats.source_table_exists = true;
    stats.source_table = "storage.objects";
    stats.storage.total_objects = totalObjects;
    stats.source.total_rows = totalObjects;
    stats.source.rows_with_storage_path = totalObjects;
    stats.source.distinct_storage_paths = totalObjects;
    stats.embeddings.pending_rows = totalObjects;
    stats.embeddings.pending_percent = totalObjects > 0 ? 100 : 0;
    stats.vlm.pending_rows = totalObjects;
    stats.vlm.pending_percent = totalObjects > 0 ? 100 : 0;
    stats.warning = null;
  } catch (error) {
    try {
      // Backward compatibility for older storage-server versions without /objects/count.
      const fallbackObjects = await listStorageObjectsWithTimeout();
      const fallbackVisibleObjects = filterVisibleObjects(fallbackObjects);
      const fallbackStats = buildStorageStats(fallbackVisibleObjects);
      fallbackStats.hidden_datasets = hiddenPayload.hidden_datasets || [];
      fallbackStats.dataset_visibility = {};
      fallbackStats.details_mode = "lite";
      fallbackStats.details_ready = false;
      fallbackStats.warning = `objects/count unavailable, used list scan fallback: ${error.message}`;
      return fallbackStats;
    } catch (fallbackError) {
      stats.source_table_exists = false;
      stats.warning = `storage unavailable: ${fallbackError.message}`;
    }
  }

  return stats;
}

async function buildFullStats({ includeVlmFieldBreakdown = false } = {}) {
  const allObjects = await listStorageObjectsWithTimeout();
  const visibleObjects = filterVisibleObjects(allObjects);
  const stats = buildStorageStats(visibleObjects);
  const totalObjects = visibleObjects.length;
  const uniqueVisibleObjectIds = Array.from(
    new Set(
      visibleObjects
        .map((item) => String(item?.object_id || "").trim())
        .filter(Boolean)
    )
  );
  const warnings = [];
  const allBuckets = Array.from(
    new Set(allObjects.map((item) => String(item?.bucket || "").trim()).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b));
  const visibilityPayload = loadDatasetVisibility();
  const visibilityMap = visibilityMapForBuckets(allBuckets);

  try {
    const vectorPayload = await readStorageJsonWithTimeout("/vectors/count", STORAGE_TIMEOUT_MS);
    const vectorCount = Math.max(0, Number(vectorPayload?.count || 0));
    let annotated = Math.max(0, Math.min(vectorCount, totalObjects));
    let pending = Math.max(0, totalObjects - annotated);
    if (vectorCount > totalObjects) {
      warnings.push(
        `vector stats are global (count=${vectorCount}) and exceed current objects (${totalObjects}); clamped to visible objects`
      );
    }

    const shouldVerifyExactPending =
      uniqueVisibleObjectIds.length > 0 &&
      (vectorCount >= Math.max(0, totalObjects - EMBEDDINGS_PENDING_VERIFY_WINDOW) ||
        vectorCount > totalObjects);
    if (shouldVerifyExactPending) {
      try {
        const completedExact = await countCompletedVectorsForObjectIds(uniqueVisibleObjectIds);
        const exactAnnotated = Math.max(0, Math.min(completedExact, totalObjects));
        const exactPending = Math.max(0, totalObjects - exactAnnotated);
        if (exactAnnotated !== annotated || exactPending !== pending) {
          warnings.push(
            `embedding stats reconciled by object_id completion scan: approx_annotated=${annotated}, exact_annotated=${exactAnnotated}`
          );
        }
        annotated = exactAnnotated;
        pending = exactPending;
      } catch (verifyError) {
        warnings.push(`exact embedding pending scan unavailable: ${verifyError.message}`);
      }
    }

    stats.embeddings.annotated_rows = annotated;
    stats.embeddings.pending_rows = pending;
    stats.embeddings.annotated_percent = totalObjects > 0 ? (annotated / totalObjects) * 100 : 0;
    stats.embeddings.pending_percent = totalObjects > 0 ? (pending / totalObjects) * 100 : 0;
  } catch (error) {
    warnings.push(`vector stats unavailable: ${error.message}`);
  }

  try {
    const payload = await fetchJsonWithTimeout(
      `${MASTER_ENDPOINT}/embeddings/dimensions`,
      MASTER_TIMEOUT_MS
    );
    stats.embeddings.dimensions = {
      status: String(payload?.status || "unknown"),
      query_dim:
        Number.isFinite(Number(payload?.query_dim)) && Number(payload?.query_dim) > 0
          ? Number(payload.query_dim)
          : null,
      stored_dim:
        Number.isFinite(Number(payload?.stored_dim)) && Number(payload?.stored_dim) > 0
          ? Number(payload.stored_dim)
          : null,
      mismatch: Boolean(payload?.mismatch),
      reason: String(payload?.reason || "").trim() || null,
    };
  } catch (error) {
    stats.embeddings.dimensions = {
      status: "unavailable",
      query_dim: null,
      stored_dim: null,
      mismatch: null,
      reason: error.message,
    };
    warnings.push(`embedding dimensions unavailable: ${error.message}`);
  }

  try {
    const fieldsPayload = await readAnalyticsJson("/fields", ANALYTICS_TIMEOUT_MS);
    const fields = Array.isArray(fieldsPayload?.fields) ? fieldsPayload.fields : [];
    const normalizedFields = fields
      .map((field) => ({
        field_name: String(field?.field_name || "").trim(),
        response_type: String(field?.response_type || "").trim(),
        prompt: String(field?.prompt || ""),
      }))
      .filter((field) => field.field_name);
    const fieldNames = normalizedFields
      .map((field) => field.field_name)
      .filter(Boolean);
    stats.vlm.configured_fields = fieldNames.length;

    if (fieldNames.length > 0 && totalObjects > 0) {
      const completed = new Set();
      const partiallyAnnotated = new Set();
      const fieldFilledSets = includeVlmFieldBreakdown
        ? new Map(fieldNames.map((fieldName) => [fieldName, new Set()]))
        : null;
      const fieldInvalidSets = includeVlmFieldBreakdown
        ? new Map(fieldNames.map((fieldName) => [fieldName, new Set()]))
        : null;
      const fieldInvalidExamples = includeVlmFieldBreakdown
        ? new Map(fieldNames.map((fieldName) => [fieldName, new Map()]))
        : null;
      const fieldMetaByName = new Map(
        normalizedFields.map((field) => [
          field.field_name,
          {
            response_type: field.response_type,
            allowed_labels: parseAllowedCategoryLabels(field.prompt),
          },
        ])
      );
      let filledCells = 0;
      let validCells = 0;
      let invalidCells = 0;
      const objectIDs = visibleObjects.map((item) => item.object_id).filter(Boolean);
      const chunks = chunkArray(objectIDs, 500);
      for (const objectIDsChunk of chunks) {
        const payload = await readAnalyticsJson(
          "/annotations/get",
          ANALYTICS_TIMEOUT_MS,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              object_ids: objectIDsChunk,
            }),
          }
        );
        const rows = Array.isArray(payload?.rows) ? payload.rows : [];
        for (const row of rows) {
          const objectID = String(row?.object_id || "").trim();
          if (!objectID) {
            continue;
          }
          const valuesRaw =
            row?.values && typeof row.values === "object" && !Array.isArray(row.values)
              ? row.values
              : {};
          const values = {};
          for (const [key, value] of Object.entries(valuesRaw)) {
            const normalizedKey = String(key || "").trim();
            const normalizedValue = String(value ?? "").trim();
            if (!normalizedKey || !normalizedValue) continue;
            values[normalizedKey] = normalizedValue;
          }
          const valueKeys = Object.keys(values);
          if (valueKeys.length === 0) {
            continue;
          }
          partiallyAnnotated.add(objectID);
          const isComplete = fieldNames.every((fieldName) => String(values[fieldName] || "").trim());
          if (isComplete) {
            completed.add(objectID);
          }
          if (fieldFilledSets) {
            for (const fieldName of fieldNames) {
              const fieldValue = String(values[fieldName] || "").trim();
              if (!fieldValue) continue;
              filledCells += 1;
              const fieldMeta = fieldMetaByName.get(fieldName) || {};
              const isValid = isValidByResponseType(
                fieldMeta.response_type,
                fieldValue,
                fieldMeta.allowed_labels
              );
              if (isValid) {
                validCells += 1;
              } else {
                invalidCells += 1;
              }
              const set = fieldFilledSets.get(fieldName);
              if (set) {
                set.add(objectID);
              }
              if (!isValid) {
                const invalidSet = fieldInvalidSets?.get(fieldName);
                if (invalidSet) {
                  invalidSet.add(objectID);
                }
                const examples = fieldInvalidExamples?.get(fieldName);
                if (examples) {
                  const key = fieldValue.slice(0, 120);
                  examples.set(key, (examples.get(key) || 0) + 1);
                }
              }
            }
          }
        }
      }
      const fullyAnnotated = Math.max(0, Math.min(totalObjects, completed.size));
      const partiallyAnnotatedCount = Math.max(0, Math.min(totalObjects, partiallyAnnotated.size));
      const pending = Math.max(0, totalObjects - fullyAnnotated);
      const partialOnly = Math.max(0, partiallyAnnotatedCount - fullyAnnotated);

      stats.vlm.annotated_rows = fullyAnnotated;
      stats.vlm.pending_rows = pending;
      stats.vlm.annotated_percent = totalObjects > 0 ? (fullyAnnotated / totalObjects) * 100 : 0;
      stats.vlm.pending_percent = totalObjects > 0 ? (pending / totalObjects) * 100 : 0;
      stats.vlm.partial_annotated_rows = partiallyAnnotatedCount;
      stats.vlm.partial_annotated_percent =
        totalObjects > 0 ? (partiallyAnnotatedCount / totalObjects) * 100 : 0;
      stats.vlm.partial_only_rows = partialOnly;
      stats.vlm.partial_only_percent = totalObjects > 0 ? (partialOnly / totalObjects) * 100 : 0;
      if (fieldFilledSets) {
        stats.vlm.field_coverage = normalizedFields.map((field) => {
          const filledRows = Number(fieldFilledSets.get(field.field_name)?.size || 0);
          const invalidRows = Number(fieldInvalidSets?.get(field.field_name)?.size || 0);
          const validRows = Math.max(0, filledRows - invalidRows);
          const missingRows = Math.max(0, totalObjects - filledRows);
          const invalidExamplesMap = fieldInvalidExamples?.get(field.field_name) || new Map();
          const invalidExamples = Array.from(invalidExamplesMap.entries())
            .sort((left, right) => right[1] - left[1])
            .slice(0, 3)
            .map(([value, count]) => ({ value, count }));
          return {
            field_name: field.field_name,
            response_type: field.response_type,
            filled_rows: filledRows,
            missing_rows: missingRows,
            valid_rows: validRows,
            invalid_rows: invalidRows,
            filled_percent: totalObjects > 0 ? (filledRows / totalObjects) * 100 : 0,
            missing_percent: totalObjects > 0 ? (missingRows / totalObjects) * 100 : 0,
            invalid_percent: totalObjects > 0 ? (invalidRows / totalObjects) * 100 : 0,
            invalid_examples: invalidExamples,
          };
        });
        const totalCells = totalObjects * fieldNames.length;
        const missingCells = Math.max(0, totalCells - filledCells);
        stats.vlm.field_coverage_summary = {
          total_cells: totalCells,
          filled_cells: filledCells,
          valid_cells: validCells,
          invalid_cells: invalidCells,
          missing_cells: missingCells,
          filled_percent: totalCells > 0 ? (filledCells / totalCells) * 100 : 0,
          valid_percent: totalCells > 0 ? (validCells / totalCells) * 100 : 0,
          invalid_percent: totalCells > 0 ? (invalidCells / totalCells) * 100 : 0,
          missing_percent: totalCells > 0 ? (missingCells / totalCells) * 100 : 0,
        };
      } else {
        stats.vlm.field_coverage = [];
        stats.vlm.field_coverage_summary = null;
      }
    } else {
      stats.vlm.annotated_rows = 0;
      stats.vlm.pending_rows = totalObjects;
      stats.vlm.annotated_percent = 0;
      stats.vlm.pending_percent = totalObjects > 0 ? 100 : 0;
      stats.vlm.partial_annotated_rows = 0;
      stats.vlm.partial_annotated_percent = 0;
      stats.vlm.partial_only_rows = 0;
      stats.vlm.partial_only_percent = 0;
      stats.vlm.field_coverage = [];
      stats.vlm.field_coverage_summary = null;
    }
  } catch (error) {
    stats.vlm.field_coverage = [];
    stats.vlm.field_coverage_summary = null;
    warnings.push(`vlm stats unavailable: ${error.message}`);
  }

  if (warnings.length > 0) {
    stats.warning = warnings.join("; ");
  }
  stats.dataset_visibility = visibilityMap;
  stats.hidden_datasets = visibilityPayload.hidden_datasets || [];
  const allBucketStatsByName = new Map(
    stats.storage.bucket_stats.map((bucket) => [String(bucket.bucket), bucket])
  );
  for (const bucket of allBuckets) {
    if (allBucketStatsByName.has(bucket)) continue;
    const objectsInBucket = allObjects.filter(
      (item) => String(item?.bucket || "").trim() === bucket
    );
    const bytes = objectsInBucket.reduce(
      (sum, item) => sum + Number(item?.size_bytes || 0),
      0
    );
    allBucketStatsByName.set(bucket, {
      bucket,
      objects: objectsInBucket.length,
      bytes,
      gigabytes: bytes / 1024 ** 3,
    });
  }
  stats.storage.all_bucket_stats = Array.from(allBucketStatsByName.values()).sort((a, b) =>
    String(a.bucket).localeCompare(String(b.bucket))
  );
  stats.details_mode = "full";
  stats.details_ready = true;

  return stats;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const includeStorageDetails = parseBooleanFlag(
      req.query?.include_storage_details,
      true
    );
    const includeVlmFieldBreakdown = parseBooleanFlag(
      req.query?.include_vlm_field_breakdown,
      false
    );
    const forceRefresh = parseBooleanFlag(
      req.query?.force_refresh ?? req.query?.refresh,
      false
    );
    const cacheKey = includeStorageDetails
      ? includeVlmFieldBreakdown
        ? "full:vlm_field_breakdown"
        : "full"
      : "lite";
    const cacheTtl = includeStorageDetails
      ? STORAGE_STATS_CACHE_TTL_MS
      : STORAGE_STATS_LITE_CACHE_TTL_MS;
    const loader = includeStorageDetails
      ? () => buildFullStats({ includeVlmFieldBreakdown })
      : buildLiteStats;
    const stats = forceRefresh
      ? await loader()
      : await getCachedStats(cacheKey, cacheTtl, loader);
    if (forceRefresh) {
      statsCache.set(cacheKey, {
        data: stats,
        expiresAt: Date.now() + cacheTtl,
        inFlight: null,
      });
    }
    return res.status(200).json(stats);
  } catch (error) {
    return res.status(error.status || 500).json(error.payload || { error: error.message });
  }
}
