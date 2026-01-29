"use client";

import { useState, useEffect } from "react";

interface SearchBarProps {
  onSearch: (query: string) => void;
}

export default function SearchBar({ onSearch }: SearchBarProps) {
  const [query, setQuery] = useState("");
  const [typing, setTyping] = useState(false);
  const [active, setActive] = useState(false);

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
    onSearch(query);
  };

  return (
    <div className="w-screen h-screen flex items-center justify-center bg-gray-100">
      <form className="flex gap-2 w-1/2" onSubmit={handleSubmit}>
        {/* Контейнер только для инпута с радужной рамкой */}
        <div className="relative flex-1 rounded-full p-[2px]">
          <div className="absolute inset-0 rounded-full bg-gradient-to-r from-red-500 via-yellow-500 via-green-500 via-blue-500 to-purple-500 animate-gradient-spin pointer-events-none"></div>
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
          className={`
            text-white font-medium rounded-full transition-all duration-300
            ${typing ? "bg-gray-400 w-24" : ""}
            ${active ? "bg-purple-600 w-60" : ""}
            ${!typing && !active ? "bg-gray-400 w-24" : ""}
          `}
        >
          Поиск
        </button>
      </form>
    </div>
  );
}
