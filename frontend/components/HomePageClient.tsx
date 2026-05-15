"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import axios from "axios";
import { CheckIcon, ChevronUpDownIcon, Cog6ToothIcon } from "@heroicons/react/24/outline";
import {
  SEARCH_MODE_STORAGE_KEY,
  type SearchMode,
} from "../lib/searchMode";
import {
  DEFAULT_UI_LANGUAGE,
  IMAGE_SEARCH_QUERY_TOKEN,
  UI_LANGUAGE_OPTIONS,
  getUiCopy,
  resolveUiLanguageCode,
  type UiLanguageCode,
} from "../lib/uiLanguage";

import SearchBar from "../components/SearchBar";
import ImageGallery from "../components/ImageGallery";
import TransferToast from "../components/TransferToast";
import LanguageFlagIcon from "../components/LanguageFlagIcon";

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
  language: UiLanguageCode;
  showSnapshotSection: boolean;
  showStorageVlmFieldAnalytics: boolean;
  showSyntheticInAnnotation: boolean;
  showOpenAIBatchAnnotation: boolean;
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

interface SearchPaginationPayload {
  has_more?: boolean;
  requested_visible_limit?: number;
}

interface SearchResponsePayload {
  items?: ImageResult[];
  warning?: SearchWarningPayload;
  pagination?: SearchPaginationPayload;
  total_matching_count?: number | null;
}

interface EmbeddingMismatchDialogState {
  queryDim: number;
  storedDim: number;
  message: string;
}

const IMAGES_PER_PAGE_OPTIONS = [6, 9, 12, 18, 24];
const INITIAL_BROWSER_VISIBLE_LIMIT = 100;
const BROWSER_LOAD_STEP = 100;
const MAX_BROWSER_VISIBLE_LIMIT = 5000;
const SEARCH_MODE_COOKIE_KEY = SEARCH_MODE_STORAGE_KEY;
const UI_SETTINGS_STORAGE_KEY = "avsp_ui_settings_v1";
const SEARCH_MODE_TABS: SearchMode[] = [
  "STORAGE",
  "VLM",
  "Browser",
  "ANNOTATION",
  "Job Monitor",
];

