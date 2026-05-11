"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import axios from "axios";
import { Cog6ToothIcon } from "@heroicons/react/24/outline";
import {
  SEARCH_MODE_STORAGE_KEY,
  type SearchMode,
} from "../lib/searchMode";

import SearchBar from "../components/SearchBar";
import ImageGallery from "../components/ImageGallery";
import TransferToast from "../components/TransferToast";

interface ImageResult {
  id: string;
  title: string;
  url: string;
  score?: number | null;
  object_id?: string;
  storage_path?: string;
  storage_url?: string;
}

interface UISettings {
  showSnapshotSection: boolean;
  showStorageVlmFieldAnalytics: boolean;
  showSyntheticInAnnotation: boolean;
  showSearchMeta: boolean;
  showJobMonitorModels: boolean;
  showJobMonitorGpu: boolean;
}

interface SearchWarningPayload {
  code?: string;
  source?: string;
  query_dim?: number;
  stored_dim?: number;
  message?: string;
}

interface EmbeddingMismatchDialogState {
  queryDim: number;
  storedDim: number;
  message: string;
}

const IMAGES_PER_PAGE_OPTIONS = [6, 9, 12, 18, 24];
const SEARCH_MODE_COOKIE_KEY = SEARCH_MODE_STORAGE_KEY;
const UI_SETTINGS_STORAGE_KEY = "avsp_ui_settings_v1";
const SEARCH_MODE_TABS: Array<{ mode: SearchMode; label: string }> = [
  { mode: "STORAGE", label: "STORAGE" },
  { mode: "VLM", label: "VLM" },
  { mode: "Browser", label: "BROWSER" },
  { mode: "ANNOTATION", label: "ANNOTATION" },
  { mode: "Job Monitor", label: "JOB MONITOR" },
];

const DEFAULT_UI_SETTINGS: UISettings = {
  showSnapshotSection: true,
  showStorageVlmFieldAnalytics: false,
  showSyntheticInAnnotation: false,
  showSearchMeta: false,
  showJobMonitorModels: true,
  showJobMonitorGpu: false,
};

function centeredPanelLoader(text: string) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-8 text-center text-sm text-gray-500">
      {text}
    </div>
  );
}

const SystemMonitor = dynamic(() => import("../components/SystemMonitor"), {
  ssr: false,
  loading: () => centeredPanelLoader("Loading Job Monitor..."),
});
const VlmPanel = dynamic(() => import("../components/VlmPanel"), {
  ssr: false,
  loading: () => centeredPanelLoader("Loading VLM..."),
});
const AnnotationPanel = dynamic(() => import("../components/AnnotationPanel"), {
  ssr: false,
  loading: () => centeredPanelLoader("Loading Annotation..."),
});
const StoragePanel = dynamic(() => import("../components/StoragePanel"), {
  ssr: false,
  loading: () => centeredPanelLoader("Loading Storage..."),
});

function parseStoragePathMeta(storagePath?: string): {
  dataset: string;
  key: string;
} {
  const raw = String(storagePath || "").trim();
  if (!raw) return { dataset: "", key: "" };
  const normalized = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^\/+/, "");
  if (!normalized.includes("/")) {
    return { dataset: normalized, key: "" };
  }
  const [dataset, ...rest] = normalized.split("/");
  return { dataset, key: rest.join("/") };
}

