"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { getLocalizedText, type UiLanguageCode } from "../lib/uiLanguage";

interface AnnotationPanelProps {
  onOpenJobsMonitor: () => void;
  onOpenStorage: () => void;
  showSyntheticMethod?: boolean;
  showOpenAIBatchBlock?: boolean;
  language?: UiLanguageCode;
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

interface PreprocessorMethod {
  key: string;
  label: string;
  description?: string;
  description_i18n?: Record<string, string>;
  default_config?: Record<string, unknown>;
}

interface DatasetRowDistribution {
  dataset?: string;
}

const URL_PATTERN = /https?:\/\/[^\s]+/g;

function normalizeI18nMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [rawLang, rawText] of Object.entries(value as Record<string, unknown>)) {
    const lang = String(rawLang || "").trim().toLowerCase();
    const text = String(rawText || "").trim();
    if (!lang || !text) continue;
    out[lang] = text;
  }
  return out;
}

function resolveMethodDescription(method: PreprocessorMethod, language: UiLanguageCode): string {
  const localized = normalizeI18nMap(method.description_i18n);
  const exact = localized[String(language).toLowerCase()];
  if (exact) return exact;
  const base = String(language).toLowerCase().split("-")[0];
  if (base && localized[base]) return localized[base];
  return String(method.description || "").trim();
}

function splitDescriptionWithUrls(text: string): Array<{ text?: string; url?: string }> {
  const normalized = String(text || "").trim();
  if (!normalized) return [];
  const chunks: Array<{ text?: string; url?: string }> = [];
  let lastIndex = 0;
  for (const match of normalized.matchAll(URL_PATTERN)) {
    const url = String(match[0] || "");
    const idx = match.index ?? 0;
    if (idx > lastIndex) {
      chunks.push({ text: normalized.slice(lastIndex, idx) });
    }
    chunks.push({ url: url.replace(/[),.;]+$/, "") });
    lastIndex = idx + url.length;
  }
  if (lastIndex < normalized.length) {
    chunks.push({ text: normalized.slice(lastIndex) });
  }
  return chunks;
}

function isSyntheticMethod(method: Pick<PreprocessorMethod, "key" | "label">): boolean {
  const key = String(method.key || "").trim().toLowerCase();
  const label = String(method.label || "").trim().toLowerCase();
  return key === "synthetic" || label.includes("synthetic");
}

