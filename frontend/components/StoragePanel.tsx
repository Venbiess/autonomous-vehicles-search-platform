"use client";

import { useEffect, useRef, useState } from "react";
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
  all_bucket_stats?: BucketStats[];
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
  dataset_visibility?: Record<string, boolean>;
  hidden_datasets?: string[];
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

interface ConfirmDialogState {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
}

type TransferKind = "full" | "vlm" | "embeddings";

const SNAPSHOT_ACTION_IDS = [
  "download-full",
  "download-embeddings",
  "download-vlm",
  "import-snapshot",
] as const;

type SnapshotActionId = (typeof SNAPSHOT_ACTION_IDS)[number];

interface SnapshotTransferSize {
  loadedBytes: number;
  totalBytes: number | null;
}

interface SnapshotProgressMeta {
  phase: string;
  status: string;
  hint?: string;
}

function jobTypeToSnapshotActionId(jobType: string): SnapshotActionId | null {
  if (jobType === "snapshot_import") return "import-snapshot";
  if (jobType === "snapshot_export_full") return "download-full";
  if (jobType === "snapshot_export_embeddings") return "download-embeddings";
  if (jobType === "snapshot_export_vlm") return "download-vlm";
  return null;
}

function snapshotActionIdToJobType(actionId: SnapshotActionId): string {
  if (actionId === "download-full") return "snapshot_export_full";
  if (actionId === "download-embeddings") return "snapshot_export_embeddings";
  if (actionId === "download-vlm") return "snapshot_export_vlm";
  return "snapshot_import";
}

function isSnapshotActionId(value: string): value is SnapshotActionId {
  return (SNAPSHOT_ACTION_IDS as readonly string[]).includes(value);
}

function toErrorMessage(value: unknown): string {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const nested =
      toErrorMessage(obj.detail) ||
      toErrorMessage(obj.error) ||
      toErrorMessage(obj.message);
    if (nested) {
      return nested;
    }
    if (typeof obj.code === "string" && obj.code.trim()) {
      return obj.code;
    }
  }
  return "";
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

function fileNameFromDisposition(disposition: string | null): string {
  if (!disposition) return "";
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]).trim();
    } catch {
      return utf8Match[1].trim();
    }
  }
  const match = disposition.match(/filename="?([^";]+)"?/i);
  return match?.[1]?.trim() || "";
}

