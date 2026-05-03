"use client";

import { useEffect, useState } from "react";
import axios from "axios";

import ImageGallery from "./ImageGallery";

type ResponseType = "short_text" | "text" | "yes_no" | "number" | "category";
type MatchMode =
  | "contains"
  | "exact"
  | "equal"
  | "not_equal"
  | "greater"
  | "greater_or_equal"
  | "less"
  | "less_or_equal";

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
  score?: number | null;
}

interface MatchModeOption {
  value: MatchMode;
  label: string;
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
const IMAGES_PER_PAGE_OPTIONS = [6, 9, 12, 18, 24];
const DEFAULT_MATCH_MODE: MatchMode = "contains";
const BASIC_MATCH_MODE_OPTIONS: MatchModeOption[] = [
  { value: "contains", label: "Contains" },
  { value: "exact", label: "Exact" },
];
const NUMBER_MATCH_MODE_OPTIONS: MatchModeOption[] = [
  { value: "contains", label: "Contains" },
  { value: "exact", label: "Exact" },
  { value: "equal", label: "Equal" },
  { value: "not_equal", label: "Not equal" },
  { value: "greater", label: "Greater than" },
  { value: "greater_or_equal", label: "Greater or equal" },
  { value: "less", label: "Less than" },
  { value: "less_or_equal", label: "Less or equal" },
];
const YES_NO_VALUE_OPTIONS = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
];

function getMatchModeOptions(responseType: ResponseType): MatchModeOption[] {
  if (responseType === "yes_no") {
    return [{ value: "exact", label: "Exact" }];
  }

  return responseType === "number"
    ? NUMBER_MATCH_MODE_OPTIONS
    : BASIC_MATCH_MODE_OPTIONS;
}

function createFilterState(
  responseType: ResponseType,
  current?: FilterState
): FilterState {
  const allowedModes = new Set(
    getMatchModeOptions(responseType).map((option) => option.value)
  );
  const nextValue =
    responseType === "yes_no" &&
    current?.value &&
    !YES_NO_VALUE_OPTIONS.some((option) => option.value === current.value)
      ? ""
      : current?.value ?? "";

  return {
    value: nextValue,
    match_mode: allowedModes.has(current?.match_mode ?? DEFAULT_MATCH_MODE)
      ? (current?.match_mode ?? DEFAULT_MATCH_MODE)
      : DEFAULT_MATCH_MODE,
  };
}

function createFieldDraft(): FieldDraft {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: "",
    prompt: "",
    response_type: "yes_no",
  };
}

function normalizeFieldName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!normalized) return "";
  return /^[0-9]/.test(normalized) ? `field_${normalized}` : normalized;
}

