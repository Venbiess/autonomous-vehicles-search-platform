"use client";

import { useEffect, useState } from "react";
import axios from "axios";

interface AnnotationPanelProps {
  onOpenJobsMonitor: () => void;
}

type ResponseType = "short_text" | "text" | "yes_no" | "number" | "category";

interface FieldDraft {
  id: string;
  name: string;
  prompt: string;
  response_type: ResponseType;
}

interface SavedField {
  field_name: string;
  prompt: string;
  response_type: ResponseType;
}

const RESPONSE_TYPE_OPTIONS: Array<{
  value: ResponseType;
  label: string;
}> = [
  { value: "yes_no", label: "Yes / No" },
  { value: "number", label: "Number" },
  { value: "category", label: "Category" },
  { value: "short_text", label: "Short text" },
  { value: "text", label: "Detailed text" },
];

function createFieldDraft(): FieldDraft {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: "",
    prompt: "",
    response_type: "yes_no",
  };
}

const DATASET_OPTIONS = [
  { key: "waymo", label: "Waymo" },
  { key: "argoverse", label: "Argoverse" },
  { key: "nuscenes", label: "NuScenes" },
] as const;

const DEFAULT_DATASET_CONFIG_TEXT: Record<string, string> = {
  waymo: JSON.stringify(
    {
      bucket: "waymo",
      cameras: ["FRONT"],
      resample_seconds: 0.1,
      exist_skip: false,
    },
    null,
    2
  ),
  argoverse: JSON.stringify(
    {
      bucket: "argoverse",
      cameras: ["FRONT"],
      resample_seconds: 0.5,
      download_parts: {
        train: [0, 1],
        val: [0],
        test: [0],
      },
      remove_after_load: false,
    },
    null,
    2
  ),
  nuscenes: JSON.stringify(
    {
      bucket: "nuscenes",
      cameras: ["FRONT"],
      resample_seconds: 0.5,
    },
    null,
    2
  ),
};

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
  const [vlmDraftFields, setVlmDraftFields] = useState<FieldDraft[]>([
    createFieldDraft(),
  ]);
  const [vlmSavedFields, setVlmSavedFields] = useState<SavedField[]>([]);
  const [vlmBackfillLimit, setVlmBackfillLimit] = useState(200);
  const [vlmMaxNewTokens, setVlmMaxNewTokens] = useState(64);
  const [isSavingVlmSchema, setIsSavingVlmSchema] = useState(false);
  const [isStartingVlmJob, setIsStartingVlmJob] = useState(false);
  const [isClearingVlmAnnotations, setIsClearingVlmAnnotations] = useState(false);
  const [vlmStatusMessage, setVlmStatusMessage] = useState<string | null>(null);
  const [vlmWarningMessage, setVlmWarningMessage] = useState<string | null>(null);
  const [vlmErrorMessage, setVlmErrorMessage] = useState<string | null>(null);
  const [showVlmJobsLink, setShowVlmJobsLink] = useState(false);
  const [sourceWarning, setSourceWarning] = useState<string | null>(null);
  const [installDatasets, setInstallDatasets] = useState<
    Record<"waymo" | "argoverse" | "nuscenes", boolean>
  >({
    waymo: true,
    argoverse: false,
    nuscenes: false,
  });
  const [datasetConfigText, setDatasetConfigText] = useState<
    Record<string, string>
  >(DEFAULT_DATASET_CONFIG_TEXT);
  const [isStartingInstall, setIsStartingInstall] = useState(false);
  const [installStatusMessage, setInstallStatusMessage] = useState<string | null>(
    null
  );
  const [installErrorMessage, setInstallErrorMessage] = useState<string | null>(
    null
  );
  const [showInstallJobsLink, setShowInstallJobsLink] = useState(false);

  useEffect(() => {
    const loadSchema = async () => {
      try {
        const response = await axios.get("/api/vlm/schema");
        const fields = response.data?.fields ?? [];
        setVlmSavedFields(fields);
        setVlmDraftFields(
          fields.length > 0
            ? fields.map((field: SavedField) => ({
                id: `${field.field_name}-${Math.random().toString(16).slice(2)}`,
                name: field.field_name,
                prompt: field.prompt,
                response_type: field.response_type,
              }))
            : [createFieldDraft()]
        );
      } catch (error: unknown) {
        const message =
          axios.isAxiosError(error) && error.response?.data?.detail
            ? error.response.data.detail
            : error instanceof Error
              ? error.message
              : "Failed to load VLM schema";
        setVlmErrorMessage(message);
      }
    };
    loadSchema();
  }, []);

  useEffect(() => {
    const loadSourceStatus = async () => {
      try {
        const response = await axios.get("/api/storage/stats", {
          params: { include_storage_details: 0 },
        });
        if (response.data?.source_table_exists === false) {
          setSourceWarning(
            response.data?.warning ??
              "Исходные данные еще не скачаны. Таблица кадров отсутствует."
          );
        } else {
          setSourceWarning(null);
        }
      } catch {
        setSourceWarning(null);
      }
    };
    loadSourceStatus();
  }, []);

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

  const updateVlmDraftField = (
    id: string,
    key: keyof Omit<FieldDraft, "id">,
    value: string
  ) => {
    setVlmDraftFields((current) =>
      current.map((field) =>
        field.id === id ? { ...field, [key]: value } : field
      )
    );
  };

  const addVlmFieldRow = () => {
    setVlmDraftFields((current) => [...current, createFieldDraft()]);
  };

  const removeVlmFieldRow = (id: string) => {
    setVlmDraftFields((current) => {
      if (current.length === 1) return current;
      return current.filter((field) => field.id !== id);
    });
  };

  const saveVlmSchema = async () => {
    const fields = vlmDraftFields
      .map((field) => ({
        name: field.name.trim(),
        prompt: field.prompt.trim(),
        response_type: field.response_type,
      }))
      .filter((field) => field.name && field.prompt);

    if (fields.length === 0) {
      setVlmStatusMessage(null);
      setVlmWarningMessage(null);
      setShowVlmJobsLink(false);
      setVlmErrorMessage("Add at least one field with a prompt.");
      return;
    }

    setIsSavingVlmSchema(true);
    setVlmStatusMessage(null);
    setVlmWarningMessage(null);
    setShowVlmJobsLink(false);
    setVlmErrorMessage(null);

    try {
      const response = await axios.post("/api/vlm/schema", { fields });
      const nextFields = response.data?.fields ?? [];
      setVlmSavedFields(nextFields);
      setVlmDraftFields(
        nextFields.map((field: SavedField) => ({
          id: `${field.field_name}-${Math.random().toString(16).slice(2)}`,
          name: field.field_name,
          prompt: field.prompt,
          response_type: field.response_type,
        }))
      );
      setVlmStatusMessage("VLM schema saved.");
      setVlmWarningMessage(null);
    } catch (error: unknown) {
      const message =
        axios.isAxiosError(error) && error.response?.data?.detail
          ? error.response.data.detail
          : error instanceof Error
            ? error.message
            : "Failed to save VLM schema";
      setVlmErrorMessage(message);
    } finally {
      setIsSavingVlmSchema(false);
    }
  };

  const startVlmBackfill = async () => {
    if (vlmSavedFields.length === 0) {
      setVlmStatusMessage(null);
      setVlmWarningMessage(null);
      setShowVlmJobsLink(false);
      setVlmErrorMessage("Save VLM fields before starting analysis.");
      return;
    }

    setIsStartingVlmJob(true);
    setVlmStatusMessage(null);
    setVlmWarningMessage(null);
    setShowVlmJobsLink(false);
    setVlmErrorMessage(null);

    try {
      const statsResponse = await axios.get("/api/storage/stats", {
        params: { include_storage_details: 0 },
      });
      const pendingRows = Number(statsResponse.data?.vlm?.pending_rows ?? 0);
      if (pendingRows <= 0) {
        setVlmWarningMessage(
          "Все сцены уже размечены для VLM. Новая backfill-джоба не требуется."
        );
        return;
      }

      const response = await axios.post("/api/vlm/backfill", {
        field_names: vlmSavedFields.map((field) => field.field_name),
        limit: vlmBackfillLimit,
        overwrite_existing: false,
        max_new_tokens: vlmMaxNewTokens,
      });
      setVlmStatusMessage(`VLM backfill started. Job ID: ${response.data.job_id}.`);
      setShowVlmJobsLink(true);
    } catch (error: unknown) {
      const message =
        axios.isAxiosError(error) && error.response?.data?.detail
          ? error.response.data.detail
          : error instanceof Error
            ? error.message
            : "Failed to start VLM backfill";
      setVlmErrorMessage(message);
    } finally {
      setIsStartingVlmJob(false);
    }
  };

  const clearVlmAnnotations = async () => {
    const confirmed = window.confirm(
      "Delete all saved VLM annotations from the database?"
    );
    if (!confirmed) return;

    setIsClearingVlmAnnotations(true);
    setVlmStatusMessage(null);
    setVlmWarningMessage(null);
    setShowVlmJobsLink(false);
    setVlmErrorMessage(null);
    try {
      const response = await axios.post("/api/vlm/clear");
      const deletedRows = response.data?.deleted_rows ?? 0;
      setVlmStatusMessage(`VLM annotations cleared. Deleted rows: ${deletedRows}.`);
    } catch (error: unknown) {
      const message =
        axios.isAxiosError(error) && error.response?.data?.detail
          ? error.response.data.detail
          : error instanceof Error
            ? error.message
            : "Failed to clear VLM annotations";
      setVlmErrorMessage(message);
    } finally {
      setIsClearingVlmAnnotations(false);
    }
  };

  const startDatasetInstall = async () => {
    const selectedDatasets = DATASET_OPTIONS
      .map((option) => option.key)
      .filter((datasetKey) => installDatasets[datasetKey]);

    if (selectedDatasets.length === 0) {
      setInstallStatusMessage(null);
      setShowInstallJobsLink(false);
      setInstallErrorMessage("Select at least one dataset for installation.");
      return;
    }

    const configs: Record<string, Record<string, unknown>> = {};
    for (const dataset of selectedDatasets) {
      try {
        const parsed = JSON.parse(datasetConfigText[dataset] || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          configs[dataset] = parsed as Record<string, unknown>;
        } else {
          throw new Error("Config must be a JSON object.");
        }
      } catch (error) {
        setInstallStatusMessage(null);
        setShowInstallJobsLink(false);
        setInstallErrorMessage(
          `Invalid JSON config for ${dataset}: ${
            error instanceof Error ? error.message : "Parse error"
          }`
        );
        return;
      }
    }

    setIsStartingInstall(true);
    setInstallStatusMessage(null);
    setInstallErrorMessage(null);
    setShowInstallJobsLink(false);

    try {
      const response = await axios.post("/api/datasets/install", {
        datasets: selectedDatasets,
        configs,
      });
      const jobs = response.data?.jobs ?? [];
      const jobsInfo = jobs
        .map((job: { dataset?: string; job_id?: string }) =>
          `${job.dataset ?? "dataset"} (${String(job.job_id ?? "").slice(0, 8)}...)`
        )
        .join(", ");
      setInstallStatusMessage(
        jobs.length > 0
          ? `Installation jobs started: ${jobsInfo}.`
          : "Installation request sent."
      );
      setShowInstallJobsLink(true);
    } catch (error: unknown) {
      const message =
        axios.isAxiosError(error) && error.response?.data?.detail
          ? error.response.data.detail
          : axios.isAxiosError(error) && error.response?.data?.error
            ? error.response.data.error
            : error instanceof Error
              ? error.message
              : "Failed to start dataset installation";
      setInstallErrorMessage(message);
    } finally {
      setIsStartingInstall(false);
    }
  };

  return (
    <section className="px-6 pt-10 pb-16">
      <div className="mx-auto flex max-w-5xl flex-col gap-8">
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="mb-5">
            <h2 className="text-2xl font-semibold text-slate-900">
              Dataset Installation
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              Select datasets, edit config JSON, and start installation jobs.
              Each dataset runs as a separate job in Job Monitor.
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            {DATASET_OPTIONS.map((option) => (
              <label
                key={option.key}
                className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-700"
              >
                <input
                  type="checkbox"
                  checked={installDatasets[option.key]}
                  onChange={(event) =>
                    setInstallDatasets((current) => ({
                      ...current,
                      [option.key]: event.target.checked,
                    }))
                  }
                  className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                />
                {option.label}
              </label>
            ))}
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-3">
            {DATASET_OPTIONS.map((option) => (
              <div
                key={`${option.key}-config`}
                className={`rounded-2xl border p-4 ${
                  installDatasets[option.key]
                    ? "border-sky-200 bg-sky-50/30"
                    : "border-slate-200 bg-slate-50"
                }`}
              >
                <div className="mb-2 text-sm font-semibold text-slate-800">
                  {option.label} config (JSON)
                </div>
                <textarea
                  value={datasetConfigText[option.key] ?? "{}"}
                  onChange={(event) =>
                    setDatasetConfigText((current) => ({
                      ...current,
                      [option.key]: event.target.value,
                    }))
                  }
                  rows={10}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 outline-none focus:border-sky-500"
                />
              </div>
            ))}
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={startDatasetInstall}
              disabled={isStartingInstall}
              className="rounded-full bg-blue-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isStartingInstall ? "Starting..." : "Start dataset installation"}
            </button>
            <button
              type="button"
              onClick={onOpenJobsMonitor}
              className="rounded-full border border-slate-300 px-5 py-3 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
            >
              Open Job Monitor
            </button>
          </div>

          {installStatusMessage && (
            <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800">
              <span>{installStatusMessage}</span>
              {showInstallJobsLink && (
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

          {installErrorMessage && (
            <div className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">
              {installErrorMessage}
            </div>
          )}
        </div>

        {sourceWarning && (
          <div className="rounded-3xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800 shadow-sm">
            {sourceWarning}
          </div>
        )}
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

        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="mb-5">
            <h2 className="text-2xl font-semibold text-slate-900">VLM Schema</h2>
            <p className="mt-2 text-sm text-slate-600">
              Configure VLM fields directly from this tab and run analysis jobs.
            </p>
          </div>

          <div className="flex flex-col gap-4">
            {vlmDraftFields.map((field, index) => (
              <div
                key={field.id}
                className="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 lg:grid-cols-[1.2fr_2.4fr_1fr_auto]"
              >
                <input
                  value={field.name}
                  onChange={(event) =>
                    updateVlmDraftField(field.id, "name", event.target.value)
                  }
                  placeholder={`field_${index + 1}`}
                  className="rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none focus:border-sky-500"
                />
                <textarea
                  value={field.prompt}
                  onChange={(event) =>
                    updateVlmDraftField(field.id, "prompt", event.target.value)
                  }
                  placeholder="Example: Is there a pedestrian crossing in front of the ego vehicle?"
                  rows={3}
                  className="rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none focus:border-sky-500"
                />
                <select
                  value={field.response_type}
                  onChange={(event) =>
                    updateVlmDraftField(
                      field.id,
                      "response_type",
                      event.target.value
                    )
                  }
                  className="rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none focus:border-sky-500"
                >
                  {RESPONSE_TYPE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => removeVlmFieldRow(field.id)}
                  className="rounded-xl border border-slate-300 px-4 py-3 text-sm text-slate-700 transition hover:bg-slate-100"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>

          <div className="mt-5 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={addVlmFieldRow}
              className="rounded-full border border-slate-300 px-5 py-3 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
            >
              Add field
            </button>
            <button
              type="button"
              onClick={saveVlmSchema}
              disabled={isSavingVlmSchema}
              className="rounded-full bg-sky-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSavingVlmSchema ? "Saving..." : "Save schema"}
            </button>
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="mb-5 flex flex-wrap items-end gap-4">
            <div>
              <h2 className="text-2xl font-semibold text-slate-900">
                Analyze Scenes
              </h2>
              <p className="mt-2 text-sm text-slate-600">
                Run VLM over stored scenes and save generated field values.
              </p>
            </div>
            <div className="ml-auto flex flex-wrap gap-3">
              <label className="flex flex-col gap-1 text-sm text-slate-600">
                Limit
                <input
                  type="number"
                  min={1}
                  value={vlmBackfillLimit}
                  onChange={(event) =>
                    setVlmBackfillLimit(Number(event.target.value) || 1)
                  }
                  className="w-28 rounded-xl border border-slate-300 px-4 py-3 text-slate-900 outline-none focus:border-sky-500"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm text-slate-600">
                Max tokens
                <input
                  type="number"
                  min={1}
                  max={512}
                  value={vlmMaxNewTokens}
                  onChange={(event) =>
                    setVlmMaxNewTokens(
                      Math.max(1, Math.min(512, Number(event.target.value) || 1))
                    )
                  }
                  className="w-32 rounded-xl border border-slate-300 px-4 py-3 text-slate-900 outline-none focus:border-sky-500"
                />
              </label>
              <button
                type="button"
                onClick={startVlmBackfill}
                disabled={isStartingVlmJob || vlmSavedFields.length === 0}
                className="rounded-full bg-emerald-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isStartingVlmJob ? "Starting..." : "Start VLM backfill"}
              </button>
              <button
                type="button"
                onClick={clearVlmAnnotations}
                disabled={isClearingVlmAnnotations}
                className="rounded-full bg-rose-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isClearingVlmAnnotations ? "Clearing..." : "Clear VLM annotations"}
              </button>
              <button
                type="button"
                onClick={onOpenJobsMonitor}
                className="rounded-full border border-slate-300 px-5 py-3 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
              >
                Open Job Monitor
              </button>
            </div>
          </div>

          {vlmStatusMessage && (
            <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800">
              <span>{vlmStatusMessage}</span>
              {showVlmJobsLink && (
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

          {vlmWarningMessage && (
            <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
              {vlmWarningMessage}
            </div>
          )}

          {vlmErrorMessage && (
            <div className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">
              {vlmErrorMessage}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
