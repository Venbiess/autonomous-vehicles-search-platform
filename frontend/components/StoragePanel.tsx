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

interface ObjectListItem {
  object_id: string;
  storage_path: string;
  bucket: string;
  key: string;
  size_bytes: number;
  content_type: string;
  created_at: string;
}

interface ObjectListResponse {
  items: ObjectListItem[];
  next_cursor?: string;
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
  const [objectsLoading, setObjectsLoading] = useState(false);
  const [objects, setObjects] = useState<ObjectListItem[]>([]);
  const [objectsPageSize, setObjectsPageSize] = useState(5);
  const [objectsCursor, setObjectsCursor] = useState("");
  const [objectsPrevCursors, setObjectsPrevCursors] = useState<string[]>([]);
  const [objectsNextCursor, setObjectsNextCursor] = useState("");
  const [objectsPage, setObjectsPage] = useState(1);
  const [previewObjectId, setPreviewObjectId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [warningMessage, setWarningMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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

  const loadObjectsPage = async (
    cursor: string,
    prevCursors: string[],
    page: number
  ) => {
    setObjectsLoading(true);
    setErrorMessage(null);
    try {
      const response = await axios.get<ObjectListResponse>("/api/storage/objects", {
        params: {
          limit: objectsPageSize,
          ...(cursor ? { cursor } : {}),
        },
      });
      setObjects(response.data.items ?? []);
      setObjectsCursor(cursor);
      setObjectsPrevCursors(prevCursors);
      setObjectsNextCursor(response.data.next_cursor ?? "");
      setObjectsPage(page);
    } catch (error) {
      const message =
        axios.isAxiosError(error) && error.response?.data?.detail
          ? error.response.data.detail
          : axios.isAxiosError(error) && error.response?.data?.error
            ? error.response.data.error
            : error instanceof Error
              ? error.message
              : "Failed to load objects";
      setErrorMessage(message);
    } finally {
      setObjectsLoading(false);
    }
  };

  useEffect(() => {
    loadObjectsPage("", [], 1);
  }, [objectsPageSize]);

  const runStorageAction = async (actionId: string, fn: () => Promise<void>) => {
    setActionInProgress(actionId);
    setStatusMessage(null);
    setWarningMessage(null);
    setErrorMessage(null);
    try {
      await fn();
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

  const goToNextObjectsPage = async () => {
    if (!objectsNextCursor || objectsLoading) return;
    await loadObjectsPage(
      objectsNextCursor,
      [...objectsPrevCursors, objectsCursor],
      objectsPage + 1
    );
  };

  const goToPrevObjectsPage = async () => {
    if (objectsPrevCursors.length === 0 || objectsLoading) return;
    const prevCursor = objectsPrevCursors[objectsPrevCursors.length - 1] ?? "";
    const nextPrev = objectsPrevCursors.slice(0, -1);
    await loadObjectsPage(prevCursor, nextPrev, Math.max(1, objectsPage - 1));
  };

  const deleteObject = async (objectId: string) => {
    const confirmed = window.confirm(
      `Удалить объект ${objectId} из storage, векторов и связанных аннотаций?`
    );
    if (!confirmed) return;

    await runStorageAction(`delete-object-${objectId}`, async () => {
      await axios.delete(`/api/storage/objects/${encodeURIComponent(objectId)}`);
      setStatusMessage(`Объект ${objectId} удален.`);
      const shouldGoPrev = objects.length === 1 && objectsPrevCursors.length > 0;
      const cursor = shouldGoPrev
        ? objectsPrevCursors[objectsPrevCursors.length - 1] ?? ""
        : objectsCursor;
      const prevCursors = shouldGoPrev
        ? objectsPrevCursors.slice(0, -1)
        : objectsPrevCursors;
      const page = shouldGoPrev ? Math.max(1, objectsPage - 1) : objectsPage;
      await Promise.all([
        loadStats(false),
        loadObjectsPage(cursor, prevCursors, page),
      ]);
      if (previewObjectId === objectId) {
        setPreviewObjectId(null);
      }
    });
  };

  const refreshAll = async () => {
    setStatusMessage(null);
    setWarningMessage(null);
    setErrorMessage(null);
    setIsRefreshing(true);
    try {
      await Promise.all([
        loadStats(false),
        loadObjectsPage(objectsCursor, objectsPrevCursors, objectsPage),
      ]);
    } finally {
      setIsRefreshing(false);
    }
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
              onClick={refreshAll}
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
          <div className="flex flex-wrap items-center gap-3">
            <div>
              <h3 className="text-lg font-semibold text-slate-900">Object Browser</h3>
              <p className="mt-1 text-sm text-slate-600">
                Листинг объектов с постраничным просмотром, превью и удалением конкретного объекта.
              </p>
            </div>
            <div className="ml-auto flex items-center gap-2 text-sm text-slate-700">
              <span>На странице:</span>
              <select
                value={objectsPageSize}
                onChange={(event) => setObjectsPageSize(Number(event.target.value))}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900"
              >
                {[5, 10, 20, 50, 100].map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-5 overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">Object ID</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">Bucket / Key</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">Size</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">Created</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 bg-white">
                {objects.length === 0 && !objectsLoading && (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-sm text-slate-500">
                      Объекты не найдены.
                    </td>
                  </tr>
                )}
                {objects.map((item) => (
                  <tr key={item.object_id}>
                    <td className="px-4 py-3 text-xs text-slate-800">{item.object_id}</td>
                    <td className="px-4 py-3 text-sm text-slate-700">
                      <div className="font-medium">{item.bucket}</div>
                      <div className="text-xs text-slate-500 break-all">{item.key}</div>
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-700">{formatBytes(item.size_bytes)}</td>
                    <td className="px-4 py-3 text-sm text-slate-700">
                      {item.created_at ? new Date(item.created_at).toLocaleString("ru-RU") : "-"}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setPreviewObjectId(item.object_id)}
                          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
                        >
                          Preview
                        </button>
                        <a
                          href={`/api/objects/${encodeURIComponent(item.object_id)}`}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
                        >
                          Open
                        </a>
                        <button
                          type="button"
                          onClick={() => deleteObject(item.object_id)}
                          disabled={actionInProgress !== null}
                          className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {actionInProgress === `delete-object-${item.object_id}` ? "Deleting..." : "Delete"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex items-center justify-between">
            <div className="text-sm text-slate-600">
              Страница {objectsPage} {objectsLoading ? "• loading..." : ""}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={goToPrevObjectsPage}
                disabled={objectsPrevCursors.length === 0 || objectsLoading}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                ← Назад
              </button>
              <button
                type="button"
                onClick={goToNextObjectsPage}
                disabled={!objectsNextCursor || objectsLoading}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Вперёд →
              </button>
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

      {previewObjectId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
          onClick={() => setPreviewObjectId(null)}
        >
          <div
            className="max-h-[90vh] w-full max-w-5xl overflow-auto rounded-2xl bg-white p-4 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between gap-4">
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">
                  Object Preview
                </div>
                <div className="break-all text-sm font-semibold text-slate-900">
                  {previewObjectId}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPreviewObjectId(null)}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                Close
              </button>
            </div>
            <img
              src={`/api/objects/${encodeURIComponent(previewObjectId)}`}
              alt={previewObjectId}
              className="max-h-[75vh] w-full rounded-xl border border-slate-200 bg-slate-100 object-contain"
            />
          </div>
        </div>
      )}
    </section>
  );
}
