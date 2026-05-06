"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";

interface AnnotationPanelProps {
  onOpenJobsMonitor: () => void;
  onOpenStorage: () => void;
  showSyntheticMethod?: boolean;
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
  default_config?: Record<string, unknown>;
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

export default function AnnotationPanel({
  onOpenJobsMonitor,
  onOpenStorage,
  showSyntheticMethod = true,
}: AnnotationPanelProps) {
  const localUploadFileInputRef = useRef<HTMLInputElement | null>(null);
  const [limit, setLimit] = useState(1000);
  const [batchSize, setBatchSize] = useState(50);
  const [stopOnError, setStopOnError] = useState(false);
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
  const [vlmBackfillLimit, setVlmBackfillLimit] = useState(200);
  const [vlmMaxNewTokens, setVlmMaxNewTokens] = useState(64);
  const [isSavingVlmSchema, setIsSavingVlmSchema] = useState(false);
  const [isStartingVlmJob, setIsStartingVlmJob] = useState(false);
  const [schemaDeleteDialog, setSchemaDeleteDialog] = useState<{
    fields: Array<{ name: string; prompt: string; response_type: ResponseType }>;
    removedFieldNames: string[];
  } | null>(null);
  const [vlmStatusMessage, setVlmStatusMessage] = useState<string | null>(null);
  const [vlmWarningMessage, setVlmWarningMessage] = useState<string | null>(null);
  const [vlmErrorMessage, setVlmErrorMessage] = useState<string | null>(null);
  const [showVlmJobsLink, setShowVlmJobsLink] = useState(false);
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
              : "Failed to load VLM schema";
        setVlmErrorMessage(message);
      }
    };
    loadSchema();
  }, []);

  useEffect(() => {
    const loadDatasets = async () => {
      try {
        const response = await axios.get("/api/storage/stats", {
          params: { include_storage_details: 0 },
        });
        const rows = Array.isArray(response.data?.datasets?.rows_distribution)
          ? response.data.datasets.rows_distribution
          : [];
        const datasetNames: string[] = rows
          .map((item: any) => String(item?.dataset || "").trim())
          .filter((name: string): name is string => Boolean(name));
        const unique = Array.from(new Set<string>(datasetNames)).sort((a, b) =>
          a.localeCompare(b)
        );
        setAvailableDatasets(unique);
      } catch {
        setAvailableDatasets([]);
      }
    };
    loadDatasets();
  }, []);

  useEffect(() => {
    const loadPreprocessorMethods = async () => {
      try {
        const response = await axios.get("/api/storage/preprocessors");
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
      } catch (error: unknown) {
        const message =
          axios.isAxiosError(error) && error.response?.data?.detail
            ? String(error.response.data.detail)
            : axios.isAxiosError(error) && error.response?.data?.error
              ? String(error.response.data.error)
              : error instanceof Error
                ? error.message
                : "Failed to load preprocessor methods from storage API. Check storage-server logs for YAML/config parse errors.";
        setPreprocessorMethods([]);
        setInstallDatasets({});
        setDatasetConfigText({});
        setPreprocessorMethodsError(message);
      }
    };
    loadPreprocessorMethods();
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
        dataset: embeddingDataset === "all" ? null : embeddingDataset,
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
      setVlmSchemaStatusMessage(null);
      setVlmStatusMessage(null);
      setVlmWarningMessage(null);
      setShowVlmJobsLink(false);
      setVlmErrorMessage("Add at least one field with a prompt.");
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
      setVlmSchemaStatusMessage("VLM schema saved.");
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
        dataset: vlmDataset === "all" ? null : vlmDataset,
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

  const fetchWaymoAuthLink = async () => {
    try {
      setWaymoAuthBusy(true);
      setWaymoAuthError(null);
      const response = await axios.post<WaymoAuthStartResponse>("/api/waymo/auth/start", {});
      const payload = response.data || {};
      const sessionId = String(payload.session_id || "").trim();
      const authUrl = String(payload.auth_url || "").trim();
      if (!sessionId) {
        throw new Error("Не удалось создать сессию авторизации Waymo.");
      }
      setWaymoAuthSessionId(sessionId);
      setWaymoAuthUrl(authUrl || null);
      if (!authUrl) {
        setWaymoAuthError(
          "Ссылка авторизации пока не получена. Нажмите «Обновить ссылку» через несколько секунд."
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
              : "Не удалось запустить авторизацию Waymo.";
      setWaymoAuthError(message);
    } finally {
      setWaymoAuthBusy(false);
    }
  };

  const submitWaymoAuthCode = async () => {
    if (!waymoAuthSessionId) {
      setWaymoAuthError("Сначала получите ссылку авторизации.");
      return;
    }
    const code = waymoAuthCode.trim();
    if (!code) {
      setWaymoAuthError("Введите код авторизации.");
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
      setWaymoAuthSuccess(message || "Авторизация Google ADC выполнена.");
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
          `${String(payload.message || "Ошибка авторизации")}\n\n${(payload.logs_tail || []).join("\n")}`
        );
      } else if (typeof detail === "string") {
        setWaymoAuthError(detail);
      } else {
        const message =
          error instanceof Error ? error.message : "Не удалось завершить авторизацию.";
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
          ? `Installation jobs started: ${jobsInfo}.`
          : "Installation request sent."
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
              : "Failed to start dataset installation";
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

    if (selectedDatasets.includes("waymo")) {
      try {
        const response = await axios.get<WaymoAuthStatusResponse>("/api/waymo/auth/status");
        const authenticated = Boolean(response.data?.authenticated);
        if (!authenticated) {
          setInstallStatusMessage(null);
          setShowInstallJobsLink(false);
          setInstallErrorMessage(null);
          setInstallStatusMessage(
            "Для установки Waymo нужна авторизация Google ADC. Завершите авторизацию в окне ниже, установка запустится автоматически."
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
                : "Не удалось проверить авторизацию Waymo.";
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

  const handleLocalImageSelected = (event: any) => {
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
      setLocalUploadError("Choose an image file first.");
      return;
    }
    const bucket = localUploadForm.bucket.trim();
    if (!bucket) {
      setLocalUploadError("Bucket is required.");
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
      const summary = `Local image uploaded: ${objectId || "n/a"}${
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
              : "Failed to upload local image";
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
              Dataset Installation
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              Select available preprocessors from storage API, edit config JSON,
              and start installation jobs.
              Each dataset runs as a separate job in Job Monitor.
            </p>
          </div>

          {preprocessorMethodsError && (
            <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">
              {preprocessorMethodsError}
            </div>
          )}

          {!preprocessorMethodsError && visiblePreprocessorMethods.length === 0 && (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
              No preprocessor methods were returned by storage API.
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
                <div className="mb-2 text-sm font-semibold text-slate-800">Config (JSON)</div>
                {option.description && (
                  <div className="mb-2 text-xs text-slate-500">{option.description}</div>
                )}
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
              {isStartingInstall ? "Starting..." : "Start dataset installation"}
            </button>
            <button
              type="button"
              onClick={onOpenJobsMonitor}
              className="rounded-full border border-slate-300 px-5 py-3 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
            >
              Open Job Monitor
            </button>
            <button
              type="button"
              onClick={openLocalUploadDialog}
              className="inline-flex items-center gap-2 rounded-full border border-slate-300 px-4 py-3 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
              title="Upload local image"
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
                    Go to Job Monitor
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
                    Открыть авторизацию Waymo
                  </button>
                </>
              )}
            </div>
          )}

          {waymoAuthSuccess && (
            <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800">
              {waymoAuthSuccess}. Теперь снова нажмите Start dataset installation.
            </div>
          )}
        </div>

        {localUploadModalOpen && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/45 px-4">
            <div className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
              <div className="mb-4">
                <h3 className="text-lg font-semibold text-slate-900">Upload Local Image</h3>
                <p className="mt-1 text-sm text-slate-600">
                  Set storage parameters for selected file:{" "}
                  <span className="font-semibold">{localUploadFile?.name || "unknown"}</span>
                </p>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <label className="flex flex-col gap-1 text-sm text-slate-600">
                  Bucket
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
                  Camera
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
                  Dataset type
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
                  Timestamp (optional)
                  <input
                    value={localUploadForm.timestamp}
                    onChange={(event) =>
                      setLocalUploadForm((current) => ({
                        ...current,
                        timestamp: event.target.value,
                      }))
                    }
                    placeholder="e.g. 1714637835123"
                    className="rounded-xl border border-slate-300 px-3 py-2 text-slate-900 outline-none focus:border-sky-500"
                  />
                </label>
              </div>

              <div className="mt-3 grid gap-3">
                <label className="flex flex-col gap-1 text-sm text-slate-600">
                  Storage key (optional override)
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
                  Source link (optional)
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
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={submitLocalImageUpload}
                  disabled={isUploadingLocalImage}
                  className="rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isUploadingLocalImage ? "Uploading..." : "Upload"}
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

            <label className="flex flex-col gap-1 text-sm text-slate-600">
              Dataset
              <select
                value={embeddingDataset}
                onChange={(event) => setEmbeddingDataset(event.target.value)}
                className="rounded-xl border border-slate-300 px-4 py-3 text-slate-900 outline-none focus:border-sky-500"
              >
                <option value="all">All datasets</option>
                {availableDatasets.map((dataset) => (
                  <option key={`embed-${dataset}`} value={dataset}>
                    {dataset}
                  </option>
                ))}
              </select>
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
            <button
              type="button"
              onClick={onOpenStorage}
              className="rounded-full border border-slate-300 px-5 py-3 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
            >
              Go to Storage
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
          {vlmSchemaStatusMessage && (
            <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800">
              {vlmSchemaStatusMessage}
            </div>
          )}
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="mb-5">
            <h2 className="text-2xl font-semibold text-slate-900">
              VLM Annotation
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              Start a background job that computes and saves VLM annotations for
              scenes in the annotation storage.
            </p>
          </div>
          <div className="mb-6 flex flex-wrap items-end gap-3">
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
              <label className="flex flex-col gap-1 text-sm text-slate-600">
                Dataset
                <select
                  value={vlmDataset}
                  onChange={(event) => setVlmDataset(event.target.value)}
                  className="w-44 rounded-xl border border-slate-300 px-4 py-3 text-slate-900 outline-none focus:border-sky-500"
                >
                  <option value="all">All datasets</option>
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
              {isStartingVlmJob ? "Starting..." : "Start VLM backfill"}
            </button>
            <button
              type="button"
              onClick={onOpenJobsMonitor}
              className="rounded-full border border-slate-300 px-5 py-3 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
            >
              Go to Job Monitor
            </button>
            <button
              type="button"
              onClick={onOpenStorage}
              className="rounded-full border border-slate-300 px-5 py-3 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
            >
              Go to Storage
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

        {waymoAuthModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-2xl overflow-hidden rounded-xl bg-white shadow-2xl">
              <div className="border-b border-slate-200 px-5 py-4">
                <div className="text-base font-semibold text-slate-900">
                  Авторизация доступа к Waymo
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  Требуется `gcloud auth application-default login` для чтения датасета.
                </div>
              </div>
              <div className="space-y-4 px-5 py-4">
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                  1. Откройте ссылку ниже и войдите в Google-аккаунт.
                  <br />
                  2. Скопируйте код подтверждения.
                  <br />
                  3. Вставьте код и нажмите `Подтвердить код`.
                </div>

                <div>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Ссылка авторизации
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
                      Ссылка пока не получена. Нажмите «Обновить ссылку».
                    </div>
                  )}
                </div>

                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Код подтверждения
                  </label>
                  <input
                    type="text"
                    value={waymoAuthCode}
                    onChange={(event) => setWaymoAuthCode(event.target.value)}
                    placeholder="Вставьте код из Google"
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
                  Закрыть
                </button>
                <button
                  type="button"
                  onClick={fetchWaymoAuthLink}
                  disabled={waymoAuthBusy}
                  className="rounded-lg border border-indigo-300 px-3 py-2 text-sm font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-60"
                >
                  {waymoAuthBusy ? "Загрузка..." : "Обновить ссылку"}
                </button>
                <button
                  type="button"
                  onClick={submitWaymoAuthCode}
                  disabled={waymoAuthBusy}
                  className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
                >
                  {waymoAuthBusy ? "Проверка..." : "Подтвердить код"}
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
                  onClick={() => persistVlmSchema(schemaDeleteDialog.fields, true)}
                  disabled={isSavingVlmSchema}
                  className="rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60"
                >
                  Подтвердить удаление
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