export default function VlmPanel() {
  const [draftFields, setDraftFields] = useState<FieldDraft[]>([createFieldDraft()]);
  const [savedFields, setSavedFields] = useState<SavedField[]>([]);
  const [filters, setFilters] = useState<Record<string, FilterState>>({});
  const [images, setImages] = useState<ImageResult[]>([]);
  const [schemaStatusMessage, setSchemaStatusMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [schemaDeleteDialog, setSchemaDeleteDialog] = useState<{
    fields: Array<{ name: string; prompt: string; response_type: ResponseType }>;
    removedFieldNames: string[];
  } | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [imagesPerPage, setImagesPerPage] = useState(9);
  const [sourceWarning, setSourceWarning] = useState<string | null>(null);

  const totalPages = Math.max(1, Math.ceil(images.length / imagesPerPage));
  const pageStart = (currentPage - 1) * imagesPerPage;
  const paginatedImages = images.slice(pageStart, pageStart + imagesPerPage);

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
              createFilterState(field.response_type),
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

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

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
      setSchemaStatusMessage(null);
      setErrorMessage("Add at least one field with a prompt.");
      return;
    }

    const savedFieldNames = new Set(
      savedFields.map((field) => field.field_name).filter(Boolean)
    );
    const nextFieldNames = new Set(
      fields.map((field) => normalizeFieldName(field.name)).filter(Boolean)
    );
    const removedFieldNames = Array.from(savedFieldNames)
      .filter((name) => !nextFieldNames.has(name))
      .sort();
    if (removedFieldNames.length > 0) {
      setSchemaDeleteDialog({ fields, removedFieldNames });
      return;
    }

    await persistSchema(fields, false);
  };

  const persistSchema = async (
    fields: Array<{ name: string; prompt: string; response_type: ResponseType }>,
    purgeDeletedValues: boolean
  ) => {
    setSchemaDeleteDialog(null);
    setIsSaving(true);
    setSchemaStatusMessage(null);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const response = await axios.post("/api/vlm/schema", {
        fields,
        replace_missing: true,
        purge_deleted_values: purgeDeletedValues,
      });
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
            createFilterState(field.response_type, filters[field.field_name]),
          ])
        )
      );
      setSchemaStatusMessage("VLM schema saved.");
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

  const runFilterSearch = async () => {
    const activeFilters = savedFields
      .map((field) => ({
        field_name: field.field_name,
        value: filters[field.field_name]?.value?.trim() ?? "",
        match_mode: filters[field.field_name]?.match_mode ?? DEFAULT_MATCH_MODE,
      }))
      .filter((filter) => filter.value.length > 0);

    if (activeFilters.length === 0) {
      setAnalyzeStatusMessage(null);
      setErrorMessage("Set at least one VLM filter value.");
      setImages([]);
      setCurrentPage(1);
      return;
    }

    setIsSearching(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const response = await axios.post("/api/vlm/search", {
        filters: activeFilters,
        limit: 100,
      });
      setImages(response.data ?? []);
      setCurrentPage(1);
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
      setCurrentPage(1);
    } finally {
      setIsSearching(false);
    }
  };

  return (
    <section className="px-6 pt-10 pb-16">
      <div className="mx-auto flex max-w-6xl flex-col gap-8">
        {sourceWarning && (
          <div className="rounded-3xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800 shadow-sm">
            {sourceWarning}
          </div>
        )}
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
          {schemaStatusMessage && (
            <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800">
              {schemaStatusMessage}
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
                      {field.response_type === "yes_no" ? (
                        <select
                          value={filters[field.field_name]?.value ?? ""}
                          onChange={(event) =>
                            setFilters((current) => ({
                              ...current,
                              [field.field_name]: {
                                ...createFilterState(
                                  field.response_type,
                                  current[field.field_name]
                                ),
                                value: event.target.value,
                              },
                            }))
                          }
                          className="flex-1 rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none focus:border-sky-500"
                        >
                          <option value="">No value</option>
                          {YES_NO_VALUE_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          value={filters[field.field_name]?.value ?? ""}
                          onChange={(event) =>
                            setFilters((current) => ({
                              ...current,
                              [field.field_name]: {
                                ...createFilterState(
                                  field.response_type,
                                  current[field.field_name]
                                ),
                                value: event.target.value,
                              },
                            }))
                          }
                          placeholder={
                            field.response_type === "number"
                              ? "Number value"
                              : "Filter value"
                          }
                          className="flex-1 rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none focus:border-sky-500"
                        />
                      )}
                      <select
                        value={
                          filters[field.field_name]?.match_mode ?? DEFAULT_MATCH_MODE
                        }
                        onChange={(event) =>
                          setFilters((current) => ({
                            ...current,
                            [field.field_name]: createFilterState(
                              field.response_type,
                              {
                                value: current[field.field_name]?.value ?? "",
                                match_mode: event.target.value as MatchMode,
                              }
                            ),
                          }))
                        }
                        className="rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none focus:border-sky-500"
                      >
                        {getMatchModeOptions(field.response_type).map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
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

        {schemaDeleteDialog && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
            <div className="w-full max-w-xl rounded-xl bg-white shadow-2xl">
              <div className="border-b border-slate-200 px-5 py-4">
                <div className="text-base font-semibold text-slate-900">
                  Удалить поле из VLM Schema?
                </div>
              </div>
              <div className="px-5 py-4 text-sm text-slate-700">
                <div>
                  Будут удалены столбцы и сохраненные значения в аннотациях:
                </div>
                <div className="mt-2 rounded-lg bg-slate-100 px-3 py-2 font-mono text-xs text-slate-800">
                  {schemaDeleteDialog.removedFieldNames.join(", ")}
                </div>
              </div>
              <div className="flex flex-nowrap items-center justify-end gap-2 border-t border-slate-200 px-5 py-4">
                <button
                  type="button"
                  onClick={() => setSchemaDeleteDialog(null)}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
                >
                  Отмена
                </button>
                <button
                  type="button"
                  onClick={() => persistSchema(schemaDeleteDialog.fields, true)}
                  disabled={isSaving}
                  className="rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60"
                >
                  Подтвердить удаление
                </button>
              </div>
            </div>
          </div>
        )}

        {images.length > 0 && (
          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-4 rounded-2xl border border-gray-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-sm text-gray-600">
                Показаны {pageStart + 1}-{Math.min(pageStart + imagesPerPage, images.length)} из {images.length}
              </div>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <label className="flex items-center gap-2 text-sm text-gray-600">
                  Картинок на странице
                  <select
                    value={imagesPerPage}
                    onChange={(event) => {
                      setImagesPerPage(Number(event.target.value));
                      setCurrentPage(1);
                    }}
                    className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900"
                  >
                    {IMAGES_PER_PAGE_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                    disabled={currentPage === 1}
                    className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    ← Назад
                  </button>
                  <div className="min-w-24 text-center text-sm font-medium text-gray-700">
                    {currentPage} / {totalPages}
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setCurrentPage((page) => Math.min(totalPages, page + 1))
                    }
                    disabled={currentPage === totalPages}
                    className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Вперёд →
                  </button>
                </div>
              </div>
            </div>

            <ImageGallery images={paginatedImages} />
          </div>
        )}
      </div>
    </section>
  );
}
