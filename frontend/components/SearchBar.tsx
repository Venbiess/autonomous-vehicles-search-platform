"use client";

import { useState, useEffect } from "react";

interface SearchBarProps {
  onSearch: (query: string) => void;
  loading?: boolean;
}

export default function SearchBar({ onSearch, loading = false }: SearchBarProps) {
  const [query, setQuery] = useState("");
  const [typing, setTyping] = useState(false);
  const [active, setActive] = useState(false);
  const trimmedQuery = query.trim();
  const isDisabled = trimmedQuery.length === 0 || loading;

  useEffect(() => {
    if (query.length > 0) {
      setTyping(true);
      setActive(false);

      const timeout = setTimeout(() => {
        setTyping(false);
        setActive(true);
      }, 500);

      return () => clearTimeout(timeout);
    } else {
      setTyping(false);
      setActive(false);
    }
  }, [query]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (trimmedQuery.length === 0) return;
    onSearch(trimmedQuery);
  };

  return (
    <form
      className="flex flex-col gap-3 w-full max-w-3xl sm:flex-row sm:items-center"
      onSubmit={handleSubmit}
    >
      {/* Контейнер только для инпута с радужной рамкой */}
      <div className="relative flex-1 rounded-full p-[4px]">
        <div
          className={`
            absolute inset-0 rounded-full bg-gradient-to-r from-red-500 via-yellow-500 via-green-500 via-blue-500 to-purple-500
            animate-gradient-spin pointer-events-none
            transition-opacity duration-700
            ${!typing && active ? "opacity-30" : "opacity-100"}
          `}
        ></div>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Найдётся почти всё..."
          className="relative z-10 w-full px-5 py-3 rounded-full bg-gray-100 text-gray-700 border-none focus:outline-none"
        />
      </div>

      <button
        type="submit"
        disabled={isDisabled}
        className={`
            text-white font-medium rounded-full transition-all duration-300 px-8 py-3
            ${typing ? "bg-gray-400 w-full sm:w-40" : ""}
            ${active ? "bg-purple-600 w-full sm:w-80" : ""}
            ${!typing && !active ? "bg-gray-400 w-full sm:w-40" : ""}
            ${isDisabled ? "opacity-60 cursor-not-allowed" : ""}
        `}
      >
        {loading ? "Ищем..." : "Поиск"}
      </button>
    </form>
  );
}
