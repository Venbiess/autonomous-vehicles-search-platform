"use client"; // делаем компонент клиентским, чтобы можно было использовать useState

import { useState } from "react";
import axios from "axios";

// Импортируем компоненты
import SearchBar from "../components/SearchBar";
import ImageGallery from "../components/ImageGallery";
import SystemMonitor from "../components/SystemMonitor";

interface ImageResult {
  id: string;
  title: string;
  url: string;
  score?: number | null;
}

type SearchMode = "VLM" | "Browser" | "Job Monitor";

export default function HomePage() {
  const [searchMode, setSearchMode] = useState<SearchMode>("Browser");
  const [images, setImages] = useState<ImageResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastQuery, setLastQuery] = useState("");

  const runSearch = async (query: string) => {
    const cleanedQuery = query.trim();
    if (!cleanedQuery) {
      setImages([]);
      setLastQuery("");
      setErrorMessage(null);
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);
    setLastQuery(cleanedQuery);
    try {
      const response = await axios.get("/api/search", {
        params: { q: cleanedQuery },
      });
      setImages(response.data ?? []);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Не удалось выполнить поиск";
      setErrorMessage(message);
      setImages([]);
    } finally {
      setIsLoading(false);
    }
  };

  // Поиск по тексту
  const handleSearch = (query: string) => runSearch(query);

  return (
    <main className="min-h-screen bg-gray-100">
      {/* Вкладки переключения режимов поиска */}
      <section className="bg-white border-b border-gray-200 shadow-sm">
        <div className="mx-auto max-w-5xl px-6">
          <div className="flex items-center justify-center py-6">
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
              Browser
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
              Job Monitor
            </button>
          </div>
        </div>
      </section>

      {searchMode === "Job Monitor" ? (
        <section className="px-6 pt-8 pb-16">
          <SystemMonitor />
        </section>
      ) : (
        <>
          <section className="px-6 pt-12 pb-8">
            <div className="mx-auto flex max-w-5xl flex-col items-center gap-6 text-center">
              <h1 className="text-3xl font-bold text-gray-900">
                Поиск сцен автономного транспорта
              </h1>

              {/* Компонент поиска */}
              <SearchBar onSearch={handleSearch} loading={isLoading} />

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
                  Ничего не найдено по запросу "{lastQuery}".
                </div>
              )}
              {images.length > 0 && <ImageGallery images={images} />}
            </div>
          </section>
        </>
      )}
    </main>
  );
}
