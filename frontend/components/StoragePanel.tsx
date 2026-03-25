"use client";

import { useEffect, useState } from "react";
import axios from "axios";

interface SourceStats {
  total_rows: number;
  rows_with_storage_path: number;
  distinct_storage_paths: number;
  duplicate_storage_rows: number;
}

interface AnnotationStats {
  annotated_rows: number;
  pending_rows: number;
  annotated_percent: number;
  pending_percent: number;
}

interface VlmStats extends AnnotationStats {
  configured_fields: number;
}

interface BucketStats {
  bucket: string;
  objects: number;
  bytes: number;
  gigabytes: number;
  error?: string;
}

interface StorageStats {
  tracked_buckets: string[];
  bucket_stats: BucketStats[];
  total_objects: number;
  total_bytes: number;
  total_gigabytes: number;
}

interface DatasetRowDistribution {
  dataset: string;
  rows: number;
  distinct_storage_paths: number;
  percent_rows: number;
}

interface DatasetMemoryDistribution {
  dataset: string;
  bytes: number;
  gigabytes: number;
  percent_images: number;
}

interface MemoryPieSegment {
  label: string;
  bytes: number;
  percent_total_disk: number;
  kind: "dataset" | "other_used" | "free";
}

interface DatasetStats {
  rows_distribution: DatasetRowDistribution[];
  memory_distribution: DatasetMemoryDistribution[];
  memory_pie_segments: MemoryPieSegment[];
}

interface DiskStats {
  total_bytes: number;
  used_bytes: number;
  free_bytes: number;
  total_gigabytes: number;
  used_gigabytes: number;
  free_gigabytes: number;
  free_percent: number;
  used_percent: number;
}

interface StorageStatsResponse {
  source_table_exists?: boolean;
  source_table?: string;
  warning?: string | null;
  source: SourceStats;
  embeddings: AnnotationStats;
  vlm: VlmStats;
  storage: StorageStats;
  datasets: DatasetStats;
  disk: DiskStats;
  timestamp: string;
}

interface PieSlice {
  label: string;
  percent: number;
  color: string;
  valueText: string;
}

interface DonutArc extends PieSlice {
  startDeg: number;
  endDeg: number;
}

function formatNumber(value: number): string {
  return value.toLocaleString("ru-RU");
}