function buildImportSummary(result: unknown): string {
  if (!result || typeof result !== "object") {
    return "Импорт завершен.";
  }
  const payload = result as Record<string, unknown>;
  const format = String(payload.format || "").trim();

  if (format === "avsp.storage.snapshot.v1") {
    const objects =
      payload.objects && typeof payload.objects === "object"
        ? (payload.objects as Record<string, unknown>)
        : {};
    const embeddings =
      payload.embeddings && typeof payload.embeddings === "object"
        ? (payload.embeddings as Record<string, unknown>)
        : {};
    const vlm =
      payload.vlm && typeof payload.vlm === "object"
        ? (payload.vlm as Record<string, unknown>)
        : {};
    return (
      `Импорт полного снапшота: объектов ${formatNumber(Number(objects.uploaded || 0))}` +
      `, embeddings ${formatNumber(Number(embeddings.upserted || 0))}` +
      `, VLM аннотаций ${formatNumber(Number(vlm.upserted_annotations || 0))}.`
    );
  }

  if (format === "avsp.embedder.annotations.v1") {
    const embeddings =
      payload.embeddings && typeof payload.embeddings === "object"
        ? (payload.embeddings as Record<string, unknown>)
        : {};
    return `Импорт embeddings: upsert ${formatNumber(Number(embeddings.upserted || 0))}.`;
  }

  if (format === "avsp.vlm.annotations.v1") {
    const vlm =
      payload.vlm && typeof payload.vlm === "object"
        ? (payload.vlm as Record<string, unknown>)
        : {};
    return (
      `Импорт VLM: полей ${formatNumber(Number(vlm.saved_fields || 0))}` +
      `, аннотаций ${formatNumber(Number(vlm.upserted_annotations || 0))}.`
    );
  }

  return "Импорт завершен.";
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

export default function StoragePanel({
  showSnapshotSection = true,
}: {
  showSnapshotSection?: boolean;
}) {
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
  const [objectsSearchQuery, setObjectsSearchQuery] = useState("");
  const [objectsDatasetFilter, setObjectsDatasetFilter] = useState("");
  const [filteredObjects, setFilteredObjects] = useState<ObjectListItem[] | null>(null);
  const [filteredObjectsLoading, setFilteredObjectsLoading] = useState(false);
  const [filteredObjectsPage, setFilteredObjectsPage] = useState(1);
  const [previewObjectId, setPreviewObjectId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [warningMessage, setWarningMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [randomEmbeddingsCount, setRandomEmbeddingsCount] = useState(100);
  const [randomVlmCount, setRandomVlmCount] = useState(100);
  const [randomHardDeleteCount, setRandomHardDeleteCount] = useState(10);
  const [transferFile, setTransferFile] = useState<File | null>(null);
  const [transferFileInputKey, setTransferFileInputKey] = useState(0);
  const [cleanupDatasetFilter, setCleanupDatasetFilter] = useState("all");
  const [datasetDeleteProgress, setDatasetDeleteProgress] = useState<
    Record<string, number>
  >({});
  const [snapshotActionProgress, setSnapshotActionProgress] = useState<
    Partial<Record<SnapshotActionId, number>>
  >({});
  const [snapshotTransferSize, setSnapshotTransferSize] = useState<
    Partial<Record<SnapshotActionId, SnapshotTransferSize>>
  >({});
  const [snapshotProgressMeta, setSnapshotProgressMeta] = useState<
    Partial<Record<SnapshotActionId, SnapshotProgressMeta>>
  >({});
  const [snapshotExportInlineMessage, setSnapshotExportInlineMessage] = useState<string | null>(null);
  const [snapshotImportInlineMessage, setSnapshotImportInlineMessage] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const [confirmDialogBusy, setConfirmDialogBusy] = useState(false);
  const snapshotProgressTimersRef = useRef<
    Partial<Record<SnapshotActionId, ReturnType<typeof setInterval>>>
  >({});
  const snapshotAbortControllersRef = useRef<
    Partial<Record<SnapshotActionId, AbortController>>
  >({});
  const snapshotExportPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const snapshotExportPollTokenRef = useRef(0);
  const snapshotImportPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const snapshotImportPollTokenRef = useRef(0);

  useEffect(() => {
    if (!confirmDialog && !previewObjectId) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      if (confirmDialog && !confirmDialogBusy) {
        setConfirmDialog(null);
        return;
      }
      if (previewObjectId) {
        setPreviewObjectId(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [confirmDialog, confirmDialogBusy, previewObjectId]);

  const extractAxiosErrorMessage = (
    error: unknown,
    fallback: string
  ): string => {
    if (axios.isAxiosError(error)) {
      const payload = error.response?.data;
      const payloadMessage = toErrorMessage(payload);
      if (payloadMessage) {
        return payloadMessage;
      }
      if (typeof error.message === "string" && error.message.trim()) {
        return error.message;
      }
      return fallback;
    }
    if (error instanceof Error && error.message.trim()) {
      return error.message;
    }
    return fallback;
  };

  const isCancelledActionError = (error: unknown): boolean => {
    if (axios.isAxiosError(error) && error.code === "ERR_CANCELED") {
      return true;
    }
    if (error && typeof error === "object") {
      const record = error as Record<string, unknown>;
      const code = String(record.code || "").toUpperCase();
      const message = String(record.message || "").toLowerCase();
      if (code === "TRANSFER_CANCELLED" || code === "ERR_CANCELED") {
        return true;
      }
      if (
        message.includes("canceled") ||
        message.includes("cancelled") ||
        message.includes("transfer cancelled")
      ) {
        return true;
      }
    }
    return false;
  };

  const clearSnapshotProgressTimer = (actionId: SnapshotActionId) => {
    const timer = snapshotProgressTimersRef.current[actionId];
    if (timer) {
      clearInterval(timer);
      delete snapshotProgressTimersRef.current[actionId];
    }
  };

  const clearSnapshotProgress = (actionId: SnapshotActionId) => {
    clearSnapshotProgressTimer(actionId);
    setSnapshotActionProgress((prev) => {
      const next = { ...prev };
      delete next[actionId];
      return next;
    });
    setSnapshotTransferSize((prev) => {
      const next = { ...prev };
      delete next[actionId];
      return next;
    });
    setSnapshotProgressMeta((prev) => {
      const next = { ...prev };
      delete next[actionId];
      return next;
    });
  };

  const updateSnapshotTransferSize = (
    actionId: SnapshotActionId,
    loadedBytes: number,
    totalBytes: number | null = null,
    options?: { monotonic?: boolean }
  ) => {
    const monotonic = options?.monotonic ?? true;
    setSnapshotTransferSize((prev) => ({
      ...prev,
      [actionId]: (() => {
        const current = prev[actionId];
        const nextLoaded = Math.max(0, Number(loadedBytes || 0));
        const normalizedTotal =
          totalBytes === null || !Number.isFinite(Number(totalBytes))
            ? null
            : Math.max(0, Number(totalBytes));
        const loaded = monotonic && current
          ? Math.max(Number(current.loadedBytes || 0), nextLoaded)
          : nextLoaded;
        const total = monotonic
          ? normalizedTotal === null
            ? current?.totalBytes ?? null
            : Math.max(Number(current?.totalBytes || 0), normalizedTotal)
          : normalizedTotal;
        const clampedLoaded =
          total !== null && total > 0 ? Math.min(loaded, total) : loaded;
        return {
          loadedBytes: clampedLoaded,
          totalBytes: total,
        };
      })(),
    }));
  };

  const updateSnapshotProgressMeta = (
    actionId: SnapshotActionId,
    patch: Partial<SnapshotProgressMeta>
  ) => {
    setSnapshotProgressMeta((prev) => ({
      ...prev,
      [actionId]: {
        phase: patch.phase ?? prev[actionId]?.phase ?? "",
        status: patch.status ?? prev[actionId]?.status ?? "",
        hint: patch.hint ?? prev[actionId]?.hint ?? "",
      },
    }));
  };

  const setSnapshotAbortController = (
    actionId: SnapshotActionId,
    controller: AbortController | null
  ) => {
    if (!controller) {
      delete snapshotAbortControllersRef.current[actionId];
      return;
    }
    snapshotAbortControllersRef.current[actionId] = controller;
  };

  const stopSnapshotExportProgressPoll = () => {
    snapshotExportPollTokenRef.current += 1;
    const timer = snapshotExportPollTimerRef.current;
    if (timer) {
      clearTimeout(timer);
      snapshotExportPollTimerRef.current = null;
    }
  };

  const stopSnapshotImportProgressPoll = () => {
    snapshotImportPollTokenRef.current += 1;
    const timer = snapshotImportPollTimerRef.current;
    if (timer) {
      clearTimeout(timer);
      snapshotImportPollTimerRef.current = null;
    }
  };

  const startSnapshotExportProgressPoll = (
    exportId: string,
    actionId: SnapshotActionId
  ) => {
    stopSnapshotExportProgressPoll();
    const token = snapshotExportPollTokenRef.current;

    const scheduleNext = (delayMs: number) => {
      snapshotExportPollTimerRef.current = setTimeout(async () => {
        if (token !== snapshotExportPollTokenRef.current) {
          return;
        }
        try {
          const response = await axios.get("/api/storage/transfer/export-progress", {
            params: { export_id: exportId },
          });
          const payload =
            response.data && typeof response.data === "object"
              ? (response.data as Record<string, unknown>)
              : {};
          const phase = String(payload.phase || "").trim().toLowerCase();
          const status = String(payload.status || "").trim().toLowerCase();
          const bytesWritten = Math.max(0, Number(payload.bytes_written || 0));
          const preparedBytes = Math.max(0, Number(payload.prepared_bytes || 0));
          const preparedObjects = Math.max(0, Number(payload.prepared_objects || 0));
          const archiveBytesRaw = Number(payload.archive_bytes || 0);
          const archiveBytes = Number.isFinite(archiveBytesRaw) && archiveBytesRaw > 0
            ? archiveBytesRaw
            : null;
          let shownBytes = bytesWritten;
          let shownTotal: number | null = archiveBytes;
          if (phase === "preparing") {
            shownBytes = Math.max(bytesWritten, preparedBytes);
            shownTotal = null;
          } else if (phase === "archiving") {
            shownBytes = Math.max(0, bytesWritten);
            shownTotal = archiveBytes ?? (preparedBytes > 0 ? preparedBytes : null);
          } else if (phase === "streaming" || phase === "done") {
            shownBytes = Math.max(0, bytesWritten);
            shownTotal = archiveBytes ?? (shownBytes > 0 ? shownBytes : null);
          }
          updateSnapshotTransferSize(actionId, shownBytes, shownTotal, { monotonic: false });

          let hint = "";
          if (shownBytes <= 0) {
            if (phase === "preparing") {
              hint =
                preparedObjects > 0
                  ? `Preparing: ${formatNumber(preparedObjects)} objects`
                  : "Preparing snapshot...";
            } else if (phase === "archiving") {
              hint = "Archiving snapshot...";
            } else if (phase === "streaming") {
              hint = "Streaming snapshot...";
            }
          }
          updateSnapshotProgressMeta(actionId, { phase, status, hint });

          if (shownTotal && shownTotal > 0) {
            const ratio = Math.min(1, Math.max(0, shownBytes / shownTotal));
            updateSnapshotProgress(actionId, ratio * 100, "max");
          }

          if (status === "error" || phase === "error") {
            setSnapshotExportInlineMessage("Ошибка при создании архива выгрузки.");
            setActionInProgress((current) => (current === actionId ? null : current));
            return;
          }
          if (status === "cancelled" || phase === "cancelled") {
            setSnapshotExportInlineMessage("Выгрузка и создание архива отменены.");
            setActionInProgress((current) => (current === actionId ? null : current));
            return;
          }
          if (status === "done" || phase === "done") {
            setActionInProgress((current) => (current === actionId ? null : current));
            return;
          }
        } catch {
          // Best effort polling; ignore transient failures.
        }
        if (token === snapshotExportPollTokenRef.current) {
          scheduleNext(350);
        }
      }, delayMs);
    };

    scheduleNext(0);
  };

  const startSnapshotImportProgressPoll = (
    importId: string,
    actionId: SnapshotActionId
  ) => {
    stopSnapshotImportProgressPoll();
    const token = snapshotImportPollTokenRef.current;

    const scheduleNext = (delayMs: number) => {
      snapshotImportPollTimerRef.current = setTimeout(async () => {
        if (token !== snapshotImportPollTokenRef.current) {
          return;
        }
        try {
          const response = await axios.get("/api/jobs");
          const jobs = Array.isArray(response.data?.jobs)
            ? (response.data.jobs as Array<Record<string, unknown>>)
            : [];
          const targetJob = jobs.find((job) => {
            const type = String(job?.job_type || "").trim();
            if (type !== "snapshot_import") return false;
            const config =
              job?.job_config && typeof job.job_config === "object"
                ? (job.job_config as Record<string, unknown>)
                : {};
            return String(config.import_id || "").trim() === importId;
          });
          if (!targetJob) {
            if (token === snapshotImportPollTokenRef.current) {
              scheduleNext(450);
            }
            return;
          }

          const status = String(targetJob.status || "").trim().toLowerCase();
          const phase = String(targetJob.phase || "").trim().toLowerCase() || "processing";
          const progress = Math.max(0, Math.min(100, Number(targetJob.progress || 0)));
          const totalSeen = Math.max(0, Number(targetJob.total_seen || 0));
          const totalPlannedRaw = Number(targetJob.total_planned || targetJob.total_limit || 0);
          const totalPlanned =
            Number.isFinite(totalPlannedRaw) && totalPlannedRaw > 0 ? totalPlannedRaw : null;

          clearSnapshotProgressTimer(actionId);
          updateSnapshotProgress(actionId, progress, "set");
          updateSnapshotTransferSize(actionId, totalSeen, totalPlanned, { monotonic: true });
          updateSnapshotProgressMeta(actionId, {
            phase,
            status,
            hint: phase === "uploading" ? "Uploading snapshot..." : "Extracting and applying snapshot...",
          });
          if (status === "running") {
            if (phase === "processing") {
              setSnapshotImportInlineMessage("Разархивация и импорт снапшота продолжаются...");
            } else if (phase === "uploading") {
              setSnapshotImportInlineMessage("Загрузка снапшота продолжается...");
            }
          }

          if (status === "error") {
            setSnapshotImportInlineMessage("Ошибка при импорте снапшота.");
            setActionInProgress((current) => (current === actionId ? null : current));
            return;
          }
          if (status === "cancelled") {
            setSnapshotImportInlineMessage("Импорт и распаковка архива отменены.");
            setActionInProgress((current) => (current === actionId ? null : current));
            return;
          }
          if (status === "success") {
            setActionInProgress((current) => (current === actionId ? null : current));
            return;
          }
        } catch {
          // Best effort polling; ignore transient failures.
        }
        if (token === snapshotImportPollTokenRef.current) {
          scheduleNext(450);
        }
      }, delayMs);
    };

    scheduleNext(0);
  };

  const cancelSnapshotAction = async (actionId: SnapshotActionId) => {
    const controller = snapshotAbortControllersRef.current[actionId];
    if (controller) {
      controller.abort();
    } else {
      try {
        const jobsResponse = await axios.get("/api/jobs");
        const jobs = Array.isArray(jobsResponse.data?.jobs)
          ? (jobsResponse.data.jobs as Array<Record<string, unknown>>)
          : [];
        const targetType = snapshotActionIdToJobType(actionId);
        const runningJob = jobs.find((job) => {
          const type = String(job?.job_type || "").trim();
          const status = String(job?.status || "").toLowerCase();
          return type === targetType && status === "running";
        });
        const jobID = String(runningJob?.job_id || "").trim();
        if (jobID) {
          await axios.post("/api/jobs/cancel", { job_id: jobID });
        }
      } catch {
        // no-op
      }
    }
    updateSnapshotProgressMeta(actionId, {
      status: "cancelled",
      hint: "Cancelling...",
    });
    if (actionId === "import-snapshot") {
      stopSnapshotImportProgressPoll();
      setSnapshotImportInlineMessage("Импорт и распаковка архива отменены.");
      return;
    }
    setSnapshotExportInlineMessage("Выгрузка и создание архива отменены.");
  };

  const askCancelSnapshotAction = (actionId: SnapshotActionId) => {
    const title =
      actionId === "import-snapshot" ? "Cancel snapshot import" : "Cancel snapshot export";
    const description =
      actionId === "import-snapshot"
        ? "Остановить импорт и распаковку snapshot?"
        : "Остановить создание и выгрузку snapshot?";
    openConfirmDialog({
      title,
      description,
      confirmLabel: "Остановить",
      onConfirm: async () => {
        await cancelSnapshotAction(actionId);
      },
    });
  };

  const updateSnapshotProgress = (
    actionId: SnapshotActionId,
    nextProgress: number,
    strategy: "set" | "max" = "set"
  ) => {
    const clamped = Math.max(0, Math.min(100, nextProgress));
    setSnapshotActionProgress((prev) => {
      const current = Number(prev[actionId] || 0);
      const value = strategy === "max" ? Math.max(current, clamped) : clamped;
      return { ...prev, [actionId]: value };
    });
  };

  const startSnapshotProgressAnimation = (
    actionId: SnapshotActionId,
    options?: {
      from?: number;
      cap?: number;
      stepMin?: number;
      stepMax?: number;
      intervalMs?: number;
    }
  ) => {
    clearSnapshotProgressTimer(actionId);
    const from = Math.max(0, Math.min(100, Number(options?.from ?? 0)));
    const cap = Math.max(from, Math.min(100, Number(options?.cap ?? 95)));
    const stepMin = Math.max(0.1, Number(options?.stepMin ?? 0.5));
    const stepMax = Math.max(stepMin, Number(options?.stepMax ?? 1.5));
    const intervalMs = Math.max(80, Number(options?.intervalMs ?? 180));

    updateSnapshotProgress(actionId, from, "max");
    const timer = setInterval(() => {
      setSnapshotActionProgress((prev) => {
        const current = Number(prev[actionId] || 0);
        if (current >= cap) {
          return prev;
        }
        const step = stepMin + Math.random() * (stepMax - stepMin);
        const next = Math.min(cap, current + step);
        return { ...prev, [actionId]: next };
      });
    }, intervalMs);
    snapshotProgressTimersRef.current[actionId] = timer;
  };

  useEffect(() => {
    return () => {
      for (const actionId of SNAPSHOT_ACTION_IDS) {
        const timer = snapshotProgressTimersRef.current[actionId];
        if (timer) {
          clearInterval(timer);
        }
      }
      snapshotProgressTimersRef.current = {};
      stopSnapshotExportProgressPoll();
      stopSnapshotImportProgressPoll();
    };
  }, []);

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
      const message = extractAxiosErrorMessage(
        error,
        "Failed to load storage stats"
      );
      setErrorMessage(message);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    loadStats(true);
  }, []);

  // Run once on mount to restore snapshot progress after tab switch/remount.
  useEffect(() => {
    let cancelled = false;
    const restoreSnapshotAction = async () => {
      try {
        const response = await axios.get("/api/jobs");
        const jobs = Array.isArray(response.data?.jobs)
          ? (response.data.jobs as Array<Record<string, unknown>>)
          : [];
        const runningSnapshotJob = jobs.find((job) => {
          const status = String(job?.status || "").toLowerCase();
          const actionId = jobTypeToSnapshotActionId(String(job?.job_type || ""));
          return status === "running" && actionId !== null;
        });
        if (!runningSnapshotJob || cancelled) {
          return;
        }

        const actionId = jobTypeToSnapshotActionId(String(runningSnapshotJob.job_type || ""));
        if (!actionId) {
          return;
        }

        const progress = Math.max(0, Math.min(100, Number(runningSnapshotJob.progress || 0)));
        const totalSeen = Math.max(0, Number(runningSnapshotJob.total_seen || 0));
        const totalPlannedRaw = Number(runningSnapshotJob.total_planned || runningSnapshotJob.total_limit || 0);
        const totalPlanned =
          Number.isFinite(totalPlannedRaw) && totalPlannedRaw > 0 ? totalPlannedRaw : null;

        setActionInProgress(actionId);
        updateSnapshotProgress(actionId, progress, "set");
        updateSnapshotTransferSize(actionId, totalSeen, totalPlanned);

        if (actionId === "import-snapshot") {
          const restoredPhase = String(runningSnapshotJob.phase || "")
            .trim()
            .toLowerCase();
          setSnapshotImportInlineMessage(
            restoredPhase === "processing"
              ? "Разархивация и импорт снапшота продолжаются..."
              : "Загрузка снапшота продолжается..."
          );
          const jobConfig =
            runningSnapshotJob.job_config && typeof runningSnapshotJob.job_config === "object"
              ? (runningSnapshotJob.job_config as Record<string, unknown>)
              : {};
          const importId = String(jobConfig.import_id || "").trim();
          updateSnapshotProgressMeta(actionId, {
            phase: restoredPhase || "processing",
            status: "running",
            hint: "Extracting and applying snapshot...",
          });
          if (importId) {
            startSnapshotImportProgressPoll(importId, actionId);
          }
          return;
        }

        setSnapshotExportInlineMessage("Выгрузка снапшота продолжается...");
        const jobConfig =
          runningSnapshotJob.job_config && typeof runningSnapshotJob.job_config === "object"
            ? (runningSnapshotJob.job_config as Record<string, unknown>)
            : {};
        const exportId = String(jobConfig.export_id || "").trim();
        if (exportId) {
          startSnapshotExportProgressPoll(exportId, actionId);
        }
      } catch {
        // no-op
      }
    };

    restoreSnapshotAction();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      const message = extractAxiosErrorMessage(error, "Failed to load objects");
      setErrorMessage(message);
    } finally {
      setObjectsLoading(false);
    }
  };

  useEffect(() => {
    loadObjectsPage("", [], 1);
  }, [objectsPageSize]);

  useEffect(() => {
    const query = objectsSearchQuery.trim().toLowerCase();
    const dataset = objectsDatasetFilter.trim();
    const hasFilter = Boolean(query || dataset);
    let cancelled = false;

    const run = async () => {
      if (!hasFilter) {
        setFilteredObjects(null);
        setFilteredObjectsLoading(false);
        return;
      }
      setFilteredObjectsLoading(true);
      try {
        const all: ObjectListItem[] = [];
        let cursor = "";
        let safety = 0;
        const maxPages = 200;
        const pageLimit = 256;

        while (!cancelled && safety < maxPages) {
          safety += 1;
          const response = await axios.get<ObjectListResponse>("/api/storage/objects", {
            params: {
              limit: pageLimit,
              ...(cursor ? { cursor } : {}),
            },
          });
          const items = Array.isArray(response.data?.items) ? response.data.items : [];
          all.push(...items);
          const nextCursor = String(response.data?.next_cursor || "").trim();
          if (!nextCursor) break;
          cursor = nextCursor;
        }

        if (cancelled) return;
        const next = all.filter((item) => {
          if (dataset && item.bucket !== dataset) {
            return false;
          }
          if (!query) {
            return true;
          }
          const haystack = [
            item.object_id,
            item.storage_path,
            item.bucket,
            item.key,
            item.content_type,
          ]
            .join(" ")
            .toLowerCase();
          return haystack.includes(query);
        });
        setFilteredObjects(next);
      } catch (error) {
        if (cancelled) return;
        const message = extractAxiosErrorMessage(error, "Failed to search objects");
        setErrorMessage(message);
        setFilteredObjects([]);
      } finally {
        if (!cancelled) {
          setFilteredObjectsLoading(false);
        }
      }
    };

    const timer = setTimeout(run, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [objectsSearchQuery, objectsDatasetFilter]);

  useEffect(() => {
    setFilteredObjectsPage(1);
  }, [objectsSearchQuery, objectsDatasetFilter, objectsPageSize]);

  useEffect(() => {
    if (!stats) return;
    if (cleanupDatasetFilter === "all") return;
    const isVisible = Boolean(stats.dataset_visibility?.[cleanupDatasetFilter] ?? true);
    if (!isVisible) {
      setCleanupDatasetFilter("all");
    }
  }, [stats, cleanupDatasetFilter]);

  const runStorageAction = async (actionId: string, fn: () => Promise<void>) => {
    setActionInProgress(actionId);
    setStatusMessage(null);
    setWarningMessage(null);
    setErrorMessage(null);
    try {
      await fn();
    } catch (error) {
      if (isCancelledActionError(error)) {
        if (isSnapshotActionId(actionId)) {
          updateSnapshotProgressMeta(actionId, {
            status: "cancelled",
            hint: "Operation cancelled",
          });
          if (actionId === "import-snapshot") {
            setSnapshotImportInlineMessage("Импорт и распаковка архива отменены.");
          } else {
            setSnapshotExportInlineMessage("Выгрузка и создание архива отменены.");
          }
          return;
        }
        setWarningMessage("Operation cancelled.");
        return;
      }
      const message = extractAxiosErrorMessage(error, "Operation failed");
      setErrorMessage(message);
    } finally {
      setActionInProgress(null);
    }
  };

  const openConfirmDialog = (dialog: ConfirmDialogState) => {
    setConfirmDialogBusy(false);
    setConfirmDialog(dialog);
  };

  const executeConfirmDialog = async () => {
    if (!confirmDialog || confirmDialogBusy) return;
    setConfirmDialogBusy(true);
    const action = confirmDialog.onConfirm;
    try {
      setConfirmDialog(null);
      await action();
    } finally {
      setConfirmDialogBusy(false);
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
    openConfirmDialog({
      title: "Delete object",
      description: `Удалить объект ${objectId} из storage, векторов и связанных аннотаций?`,
      confirmLabel: "Удалить объект",
      onConfirm: async () => {
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
      },
    });
  };

  const deleteRandomEmbeddings = async () => {
    const count = Math.max(1, Number(randomEmbeddingsCount || 1));
    const dataset = cleanupDatasetFilter === "all" ? "" : cleanupDatasetFilter;
    openConfirmDialog({
      title: "Delete random embeddings",
      description: `Delete embeddings for ${count} random scenes${dataset ? ` in dataset '${dataset}'` : ""}?`,
      confirmLabel: "Удалить embeddings",
      onConfirm: async () => {
        await runStorageAction("delete-random-embeddings", async () => {
          const response = await axios.post("/api/storage/delete-random-embeddings", {
            count,
            dataset,
            confirm: true,
          });
          const selected = Number(response.data?.selected_images || 0);
          const reset = Number(response.data?.reset_embeddings || 0);
          setStatusMessage(`Сброшены embeddings: ${reset} из ${selected} выбранных сцен.`);
          await loadStats(false);
        });
      },
    });
  };

  const deleteRandomVlm = async () => {
    const count = Math.max(1, Number(randomVlmCount || 1));
    const dataset = cleanupDatasetFilter === "all" ? "" : cleanupDatasetFilter;
    openConfirmDialog({
      title: "Delete random VLM",
      description: `Delete VLM annotations for ${count} random scenes${dataset ? ` in dataset '${dataset}'` : ""}?`,
      confirmLabel: "Удалить VLM",
      onConfirm: async () => {
        await runStorageAction("delete-random-vlm", async () => {
          const response = await axios.post("/api/storage/delete-random-vlm", {
            count,
            dataset,
            confirm: true,
          });
          const selected = Number(response.data?.selected_images || 0);
          const reset = Number(response.data?.reset_vlm_annotations || 0);
          setStatusMessage(`Сброшены VLM-аннотации: ${reset} из ${selected} выбранных сцен.`);
          await loadStats(false);
        });
      },
    });
  };

  const deleteDuplicates = async () => {
    const dataset = cleanupDatasetFilter === "all" ? "" : cleanupDatasetFilter;
    openConfirmDialog({
      title: "Delete duplicates",
      description:
        `Delete duplicate scenes by identical storage_path${dataset ? ` in dataset '${dataset}'` : ""}, keeping one row each?`,
      confirmLabel: "Удалить дубли",
      onConfirm: async () => {
        await runStorageAction("delete-duplicates", async () => {
          const response = await axios.post("/api/storage/delete-duplicates", {
            dataset,
            confirm: true,
          });
          const candidates = Number(response.data?.duplicate_candidates || 0);
          const deleted = Number(response.data?.deleted_duplicates || 0);
          const failed = Number(response.data?.failed_duplicates || 0);
          setStatusMessage(
            `Дубликаты обработаны: кандидатов ${candidates}, удалено ${deleted}, ошибок ${failed}.`
          );
          await Promise.all([
            loadStats(false),
            loadObjectsPage(objectsCursor, objectsPrevCursors, objectsPage),
          ]);
        });
      },
    });
  };

  const deleteRandomImagesHard = async () => {
    const count = Math.max(1, Number(randomHardDeleteCount || 1));
    const dataset = cleanupDatasetFilter === "all" ? "" : cleanupDatasetFilter;
    openConfirmDialog({
      title: "Hard delete random scenes",
      description: `Hard delete ${count} random scenes${dataset ? ` in dataset '${dataset}'` : ""} (image, vectors, VLM annotations)?`,
      confirmLabel: "Удалить сцены",
      onConfirm: async () => {
        await runStorageAction("delete-random-images", async () => {
          const response = await axios.post("/api/storage/delete-random-images", {
            count,
            dataset,
            confirm: true,
          });
          const selected = Number(response.data?.selected_images || 0);
          const deleted = Number(response.data?.deleted_images || 0);
          const failed = Number(response.data?.failed_images || 0);
          setStatusMessage(
            `Полное удаление сцен: выбранo ${selected}, удалено ${deleted}, ошибок ${failed}.`
          );
          await Promise.all([
            loadStats(false),
            loadObjectsPage(objectsCursor, objectsPrevCursors, objectsPage),
          ]);
          if (failed > 0) {
            setWarningMessage("Часть сцен не удалена. Проверьте детали в ответе API/логах.");
          }
        });
      },
    });
  };

  const deleteDataset = async (dataset: string) => {
    openConfirmDialog({
      title: "Delete dataset",
      description: `Полностью удалить датасет '${dataset}' (все сцены, векторы и VLM-аннотации)?`,
      confirmLabel: "Удалить датасет",
      onConfirm: async () => {
        await runStorageAction(`delete-dataset-${dataset}`, async () => {
          const datasetDeleteJobID = `${Date.now().toString(16)}${Math.random()
            .toString(16)
            .slice(2, 10)}`.slice(0, 16);
          let initialSelected = 0;
          let deletedTotal = 0;
          let failedTotal = 0;
          let remaining = 0;
          let done = false;
          let safetySteps = 0;
          setDatasetDeleteProgress((prev) => ({ ...prev, [dataset]: 0 }));

          try {
            while (!done && safetySteps < 1000) {
              safetySteps += 1;
              const response = await axios.post("/api/storage/delete-dataset", {
                dataset,
                confirm: true,
                progressive: true,
                batch_size: 200,
                job_id: datasetDeleteJobID,
              });
              const selected = Number(response.data?.selected_images || 0);
              const deleted = Number(response.data?.deleted_images || 0);
              remaining = Number(response.data?.remaining_images || 0);
              const failed = Number(response.data?.failed_images || 0);
              done = Boolean(response.data?.done);

              if (initialSelected <= 0 && selected > 0) {
                initialSelected = selected;
              }
              deletedTotal += deleted;
              failedTotal += failed;

              const baseTotal = Math.max(initialSelected, deletedTotal + remaining);
              const completed = Math.max(0, baseTotal - remaining);
              const progress =
                baseTotal > 0 ? Math.min(100, (completed / baseTotal) * 100) : done ? 100 : 0;
              setDatasetDeleteProgress((prev) => ({ ...prev, [dataset]: progress }));

              if (!done && deleted === 0) {
                break;
              }
            }
          } finally {
            setDatasetDeleteProgress((prev) => {
              const next = { ...prev };
              delete next[dataset];
              return next;
            });
          }

          const selected = Math.max(initialSelected, deletedTotal + remaining);
          setStatusMessage(
            `Датасет '${dataset}' обработан: выбрано ${selected}, удалено ${deletedTotal}, осталось ${remaining}, ошибок ${failedTotal}.`
          );
          await Promise.all([loadStats(false), loadObjectsPage("", [], 1)]);
          if (failedTotal > 0 || remaining > 0) {
            setWarningMessage(
              `При удалении датасета '${dataset}' остались проблемы: осталось ${remaining}, ошибок ${failedTotal}.`
            );
          }
        });
      },
    });
  };

  const downloadSnapshot = async (kind: TransferKind) => {
    const actionId = `download-${kind}` as SnapshotActionId;
    const exportId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    setSnapshotExportInlineMessage(null);
    const controller = new AbortController();
    setSnapshotAbortController(actionId, controller);
    updateSnapshotProgressMeta(actionId, {
      phase: "preparing",
      status: "running",
      hint: "Preparing snapshot...",
    });
    updateSnapshotTransferSize(actionId, 0, null);
    updateSnapshotProgress(actionId, 0);
    startSnapshotExportProgressPoll(exportId, actionId);

    await runStorageAction(actionId, async () => {
      const response = await axios.get(
        `/api/storage/transfer/export?kind=${encodeURIComponent(kind)}&export_id=${encodeURIComponent(exportId)}`,
        {
          adapter: "xhr",
          responseType: "blob",
          signal: controller.signal,
          onDownloadProgress: (event) => {
            const total = Number(event.total || 0);
            const loaded = Number(event.loaded || 0);
            updateSnapshotTransferSize(actionId, loaded, total > 0 ? total : null);
            if (total > 0) {
              const ratio = Math.min(1, Math.max(0, loaded / total));
              updateSnapshotProgress(actionId, ratio * 100, "max");
            }
          },
        }
      );

      const blob = response.data as Blob;
      const finalSize = Number(blob.size || 0);
      if (finalSize > 0) {
        updateSnapshotTransferSize(actionId, finalSize, finalSize);
      }
      updateSnapshotProgressMeta(actionId, {
        phase: "done",
        status: "done",
        hint: "",
      });
      updateSnapshotProgress(actionId, 100);
      await new Promise((resolve) => setTimeout(resolve, 160));

      const disposition = String(response.headers?.["content-disposition"] || "");
      const fallbackName = `avsp-${kind}-snapshot-${new Date()
        .toISOString()
        .replace(/[:.]/g, "-")}.tar.gz`;
      const filename = fileNameFromDisposition(disposition) || fallbackName;
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(href);
      setSnapshotExportInlineMessage(`Файл '${filename}' выгружен.`);
    });

    stopSnapshotExportProgressPoll();
    setSnapshotAbortController(actionId, null);
    clearSnapshotProgress(actionId);
  };

  const askImportSnapshot = async () => {
    if (!transferFile) {
      setWarningMessage("Выберите файл снапшота перед импортом.");
      return;
    }
    openConfirmDialog({
      title: "Import snapshot",
      description:
        "Импорт может перезаписать существующие embeddings/VLM аннотации и добавить объекты в storage. Продолжить?",
      confirmLabel: "Импортировать",
      onConfirm: async () => {
        const actionId: SnapshotActionId = "import-snapshot";
        const importId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        setSnapshotImportInlineMessage("Загрузка снапшота продолжается...");
        const controller = new AbortController();
        setSnapshotAbortController(actionId, controller);
        updateSnapshotProgressMeta(actionId, {
          phase: "uploading",
          status: "running",
          hint: "Uploading snapshot...",
        });
        updateSnapshotTransferSize(
          actionId,
          0,
          transferFile ? Number(transferFile.size || 0) : null
        );
        startSnapshotImportProgressPoll(importId, actionId);
        startSnapshotProgressAnimation(actionId, {
          from: 4,
          cap: 55,
          stepMin: 0.2,
          stepMax: 0.45,
          intervalMs: 160,
        });

        await runStorageAction(actionId, async () => {
          let processingAnimationStarted = false;
          const response = await axios.post(
            `/api/storage/transfer/import?import_id=${encodeURIComponent(importId)}`,
            transferFile,
            {
              adapter: "xhr",
              headers: {
                "Content-Type": transferFile.type || "application/octet-stream",
              },
              signal: controller.signal,
              onUploadProgress: (event) => {
                const total = Number(event.total || 0);
                const loaded = Number(event.loaded || 0);
                updateSnapshotTransferSize(
                  actionId,
                  loaded,
                  total > 0 ? total : transferFile ? Number(transferFile.size || 0) : null
                );
                if (total > 0) {
                  clearSnapshotProgressTimer(actionId);
                  const uploadPercent = Math.min(1, Math.max(0, loaded / total));
                  updateSnapshotProgress(actionId, 5 + uploadPercent * 50, "max");
                }
                if (!processingAnimationStarted && total > 0 && loaded >= total) {
                  processingAnimationStarted = true;
                  clearSnapshotProgressTimer(actionId);
                  updateSnapshotProgress(actionId, 70, "max");
                  startSnapshotProgressAnimation(actionId, {
                    from: 70,
                    cap: 98,
                    stepMin: 0.35,
                    stepMax: 0.85,
                    intervalMs: 130,
                  });
                  updateSnapshotProgressMeta(actionId, {
                    phase: "processing",
                    status: "running",
                    hint: "Extracting and applying snapshot...",
                  });
                  setSnapshotImportInlineMessage("Разархивация и импорт снапшота продолжаются...");
                }
              },
            }
          );

          if (!processingAnimationStarted) {
            clearSnapshotProgressTimer(actionId);
            updateSnapshotProgress(actionId, 97, "max");
          }

          clearSnapshotProgressTimer(actionId);
          updateSnapshotProgress(actionId, 100);
          updateSnapshotProgressMeta(actionId, {
            phase: "done",
            status: "done",
            hint: "",
          });
          await new Promise((resolve) => setTimeout(resolve, 160));

          const payload = response.data;
          const responsePayload =
            payload && typeof payload === "object"
              ? (payload as Record<string, unknown>)
              : {};
          setSnapshotImportInlineMessage(buildImportSummary(responsePayload.result));
          setTransferFile(null);
          setTransferFileInputKey((value) => value + 1);
          await Promise.all([loadStats(false), loadObjectsPage("", [], 1)]);
        });

        stopSnapshotImportProgressPoll();
        setSnapshotAbortController(actionId, null);
        clearSnapshotProgress(actionId);
      },
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

  const normalizedObjectsQuery = objectsSearchQuery.trim().toLowerCase();
  const hasObjectsFilter = Boolean(objectsDatasetFilter || normalizedObjectsQuery);
  const filteredTotalPages = Math.max(
    1,
    Math.ceil((filteredObjects?.length ?? 0) / Math.max(1, objectsPageSize))
  );
  const safeFilteredPage = Math.min(filteredObjectsPage, filteredTotalPages);
  const filteredStart = (safeFilteredPage - 1) * Math.max(1, objectsPageSize);
  const filteredEnd = filteredStart + Math.max(1, objectsPageSize);
  const objectsToRender = hasObjectsFilter
    ? (filteredObjects ?? []).slice(filteredStart, filteredEnd)
    : objects;
  const allDatasetBuckets = (stats.storage.all_bucket_stats || stats.storage.bucket_stats).map(
    (bucket) => bucket.bucket
  );
  const allDatasetsVisible =
    allDatasetBuckets.length > 0 &&
    allDatasetBuckets.every((dataset) => Boolean(stats.dataset_visibility?.[dataset] ?? true));
  const allVisibilityActionId = "toggle-visibility-all";
  const isTogglingAllVisibility = actionInProgress === allVisibilityActionId;
  const transferFileInputId = `snapshot-file-input-${transferFileInputKey}`;

  const renderSnapshotProgressButton = ({
    actionId,
    idleLabel,
    activeLabel,
    onClick,
    disabled,
    tone,
    longProgress = false,
    fixedWidthClass = "",
    onCancel,
  }: {
    actionId: SnapshotActionId;
    idleLabel: string;
    activeLabel: string;
    onClick: () => void;
    disabled: boolean;
    tone: "sky" | "indigo" | "violet" | "emerald";
    longProgress?: boolean;
    fixedWidthClass?: string;
    onCancel?: (actionId: SnapshotActionId) => void;
  }) => {
    const isActive = actionInProgress === actionId;
    const rawProgress = Math.max(
      0,
      Math.min(100, Math.round(snapshotActionProgress[actionId] ?? 0))
    );
    const transferSize = snapshotTransferSize[actionId];
    const transferMeta = snapshotProgressMeta[actionId];
    let idleTone = "";
    let activeTone = "";
    let fillTone = "";
    let textTone = "";

    if (tone === "sky") {
      idleTone = "border-sky-500 bg-sky-600 text-white hover:bg-sky-700";
      activeTone = "border-sky-300 bg-sky-100 text-sky-700";
      fillTone = "bg-sky-600";
      textTone = "text-sky-700";
    } else if (tone === "indigo") {
      idleTone = "border-indigo-500 bg-indigo-600 text-white hover:bg-indigo-700";
      activeTone = "border-indigo-300 bg-indigo-100 text-indigo-700";
      fillTone = "bg-indigo-600";
      textTone = "text-indigo-700";
    } else if (tone === "violet") {
      idleTone = "border-violet-500 bg-violet-600 text-white hover:bg-violet-700";
      activeTone = "border-violet-300 bg-violet-100 text-violet-700";
      fillTone = "bg-violet-600";
      textTone = "text-violet-700";
    } else {
      idleTone = "border-emerald-500 bg-emerald-600 text-white hover:bg-emerald-700";
      activeTone = "border-emerald-300 bg-emerald-100 text-emerald-700";
      fillTone = "bg-emerald-600";
      textTone = "text-emerald-700";
    }

    let sizeText = "";
    const hasTotalSize = Number(transferSize?.totalBytes || 0) > 0;
    const transferRatioProgress = hasTotalSize
      ? (() => {
          const loaded = Number(transferSize?.loadedBytes || 0);
          const total = Math.max(1, Number(transferSize?.totalBytes || 0));
          const ratio = (loaded / total) * 100;
          if (loaded > 0 && loaded < total) {
            return Math.max(0, Math.min(99, Math.floor(ratio)));
          }
          return Math.max(0, Math.min(100, Math.round(ratio)));
        })()
      : null;
    const isMidTransfer =
      hasTotalSize &&
      Number(transferSize?.loadedBytes || 0) > 0 &&
      Number(transferSize?.loadedBytes || 0) < Number(transferSize?.totalBytes || 0);
    const shouldPreferTransferRatio =
      isMidTransfer &&
      (transferMeta?.phase === "uploading" ||
        transferMeta?.phase === "streaming" ||
        rawProgress - (transferRatioProgress ?? rawProgress) > 20);
    const progress = shouldPreferTransferRatio
      ? Number(transferRatioProgress || 0)
      : rawProgress;
    let displayActiveLabel = activeLabel;
    if (actionId === "import-snapshot") {
      const phase = String(transferMeta?.phase || "").trim().toLowerCase();
      if (phase === "uploading") {
        displayActiveLabel = "Загрузка...";
      } else if (phase === "processing") {
        displayActiveLabel = "Разархивация...";
      } else if (phase === "done") {
        displayActiveLabel = "Импорт...";
      }
    }

    if (transferSize && transferSize.loadedBytes > 0) {
      if (hasTotalSize) {
        sizeText = ` (${formatBytes(transferSize.loadedBytes)} / ${formatBytes(
          Number(transferSize.totalBytes || 0)
        )})`;
      } else {
        sizeText = ` (${formatBytes(transferSize.loadedBytes)})`;
      }
    } else if (transferMeta?.hint) {
      sizeText = ` (${transferMeta.hint})`;
    }
    const activeText = hasTotalSize
      ? `${displayActiveLabel} ${progress}%${sizeText}`
      : `${displayActiveLabel}${sizeText}`;
    const handleClick = () => {
      if (isActive && onCancel) {
        onCancel(actionId);
        return;
      }
      onClick();
    };
    return (
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        title={isActive ? "Click to cancel" : undefined}
        className={`relative self-start overflow-hidden rounded-full border px-4 py-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${
          fixedWidthClass || (longProgress ? "min-w-40" : "w-fit")
        } ${
          isActive ? activeTone : idleTone
        } ${
          isActive
            ? "cursor-pointer hover:!border-rose-300 hover:!bg-rose-100 hover:!text-rose-700"
            : ""
        }`}
      >
        {isActive && (
          <span
            aria-hidden="true"
            className={`pointer-events-none absolute inset-y-0 left-0 transition-[width] duration-200 ease-out ${fillTone}`}
            style={{ width: `${progress}%` }}
          />
        )}
        {isActive ? (
          <>
            <span className={`relative z-10 inline-block whitespace-nowrap ${textTone}`}>
              <span aria-hidden="true" className="opacity-0">
                {activeText}
              </span>
            </span>
            <span
              className={`pointer-events-none absolute inset-0 z-10 flex items-center justify-center whitespace-nowrap ${textTone}`}
            >
              {activeText}
            </span>
            <span
              className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center whitespace-nowrap text-white transition-[clip-path] duration-200 ease-out"
              style={{ clipPath: `inset(0 ${100 - progress}% 0 0)` }}
            >
              {activeText}
            </span>
          </>
        ) : (
          <span className="relative z-10">{idleLabel}</span>
        )}
      </button>
    );
  };

  const snapshotSection = (
    <div
      id="transfer-snapshot-section"
      className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"
    >
      <h3 className="text-lg font-semibold text-slate-900">Transfer Snapshot</h3>
      <p className="mt-1 text-sm text-slate-600">
        Экспорт/импорт полного storage и отдельной разметки (VLM/Embedder) через файл.
      </p>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <div className="text-sm font-medium text-slate-800">Выгрузка</div>
          <p className="mt-1 text-xs text-slate-500">
            Файл можно перенести на другую VM и загрузить обратно после разметки.
          </p>
          {snapshotExportInlineMessage && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
              {snapshotExportInlineMessage}
            </div>
          )}
          <div className="mt-3 flex flex-col items-start gap-2">
            {renderSnapshotProgressButton({
              actionId: "download-full",
              idleLabel: "Скачать полный storage",
              activeLabel: "Archiving full snapshot...",
              onClick: () => downloadSnapshot("full"),
              disabled:
                actionInProgress !== null && actionInProgress !== "download-full",
              tone: "sky",
              fixedWidthClass: "w-full max-w-[30rem]",
              onCancel: askCancelSnapshotAction,
            })}
            {renderSnapshotProgressButton({
              actionId: "download-embeddings",
              idleLabel: "Скачать Embedder",
              activeLabel: "Archiving embeddings...",
              onClick: () => downloadSnapshot("embeddings"),
              disabled:
                actionInProgress !== null &&
                actionInProgress !== "download-embeddings",
              tone: "indigo",
              fixedWidthClass: "w-full max-w-[30rem]",
              onCancel: askCancelSnapshotAction,
            })}
            {renderSnapshotProgressButton({
              actionId: "download-vlm",
              idleLabel: "Скачать VLM",
              activeLabel: "Archiving VLM...",
              onClick: () => downloadSnapshot("vlm"),
              disabled:
                actionInProgress !== null && actionInProgress !== "download-vlm",
              tone: "violet",
              fixedWidthClass: "w-full max-w-[30rem]",
              onCancel: askCancelSnapshotAction,
            })}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <div className="text-sm font-medium text-slate-800">Загрузка файла</div>
          <p className="mt-1 text-xs text-slate-500">
            Поддерживаются снапшоты: full storage, embeddings-only, VLM-only.
          </p>
          <div className="mt-3 flex flex-col items-start gap-2">
            <input
              id={transferFileInputId}
              key={transferFileInputKey}
              type="file"
              accept=".tar.gz,.tgz,.tar,.gz,application/gzip,application/x-gzip,application/x-tar"
              onChange={(event) =>
                setTransferFile(event.target.files?.[0] ?? null)
              }
              className="sr-only"
            />
            <label
              htmlFor={transferFileInputId}
              className="inline-flex w-full max-w-[30rem] cursor-pointer items-center justify-center rounded-full border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 transition hover:border-slate-400 hover:bg-slate-100"
            >
              Choose file
            </label>
            <div className="w-full max-w-[30rem] break-all px-1 text-xs text-slate-500">
              {transferFile
                ? `Selected: ${transferFile.name} (${formatBytes(transferFile.size)})`
                : "No file selected"}
            </div>
            {snapshotImportInlineMessage && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
                {snapshotImportInlineMessage}
              </div>
            )}
            {renderSnapshotProgressButton({
              actionId: "import-snapshot",
              idleLabel: "Upload",
              activeLabel: "Import...",
              onClick: askImportSnapshot,
              disabled:
                (actionInProgress !== null && actionInProgress !== "import-snapshot") ||
                (transferFile === null && actionInProgress !== "import-snapshot"),
              tone: "emerald",
              longProgress: true,
              fixedWidthClass: "w-full max-w-[30rem]",
              onCancel: askCancelSnapshotAction,
            })}
          </div>
        </div>
      </div>
    </div>
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
              {hasObjectsFilter && (
                <p className="mt-1 text-xs text-slate-500">
                  Поиск выполняется по всем объектам storage.
                </p>
              )}
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-2 text-sm text-slate-700">
              <input
                type="text"
                value={objectsSearchQuery}
                onChange={(event) => setObjectsSearchQuery(event.target.value)}
                placeholder="Поиск: object_id / key / path..."
                className="w-72 rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900"
              />
              <select
                value={objectsDatasetFilter}
                onChange={(event) => setObjectsDatasetFilter(event.target.value)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900"
              >
                <option value="">Все датасеты</option>
                {(stats.storage.all_bucket_stats || stats.storage.bucket_stats).map((bucket) => (
                  <option key={bucket.bucket} value={bucket.bucket}>
                    {bucket.bucket}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2 text-sm text-slate-700">
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
                {objectsToRender.length === 0 && !objectsLoading && !filteredObjectsLoading && (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-sm text-slate-500">
                      {hasObjectsFilter ? "По заданному фильтру объектов нет." : "Объекты не найдены."}
                    </td>
                  </tr>
                )}
                {filteredObjectsLoading && (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-sm text-slate-500">
                      Поиск по объектам...
                    </td>
                  </tr>
                )}
                {objectsToRender.map((item) => (
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
              {hasObjectsFilter
                ? `Найдено: ${objectsToRender.length} ${filteredObjectsLoading ? "• loading..." : ""}`
                : `Страница ${objectsPage} ${objectsLoading ? "• loading..." : ""}`}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  if (hasObjectsFilter) {
                    setFilteredObjectsPage((current) => Math.max(1, current - 1));
                    return;
                  }
                  goToPrevObjectsPage();
                }}
                disabled={
                  hasObjectsFilter
                    ? filteredObjectsLoading || safeFilteredPage <= 1
                    : objectsPrevCursors.length === 0 || objectsLoading
                }
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                ← Назад
              </button>
              <button
                type="button"
                onClick={() => {
                  if (hasObjectsFilter) {
                    setFilteredObjectsPage((current) =>
                      Math.min(filteredTotalPages, current + 1)
                    );
                    return;
                  }
                  goToNextObjectsPage();
                }}
                disabled={
                  hasObjectsFilter
                    ? filteredObjectsLoading || safeFilteredPage >= filteredTotalPages
                    : !objectsNextCursor || objectsLoading
                }
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
          <h3 className="text-lg font-semibold text-slate-900">Cleanup & Re-Annotation</h3>
          <p className="mt-1 text-sm text-slate-600">
            Partial annotation reset, duplicate cleanup, and full random scene deletion.
          </p>
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
          <div className="mt-3">
            <label className="text-sm font-medium text-slate-700">
              Dataset scope
            </label>
            <div className="mt-2">
              <select
                value={cleanupDatasetFilter}
                onChange={(event) => setCleanupDatasetFilter(event.target.value)}
                className="w-56 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
              >
                <option value="all">All datasets</option>
                {(stats.storage.all_bucket_stats || stats.storage.bucket_stats)
                  .filter((bucket) => Boolean(stats.dataset_visibility?.[bucket.bucket] ?? true))
                  .map((bucket) => (
                    <option key={`cleanup-${bucket.bucket}`} value={bucket.bucket}>
                      {bucket.bucket}
                    </option>
                  ))}
              </select>
            </div>
          </div>

          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <label className="text-sm font-medium text-slate-700">
                Random N for vector reset
              </label>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  type="number"
                  min={1}
                  value={randomEmbeddingsCount}
                  onChange={(event) =>
                    setRandomEmbeddingsCount(Math.max(1, Number(event.target.value) || 1))
                  }
                  className="w-28 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                />
                <button
                  type="button"
                  onClick={deleteRandomEmbeddings}
                  disabled={actionInProgress !== null}
                  className="rounded-full bg-indigo-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {actionInProgress === "delete-random-embeddings"
                    ? "Deleting..."
                    : "Delete random embeddings"}
                </button>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <label className="text-sm font-medium text-slate-700">
                Random N for VLM reset
              </label>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  type="number"
                  min={1}
                  value={randomVlmCount}
                  onChange={(event) =>
                    setRandomVlmCount(Math.max(1, Number(event.target.value) || 1))
                  }
                  className="w-28 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                />
                <button
                  type="button"
                  onClick={deleteRandomVlm}
                  disabled={actionInProgress !== null}
                  className="rounded-full bg-violet-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {actionInProgress === "delete-random-vlm"
                    ? "Deleting..."
                    : "Delete random VLM"}
                </button>
              </div>
            </div>

            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
              <label className="text-sm font-medium text-amber-800">
                Duplicate rows cleanup
              </label>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-sm text-amber-800">
                  Drop duplicate rows by identical `storage_path`
                </span>
                <button
                  type="button"
                  onClick={deleteDuplicates}
                  disabled={actionInProgress !== null}
                  className="rounded-full bg-amber-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {actionInProgress === "delete-duplicates" ? "Deleting..." : "Drop duplicates"}
                </button>
              </div>
            </div>

            <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4">
              <label className="text-sm font-medium text-rose-700">
                Random N images hard delete
              </label>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  type="number"
                  min={1}
                  value={randomHardDeleteCount}
                  onChange={(event) =>
                    setRandomHardDeleteCount(Math.max(1, Number(event.target.value) || 1))
                  }
                  className="w-28 rounded-lg border border-rose-300 bg-white px-3 py-2 text-sm text-rose-900"
                />
                <button
                  type="button"
                  onClick={deleteRandomImagesHard}
                  disabled={actionInProgress !== null}
                  className="rounded-full bg-rose-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {actionInProgress === "delete-random-images"
                    ? "Deleting..."
                    : "Delete images + metadata"}
                </button>
              </div>
            </div>
          </div>
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
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Actions
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                    <div className="flex items-center gap-2">
                      <span>Visibility</span>
                      <button
                        type="button"
                        onClick={() => {
                          if (allDatasetBuckets.length === 0) return;
                          const nextVisible = !allDatasetsVisible;
                          openConfirmDialog({
                            title: nextVisible ? "Show all datasets" : "Hide all datasets",
                            description: nextVisible
                              ? "Show all datasets across Browser, VLM, annotation, cleanup/deletion and Storage analytics?"
                              : "Hide all datasets from Browser, VLM, annotation, cleanup/deletion and Storage analytics?",
                            confirmLabel: nextVisible ? "Show all" : "Hide all",
                            onConfirm: async () => {
                              await runStorageAction(allVisibilityActionId, async () => {
                                await Promise.all(
                                  allDatasetBuckets.map((dataset) =>
                                    axios.post("/api/storage/dataset-visibility", {
                                      dataset,
                                      visible: nextVisible,
                                    })
                                  )
                                );
                                await Promise.all([
                                  loadStats(false),
                                  loadObjectsPage(objectsCursor, objectsPrevCursors, objectsPage),
                                ]);
                              });
                            },
                          });
                        }}
                        disabled={isTogglingAllVisibility || actionInProgress !== null}
                        className="rounded-md border border-slate-300 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {allDatasetsVisible ? "Hide all" : "Show all"}
                      </button>
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 bg-white">
                {(stats.storage.all_bucket_stats || stats.storage.bucket_stats).map((bucket) => {
                  const deleteActionId = `delete-dataset-${bucket.bucket}`;
                  const isDeleting = actionInProgress === deleteActionId;
                  const visibilityActionId = `toggle-visibility-${bucket.bucket}`;
                  const isTogglingVisibility = actionInProgress === visibilityActionId;
                  const isVisible = Boolean(
                    stats.dataset_visibility?.[bucket.bucket] ?? true
                  );
                  const progress = Math.max(
                    0,
                    Math.min(100, datasetDeleteProgress[bucket.bucket] ?? 0)
                  );
                  return (
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
                      <td className="px-4 py-3 text-sm">
                        <button
                          type="button"
                          onClick={() => deleteDataset(bucket.bucket)}
                          disabled={actionInProgress !== null || !isVisible}
                          className={`relative overflow-hidden rounded-lg border px-3 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${
                            isDeleting
                              ? "border-rose-400 bg-rose-100"
                              : "border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100"
                          }`}
                        >
                          {isDeleting && (
                            <span
                              aria-hidden="true"
                              className="pointer-events-none absolute inset-y-0 left-0 bg-rose-600 transition-[width] duration-300 ease-out"
                              style={{ width: `${progress}%` }}
                            />
                          )}
                          {isDeleting ? (
                            <>
                              <span className="relative z-10 inline-block whitespace-nowrap text-rose-700">
                                <span aria-hidden="true" className="opacity-0">
                                  Deleting
                                </span>
                              </span>
                              <span className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center whitespace-nowrap text-rose-700">
                                Deleting
                              </span>
                              <span
                                className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center whitespace-nowrap text-white transition-[clip-path] duration-300 ease-out"
                                style={{ clipPath: `inset(0 ${100 - progress}% 0 0)` }}
                              >
                                Deleting
                              </span>
                            </>
                          ) : (
                            <span className="relative z-10">Delete dataset</span>
                          )}
                        </button>
                      </td>
                      <td className="px-4 py-3 text-sm">
                        <button
                          type="button"
                          title={isVisible ? "Dataset is visible" : "Dataset is hidden"}
                          onClick={() => {
                            openConfirmDialog({
                              title: isVisible ? "Hide dataset" : "Show dataset",
                              description: isVisible
                                ? `Hide dataset '${bucket.bucket}' from Browser, VLM, annotation, cleanup/deletion and Storage analytics?`
                                : `Show dataset '${bucket.bucket}' again across Browser, VLM, annotation, cleanup/deletion and Storage analytics?`,
                              confirmLabel: isVisible ? "Hide dataset" : "Show dataset",
                              onConfirm: async () => {
                                await runStorageAction(visibilityActionId, async () => {
                                  await axios.post("/api/storage/dataset-visibility", {
                                    dataset: bucket.bucket,
                                    visible: !isVisible,
                                  });
                                  await Promise.all([
                                    loadStats(false),
                                    loadObjectsPage(objectsCursor, objectsPrevCursors, objectsPage),
                                  ]);
                                });
                              },
                            });
                          }}
                          disabled={isTogglingVisibility || actionInProgress !== null}
                          className={`inline-flex items-center justify-center text-slate-700 transition hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-60 ${
                            isVisible ? "" : "text-slate-400"
                          }`}
                        >
                          {isVisible ? (
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              className="h-4 w-4"
                            >
                              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
                              <circle cx="12" cy="12" r="3" />
                            </svg>
                          ) : (
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              className="h-4 w-4"
                            >
                              <path d="M3 3l18 18" />
                              <path d="M10.58 10.58A2 2 0 0 0 12 14a2 2 0 0 0 1.42-.58" />
                              <path d="M9.88 5.09A9.78 9.78 0 0 1 12 5c6.5 0 10 7 10 7a17.1 17.1 0 0 1-3.07 4.22" />
                              <path d="M6.61 6.61C3.62 8.39 2 12 2 12s3.5 7 10 7a9.77 9.77 0 0 0 5.19-1.51" />
                            </svg>
                          )}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {showSnapshotSection && snapshotSection}
      </div>

      {confirmDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          onClick={() => {
            if (!confirmDialogBusy) {
              setConfirmDialog(null);
            }
          }}
        >
          <div
            className="w-full max-w-xl rounded-2xl bg-white p-6 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-slate-900">{confirmDialog.title}</h3>
            <p className="mt-2 text-sm text-slate-600">{confirmDialog.description}</p>
            <div className="mt-5 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setConfirmDialog(null)}
                disabled={confirmDialogBusy}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={executeConfirmDialog}
                disabled={confirmDialogBusy}
                className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {confirmDialog.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}

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
