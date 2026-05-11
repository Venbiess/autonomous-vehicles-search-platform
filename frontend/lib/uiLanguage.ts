export type UiLanguageCode = "en" | "ru";

export interface UiLanguageOption {
  code: UiLanguageCode;
  flag: string;
  label: string;
  nativeLabel: string;
}

export interface SearchBarCopy {
  openImagePreviewAria: string;
  selectedImageAlt: string;
  removeImageAria: string;
  queryPlaceholder: string;
  attachImageAria: string;
  searchButtonIdle: string;
  searchButtonLoading: string;
  closePreviewAria: string;
  uploadedImagePreviewAlt: string;
}

export interface UiCopy {
  tabs: {
    storage: string;
    vlm: string;
    browser: string;
    annotation: string;
    jobMonitor: string;
  };
  settings: {
    openSettingsAriaLabel: string;
    panelTitle: string;
    languageLabel: string;
    languageHint: string;
    toggles: {
      showSnapshotSection: { label: string; hint: string };
      showSyntheticInAnnotation: { label: string; hint: string };
      showSearchMeta: { label: string; hint: string };
      showJobMonitorModels: { label: string; hint: string };
      showJobMonitorGpu: { label: string; hint: string };
    };
  };
  browser: {
    heroTitle: string;
    loadingResults: string;
    emptyFromImage: string;
    emptyFromQuery: (query: string) => string;
    resultsShown: (start: number, end: number, total: number) => string;
    noResultsForFilter: string;
    totalFoundSuffix: (total: number) => string;
    imagesPerPage: string;
    previousPage: string;
    nextPage: string;
    scoreFilterAndExport: string;
    scoreFrom: string;
    scoreTo: string;
    resetScore: string;
    exportCsv: string;
  };
  search: {
    sourceDataMissing: string;
    embeddingMismatchDetailed: (queryDim: number, storedDim: number) => string;
    embeddingMismatchGeneric: string;
    searchBackendUnavailable: string;
    searchFailed: string;
    rebuildEmbeddingsFailed: string;
    embeddingsResetAndBackfillStarted: (resetEmbeddings: number, jobId: string) => string;
  };
  embeddingDialog: {
    title: string;
    currentQueryEmbedder: string;
    storageEmbeddings: string;
    recommendation: string;
    openAnnotation: string;
    rebuilding: string;
    rebuildAndStartBackfill: string;
  };
  searchBar: SearchBarCopy;
}

export const UI_LANGUAGE_OPTIONS: UiLanguageOption[] = [
  {
    code: "en",
    flag: "🇺🇸",
    label: "English",
    nativeLabel: "English",
  },
  {
    code: "ru",
    flag: "🇷🇺",
    label: "Russian",
    nativeLabel: "Русский",
  },
];

export const DEFAULT_UI_LANGUAGE: UiLanguageCode = "ru";
export const IMAGE_SEARCH_QUERY_TOKEN = "__image_search__";

const LANGUAGE_CODES = new Set<UiLanguageCode>(
  UI_LANGUAGE_OPTIONS.map((language) => language.code)
);

export function isUiLanguageCode(value: unknown): value is UiLanguageCode {
  return typeof value === "string" && LANGUAGE_CODES.has(value as UiLanguageCode);
}

export function resolveUiLanguageCode(value: unknown): UiLanguageCode {
  return isUiLanguageCode(value) ? value : DEFAULT_UI_LANGUAGE;
}

