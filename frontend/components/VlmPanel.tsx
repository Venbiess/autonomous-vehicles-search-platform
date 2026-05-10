"use client";

import { useEffect, useMemo, useState } from "react";
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
type MatchModeSelectValue = MatchMode | "any";

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
  isAny: boolean;
  value: string;
  match_mode: MatchMode;
}

interface ImageResult {
  id: string;
  title: string;
  url: string;
  score?: number | null;
  attributes?: Record<string, unknown>;
}

interface MatchModeOption {
  value: MatchModeSelectValue;
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
  { value: "equal", label: "Equal" },
  { value: "not_equal", label: "Not equal" },
  { value: "greater", label: "Greater than" },
  { value: "greater_or_equal", label: "Greater or equal than" },
  { value: "less", label: "Less than" },
  { value: "less_or_equal", label: "Less or equal than" },
];
const ANY_MATCH_MODE_OPTION: MatchModeOption = { value: "any", label: "Any" };
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
    isAny: current?.isAny ?? false,
    value: nextValue,
    match_mode: allowedModes.has(current?.match_mode ?? DEFAULT_MATCH_MODE)
      ? (current?.match_mode ?? DEFAULT_MATCH_MODE)
      : DEFAULT_MATCH_MODE,
  };
}

function extractAllowedCategoryLabels(prompt: string): string[] {
  const source = String(prompt || "");
  const blockMatch = source.match(
    /allowed\s+labels?\s*:\s*([\s\S]*?)(?:\n\s*\n|definitions?\s*:|choose\b|$)/i
  );
  if (!blockMatch?.[1]) return [];

  const normalized = blockMatch[1]
    .replace(/\r/g, "\n")
    .replace(/\n/g, ",")
    .replace(/;/g, ",");
  const rawItems = normalized.split(",");
  const seen = new Set<string>();
  const labels: string[] = [];

  for (const rawItem of rawItems) {
    const label = rawItem
      .replace(/^[-*]\s*/, "")
      .replace(/\.$/, "")
      .trim();
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
  }

  return labels;
}