function moveSyntheticToEnd(methods: PreprocessorMethod[]): PreprocessorMethod[] {
  const regular = methods.filter((item) => !isSyntheticMethod(item));
  const synthetic = methods.filter((item) => isSyntheticMethod(item));
  return [...regular, ...synthetic];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientFetchFailure(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  const message = String(error.message || "").toLowerCase();
  const detail = String(error.response?.data?.detail || error.response?.data?.error || "").toLowerCase();
  return (
    message.includes("fetch failed") ||
    message.includes("network error") ||
    message.includes("timeout") ||
    detail.includes("fetch failed") ||
    detail.includes("connection refused") ||
    detail.includes("bad gateway")
  );
}

interface WaymoAuthStartResponse {
  session_id?: string;
  auth_url?: string;
  awaiting_code?: boolean;
  status?: string;
  error?: string;
}

interface WaymoAuthStatusResponse {
  authenticated?: boolean;
  reason?: string;
  error?: string;
}

interface EmbeddingMismatchDialogState {
  queryDim: number;
  storedDim: number;
  message: string;
}

interface PendingInstallPayload {
  datasets: string[];
  configs: Record<string, Record<string, unknown>>;
}

interface LocalUploadFormState {
  bucket: string;
  datasetType: string;
  cameraName: string;
  timestamp: string;
  sourceLink: string;
  objectKey: string;
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

function parseIntegerInput(
  rawValue: string,
  label: string,
  { min = 1, max }: { min?: number; max?: number } = {}
): number {
  const value = String(rawValue ?? "").trim();
  if (!value) {
    throw new Error(`${label} is required.`);
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`${label} must be an integer.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`${label} must be >= ${min}.`);
  }
  if (typeof max === "number" && parsed > max) {
    throw new Error(`${label} must be <= ${max}.`);
  }
  return parsed;
}

export default function AnnotationPanel({
  onOpenJobsMonitor,
  onOpenStorage,
  showSyntheticMethod = true,
  showOpenAIBatchBlock = false,
  language = "ru",
}: AnnotationPanelProps) {
  const tr = useCallback(
    (ru: string, en: string) => getLocalizedText(language, { ru, en }, en),
    [language]
  );
  const getDatasetLinkLabel = (url: string, index: number, total: number): string => {
    const value = String(url || "").toLowerCase();
    if (value.includes("huggingface.co")) {
      return tr("Ссылка Hugging Face", "Hugging Face Link");
    }
    if (value.includes("kaggle.com")) {
      return tr("Ссылка Kaggle", "Kaggle Link");
    }
    if (value.includes("once-for-auto-driving.github.io")) {
      return tr("Ссылка ONCE", "ONCE Link");
    }
    const base = tr("Ссылка на датасет", "Dataset Link");
    return total > 1 ? `${base} ${index + 1}` : base;
  };
  const responseTypeOptions = useMemo(
    () => [
      { value: "yes_no" as ResponseType, label: tr("Да / Нет", "Yes / No") },
      { value: "number" as ResponseType, label: tr("Число", "Number") },
      { value: "category" as ResponseType, label: tr("Категория", "Category") },
      { value: "short_text" as ResponseType, label: tr("Короткий текст", "Short text") },
      { value: "text" as ResponseType, label: tr("Подробный текст", "Detailed text") },
    ],
    [tr]
  );
  const localUploadFileInputRef = useRef<HTMLInputElement | null>(null);
  const [limitInput, setLimitInput] = useState("1000");
  const [batchSizeInput, setBatchSizeInput] = useState("50");
  const [isStartingJob, setIsStartingJob] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [warningMessage, setWarningMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showJobsLink, setShowJobsLink] = useState(false);
  const [vlmDraftFields, setVlmDraftFields] = useState<FieldDraft[]>([
    createFieldDraft(),
  ]);
  const [vlmSavedFields, setVlmSavedFields] = useState<SavedField[]>([]);
  const [vlmSchemaStatusMessage, setVlmSchemaStatusMessage] = useState<string | null>(
    null
  );
  const [vlmBackfillLimitInput, setVlmBackfillLimitInput] = useState("200");
  const [vlmBatchSizeInput, setVlmBatchSizeInput] = useState("10");
  const [vlmMaxNewTokensInput, setVlmMaxNewTokensInput] = useState("64");
  const [isSavingVlmSchema, setIsSavingVlmSchema] = useState(false);
  const [isStartingVlmJob, setIsStartingVlmJob] = useState(false);
  const [openAiCombinedPromptInput, setOpenAiCombinedPromptInput] = useState("");
  const [vlmApiProvider, setVlmApiProvider] = useState<"openai">("openai");
  const [openAiUseJsonSchema, setOpenAiUseJsonSchema] = useState(false);
  const [openAiJsonSchemaInput, setOpenAiJsonSchemaInput] = useState("");
  const [openAiFieldNamesInput, setOpenAiFieldNamesInput] = useState("");
  const [openAiUseAllSchemaFields, setOpenAiUseAllSchemaFields] = useState(true);
  const [openAiBackfillLimitInput, setOpenAiBackfillLimitInput] = useState("200");
  const [openAiBatchSizeInput, setOpenAiBatchSizeInput] = useState("32");
  const [openAiMaxTokensInput, setOpenAiMaxTokensInput] = useState("256");
  const [openAiDataset, setOpenAiDataset] = useState<string>("all");
  const [openAiOverwriteExisting, setOpenAiOverwriteExisting] = useState(false);
  const [openAiDryRun, setOpenAiDryRun] = useState(false);
  const [isStartingOpenAiBatchJob, setIsStartingOpenAiBatchJob] = useState(false);
  const [openAiBatchStatusMessage, setOpenAiBatchStatusMessage] = useState<string | null>(null);
  const [openAiBatchWarningMessage, setOpenAiBatchWarningMessage] = useState<string | null>(null);
  const [openAiBatchErrorMessage, setOpenAiBatchErrorMessage] = useState<string | null>(null);
  const [showOpenAiBatchJobsLink, setShowOpenAiBatchJobsLink] = useState(false);
  const [schemaDeleteDialog, setSchemaDeleteDialog] = useState<{
    fields: Array<{ name: string; prompt: string; response_type: ResponseType }>;
    removedFieldNames: string[];
  } | null>(null);
  const [vlmStatusMessage, setVlmStatusMessage] = useState<string | null>(null);
  const [vlmWarningMessage, setVlmWarningMessage] = useState<string | null>(null);
  const [vlmErrorMessage, setVlmErrorMessage] = useState<string | null>(null);
  const [showVlmJobsLink, setShowVlmJobsLink] = useState(false);
  const [isVlmSchemaCollapsed, setIsVlmSchemaCollapsed] = useState(false);
  const [sourceWarning, setSourceWarning] = useState<string | null>(null);
  const [availableDatasets, setAvailableDatasets] = useState<string[]>([]);
  const [embeddingDataset, setEmbeddingDataset] = useState<string>("all");
  const [vlmDataset, setVlmDataset] = useState<string>("all");
  const [preprocessorMethods, setPreprocessorMethods] = useState<
    PreprocessorMethod[]
  >([]);
  const [preprocessorMethodsError, setPreprocessorMethodsError] = useState<string | null>(null);
  const [installDatasets, setInstallDatasets] = useState<Record<string, boolean>>(
    {}
  );
  const [datasetConfigText, setDatasetConfigText] = useState<Record<string, string>>(
    {}
  );
  const [isStartingInstall, setIsStartingInstall] = useState(false);
  const [installStatusMessage, setInstallStatusMessage] = useState<string | null>(
    null
  );
  const [installErrorMessage, setInstallErrorMessage] = useState<string | null>(
    null
  );
  const [showInstallJobsLink, setShowInstallJobsLink] = useState(false);
  const [waymoAuthModalOpen, setWaymoAuthModalOpen] = useState(false);
  const [waymoAuthSessionId, setWaymoAuthSessionId] = useState<string | null>(null);
  const [waymoAuthUrl, setWaymoAuthUrl] = useState<string | null>(null);
  const [waymoAuthCode, setWaymoAuthCode] = useState("");
  const [waymoAuthBusy, setWaymoAuthBusy] = useState(false);
  const [waymoAuthError, setWaymoAuthError] = useState<string | null>(null);
  const [waymoAuthSuccess, setWaymoAuthSuccess] = useState<string | null>(null);
  const [pendingWaymoInstall, setPendingWaymoInstall] = useState<PendingInstallPayload | null>(null);
  const [localUploadModalOpen, setLocalUploadModalOpen] = useState(false);
  const [localUploadFile, setLocalUploadFile] = useState<File | null>(null);
  const [isUploadingLocalImage, setIsUploadingLocalImage] = useState(false);
  const [localUploadError, setLocalUploadError] = useState<string | null>(null);
  const [localUploadSuccess, setLocalUploadSuccess] = useState<string | null>(null);
  const [embeddingMismatchDialog, setEmbeddingMismatchDialog] =
    useState<EmbeddingMismatchDialogState | null>(null);
  const [isRebuildingEmbeddings, setIsRebuildingEmbeddings] = useState(false);
  const [localUploadForm, setLocalUploadForm] = useState<LocalUploadFormState>({
    bucket: "manual",
    datasetType: "local_upload",
    cameraName: "FRONT",
    timestamp: "",
    sourceLink: "",
    objectKey: "",
  });

  const visiblePreprocessorMethods = useMemo(
    () =>
      showSyntheticMethod
        ? preprocessorMethods
        : preprocessorMethods.filter((item) => !isSyntheticMethod(item)),
    [preprocessorMethods, showSyntheticMethod]
  );

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
              : tr("Не удалось загрузить VLM schema", "Failed to load VLM schema");
        setVlmErrorMessage(message);
      }
    };
    loadSchema();
  }, [tr]);

  useEffect(() => {
    if (!openAiFieldNamesInput.trim() && vlmSavedFields.length > 0) {
      setOpenAiFieldNamesInput(vlmSavedFields.map((field) => field.field_name).join(", "));
    }
  }, [vlmSavedFields, openAiFieldNamesInput]);

  useEffect(() => {
    const loadDatasets = async () => {
      try {
        const response = await axios.get("/api/storage/stats", {
          params: { include_storage_details: 1 },
        });
        const rows: DatasetRowDistribution[] = Array.isArray(
          response.data?.datasets?.rows_distribution
        )
          ? response.data.datasets.rows_distribution
          : [];
        const datasetNames: string[] = rows
          .map((item) => String(item?.dataset || "").trim())
          .filter((name: string): name is string => Boolean(name));
        const unique = Array.from(new Set(datasetNames)).sort((a, b) => a.localeCompare(b));
        setAvailableDatasets(unique);
      } catch {
        setAvailableDatasets([]);
      }
    };
    loadDatasets();
  }, [tr]);

  useEffect(() => {
    let cancelled = false;
    const loadPreprocessorMethods = async () => {
      const maxAttempts = 4;
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const response = await axios.get("/api/storage/preprocessors");
          if (cancelled) return;
          const items: unknown[] = Array.isArray(response.data?.items)
            ? response.data.items
            : [];
          const methods: PreprocessorMethod[] = items
            .map((rawItem) => {
              const item =
                rawItem && typeof rawItem === "object"
                  ? (rawItem as Record<string, unknown>)
                  : {};
              return {
                key: String(item.key ?? "").trim(),
                label: String(item.label ?? "").trim(),
                description:
                  typeof item.description === "string"
                    ? item.description.trim()
                    : undefined,
                description_i18n: normalizeI18nMap(item.description_i18n),
                default_config: {
                  embed_on_install: false,
                  ...(item.default_config &&
                  typeof item.default_config === "object" &&
                  !Array.isArray(item.default_config)
                    ? (item.default_config as Record<string, unknown>)
                    : {}),
                },
              };
            })
            .filter((item: PreprocessorMethod) => item.key && item.label);
          const orderedMethods = moveSyntheticToEnd(methods);
          setPreprocessorMethods(orderedMethods);
          setInstallDatasets(
            orderedMethods.reduce<Record<string, boolean>>((acc, item) => {
              acc[item.key] = false;
              return acc;
            }, {})
          );
          setDatasetConfigText(
            orderedMethods.reduce<Record<string, string>>((acc, item) => {
              acc[item.key] = JSON.stringify(item.default_config ?? {}, null, 2);
              return acc;
            }, {})
          );
          setPreprocessorMethodsError(null);
          return;
        } catch (error: unknown) {
          lastError = error;
          if (!isTransientFetchFailure(error) || attempt === maxAttempts) {
            break;
          }
          await sleep(600 * attempt);
        }
      }
      if (cancelled) return;
      const message =
        axios.isAxiosError(lastError) && lastError.response?.data?.detail
          ? String(lastError.response.data.detail)
          : axios.isAxiosError(lastError) && lastError.response?.data?.error
            ? String(lastError.response.data.error)
            : isTransientFetchFailure(lastError)
              ? tr(
                  "Storage server запускается. Повторите через несколько секунд.",
                  "Storage server is starting up. Retry in a few seconds."
                )
              : lastError instanceof Error
                ? lastError.message
                : tr(
                    "Не удалось загрузить preprocessor methods из storage API. Проверьте логи storage-server на ошибки YAML/config.",
                    "Failed to load preprocessor methods from storage API. Check storage-server logs for YAML/config parse errors."
                  );
      setPreprocessorMethods([]);
      setInstallDatasets({});
      setDatasetConfigText({});
      setPreprocessorMethodsError(message);
    };
    loadPreprocessorMethods();
    return () => {
      cancelled = true;
    };
  }, [tr]);

  useEffect(() => {
    const loadSourceStatus = async () => {
      try {
        const response = await axios.get("/api/storage/stats", {
          params: { include_storage_details: 0 },
        });
        if (response.data?.source_table_exists === false) {
          setSourceWarning(
            response.data?.warning ??
              tr(
                "Исходные данные еще не скачаны. Таблица кадров отсутствует.",
                "Source data has not been downloaded yet. Frames table is missing."
              )
          );
        } else {
          setSourceWarning(null);
        }
      } catch {
        setSourceWarning(null);
      }
    };
    loadSourceStatus();
  }, [tr]);

  useEffect(() => {
    if (!waymoAuthModalOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setWaymoAuthModalOpen(false);
        setWaymoAuthError(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [waymoAuthModalOpen]);

  const startBackfill = async () => {
    setIsStartingJob(true);
    setStatusMessage(null);
    setWarningMessage(null);
    setErrorMessage(null);
    setShowJobsLink(false);

    try {
      const limit = parseIntegerInput(limitInput, "Limit", { min: 1 });
      const batchSize = parseIntegerInput(batchSizeInput, "Batch size", { min: 1 });

      try {
        const dimResponse = await axios.get("/api/embeddings/dimensions");
        const payload = dimResponse.data || {};
        if (payload?.status === "ok" && payload?.mismatch === true) {
          const queryDim = Number(payload?.query_dim || 0);
          const storedDim = Number(payload?.stored_dim || 0);
          setEmbeddingMismatchDialog({
            queryDim,
            storedDim,
            message:
              queryDim > 0 && storedDim > 0
                ? `Размерность нового embedder (${queryDim}) не совпадает с текущей разметкой storage (${storedDim}).`
                : tr(
                    "Размерность нового embedder не совпадает с текущей разметкой storage.",
                    "The new embedder dimension does not match the current storage mapping."
                  ),
          });
          return;
        }
      } catch {
        // If dimensions endpoint is unavailable, continue with current flow.
      }

      const statsResponse = await axios.get("/api/storage/stats", {
        params: {
          include_storage_details: 1,
          force_refresh: 1,
        },
      });
      const pendingRows = Number(statsResponse.data?.embeddings?.pending_rows ?? 0);
      if (pendingRows <= 0) {
        setWarningMessage(
          tr(
            "Все сцены уже размечены векторными эмбеддингами. Новая backfill-джоба не требуется.",
            "All scenes already have vector embeddings. A new backfill job is not required."
          )
        );
        return;
      }

      const response = await axios.post("/api/backfill", {
        limit,
        batch_size: batchSize,
        stop_on_error: false,
        dataset: embeddingDataset === "all" ? null : embeddingDataset,
      });
      setStatusMessage(
        tr(
          `Запущен embedding backfill. Job ID: ${response.data.job_id}.`,
          `Embedding backfill started. Job ID: ${response.data.job_id}.`
        )
      );
      setShowJobsLink(true);
    } catch (error: unknown) {
      const message =
        axios.isAxiosError(error) && error.response?.data?.detail
          ? error.response.data.detail
          : error instanceof Error
            ? error.message
            : tr("Не удалось запустить разметку эмбеддингов", "Failed to start embedding backfill");
      setErrorMessage(message);
    } finally {
      setIsStartingJob(false);
    }
  };

  const rebuildEmbeddingsAndStartBackfill = async () => {
    try {
      const limit = parseIntegerInput(limitInput, "Limit", { min: 1 });
      const batchSize = parseIntegerInput(batchSizeInput, "Batch size", { min: 1 });
      setIsRebuildingEmbeddings(true);
      setStatusMessage(null);
      setWarningMessage(null);
      setErrorMessage(null);
      setShowJobsLink(false);

      const resetResponse = await axios.post("/api/storage/clear-embeddings", {
        confirm: true,
        page_size: 1000,
      });
      const resetEmbeddings = Number(resetResponse.data?.reset_embeddings || 0);

      const statsResponse = await axios.get("/api/storage/stats", {
        params: {
          include_storage_details: 1,
          force_refresh: 1,
        },
      });
      const pendingRows = Number(statsResponse.data?.embeddings?.pending_rows ?? 0);
      const response = await axios.post("/api/backfill", {
        limit: Math.max(1, Math.max(Math.floor(pendingRows || 0), limit)),
        batch_size: batchSize,
        stop_on_error: false,
        dataset: embeddingDataset === "all" ? null : embeddingDataset,
      });

      setEmbeddingMismatchDialog(null);
      setStatusMessage(
        tr(
          `Embeddings reset: ${resetEmbeddings}. Запущен embedding backfill. Job ID: ${response.data.job_id}.`,
          `Embeddings reset: ${resetEmbeddings}. Embedding backfill started. Job ID: ${response.data.job_id}.`
        )
      );
      setShowJobsLink(true);
    } catch (error: unknown) {
      const message =
        axios.isAxiosError(error) && error.response?.data?.detail
          ? error.response.data.detail
          : axios.isAxiosError(error) && error.response?.data?.error
            ? error.response.data.error
            : error instanceof Error
              ? error.message
              : tr("Не удалось пересоздать embeddings", "Failed to rebuild embeddings");
      setErrorMessage(message);
    } finally {
      setIsRebuildingEmbeddings(false);
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
      setVlmSchemaStatusMessage(null);
      setVlmStatusMessage(null);
      setVlmWarningMessage(null);
      setShowVlmJobsLink(false);
      setVlmErrorMessage(
        tr(
          "Добавьте хотя бы одно поле с prompt.",
          "Add at least one field with a prompt."
        )
      );
      return;
    }

    const savedFieldNames = new Set(
      vlmSavedFields.map((field) => field.field_name).filter(Boolean)
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

    await persistVlmSchema(fields, false);
  };

  const persistVlmSchema = async (
    fields: Array<{ name: string; prompt: string; response_type: ResponseType }>,
    purgeDeletedValues: boolean
  ) => {
    setSchemaDeleteDialog(null);
    setIsSavingVlmSchema(true);
    setVlmSchemaStatusMessage(null);
    setVlmStatusMessage(null);
    setVlmWarningMessage(null);
    setShowVlmJobsLink(false);
    setVlmErrorMessage(null);

    try {
      const response = await axios.post("/api/vlm/schema", {
        fields,
        replace_missing: true,
        purge_deleted_values: purgeDeletedValues,
      });
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
      setVlmSchemaStatusMessage(tr("VLM schema сохранена.", "VLM schema saved."));
    } catch (error: unknown) {
      const message =
        axios.isAxiosError(error) && error.response?.data?.detail
          ? error.response.data.detail
          : error instanceof Error
            ? error.message
            : tr("Не удалось сохранить VLM schema", "Failed to save VLM schema");
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
      setVlmErrorMessage(
        tr(
          "Сохраните VLM-поля перед запуском анализа.",
          "Save VLM fields before starting analysis."
        )
      );
      return;
    }

    setIsStartingVlmJob(true);
    setVlmStatusMessage(null);
    setVlmWarningMessage(null);
    setShowVlmJobsLink(false);
    setVlmErrorMessage(null);

    try {
      const vlmBackfillLimit = parseIntegerInput(vlmBackfillLimitInput, "VLM limit", {
        min: 1,
      });
      const vlmBatchSize = parseIntegerInput(vlmBatchSizeInput, "VLM batch size", {
        min: 1,
      });
      const vlmMaxNewTokens = parseIntegerInput(vlmMaxNewTokensInput, "VLM max tokens", {
        min: 1,
        max: 512,
      });

      const statsResponse = await axios.get("/api/storage/stats", {
        params: {
          include_storage_details: 1,
          force_refresh: 1,
        },
      });
      const pendingRows = Number(statsResponse.data?.vlm?.pending_rows ?? 0);
      if (pendingRows <= 0) {
        setVlmWarningMessage(
          tr(
            "Все сцены уже размечены для VLM. Новая backfill-джоба не требуется.",
            "All scenes already have VLM annotations. A new backfill job is not required."
          )
        );
        return;
      }

      const response = await axios.post("/api/vlm/backfill", {
        field_names: vlmSavedFields.map((field) => field.field_name),
        limit: vlmBackfillLimit,
        batch_size: vlmBatchSize,
        overwrite_existing: false,
        max_new_tokens: vlmMaxNewTokens,
        dataset: vlmDataset === "all" ? null : vlmDataset,
      });
      setVlmStatusMessage(
        tr(
          `Запущен VLM backfill. Job ID: ${response.data.job_id}.`,
          `VLM backfill started. Job ID: ${response.data.job_id}.`
        )
      );
      setShowVlmJobsLink(true);
    } catch (error: unknown) {
      const message =
        axios.isAxiosError(error) && error.response?.data?.detail
          ? error.response.data.detail
          : error instanceof Error
            ? error.message
            : tr("Не удалось запустить VLM разметку", "Failed to start VLM backfill");
      setVlmErrorMessage(message);
    } finally {
      setIsStartingVlmJob(false);
    }
  };

  const parseOpenAiFieldNames = (): string[] => {
    if (openAiUseAllSchemaFields) {
      return vlmSavedFields.map((field) => field.field_name).filter(Boolean);
    }
    return Array.from(
      new Set(
        openAiFieldNamesInput
          .split(/[\n,]+/)
          .map((item) => normalizeFieldName(item))
          .filter(Boolean)
      )
    );
  };

  const parseOpenAiJsonSchema = (): Record<string, unknown> | null => {
    if (!openAiUseJsonSchema) {
      return null;
    }
    const raw = openAiJsonSchemaInput.trim();
    if (!raw) {
      throw new Error("Custom JSON schema is enabled, but schema field is empty.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error: unknown) {
      // Accept Python-like literals when users paste examples from scripts/docs.
      const normalizedRaw = raw
        .replace(/\bTrue\b/g, "true")
        .replace(/\bFalse\b/g, "false")
        .replace(/\bNone\b/g, "null");
      try {
        parsed = JSON.parse(normalizedRaw);
      } catch {
        throw new Error(
          `Custom JSON schema must be valid JSON: ${
            error instanceof Error ? error.message : "parse error"
          }`
        );
      }
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Custom JSON schema must be a JSON object.");
    }

    const inputObject = parsed as Record<string, unknown>;
    let schema: Record<string, unknown> = inputObject;

    // Support full response_format wrapper:
    // { "type": "json_schema", "json_schema": { "name": "...", "strict": true, "schema": {...} } }
    if (inputObject.type === "json_schema") {
      const jsonSchemaWrapper = inputObject.json_schema;
      if (
        !jsonSchemaWrapper ||
        typeof jsonSchemaWrapper !== "object" ||
        Array.isArray(jsonSchemaWrapper)
      ) {
        throw new Error(
          "When using \"type\": \"json_schema\", field \"json_schema\" must be an object."
        );
      }
      const wrapped = jsonSchemaWrapper as Record<string, unknown>;
      const wrappedSchema = wrapped.schema;
      if (!wrappedSchema || typeof wrappedSchema !== "object" || Array.isArray(wrappedSchema)) {
        throw new Error(
          "When using json_schema wrapper, field \"json_schema.schema\" must be an object."
        );
      }
      schema = wrappedSchema as Record<string, unknown>;
    } else if (
      inputObject.schema &&
      typeof inputObject.schema === "object" &&
      !Array.isArray(inputObject.schema)
    ) {
      // Also support direct json_schema object:
      // { "name": "...", "strict": true, "schema": {...} }
      const nestedSchema = inputObject.schema as Record<string, unknown>;
      if (nestedSchema.type === "object") {
        schema = nestedSchema;
      }
    }

    if (schema.type !== "object") {
      throw new Error(
        tr(
          "Custom JSON schema должен содержать \"type\": \"object\".",
          "Custom JSON schema must contain \"type\": \"object\"."
        )
      );
    }
    const properties = schema.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
      throw new Error(
        tr(
          "Custom JSON schema должен содержать объект \"properties\".",
          "Custom JSON schema must contain an object \"properties\"."
        )
      );
    }
    if ("required" in schema) {
      const required = schema.required;
      if (
        !Array.isArray(required) ||
        required.some((item) => typeof item !== "string")
      ) {
        throw new Error(
          tr(
            "Поле \"required\" в Custom JSON schema должно быть массивом строк.",
            "Custom JSON schema field \"required\" must be an array of strings."
          )
        );
      }
    }
    return schema;
  };

  const startOpenAiBatchBackfill = async () => {
    setIsStartingOpenAiBatchJob(true);
    setOpenAiBatchStatusMessage(null);
    setOpenAiBatchWarningMessage(null);
    setOpenAiBatchErrorMessage(null);
    setShowOpenAiBatchJobsLink(false);

    try {
      const fieldNames = parseOpenAiFieldNames();
      if (fieldNames.length === 0) {
        setOpenAiBatchErrorMessage(
          tr(
            "Выберите хотя бы одно поле VLM (или включите \"Использовать все сохраненные поля схемы\").",
            "Select at least one VLM field (or enable 'Use all schema fields')."
          )
        );
        return;
      }

      const combinedPrompt = openAiCombinedPromptInput.trim();
      if (!combinedPrompt) {
        setOpenAiBatchErrorMessage(
          tr(
            "Combined prompt обязателен. Опишите формат JSON и правила полей.",
            "Combined prompt is required. Describe the JSON format and field rules."
          )
        );
        return;
      }

      const limit = parseIntegerInput(openAiBackfillLimitInput, tr("Лимит API batch", "API batch limit"), {
        min: 1,
      });
      const batchSize = parseIntegerInput(
        openAiBatchSizeInput,
        tr("Размер чанка сцен API", "API scene chunk size"),
        {
        min: 1,
        }
      );
      const maxTokens = parseIntegerInput(openAiMaxTokensInput, tr("Макс. токенов API", "API max tokens"), {
        min: 1,
        max: 512,
      });
      const customJsonSchema = parseOpenAiJsonSchema();

      if (vlmApiProvider !== "openai") {
        setOpenAiBatchErrorMessage(
          tr("Неподдерживаемый API provider", "Unsupported API provider") + `: ${vlmApiProvider}`
        );
        return;
      }

      const statsResponse = await axios.get("/api/storage/stats", {
        params: {
          include_storage_details: 1,
          force_refresh: 1,
        },
      });
      const pendingRows = Number(statsResponse.data?.vlm?.pending_rows ?? 0);
      if (pendingRows <= 0 && !openAiOverwriteExisting) {
        setOpenAiBatchWarningMessage(
          tr(
            "Все сцены уже имеют VLM разметку. Включите перезапись или выберите другой датасет.",
            "All scenes already have VLM annotations. Enable overwrite or choose another dataset."
          )
        );
        return;
      }

      const response = await axios.post("/api/vlm/backfill", {
        field_names: fieldNames,
        limit,
        batch_size: batchSize,
        stop_on_error: false,
        dry_run: openAiDryRun,
        overwrite_existing: openAiOverwriteExisting,
        max_new_tokens: maxTokens,
        dataset: openAiDataset === "all" ? null : openAiDataset,
        combine_fields_into_json: true,
        combined_prompt: combinedPrompt,
        use_openai_batch_api: vlmApiProvider === "openai",
        openai_use_json_schema: openAiUseJsonSchema,
        openai_json_schema: customJsonSchema,
      });
      const dryRunSuffix = openAiDryRun
        ? tr(" (dry-run, без записи)", " (dry-run, no write)")
        : "";
      setOpenAiBatchStatusMessage(
        tr("API Batch VLM backfill запущен", "API Batch VLM backfill started") +
          `${dryRunSuffix}. Job ID: ${response.data.job_id}.`
      );
      setShowOpenAiBatchJobsLink(true);
    } catch (error: unknown) {
      const message =
        axios.isAxiosError(error) && error.response?.data?.detail
          ? error.response.data.detail
          : error instanceof Error
            ? error.message
            : tr(
                "Не удалось запустить API Batch VLM backfill",
                "Failed to start API Batch VLM backfill"
              );
      setOpenAiBatchErrorMessage(message);
    } finally {
      setIsStartingOpenAiBatchJob(false);
    }
  };

  const fetchWaymoAuthLink = async () => {
    try {
      setWaymoAuthBusy(true);
      setWaymoAuthError(null);
      const response = await axios.post<WaymoAuthStartResponse>("/api/waymo/auth/start", {});
      const payload = response.data || {};
      const sessionId = String(payload.session_id || "").trim();
      const authUrl = String(payload.auth_url || "").trim();
      if (!sessionId) {
        throw new Error(
          tr(
            "Не удалось создать сессию авторизации Waymo.",
            "Failed to create a Waymo auth session."
          )
        );
      }
      setWaymoAuthSessionId(sessionId);
      setWaymoAuthUrl(authUrl || null);
      if (!authUrl) {
        setWaymoAuthError(
          tr(
            "Ссылка авторизации пока не получена. Нажмите «Обновить ссылку» через несколько секунд.",
            "The auth link is not ready yet. Click Refresh link in a few seconds."
          )
        );
      }
    } catch (error: unknown) {
      const message =
        axios.isAxiosError(error) && error.response?.data?.detail
          ? String(error.response.data.detail)
          : axios.isAxiosError(error) && error.response?.data?.error
            ? String(error.response.data.error)
            : error instanceof Error
              ? error.message
              : tr("Не удалось запустить авторизацию Waymo.", "Failed to start Waymo auth.");
      setWaymoAuthError(message);
    } finally {
      setWaymoAuthBusy(false);
    }
  };

  const submitWaymoAuthCode = async () => {
    if (!waymoAuthSessionId) {
      setWaymoAuthError(tr("Сначала получите ссылку авторизации.", "Get the auth link first."));
      return;
    }
    const code = waymoAuthCode.trim();
    if (!code) {
      setWaymoAuthError(tr("Введите код авторизации.", "Enter the auth code."));
      return;
    }
    try {
      setWaymoAuthBusy(true);
      setWaymoAuthError(null);
      const response = await axios.post("/api/waymo/auth/complete", {
        session_id: waymoAuthSessionId,
        code,
      });
      const message = String(response.data?.message || "").trim();
      setWaymoAuthSuccess(
        message || tr("Авторизация Google ADC выполнена.", "Google ADC authorization completed.")
      );
      setWaymoAuthModalOpen(false);
      setWaymoAuthCode("");
      if (pendingWaymoInstall) {
        await executeDatasetInstall(
          pendingWaymoInstall.datasets,
          pendingWaymoInstall.configs,
          { clearPending: true }
        );
      }
    } catch (error: unknown) {
      const detail = axios.isAxiosError(error) ? error.response?.data?.detail : null;
      if (detail && typeof detail === "object" && Array.isArray((detail as { logs_tail?: string[] }).logs_tail)) {
        const payload = detail as { message?: string; logs_tail?: string[] };
        setWaymoAuthError(
          `${String(payload.message || tr("Ошибка авторизации", "Authorization error"))}\n\n${(payload.logs_tail || []).join("\n")}`
        );
      } else if (typeof detail === "string") {
        setWaymoAuthError(detail);
      } else {
        const message =
          error instanceof Error
            ? error.message
            : tr("Не удалось завершить авторизацию.", "Failed to complete authorization.");
        setWaymoAuthError(message);
      }
    } finally {
      setWaymoAuthBusy(false);
    }
  };

  const executeDatasetInstall = async (
    selectedDatasets: string[],
    configs: Record<string, Record<string, unknown>>,
    options?: { clearPending?: boolean }
  ) => {
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
          ? tr(
              `Джобы установки запущены: ${jobsInfo}.`,
              `Installation jobs started: ${jobsInfo}.`
            )
          : tr("Запрос на установку отправлен.", "Installation request sent.")
      );
      setShowInstallJobsLink(true);
      if (options?.clearPending) {
        setPendingWaymoInstall(null);
      }
    } catch (error: unknown) {
      const message =
        axios.isAxiosError(error) && error.response?.data?.detail
          ? error.response.data.detail
          : axios.isAxiosError(error) && error.response?.data?.error
            ? error.response.data.error
            : error instanceof Error
              ? error.message
              : tr("Не удалось запустить установку датасетов", "Failed to start dataset installation");
      setInstallErrorMessage(message);
    } finally {
      setIsStartingInstall(false);
    }
  };

  const startDatasetInstall = async () => {
    const selectedDatasets = visiblePreprocessorMethods
      .map((option) => option.key)
      .filter((datasetKey) => installDatasets[datasetKey]);

    if (selectedDatasets.length === 0) {
      setInstallStatusMessage(null);
      setShowInstallJobsLink(false);
      setInstallErrorMessage(
        tr(
          "Выберите хотя бы один датасет для установки.",
          "Select at least one dataset for installation."
        )
      );
      return;
    }

    const configs: Record<string, Record<string, unknown>> = {};
    for (const dataset of selectedDatasets) {
      try {
        const parsed = JSON.parse(datasetConfigText[dataset] || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          configs[dataset] = parsed as Record<string, unknown>;
        } else {
          throw new Error(tr("Config должен быть JSON-объектом.", "Config must be a JSON object."));
        }
      } catch (error) {
        setInstallStatusMessage(null);
        setShowInstallJobsLink(false);
        setInstallErrorMessage(
          tr(
            `Некорректный JSON config для ${dataset}: ${
              error instanceof Error ? error.message : "Ошибка парсинга"
            }`,
            `Invalid JSON config for ${dataset}: ${
              error instanceof Error ? error.message : "Parse error"
            }`
          )
        );
        return;
      }
    }

    if (selectedDatasets.includes("waymo")) {
      try {
        const response = await axios.get<WaymoAuthStatusResponse>("/api/waymo/auth/status");
        const authenticated = Boolean(response.data?.authenticated);
        if (!authenticated) {
          setInstallStatusMessage(null);
          setShowInstallJobsLink(false);
          setInstallErrorMessage(null);
          setInstallStatusMessage(
            tr(
              "Для установки Waymo нужна авторизация Google ADC. Завершите авторизацию в окне ниже, установка запустится автоматически.",
              "Waymo installation requires Google ADC authorization. Complete authorization below and installation will start automatically."
            )
          );
          setPendingWaymoInstall({
            datasets: selectedDatasets,
            configs,
          });
          setWaymoAuthModalOpen(true);
          setWaymoAuthSuccess(null);
          if (!waymoAuthSessionId) {
            await fetchWaymoAuthLink();
          }
          return;
        }
      } catch (error: unknown) {
        const message =
          axios.isAxiosError(error) && error.response?.data?.detail
            ? String(error.response.data.detail)
            : axios.isAxiosError(error) && error.response?.data?.error
              ? String(error.response.data.error)
              : error instanceof Error
                ? error.message
                : tr("Не удалось проверить авторизацию Waymo.", "Failed to check Waymo authorization.");
        setInstallStatusMessage(null);
        setShowInstallJobsLink(false);
        setInstallErrorMessage(message);
        return;
      }
    }
    await executeDatasetInstall(selectedDatasets, configs, { clearPending: true });
  };

  const openLocalUploadDialog = () => {
    setLocalUploadError(null);
    setLocalUploadSuccess(null);
    localUploadFileInputRef.current?.click();
  };

  const handleLocalImageSelected = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    if (!file) return;
    setLocalUploadFile(file);
    setLocalUploadForm((current) => ({
      ...current,
      objectKey: "",
      timestamp: "",
    }));
    setLocalUploadModalOpen(true);
    setLocalUploadError(null);
    setLocalUploadSuccess(null);
    event.target.value = "";
  };

  const buildLocalUploadObjectKey = () => {
    const explicitKey = localUploadForm.objectKey.trim();
    if (explicitKey) return explicitKey;

    const ext = localUploadFile?.name.includes(".")
      ? localUploadFile.name.slice(localUploadFile.name.lastIndexOf("."))
      : ".jpg";
    const safeDataset = (localUploadForm.datasetType.trim() || "local_upload").replace(
      /[^a-zA-Z0-9/_-]+/g,
      "_"
    );
    const safeCamera = (localUploadForm.cameraName.trim() || "FRONT").replace(
      /[^a-zA-Z0-9_-]+/g,
      "_"
    );
    const ts = localUploadForm.timestamp.trim() || String(Date.now());
    return `${safeDataset}/${safeCamera}_${ts}${ext}`;
  };

  const submitLocalImageUpload = async () => {
    if (!localUploadFile) {
      setLocalUploadError(tr("Сначала выберите изображение.", "Choose an image file first."));
      return;
    }
    const bucket = localUploadForm.bucket.trim();
    if (!bucket) {
      setLocalUploadError(tr("Поле bucket обязательно.", "Bucket is required."));
      return;
    }

    setIsUploadingLocalImage(true);
    setLocalUploadError(null);
    setLocalUploadSuccess(null);
    setInstallErrorMessage(null);
    setInstallStatusMessage(null);

    try {
      const formData = new FormData();
      formData.append("file", localUploadFile, localUploadFile.name);
      formData.append("bucket", bucket);
      formData.append("key", buildLocalUploadObjectKey());
      formData.append("content_type", localUploadFile.type || "application/octet-stream");
      formData.append("camera_name", localUploadForm.cameraName.trim() || "FRONT");
      if (localUploadForm.datasetType.trim()) {
        formData.append("dataset_type", localUploadForm.datasetType.trim());
      }
      if (localUploadForm.timestamp.trim()) {
        formData.append("timestamp", localUploadForm.timestamp.trim());
      }
      if (localUploadForm.sourceLink.trim()) {
        formData.append("source_link", localUploadForm.sourceLink.trim());
      }

      const response = await axios.post("/api/storage/upload-local", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      const payload = response.data || {};
      const objectId = String(payload.object_id || "").trim();
      const storagePath = String(payload.storage_path || "").trim();
      const summary = `${tr("Изображение загружено", "Local image uploaded")}: ${objectId || "n/a"}${
        storagePath ? ` (${storagePath})` : ""
      }`;
      setLocalUploadSuccess(summary);
      setInstallStatusMessage(summary);
      setShowInstallJobsLink(false);
      setLocalUploadModalOpen(false);
      setLocalUploadFile(null);
    } catch (error: unknown) {
      const message =
        axios.isAxiosError(error) && error.response?.data?.error
          ? String(error.response.data.error)
          : axios.isAxiosError(error) && error.response?.data?.detail
            ? String(error.response.data.detail)
            : error instanceof Error
              ? error.message
              : tr("Не удалось загрузить локальное изображение", "Failed to upload local image");
      setLocalUploadError(message);
    } finally {
      setIsUploadingLocalImage(false);
    }
  };

  return (
    <section className="px-6 pt-10 pb-16">
      <div className="mx-auto flex max-w-5xl flex-col gap-8">
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="mb-5">
            <h2 className="text-2xl font-semibold text-slate-900">
              {tr("Установка датасетов", "Dataset Installation")}
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              {tr(
                "Выберите доступные preprocessors из storage API, отредактируйте config JSON и запустите джобы установки. Каждый датасет запускается отдельной джобой в Job Monitor.",
                "Select available preprocessors from storage API, edit config JSON, and start installation jobs. Each dataset runs as a separate job in Job Monitor."
              )}
            </p>
          </div>

          {preprocessorMethodsError && (
            <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">
              {preprocessorMethodsError}
            </div>
          )}

          {!preprocessorMethodsError && visiblePreprocessorMethods.length === 0 && (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
              {tr(
                "Storage API не вернул preprocessor methods.",
                "No preprocessor methods were returned by storage API."
              )}
            </div>
          )}

          <div className="mt-5 grid gap-4 lg:grid-cols-3">
            {visiblePreprocessorMethods.map((option) => (
              <div
                key={`${option.key}-config`}
                className={`rounded-2xl border p-4 ${
                  installDatasets[option.key]
                    ? "border-sky-200 bg-sky-50/30"
                    : "border-slate-200 bg-slate-50"
                }`}
              >
                <label className="mb-3 flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700">
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
                  <span>{option.label}</span>
                </label>
                <div className="mb-2 text-sm font-semibold text-slate-800">
                  {tr("Config (JSON)", "Config (JSON)")}
                </div>
                {(() => {
                  const description = resolveMethodDescription(option, language);
                  if (!description) return null;
                  const chunks = splitDescriptionWithUrls(description);
                  const urlChunks = chunks.filter((chunk) => chunk.url);
                  let linkIndex = 0;
                  return (
                    <div className="mb-2 text-xs leading-relaxed text-slate-500 [overflow-wrap:anywhere] break-words">
                      {chunks.map((chunk, idx) => {
                        if (chunk.url) {
                          const label = getDatasetLinkLabel(
                            chunk.url,
                            linkIndex,
                            urlChunks.length
                          );
                          linkIndex += 1;
                          return (
                            <a
                              key={`link-${option.key}-${idx}`}
                              href={chunk.url}
                              target="_blank"
                              rel="noreferrer"
                              className="font-medium text-blue-600 underline underline-offset-2 hover:text-blue-700"
                            >
                              {label}
                            </a>
                          );
                        }
                        return (
                          <span key={`text-${option.key}-${idx}`}>{chunk.text}</span>
                        );
                      })}
                    </div>
                  );
                })()}
                <textarea
                  value={datasetConfigText[option.key] ?? "{}"}
                  onChange={(event) => {
                    setDatasetConfigText((current) => ({
                      ...current,
                      [option.key]: event.target.value,
                    }));
                    setInstallDatasets((current) => ({
                      ...current,
                      [option.key]: true,
                    }));
                  }}
                  rows={10}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 outline-none focus:border-sky-500"
                />
              </div>
            ))}
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            <input
              ref={localUploadFileInputRef}
              type="file"
              accept="image/*"
              onChange={handleLocalImageSelected}
              className="hidden"
            />
            <button
              type="button"
              onClick={startDatasetInstall}
              disabled={isStartingInstall}
              className="rounded-full bg-blue-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isStartingInstall
                ? tr("Запуск...", "Starting...")
                : tr("Запустить установку датасетов", "Start dataset installation")}
            </button>
            <button
              type="button"
              onClick={onOpenJobsMonitor}
              className="rounded-full border border-slate-300 px-5 py-3 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
            >
              {tr("Открыть Мониторинг", "Open Job Monitor")}
            </button>
            <button
              type="button"
              onClick={openLocalUploadDialog}
              className="inline-flex items-center gap-2 rounded-full border border-slate-300 px-4 py-3 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
              title={tr("Загрузить локальное изображение", "Upload local image")}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-4 w-4"
                aria-hidden="true"
              >
                <path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.9-9.9a4 4 0 0 1 5.66 5.66l-10.6 10.6a2 2 0 0 1-2.83-2.83l9.2-9.19" />
              </svg>
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
                    {tr("Перейти в Мониторинг", "Go to Job Monitor")}
                  </button>
                </>
              )}
            </div>
          )}

          {installErrorMessage && (
            <div className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">
              {installErrorMessage}
              {installErrorMessage.toLowerCase().includes("waymo") && (
                <>
                  {" "}
                  <button
                    type="button"
                    onClick={async () => {
                      setWaymoAuthModalOpen(true);
                      setWaymoAuthError(null);
                      setWaymoAuthSuccess(null);
                      if (!waymoAuthSessionId) {
                        await fetchWaymoAuthLink();
                      }
                    }}
                    className="font-bold text-indigo-700 underline decoration-indigo-600 underline-offset-2 transition hover:text-indigo-800"
                  >
                    {tr("Открыть авторизацию Waymo", "Open Waymo authorization")}
                  </button>
                </>
              )}
            </div>
          )}

          {waymoAuthSuccess && (
            <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800">
              {waymoAuthSuccess}.{" "}
              {tr(
                "Теперь снова нажмите «Запустить установку датасетов».",
                "Now click Start dataset installation again."
              )}
            </div>
          )}
        </div>

        {localUploadModalOpen && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/45 px-4">
            <div className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
              <div className="mb-4">
                <h3 className="text-lg font-semibold text-slate-900">
                  {tr("Загрузка локального изображения", "Upload Local Image")}
                </h3>
                <p className="mt-1 text-sm text-slate-600">
                  {tr("Задайте параметры storage для выбранного файла:", "Set storage parameters for selected file:")}{" "}
                  <span className="font-semibold">{localUploadFile?.name || tr("неизвестно", "unknown")}</span>
                </p>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <label className="flex flex-col gap-1 text-sm text-slate-600">
                  {tr("Bucket", "Bucket")}
                  <input
                    value={localUploadForm.bucket}
                    onChange={(event) =>
                      setLocalUploadForm((current) => ({
                        ...current,
                        bucket: event.target.value,
                      }))
                    }
                    className="rounded-xl border border-slate-300 px-3 py-2 text-slate-900 outline-none focus:border-sky-500"
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm text-slate-600">
                  {tr("Камера", "Camera")}
                  <select
                    value={localUploadForm.cameraName}
                    onChange={(event) =>
                      setLocalUploadForm((current) => ({
                        ...current,
                        cameraName: event.target.value,
                      }))
                    }
                    className="rounded-xl border border-slate-300 px-3 py-2 text-slate-900 outline-none focus:border-sky-500"
                  >
                    <option value="FRONT">FRONT</option>
                    <option value="FRONT_LEFT">FRONT_LEFT</option>
                    <option value="FRONT_RIGHT">FRONT_RIGHT</option>
                    <option value="REAR">REAR</option>
                    <option value="BACK_LEFT">BACK_LEFT</option>
                    <option value="BACK_RIGHT">BACK_RIGHT</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm text-slate-600">
                  {tr("Тип датасета", "Dataset type")}
                  <input
                    value={localUploadForm.datasetType}
                    onChange={(event) =>
                      setLocalUploadForm((current) => ({
                        ...current,
                        datasetType: event.target.value,
                      }))
                    }
                    className="rounded-xl border border-slate-300 px-3 py-2 text-slate-900 outline-none focus:border-sky-500"
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm text-slate-600">
                  {tr("Timestamp (опционально)", "Timestamp (optional)")}
                  <input
                    value={localUploadForm.timestamp}
                    onChange={(event) =>
                      setLocalUploadForm((current) => ({
                        ...current,
                        timestamp: event.target.value,
                      }))
                    }
                    placeholder={tr("например: 1714637835123", "e.g. 1714637835123")}
                    className="rounded-xl border border-slate-300 px-3 py-2 text-slate-900 outline-none focus:border-sky-500"
                  />
                </label>
              </div>

              <div className="mt-3 grid gap-3">
                <label className="flex flex-col gap-1 text-sm text-slate-600">
                  {tr("Storage key (опциональное переопределение)", "Storage key (optional override)")}
                  <input
                    value={localUploadForm.objectKey}
                    onChange={(event) =>
                      setLocalUploadForm((current) => ({
                        ...current,
                        objectKey: event.target.value,
                      }))
                    }
                    placeholder="local_upload/FRONT_1714637835123.jpg"
                    className="rounded-xl border border-slate-300 px-3 py-2 text-slate-900 outline-none focus:border-sky-500"
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm text-slate-600">
                  {tr("Source link (опционально)", "Source link (optional)")}
                  <input
                    value={localUploadForm.sourceLink}
                    onChange={(event) =>
                      setLocalUploadForm((current) => ({
                        ...current,
                        sourceLink: event.target.value,
                      }))
                    }
                    placeholder="local://my-dataset/path/image.jpg"
                    className="rounded-xl border border-slate-300 px-3 py-2 text-slate-900 outline-none focus:border-sky-500"
                  />
                </label>
              </div>

              {localUploadError && (
                <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">
                  {localUploadError}
                </div>
              )}
              {localUploadSuccess && (
                <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800">
                  {localUploadSuccess}
                </div>
              )}

              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (isUploadingLocalImage) return;
                    setLocalUploadModalOpen(false);
                  }}
                  className="rounded-full border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
                >
                  {tr("Отмена", "Cancel")}
                </button>
                <button
                  type="button"
                  onClick={submitLocalImageUpload}
                  disabled={isUploadingLocalImage}
                  className="rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isUploadingLocalImage ? tr("Загрузка...", "Uploading...") : tr("Загрузить", "Upload")}
                </button>
              </div>
            </div>
          </div>
        )}

        {embeddingMismatchDialog && (
          <div
            className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 p-4"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !isRebuildingEmbeddings) {
                setEmbeddingMismatchDialog(null);
              }
            }}
          >
            <div className="w-full max-w-2xl overflow-hidden rounded-2xl bg-white shadow-2xl">
              <div className="border-b border-slate-200 px-5 py-4">
                <div className="text-base font-semibold text-slate-900">
                  {tr("Несовместимая размерность embeddings", "Incompatible embeddings dimension")}
                </div>
                <div className="mt-1 text-sm text-slate-600">{embeddingMismatchDialog.message}</div>
              </div>
              <div className="space-y-3 px-5 py-4 text-sm text-slate-700">
                <div>
                  {tr("Текущий embedder", "Current embedder")}: <span className="font-semibold">{embeddingMismatchDialog.queryDim || "—"}</span>
                </div>
                <div>
                  {tr("Разметка в storage", "Storage mapping")}: <span className="font-semibold">{embeddingMismatchDialog.storedDim || "—"}</span>
                </div>
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
                  {tr(
                    "Возможно стоит пересоздать embedding storage под новую размерность и запустить разметку заново либо вернуть прежнюю модель.",
                    "Consider rebuilding embedding storage for the new dimension and restarting annotation, or switching back to the previous model."
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 px-5 py-4">
                <button
                  type="button"
                  onClick={() => setEmbeddingMismatchDialog(null)}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
                  disabled={isRebuildingEmbeddings}
                >
                  {tr("Отмена", "Cancel")}
                </button>
                <button
                  type="button"
                  onClick={rebuildEmbeddingsAndStartBackfill}
                  className={`rounded-lg px-3 py-2 text-sm font-semibold text-white ${
                    isRebuildingEmbeddings ? "cursor-not-allowed bg-slate-400" : "bg-blue-600 hover:bg-blue-700"
                  }`}
                  disabled={isRebuildingEmbeddings}
                >
                  {isRebuildingEmbeddings
                    ? tr("Пересоздаю embeddings...", "Rebuilding embeddings...")
                    : tr("Пересоздать и разметить заново", "Rebuild and re-annotate")}
                </button>
              </div>
            </div>
          </div>
        )}

        {sourceWarning && (
          <div className="rounded-3xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800 shadow-sm">
            {sourceWarning}
          </div>
        )}
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="mb-5">
            <h2 className="text-2xl font-semibold text-slate-900">
              {tr("Разметка эмбеддингов", "Embedding Annotation")}
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              {tr(
                "Запустите фоновую джобу, которая вычисляет и сохраняет эмбеддинги изображений для сцен в хранилище",
                "Start a background job that computes and saves image embeddings for scenes into the annotation storage."
              )}
            </p>
          </div>

          <div className="mb-6 flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm text-slate-600">
              {tr("Лимит", "Limit")}
              <input
                type="number"
                min={1}
                value={limitInput}
                onChange={(event) => setLimitInput(event.target.value)}
                className="w-28 rounded-xl border border-slate-300 px-4 py-3 text-slate-900 outline-none focus:border-sky-500"
              />
            </label>

            <label className="flex flex-col gap-1 text-sm text-slate-600">
              {tr("Размер батча", "Batch size")}
              <input
                type="number"
                min={1}
                value={batchSizeInput}
                onChange={(event) => setBatchSizeInput(event.target.value)}
                className="w-28 rounded-xl border border-slate-300 px-4 py-3 text-slate-900 outline-none focus:border-sky-500"
              />
            </label>

            <label className="flex flex-col gap-1 text-sm text-slate-600">
              {tr("Датасет", "Dataset")}
              <select
                value={embeddingDataset}
                onChange={(event) => setEmbeddingDataset(event.target.value)}
                className="w-44 rounded-xl border border-slate-300 px-4 py-3 text-slate-900 outline-none focus:border-sky-500"
              >
                <option value="all">{tr("Все датасеты", "All datasets")}</option>
                {availableDatasets.map((dataset) => (
                  <option key={`embed-${dataset}`} value={dataset}>
                    {dataset}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={startBackfill}
              disabled={isStartingJob}
              className="rounded-full bg-emerald-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isStartingJob
                ? tr("Запуск...", "Starting...")
                : tr("Запустить разметку эмбеддингов", "Start embedding backfill")}
            </button>
            <button
              type="button"
              onClick={onOpenJobsMonitor}
              className="rounded-full border border-slate-300 px-5 py-3 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
            >
              {tr("Открыть Мониторинг", "Open Job Monitor")}
            </button>
            <button
              type="button"
              onClick={onOpenStorage}
              className="rounded-full border border-slate-300 px-5 py-3 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
            >
              {tr("Открыть Хранилище", "Go to Storage")}
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
                    {tr("Перейти в Мониторинг", "Go to Job Monitor")}
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
            <h2 className="text-2xl font-semibold text-slate-900">
              {tr("VLM Разметка", "VLM Annotation")}
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              {tr(
                "Запустите фоновую джобу, которая вычисляет и сохраняет VLM-аннотации для сцен в annotation storage.",
                "Start a background job that computes and saves VLM annotations for scenes in the annotation storage."
              )}
            </p>
          </div>
          <div className="mb-6 flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-sm text-slate-600">
                {tr("Лимит", "Limit")}
                <input
                  type="number"
                  min={1}
                  value={vlmBackfillLimitInput}
                  onChange={(event) => setVlmBackfillLimitInput(event.target.value)}
                  className="w-28 rounded-xl border border-slate-300 px-4 py-3 text-slate-900 outline-none focus:border-sky-500"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm text-slate-600">
                {tr("Макс. токенов", "Max tokens")}
                <input
                  type="number"
                  min={1}
                  max={512}
                  value={vlmMaxNewTokensInput}
                  onChange={(event) => setVlmMaxNewTokensInput(event.target.value)}
                  className="w-32 rounded-xl border border-slate-300 px-4 py-3 text-slate-900 outline-none focus:border-sky-500"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm text-slate-600">
                {tr("Размер батча", "Batch size")}
                <input
                  type="number"
                  min={1}
                  value={vlmBatchSizeInput}
                  onChange={(event) => setVlmBatchSizeInput(event.target.value)}
                  className="w-28 rounded-xl border border-slate-300 px-4 py-3 text-slate-900 outline-none focus:border-sky-500"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm text-slate-600">
                {tr("Датасет", "Dataset")}
                <select
                  value={vlmDataset}
                  onChange={(event) => setVlmDataset(event.target.value)}
                  className="w-44 rounded-xl border border-slate-300 px-4 py-3 text-slate-900 outline-none focus:border-sky-500"
                >
                  <option value="all">{tr("Все датасеты", "All datasets")}</option>
                  {availableDatasets.map((dataset) => (
                    <option key={`vlm-${dataset}`} value={dataset}>
                      {dataset}
                    </option>
                  ))}
                </select>
              </label>
          </div>
          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={startVlmBackfill}
              disabled={isStartingVlmJob || vlmSavedFields.length === 0}
              className="rounded-full bg-emerald-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isStartingVlmJob
                ? tr("Запуск...", "Starting...")
                : tr("Запустить разметку VLM", "Start VLM backfill")}
            </button>
            <button
              type="button"
              onClick={onOpenJobsMonitor}
              className="rounded-full border border-slate-300 px-5 py-3 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
            >
              {tr("Перейти в Мониторинг", "Go to Job Monitor")}
            </button>
            <button
              type="button"
              onClick={onOpenStorage}
              className="rounded-full border border-slate-300 px-5 py-3 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
            >
              {tr("Перейти в Хранилище", "Go to Storage")}
            </button>
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
                    {tr("Перейти в Мониторинг", "Go to Job Monitor")}
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

        {showOpenAIBatchBlock && (
          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-5">
              <h2 className="text-2xl font-semibold text-slate-900">
                {tr("API VLM Разметка", "API VLM Annotation")}
              </h2>
              <p className="mt-2 text-sm text-slate-600">
                {tr(
                  "Запуск пакетной JSON-разметки через VLM API. Модель получает один общий prompt и возвращает один JSON-объект на сцену.",
                  "Launch batched JSON labeling through VLM API. The model receives one combined prompt and returns one JSON object per scene."
                )}
              </p>
            </div>

            <div className="mb-4 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
              {tr(
                "Убедитесь, что переменные окружения для API настроены, а контейнеры перезапущены.",
                "Make sure API-specific environment variables are configured and containers are restarted."
              )}{" "}
              {tr("Для OpenAI", "For OpenAI")}: <code>VLM_BACKEND=OPENAI</code> and{" "}
              <code>VLM_OPENAI_API_KEY</code> (or <code>OPENAI_API_KEY</code>).
            </div>

            <div className="mt-1 flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-sm text-slate-600">
                {tr("API провайдер", "API provider")}
                <select
                  value={vlmApiProvider}
                  onChange={(event) => setVlmApiProvider(event.target.value as "openai")}
                  className="w-44 rounded-xl border border-slate-300 px-4 py-3 text-slate-900 outline-none focus:border-sky-500"
                >
                  <option value="openai">OpenAI</option>
                </select>
              </label>
            </div>

            <div className="grid gap-3">
              <label className="flex flex-col gap-1 text-sm text-slate-600">
                {tr("Combined prompt (обязательно)", "Combined prompt (required)")}
                <textarea
                  value={openAiCombinedPromptInput}
                  onChange={(event) => setOpenAiCombinedPromptInput(event.target.value)}
                  rows={8}
                  placeholder={
                    "Return one compact JSON object with these keys only: car_count, has_crosswalk, scene_type.\ncar_count: integer only.\nhas_crosswalk: Yes or No.\nscene_type: one short category.\nNo markdown, no extra keys."
                  }
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-sky-500"
                />
              </label>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={openAiUseJsonSchema}
                  onChange={(event) => setOpenAiUseJsonSchema(event.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                />
                {tr("Использовать custom JSON schema", "Use custom JSON schema")}
              </label>
            </div>

            {openAiUseJsonSchema && (
              <div className="mt-3 grid gap-3">
                <label className="flex flex-col gap-1 text-sm text-slate-600">
                  {tr("Custom JSON schema", "Custom JSON schema")}
                  <textarea
                    value={openAiJsonSchemaInput}
                    onChange={(event) => setOpenAiJsonSchemaInput(event.target.value)}
                    rows={10}
                    placeholder={`{\n  "type": "object",\n  "additionalProperties": false,\n  "required": ["car_count"],\n  "properties": {\n    "car_count": {"type": "integer", "minimum": 0}\n  }\n}`}
                    className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 outline-none focus:border-sky-500"
                  />
                </label>
                <p className="text-xs text-slate-500">
                  {tr(
                    "Если включено, schema JSON должен быть валидным и содержать",
                    "If enabled, schema JSON must be valid and contain"
                  )}{" "}
                  <code>type: object</code> {tr("и", "and")} <code>properties</code>.{" "}
                  {tr(
                    "Если выключено, используется авто-парсинг по умолчанию.",
                    "If disabled, default auto parsing is used."
                  )}
                </p>
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={openAiUseAllSchemaFields}
                  onChange={(event) => setOpenAiUseAllSchemaFields(event.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                />
                {tr("Использовать все сохраненные поля схемы", "Use all saved schema fields")}
              </label>
            </div>

            {!openAiUseAllSchemaFields && (
              <div className="mt-3 grid gap-3">
                <label className="flex flex-col gap-1 text-sm text-slate-600">
                  {tr(
                    "Имена полей (через запятую или с новой строки)",
                    "Field names (comma or newline separated)"
                  )}
                  <textarea
                    value={openAiFieldNamesInput}
                    onChange={(event) => setOpenAiFieldNamesInput(event.target.value)}
                    rows={3}
                    placeholder="car_count, has_crosswalk, scene_type"
                    className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 outline-none focus:border-sky-500"
                  />
                </label>
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-sm text-slate-600">
                {tr("Лимит", "Limit")}
                <input
                  type="number"
                  min={1}
                  value={openAiBackfillLimitInput}
                  onChange={(event) => setOpenAiBackfillLimitInput(event.target.value)}
                  className="w-28 rounded-xl border border-slate-300 px-4 py-3 text-slate-900 outline-none focus:border-sky-500"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm text-slate-600">
                {tr("Размер чанка сцен", "Scene chunk size")}
                <input
                  type="number"
                  min={1}
                  value={openAiBatchSizeInput}
                  onChange={(event) => setOpenAiBatchSizeInput(event.target.value)}
                  className="w-36 rounded-xl border border-slate-300 px-4 py-3 text-slate-900 outline-none focus:border-sky-500"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm text-slate-600">
                {tr("Макс. токенов", "Max tokens")}
                <input
                  type="number"
                  min={1}
                  max={512}
                  value={openAiMaxTokensInput}
                  onChange={(event) => setOpenAiMaxTokensInput(event.target.value)}
                  className="w-32 rounded-xl border border-slate-300 px-4 py-3 text-slate-900 outline-none focus:border-sky-500"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm text-slate-600">
                {tr("Датасет", "Dataset")}
                <select
                  value={openAiDataset}
                  onChange={(event) => setOpenAiDataset(event.target.value)}
                  className="w-44 rounded-xl border border-slate-300 px-4 py-3 text-slate-900 outline-none focus:border-sky-500"
                >
                  <option value="all">{tr("Все датасеты", "All datasets")}</option>
                  {availableDatasets.map((dataset) => (
                    <option key={`openai-${dataset}`} value={dataset}>
                      {dataset}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={openAiOverwriteExisting}
                  onChange={(event) => setOpenAiOverwriteExisting(event.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                />
                {tr("Перезаписывать существующие значения", "Overwrite existing values")}
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={openAiDryRun}
                  onChange={(event) => setOpenAiDryRun(event.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                />
                {tr("Dry run (без записи разметки)", "Dry run (no annotation write)")}
              </label>
            </div>

            <div className="mt-6 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={startOpenAiBatchBackfill}
                disabled={isStartingOpenAiBatchJob}
                className="rounded-full bg-indigo-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isStartingOpenAiBatchJob
                  ? tr("Запуск...", "Starting...")
                  : tr("Запустить API Batch backfill", "Start API Batch backfill")}
              </button>
              <button
                type="button"
                onClick={onOpenJobsMonitor}
                className="rounded-full border border-slate-300 px-5 py-3 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
              >
                {tr("Перейти в Мониторинг", "Go to Job Monitor")}
              </button>
            </div>

            {openAiBatchStatusMessage && (
              <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800">
                <span>{openAiBatchStatusMessage}</span>
                {showOpenAiBatchJobsLink && (
                  <>
                    {" "}
                    <button
                      type="button"
                      onClick={onOpenJobsMonitor}
                      className="font-bold text-teal-600 underline decoration-teal-500 underline-offset-2 transition hover:text-teal-700"
                    >
                      {tr("Перейти в Мониторинг", "Go to Job Monitor")}
                    </button>
                  </>
                )}
              </div>
            )}

            {openAiBatchWarningMessage && (
              <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
                {openAiBatchWarningMessage}
              </div>
            )}

            {openAiBatchErrorMessage && (
              <div className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">
                {openAiBatchErrorMessage}
              </div>
            )}
          </div>
        )}

        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="mb-5 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-2xl font-semibold text-slate-900">
                {tr("Схема полей VLM", "VLM Fields Schema")}
              </h2>
              <p className="mt-2 text-sm text-slate-600">
                {tr(
                  "Настройте VLM-поля прямо в этой вкладке и запускайте джобы анализа.",
                  "Configure VLM fields directly from this tab and run analysis jobs."
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setIsVlmSchemaCollapsed((current) => !current)}
              className="rounded-full border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-100"
            >
              {isVlmSchemaCollapsed ? tr("Развернуть", "Expand") : tr("Свернуть", "Collapse")}
            </button>
          </div>

          {!isVlmSchemaCollapsed && (
            <>
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
                      className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none focus:border-sky-500"
                    />
                    <textarea
                      value={field.prompt}
                      onChange={(event) =>
                        updateVlmDraftField(field.id, "prompt", event.target.value)
                      }
                      placeholder={tr(
                        "Пример: Есть ли пешеходный переход перед эго-автомобилем?",
                        "Example: Is there a pedestrian crossing in front of the ego vehicle?"
                      )}
                      rows={3}
                      className="rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none focus:border-sky-500"
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
                      className="ui-select-rounded rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none focus:border-sky-500"
                    >
                      {responseTypeOptions.map((option) => (
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
                      {tr("Удалить", "Remove")}
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
                  {tr("Добавить поле", "Add field")}
                </button>
                <button
                  type="button"
                  onClick={saveVlmSchema}
                  disabled={isSavingVlmSchema}
                  className="rounded-full bg-sky-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isSavingVlmSchema
                    ? tr("Сохраняем...", "Saving...")
                    : tr("Сохранить схему", "Save schema")}
                </button>
              </div>
              {vlmSchemaStatusMessage && (
                <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800">
                  {vlmSchemaStatusMessage}
                </div>
              )}
            </>
          )}
        </div>

        {waymoAuthModalOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            onClick={() => {
              setWaymoAuthModalOpen(false);
              setWaymoAuthError(null);
            }}
          >
            <div
              className="w-full max-w-2xl overflow-hidden rounded-xl bg-white shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="border-b border-slate-200 px-5 py-4">
                <div className="text-base font-semibold text-slate-900">
                  {tr("Авторизация доступа к Waymo", "Waymo Access Authorization")}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  {tr(
                    "Требуется `gcloud auth application-default login` для чтения датасета.",
                    "`gcloud auth application-default login` is required to read this dataset."
                  )}
                </div>
              </div>
              <div className="space-y-4 px-5 py-4">
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                  {tr("1. Откройте ссылку ниже и войдите в Google-аккаунт.", "1. Open the link below and sign in to your Google account.")}
                  <br />
                  {tr("2. Скопируйте код подтверждения.", "2. Copy the verification code.")}
                  <br />
                  {tr("3. Вставьте код и нажмите `Подтвердить код`.", "3. Paste the code and click `Confirm code`.")}
                </div>

                <div>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {tr("Ссылка авторизации", "Authorization link")}
                  </div>
                  {waymoAuthUrl ? (
                    <a
                      href={waymoAuthUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="block break-all rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700 hover:bg-blue-100"
                    >
                      {waymoAuthUrl}
                    </a>
                  ) : (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                      {tr(
                        "Ссылка пока не получена. Нажмите «Обновить ссылку».",
                        "Link is not available yet. Click Refresh link."
                      )}
                    </div>
                  )}
                </div>

                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {tr("Код подтверждения", "Verification code")}
                  </label>
                  <input
                    type="text"
                    value={waymoAuthCode}
                    onChange={(event) => setWaymoAuthCode(event.target.value)}
                    placeholder={tr("Вставьте код из Google", "Paste code from Google")}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm text-slate-900 outline-none ring-0 transition focus:border-indigo-500"
                  />
                </div>

                {waymoAuthError && (
                  <pre className="whitespace-pre-wrap rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
                    {waymoAuthError}
                  </pre>
                )}
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 px-5 py-4">
                <button
                  type="button"
                  onClick={() => {
                    setWaymoAuthModalOpen(false);
                    setWaymoAuthError(null);
                  }}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
                >
                  {tr("Закрыть", "Close")}
                </button>
                <button
                  type="button"
                  onClick={fetchWaymoAuthLink}
                  disabled={waymoAuthBusy}
                  className="rounded-lg border border-indigo-300 px-3 py-2 text-sm font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-60"
                >
                  {waymoAuthBusy ? tr("Загрузка...", "Loading...") : tr("Обновить ссылку", "Refresh link")}
                </button>
                <button
                  type="button"
                  onClick={submitWaymoAuthCode}
                  disabled={waymoAuthBusy}
                  className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
                >
                  {waymoAuthBusy ? tr("Проверка...", "Checking...") : tr("Подтвердить код", "Confirm code")}
                </button>
              </div>
            </div>
          </div>
        )}

        {schemaDeleteDialog && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
            <div className="w-full max-w-xl rounded-xl bg-white shadow-2xl">
              <div className="border-b border-slate-200 px-5 py-4">
                <div className="text-base font-semibold text-slate-900">
                  {tr(
                    "Удалить поле из схемы полей VLM?",
                    "Delete a field from VLM Fields Schema?"
                  )}
                </div>
              </div>
              <div className="px-5 py-4 text-sm text-slate-700">
                <div>
                  {tr(
                    "Будут удалены столбцы и сохраненные значения в аннотациях:",
                    "Columns and saved annotation values will be removed:"
                  )}
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
                  {tr("Отмена", "Cancel")}
                </button>
                <button
                  type="button"
                  onClick={() => persistVlmSchema(schemaDeleteDialog.fields, true)}
                  disabled={isSavingVlmSchema}
                  className="rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60"
                >
                  {tr("Подтвердить удаление", "Confirm deletion")}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