function formatBrowserResultTitle(item: ImageResult, showMeta: boolean): string {
  if (!showMeta) {
    return item.object_id || item.title || item.storage_path || item.url || "";
  }
  const { dataset, key } = parseStoragePathMeta(item.storage_path);
  const lines = [
    item.object_id ? `object_id: ${item.object_id}` : "",
    dataset ? `dataset: ${dataset}` : "",
    key ? `key: ${key}` : "",
    item.storage_path ? `storage_path: ${item.storage_path}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

function IOSSwitch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-7 w-12 min-w-12 shrink-0 items-center rounded-full transition-colors duration-200 ${
        checked ? "bg-emerald-500" : "bg-slate-300"
      }`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform duration-200 ${
          checked ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  );
}

export default function HomePageClient({
  initialSearchMode,
}: {
  initialSearchMode: SearchMode;
}) {
  const [searchMode, setSearchMode] = useState<SearchMode>(initialSearchMode);
  const [images, setImages] = useState<ImageResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [searchWarningMessage, setSearchWarningMessage] = useState<string | null>(null);
  const [sourceWarning, setSourceWarning] = useState<string | null>(null);
  const [lastQuery, setLastQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [imagesPerPage, setImagesPerPage] = useState(9);
  const [browserQueryDraft, setBrowserQueryDraft] = useState("");
  const [browserImageDraft, setBrowserImageDraft] = useState<File | null>(null);
  const [minScoreInput, setMinScoreInput] = useState("0.1");
  const [maxScoreInput, setMaxScoreInput] = useState("");
  const [uiSettings, setUiSettings] = useState<UISettings>(DEFAULT_UI_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [embeddingMismatchDialog, setEmbeddingMismatchDialog] =
    useState<EmbeddingMismatchDialogState | null>(null);
  const [isRebuildingEmbeddings, setIsRebuildingEmbeddings] = useState(false);
  const settingsPopoverRef = useRef<HTMLDivElement | null>(null);

  const minScore = minScoreInput.trim() === "" ? null : Number(minScoreInput);
  const maxScore = maxScoreInput.trim() === "" ? null : Number(maxScoreInput);
  const hasValidMinScore = minScore !== null && Number.isFinite(minScore);
  const hasValidMaxScore = maxScore !== null && Number.isFinite(maxScore);
  const hasScoreFilter = hasValidMinScore || hasValidMaxScore;

  const presentedImages = useMemo(
    () =>
      images.map((item) => ({
        ...item,
        title: formatBrowserResultTitle(item, uiSettings.showSearchMeta),
      })),
    [images, uiSettings.showSearchMeta]
  );

  const filteredImages = useMemo(() => {
    if (!hasScoreFilter) {
      return presentedImages;
    }

    return presentedImages.filter((item) => {
      if (typeof item.score !== "number" || !Number.isFinite(item.score)) {
        return false;
      }
      if (hasValidMinScore && item.score < (minScore as number)) {
        return false;
      }
      if (hasValidMaxScore && item.score > (maxScore as number)) {
        return false;
      }
      return true;
    });
  }, [
    hasScoreFilter,
    hasValidMaxScore,
    hasValidMinScore,
    maxScore,
    minScore,
    presentedImages,
  ]);

  const totalPages = Math.max(1, Math.ceil(filteredImages.length / imagesPerPage));
  const pageStart = (currentPage - 1) * imagesPerPage;
  const paginatedImages = filteredImages.slice(pageStart, pageStart + imagesPerPage);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  useEffect(() => {
    setCurrentPage(1);
  }, [minScoreInput, maxScoreInput]);

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
    window.localStorage.setItem(SEARCH_MODE_STORAGE_KEY, searchMode);
    document.cookie = `${SEARCH_MODE_COOKIE_KEY}=${encodeURIComponent(searchMode)}; path=/; max-age=31536000; samesite=lax`;
  }, [searchMode]);

  useEffect(() => {
    const loadSettings = async () => {
      let gpuAvailableByDefault = false;
      try {
        const systemInfo = await axios.get("/api/system-info");
        const gpuPayload = systemInfo.data?.gpu;
        const hasGpuList = Array.isArray(gpuPayload?.gpus) && gpuPayload.gpus.length > 0;
        const hasNoGpuError = typeof gpuPayload?.error !== "string" || gpuPayload.error.trim() === "";
        gpuAvailableByDefault = Boolean(gpuPayload?.available && hasGpuList && hasNoGpuError);
      } catch {
        gpuAvailableByDefault = false;
      }

      try {
        const raw = window.localStorage.getItem(UI_SETTINGS_STORAGE_KEY);
        if (!raw) {
          setUiSettings({
            ...DEFAULT_UI_SETTINGS,
            showJobMonitorGpu: gpuAvailableByDefault,
          });
          return;
        }
        const parsed = JSON.parse(raw) as Partial<UISettings> & { showJobMonitorRuntime?: boolean };
        const legacyRuntimeToggle =
          typeof parsed?.showJobMonitorRuntime === "boolean"
            ? parsed.showJobMonitorRuntime
            : undefined;

        setUiSettings({
          showSnapshotSection:
            typeof parsed?.showSnapshotSection === "boolean"
              ? parsed.showSnapshotSection
              : DEFAULT_UI_SETTINGS.showSnapshotSection,
          showStorageVlmFieldAnalytics:
            typeof parsed?.showStorageVlmFieldAnalytics === "boolean"
              ? parsed.showStorageVlmFieldAnalytics
              : DEFAULT_UI_SETTINGS.showStorageVlmFieldAnalytics,
          showSyntheticInAnnotation:
            typeof parsed?.showSyntheticInAnnotation === "boolean"
              ? parsed.showSyntheticInAnnotation
              : DEFAULT_UI_SETTINGS.showSyntheticInAnnotation,
          showSearchMeta:
            typeof parsed?.showSearchMeta === "boolean"
              ? parsed.showSearchMeta
              : DEFAULT_UI_SETTINGS.showSearchMeta,
          showJobMonitorModels:
            typeof parsed?.showJobMonitorModels === "boolean"
              ? parsed.showJobMonitorModels
              : legacyRuntimeToggle ?? DEFAULT_UI_SETTINGS.showJobMonitorModels,
          showJobMonitorGpu:
            typeof parsed?.showJobMonitorGpu === "boolean"
              ? parsed.showJobMonitorGpu
              : legacyRuntimeToggle ?? gpuAvailableByDefault,
        });
      } catch {
        setUiSettings({
          ...DEFAULT_UI_SETTINGS,
          showJobMonitorGpu: gpuAvailableByDefault,
        });
      }
    };
    loadSettings();
  }, []);

  useEffect(() => {
    window.localStorage.setItem(UI_SETTINGS_STORAGE_KEY, JSON.stringify(uiSettings));
  }, [uiSettings]);

  useEffect(() => {
    if (!settingsOpen) return;
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const root = settingsPopoverRef.current;
      const target = event.target as Node | null;
      if (!root || !target) return;
      if (!root.contains(target)) {
        setSettingsOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
    };
  }, [settingsOpen]);

  const runSearch = async ({
    query,
    imageFile,
  }: {
    query: string;
    imageFile: File | null;
  }) => {
    const cleanedQuery = query.trim();
    if (!cleanedQuery && !imageFile) {
      setImages([]);
      setLastQuery("");
      setErrorMessage(null);
      setCurrentPage(1);
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);
    setSearchWarningMessage(null);
    setLastQuery(cleanedQuery || (imageFile ? "image search" : ""));
    try {
      const response = imageFile
        ? await axios.post("/api/search?limit=100", imageFile, {
            headers: {
              "Content-Type": imageFile.type || "application/octet-stream",
            },
          })
        : await axios.get("/api/search", {
            params: { q: cleanedQuery, limit: 100 },
          });
      const payload = response.data;
      const items = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.items)
          ? payload.items
          : [];
      const warning =
        !Array.isArray(payload) && payload?.warning && typeof payload.warning === "object"
          ? (payload.warning as SearchWarningPayload)
          : null;
      if (warning?.code === "embedding_dim_mismatch") {
        const queryDim = Number(warning.query_dim || 0);
        const storedDim = Number(warning.stored_dim || 0);
        const warningMessage =
          queryDim > 0 && storedDim > 0
            ? `Размерность нового embedder (${queryDim}) не совпадает с текущей разметкой storage (${storedDim}). Поиск будет возвращать пустой результат, пока не пересоздать embeddings.`
            : "Размерность нового embedder не совпадает с текущей разметкой storage. Поиск может возвращать пустой результат.";
        setSearchWarningMessage(warningMessage);
        setEmbeddingMismatchDialog({
          queryDim,
          storedDim,
          message: warningMessage,
        });
      } else if (warning?.code === "model_unavailable" || warning?.code === "search_backend_unavailable") {
        const warningMessage =
          typeof warning.message === "string" && warning.message.trim().length > 0
            ? warning.message.trim()
            : "Search backend недоступен. Дождитесь запуска модели.";
        setSearchWarningMessage(warningMessage);
      }
      setImages(items);
      setCurrentPage(1);
    } catch (error) {
      const message = axios.isAxiosError(error)
        ? error.response?.data?.error || error.message
        : error instanceof Error
          ? error.message
          : "Не удалось выполнить поиск";
      setErrorMessage(message);
      setSearchWarningMessage(null);
      setImages([]);
      setCurrentPage(1);
    } finally {
      setIsLoading(false);
    }
  };

  const rebuildEmbeddingsAndStartBackfill = async () => {
    try {
      setIsRebuildingEmbeddings(true);
      setErrorMessage(null);

      let limit = 1_000_000;
      try {
        const statsResponse = await axios.get("/api/storage/stats", {
          params: { include_storage_details: 0 },
        });
        const pendingRows = Number(statsResponse.data?.embeddings?.pending_rows ?? 0);
        if (Number.isFinite(pendingRows) && pendingRows > 0) {
          limit = Math.max(1000, Math.floor(pendingRows));
        }
      } catch {
        // Keep fallback limit when stats request is unavailable.
      }

      const resetResponse = await axios.post("/api/storage/clear-embeddings", {
        confirm: true,
        page_size: 1000,
      });
      const resetEmbeddings = Number(resetResponse.data?.reset_embeddings || 0);

      const backfillResponse = await axios.post("/api/backfill", {
        limit,
        batch_size: 50,
        stop_on_error: false,
        dry_run: false,
      });

      setEmbeddingMismatchDialog(null);
      setSearchWarningMessage(
        `Embeddings reset: ${resetEmbeddings}. Backfill job started: ${String(
          backfillResponse.data?.job_id || ""
        )}.`
      );
      setSearchMode("Job Monitor");
    } catch (error) {
      const message = axios.isAxiosError(error)
        ? error.response?.data?.error || error.message
        : error instanceof Error
          ? error.message
          : "Не удалось пересоздать embeddings";
      setErrorMessage(message);
    } finally {
      setIsRebuildingEmbeddings(false);
    }
  };

  const handleSearch = (payload: { query: string; imageFile: File | null }) =>
    runSearch(payload);

  const handleExportCsv = () => {
    if (filteredImages.length === 0) return;

    const escapeCsv = (value: unknown): string => {
      const raw = value === null || value === undefined ? "" : String(value);
      if (raw.includes('"') || raw.includes(",") || raw.includes("\n")) {
        return `"${raw.replace(/"/g, '""')}"`;
      }
      return raw;
    };

    const headers = [
      "id",
      "object_id",
      "title",
      "url",
      "storage_path",
      "storage_url",
      "score",
    ];
    const rows = filteredImages.map((item) => [
      item.id,
      item.object_id ?? "",
      item.title,
      item.url,
      item.storage_path ?? "",
      item.storage_url ?? "",
      item.score ?? "",
    ]);

    const csv = [headers, ...rows]
      .map((row) => row.map((cell) => escapeCsv(cell)).join(","))
      .join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const href = URL.createObjectURL(blob);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const link = document.createElement("a");
    link.href = href;
    link.download = `browser-search-${timestamp}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(href);
  };

  const openTransferSnapshotSection = () => {
    setSearchMode("STORAGE");
    if (typeof window === "undefined") {
      return;
    }
    let attempts = 0;
    const scrollToSection = () => {
      const section = document.getElementById("transfer-snapshot-section");
      if (section) {
        section.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      attempts += 1;
      if (attempts < 12) {
        setTimeout(scrollToSection, 120);
      }
    };
    setTimeout(scrollToSection, 80);
  };

  return (
    <main className="min-h-screen overflow-x-hidden bg-gray-100">
      <div className="fixed right-3 top-3 z-[70] sm:right-4 sm:top-4">
        <div ref={settingsPopoverRef} className="relative">
          <button
            type="button"
            onClick={() => setSettingsOpen((value) => !value)}
            className="group rounded-full border border-slate-300 bg-white p-2.5 text-slate-700 shadow-md transition hover:bg-slate-50"
            aria-label="Open settings"
          >
            <Cog6ToothIcon className="h-6 w-6 transition-transform duration-500 group-hover:rotate-180" />
          </button>
          {settingsOpen && (
            <div className="absolute right-0 mt-3 w-[min(22rem,calc(100vw-1.5rem))] rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl">
              <div className="mb-3 text-sm font-semibold text-slate-900">Interface Settings</div>
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-slate-800">Show Snapshot Section</div>
                    <div className="text-xs text-slate-500">Storage tab transfer block</div>
                  </div>
                  <IOSSwitch
                    checked={uiSettings.showSnapshotSection}
                    onChange={(next) =>
                      setUiSettings((prev) => ({ ...prev, showSnapshotSection: next }))
                    }
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-slate-800">Show Job Monitor Models</div>
                    <div className="text-xs text-slate-500">Model runtime block</div>
                  </div>
                  <IOSSwitch
                    checked={uiSettings.showJobMonitorModels}
                    onChange={(next) =>
                      setUiSettings((prev) => ({
                        ...prev,
                        showJobMonitorModels: next,
                      }))
                    }
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-slate-800">Show Job Monitor GPU</div>
                    <div className="text-xs text-slate-500">GPU host block</div>
                  </div>
                  <IOSSwitch
                    checked={uiSettings.showJobMonitorGpu}
                    onChange={(next) =>
                      setUiSettings((prev) => ({ ...prev, showJobMonitorGpu: next }))
                    }
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-slate-800">Detailed VLM Analytics</div>
                    <div className="text-xs text-slate-500">
                      Storage: per-field valid/fallback/missing breakdown
                    </div>
                  </div>
                  <IOSSwitch
                    checked={uiSettings.showStorageVlmFieldAnalytics}
                    onChange={(next) =>
                      setUiSettings((prev) => ({
                        ...prev,
                        showStorageVlmFieldAnalytics: next,
                      }))
                    }
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-slate-800">Show Search Metadata</div>
                    <div className="text-xs text-slate-500">Dataset and storage info in result titles</div>
                  </div>
                  <IOSSwitch
                    checked={uiSettings.showSearchMeta}
                    onChange={(next) =>
                      setUiSettings((prev) => ({ ...prev, showSearchMeta: next }))
                    }
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-slate-800">Show Synthetic Dataset</div>
                    <div className="text-xs text-slate-500">In annotation preprocessor list</div>
                  </div>
                  <IOSSwitch
                    checked={uiSettings.showSyntheticInAnnotation}
                    onChange={(next) =>
                      setUiSettings((prev) => ({
                        ...prev,
                        showSyntheticInAnnotation: next,
                      }))
                    }
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <section className="bg-white border-b border-gray-200 shadow-sm">
        <div className="mx-auto max-w-5xl px-2 sm:px-6">
          <div className="hide-scrollbar flex items-center gap-1 overflow-x-auto py-3 sm:justify-center sm:gap-2 sm:py-6">
            {SEARCH_MODE_TABS.map((tab) => (
              <button
                key={tab.mode}
                onClick={() => setSearchMode(tab.mode)}
                className={`shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-xl font-black tracking-wide font-bebas transition-all duration-200 sm:px-6 sm:py-3 sm:text-3xl ${
                  searchMode === tab.mode
                    ? "border-blue-600 bg-blue-50 text-blue-600"
                    : "border-transparent text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {searchMode === "Job Monitor" ? (
        <section className="px-4 pb-16 pt-8 sm:px-6">
          <SystemMonitor
            showModelsPanel={uiSettings.showJobMonitorModels}
            showGpuPanel={uiSettings.showJobMonitorGpu}
            isActive={searchMode === "Job Monitor"}
          />
        </section>
      ) : searchMode === "VLM" ? (
        <VlmPanel />
      ) : searchMode === "ANNOTATION" ? (
        <AnnotationPanel
          onOpenJobsMonitor={() => setSearchMode("Job Monitor")}
          onOpenStorage={() => setSearchMode("STORAGE")}
          showSyntheticMethod={uiSettings.showSyntheticInAnnotation}
        />
      ) : searchMode === "STORAGE" ? (
        <StoragePanel
          showSnapshotSection={uiSettings.showSnapshotSection}
          showVlmFieldBreakdown={uiSettings.showStorageVlmFieldAnalytics}
        />
      ) : (
        <>
          <section className="px-4 pb-8 pt-10 sm:px-6 sm:pt-12">
            <div className="mx-auto flex max-w-5xl flex-col items-center gap-6 text-center">
              <h1 className="text-2xl font-bold text-gray-900 sm:text-3xl">
                Поиск сцен автономного транспорта
              </h1>

              <SearchBar
                onSearch={handleSearch}
                loading={isLoading}
                initialQuery={browserQueryDraft}
                initialImageFile={browserImageDraft}
                onStateChange={({ query, imageFile }) => {
                  setBrowserQueryDraft(query);
                  setBrowserImageDraft(imageFile);
                }}
              />

              {sourceWarning && (
                <div className="w-full rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800 text-left">
                  {sourceWarning}
                </div>
              )}

              {searchWarningMessage && (
                <div className="w-full rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800 text-left">
                  {searchWarningMessage}
                </div>
              )}

              {errorMessage && (
                <div className="text-sm text-red-600">{errorMessage}</div>
              )}
            </div>
          </section>

          <section className="px-4 pb-16 sm:px-6">
            <div className="mx-auto max-w-5xl">
              {isLoading && (
                <div className="text-sm text-gray-500">Ищем подходящие кадры...</div>
              )}
              {!isLoading && images.length === 0 && lastQuery && !errorMessage && !searchWarningMessage && (
                <div className="text-sm text-gray-500">
                  {lastQuery === "image search"
                    ? "Ничего не найдено по загруженному изображению."
                    : `Ничего не найдено по запросу "${lastQuery}".`}
                </div>
              )}
              {!isLoading && lastQuery && !errorMessage && (
                <>
                  <div className="mt-4 flex flex-col gap-4 rounded-2xl border border-gray-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="text-sm text-gray-600">
                      {filteredImages.length > 0
                        ? `Показаны ${pageStart + 1}-${Math.min(pageStart + imagesPerPage, filteredImages.length)} из ${filteredImages.length}`
                        : "По текущему фильтру результаты отсутствуют"}
                      {hasScoreFilter && ` (всего найдено: ${images.length})`}
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
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                          disabled={currentPage === 1 || filteredImages.length === 0}
                          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          ← Назад
                        </button>
                        <div className="min-w-[5rem] text-center text-sm font-medium text-gray-700">
                          {currentPage} / {totalPages}
                        </div>
                        <button
                          type="button"
                          onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
                          disabled={currentPage === totalPages || filteredImages.length === 0}
                          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Вперёд →
                        </button>
                      </div>
                    </div>
                  </div>

                  {filteredImages.length > 0 && (
                    <ImageGallery images={paginatedImages} />
                  )}

                  <div className="mt-4 rounded-2xl border border-gray-200 bg-white p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                      <div className="text-sm font-semibold text-gray-700">
                        Фильтр по score и экспорт
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <label className="flex items-center gap-2 text-sm text-gray-600">
                          score от
                          <input
                            type="number"
                            value={minScoreInput}
                            onChange={(event) => setMinScoreInput(event.target.value)}
                            step="0.0001"
                            className="w-28 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900"
                          />
                        </label>
                        <label className="flex items-center gap-2 text-sm text-gray-600">
                          до
                          <input
                            type="number"
                            value={maxScoreInput}
                            onChange={(event) => setMaxScoreInput(event.target.value)}
                            step="0.0001"
                            className="w-28 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900"
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() => {
                            setMinScoreInput("0.1");
                            setMaxScoreInput("");
                          }}
                          className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 transition hover:bg-gray-50"
                        >
                          Сбросить score
                        </button>
                        <button
                          type="button"
                          onClick={handleExportCsv}
                          disabled={filteredImages.length === 0}
                          className="rounded-lg border border-blue-300 bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-700 transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Экспорт CSV
                        </button>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          </section>
        </>
      )}
      <TransferToast
        onOpenTransfer={openTransferSnapshotSection}
        isStorageMode={searchMode === "STORAGE"}
      />

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
                Несовместимая размерность embeddings
              </div>
              <div className="mt-1 text-sm text-slate-600">
                {embeddingMismatchDialog.message}
              </div>
            </div>
            <div className="space-y-3 px-5 py-4 text-sm text-slate-700">
              <div>
                Текущий запрос embedder: <span className="font-semibold">{embeddingMismatchDialog.queryDim || "—"}</span>
              </div>
              <div>
                Разметка в storage: <span className="font-semibold">{embeddingMismatchDialog.storedDim || "—"}</span>
              </div>
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
                Стоит пересоздать embedding storage под новую размерность и заново запустить embedding backfill, либо вернуть прежнюю модель.
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 px-5 py-4">
              <button
                type="button"
                onClick={() => {
                  setEmbeddingMismatchDialog(null);
                  setSearchMode("ANNOTATION");
                }}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
                disabled={isRebuildingEmbeddings}
              >
                Открыть ANNOTATION
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
                  ? "Пересоздаю embeddings..."
                  : "Пересоздать и запустить backfill"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
