"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { Cog6ToothIcon } from "@heroicons/react/24/outline";
import {
  SEARCH_MODE_STORAGE_KEY,
  type SearchMode,
} from "../lib/searchMode";

import SearchBar from "../components/SearchBar";
import ImageGallery from "../components/ImageGallery";
import SystemMonitor from "../components/SystemMonitor";
import VlmPanel from "../components/VlmPanel";
import AnnotationPanel from "../components/AnnotationPanel";
import StoragePanel from "../components/StoragePanel";
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
  showSyntheticInAnnotation: boolean;
  showSearchMeta: boolean;
  showJobMonitorRuntime: boolean;
}

const IMAGES_PER_PAGE_OPTIONS = [6, 9, 12, 18, 24];
const SEARCH_MODE_COOKIE_KEY = SEARCH_MODE_STORAGE_KEY;
const UI_SETTINGS_STORAGE_KEY = "avsp_ui_settings_v1";

const DEFAULT_UI_SETTINGS: UISettings = {
  showSnapshotSection: true,
  showSyntheticInAnnotation: true,
  showSearchMeta: false,
  showJobMonitorRuntime: true,
};

function parseStoragePathMeta(storagePath?: string): {
  dataset: string;
  key: string;
} {
  const raw = String(storagePath || "").trim();
  if (!raw) return { dataset: "", key: "" };
  const normalized = raw.replace(/^s3:\/\//i, "").replace(/^\/+/, "");
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
      className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors duration-200 ${
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
    try {
      const raw = window.localStorage.getItem(UI_SETTINGS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<UISettings>;
      setUiSettings({
        showSnapshotSection:
          typeof parsed?.showSnapshotSection === "boolean"
            ? parsed.showSnapshotSection
            : DEFAULT_UI_SETTINGS.showSnapshotSection,
        showSyntheticInAnnotation:
          typeof parsed?.showSyntheticInAnnotation === "boolean"
            ? parsed.showSyntheticInAnnotation
            : DEFAULT_UI_SETTINGS.showSyntheticInAnnotation,
        showSearchMeta:
          typeof parsed?.showSearchMeta === "boolean"
            ? parsed.showSearchMeta
            : DEFAULT_UI_SETTINGS.showSearchMeta,
        showJobMonitorRuntime:
          typeof parsed?.showJobMonitorRuntime === "boolean"
            ? parsed.showJobMonitorRuntime
            : DEFAULT_UI_SETTINGS.showJobMonitorRuntime,
      });
    } catch {
      setUiSettings(DEFAULT_UI_SETTINGS);
    }
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
      setImages(response.data ?? []);
      setCurrentPage(1);
    } catch (error) {
      const message = axios.isAxiosError(error)
        ? error.response?.data?.error || error.message
        : error instanceof Error
          ? error.message
          : "Не удалось выполнить поиск";
      setErrorMessage(message);
      setImages([]);
      setCurrentPage(1);
    } finally {
      setIsLoading(false);
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
    <main className="min-h-screen bg-gray-100">
      <div className="fixed right-4 top-4 z-[70]">
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
            <div className="absolute right-0 mt-3 w-[340px] rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl">
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
                    <div className="text-sm font-medium text-slate-800">Show Job Monitor Runtime</div>
                    <div className="text-xs text-slate-500">GPU host and model runtime blocks</div>
                  </div>
                  <IOSSwitch
                    checked={uiSettings.showJobMonitorRuntime}
                    onChange={(next) =>
                      setUiSettings((prev) => ({ ...prev, showJobMonitorRuntime: next }))
                    }
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <section className="bg-white border-b border-gray-200 shadow-sm">
        <div className="mx-auto max-w-5xl px-6">
          <div className="flex items-center justify-center py-6">
            <button
              onClick={() => setSearchMode("STORAGE")}
              style={{ fontSize: '32px', fontWeight: 900, letterSpacing: '0.5px' }}
              className={`font-bebas transition-all duration-200 px-8 py-3 ${
                searchMode === "STORAGE"
                  ? "text-blue-600 bg-blue-50 border-b-4 border-blue-600"
                  : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
              }`}
            >
              STORAGE
            </button>
            <div className="h-8 w-px bg-gray-300 mx-4"></div>
            <button
              onClick={() => setSearchMode("VLM")}
              style={{ fontSize: '32px', fontWeight: 900, letterSpacing: '0.5px' }}
              className={`font-bebas transition-all duration-200 px-8 py-3 ${
                searchMode === "VLM"
                  ? "text-blue-600 bg-blue-50 border-b-4 border-blue-600"
                  : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
              }`}
            >
              VLM
            </button>
            <div className="h-8 w-px bg-gray-300 mx-4"></div>
            <button
              onClick={() => setSearchMode("Browser")}
              style={{ fontSize: '32px', fontWeight: 900, letterSpacing: '0.5px' }}
              className={`font-bebas transition-all duration-200 px-8 py-3 ${
                searchMode === "Browser"
                  ? "text-blue-600 bg-blue-50 border-b-4 border-blue-600"
                  : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
              }`}
            >
              BROWSER
            </button>
            <div className="h-8 w-px bg-gray-300 mx-4"></div>
            <button
              onClick={() => setSearchMode("ANNOTATION")}
              style={{ fontSize: '32px', fontWeight: 900, letterSpacing: '0.5px' }}
              className={`font-bebas transition-all duration-200 px-8 py-3 ${
                searchMode === "ANNOTATION"
                  ? "text-blue-600 bg-blue-50 border-b-4 border-blue-600"
                  : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
              }`}
            >
              ANNOTATION
            </button>
            <div className="h-8 w-px bg-gray-300 mx-4"></div>
            <button
              onClick={() => setSearchMode("Job Monitor")}
              style={{ fontSize: '32px', fontWeight: 900, letterSpacing: '0.5px' }}
              className={`font-bebas transition-all duration-200 px-8 py-3 ${
                searchMode === "Job Monitor"
                  ? "text-blue-600 bg-blue-50 border-b-4 border-blue-600"
                  : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
              }`}
            >
              JOB MONITOR
            </button>
          </div>
        </div>
      </section>

      {searchMode === "Job Monitor" ? (
        <section className="px-6 pt-8 pb-16">
          <SystemMonitor showRuntimePanels={uiSettings.showJobMonitorRuntime} />
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
        <StoragePanel showSnapshotSection={uiSettings.showSnapshotSection} />
      ) : (
        <>
          <section className="px-6 pt-12 pb-8">
            <div className="mx-auto flex max-w-5xl flex-col items-center gap-6 text-center">
              <h1 className="text-3xl font-bold text-gray-900">
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

              {errorMessage && (
                <div className="text-sm text-red-600">{errorMessage}</div>
              )}
            </div>
          </section>

          <section className="px-6 pb-16">
            <div className="mx-auto max-w-5xl">
              {isLoading && (
                <div className="text-sm text-gray-500">Ищем подходящие кадры...</div>
              )}
              {!isLoading && images.length === 0 && lastQuery && !errorMessage && (
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
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                          disabled={currentPage === 1 || filteredImages.length === 0}
                          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          ← Назад
                        </button>
                        <div className="min-w-24 text-center text-sm font-medium text-gray-700">
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
      <TransferToast onOpenTransfer={openTransferSnapshotSection} />
    </main>
  );
}
