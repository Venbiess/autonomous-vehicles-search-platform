"use client";

import { useEffect, useState } from "react";
import axios from "axios";

import ImageGallery from "./ImageGallery";

type ResponseType = "short_text" | "text" | "yes_no" | "number" | "category";
type MatchMode = "exact" | "contains";

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

interface FilterState {
  value: string;
  match_mode: MatchMode;
}

interface ImageResult {
  id: string;
  title: string;
  url: string;
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

function usesContainsMatch(responseType: ResponseType): boolean {
  return responseType === "short_text" || responseType === "text";
}

function createFieldDraft(): FieldDraft {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: "",
    prompt: "",
    response_type: "yes_no",
  };
}

interface VlmPanelProps {
  onOpenJobsMonitor: () => void;
}

export default function VlmPanel({ onOpenJobsMonitor }: VlmPanelProps) {
  const [draftFields, setDraftFields] = useState<FieldDraft[]>([createFieldDraft()]);
  const [savedFields, setSavedFields] = useState<SavedField[]>([]);
  const [filters, setFilters] = useState<Record<string, FilterState>>({});
  const [images, setImages] = useState<ImageResult[]>([]);
  const [analyzeStatusMessage, setAnalyzeStatusMessage] = useState<string | null>(null);
  const [showAnalyzeJobsLink, setShowAnalyzeJobsLink] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [isStartingJob, setIsStartingJob] = useState(false);
  const [isClearingAnnotations, setIsClearingAnnotations] = useState(false);
  const [backfillLimit, setBackfillLimit] = useState(200);
  const [maxNewTokens, setMaxNewTokens] = useState(64);

  useEffect(() => {
    const loadSchema = async () => {
      try {
        const response = await axios.get("/api/vlm/schema");
        const fields = response.data?.fields ?? [];
        setSavedFields(fields);
        setDraftFields(
          fields.length > 0
            ? fields.map((field: SavedField) => ({
                id: `${field.field_name}-${Math.random().toString(16).slice(2)}`,
                name: field.field_name,
                prompt: field.prompt,
                response_type: field.response_type,
              }))
            : [createFieldDraft()]
        );
        setFilters(
          Object.fromEntries(
            fields.map((field: SavedField) => [
                field.field_name,
              {
                value: "",
                match_mode: usesContainsMatch(field.response_type) ? "contains" : "exact",
              },
            ])
          )
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to load VLM schema";
        setErrorMessage(message);
      }
    };
    loadSchema();
  }, []);

  const updateDraftField = (
    id: string,
    key: keyof Omit<FieldDraft, "id">,
    value: string
  ) => {
    setDraftFields((current) =>
      current.map((field) =>
        field.id === id ? { ...field, [key]: value } : field
      )
    );
  };

  const addFieldRow = () => {
    setDraftFields((current) => [...current, createFieldDraft()]);
  };

  const removeFieldRow = (id: string) => {
    setDraftFields((current) => {
      if (current.length === 1) return current;
      return current.filter((field) => field.id !== id);
    });
  };

  const saveSchema = async () => {
    const fields = draftFields
      .map((field) => ({
        name: field.name.trim(),
        prompt: field.prompt.trim(),
        response_type: field.response_type,
      }))
      .filter((field) => field.name && field.prompt);

    if (fields.length === 0) {
      setAnalyzeStatusMessage(null);
      setShowAnalyzeJobsLink(false);
      setErrorMessage("Add at least one field with a prompt.");
      return;
    }

    setIsSaving(true);
    setAnalyzeStatusMessage(null);
    setShowAnalyzeJobsLink(false);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const response = await axios.post("/api/vlm/schema", { fields });
      const nextFields = response.data?.fields ?? [];
      setSavedFields(nextFields);
      setDraftFields(
        nextFields.map((field: SavedField) => ({
          id: `${field.field_name}-${Math.random().toString(16).slice(2)}`,
          name: field.field_name,
          prompt: field.prompt,
          response_type: field.response_type,
        }))
      );
      setFilters(
        Object.fromEntries(
          nextFields.map((field: SavedField) => [
            field.field_name,
            {
              value: filters[field.field_name]?.value ?? "",
              match_mode:
                filters[field.field_name]?.match_mode ??
                (usesContainsMatch(field.response_type) ? "contains" : "exact"),
            },
          ])
        )
      );
      setAnalyzeStatusMessage("VLM schema saved.");
    } catch (error: unknown) {
      const message =
        axios.isAxiosError(error) && error.response?.data?.detail
          ? error.response.data.detail
          : error instanceof Error
            ? error.message
            : "Failed to save VLM schema";
      setErrorMessage(message);
    } finally {
      setIsSaving(false);
    }
  };

  const startBackfill = async () => {
    if (savedFields.length === 0) {
      setAnalyzeStatusMessage(null);
      setShowAnalyzeJobsLink(false);
      setErrorMessage("Save VLM fields before starting analysis.");
      return;
    }

    setIsStartingJob(true);
    setAnalyzeStatusMessage(null);
    setShowAnalyzeJobsLink(false);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const response = await axios.post("/api/vlm/backfill", {
        field_names: savedFields.map((field) => field.field_name),
        limit: backfillLimit,
        overwrite_existing: false,
        max_new_tokens: maxNewTokens,
      });
      setAnalyzeStatusMessage(`VLM backfill started. Job ID: ${response.data.job_id}. `);
      setShowAnalyzeJobsLink(true);
    } catch (error: unknown) {
      const message =
        axios.isAxiosError(error) && error.response?.data?.detail
          ? error.response.data.detail
          : error instanceof Error
            ? error.message
            : "Failed to start VLM backfill";
      setErrorMessage(message);
    } finally {
      setIsStartingJob(false);
    }
  };

  const clearAnnotations = async () => {
    const confirmed = window.confirm(
      "Delete all saved VLM annotations from the database?"
    );
    if (!confirmed) {
      return;
    }

    setIsClearingAnnotations(true);
    setAnalyzeStatusMessage(null);
    setShowAnalyzeJobsLink(false);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const response = await axios.post("/api/vlm/clear");
      const deletedRows = response.data?.deleted_rows ?? 0;
      setImages([]);
      setAnalyzeStatusMessage(
        `VLM annotations cleared. Deleted rows: ${deletedRows}.`
      );
    } catch (error: unknown) {
      const message =
        axios.isAxiosError(error) && error.response?.data?.detail
          ? error.response.data.detail
          : error instanceof Error
            ? error.message
            : "Failed to clear VLM annotations";
      setErrorMessage(message);
    } finally {
      setIsClearingAnnotations(false);
    }
  };

  const runFilterSearch = async () => {
    const activeFilters = savedFields
      .map((field) => ({
        field_name: field.field_name,
        value: filters[field.field_name]?.value?.trim() ?? "",
        match_mode: filters[field.field_name]?.match_mode ?? "exact",
      }))
      .filter((filter) => filter.value.length > 0);

    if (activeFilters.length === 0) {
      setAnalyzeStatusMessage(null);
      setErrorMessage("Set at least one VLM filter value.");
      setImages([]);
      return;
    }

    setIsSearching(true);
    setAnalyzeStatusMessage(null);
    setShowAnalyzeJobsLink(false);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const response = await axios.post("/api/vlm/search", {
        filters: activeFilters,
        limit: 100,
      });
      setImages(response.data ?? []);
      if ((response.data ?? []).length === 0) {
        setStatusMessage("No scenes matched the current VLM filters.");
      }
    } catch (error: unknown) {
      const message =
        axios.isAxiosError(error) && error.response?.data?.detail
          ? error.response.data.detail
          : error instanceof Error
            ? error.message
            : "Failed to run VLM search";
      setErrorMessage(message);
      setImages([]);
    } finally {
      setIsSearching(false);
    }
  };

  return (
    <section className="px-6 pt-10 pb-16">
      <div className="mx-auto flex max-w-6xl flex-col gap-8">
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="mb-5">
            <h2 className="text-2xl font-semibold text-slate-900">VLM Schema</h2>
            <p className="mt-2 text-sm text-slate-600">
              Each row becomes a field stored for every scene. The system appends
              response-format instructions automatically based on the selected type.
            </p>
          </div>

          <div className="flex flex-col gap-4">
            {draftFields.map((field, index) => (
              <div
                key={field.id}
                className="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 lg:grid-cols-[1.2fr_2.4fr_1fr_auto]"
              >
                <input
                  value={field.name}
                  onChange={(event) =>
                    updateDraftField(field.id, "name", event.target.value)
                  }
                  placeholder={`field_${index + 1}`}
                  className="rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none focus:border-sky-500"
                />
                <textarea
                  value={field.prompt}
                  onChange={(event) =>
                    updateDraftField(field.id, "prompt", event.target.value)
                  }
                  placeholder="Example: Is there a pedestrian crossing in front of the ego vehicle?"
                  rows={3}
                  className="rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none focus:border-sky-500"
                />
                <select
                  value={field.response_type}
                  onChange={(event) =>
                    updateDraftField(
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
                  onClick={() => removeFieldRow(field.id)}
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
              onClick={addFieldRow}
              className="rounded-full border border-slate-300 px-5 py-3 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
            >
              Add field
            </button>
            <button
              type="button"
              onClick={saveSchema}
              disabled={isSaving}
              className="rounded-full bg-sky-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSaving ? "Saving..." : "Save schema"}
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
                  value={backfillLimit}
                  onChange={(event) => setBackfillLimit(Number(event.target.value) || 1)}
                  className="w-28 rounded-xl border border-slate-300 px-4 py-3 text-slate-900 outline-none focus:border-sky-500"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm text-slate-600">
                Max tokens
                <input
                  type="number"
                  min={1}
                  max={512}
                  value={maxNewTokens}
                  onChange={(event) =>
                    setMaxNewTokens(
                      Math.max(1, Math.min(512, Number(event.target.value) || 1))
                    )
                  }
                  className="w-32 rounded-xl border border-slate-300 px-4 py-3 text-slate-900 outline-none focus:border-sky-500"
                />
              </label>
              <button
                type="button"
                onClick={startBackfill}
                disabled={isStartingJob || savedFields.length === 0}
                className="rounded-full bg-emerald-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isStartingJob ? "Starting..." : "Start VLM backfill"}
              </button>
              <button
                type="button"
                onClick={clearAnnotations}
                disabled={isClearingAnnotations}
                className="rounded-full bg-rose-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isClearingAnnotations ? "Clearing..." : "Clear VLM annotations"}
              </button>
            </div>
          </div>

          {analyzeStatusMessage && (
            <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800">
              <span>{analyzeStatusMessage}</span>
              {showAnalyzeJobsLink && (
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
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="mb-5">
            <h2 className="text-2xl font-semibold text-slate-900">Filter Scenes</h2>
            <p className="mt-2 text-sm text-slate-600">
              Search by saved VLM fields after the analysis job has populated the
              annotations table.
            </p>
          </div>

          {savedFields.length === 0 ? (
            <div className="text-sm text-slate-500">
              Save at least one VLM field to enable filtering.
            </div>
          ) : (
            <>
              <div className="grid gap-4 lg:grid-cols-2">
                {savedFields.map((field) => (
                  <div
                    key={field.field_name}
                    className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                  >
                    <div className="mb-2 text-sm font-semibold text-slate-900">
                      {field.field_name}
                    </div>
                    <div className="mb-3 text-xs text-slate-500">
                      {field.response_type}
                    </div>
                    <div className="flex gap-3">
                      <input
                        value={filters[field.field_name]?.value ?? ""}
                        onChange={(event) =>
                          setFilters((current) => ({
                            ...current,
                            [field.field_name]: {
                              ...(current[field.field_name] ?? {
                                match_mode:
                                  usesContainsMatch(field.response_type)
                                    ? "contains"
                                    : "exact",
                              }),
                              value: event.target.value,
                            },
                          }))
                        }
                        placeholder="Filter value"
                        className="flex-1 rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none focus:border-sky-500"
                      />
                      <select
                        value={filters[field.field_name]?.match_mode ?? "exact"}
                        onChange={(event) =>
                          setFilters((current) => ({
                            ...current,
                            [field.field_name]: {
                              value: current[field.field_name]?.value ?? "",
                              match_mode: event.target.value as MatchMode,
                            },
                          }))
                        }
                        className="rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none focus:border-sky-500"
                      >
                        <option value="exact">Exact</option>
                        <option value="contains">Contains</option>
                      </select>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-5 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={runFilterSearch}
                  disabled={isSearching}
                  className="rounded-full bg-indigo-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isSearching ? "Searching..." : "Search by VLM filters"}
                </button>
              </div>

              {(statusMessage || errorMessage) && (
                <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  {statusMessage && (
                    <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800">
                      {statusMessage}
                    </div>
                  )}
                  {errorMessage && (
                    <div className="text-sm text-rose-700">{errorMessage}</div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {images.length > 0 && (
          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <ImageGallery images={images} />
          </div>
        )}
      </div>
    </section>
  );
}
