const DEFAULT_STORAGE_ENDPOINT = "http://localhost:9013";

export function storageEndpoint() {
  return (process.env.STORAGE_SERVER_ENDPOINT || DEFAULT_STORAGE_ENDPOINT).replace(
    /\/$/,
    ""
  );
}

export function storageWriteHeaders(extra = {}) {
  const token = process.env.STORAGE_WRITE_TOKEN || "";
  return {
    ...extra,
    ...(token.trim() ? { "X-Storage-Write-Token": token.trim() } : {}),
  };
}

export async function readStorageJson(path, init = {}) {
  const response = await fetch(`${storageEndpoint()}${path}`, init);
  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text };
    }
  }
  if (!response.ok) {
    const message = payload.detail || payload.error || response.statusText;
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export async function listStorageObjects(limit = 1000) {
  const items = [];
  let cursor = "";
  do {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set("cursor", cursor);
    const payload = await readStorageJson(`/objects?${params.toString()}`);
    items.push(...(payload.items || []));
    cursor = payload.next_cursor || "";
  } while (cursor);
  return items;
}

export function emptyStorageStats() {
  return {
    source_table_exists: true,
    source_table: "storage.objects",
    warning: null,
    source: {
      total_rows: 0,
      rows_with_storage_path: 0,
      distinct_storage_paths: 0,
      duplicate_storage_rows: 0,
    },
    embeddings: {
      annotated_rows: 0,
      pending_rows: 0,
      annotated_percent: 0,
      pending_percent: 0,
    },
    vlm: {
      annotated_rows: 0,
      pending_rows: 0,
      annotated_percent: 0,
      pending_percent: 0,
      partial_annotated_rows: 0,
      partial_annotated_percent: 0,
      partial_only_rows: 0,
      partial_only_percent: 0,
      configured_fields: 0,
    },
    storage: {
      tracked_buckets: [],
      bucket_stats: [],
      total_objects: 0,
      total_bytes: 0,
      total_gigabytes: 0,
    },
    datasets: {
      rows_distribution: [],
      memory_distribution: [],
      memory_pie_segments: [],
    },
    disk: {
      total_bytes: 0,
      used_bytes: 0,
      free_bytes: 0,
      total_gigabytes: 0,
      used_gigabytes: 0,
      free_gigabytes: 0,
      free_percent: 0,
      used_percent: 0,
    },
    timestamp: new Date().toISOString(),
  };
}

export function buildStorageStats(objects) {
  const stats = emptyStorageStats();
  const byBucket = new Map();
  const byDataset = new Map();

  for (const object of objects) {
    const bucket = object.bucket || "unknown";
    const bytes = Number(object.size_bytes || 0);
    const bucketStats = byBucket.get(bucket) || { bucket, objects: 0, bytes: 0 };
    bucketStats.objects += 1;
    bucketStats.bytes += bytes;
    byBucket.set(bucket, bucketStats);

    const dataset = bucket;
    const datasetStats = byDataset.get(dataset) || {
      dataset,
      rows: 0,
      distinct_storage_paths: 0,
      bytes: 0,
    };
    datasetStats.rows += 1;
    datasetStats.distinct_storage_paths += 1;
    datasetStats.bytes += bytes;
    byDataset.set(dataset, datasetStats);
  }

  const totalObjects = objects.length;
  const totalBytes = objects.reduce(
    (sum, object) => sum + Number(object.size_bytes || 0),
    0
  );
  const totalGb = totalBytes / 1024 ** 3;

  stats.source.total_rows = totalObjects;
  stats.source.rows_with_storage_path = totalObjects;
  stats.source.distinct_storage_paths = totalObjects;
  stats.embeddings.pending_rows = totalObjects;
  stats.embeddings.pending_percent = totalObjects > 0 ? 100 : 0;
  stats.vlm.pending_rows = totalObjects;
  stats.vlm.pending_percent = totalObjects > 0 ? 100 : 0;
  stats.storage.tracked_buckets = Array.from(byBucket.keys()).sort();
  stats.storage.bucket_stats = Array.from(byBucket.values())
    .sort((left, right) => left.bucket.localeCompare(right.bucket))
    .map((bucket) => ({
      ...bucket,
      gigabytes: bucket.bytes / 1024 ** 3,
    }));
  stats.storage.total_objects = totalObjects;
  stats.storage.total_bytes = totalBytes;
  stats.storage.total_gigabytes = totalGb;
  stats.datasets.rows_distribution = Array.from(byDataset.values()).map((item) => ({
    dataset: item.dataset,
    rows: item.rows,
    distinct_storage_paths: item.distinct_storage_paths,
    percent_rows: totalObjects > 0 ? (item.rows / totalObjects) * 100 : 0,
  }));
  stats.datasets.memory_distribution = Array.from(byDataset.values()).map((item) => ({
    dataset: item.dataset,
    bytes: item.bytes,
    gigabytes: item.bytes / 1024 ** 3,
    percent_images: totalBytes > 0 ? (item.bytes / totalBytes) * 100 : 0,
  }));
  stats.datasets.memory_pie_segments = stats.datasets.memory_distribution.map(
    (item) => ({
      label: item.dataset,
      bytes: item.bytes,
      percent_total_disk: totalBytes > 0 ? (item.bytes / totalBytes) * 100 : 0,
      kind: "dataset",
    })
  );
  stats.disk.total_bytes = totalBytes;
  stats.disk.used_bytes = totalBytes;
  stats.disk.total_gigabytes = totalGb;
  stats.disk.used_gigabytes = totalGb;
  stats.disk.used_percent = totalBytes > 0 ? 100 : 0;
  stats.timestamp = new Date().toISOString();
  return stats;
}
