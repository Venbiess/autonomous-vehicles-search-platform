"use client";

import { useState } from "react";
import axios from "axios";

interface AnnotationPanelProps {
  onOpenJobsMonitor: () => void;
}

export default function AnnotationPanel({
  onOpenJobsMonitor,
}: AnnotationPanelProps) {
  const [limit, setLimit] = useState(1000);
  const [batchSize, setBatchSize] = useState(50);
  const [stopOnError, setStopOnError] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [isStartingJob, setIsStartingJob] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [warningMessage, setWarningMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showJobsLink, setShowJobsLink] = useState(false);

  const startBackfill = async () => {
    setIsStartingJob(true);
    setStatusMessage(null);
    setWarningMessage(null);
    setErrorMessage(null);
    setShowJobsLink(false);

    try {
      const statsResponse = await axios.get("/api/storage/stats", {
        params: { include_storage_details: 0 },
      });
      const pendingRows = Number(statsResponse.data?.embeddings?.pending_rows ?? 0);
      if (pendingRows <= 0) {
        setWarningMessage(
          "Все сцены уже размечены векторными эмбеддингами. Новая backfill-джоба не требуется."
        );
        return;
      }

      const response = await axios.post("/api/backfill", {
        limit: Math.max(1, limit),
        batch_size: Math.max(1, batchSize),
        stop_on_error: stopOnError,
        dry_run: dryRun,
      });
      setStatusMessage(
        `Embedding backfill started. Job ID: ${response.data.job_id}.`
      );
      setShowJobsLink(true);
    } catch (error: unknown) {
      const message =
        axios.isAxiosError(error) && error.response?.data?.detail
          ? error.response.data.detail
          : error instanceof Error
            ? error.message
            : "Failed to start embedding backfill";
      setErrorMessage(message);
    } finally {
      setIsStartingJob(false);
    }
  };

  return (
    <section className="px-6 pt-10 pb-16">
      <div className="mx-auto flex max-w-5xl flex-col gap-8">
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="mb-5">
            <h2 className="text-2xl font-semibold text-slate-900">
              Embedding Annotation
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              Start a background job that computes and saves image embeddings for
              scenes into the annotation storage.
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <label className="flex flex-col gap-1 text-sm text-slate-600">
              Limit
              <input
                type="number"
                min={1}
                value={limit}
                onChange={(event) => setLimit(Number(event.target.value) || 1)}
                className="rounded-xl border border-slate-300 px-4 py-3 text-slate-900 outline-none focus:border-sky-500"
              />
            </label>

            <label className="flex flex-col gap-1 text-sm text-slate-600">
              Batch size
              <input
                type="number"
                min={1}
                value={batchSize}
                onChange={(event) =>
                  setBatchSize(Number(event.target.value) || 1)
                }
                className="rounded-xl border border-slate-300 px-4 py-3 text-slate-900 outline-none focus:border-sky-500"
              />
            </label>

            <label className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={stopOnError}
                onChange={(event) => setStopOnError(event.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
              />
              Stop on error
            </label>

            <label className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={dryRun}
                onChange={(event) => setDryRun(event.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
              />
              Dry run
            </label>
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={startBackfill}
              disabled={isStartingJob}
              className="rounded-full bg-emerald-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isStartingJob ? "Starting..." : "Start embedding backfill"}
            </button>
            <button
              type="button"
              onClick={onOpenJobsMonitor}
              className="rounded-full border border-slate-300 px-5 py-3 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
            >
              Open Job Monitor
            </button>
          </div>

          {statusMessage && (
            <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800">
              <span>{statusMessage}</span>
              {showJobsLink && (
                <>
                  {" "}
                  <button
                    type="button"
                    onClick={onOpenJobsMonitor}
                    className="font-bold text-teal-600 underline decoration-teal-500 underline-offset-2 transition hover:text-teal-700"
                  >
                    Go to Job Monitor
                  </button>
                </>
              )}
            </div>
          )}

          {warningMessage && (
            <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
              {warningMessage}
            </div>
          )}

          {errorMessage && (
            <div className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">
              {errorMessage}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
