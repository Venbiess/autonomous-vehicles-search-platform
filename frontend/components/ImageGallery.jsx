"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";

const GALLERY_VIRTUALIZE_MIN_ITEMS = 40;
const GALLERY_ROW_HEIGHT_PX = 304;
const GALLERY_ROW_GAP_PX = 16;
const GALLERY_OVERSCAN_ROWS = 2;
const IMAGE_RETRY_ATTEMPTS = 2;

function appendRetryToken(url) {
  const separator = String(url).includes("?") ? "&" : "?";
  return `${url}${separator}retry=${Date.now()}`;
}

function ResilientImage({ src, alt, className }) {
  const [resolvedSrc, setResolvedSrc] = useState(src);
  const [retryCount, setRetryCount] = useState(0);
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div
        className={`${className} flex items-center justify-center bg-slate-100 text-xs text-slate-500`}
      >
        image unavailable
      </div>
    );
  }

  return (
    <Image
      src={resolvedSrc}
      alt={alt}
      unoptimized
      width={1600}
      height={900}
      loading="lazy"
      className={className}
      onError={() => {
        if (retryCount >= IMAGE_RETRY_ATTEMPTS) {
          setFailed(true);
          return;
        }
        const nextRetry = retryCount + 1;
        setRetryCount(nextRetry);
        window.setTimeout(() => {
          setResolvedSrc(appendRetryToken(src));
        }, 200 * nextRetry);
      }}
    />
  );
}

function renderTitleLines(title, className = "") {
  const lines = String(title || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  return (
    <div className={className}>
      {lines.map((line, index) => (
        <div
          key={`${line}-${index}`}
          className={`font-bold ${index % 2 === 0 ? "text-black" : "text-slate-600"}`}
        >
          {line}
        </div>
      ))}
    </div>
  );
}

export default function ImageGallery({ images }) {
  const [selectedImage, setSelectedImage] = useState(null);
  const [viewportWidth, setViewportWidth] = useState(
    typeof window !== "undefined" ? window.innerWidth : 1280
  );
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(640);
  const viewportRef = useRef(null);

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

  useEffect(() => {
    const updateViewportWidth = () => {
      setViewportWidth(window.innerWidth);
    };
    window.addEventListener("resize", updateViewportWidth);
    return () => window.removeEventListener("resize", updateViewportWidth);
  }, []);

  useEffect(() => {
    const root = viewportRef.current;
    if (!root) return;
    const updateSize = () => {
      setViewportHeight(Math.max(320, root.clientHeight || 0));
      setScrollTop(root.scrollTop || 0);
    };
    updateSize();
    const onScroll = () => {
      setScrollTop(root.scrollTop || 0);
    };
    root.addEventListener("scroll", onScroll, { passive: true });

    let resizeObserver = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(updateSize);
      resizeObserver.observe(root);
    }

    return () => {
      root.removeEventListener("scroll", onScroll);
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
    };
  }, [images.length]);

  const columns = viewportWidth >= 1024 ? 3 : viewportWidth >= 640 ? 2 : 1;
  const shouldVirtualize = images.length >= GALLERY_VIRTUALIZE_MIN_ITEMS;
  const totalRows = Math.max(1, Math.ceil(images.length / columns));
  const rowStride = GALLERY_ROW_HEIGHT_PX + GALLERY_ROW_GAP_PX;
  const visibleRows = Math.max(1, Math.ceil(viewportHeight / rowStride));
  const startRow = shouldVirtualize
    ? Math.max(0, Math.floor(scrollTop / rowStride) - GALLERY_OVERSCAN_ROWS)
    : 0;
  const endRow = shouldVirtualize
    ? Math.min(totalRows, startRow + visibleRows + GALLERY_OVERSCAN_ROWS * 2)
    : totalRows;
  const startIndex = startRow * columns;
  const endIndex = Math.min(images.length, endRow * columns);
  const topSpacerHeight = shouldVirtualize ? startRow * rowStride : 0;
  const bottomSpacerHeight = shouldVirtualize ? Math.max(0, (totalRows - endRow) * rowStride) : 0;
  const visibleImages = useMemo(
    () => (shouldVirtualize ? images.slice(startIndex, endIndex) : images),
    [endIndex, images, shouldVirtualize, startIndex]
  );

  const galleryGrid = (
    <>
      {topSpacerHeight > 0 && <div aria-hidden="true" style={{ height: `${topSpacerHeight}px` }} />}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {visibleImages.map((img) => (
          <button
            key={img.id}
            type="button"
            onClick={() => setSelectedImage(img)}
            className="h-[300px] overflow-hidden rounded border bg-white text-left transition hover:-translate-y-0.5 hover:shadow-lg"
          >
            <ResilientImage
              key={img.url}
              src={img.url}
              alt={img.title}
              className="h-48 w-full object-cover"
            />
            <div className="p-2">
              {renderTitleLines(img.title, "max-h-[96px] overflow-hidden text-xs break-all")}
              {img.score !== null && img.score !== undefined && (
                <div className="text-xs text-gray-500">
                  score: {Number(img.score).toFixed(4)}
                </div>
              )}
            </div>
          </button>
        ))}
      </div>
      {bottomSpacerHeight > 0 && <div aria-hidden="true" style={{ height: `${bottomSpacerHeight}px` }} />}
    </>
  );

  return (
    <>
      {shouldVirtualize ? (
        <div ref={viewportRef} className="mt-4 max-h-[72vh] overflow-auto">
          {galleryGrid}
        </div>
      ) : (
        <div className="mt-4">{galleryGrid}</div>
      )}

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
              <ResilientImage
                key={selectedImage.url}
                src={selectedImage.url}
                alt={selectedImage.title}
                className="max-h-[68vh] w-full rounded-2xl object-contain bg-slate-100"
              />
              <div className="px-2 pb-2 pt-4">
                {renderTitleLines(selectedImage.title, "text-sm break-all")}
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
