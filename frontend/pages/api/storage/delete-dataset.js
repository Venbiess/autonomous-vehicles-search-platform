import { listStorageObjects } from "../../../lib/storageServer";
import { isDatasetVisible } from "../../../lib/datasetVisibility";
import {
  appendSnapshotTransferJobLog,
  ensureSnapshotTransferJob,
  isSnapshotTransferJobCancelRequested,
  setSnapshotTransferJobError,
  updateSnapshotTransferJob,
} from "../../../lib/snapshotTransferJobs";

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

function normalizeJobId(rawJobId) {
  return String(rawJobId || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "")
    .slice(0, 128);
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
    const jobID = normalizeJobId(req.body?.job_id);
    const updateJob = (patch) => {
      if (!jobID) return null;
      return updateSnapshotTransferJob(jobID, patch);
    };
    const appendLog = (line) => {
      if (!jobID) return null;
      return appendSnapshotTransferJobLog(jobID, line);
    };
    const isCancelRequested = () =>
      Boolean(jobID) && isSnapshotTransferJobCancelRequested(jobID);
    const progressive = Boolean(req.body?.progressive);
    const batchSize = Math.min(
      200,
      Math.max(1, Number(req.body?.batch_size || 50))
    );
    const errors = [];

    if (jobID) {
      ensureSnapshotTransferJob(jobID, "dataset_delete", {
        dataset,
        progressive,
      });
      updateJob({
        status: "running",
      });
      appendLog(`Dataset delete started: ${dataset}.`);
    }
    if (isCancelRequested()) {
      updateJob({ status: "cancelled", cancel_requested: true });
      appendLog(`Dataset delete cancelled before start: ${dataset}.`);
      return res.status(200).json({
        dataset,
        selected_images: 0,
        deleted_images: 0,
        remaining_images: 0,
        failed_images: 0,
        done: true,
        cancelled: true,
        batch_size: batchSize,
        errors: [],
      });
    }

    if (progressive) {
      const objects = await listStorageObjects();
      const selected = objects.filter((item) => String(item.bucket || "") === dataset);
      const selectedTotal = selected.length;
      if (isCancelRequested()) {
        updateJob({ status: "cancelled", cancel_requested: true });
        appendLog(`Dataset delete cancelled: ${dataset}.`);
        return res.status(200).json({
          dataset,
          selected_images: selectedTotal,
          deleted_images: 0,
          remaining_images: selectedTotal,
          failed_images: 0,
          done: true,
          cancelled: true,
          batch_size: batchSize,
          errors: [],
        });
      }

      if (selectedTotal === 0) {
        updateJob({
          status: "success",
          progress: 100,
          total_seen: 0,
          total_limit: 0,
          total_planned: 0,
          total_inserted: 0,
        });
        appendLog(`Dataset delete completed: ${dataset} is already empty.`);
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
      const previous = jobID ? ensureSnapshotTransferJob(jobID, "dataset_delete") : null;
      const previousDeleted = Math.max(0, Number(previous?.total_inserted || 0));
      const nextDeleted = previousDeleted + deletedInBatch;
      const totalPlanned = Math.max(
        Number(previous?.total_planned || 0),
        nextDeleted + remainingInDataset
      );
      const done = remainingInDataset === 0;
      const progress =
        totalPlanned > 0
          ? Math.min(100, Math.round(((totalPlanned - remainingInDataset) / totalPlanned) * 100))
          : done
            ? 100
            : 0;
      const isStalled = !done && deletedInBatch === 0;
      if (isCancelRequested()) {
        updateJob({
          status: "cancelled",
          cancel_requested: true,
          progress,
          total_seen: Math.max(0, totalPlanned - remainingInDataset),
          total_limit: totalPlanned,
          total_planned: totalPlanned,
          total_inserted: nextDeleted,
        });
        appendLog(`Dataset delete cancelled: ${dataset}.`);
        return res.status(200).json({
          dataset,
          selected_images: selectedTotal,
          deleted_images: deletedInBatch,
          remaining_images: remainingInDataset,
          failed_images: errors.length,
          done: true,
          cancelled: true,
          batch_size: batchSize,
          errors,
        });
      }
      updateJob({
        status: isStalled ? "error" : done ? "success" : "running",
        progress,
        total_seen: Math.max(0, totalPlanned - remainingInDataset),
        total_limit: totalPlanned,
        total_planned: totalPlanned,
        total_inserted: nextDeleted,
      });
      appendLog(
        `Batch: deleted=${deletedInBatch}, remaining=${remainingInDataset}, failed=${errors.length}.`
      );
      if (isStalled) {
        const stalledMessage = `Dataset delete stalled: ${dataset}, remaining=${remainingInDataset}.`;
        setSnapshotTransferJobError(jobID, stalledMessage);
        appendLog(stalledMessage);
      }
      if (done) {
        appendLog(`Dataset delete completed: ${dataset}.`);
      }

      return res.status(errors.length ? 207 : 200).json({
        dataset,
        selected_images: selectedTotal,
        deleted_images: deletedInBatch,
        remaining_images: remainingInDataset,
        failed_images: errors.length,
        done,
        batch_size: batchSize,
        errors,
      });
    }

    let deleted = 0;
    let selectedTotal = 0;
    let attempts = 0;
    let remainingInDataset = 0;

    while (attempts < 3) {
      if (isCancelRequested()) {
        break;
      }
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

    const totalPlanned = Math.max(0, selectedTotal);
    const totalSeen = Math.max(0, totalPlanned - remainingInDataset);
    const done = remainingInDataset === 0;
    const cancelled = isCancelRequested();
    const progress =
      totalPlanned > 0
        ? Math.min(100, Math.round((totalSeen / totalPlanned) * 100))
        : done
          ? 100
          : 0;
    updateJob({
      status: cancelled ? "cancelled" : done ? "success" : "error",
      cancel_requested: cancelled,
      progress,
      total_seen: totalSeen,
      total_limit: totalPlanned,
      total_planned: totalPlanned,
      total_inserted: deleted,
    });
    appendLog(
      `Dataset delete finished: deleted=${deleted}, remaining=${remainingInDataset}, failed=${errors.length}.`
    );
    if (!done && !cancelled) {
      setSnapshotTransferJobError(
        jobID,
        `Dataset delete incomplete: ${dataset}, remaining=${remainingInDataset}.`
      );
    }

    return res.status(errors.length ? 207 : 200).json({
      dataset,
      selected_images: selectedTotal,
      deleted_images: deleted,
      remaining_images: remainingInDataset,
      attempts,
      cancelled,
      failed_images: errors.length,
      errors,
    });
  } catch (error) {
    const jobID = normalizeJobId(req.body?.job_id);
    if (jobID) {
      const message = error?.message || "Unknown error";
      updateSnapshotTransferJob(jobID, { status: "error" });
      setSnapshotTransferJobError(jobID, message);
      appendSnapshotTransferJobLog(jobID, `Dataset delete failed: ${message}`);
    }
    return res.status(500).json({ error: error.message || "Unknown error" });
  }
}
