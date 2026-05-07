"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

interface SearchBarProps {
  onSearch: (payload: { query: string; imageFile: File | null }) => void;
  loading?: boolean;
  initialQuery?: string;
  initialImageFile?: File | null;
  onStateChange?: (payload: { query: string; imageFile: File | null }) => void;
}

export default function SearchBar({
  onSearch,
  loading = false,
  initialQuery = "",
  initialImageFile = null,
  onStateChange,
}: SearchBarProps) {
  const [query, setQuery] = useState(initialQuery);
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(initialImageFile);
  const [isImageLoading, setIsImageLoading] = useState(Boolean(initialImageFile));
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previewUrl = useMemo(
    () => (imageFile ? URL.createObjectURL(imageFile) : null),
    [imageFile]
  );
  const trimmedQuery = query.trim();
  const hasImage = imageFile !== null;
  const hasReadyImage = hasImage && !isImageLoading;
  const typing = query.length > 0 && query !== debouncedQuery;
  const active = !typing && (debouncedQuery.trim().length > 0 || hasReadyImage);
  const isDisabled = loading || isImageLoading || (trimmedQuery.length === 0 && !hasImage);

  useEffect(() => {
    if (typeof onStateChange === "function") {
      onStateChange({ query, imageFile });
    }
  }, [query, imageFile, onStateChange]);

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  useEffect(() => {
    if (!isPreviewOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsPreviewOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isPreviewOpen]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setDebouncedQuery(query);
    }, 500);
    return () => clearTimeout(timeout);
  }, [query]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (trimmedQuery.length === 0 && !imageFile) return;
    if (isImageLoading) return;
    onSearch({ query: trimmedQuery, imageFile });
  };

  const handleImageChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    if (!file) {
      setImageFile(null);
      setIsImageLoading(false);
      return;
    }
    setQuery("");
    setImageFile(file);
    setIsImageLoading(true);
  };

  const clearImage = () => {
    setImageFile(null);
    setIsImageLoading(false);
    setIsPreviewOpen(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  return (
    <form
      className="flex flex-col gap-3 w-full max-w-3xl sm:flex-row sm:items-center"
      onSubmit={handleSubmit}
    >
      <div className="relative flex-1 rounded-full p-[4px]">
        <div
          className={`
            absolute inset-0 rounded-full bg-gradient-to-r from-red-500 via-yellow-500 via-green-500 via-blue-500 to-purple-500
            animate-gradient-spin pointer-events-none
            transition-opacity duration-700
            ${!typing && active ? "opacity-30" : "opacity-100"}
          `}
        ></div>
        <div className="relative z-10 flex h-[44px] items-center gap-3 rounded-full bg-gray-100 px-4">
          {previewUrl && (
            <div className="relative h-7 w-7 shrink-0 overflow-visible">
              <div
                className={`group relative h-full w-full overflow-hidden rounded-lg ${!isImageLoading ? "cursor-zoom-in" : ""}`}
                onClick={() => {
                  if (!isImageLoading) {
                    setIsPreviewOpen(true);
                  }
                }}
                role="button"
                tabIndex={isImageLoading ? -1 : 0}
                onKeyDown={(event) => {
                  if (
                    !isImageLoading &&
                    (event.key === "Enter" || event.key === " ")
                  ) {
                    event.preventDefault();
                    setIsPreviewOpen(true);
                  }
                }}
                aria-label="Открыть превью изображения"
              >
                <img
                  src={previewUrl}
                  alt="Выбранное изображение"
                  className="h-full w-full object-cover"
                  onLoad={() => setIsImageLoading(false)}
                  onError={() => {
                    setImageFile(null);
                    setIsImageLoading(false);
                  }}
                />
                {!isImageLoading && (
                  <div className="absolute inset-0 bg-black/0 opacity-0 transition-opacity duration-200 group-hover:bg-black/45 group-hover:opacity-100" />
                )}
              </div>
              {isImageLoading && (
                <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/55">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                </div>
              )}
              {!isImageLoading && (
                <button
                  type="button"
                  onClick={clearImage}
                  className="absolute -right-2 -top-2 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-gray-900 text-[11px] leading-none text-white shadow-sm"
                  aria-label="Удалить изображение"
                >
                  ×
                </button>
              )}
            </div>
          )}
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={hasImage}
            readOnly={hasImage}
            placeholder="Найдётся почти всё..."
            className={`min-w-0 flex-1 bg-transparent px-1 py-1 text-gray-700 outline-none ${
              hasImage ? "cursor-not-allowed opacity-60" : ""
            }`}
          />
          <input
            id={inputId}
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleImageChange}
            className="hidden"
          />
          <label
            htmlFor={inputId}
            className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-gray-500 transition hover:bg-gray-200 hover:text-gray-800"
            aria-label="Прикрепить изображение"
            title="Прикрепить изображение"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M21.44 11.05 12.25 20.24a6 6 0 1 1-8.49-8.48l9.2-9.2a4 4 0 1 1 5.65 5.66l-9.2 9.19a2 2 0 1 1-2.82-2.83l8.48-8.48"
              />
            </svg>
          </label>
        </div>
      </div>

      <button
        type="submit"
        disabled={isDisabled}
        className={`
            h-[52px] text-white font-medium rounded-full transition-all duration-300 px-8
            ${typing ? "bg-gray-400 w-full sm:w-40" : ""}
            ${active ? "bg-purple-600 w-full sm:w-80" : ""}
            ${!typing && !active ? "bg-gray-400 w-full sm:w-40" : ""}
            ${isDisabled ? "opacity-60 cursor-not-allowed" : ""}
        `}
      >
        {loading ? "Ищем..." : "Поиск"}
      </button>

      {isPreviewOpen && previewUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 py-6"
          onClick={() => setIsPreviewOpen(false)}
        >
          <div
            className="relative max-h-full max-w-5xl rounded-2xl bg-white p-2 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setIsPreviewOpen(false)}
              className="absolute -right-3 -top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-gray-900 text-lg leading-none text-white shadow-md"
              aria-label="Закрыть превью"
            >
              ×
            </button>
            <img
              src={previewUrl}
              alt="Превью загруженного изображения"
              className="max-h-[82vh] max-w-[90vw] rounded-xl object-contain"
            />
          </div>
        </div>
      )}
    </form>
  );
}