function formatBytes(value: number): string {
  if (value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

function pct(value: number): string {
  return `${value.toFixed(2)}%`;
}

function polarToCartesian(
  cx: number,
  cy: number,
  radius: number,
  angleDeg: number
): { x: number; y: number } {
  const angleRad = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(angleRad),
    y: cy + radius * Math.sin(angleRad),
  };
}

function describeDonutArc(
  cx: number,
  cy: number,
  outerRadius: number,
  innerRadius: number,
  startDeg: number,
  endDeg: number
): string {
  const startOuter = polarToCartesian(cx, cy, outerRadius, startDeg);
  const endOuter = polarToCartesian(cx, cy, outerRadius, endDeg);
  const startInner = polarToCartesian(cx, cy, innerRadius, startDeg);
  const endInner = polarToCartesian(cx, cy, innerRadius, endDeg);
  const largeArcFlag = endDeg - startDeg > 180 ? 1 : 0;

  return [
    `M ${startOuter.x} ${startOuter.y}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArcFlag} 1 ${endOuter.x} ${endOuter.y}`,
    `L ${endInner.x} ${endInner.y}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArcFlag} 0 ${startInner.x} ${startInner.y}`,
    "Z",
  ].join(" ");
}

function PieChart({
  title,
  subtitle,
  slices,
}: {
  title: string;
  subtitle: string;
  slices: PieSlice[];
}) {
  const [hoveredLabel, setHoveredLabel] = useState<string | null>(null);
  const normalizedSlices = slices.filter((slice) => slice.percent > 0);
  const cumulativePercents = normalizedSlices.reduce<number[]>(
    (acc, slice, index) => [
      ...acc,
      (index === 0 ? 0 : acc[index - 1]) + slice.percent,
    ],
    []
  );
  const arcs: DonutArc[] = normalizedSlices.map((slice, index) => {
    const startPercent = index === 0 ? 0 : cumulativePercents[index - 1];
    const endPercent = cumulativePercents[index] ?? startPercent;
    return {
      ...slice,
      startDeg: (startPercent / 100) * 360,
      endDeg: (endPercent / 100) * 360,
    };
  });

  const hasHover = hoveredLabel !== null;
  const viewSize = 280;
  const center = viewSize / 2;
  const outerRadius = 116;
  const innerRadius = 88;
  const fallbackRing = describeDonutArc(
    center,
    center,
    outerRadius,
    innerRadius,
    0,
    359.99
  );

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <h3 className="text-lg font-semibold text-slate-900">{title}</h3>
      <p className="mt-1 text-xs text-slate-500">{subtitle}</p>
      <div className="mt-4 flex flex-col items-center gap-4 lg:flex-row lg:items-start">
        <div className="relative h-72 w-72 shrink-0">
          <svg
            viewBox={`0 0 ${viewSize} ${viewSize}`}
            className="h-full w-full"
            onMouseLeave={() => setHoveredLabel(null)}
            aria-label={title}
            role="img"
          >
            <circle
              cx={center}
              cy={center}
              r={outerRadius + 4}
              fill="#f8fafc"
              stroke="#e2e8f0"
              strokeWidth="1"
            />
            {arcs.length === 0 && (
              <path d={fallbackRing} fill="#cbd5e1" opacity={0.8} />
            )}
            {arcs.map((arc) => {
              const midDeg = (arc.startDeg + arc.endDeg) / 2;
              const isActive = hoveredLabel === arc.label;
              const isFaded = hasHover && !isActive;
              const pullDistance = isActive ? 9 : 0;
              const pullX = pullDistance * Math.cos(((midDeg - 90) * Math.PI) / 180);
              const pullY = pullDistance * Math.sin(((midDeg - 90) * Math.PI) / 180);

              return (
                <path
                  key={arc.label}
                  d={describeDonutArc(
                    center,
                    center,
                    outerRadius,
                    innerRadius,
                    arc.startDeg,
                    arc.endDeg
                  )}
                  fill={arc.color}
                  stroke="#ffffff"
                  strokeWidth={isActive ? 4 : 2}
                  transform={`translate(${pullX} ${pullY})`}
                  className="cursor-pointer transition-all duration-300"
                  opacity={isFaded ? 0.25 : 1}
                  onMouseEnter={() => setHoveredLabel(arc.label)}
                />
              );
            })}
            <circle
              cx={center}
              cy={center}
              r={innerRadius - 2}
              fill="#ffffff"
              stroke="#e2e8f0"
              strokeWidth="1"
            />
            <text
              x={center}
              y={center - 2}
              textAnchor="middle"
              className="fill-slate-700 text-[12px] font-semibold"
            >
              {hasHover ? hoveredLabel : "Hover class"}
            </text>
            <text
              x={center}
              y={center + 16}
              textAnchor="middle"
              className="fill-slate-500 text-[11px]"
            >
              {hasHover
                ? pct(
                    slices.find((slice) => slice.label === hoveredLabel)?.percent ?? 0
                  )
                : "Dataset share"}
            </text>
          </svg>
        </div>
        <div className="w-full space-y-2">
          {slices.map((slice) => (
            <div
              key={slice.label}
              className={`flex items-center justify-between rounded-xl border px-3 py-2 text-sm transition-all duration-300 ${
                hoveredLabel === slice.label
                  ? "scale-[1.02] border-slate-400 bg-white shadow-sm"
                  : "border-slate-200 bg-slate-50"
              } ${hasHover && hoveredLabel !== slice.label ? "opacity-40" : "opacity-100"}`}
              onMouseEnter={() => setHoveredLabel(slice.label)}
              onMouseLeave={() => setHoveredLabel(null)}
            >
              <div className="flex items-center gap-2 text-slate-700">
                <span
                  className="h-3 w-3 rounded-full"
                  style={{ backgroundColor: slice.color }}
                />
                <span>{slice.label}</span>
              </div>
              <div className="text-right">
                <div className="font-semibold text-slate-900">{pct(slice.percent)}</div>
                <div className="text-xs text-slate-500">{slice.valueText}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function StoragePanel() {
  const [stats, setStats] = useState<StorageStatsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [warningMessage, setWarningMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [embeddingsRandomCount, setEmbeddingsRandomCount] = useState(100);
  const [vlmRandomCount, setVlmRandomCount] = useState(100);
  const [imagesDeleteCount, setImagesDeleteCount] = useState(10);

  const loadStats = async (showLoader = false) => {
    if (showLoader) {
      setIsLoading(true);
    } else {
      setIsRefreshing(true);
    }
    try {
      const response = await axios.get("/api/storage/stats");
      setStats(response.data);
      setErrorMessage(null);
    } catch (error) {
      const message =
        axios.isAxiosError(error) && error.response?.data?.detail
          ? error.response.data.detail
          : error instanceof Error
            ? error.message
            : "Failed to load storage stats";
      setErrorMessage(message);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    loadStats(true);
  }, []);

  const runStorageAction = async (
    actionId: string,
    fn: () => Promise<void>
  ) => {
    setActionInProgress(actionId);
    setStatusMessage(null);
    setWarningMessage(null);
    setErrorMessage(null);
    try {
      await fn();
      await loadStats(false);
    } catch (error) {
      const message =
        axios.isAxiosError(error) && error.response?.data?.detail
          ? error.response.data.detail
          : axios.isAxiosError(error) && error.response?.data?.error
            ? error.response.data.error
            : error instanceof Error
              ? error.message
              : "Operation failed";
      setErrorMessage(message);
    } finally {
      setActionInProgress(null);
    }
  };

  const deleteRandomEmbeddings = async () => {
    if (!stats) return;
    if (stats.embeddings.annotated_rows <= 0) {
      setWarningMessage("Векторных аннотаций для удаления нет.");
      return;
    }
    await runStorageAction("delete-embeddings", async () => {
      const response = await axios.post("/api/storage/delete-random-embeddings", {
        count: Math.max(1, embeddingsRandomCount),
      });
      setStatusMessage(
        `Удалено векторных аннотаций: ${response.data.deleted_rows} (из ${response.data.selected_rows}).`
      );
    });
  };

  const deleteRandomVlm = async () => {
    if (!stats) return;
    if (stats.vlm.annotated_rows <= 0) {
      setWarningMessage("VLM-аннотаций для удаления нет.");
      return;
    }
    await runStorageAction("delete-vlm", async () => {
      const response = await axios.post("/api/storage/delete-random-vlm", {
        count: Math.max(1, vlmRandomCount),
      });
      setStatusMessage(
        `Удалено VLM-аннотаций: ${response.data.deleted_rows} (из ${response.data.selected_rows}).`
      );
    });
  };

  const deleteDuplicates = async () => {
    const confirmed = window.confirm(
      "Удалить дубликаты в source-таблице по storage_path? Будет оставлена 1 запись на storage_path."
    );
    if (!confirmed) return;

    await runStorageAction("delete-duplicates", async () => {
      const response = await axios.post("/api/storage/delete-duplicates", {
        confirm: true,
      });
      setStatusMessage(`Удалено дубликатов: ${response.data.deleted_rows}.`);
    });
  };

  const deleteRandomImages = async () => {
    const count = Math.max(1, imagesDeleteCount);
    const confirmed = window.confirm(
      `Удалить ${count} случайных изображений из стоража и все связанные записи/разметку? Действие необратимо.`
    );
    if (!confirmed) return;

    await runStorageAction("delete-images", async () => {
      const response = await axios.post("/api/storage/delete-random-images", {
        count,
        confirm: true,
      });
      setStatusMessage(
        `Удалено изображений: ${response.data.deleted_images}. Удалено строк source: ${response.data.deleted_source_rows}. Ошибок: ${response.data.failed_images}.`
      );
      if (Number(response.data.failed_images || 0) > 0) {
        setWarningMessage(
          "Часть изображений не удалось удалить. Проверьте details в ответе backend (errors)."
        );
      }
    });
  };

  if (isLoading) {
    return (
      <section className="px-6 pt-10 pb-16">
        <div className="mx-auto max-w-6xl rounded-3xl border border-slate-200 bg-white p-6 text-sm text-slate-500 shadow-sm">
          Загрузка статистики хранилища...
        </div>
      </section>
    );
  }

  if (!stats) {
    return (
      <section className="px-6 pt-10 pb-16">
        <div className="mx-auto max-w-6xl rounded-3xl border border-rose-200 bg-rose-50 p-6 text-sm font-semibold text-rose-700 shadow-sm">
          {errorMessage ?? "Не удалось загрузить статистику хранилища."}
        </div>
      </section>
    );
  }

  const avgImageBytes =
    stats.source.distinct_storage_paths > 0
      ? stats.storage.total_bytes / stats.source.distinct_storage_paths
      : 0;
  const embeddingsRemainingBytes = Math.round(
    avgImageBytes * stats.embeddings.pending_rows
  );
  const vlmRemainingBytes = Math.round(avgImageBytes * stats.vlm.pending_rows);
  const sourceTableMissing = stats.source_table_exists === false;

  const rowPalette = [
    "#2563eb",
    "#06b6d4",
    "#10b981",
    "#8b5cf6",
    "#f59e0b",
    "#ec4899",
    "#f97316",
  ];
  const rowsPieSlices: PieSlice[] = stats.datasets.rows_distribution.map(
    (item, index) => ({
      label: item.dataset,
      percent: item.percent_rows,
      color: rowPalette[index % rowPalette.length],
      valueText: `${formatNumber(item.rows)} строк`,
    })
  );

  const memoryPalette = [
    "#3b82f6",
    "#14b8a6",
    "#8b5cf6",
    "#f59e0b",
    "#f97316",
    "#ec4899",
  ];
  const memoryPieSlices: PieSlice[] = stats.datasets.memory_pie_segments.map(
    (segment, index) => {
      let color = memoryPalette[index % memoryPalette.length];
      if (segment.kind === "free") color = "#34d399";
      if (segment.kind === "other_used") color = "#64748b";
      return {
        label:
          segment.label === "free"
            ? "free"
            : segment.label === "other_used"
              ? "other_used"
              : segment.label,
        percent: segment.percent_total_disk,
        color,
        valueText: formatBytes(segment.bytes),
      };
    }
  );

  return (
    <section className="px-6 pt-10 pb-16">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center gap-4">
            <div>
              <h2 className="text-2xl font-semibold text-slate-900">Storage</h2>
              <p className="mt-2 text-sm text-slate-600">
                Сводка по разметке, очистке и объёму данных.
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Последнее обновление: {stats.timestamp}
              </p>
            </div>
            <button
              type="button"
              onClick={() => loadStats(false)}
              disabled={isRefreshing}
              className="ml-auto rounded-full bg-sky-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isRefreshing ? "Обновляем..." : "Обновить"}
            </button>
          </div>

          {statusMessage && (
            <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800">
              {statusMessage}
            </div>
          )}
          {warningMessage && (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
              {warningMessage}
            </div>
          )}
          {sourceTableMissing && (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
              {stats.warning ??
                "Данные еще не скачаны: исходная таблица с кадрами отсутствует. Пока отображается пустая статистика."}
            </div>
          )}
          {errorMessage && (
            <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">
              {errorMessage}
            </div>
          )}
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <h3 className="text-lg font-semibold text-slate-900">Cleanup & Re-Annotation</h3>
          <p className="mt-1 text-sm text-slate-600">
            Управление случайной де-разметкой, дубликатами и удалением изображений.
          </p>
          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <label className="flex items-center gap-3 text-sm text-slate-700">
                Random N for vector reset
                <input
                  type="number"
                  min={1}
                  value={embeddingsRandomCount}
                  onChange={(event) =>
                    setEmbeddingsRandomCount(Number(event.target.value) || 1)
                  }
                  className="w-28 rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900"
                />
                <button
                  type="button"
                  onClick={deleteRandomEmbeddings}
                  disabled={actionInProgress !== null}
                  className="rounded-full bg-indigo-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {actionInProgress === "delete-embeddings" ? "Working..." : "Delete random embeddings"}
                </button>
              </label>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <label className="flex items-center gap-3 text-sm text-slate-700">
                Random N for VLM reset
                <input
                  type="number"
                  min={1}
                  value={vlmRandomCount}
                  onChange={(event) => setVlmRandomCount(Number(event.target.value) || 1)}
                  className="w-28 rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900"
                />
                <button
                  type="button"
                  onClick={deleteRandomVlm}
                  disabled={actionInProgress !== null}
                  className="rounded-full bg-violet-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {actionInProgress === "delete-vlm" ? "Working..." : "Delete random VLM"}
                </button>
              </label>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center gap-3 text-sm text-slate-700">
                <button
                  type="button"
                  onClick={deleteDuplicates}
                  disabled={actionInProgress !== null}
                  className="rounded-full bg-amber-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {actionInProgress === "delete-duplicates" ? "Working..." : "Delete duplicates"}
                </button>
                <span>Удаляет дубликаты строк в source по `storage_path`.</span>
              </div>
            </div>

            <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4">
              <label className="flex items-center gap-3 text-sm text-rose-800">
                Random N images hard delete
                <input
                  type="number"
                  min={1}
                  value={imagesDeleteCount}
                  onChange={(event) =>
                    setImagesDeleteCount(Number(event.target.value) || 1)
                  }
                  className="w-24 rounded-lg border border-rose-300 bg-white px-3 py-2 text-slate-900"
                />
                <button
                  type="button"
                  onClick={deleteRandomImages}
                  disabled={actionInProgress !== null}
                  className="rounded-full bg-rose-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {actionInProgress === "delete-images" ? "Working..." : "Delete images + metadata"}
                </button>
              </label>
            </div>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <h3 className="text-lg font-semibold text-slate-900">Dataset Coverage</h3>
            <div className="mt-4 space-y-2 text-sm text-slate-700">
              <div>Строк в источнике: {formatNumber(stats.source.total_rows)}</div>
              <div>Строк с `storage_path`: {formatNumber(stats.source.rows_with_storage_path)}</div>
              <div>Уникальных сцен: {formatNumber(stats.source.distinct_storage_paths)}</div>
              <div>Дубликатов: {formatNumber(stats.source.duplicate_storage_rows)}</div>
            </div>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <h3 className="text-lg font-semibold text-slate-900">Vector Annotation</h3>
            <div className="mt-4 text-sm text-slate-700">
              <div className="mb-2 flex justify-between">
                <span>Размечено</span>
                <span className="font-semibold">{pct(stats.embeddings.annotated_percent)}</span>
              </div>
              <div className="h-2 w-full rounded-full bg-slate-200">
                <div
                  className="h-2 rounded-full bg-emerald-500"
                  style={{ width: `${Math.min(stats.embeddings.annotated_percent, 100)}%` }}
                />
              </div>
              <div className="mt-3">Осталось: {formatNumber(stats.embeddings.pending_rows)}</div>
              <div>Размечено: {formatNumber(stats.embeddings.annotated_rows)}</div>
              <div>Не размечено: {pct(stats.embeddings.pending_percent)}</div>
              <div className="mt-2 text-xs text-slate-500">
                Оценка оставшегося объёма: {formatBytes(embeddingsRemainingBytes)}
              </div>
            </div>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <h3 className="text-lg font-semibold text-slate-900">VLM Annotation</h3>
            <div className="mt-4 text-sm text-slate-700">
              <div className="mb-2 flex justify-between">
                <span>Размечено</span>
                <span className="font-semibold">{pct(stats.vlm.annotated_percent)}</span>
              </div>
              <div className="h-2 w-full rounded-full bg-slate-200">
                <div
                  className="h-2 rounded-full bg-indigo-500"
                  style={{ width: `${Math.min(stats.vlm.annotated_percent, 100)}%` }}
                />
              </div>
              <div className="mt-3">Осталось: {formatNumber(stats.vlm.pending_rows)}</div>
              <div>Размечено: {formatNumber(stats.vlm.annotated_rows)}</div>
              <div>Не размечено: {pct(stats.vlm.pending_percent)}</div>
              <div>Поля VLM: {formatNumber(stats.vlm.configured_fields)}</div>
              <div className="mt-2 text-xs text-slate-500">
                Оценка оставшегося объёма: {formatBytes(vlmRemainingBytes)}
              </div>
            </div>
          </div>
        </div>

        <div className="grid gap-6 xl:grid-cols-2">
          <PieChart
            title="Dataset Share by Rows"
            subtitle="Доля датасетов от общего числа строк"
            slices={rowsPieSlices}
          />
          <PieChart
            title="Dataset Share by Memory + Free"
            subtitle="Доля датасетов от всего диска, включая свободное место"
            slices={memoryPieSlices}
          />
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <h3 className="text-lg font-semibold text-slate-900">Image Storage</h3>
          <div className="mt-4 grid gap-4 md:grid-cols-4">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
              Объектов: <span className="font-semibold">{formatNumber(stats.storage.total_objects)}</span>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
              Данные изображений: <span className="font-semibold">{formatBytes(stats.storage.total_bytes)}</span>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
              Диск свободно: <span className="font-semibold">{formatBytes(stats.disk.free_bytes)}</span>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
              Диск занято: <span className="font-semibold">{pct(stats.disk.used_percent)}</span>
            </div>
          </div>

          <div className="mt-5 overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Bucket
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Objects
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Size
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 bg-white">
                {stats.storage.bucket_stats.map((bucket) => (
                  <tr key={bucket.bucket}>
                    <td className="px-4 py-3 text-sm text-slate-800">{bucket.bucket}</td>
                    <td className="px-4 py-3 text-sm text-slate-700">{formatNumber(bucket.objects)}</td>
                    <td className="px-4 py-3 text-sm text-slate-700">{formatBytes(bucket.bytes)}</td>
                    <td className="px-4 py-3 text-sm">
                      {bucket.error ? (
                        <span className="font-semibold text-amber-700">
                          Warning: {bucket.error}
                        </span>
                      ) : (
                        <span className="font-semibold text-emerald-700">OK</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}