const DEFAULT_UI_SETTINGS: UISettings = {
  language: DEFAULT_UI_LANGUAGE,
  showSnapshotSection: true,
  showStorageVlmFieldAnalytics: false,
  showSyntheticInAnnotation: false,
  showOpenAIBatchAnnotation: false,
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
  const [activeBrowserSearch, setActiveBrowserSearch] = useState<{
    query: string;
    imageFile: File | null;
  } | null>(null);
  const [browserLoadedLimit, setBrowserLoadedLimit] = useState(INITIAL_BROWSER_VISIBLE_LIMIT);
  const [browserHasMore, setBrowserHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isScoreFilterUpdating, setIsScoreFilterUpdating] = useState(false);
  const [scoreThresholdTotalCount, setScoreThresholdTotalCount] = useState<number | null>(null);
  const [minScoreInput, setMinScoreInput] = useState("0.1");
  const [maxScoreInput, setMaxScoreInput] = useState("");
  const [appliedMinScore, setAppliedMinScore] = useState<number | null>(0.1);
  const [appliedMaxScore, setAppliedMaxScore] = useState<number | null>(null);
  const [uiSettings, setUiSettings] = useState<UISettings>(DEFAULT_UI_SETTINGS);
  const [uiSettingsHydrated, setUiSettingsHydrated] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false);
  const [embeddingMismatchDialog, setEmbeddingMismatchDialog] =
    useState<EmbeddingMismatchDialogState | null>(null);
  const [isRebuildingEmbeddings, setIsRebuildingEmbeddings] = useState(false);
  const settingsPopoverRef = useRef<HTMLDivElement | null>(null);
  const languageMenuRef = useRef<HTMLDivElement | null>(null);
  const searchRunSeqRef = useRef(0);
  const scoreCountRunSeqRef = useRef(0);
  const lastScoreCountKeyRef = useRef("");

  const minScore = minScoreInput.trim() === "" ? null : Number(minScoreInput);
  const maxScore = maxScoreInput.trim() === "" ? null : Number(maxScoreInput);
  const hasValidMinScore = minScore !== null && Number.isFinite(minScore);
  const hasValidMaxScore = maxScore !== null && Number.isFinite(maxScore);
  const hasScoreFilter = appliedMinScore !== null || appliedMaxScore !== null;
  const copy = useMemo(() => getUiCopy(uiSettings.language), [uiSettings.language]);
  const selectedLanguage = useMemo(
    () =>
      UI_LANGUAGE_OPTIONS.find((language) => language.code === uiSettings.language) ||
      UI_LANGUAGE_OPTIONS[0],
    [uiSettings.language]
  );
  const searchModeTabLabels = useMemo(
    () => ({
      STORAGE: copy.tabs.storage,
      VLM: copy.tabs.vlm,
      Browser: copy.tabs.browser,
      ANNOTATION: copy.tabs.annotation,
      "Job Monitor": copy.tabs.jobMonitor,
    }),
    [copy]
  );

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
      if (appliedMinScore !== null && item.score < appliedMinScore) {
        return false;
      }
      if (appliedMaxScore !== null && item.score > appliedMaxScore) {
        return false;
      }
      return true;
    });
  }, [
    hasScoreFilter,
    appliedMinScore,
    appliedMaxScore,
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
    if (searchMode !== "Browser") return;
    if (isLoading || isLoadingMore) return;
    if (!activeBrowserSearch) return;
    if (!browserHasMore) return;
    if (filteredImages.length === 0) return;
    if (currentPage < Math.max(1, totalPages - 1)) return;
    const nextLimit = Math.min(
      MAX_BROWSER_VISIBLE_LIMIT,
      browserLoadedLimit + BROWSER_LOAD_STEP
    );
    if (nextLimit <= browserLoadedLimit) return;
    void runSearch({
      query: activeBrowserSearch.query,
      imageFile: activeBrowserSearch.imageFile,
      targetVisibleLimit: nextLimit,
      isLoadMore: true,
      includeScoreTotalCount: false,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    searchMode,
    isLoading,
    isLoadingMore,
    activeBrowserSearch,
    browserHasMore,
    filteredImages.length,
    currentPage,
    totalPages,
    browserLoadedLimit,
  ]);

  useEffect(() => {
    if (!activeBrowserSearch) {
      setScoreThresholdTotalCount(null);
      setIsScoreFilterUpdating(false);
      lastScoreCountKeyRef.current = "";
      return;
    }
    if (isLoading || isLoadingMore) {
      return;
    }
    const nextAppliedMin = hasValidMinScore ? (minScore as number) : null;
    const nextAppliedMax = hasValidMaxScore ? (maxScore as number) : null;
    const countMinScore =
      hasValidMinScore && !hasValidMaxScore && !activeBrowserSearch.imageFile
        ? (minScore as number)
        : null;

    if (countMinScore === null) {
      setAppliedMinScore(nextAppliedMin);
      setAppliedMaxScore(nextAppliedMax);
      setScoreThresholdTotalCount(null);
      setIsScoreFilterUpdating(false);
      lastScoreCountKeyRef.current = "";
      return;
    }

    const countKey = `${activeBrowserSearch.query}::${nextAppliedMin ?? ""}::${nextAppliedMax ?? ""}::${
      activeBrowserSearch.imageFile ? "image" : "text"
    }`;
    if (lastScoreCountKeyRef.current === countKey) {
      return;
    }

    const runSeq = scoreCountRunSeqRef.current + 1;
    scoreCountRunSeqRef.current = runSeq;
    setIsScoreFilterUpdating(true);

    const timeout = window.setTimeout(async () => {
      try {
        const response = await axios.get("/api/search", {
          params: {
            q: activeBrowserSearch.query,
            count_only: 1,
            count_min_score: countMinScore,
          },
        });
        if (runSeq !== scoreCountRunSeqRef.current) {
          return;
        }
        const payload = response.data as SearchResponsePayload & {
          total_matching_count?: number | null;
        };
        const nextTotal = Number(payload?.total_matching_count);
        setScoreThresholdTotalCount(Number.isFinite(nextTotal) ? nextTotal : null);
        setAppliedMinScore(nextAppliedMin);
        setAppliedMaxScore(nextAppliedMax);
        lastScoreCountKeyRef.current = countKey;
      } catch {
        if (runSeq !== scoreCountRunSeqRef.current) {
          return;
        }
      } finally {
        if (runSeq === scoreCountRunSeqRef.current) {
          setIsScoreFilterUpdating(false);
        }
      }
    }, 450);

    return () => window.clearTimeout(timeout);
  }, [
    activeBrowserSearch,
    hasValidMinScore,
    hasValidMaxScore,
    minScore,
    maxScore,
    isLoading,
    isLoadingMore,
  ]);

  useEffect(() => {
    const loadSourceStatus = async () => {
      try {
        const response = await axios.get("/api/storage/stats", {
          params: { include_storage_details: 0 },
        });
        if (response.data?.source_table_exists === false) {
          setSourceWarning(
            response.data?.warning ??
              copy.search.sourceDataMissing
          );
        } else {
          setSourceWarning(null);
        }
      } catch {
        setSourceWarning(null);
      }
    };
    loadSourceStatus();
  }, [copy.search.sourceDataMissing]);

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
          setUiSettingsHydrated(true);
          return;
        }
        const parsed = JSON.parse(raw) as Partial<UISettings> & { showJobMonitorRuntime?: boolean };
        const legacyRuntimeToggle =
          typeof parsed?.showJobMonitorRuntime === "boolean"
            ? parsed.showJobMonitorRuntime
            : undefined;

        setUiSettings({
          language: resolveUiLanguageCode(parsed?.language),
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
          showOpenAIBatchAnnotation:
            typeof parsed?.showOpenAIBatchAnnotation === "boolean"
              ? parsed.showOpenAIBatchAnnotation
              : DEFAULT_UI_SETTINGS.showOpenAIBatchAnnotation,
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
        setUiSettingsHydrated(true);
      } catch {
        setUiSettings({
          ...DEFAULT_UI_SETTINGS,
          showJobMonitorGpu: gpuAvailableByDefault,
        });
        setUiSettingsHydrated(true);
      }
    };
    loadSettings();
  }, []);

  useEffect(() => {
    if (!uiSettingsHydrated) {
      return;
    }
    window.localStorage.setItem(UI_SETTINGS_STORAGE_KEY, JSON.stringify(uiSettings));
  }, [uiSettings, uiSettingsHydrated]);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = uiSettings.language;
    }
  }, [uiSettings.language]);

  useEffect(() => {
    if (!settingsOpen) {
      setLanguageMenuOpen(false);
    }
  }, [settingsOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const root = settingsPopoverRef.current;
      const languageMenuRoot = languageMenuRef.current;
      const target = event.target as Node | null;
      if (!root || !target) return;
      if (!root.contains(target)) {
        setSettingsOpen(false);
        return;
      }
      if (
        languageMenuOpen &&
        languageMenuRoot &&
        !languageMenuRoot.contains(target)
      ) {
        setLanguageMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
    };
  }, [settingsOpen, languageMenuOpen]);

  const runSearch = async ({
    query,
    imageFile,
    targetVisibleLimit,
    isLoadMore,
    includeScoreTotalCount,
    countMinScore = null,
    applyScoreFilterOnSuccess = false,
    nextAppliedMinScore = null,
    nextAppliedMaxScore = null,
    showLoadMoreSpinner = true,
    updateResultsOnSuccess = true,
    suppressErrors = false,
  }: {
    query: string;
    imageFile: File | null;
    targetVisibleLimit: number;
    isLoadMore: boolean;
    includeScoreTotalCount: boolean;
    countMinScore?: number | null;
    applyScoreFilterOnSuccess?: boolean;
    nextAppliedMinScore?: number | null;
    nextAppliedMaxScore?: number | null;
    showLoadMoreSpinner?: boolean;
    updateResultsOnSuccess?: boolean;
    suppressErrors?: boolean;
  }) => {
    const runSeq = searchRunSeqRef.current + 1;
    searchRunSeqRef.current = runSeq;
    const cleanedQuery = query.trim();
    if (!cleanedQuery && !imageFile && !isLoadMore) {
      setImages([]);
      setLastQuery("");
      setErrorMessage(null);
      setCurrentPage(1);
      setBrowserHasMore(false);
      setBrowserLoadedLimit(INITIAL_BROWSER_VISIBLE_LIMIT);
      setActiveBrowserSearch(null);
      setScoreThresholdTotalCount(null);
      lastScoreCountKeyRef.current = "";
      return;
    }

    if (isLoadMore) {
      if (showLoadMoreSpinner) {
        setIsLoadingMore(true);
      }
    } else {
      setIsLoading(true);
      setErrorMessage(null);
      setSearchWarningMessage(null);
      setLastQuery(cleanedQuery || (imageFile ? IMAGE_SEARCH_QUERY_TOKEN : ""));
    }
    try {
      const requestedLimit = Math.max(
        INITIAL_BROWSER_VISIBLE_LIMIT,
        Math.min(MAX_BROWSER_VISIBLE_LIMIT, Math.floor(targetVisibleLimit))
      );
      const includeCount = includeScoreTotalCount && countMinScore !== null;
      const params = new URLSearchParams();
      params.set("limit", String(requestedLimit));
      if (includeCount) {
        params.set("count_min_score", String(countMinScore));
      }

      const response = imageFile
        ? await axios.post(`/api/search?${params.toString()}`, imageFile, {
            headers: {
              "Content-Type": imageFile.type || "application/octet-stream",
            },
          })
        : await axios.get("/api/search", {
            params: {
              q: cleanedQuery,
              limit: requestedLimit,
              ...(includeCount ? { count_min_score: countMinScore } : {}),
            },
          });
      if (runSeq !== searchRunSeqRef.current) {
        return;
      }
      const payload = response.data as SearchResponsePayload;
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
            ? copy.search.embeddingMismatchDetailed(queryDim, storedDim)
            : copy.search.embeddingMismatchGeneric;
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
            : copy.search.searchBackendUnavailable;
        setSearchWarningMessage(warningMessage);
      }
      if (updateResultsOnSuccess) {
        setImages(items);
        setBrowserHasMore(Boolean(payload?.pagination?.has_more));
        setBrowserLoadedLimit(
          Number.isFinite(payload?.pagination?.requested_visible_limit)
            ? Number(payload.pagination?.requested_visible_limit)
            : requestedLimit
        );
        setActiveBrowserSearch((prev) => {
          if (prev && prev.query === cleanedQuery && prev.imageFile === imageFile) {
            return prev;
          }
          return { query: cleanedQuery, imageFile };
        });
      }
      if (includeCount) {
        const nextTotal = Number(payload?.total_matching_count);
        setScoreThresholdTotalCount(Number.isFinite(nextTotal) ? nextTotal : null);
      } else if (!isLoadMore) {
        setScoreThresholdTotalCount(null);
        lastScoreCountKeyRef.current = "";
      }
      if (applyScoreFilterOnSuccess) {
        setAppliedMinScore(nextAppliedMinScore);
        setAppliedMaxScore(nextAppliedMaxScore);
      }
      if (!isLoadMore && updateResultsOnSuccess) {
        setCurrentPage(1);
      }
    } catch (error) {
      if (runSeq !== searchRunSeqRef.current) {
        return;
      }
      const message = axios.isAxiosError(error)
        ? error.response?.data?.error || error.message
        : error instanceof Error
          ? error.message
          : copy.search.searchFailed;
      if (!suppressErrors) {
        setErrorMessage(message);
        setSearchWarningMessage(null);
      }
      if (!isLoadMore && updateResultsOnSuccess) {
        setImages([]);
        setCurrentPage(1);
        setBrowserHasMore(false);
        setActiveBrowserSearch(null);
        setScoreThresholdTotalCount(null);
        setAppliedMinScore(hasValidMinScore ? (minScore as number) : null);
        setAppliedMaxScore(hasValidMaxScore ? (maxScore as number) : null);
        lastScoreCountKeyRef.current = "";
      }
    } finally {
      if (runSeq !== searchRunSeqRef.current) {
        return;
      }
      if (isLoadMore) {
        if (showLoadMoreSpinner) {
          setIsLoadingMore(false);
        }
      } else {
        setIsLoading(false);
      }
      if (applyScoreFilterOnSuccess) {
        setIsScoreFilterUpdating(false);
      }
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
        copy.search.embeddingsResetAndBackfillStarted(
          resetEmbeddings,
          String(backfillResponse.data?.job_id || "")
        )
      );
      setSearchMode("Job Monitor");
    } catch (error) {
      const message = axios.isAxiosError(error)
        ? error.response?.data?.error || error.message
        : error instanceof Error
          ? error.message
          : copy.search.rebuildEmbeddingsFailed;
      setErrorMessage(message);
    } finally {
      setIsRebuildingEmbeddings(false);
    }
  };

  const handleSearch = (payload: { query: string; imageFile: File | null }) =>
    runSearch({
      ...payload,
      targetVisibleLimit: INITIAL_BROWSER_VISIBLE_LIMIT,
      isLoadMore: false,
      includeScoreTotalCount: hasValidMinScore && !hasValidMaxScore,
      countMinScore: hasValidMinScore && !hasValidMaxScore ? (minScore as number) : null,
      applyScoreFilterOnSuccess: true,
      nextAppliedMinScore: hasValidMinScore ? (minScore as number) : null,
      nextAppliedMaxScore: hasValidMaxScore ? (maxScore as number) : null,
    });

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
            aria-label={copy.settings.openSettingsAriaLabel}
          >
          <Cog6ToothIcon className="h-6 w-6 transition-transform duration-500 group-hover:rotate-180" />
          </button>
          {settingsOpen && (
            <div className="absolute right-0 mt-3 w-[min(22rem,calc(100vw-1.5rem))] rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl">
              <div className="mb-3 text-sm font-semibold text-slate-900">{copy.settings.panelTitle}</div>
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-slate-800">
                      {copy.settings.toggles.showSnapshotSection.label}
                    </div>
                    <div className="text-xs text-slate-500">
                      {copy.settings.toggles.showSnapshotSection.hint}
                    </div>
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
                    <div className="text-sm font-medium text-slate-800">
                      {copy.settings.toggles.showJobMonitorModels.label}
                    </div>
                    <div className="text-xs text-slate-500">
                      {copy.settings.toggles.showJobMonitorModels.hint}
                    </div>
                  </div>
                  <IOSSwitch
                    checked={uiSettings.showJobMonitorModels}
                    onChange={(next) =>
                      setUiSettings((prev) => ({ ...prev, showJobMonitorModels: next }))
                    }
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-slate-800">
                      {copy.settings.toggles.showJobMonitorGpu.label}
                    </div>
                    <div className="text-xs text-slate-500">
                      {copy.settings.toggles.showJobMonitorGpu.hint}
                    </div>
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
                    <div className="text-sm font-medium text-slate-800">
                      {copy.settings.toggles.showStorageVlmFieldAnalytics.label}
                    </div>
                    <div className="text-xs text-slate-500">
                      {copy.settings.toggles.showStorageVlmFieldAnalytics.hint}
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
                    <div className="text-sm font-medium text-slate-800">
                      {copy.settings.toggles.showOpenAIBatchAnnotation.label}
                    </div>
                    <div className="text-xs text-slate-500">
                      {copy.settings.toggles.showOpenAIBatchAnnotation.hint}
                    </div>
                  </div>
                  <IOSSwitch
                    checked={uiSettings.showOpenAIBatchAnnotation}
                    onChange={(next) =>
                      setUiSettings((prev) => ({
                        ...prev,
                        showOpenAIBatchAnnotation: next,
                      }))
                    }
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-slate-800">
                      {copy.settings.toggles.showSearchMeta.label}
                    </div>
                    <div className="text-xs text-slate-500">
                      {copy.settings.toggles.showSearchMeta.hint}
                    </div>
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
                    <div className="text-sm font-medium text-slate-800">
                      {copy.settings.toggles.showSyntheticInAnnotation.label}
                    </div>
                    <div className="text-xs text-slate-500">
                      {copy.settings.toggles.showSyntheticInAnnotation.hint}
                    </div>
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
                <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                  <div>
                    <div className="text-sm font-medium text-slate-800">{copy.settings.languageLabel}</div>
                  </div>
                  <div ref={languageMenuRef} className="relative">
                    <button
                      type="button"
                      onClick={() => setLanguageMenuOpen((value) => !value)}
                      className="flex w-44 items-center justify-between gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 transition hover:bg-slate-50"
                      aria-label={copy.settings.languageLabel}
                      aria-haspopup="listbox"
                      aria-expanded={languageMenuOpen}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <LanguageFlagIcon code={selectedLanguage.code} className="h-6 w-6" />
                        <span className="truncate">{selectedLanguage.nativeLabel}</span>
                      </span>
                      <ChevronUpDownIcon className="h-4 w-4 shrink-0 text-slate-500" />
                    </button>
                    {languageMenuOpen && (
                      <div className="absolute bottom-full right-0 z-10 mb-2 w-52 rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl">
                        <div role="listbox" aria-label={copy.settings.languageLabel}>
                          {UI_LANGUAGE_OPTIONS.map((language) => {
                            const active = uiSettings.language === language.code;
                            return (
                              <button
                                key={language.code}
                                type="button"
                                onClick={() => {
                                  setUiSettings((prev) => ({
                                    ...prev,
                                    language: resolveUiLanguageCode(language.code),
                                  }));
                                  setLanguageMenuOpen(false);
                                }}
                                className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition ${
                                  active
                                    ? "bg-blue-50 text-blue-700"
                                    : "text-slate-700 hover:bg-slate-100"
                                }`}
                                role="option"
                                aria-selected={active}
                              >
                                <LanguageFlagIcon code={language.code} className="h-6 w-6" />
                                <span className="flex-1 truncate">{language.nativeLabel}</span>
                                {active && <CheckIcon className="h-4 w-4" />}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <section className="bg-white border-b border-gray-200 shadow-sm">
        <div className="mx-auto max-w-5xl px-2 sm:px-6">
          <div className="hide-scrollbar flex items-center gap-1 overflow-x-auto py-3 sm:justify-center sm:gap-2 sm:py-6">
            {SEARCH_MODE_TABS.map((mode) => (
              <button
                key={mode}
                onClick={() => setSearchMode(mode)}
                className={`shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-xl font-black tracking-wide font-bebas transition-all duration-200 sm:px-6 sm:py-3 sm:text-3xl ${
                  searchMode === mode
                    ? "border-blue-600 bg-blue-50 text-blue-600"
                    : "border-transparent text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                }`}
              >
                {searchModeTabLabels[mode]}
              </button>
            ))}
          </div>
        </div>
      </section>

      {searchMode === "Job Monitor" ? (
        <section className="px-4 pb-16 pt-8 sm:px-6">
          <SystemMonitor
            language={uiSettings.language}
            showModelsPanel={uiSettings.showJobMonitorModels}
            showGpuPanel={uiSettings.showJobMonitorGpu}
            isActive={searchMode === "Job Monitor"}
          />
        </section>
      ) : searchMode === "VLM" ? (
        <VlmPanel language={uiSettings.language} />
      ) : searchMode === "ANNOTATION" ? (
        <AnnotationPanel
          language={uiSettings.language}
          onOpenJobsMonitor={() => setSearchMode("Job Monitor")}
          onOpenStorage={() => setSearchMode("STORAGE")}
          showSyntheticMethod={uiSettings.showSyntheticInAnnotation}
          showOpenAIBatchBlock={uiSettings.showOpenAIBatchAnnotation}
        />
      ) : searchMode === "STORAGE" ? (
        <StoragePanel
          language={uiSettings.language}
          showSnapshotSection={uiSettings.showSnapshotSection}
          showVlmFieldBreakdown={uiSettings.showStorageVlmFieldAnalytics}
        />
      ) : (
        <>
          <section className="px-4 pb-8 pt-10 sm:px-6 sm:pt-12">
            <div className="mx-auto flex max-w-5xl flex-col items-center gap-6 text-center">
              <h1 className="text-2xl font-bold text-gray-900 sm:text-3xl">
                {copy.browser.heroTitle}
              </h1>

              <SearchBar
                onSearch={handleSearch}
                loading={isLoading}
                copy={copy.searchBar}
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
              {isLoading && images.length === 0 && (
                <div className="text-sm text-gray-500">{copy.browser.loadingResults}</div>
              )}
              {!isLoading && images.length === 0 && lastQuery && !errorMessage && !searchWarningMessage && (
                <div className="text-sm text-gray-500">
                  {lastQuery === IMAGE_SEARCH_QUERY_TOKEN
                    ? copy.browser.emptyFromImage
                    : copy.browser.emptyFromQuery(lastQuery)}
                </div>
              )}
              {!isLoading && lastQuery && !errorMessage && (
                <>
                  <div className="mt-4 flex flex-col gap-4 rounded-2xl border border-gray-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="text-sm text-gray-600">
                      {filteredImages.length > 0
                        ? copy.browser.resultsShown(
                            pageStart + 1,
                            Math.min(pageStart + imagesPerPage, filteredImages.length),
                            filteredImages.length
                          )
                        : copy.browser.noResultsForFilter}
                      {hasScoreFilter &&
                        (isScoreFilterUpdating
                          ? copy.browser.totalFoundUpdating
                          : copy.browser.totalFoundSuffix(
                              hasValidMinScore && !hasValidMaxScore && scoreThresholdTotalCount !== null
                                ? scoreThresholdTotalCount
                                : images.length
                            ))}
                    </div>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                      <label className="flex items-center gap-2 text-sm text-gray-600">
                        {copy.browser.imagesPerPage}
                        <select
                          value={imagesPerPage}
                          onChange={(event) => {
                            setImagesPerPage(Number(event.target.value));
                            setCurrentPage(1);
                          }}
                          className="h-10 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900"
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
                          {copy.browser.previousPage}
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
                          {copy.browser.nextPage}
                        </button>
                      </div>
                    </div>
                  </div>

                  {isLoadingMore && (
                    <div className="mt-3 text-xs text-gray-500">{copy.browser.loadingResults}</div>
                  )}

                  {filteredImages.length > 0 && (
                    <ImageGallery images={paginatedImages} />
                  )}

                  <div className="mt-4 rounded-2xl border border-gray-200 bg-white p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                      <div className="text-sm font-semibold text-gray-700">
                        {copy.browser.scoreFilterAndExport}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <label className="flex items-center gap-2 text-sm text-gray-600">
                          {copy.browser.scoreFrom}
                          <input
                            type="number"
                            value={minScoreInput}
                            onChange={(event) => setMinScoreInput(event.target.value)}
                            step="0.0001"
                            className="w-28 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900"
                          />
                        </label>
                        <label className="flex items-center gap-2 text-sm text-gray-600">
                          {copy.browser.scoreTo}
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
                          {copy.browser.resetScore}
                        </button>
                        <button
                          type="button"
                          onClick={handleExportCsv}
                          disabled={filteredImages.length === 0}
                          className="rounded-lg border border-blue-300 bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-700 transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {copy.browser.exportCsv}
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
        language={uiSettings.language}
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
                {copy.embeddingDialog.title}
              </div>
              <div className="mt-1 text-sm text-slate-600">
                {embeddingMismatchDialog.message}
              </div>
            </div>
            <div className="space-y-3 px-5 py-4 text-sm text-slate-700">
              <div>
                {copy.embeddingDialog.currentQueryEmbedder}:{" "}
                <span className="font-semibold">{embeddingMismatchDialog.queryDim || "—"}</span>
              </div>
              <div>
                {copy.embeddingDialog.storageEmbeddings}:{" "}
                <span className="font-semibold">{embeddingMismatchDialog.storedDim || "—"}</span>
              </div>
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
                {copy.embeddingDialog.recommendation}
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
                {copy.embeddingDialog.openAnnotation}
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
                  ? copy.embeddingDialog.rebuilding
                  : copy.embeddingDialog.rebuildAndStartBackfill}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