function toErrorMessage(detail: unknown, fallback: string): string {
  if (typeof detail === "string" && detail.trim().length > 0) return detail;
  if (detail instanceof Error && detail.message) return detail.message;
  if (detail && typeof detail === "object") {
    try {
      return JSON.stringify(detail);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function buildFilteredTitle(
  attributes: Record<string, unknown> | undefined,
  preferredFields: string[]
): string {
  const attrs = attributes ?? {};
  const keys = preferredFields.filter((key) => Object.prototype.hasOwnProperty.call(attrs, key));
  if (keys.length > 0) {
    return keys.map((key) => `${key}: ${String(attrs[key])}`).join(" | ");
  }
  const allEntries = Object.entries(attrs);
  if (allEntries.length > 0) {
    return allEntries.map(([key, value]) => `${key}: ${String(value)}`).join(" | ");
  }
  return "";
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
  const [isSchemaCollapsed, setIsSchemaCollapsed] = useState(false);
  const [isFilterScenesCollapsed, setIsFilterScenesCollapsed] = useState(false);

  const totalPages = Math.max(1, Math.ceil(images.length / imagesPerPage));
  const pageStart = (currentPage - 1) * imagesPerPage;
  const paginatedImages = images.slice(pageStart, pageStart + imagesPerPage);
  const categoryOptionsByField = useMemo(
    () =>
      Object.fromEntries(
        savedFields.map((field) => [field.field_name, extractAllowedCategoryLabels(field.prompt)])
      ) as Record<string, string[]>,
    [savedFields]
  );

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
      const message = axios.isAxiosError(error)
        ? toErrorMessage(
            error.response?.data?.detail ?? error.response?.data?.error ?? error.message,
            "Failed to save VLM schema"
          )
        : toErrorMessage(error, "Failed to save VLM schema");
      setErrorMessage(message);
    } finally {
      setIsSaving(false);
    }
  };

  const runFilterSearch = async () => {
    const displayFieldNames = savedFields
      .map((field) => {
        const state = filters[field.field_name];
        const hasValue = (state?.value ?? "").trim().length > 0;
        if ((state?.isAny ?? false) || hasValue) {
          return field.field_name;
        }
        return "";
      })
      .filter((name) => name.length > 0);
    const activeFilters = savedFields
      .map((field) => ({
        field_name: field.field_name,
        is_any: filters[field.field_name]?.isAny ?? true,
        value: filters[field.field_name]?.value?.trim() ?? "",
        match_mode: filters[field.field_name]?.match_mode ?? DEFAULT_MATCH_MODE,
      }))
      .filter((filter) => !filter.is_any && filter.value.length > 0)
      .map((filter) => ({
        field_name: filter.field_name,
        value: filter.value,
        match_mode: filter.match_mode,
      }));

    setIsSearching(true);
    setErrorMessage(null);
    setStatusMessage(null);
    try {
      const response = await axios.post("/api/vlm/search", {
        filters: activeFilters,
        limit: 100,
      });
      const normalizedResults: ImageResult[] = (response.data ?? []).map((item: ImageResult) => {
        const title = buildFilteredTitle(item.attributes, displayFieldNames);
        return {
          ...item,
          title: title || item.title || "",
        };
      });
      setImages(normalizedResults);
      setCurrentPage(1);
      if (normalizedResults.length === 0) {
        setStatusMessage("No scenes matched the current VLM filters.");
      }
    } catch (error: unknown) {
      const message = axios.isAxiosError(error)
        ? toErrorMessage(
            error.response?.data?.detail ?? error.response?.data?.error ?? error.message,
            "Failed to run VLM search"
          )
        : toErrorMessage(error, "Failed to run VLM search");
      setErrorMessage(message);
      setImages([]);
      setCurrentPage(1);
    } finally {
      setIsSearching(false);
    }
  };

  const resetFilters = () => {
    setFilters(
      Object.fromEntries(
        savedFields.map((field) => [
          field.field_name,
          createFilterState(field.response_type),
        ])
      )
    );
    setStatusMessage(null);
    setErrorMessage(null);
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
          <div className="mb-5 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-2xl font-semibold text-slate-900">VLM Schema</h2>
              <p className="mt-2 text-sm text-slate-600">
                Each row becomes a field stored for every scene. The system appends
                response-format instructions automatically based on the selected type.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setIsSchemaCollapsed((current) => !current)}
              className="rounded-full border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-100"
            >
              {isSchemaCollapsed ? "Expand" : "Collapse"}
            </button>
          </div>

          {!isSchemaCollapsed && (
            <>
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
            </>
          )}
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="mb-5 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-2xl font-semibold text-slate-900">Filter Scenes</h2>
              <p className="mt-2 text-sm text-slate-600">
                Search by saved VLM fields after the analysis job has populated the
                annotations table.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={resetFilters}
                className="rounded-full border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-100"
              >
                Reset Filters
              </button>
              <button
                type="button"
                onClick={() => setIsFilterScenesCollapsed((current) => !current)}
                className="rounded-full border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-100"
              >
                {isFilterScenesCollapsed ? "Expand" : "Collapse"}
              </button>
            </div>
          </div>

          {savedFields.length === 0 ? (
            <div className="text-sm text-slate-500">
              Save at least one VLM field to enable filtering.
            </div>
          ) : (
            <>
              {!isFilterScenesCollapsed && (
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
                      <div
                        className={
                          field.response_type === "yes_no"
                            ? "grid gap-3 sm:grid-cols-1"
                            : "grid gap-3 sm:grid-cols-[2fr_1fr]"
                        }
                      >
                        {field.response_type === "yes_no" ? (
                          <select
                            value={
                              filters[field.field_name]?.isAny
                                ? "any"
                                : (filters[field.field_name]?.value ?? "")
                            }
                            onChange={(event) =>
                              setFilters((current) => ({
                                ...current,
                                [field.field_name]: {
                                  ...createFilterState(
                                    field.response_type,
                                    current[field.field_name]
                                  ),
                                  isAny: event.target.value === "any",
                                  value:
                                    event.target.value === "any"
                                      ? ""
                                      : event.target.value,
                                },
                              }))
                            }
                            className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none focus:border-sky-500"
                          >
                            <option value="">None</option>
                            <option value="any">Any</option>
                            {YES_NO_VALUE_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        ) : field.response_type === "category" ? (
                          <>
                            {(() => {
                              const fieldState = filters[field.field_name];
                              const matchMode = fieldState?.match_mode ?? DEFAULT_MATCH_MODE;
                              const isExactMode = !fieldState?.isAny && matchMode === "exact";
                              const categoryOptions = categoryOptionsByField[field.field_name] ?? [];
                              const currentValue = fieldState?.value ?? "";
                              const hasCurrentInOptions = categoryOptions.includes(currentValue);
                              const isCustomMode =
                                isExactMode && currentValue.length > 0 && !hasCurrentInOptions;
                              const selectValue = isCustomMode
                                ? "__custom__"
                                : hasCurrentInOptions
                                  ? currentValue
                                  : "";

                              return (
                                <>
                                  {isExactMode && categoryOptions.length > 0 ? (
                                    <>
                                      <select
                                        value={selectValue}
                                        onChange={(event) =>
                                          setFilters((current) => {
                                            const prevValue = current[field.field_name]?.value ?? "";
                                            const nextValue =
                                              event.target.value === "__custom__"
                                                ? (categoryOptions.includes(prevValue)
                                                    ? ""
                                                    : prevValue)
                                                : event.target.value;
                                            return {
                                              ...current,
                                              [field.field_name]: {
                                                ...createFilterState(
                                                  field.response_type,
                                                  current[field.field_name]
                                                ),
                                                isAny: false,
                                                value: nextValue,
                                              },
                                            };
                                          })
                                        }
                                        disabled={fieldState?.isAny ?? true}
                                        className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none focus:border-sky-500 disabled:cursor-not-allowed disabled:bg-slate-100"
                                      >
                                        <option value="">Select value</option>
                                        {categoryOptions.map((label) => (
                                          <option key={label} value={label}>
                                            {label}
                                          </option>
                                        ))}
                                        <option value="__custom__">Custom value</option>
                                      </select>
                                      {selectValue === "__custom__" && (
                                        <input
                                          value={currentValue}
                                          onChange={(event) =>
                                            setFilters((current) => ({
                                              ...current,
                                              [field.field_name]: {
                                                ...createFilterState(
                                                  field.response_type,
                                                  current[field.field_name]
                                                ),
                                                isAny: false,
                                                value: event.target.value,
                                              },
                                            }))
                                          }
                                          disabled={fieldState?.isAny ?? true}
                                          placeholder="Type exact value"
                                          className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none focus:border-sky-500 disabled:cursor-not-allowed disabled:bg-slate-100"
                                        />
                                      )}
                                    </>
                                  ) : (
                                    <input
                                      value={currentValue}
                                      onChange={(event) =>
                                        setFilters((current) => ({
                                          ...current,
                                          [field.field_name]: {
                                            ...createFilterState(
                                              field.response_type,
                                              current[field.field_name]
                                            ),
                                            isAny: false,
                                            value: event.target.value,
                                          },
                                        }))
                                      }
                                      disabled={fieldState?.isAny ?? true}
                                      placeholder="Filter value"
                                      className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none focus:border-sky-500 disabled:cursor-not-allowed disabled:bg-slate-100"
                                    />
                                  )}
                                </>
                              );
                            })()}
                          </>
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
                                  isAny: false,
                                  value: event.target.value,
                                },
                              }))
                            }
                            disabled={filters[field.field_name]?.isAny ?? true}
                            placeholder={
                              field.response_type === "number"
                                ? "Number value"
                                : "Filter value"
                            }
                            className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none focus:border-sky-500 disabled:cursor-not-allowed disabled:bg-slate-100"
                          />
                        )}
                        {field.response_type !== "yes_no" && (
                          <select
                            value={
                              filters[field.field_name]?.isAny
                                ? "any"
                                : (filters[field.field_name]?.match_mode ?? DEFAULT_MATCH_MODE)
                            }
                            onChange={(event) =>
                              setFilters((current) => ({
                                ...current,
                                [field.field_name]:
                                  event.target.value === "any"
                                    ? {
                                        ...createFilterState(
                                          field.response_type,
                                          current[field.field_name]
                                        ),
                                        isAny: true,
                                        value: "",
                                      }
                                    : {
                                        ...createFilterState(field.response_type, {
                                          value: current[field.field_name]?.value ?? "",
                                          match_mode: event.target.value as MatchMode,
                                        }),
                                        isAny: false,
                                      },
                              }))
                            }
                            className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none focus:border-sky-500"
                          >
                            {[ANY_MATCH_MODE_OPTION, ...getMatchModeOptions(field.response_type)].map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

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