export const UI_COPY: Record<UiLanguageCode, UiCopy> = {
  en: {
    tabs: {
      storage: "STORAGE",
      vlm: "VLM",
      browser: "BROWSER",
      annotation: "ANNOTATION",
      jobMonitor: "JOB MONITOR",
    },
    settings: {
      openSettingsAriaLabel: "Open settings",
      panelTitle: "Interface Settings",
      languageLabel: "Language",
      languageHint: "Labels and messages in the web UI",
      toggles: {
        showSnapshotSection: {
          label: "Show Snapshot Section",
          hint: "Storage tab transfer block",
        },
        showSyntheticInAnnotation: {
          label: "Show Synthetic Dataset",
          hint: "In annotation preprocessor list",
        },
        showSearchMeta: {
          label: "Show Search Metadata",
          hint: "Dataset and storage info in result titles",
        },
        showJobMonitorModels: {
          label: "Show Job Monitor Models",
          hint: "Model runtime block",
        },
        showJobMonitorGpu: {
          label: "Show Job Monitor GPU",
          hint: "GPU host block",
        },
      },
    },
    browser: {
      heroTitle: "Autonomous Vehicle Scene Search",
      loadingResults: "Searching for matching frames...",
      emptyFromImage: "No matches found for the uploaded image.",
      emptyFromQuery: (query: string) => `No matches found for "${query}".`,
      resultsShown: (start: number, end: number, total: number) =>
        `Showing ${start}-${end} of ${total}`,
      noResultsForFilter: "No results for the current filter",
      totalFoundSuffix: (total: number) => ` (total found: ${total})`,
      imagesPerPage: "Images per page",
      previousPage: "← Previous",
      nextPage: "Next →",
      scoreFilterAndExport: "Score filter and export",
      scoreFrom: "score from",
      scoreTo: "to",
      resetScore: "Reset score",
      exportCsv: "Export CSV",
    },
    search: {
      sourceDataMissing: "Source data has not been downloaded yet. Frames table is missing.",
      embeddingMismatchDetailed: (queryDim: number, storedDim: number) =>
        `The new embedder dimension (${queryDim}) does not match the current storage embeddings dimension (${storedDim}). Search will return empty results until embeddings are rebuilt.`,
      embeddingMismatchGeneric:
        "The new embedder dimension does not match the current storage embeddings dimension. Search may return empty results.",
      searchBackendUnavailable: "Search backend is unavailable. Wait until the model starts.",
      searchFailed: "Failed to run search",
      rebuildEmbeddingsFailed: "Failed to rebuild embeddings",
      embeddingsResetAndBackfillStarted: (resetEmbeddings: number, jobId: string) =>
        `Embeddings reset: ${resetEmbeddings}. Backfill job started: ${jobId}.`,
    },
    embeddingDialog: {
      title: "Incompatible embeddings dimension",
      currentQueryEmbedder: "Current query embedder",
      storageEmbeddings: "Storage embeddings",
      recommendation:
        "Rebuild embedding storage for the new dimension and restart embedding backfill, or switch back to the previous model.",
      openAnnotation: "Open ANNOTATION",
      rebuilding: "Rebuilding embeddings...",
      rebuildAndStartBackfill: "Rebuild and start backfill",
    },
    searchBar: {
      openImagePreviewAria: "Open image preview",
      selectedImageAlt: "Selected image",
      removeImageAria: "Remove image",
      queryPlaceholder: "Search almost anything...",
      attachImageAria: "Attach image",
      searchButtonIdle: "Search",
      searchButtonLoading: "Searching...",
      closePreviewAria: "Close preview",
      uploadedImagePreviewAlt: "Uploaded image preview",
    },
  },
  ru: {
    tabs: {
      storage: "ХРАНИЛИЩЕ",
      vlm: "VLM",
      browser: "ПОИСК",
      annotation: "АННОТАЦИЯ",
      jobMonitor: "МОНИТОР",
    },
    settings: {
      openSettingsAriaLabel: "Открыть настройки",
      panelTitle: "Настройки интерфейса",
      languageLabel: "Язык",
      languageHint: "Подписи и сообщения в веб-интерфейсе",
      toggles: {
        showSnapshotSection: {
          label: "Показывать Transfer Snapshot",
          hint: "Блок передачи во вкладке Хранилище",
        },
        showSyntheticInAnnotation: {
          label: "Показывать Synthetic Dataset",
          hint: "В списке preprocessors во вкладке Аннотация",
        },
        showSearchMeta: {
          label: "Показывать метаданные поиска",
          hint: "Dataset и данные storage в заголовках результатов",
        },
        showJobMonitorModels: {
          label: "Показывать модели Job Monitor",
          hint: "Блок runtime моделей",
        },
        showJobMonitorGpu: {
          label: "Показывать GPU в Job Monitor",
          hint: "Блок GPU host",
        },
      },
    },
    browser: {
      heroTitle: "Поиск сцен автономного транспорта",
      loadingResults: "Ищем подходящие кадры...",
      emptyFromImage: "Ничего не найдено по загруженному изображению.",
      emptyFromQuery: (query: string) => `Ничего не найдено по запросу "${query}".`,
      resultsShown: (start: number, end: number, total: number) =>
        `Показаны ${start}-${end} из ${total}`,
      noResultsForFilter: "По текущему фильтру результаты отсутствуют",
      totalFoundSuffix: (total: number) => ` (всего найдено: ${total})`,
      imagesPerPage: "Картинок на странице",
      previousPage: "← Назад",
      nextPage: "Вперёд →",
      scoreFilterAndExport: "Фильтр по score и экспорт",
      scoreFrom: "score от",
      scoreTo: "до",
      resetScore: "Сбросить score",
      exportCsv: "Экспорт CSV",
    },
    search: {
      sourceDataMissing: "Исходные данные еще не скачаны. Таблица кадров отсутствует.",
      embeddingMismatchDetailed: (queryDim: number, storedDim: number) =>
        `Размерность нового embedder (${queryDim}) не совпадает с текущей разметкой storage (${storedDim}). Поиск будет возвращать пустой результат, пока не пересоздать embeddings.`,
      embeddingMismatchGeneric:
        "Размерность нового embedder не совпадает с текущей разметкой storage. Поиск может возвращать пустой результат.",
      searchBackendUnavailable:
        "Поисковый backend недоступен. Дождитесь запуска модели.",
      searchFailed: "Не удалось выполнить поиск",
      rebuildEmbeddingsFailed: "Не удалось пересоздать embeddings",
      embeddingsResetAndBackfillStarted: (resetEmbeddings: number, jobId: string) =>
        `Embeddings сброшены: ${resetEmbeddings}. Backfill-джоба запущена: ${jobId}.`,
    },
    embeddingDialog: {
      title: "Несовместимая размерность embeddings",
      currentQueryEmbedder: "Текущий запрос embedder",
      storageEmbeddings: "Разметка в storage",
      recommendation:
        "Стоит пересоздать embedding storage под новую размерность и заново запустить embedding backfill, либо вернуть прежнюю модель.",
      openAnnotation: "Открыть ANNOTATION",
      rebuilding: "Пересоздаю embeddings...",
      rebuildAndStartBackfill: "Пересоздать и запустить backfill",
    },
    searchBar: {
      openImagePreviewAria: "Открыть превью изображения",
      selectedImageAlt: "Выбранное изображение",
      removeImageAria: "Удалить изображение",
      queryPlaceholder: "Найдётся почти всё...",
      attachImageAria: "Прикрепить изображение",
      searchButtonIdle: "Поиск",
      searchButtonLoading: "Ищем...",
      closePreviewAria: "Закрыть превью",
      uploadedImagePreviewAlt: "Превью загруженного изображения",
    },
  },
};

export const DEFAULT_UI_COPY: UiCopy = UI_COPY[DEFAULT_UI_LANGUAGE];

export function getUiCopy(language: unknown): UiCopy {
  return UI_COPY[resolveUiLanguageCode(language)];
}
