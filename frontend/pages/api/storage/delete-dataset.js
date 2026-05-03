import { listStorageObjects } from "../../../lib/storageServer";
import { isDatasetVisible } from "../../../lib/datasetVisibility";

const masterEndpoint = process.env.MASTER_ENDPOINT || "http://localhost:9002";
const DELETE_CONCURRENCY = Math.max(
  1,
  Number(process.env.DATASET_DELETE_CONCURRENCY || 12)
);

async function deleteStorageObject(item, errors, attemptLabel = null) {
  try {
    const response = await fetch(
      `${masterEndpoint}/objects/${encodeURIComponent(item.object_id)}`,
      { method: "DELETE" }
    );
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(
        payload?.detail?.message || payload?.detail || payload?.error || response.statusText
      );
    }
    return Boolean(payload?.result?.object?.deleted);
  } catch (error) {
    errors.push({
      ...(attemptLabel ? { attempt: attemptLabel } : {}),
      object_id: item.object_id,
      storage_path: item.storage_path,
      error: error?.message || "Unknown error",
    });
    return false;
  }
}

async function deleteObjectsConcurrent(items, errors, attemptLabel = null) {
  if (!Array.isArray(items) || items.length === 0) {
    return 0;
  }

  let cursor = 0;
  let deletedCount = 0;
  const workerCount = Math.min(DELETE_CONCURRENCY, items.length);

  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const deleted = await deleteStorageObject(items[index], errors, attemptLabel);
      if (deleted) {
        deletedCount += 1;
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return deletedCount;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    if (!req.body?.confirm) {
      return res.status(400).json({ error: "confirm=true is required" });
    }
    const dataset = String(req.body?.dataset || "").trim();
    if (!dataset) {
      return res.status(400).json({ error: "dataset is required" });
    }
    if (!isDatasetVisible(dataset)) {
      return res.status(400).json({ error: `dataset '${dataset}' is hidden` });
    }
    const progressive = Boolean(req.body?.progressive);
    const batchSize = Math.min(
      200,
      Math.max(1, Number(req.body?.batch_size || 50))
    );
    const errors = [];

    if (progressive) {
      const objects = await listStorageObjects();
      const selected = objects.filter((item) => String(item.bucket || "") === dataset);
      const selectedTotal = selected.length;

      if (selectedTotal === 0) {
        return res.status(200).json({
          dataset,
          selected_images: 0,
          deleted_images: 0,
          remaining_images: 0,
          failed_images: 0,
          done: true,
          batch_size: batchSize,
          errors: [],
        });
      }

      const batch = selected.slice(0, batchSize);
      const deletedInBatch = await deleteObjectsConcurrent(batch, errors);

      const refreshed = await listStorageObjects();
      const remainingInDataset = refreshed.filter(
        (item) => String(item.bucket || "") === dataset
      ).length;

      return res.status(errors.length ? 207 : 200).json({
        dataset,
        selected_images: selectedTotal,
        deleted_images: deletedInBatch,
        remaining_images: remainingInDataset,
        failed_images: errors.length,
        done: remainingInDataset === 0,
        batch_size: batchSize,
        errors,
      });
    }

    let deleted = 0;
    let selectedTotal = 0;
    let attempts = 0;
    let remainingInDataset = 0;

    while (attempts < 3) {
      attempts += 1;
      const objects = await listStorageObjects();
      const selected = objects.filter((item) => String(item.bucket || "") === dataset);
      if (attempts === 1) {
        selectedTotal = selected.length;
      }
      if (selected.length === 0) {
        remainingInDataset = 0;
        break;
      }

      const deletedInAttempt = await deleteObjectsConcurrent(selected, errors, attempts);
      deleted += deletedInAttempt;

      const refreshed = await listStorageObjects();
      remainingInDataset = refreshed.filter(
        (item) => String(item.bucket || "") === dataset
      ).length;
      if (remainingInDataset === 0 || deletedInAttempt === 0) {
        break;
      }
    }

    return res.status(errors.length ? 207 : 200).json({
      dataset,
      selected_images: selectedTotal,
      deleted_images: deleted,
      remaining_images: remainingInDataset,
      attempts,
      failed_images: errors.length,
      errors,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Unknown error" });
  }
}
