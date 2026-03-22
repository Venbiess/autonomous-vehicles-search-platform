"use client";

import { useEffect, useState } from "react";

export default function ImageGallery({ images }) {
  const [selectedImage, setSelectedImage] = useState(null);

  useEffect(() => {
    if (!selectedImage) return undefined;

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setSelectedImage(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedImage]);

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 mt-4">
        {images.map((img) => (
          <button
            key={img.id}
            type="button"
            onClick={() => setSelectedImage(img)}
            className="overflow-hidden rounded border bg-white text-left transition hover:-translate-y-0.5 hover:shadow-lg"
          >
            <img
              src={img.url}
              alt={img.title}
              loading="lazy"
              className="h-48 w-full object-cover"
            />
            <div className="p-2">
              <div className="text-xs whitespace-pre-line break-all">{img.title}</div>
              {img.score !== null && img.score !== undefined && (
                <div className="text-xs text-gray-500">
                  score: {Number(img.score).toFixed(4)}
                </div>
              )}
            </div>
          </button>
        ))}
      </div>

      {selectedImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-6 py-10"
          onClick={() => setSelectedImage(null)}
        >
          <div
            className="relative max-h-[85vh] w-full max-w-5xl overflow-hidden rounded-3xl bg-white/95 p-4 shadow-2xl backdrop-blur-sm"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setSelectedImage(null)}
              className="absolute right-4 top-4 rounded-full bg-black/70 px-3 py-1 text-sm font-semibold text-white transition hover:bg-black"
            >
              Закрыть
            </button>
            <div className="overflow-auto pt-8">
              <img
                src={selectedImage.url}
                alt={selectedImage.title}
                className="max-h-[68vh] w-full rounded-2xl object-contain bg-slate-100"
              />
              <div className="px-2 pb-2 pt-4">
                <div className="text-sm whitespace-pre-line break-all text-slate-800">
                  {selectedImage.title}
                </div>
                {selectedImage.score !== null &&
                  selectedImage.score !== undefined && (
                    <div className="mt-2 text-sm text-slate-500">
                      score: {Number(selectedImage.score).toFixed(4)}
                    </div>
                  )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
