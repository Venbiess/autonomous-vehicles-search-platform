"use client"; // делаем компонент клиентским, чтобы можно было использовать useState

import { useState } from "react";
import axios from "axios";

// Импортируем компоненты
import SearchBar from "../components/SearchBar";
import ImageGallery from "../components/ImageGallery";

interface ImageResult {
  id: string;
  title: string;
  url: string;
  score?: number | null;
}

export default function HomePage() {
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
    </main>
  );
}
