"use client";

import { useEffect, useRef, useState } from "react";
import axios from "axios";
import Image from "next/image";
import {
  getLocalizedText,
  getUiLanguageLocale,
  type UiLanguageCode,
} from "../lib/uiLanguage";

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
  dimensions?: {
    status?: string;
    query_dim?: number | null;
    stored_dim?: number | null;
    mismatch?: boolean | null;
    reason?: string | null;
  };
}

interface VlmStats extends AnnotationStats {
  configured_fields: number;
  partial_annotated_rows?: number;
  partial_annotated_percent?: number;
  partial_only_rows?: number;
  partial_only_percent?: number;
  field_coverage?: VlmFieldCoverageRow[];
  field_coverage_summary?: VlmFieldCoverageSummary | null;
}

interface VlmFieldCoverageRow {
  field_name: string;
  response_type?: string;
  filled_rows: number;
  valid_rows?: number;
  invalid_rows?: number;
  missing_rows: number;
  filled_percent: number;
  invalid_percent?: number;
  missing_percent: number;
  invalid_examples?: Array<{ value: string; count: number }>;
}

interface VlmFieldCoverageSummary {
  total_cells: number;
  filled_cells: number;
  valid_cells: number;
  invalid_cells: number;
  missing_cells: number;
  filled_percent: number;
  valid_percent: number;
  invalid_percent: number;
  missing_percent: number;
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

const EMPTY_STORAGE_STATS: StorageStatsResponse = {
  source_table_exists: true,
  source_table: "storage.objects",
  warning: null,
  source: {
    total_rows: 0,
    rows_with_storage_path: 0,
    distinct_storage_paths: 0,
    duplicate_storage_rows: 0,
  },
  embeddings: {
    annotated_rows: 0,
    pending_rows: 0,
    annotated_percent: 0,
    pending_percent: 0,
    dimensions: {
      status: "unknown",
      query_dim: null,
      stored_dim: null,
      mismatch: null,
      reason: null,
    },
  },
  vlm: {
    annotated_rows: 0,
    pending_rows: 0,
    annotated_percent: 0,
    pending_percent: 0,
    configured_fields: 0,
    partial_annotated_rows: 0,
    partial_annotated_percent: 0,
    partial_only_rows: 0,
    partial_only_percent: 0,
    field_coverage: [],
    field_coverage_summary: null,
  },
  storage: {
    tracked_buckets: [],
    bucket_stats: [],
    all_bucket_stats: [],
    total_objects: 0,
    total_bytes: 0,
    total_gigabytes: 0,
  },
  datasets: {
    rows_distribution: [],
    memory_distribution: [],
    memory_pie_segments: [],
  },
  disk: {
    total_bytes: 0,
    used_bytes: 0,
    free_bytes: 0,
    total_gigabytes: 0,
    used_gigabytes: 0,
    free_gigabytes: 0,
    free_percent: 0,
    used_percent: 0,
  },
  timestamp: "—",
  dataset_visibility: {},
  hidden_datasets: [],
};

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
  extraActions?: Array<{
    label: string;
    onAction: () => Promise<void>;
  }>;
}

type TransferKind = "full" | "vlm" | "embeddings";
type SnapshotImportMode = "replace" | "append";
type ActionMessageScope = "cleanup" | "storage" | "snapshot";

const SNAPSHOT_ACTION_IDS = [
  "download-full",
  "download-embeddings",
  "download-vlm",
  "import-snapshot",
] as const;
const SNAPSHOT_UI_STATE_STORAGE_KEY = "avsp_snapshot_transfer_ui_v1";
const OBJECT_BROWSER_ROW_HEIGHT_PX = 64;
const OBJECT_BROWSER_VIRTUAL_OVERSCAN_ROWS = 6;

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

interface SnapshotUiStateStorage {
  actionInProgress: SnapshotActionId | null;
  snapshotActionProgress: Partial<Record<SnapshotActionId, number>>;
  snapshotTransferSize: Partial<Record<SnapshotActionId, SnapshotTransferSize>>;
  snapshotProgressMeta: Partial<Record<SnapshotActionId, SnapshotProgressMeta>>;
  snapshotImportInlineMessage: string | null;
  snapshotWarningMessage: string | null;
}

function jobTypeToSnapshotActionId(jobType: string): SnapshotActionId | null {
  if (jobType === "snapshot_import") return "import-snapshot";
  if (jobType === "snapshot_export_full") return "download-full";
  if (jobType === "snapshot_export_embeddings") return "download-embeddings";
  if (jobType === "snapshot_export_vlm") return "download-vlm";
  return null;
}

function isRunningSnapshotActionJob(
  job: Record<string, unknown>,
  actionId: SnapshotActionId
): boolean {
  const status = String(job?.status || "").trim().toLowerCase();
  if (status !== "running") return false;

  const jobType = String(job?.job_type || "").trim();
  const directAction = jobTypeToSnapshotActionId(jobType);
  if (directAction === actionId) {
    return true;
  }

  if (actionId === "import-snapshot") {
    return false;
  }

  if (jobType !== "snapshot_export" && jobType !== "snapshot_transfer") {
    return false;
  }

  const config =
    job?.job_config && typeof job.job_config === "object"
      ? (job.job_config as Record<string, unknown>)
      : {};
  const kind = String(config.kind || "").trim().toLowerCase();
  if (actionId === "download-full") {
    return !kind || kind === "full";
  }
  if (actionId === "download-embeddings") {
    return kind === "embeddings";
  }
  if (actionId === "download-vlm") {
    return kind === "vlm";
  }
  return false;
}

function resolveSnapshotActionIdFromJob(
  job: Record<string, unknown>
): SnapshotActionId | null {
  const jobType = String(job?.job_type || "").trim();
  const directAction = jobTypeToSnapshotActionId(jobType);
  if (directAction) {
    return directAction;
  }
  if (jobType !== "snapshot_export" && jobType !== "snapshot_transfer") {
    return null;
  }
  const config =
    job?.job_config && typeof job.job_config === "object"
      ? (job.job_config as Record<string, unknown>)
      : {};
  const kind = String(config.kind || "").trim().toLowerCase();
  if (kind === "embeddings") return "download-embeddings";
  if (kind === "vlm") return "download-vlm";
  return "download-full";
}

function isSnapshotActionId(value: string): value is SnapshotActionId {
  return (SNAPSHOT_ACTION_IDS as readonly string[]).includes(value);
}

function toErrorMessage(value: unknown): string {
  if (typeof value === "string" && value.trim()) {
    const text = value.trim();
    const lowered = text.toLowerCase();
    if (
      lowered.startsWith("<!doctype html") ||
      lowered.startsWith("<html") ||
      lowered.includes("\"page\":\"/_error\"") ||
      lowered.includes("unexpected end of json input")
    ) {
      return "";
    }
    return text;
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

function isTransientFetchFailure(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  const status = Number(error.response?.status || 0);
  const message = String(error.message || "").toLowerCase();
  const detail = String(error.response?.data?.detail || error.response?.data?.error || "").toLowerCase();
  const rawPayload = String(
    typeof error.response?.data === "string"
      ? error.response?.data
      : JSON.stringify(error.response?.data || {})
  ).toLowerCase();
  return (
    (status >= 500 && status < 600) ||
    message.includes("fetch failed") ||
    message.includes("network error") ||
    message.includes("timeout") ||
    message.includes("request failed with status code 500") ||
    detail.includes("fetch failed") ||
    detail.includes("connection refused") ||
    detail.includes("bad gateway") ||
    detail.includes("unexpected end of json input") ||
    rawPayload.includes("unexpected end of json input") ||
    rawPayload.includes("load-manifest.external.js") ||
    rawPayload.includes("pages-api.runtime.dev.js")
  );
}

function formatNumber(value: number, locale = "en-US"): string {
  return value.toLocaleString(locale);
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

function pct(value: number, digits = 2): string {
  const safeDigits = Math.max(0, digits);
  return `${value.toFixed(safeDigits)}%`;
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

function buildImportSummary(
  result: unknown,
  options: { language: unknown; formatNumberFn: (value: number) => string }
): string {
  const { language, formatNumberFn } = options;
  const t = (ru: string, en: string) => getLocalizedText(language, { ru, en }, en);
  if (!result || typeof result !== "object") {
    return t("Импорт завершен.", "Import completed.");
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
    const skippedExisting = Number(objects.skipped_existing || 0);
    const mode = String(payload.mode || "").trim();
    const objectsPart =
      skippedExisting > 0
        ? t(
            `объектов ${formatNumberFn(Number(objects.uploaded || 0))} (пропущено существующих ${formatNumberFn(skippedExisting)})`,
            `${formatNumberFn(Number(objects.uploaded || 0))} objects (skipped existing: ${formatNumberFn(skippedExisting)})`
          )
        : t(
            `объектов ${formatNumberFn(Number(objects.uploaded || 0))}`,
            `${formatNumberFn(Number(objects.uploaded || 0))} objects`
          );
    const modePart = mode === "append" ? t(" (добавление)", " (append)") : "";
    return (
      `${t("Импорт полного снапшота", "Full snapshot import")}${modePart}: ${objectsPart}, ` +
      `${t("embeddings", "embeddings")} ${formatNumberFn(Number(embeddings.upserted || 0))}, ` +
      `${t("VLM аннотаций", "VLM annotations")} ${formatNumberFn(Number(vlm.upserted_annotations || 0))}.`
    );
  }

  if (format === "avsp.embedder.annotations.v1") {
    const embeddings =
      payload.embeddings && typeof payload.embeddings === "object"
        ? (payload.embeddings as Record<string, unknown>)
        : {};
    return t(
      `Импорт embeddings: upsert ${formatNumberFn(Number(embeddings.upserted || 0))}.`,
      `Embeddings import: upsert ${formatNumberFn(Number(embeddings.upserted || 0))}.`
    );
  }

  if (format === "avsp.vlm.annotations.v1") {
    const vlm =
      payload.vlm && typeof payload.vlm === "object"
        ? (payload.vlm as Record<string, unknown>)
        : {};
    return (
      `${t("Импорт VLM", "VLM import")}: ` +
      `${t("полей", "fields")} ${formatNumberFn(Number(vlm.saved_fields || 0))}, ` +
      `${t("аннотаций", "annotations")} ${formatNumberFn(Number(vlm.upserted_annotations || 0))}.`
    );
  }

  return t("Импорт завершен.", "Import completed.");
}

function buildImportWarnings(result: unknown, language: unknown): string[] {
  const t = (ru: string, en: string) => getLocalizedText(language, { ru, en }, en);
  if (!result || typeof result !== "object") {
    return [];
  }
  const payload = result as Record<string, unknown>;
  const warnings: string[] = [];
  const rawWarnings = Array.isArray(payload.warnings) ? payload.warnings : [];
  for (const item of rawWarnings) {
    const text = String(item || "").trim();
    if (text) warnings.push(text);
  }
  const vlm =
    payload.vlm && typeof payload.vlm === "object"
      ? (payload.vlm as Record<string, unknown>)
      : null;
  const mode = String(payload.mode || "").trim().toLowerCase();
  const diff =
    vlm?.fields_diff && typeof vlm.fields_diff === "object"
      ? (vlm.fields_diff as Record<string, unknown>)
      : null;
  if (mode === "append" && diff) {
    const missingInSnapshot = Array.isArray(diff.missing_in_snapshot)
      ? diff.missing_in_snapshot.map((v) => String(v || "").trim()).filter(Boolean)
      : [];
    const missingInExisting = Array.isArray(diff.missing_in_existing)
      ? diff.missing_in_existing.map((v) => String(v || "").trim()).filter(Boolean)
      : [];
    const changed = Array.isArray(diff.changed)
      ? diff.changed.map((v) => String(v || "").trim()).filter(Boolean)
      : [];
    if (missingInSnapshot.length > 0 || missingInExisting.length > 0 || changed.length > 0) {
      const parts: string[] = [];
      if (missingInSnapshot.length > 0) {
        parts.push(
          t(
            `в текущей схеме есть лишние поля: ${missingInSnapshot.join(", ")}`,
            `extra fields in current schema: ${missingInSnapshot.join(", ")}`
          )
        );
      }
      if (missingInExisting.length > 0) {
        parts.push(
          t(
            `в снапшоте есть новые поля: ${missingInExisting.join(", ")}`,
            `new fields in snapshot: ${missingInExisting.join(", ")}`
          )
        );
      }
      if (changed.length > 0) {
        parts.push(
          t(
            `совпадающие поля с отличиями prompt/type: ${changed.join(", ")}`,
            `matching fields with prompt/type differences: ${changed.join(", ")}`
          )
        );
      }
      warnings.push(
        t(
          `Append VLM: различия полей (${parts.join("; ")}).`,
          `Append VLM: field differences (${parts.join("; ")}).`
        )
      );
    }
  }
  return warnings;
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
  hoverHintLabel,
  hoverHintValue,
}: {
  title: string;
  subtitle: string;
  slices: PieSlice[];
  hoverHintLabel: string;
  hoverHintValue: string;
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
              {hasHover ? hoveredLabel : hoverHintLabel}
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
                : hoverHintValue}
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

function VlmFieldCoverageChart({
  rows,
  summary,
  tr,
}: {
  rows: VlmFieldCoverageRow[];
  summary?: VlmFieldCoverageSummary | null;
  tr: (ru: string, en: string) => string;
}) {
  const [showValid, setShowValid] = useState(true);
  const [showFallback, setShowFallback] = useState(true);
  const [showMissing, setShowMissing] = useState(false);

  if (!rows.length) {
    return (
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <h3 className="text-lg font-semibold text-slate-900">
          {tr("Покрытие полей VLM", "VLM Field Coverage")}
        </h3>
        <p className="mt-1 text-xs text-slate-500">
          {tr(
            "Разбивка по полям: где чаще всего остаются пропуски.",
            "Per-field breakdown showing where missing values occur most often."
          )}
        </p>
        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
          {tr(
            "Данные по полям пока недоступны (нет полей VLM или нет сцен в текущем scope).",
            "Field-level data is not available yet (no VLM fields or no scenes in the current scope)."
          )}
        </div>
      </div>
    );
  }
  const sortedRows = [...rows].sort((left, right) => {
    if (right.missing_rows !== left.missing_rows) {
      return right.missing_rows - left.missing_rows;
    }
    return left.field_name.localeCompare(right.field_name);
  });

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <h3 className="text-lg font-semibold text-slate-900">
        {tr("Покрытие полей VLM", "VLM Field Coverage")}
      </h3>
      <p className="mt-1 text-xs text-slate-500">
        {tr(
          "По каждому полю: валидные значения, вероятные parse-fallback, пропуски.",
          "Per field: valid values, probable parse-fallback values, and missing values."
        )}
      </p>
      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-emerald-800">
          <input
            type="checkbox"
            checked={showValid}
            onChange={(event) => setShowValid(event.target.checked)}
            className="h-3.5 w-3.5 accent-emerald-600"
          />
          {tr("валидные", "valid")}
        </label>
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-amber-800">
          <input
            type="checkbox"
            checked={showFallback}
            onChange={(event) => setShowFallback(event.target.checked)}
            className="h-3.5 w-3.5 accent-amber-600"
          />
          {tr("fallback", "fallback")}
        </label>
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-slate-300 bg-slate-100 px-2.5 py-1 text-slate-700">
          <input
            type="checkbox"
            checked={showMissing}
            onChange={(event) => setShowMissing(event.target.checked)}
            className="h-3.5 w-3.5 accent-slate-600"
          />
          {tr("пропуски", "missing")}
        </label>
      </div>
      {summary ? (
        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <div
            className={`rounded-xl border p-3 ${showValid ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-slate-50 opacity-50"}`}
          >
            <div className="text-[11px] uppercase tracking-wide text-emerald-700">
              {tr("Валидные", "Valid")}
            </div>
            <div className="mt-1 text-lg font-semibold text-emerald-900">
              {formatNumber(summary.valid_cells)}
            </div>
            <div className="text-xs text-emerald-700">{pct(summary.valid_percent)}</div>
          </div>
          <div
            className={`rounded-xl border p-3 ${showFallback ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-slate-50 opacity-50"}`}
          >
            <div className="text-[11px] uppercase tracking-wide text-amber-700">
              {tr("Parse fallback (оценка)", "Parse fallback (est.)")}
            </div>
            <div className="mt-1 text-lg font-semibold text-amber-900">
              {formatNumber(summary.invalid_cells)}
            </div>
            <div className="text-xs text-amber-700">{pct(summary.invalid_percent)}</div>
          </div>
          <div
            className={`rounded-xl border p-3 ${showMissing ? "border-slate-300 bg-slate-100" : "border-slate-200 bg-slate-50 opacity-50"}`}
          >
            <div className="text-[11px] uppercase tracking-wide text-slate-600">
              {tr("Пропуски", "Missing")}
            </div>
            <div className="mt-1 text-lg font-semibold text-slate-900">
              {formatNumber(summary.missing_cells)}
            </div>
            <div className="text-xs text-slate-600">{pct(summary.missing_percent)}</div>
          </div>
          <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-3">
            <div className="text-[11px] uppercase tracking-wide text-indigo-700">
              {tr("Заполнено", "Filled")}
            </div>
            <div className="mt-1 text-lg font-semibold text-indigo-900">
              {formatNumber(summary.filled_cells)}
            </div>
            <div className="text-xs text-indigo-700">{pct(summary.filled_percent)}</div>
          </div>
        </div>
      ) : null}
      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        {sortedRows.map((row) => {
          const filledRows = Number(row.filled_rows || 0);
          const validRows = Math.max(0, Number(row.valid_rows ?? filledRows));
          const invalidRows = Math.max(0, Number(row.invalid_rows || 0));
          const missingRows = Math.max(0, Number(row.missing_rows || 0));
          const totalRows = Math.max(1, validRows + invalidRows + missingRows);
          const activeDenominator =
            (showValid ? validRows : 0) +
            (showFallback ? invalidRows : 0) +
            (showMissing ? missingRows : 0);
          const normalizedDenominator = Math.max(1, activeDenominator);
          const validWidth = showValid ? (validRows / normalizedDenominator) * 100 : 0;
          const invalidWidth = showFallback ? (invalidRows / normalizedDenominator) * 100 : 0;
          const missingWidth = showMissing ? (missingRows / normalizedDenominator) * 100 : 0;
          const validPctOfAll = (validRows / totalRows) * 100;
          const invalidPctOfAll = (invalidRows / totalRows) * 100;
          const missingPctOfAll = (missingRows / totalRows) * 100;
          return (
            <div key={row.field_name} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <div className="font-medium text-slate-800">
                  {row.field_name}
                  {row.response_type ? (
                    <span className="ml-2 text-xs font-normal text-slate-500">
                      ({row.response_type})
                    </span>
                  ) : null}
                </div>
                <div className="text-xs text-slate-600">
                  {tr("валидные", "valid")} {formatNumber(validRows)} • {tr("fallback", "fallback")}{" "}
                  {formatNumber(invalidRows)} • {tr("пропуски", "missing")}{" "}
                  {formatNumber(missingRows)}
                </div>
              </div>
              <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-slate-200">
                <div className="flex h-full w-full">
                  {showValid ? (
                    <div
                      className="h-full bg-emerald-500"
                      style={{ width: `${validWidth}%` }}
                    />
                  ) : null}
                  {showFallback ? (
                    <div
                      className="h-full bg-amber-400"
                      style={{ width: `${invalidWidth}%` }}
                    />
                  ) : null}
                  {showMissing ? (
                    <div
                      className="h-full bg-slate-400"
                      style={{ width: `${missingWidth}%` }}
                    />
                  ) : null}
                </div>
              </div>
              <div className="mt-1 flex flex-wrap justify-between gap-1 text-[11px] text-slate-500">
                <span>{tr("валидные", "valid")}: {pct(validPctOfAll)}</span>
                <span>{tr("fallback", "fallback")}: {pct(invalidPctOfAll)}</span>
                <span>{tr("пропуски", "missing")}: {pct(missingPctOfAll)}</span>
              </div>
              {Array.isArray(row.invalid_examples) && row.invalid_examples.length > 0 ? (
                <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
                  Примеры:{" "}
                  {row.invalid_examples
                    .map((item) => `${item.value || "∅"} (${formatNumber(Number(item.count || 0))})`)
                    .join(", ")}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function StoragePanel({
  language = "ru",
  showSnapshotSection = true,
  showVlmFieldBreakdown = false,
}: {
  language?: UiLanguageCode;
  showSnapshotSection?: boolean;
  showVlmFieldBreakdown?: boolean;
}) {
  const tr = (ru: string, en: string) =>
    getLocalizedText(language, { ru, en }, en);
  const numberLocale = getUiLanguageLocale(language);
  const formatNum = (value: number) => formatNumber(value, numberLocale);
  const pctText = (value: number, digits = 2) => pct(value, digits);
  const [stats, setStats] = useState<StorageStatsResponse>(EMPTY_STORAGE_STATS);
  const [hasLoadedStats, setHasLoadedStats] = useState(false);
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
  const [filteredObjectsCursor, setFilteredObjectsCursor] = useState("");
  const [filteredObjectsPrevCursors, setFilteredObjectsPrevCursors] = useState<string[]>([]);
  const [filteredObjectsNextCursor, setFilteredObjectsNextCursor] = useState("");
  const [objectBrowserScrollTop, setObjectBrowserScrollTop] = useState(0);
  const [objectBrowserViewportHeight, setObjectBrowserViewportHeight] = useState(420);
  const [previewObjectId, setPreviewObjectId] = useState<string | null>(null);
  const [cleanupStatusMessage, setCleanupStatusMessage] = useState<string | null>(null);
  const [cleanupWarningMessage, setCleanupWarningMessage] = useState<string | null>(null);
  const [storageStatusMessage, setStorageStatusMessage] = useState<string | null>(null);
  const [storageWarningMessage, setStorageWarningMessage] = useState<string | null>(null);
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
  const [snapshotWarningMessage, setSnapshotWarningMessage] = useState<string | null>(null);
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
  const objectBrowserViewportRef = useRef<HTMLDivElement | null>(null);
  const normalizedObjectsQuery = objectsSearchQuery.trim().toLowerCase();
  const hasObjectsFilter = Boolean(objectsDatasetFilter || normalizedObjectsQuery);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SNAPSHOT_UI_STATE_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as Partial<SnapshotUiStateStorage>;
      const nextActionInProgress =
        typeof parsed?.actionInProgress === "string" && isSnapshotActionId(parsed.actionInProgress)
          ? parsed.actionInProgress
          : null;
      if (nextActionInProgress) {
        setActionInProgress(nextActionInProgress);
      }

      const nextProgress: Partial<Record<SnapshotActionId, number>> = {};
      const rawProgress =
        parsed?.snapshotActionProgress && typeof parsed.snapshotActionProgress === "object"
          ? parsed.snapshotActionProgress
          : {};
      for (const [key, value] of Object.entries(rawProgress)) {
        if (!isSnapshotActionId(key)) continue;
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) continue;
        nextProgress[key] = Math.max(0, Math.min(100, numeric));
      }
      if (Object.keys(nextProgress).length > 0) {
        setSnapshotActionProgress(nextProgress);
      }

      const nextTransferSize: Partial<Record<SnapshotActionId, SnapshotTransferSize>> = {};
      const rawTransferSize =
        parsed?.snapshotTransferSize && typeof parsed.snapshotTransferSize === "object"
          ? parsed.snapshotTransferSize
          : {};
      for (const [key, value] of Object.entries(rawTransferSize)) {
        if (!isSnapshotActionId(key) || !value || typeof value !== "object") continue;
        const loaded = Math.max(0, Number((value as SnapshotTransferSize).loadedBytes || 0));
        const rawTotal = Number((value as SnapshotTransferSize).totalBytes);
        const total =
          Number.isFinite(rawTotal) && rawTotal >= 0 ? rawTotal : null;
        nextTransferSize[key] = { loadedBytes: loaded, totalBytes: total };
      }
      if (Object.keys(nextTransferSize).length > 0) {
        setSnapshotTransferSize(nextTransferSize);
      }

      const nextMeta: Partial<Record<SnapshotActionId, SnapshotProgressMeta>> = {};
      const rawMeta =
        parsed?.snapshotProgressMeta && typeof parsed.snapshotProgressMeta === "object"
          ? parsed.snapshotProgressMeta
          : {};
      for (const [key, value] of Object.entries(rawMeta)) {
        if (!isSnapshotActionId(key) || !value || typeof value !== "object") continue;
        const phase = String((value as SnapshotProgressMeta).phase || "").trim().toLowerCase();
        const status = String((value as SnapshotProgressMeta).status || "").trim().toLowerCase();
        const hint = String((value as SnapshotProgressMeta).hint || "").trim();
        nextMeta[key] = { phase, status, hint };
      }
      if (Object.keys(nextMeta).length > 0) {
        setSnapshotProgressMeta(nextMeta);
      }

      if (typeof parsed?.snapshotImportInlineMessage === "string") {
        setSnapshotImportInlineMessage(parsed.snapshotImportInlineMessage || null);
      }
      if (typeof parsed?.snapshotWarningMessage === "string") {
        setSnapshotWarningMessage(parsed.snapshotWarningMessage || null);
      }
    } catch {
    }
  }, []);

  useEffect(() => {
    const snapshotActionInProgress =
      actionInProgress && isSnapshotActionId(actionInProgress) ? actionInProgress : null;
    const hasSnapshotState =
      Boolean(snapshotActionInProgress) ||
      Object.keys(snapshotActionProgress).length > 0 ||
      Object.keys(snapshotTransferSize).length > 0 ||
      Object.keys(snapshotProgressMeta).length > 0 ||
      Boolean(snapshotImportInlineMessage) ||
      Boolean(snapshotWarningMessage);
    if (!hasSnapshotState) {
      window.localStorage.removeItem(SNAPSHOT_UI_STATE_STORAGE_KEY);
      return;
    }
    const payload: SnapshotUiStateStorage = {
      actionInProgress: snapshotActionInProgress,
      snapshotActionProgress,
      snapshotTransferSize,
      snapshotProgressMeta,
      snapshotImportInlineMessage,
      snapshotWarningMessage,
    };
    window.localStorage.setItem(SNAPSHOT_UI_STATE_STORAGE_KEY, JSON.stringify(payload));
  }, [
    actionInProgress,
    snapshotActionProgress,
    snapshotTransferSize,
    snapshotProgressMeta,
    snapshotImportInlineMessage,
    snapshotWarningMessage,
  ]);

  useEffect(() => {
    if (!snapshotExportInlineMessage) {
      return;
    }
    const isSuccessExportMessage =
      snapshotExportInlineMessage.startsWith("Файл '") &&
      snapshotExportInlineMessage.endsWith("' выгружен.");
    if (!isSuccessExportMessage) {
      return;
    }
    const timer = setTimeout(() => {
      setSnapshotExportInlineMessage((current) =>
        current === snapshotExportInlineMessage ? null : current
      );
    }, 12000);
    return () => clearTimeout(timer);
  }, [snapshotExportInlineMessage]);

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

  useEffect(() => {
    const root = objectBrowserViewportRef.current;
    if (!root) return;

    const updateViewport = () => {
      setObjectBrowserViewportHeight(Math.max(220, root.clientHeight || 0));
      setObjectBrowserScrollTop(root.scrollTop || 0);
    };

    updateViewport();

    const onScroll = () => {
      setObjectBrowserScrollTop(root.scrollTop || 0);
    };
    root.addEventListener("scroll", onScroll, { passive: true });

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(updateViewport);
      resizeObserver.observe(root);
    } else {
      window.addEventListener("resize", updateViewport);
    }

    return () => {
      root.removeEventListener("scroll", onScroll);
      if (resizeObserver) {
        resizeObserver.disconnect();
      } else {
        window.removeEventListener("resize", updateViewport);
      }
    };
  }, []);

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
    exportId: string | null | undefined,
    actionId: SnapshotActionId
  ) => {
    stopSnapshotExportProgressPoll();
    const token = snapshotExportPollTokenRef.current;
    const normalizedExportId = String(exportId || "").trim();

    const syncFromJobs = async (): Promise<boolean> => {
      const jobsResponse = await axios.get("/api/jobs");
      const jobs = Array.isArray(jobsResponse.data?.jobs)
        ? (jobsResponse.data.jobs as Array<Record<string, unknown>>)
        : [];
      const targetJob = jobs
        .filter((job) => resolveSnapshotActionIdFromJob(job) === actionId)
        .sort((left, right) => Number(right?.created_at || 0) - Number(left?.created_at || 0))[0];

      if (!targetJob) {
        clearSnapshotProgress(actionId);
        setActionInProgress((current) => (current === actionId ? null : current));
        return true;
      }

      const status = String(targetJob.status || "").trim().toLowerCase();
      const phase = String(targetJob.phase || "").trim().toLowerCase();
      const progress = Math.max(0, Math.min(100, Number(targetJob.progress || 0)));
      const totalSeen = Math.max(0, Number(targetJob.total_seen || 0));
      const totalPlannedRaw = Number(targetJob.total_planned || targetJob.total_limit || 0);
      const totalPlanned =
        Number.isFinite(totalPlannedRaw) && totalPlannedRaw > 0 ? totalPlannedRaw : null;
      updateSnapshotTransferSize(actionId, totalSeen, totalPlanned, { monotonic: false });
      updateSnapshotProgress(actionId, progress, "set");
      let hint = "";
      if (phase === "preparing") {
        hint = "Preparing snapshot...";
      } else if (phase === "archiving") {
        hint = "Archiving snapshot...";
      } else if (phase === "streaming") {
        hint = "Streaming snapshot...";
      }
      updateSnapshotProgressMeta(actionId, { phase, status, hint });

      if (status === "error") {
        setSnapshotExportInlineMessage("Ошибка при создании архива выгрузки.");
        setActionInProgress((current) => (current === actionId ? null : current));
        return true;
      }
      if (status === "cancelled") {
        setSnapshotExportInlineMessage("Выгрузка и создание архива отменены.");
        setActionInProgress((current) => (current === actionId ? null : current));
        return true;
      }
      if (status === "success") {
        setActionInProgress((current) => (current === actionId ? null : current));
        return true;
      }
      return false;
    };

    const scheduleNext = (delayMs: number) => {
      snapshotExportPollTimerRef.current = setTimeout(async () => {
        if (token !== snapshotExportPollTokenRef.current) {
          return;
        }
        try {
          if (!normalizedExportId) {
            const done = await syncFromJobs();
            if (done) {
              return;
            }
            const nextDelay =
              typeof document !== "undefined" && document.visibilityState !== "visible"
                ? 1400
                : 350;
            scheduleNext(nextDelay);
            return;
          }

          const response = await axios.get("/api/storage/transfer/export-progress", {
            params: {
              export_id: normalizedExportId,
              _ts: Date.now(),
            },
            headers: {
              "Cache-Control": "no-cache",
              Pragma: "no-cache",
            },
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
                  ? tr(
                      `Подготовка: ${formatNum(preparedObjects)} объектов`,
                      `Preparing: ${formatNum(preparedObjects)} objects`
                    )
                  : tr("Подготовка snapshot...", "Preparing snapshot...");
            } else if (phase === "archiving") {
              hint = tr("Архивация snapshot...", "Archiving snapshot...");
            } else if (phase === "streaming") {
              hint = tr("Передача snapshot...", "Streaming snapshot...");
            }
          }
          updateSnapshotProgressMeta(actionId, { phase, status, hint });

          if (shownTotal && shownTotal > 0) {
            const ratio = Math.min(1, Math.max(0, shownBytes / shownTotal));
            updateSnapshotProgress(actionId, ratio * 100, "max");
          }

          if (status === "error" || phase === "error") {
            setSnapshotExportInlineMessage(
              tr("Ошибка при создании архива выгрузки.", "Failed to create export archive.")
            );
            setActionInProgress((current) => (current === actionId ? null : current));
            return;
          }
          if (status === "cancelled" || phase === "cancelled") {
            setSnapshotExportInlineMessage(
              tr("Выгрузка и создание архива отменены.", "Export and archive creation were cancelled.")
            );
            setActionInProgress((current) => (current === actionId ? null : current));
            return;
          }
          if (status === "done" || phase === "done") {
            setActionInProgress((current) => (current === actionId ? null : current));
            return;
          }
          if (phase === "unknown" || status === "unknown") {
            const done = await syncFromJobs();
            if (done) {
              return;
            }
          }
        } catch {
          try {
            const done = await syncFromJobs();
            if (done) {
              return;
            }
          } catch {
          }
        }
        if (token === snapshotExportPollTokenRef.current) {
          const nextDelay =
            typeof document !== "undefined" && document.visibilityState !== "visible"
              ? 1400
              : 350;
          scheduleNext(nextDelay);
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
            hint:
              phase === "uploading"
                ? tr("Загрузка snapshot...", "Uploading snapshot...")
                : tr("Распаковка и применение snapshot...", "Extracting and applying snapshot..."),
          });
          if (status === "running") {
            if (phase === "processing") {
              setSnapshotImportInlineMessage(
                tr(
                  "Разархивация и импорт снапшота продолжаются...",
                  "Extracting and importing snapshot..."
                )
              );
            } else if (phase === "uploading") {
              setSnapshotImportInlineMessage(
                tr("Загрузка снапшота продолжается...", "Uploading snapshot...")
              );
            }
          }

          if (status === "error") {
            setSnapshotImportInlineMessage(
              tr("Ошибка при импорте снапшота.", "Snapshot import failed.")
            );
            setActionInProgress((current) => (current === actionId ? null : current));
            return;
          }
          if (status === "cancelled") {
            setSnapshotImportInlineMessage(
              tr("Импорт и распаковка архива отменены.", "Import and archive extraction were cancelled.")
            );
            setActionInProgress((current) => (current === actionId ? null : current));
            return;
          }
          if (status === "success") {
            setActionInProgress((current) => (current === actionId ? null : current));
            return;
          }
        } catch {
        }
        if (token === snapshotImportPollTokenRef.current) {
          const nextDelay =
            typeof document !== "undefined" && document.visibilityState !== "visible"
              ? 1800
              : 450;
          scheduleNext(nextDelay);
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
        const runningJob = jobs
          .filter((job) => isRunningSnapshotActionJob(job, actionId))
          .sort((left, right) => Number(right?.created_at || 0) - Number(left?.created_at || 0))[0];
        const jobID = String(runningJob?.job_id || "").trim();
        if (jobID) {
          await axios.post("/api/jobs/cancel", { job_id: jobID });
        }
      } catch {
      }
    }
    updateSnapshotProgressMeta(actionId, {
      status: "cancelled",
      hint: tr("Отмена...", "Cancelling..."),
    });
    if (actionId === "import-snapshot") {
      stopSnapshotImportProgressPoll();
      setSnapshotImportInlineMessage(
        tr("Импорт и распаковка архива отменены.", "Import and archive extraction were cancelled.")
      );
      return;
    }
    setSnapshotExportInlineMessage(
      tr("Выгрузка и создание архива отменены.", "Export and archive creation were cancelled.")
    );
  };

  const askCancelSnapshotAction = (actionId: SnapshotActionId) => {
    const title =
      actionId === "import-snapshot"
        ? tr("Отменить импорт snapshot", "Cancel snapshot import")
        : tr("Отменить экспорт snapshot", "Cancel snapshot export");
    const description =
      actionId === "import-snapshot"
        ? tr("Остановить импорт и распаковку snapshot?", "Stop snapshot import and extraction?")
        : tr("Остановить создание и выгрузку snapshot?", "Stop snapshot export and archive creation?");
    openConfirmDialog({
      title,
      description,
      confirmLabel: tr("Остановить", "Stop"),
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

  const loadStats = async (
    showLoader = false,
    includeStorageDetails = true,
    forceRefresh = false
  ) => {
    if (showLoader) {
      setIsLoading(true);
    } else {
      setIsRefreshing(true);
    }
    try {
      const maxAttempts = showLoader ? 4 : 1;
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const response = await axios.get("/api/storage/stats", {
            params: {
              include_storage_details: includeStorageDetails ? 1 : 0,
              force_refresh: forceRefresh ? 1 : 0,
              include_vlm_field_breakdown: showVlmFieldBreakdown ? 1 : 0,
            },
          });
          setStats(response.data);
          setHasLoadedStats(true);
          setErrorMessage(null);
          return;
        } catch (error) {
          lastError = error;
          if (!isTransientFetchFailure(error) || attempt === maxAttempts) {
            break;
          }
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 500 * attempt);
          });
        }
      }
      const message = isTransientFetchFailure(lastError)
        ? tr(
            "Storage server запускается. Повторите через несколько секунд.",
            "Storage server is starting up. Retry in a few seconds."
          )
        : extractAxiosErrorMessage(
            lastError,
            tr("Не удалось загрузить статистику storage", "Failed to load storage stats")
          );
      setErrorMessage(message);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      if (cancelled) return;
      await loadStats(true, false);
      if (cancelled) return;
      await loadStats(false, true);
    };
    void boot();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hasLoadedStats) return;
    loadStats(false, true, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showVlmFieldBreakdown]);

  useEffect(() => {
    let cancelled = false;
    const clearRestoredSnapshotStateIfNoLiveJob = () => {
      setActionInProgress((current) =>
        current && isSnapshotActionId(current) ? null : current
      );
      for (const snapshotActionId of SNAPSHOT_ACTION_IDS) {
        clearSnapshotProgress(snapshotActionId);
      }
    };

    const restoreSnapshotAction = async () => {
      try {
        const response = await axios.get("/api/jobs");
        const jobs = Array.isArray(response.data?.jobs)
          ? (response.data.jobs as Array<Record<string, unknown>>)
          : [];
        const runningSnapshotJobs = jobs
          .filter((job) => String(job?.status || "").trim().toLowerCase() === "running")
          .map((job) => ({
            job,
            actionId: resolveSnapshotActionIdFromJob(job),
          }))
          .filter(
            (item): item is { job: Record<string, unknown>; actionId: SnapshotActionId } =>
              item.actionId !== null
          )
          .sort(
            (left, right) =>
              Number(right.job?.created_at || 0) - Number(left.job?.created_at || 0)
          );
        const runningSnapshotJob = runningSnapshotJobs[0];

        if (cancelled) {
          return;
        }
        if (!runningSnapshotJob) {
          clearRestoredSnapshotStateIfNoLiveJob();
          return;
        }

        const actionId = runningSnapshotJob.actionId;
        const runningJob = runningSnapshotJob.job;

        const progress = Math.max(0, Math.min(100, Number(runningJob.progress || 0)));
        const totalSeen = Math.max(0, Number(runningJob.total_seen || 0));
        const totalPlannedRaw = Number(runningJob.total_planned || runningJob.total_limit || 0);
        const totalPlanned =
          Number.isFinite(totalPlannedRaw) && totalPlannedRaw > 0 ? totalPlannedRaw : null;

        setActionInProgress(actionId);
        updateSnapshotProgress(actionId, progress, "set");
        updateSnapshotTransferSize(actionId, totalSeen, totalPlanned);

        if (actionId === "import-snapshot") {
          const restoredPhase = String(runningJob.phase || "")
            .trim()
            .toLowerCase();
          setSnapshotImportInlineMessage(
            restoredPhase === "processing"
              ? tr("Разархивация и импорт снапшота продолжаются...", "Extracting and importing snapshot...")
              : tr("Загрузка снапшота продолжается...", "Uploading snapshot...")
          );
          const jobConfig =
            runningJob.job_config && typeof runningJob.job_config === "object"
              ? (runningJob.job_config as Record<string, unknown>)
              : {};
          const importId = String(jobConfig.import_id || "").trim();
          updateSnapshotProgressMeta(actionId, {
            phase: restoredPhase || "processing",
            status: "running",
            hint: tr("Распаковка и применение snapshot...", "Extracting and applying snapshot..."),
          });
          if (importId) {
            startSnapshotImportProgressPoll(importId, actionId);
          }
          return;
        }

        setSnapshotExportInlineMessage(
          tr("Выгрузка снапшота продолжается...", "Snapshot export is in progress...")
        );
        const jobConfig =
          runningJob.job_config && typeof runningJob.job_config === "object"
            ? (runningJob.job_config as Record<string, unknown>)
            : {};
        const exportId = String(jobConfig.export_id || "").trim();
        startSnapshotExportProgressPoll(exportId || null, actionId);
      } catch {
        if (!cancelled) {
          clearRestoredSnapshotStateIfNoLiveJob();
        }
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
      const message = extractAxiosErrorMessage(
        error,
        tr("Не удалось загрузить объекты", "Failed to load objects")
      );
      setErrorMessage(message);
    } finally {
      setObjectsLoading(false);
    }
  };

  const loadFilteredObjectsPage = async (
    cursor: string,
    prevCursors: string[],
    page: number,
    query: string,
    dataset: string
  ) => {
    setFilteredObjectsLoading(true);
    setErrorMessage(null);
    try {
      const response = await axios.get<ObjectListResponse>("/api/storage/objects", {
        params: {
          limit: objectsPageSize,
          q: query,
          dataset,
          ...(cursor ? { cursor } : {}),
        },
      });
      setFilteredObjects(response.data.items ?? []);
      setFilteredObjectsCursor(cursor);
      setFilteredObjectsPrevCursors(prevCursors);
      setFilteredObjectsNextCursor(response.data.next_cursor ?? "");
      setFilteredObjectsPage(page);
    } catch (error) {
      const message = extractAxiosErrorMessage(error, "Failed to search objects");
      setErrorMessage(message);
      setFilteredObjects([]);
    } finally {
      setFilteredObjectsLoading(false);
    }
  };

  useEffect(() => {
    if (hasObjectsFilter) {
      return;
    }
    loadObjectsPage("", [], 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectsPageSize, hasObjectsFilter]);

  useEffect(() => {
    if (!hasObjectsFilter) {
      setFilteredObjects(null);
      setFilteredObjectsLoading(false);
      setFilteredObjectsPage(1);
      setFilteredObjectsCursor("");
      setFilteredObjectsPrevCursors([]);
      setFilteredObjectsNextCursor("");
      return;
    }
    const query = normalizedObjectsQuery;
    const dataset = objectsDatasetFilter.trim().toLowerCase();
    const timer = setTimeout(() => {
      loadFilteredObjectsPage("", [], 1, query, dataset);
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normalizedObjectsQuery, objectsDatasetFilter, objectsPageSize, hasObjectsFilter]);

  useEffect(() => {
    if (!hasLoadedStats) return;
    if (cleanupDatasetFilter === "all") return;
    const isVisible = Boolean(stats.dataset_visibility?.[cleanupDatasetFilter] ?? true);
    if (!isVisible) {
      setCleanupDatasetFilter("all");
    }
  }, [hasLoadedStats, stats, cleanupDatasetFilter]);

  const clearScopedMessages = (scope: ActionMessageScope) => {
    if (scope === "snapshot") {
      setSnapshotWarningMessage(null);
      return;
    }
    if (scope === "storage") {
      setStorageStatusMessage(null);
      setStorageWarningMessage(null);
      return;
    }
    setCleanupStatusMessage(null);
    setCleanupWarningMessage(null);
  };

  const runStorageAction = async (
    actionId: string,
    fn: () => Promise<void>,
    scope: ActionMessageScope = "cleanup"
  ) => {
    setActionInProgress(actionId);
    clearScopedMessages(scope);
    setErrorMessage(null);
    try {
      await fn();
    } catch (error) {
      if (isCancelledActionError(error)) {
        if (isSnapshotActionId(actionId)) {
          updateSnapshotProgressMeta(actionId, {
            status: "cancelled",
            hint: tr("Операция отменена", "Operation cancelled"),
          });
          if (actionId === "import-snapshot") {
            setSnapshotImportInlineMessage(
              tr("Импорт и распаковка архива отменены.", "Import and archive extraction were cancelled.")
            );
          } else {
            setSnapshotExportInlineMessage(
              tr("Выгрузка и создание архива отменены.", "Export and archive creation were cancelled.")
            );
          }
          return;
        }
        if (scope === "storage") {
          setStorageWarningMessage(tr("Операция отменена.", "Operation cancelled."));
        } else if (scope === "snapshot") {
          setSnapshotWarningMessage(tr("Операция отменена.", "Operation cancelled."));
        } else {
          setCleanupWarningMessage(tr("Операция отменена.", "Operation cancelled."));
        }
        return;
      }
      const message = extractAxiosErrorMessage(error, tr("Операция завершилась ошибкой", "Operation failed"));
      if (scope === "snapshot") {
        if (actionId === "import-snapshot") {
          setSnapshotImportInlineMessage(null);
        }
        if (actionId === "download-full" || actionId === "download-embeddings" || actionId === "download-vlm") {
          setSnapshotExportInlineMessage(null);
        }
        setSnapshotWarningMessage(message);
      } else if (scope === "storage") {
        setStorageWarningMessage(message);
      } else {
        setCleanupWarningMessage(message);
      }
    } finally {
      setActionInProgress(null);
    }
  };

  const openConfirmDialog = (dialog: ConfirmDialogState) => {
    setConfirmDialogBusy(false);
    setConfirmDialog(dialog);
  };

  const executeConfirmDialog = async (actionOverride?: () => Promise<void>) => {
    if (!confirmDialog || confirmDialogBusy) return;
    setConfirmDialogBusy(true);
    const action = actionOverride || confirmDialog.onConfirm;
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

  const goToNextFilteredObjectsPage = async () => {
    if (!filteredObjectsNextCursor || filteredObjectsLoading) return;
    await loadFilteredObjectsPage(
      filteredObjectsNextCursor,
      [...filteredObjectsPrevCursors, filteredObjectsCursor],
      filteredObjectsPage + 1,
      normalizedObjectsQuery,
      objectsDatasetFilter.trim().toLowerCase()
    );
  };

  const goToPrevFilteredObjectsPage = async () => {
    if (filteredObjectsPrevCursors.length === 0 || filteredObjectsLoading) return;
    const prevCursor = filteredObjectsPrevCursors[filteredObjectsPrevCursors.length - 1] ?? "";
    const nextPrev = filteredObjectsPrevCursors.slice(0, -1);
    await loadFilteredObjectsPage(
      prevCursor,
      nextPrev,
      Math.max(1, filteredObjectsPage - 1),
      normalizedObjectsQuery,
      objectsDatasetFilter.trim().toLowerCase()
    );
  };

  const reloadCurrentObjectsView = async () => {
    if (hasObjectsFilter) {
      await loadFilteredObjectsPage(
        filteredObjectsCursor,
        filteredObjectsPrevCursors,
        filteredObjectsPage,
        normalizedObjectsQuery,
        objectsDatasetFilter.trim().toLowerCase()
      );
      return;
    }
    await loadObjectsPage(objectsCursor, objectsPrevCursors, objectsPage);
  };

  const deleteObject = async (objectId: string) => {
    openConfirmDialog({
      title: tr("Удалить объект", "Delete object"),
      description: tr(
        `Удалить объект ${objectId} из storage, векторов и связанных аннотаций?`,
        `Delete object ${objectId} from storage, vectors, and linked annotations?`
      ),
      confirmLabel: tr("Удалить объект", "Delete object"),
      onConfirm: async () => {
        await runStorageAction(`delete-object-${objectId}`, async () => {
          await axios.delete(`/api/storage/objects/${encodeURIComponent(objectId)}`);
          setStorageStatusMessage(
            tr(`Объект ${objectId} удален.`, `Object ${objectId} was deleted.`)
          );
          const shouldGoPrev = objects.length === 1 && objectsPrevCursors.length > 0;
          const cursor = shouldGoPrev
            ? objectsPrevCursors[objectsPrevCursors.length - 1] ?? ""
            : objectsCursor;
          const prevCursors = shouldGoPrev
            ? objectsPrevCursors.slice(0, -1)
            : objectsPrevCursors;
          const page = shouldGoPrev ? Math.max(1, objectsPage - 1) : objectsPage;
          if (hasObjectsFilter) {
            await Promise.all([
              loadStats(false, true, true),
              loadFilteredObjectsPage(
                filteredObjectsCursor,
                filteredObjectsPrevCursors,
                filteredObjectsPage,
                normalizedObjectsQuery,
                objectsDatasetFilter.trim().toLowerCase()
              ),
            ]);
          } else {
            await Promise.all([
              loadStats(false, true, true),
              loadObjectsPage(cursor, prevCursors, page),
            ]);
          }
          if (previewObjectId === objectId) {
            setPreviewObjectId(null);
          }
        }, "storage");
      },
    });
  };

  const deleteRandomEmbeddings = async () => {
    const count = Math.max(1, Number(randomEmbeddingsCount || 1));
    const dataset = cleanupDatasetFilter === "all" ? "" : cleanupDatasetFilter;
    openConfirmDialog({
      title: tr("Удалить случайные embeddings", "Delete random embeddings"),
      description: tr(
        `Удалить embeddings для ${count} случайных сцен${dataset ? ` в датасете '${dataset}'` : ""}?`,
        `Delete embeddings for ${count} random scenes${dataset ? ` in dataset '${dataset}'` : ""}?`
      ),
      confirmLabel: tr("Удалить embeddings", "Delete embeddings"),
      onConfirm: async () => {
        await runStorageAction("delete-random-embeddings", async () => {
          const response = await axios.post("/api/storage/delete-random-embeddings", {
            count,
            dataset,
            confirm: true,
          });
          const requested = Number(response.data?.requested_count || count);
          const available = Number(response.data?.available_embeddings || 0);
          const selected = Number(response.data?.selected_images || 0);
          const reset = Number(response.data?.reset_embeddings || 0);
          const orphanRemoved = Number(response.data?.orphan_embeddings_removed || 0);
          const shortageNote =
            selected < requested
              ? tr(
                  ` (доступно embeddings: ${formatNum(available)}, запрошено: ${formatNum(requested)})`,
                  ` (available embeddings: ${formatNum(available)}, requested: ${formatNum(requested)})`
                )
              : "";
          const orphanNote =
            orphanRemoved > 0
              ? tr(
                  `; удалено orphan embeddings: ${formatNum(orphanRemoved)}`,
                  `; orphan embeddings removed: ${formatNum(orphanRemoved)}`
                )
              : "";
          setCleanupStatusMessage(
            tr(
              `Сброшены embeddings: ${formatNum(reset)} из ${formatNum(requested)} выбранных сцен${shortageNote}${orphanNote}.`,
              `Embeddings reset: ${formatNum(reset)} of ${formatNum(requested)} selected scenes${shortageNote}${orphanNote}.`
            )
          );
          await loadStats(false, true, true);
        });
      },
    });
  };

  const deleteRandomVlm = async () => {
    const count = Math.max(1, Number(randomVlmCount || 1));
    const dataset = cleanupDatasetFilter === "all" ? "" : cleanupDatasetFilter;
    openConfirmDialog({
      title: tr("Удалить случайные VLM", "Delete random VLM"),
      description: tr(
        `Удалить VLM-аннотации для ${count} случайных сцен${dataset ? ` в датасете '${dataset}'` : ""}?`,
        `Delete VLM annotations for ${count} random scenes${dataset ? ` in dataset '${dataset}'` : ""}?`
      ),
      confirmLabel: tr("Удалить VLM", "Delete VLM"),
      onConfirm: async () => {
        await runStorageAction("delete-random-vlm", async () => {
          const response = await axios.post("/api/storage/delete-random-vlm", {
            count,
            dataset,
            confirm: true,
          });
          const requested = Number(response.data?.requested_count || count);
          const available = Number(response.data?.available_vlm_annotations || 0);
          const selected = Number(response.data?.selected_images || 0);
          const reset = Number(response.data?.reset_vlm_annotations || 0);
          const shortageNote =
            selected < requested
              ? tr(
                  ` (доступно VLM-аннотаций: ${formatNum(available)}, запрошено: ${formatNum(requested)})`,
                  ` (available VLM annotations: ${formatNum(available)}, requested: ${formatNum(requested)})`
                )
              : "";
          setCleanupStatusMessage(
            tr(
              `Сброшены VLM-аннотации: ${formatNum(reset)} из ${formatNum(selected)} выбранных сцен${shortageNote}.`,
              `VLM annotations reset: ${formatNum(reset)} of ${formatNum(selected)} selected scenes${shortageNote}.`
            )
          );
          await loadStats(false, true, true);
        });
      },
    });
  };

  const deleteDuplicates = async () => {
    const dataset = cleanupDatasetFilter === "all" ? "" : cleanupDatasetFilter;
    openConfirmDialog({
      title: tr("Удалить дубли", "Delete duplicates"),
      description: tr(
        `Удалить сцены-дубли по одинаковому storage_path${dataset ? ` в датасете '${dataset}'` : ""}, оставляя по одной строке?`,
        `Delete duplicate scenes by identical storage_path${dataset ? ` in dataset '${dataset}'` : ""}, keeping one row each?`
      ),
      confirmLabel: tr("Удалить дубли", "Delete duplicates"),
      onConfirm: async () => {
        await runStorageAction("delete-duplicates", async () => {
          const response = await axios.post("/api/storage/delete-duplicates", {
            dataset,
            confirm: true,
          });
          const candidates = Number(response.data?.duplicate_candidates || 0);
          const deleted = Number(response.data?.deleted_duplicates || 0);
          const failed = Number(response.data?.failed_duplicates || 0);
          setCleanupStatusMessage(
            tr(
              `Дубликаты обработаны: кандидатов ${formatNum(candidates)}, удалено ${formatNum(deleted)}, ошибок ${formatNum(failed)}.`,
              `Duplicates processed: candidates ${formatNum(candidates)}, deleted ${formatNum(deleted)}, failed ${formatNum(failed)}.`
            )
          );
          await Promise.all([
            loadStats(false, true, true),
            reloadCurrentObjectsView(),
          ]);
        });
      },
    });
  };

  const deleteRandomImagesHard = async () => {
    const count = Math.max(1, Number(randomHardDeleteCount || 1));
    const dataset = cleanupDatasetFilter === "all" ? "" : cleanupDatasetFilter;
    openConfirmDialog({
      title: tr("Полное удаление случайных сцен", "Hard delete random scenes"),
      description: tr(
        `Полностью удалить ${count} случайных сцен${dataset ? ` в датасете '${dataset}'` : ""} (изображение, векторы, VLM-аннотации)?`,
        `Hard delete ${count} random scenes${dataset ? ` in dataset '${dataset}'` : ""} (image, vectors, VLM annotations)?`
      ),
      confirmLabel: tr("Удалить сцены", "Delete scenes"),
      onConfirm: async () => {
        await runStorageAction("delete-random-images", async () => {
          const response = await axios.post("/api/storage/delete-random-images", {
            count,
            dataset,
            confirm: true,
          });
          const requested = Number(response.data?.requested_count || count);
          const available = Number(response.data?.available_images || 0);
          const selected = Number(response.data?.selected_images || 0);
          const deleted = Number(response.data?.deleted_images || 0);
          const failed = Number(response.data?.failed_images || 0);
          const shortageNote =
            selected < requested
              ? tr(
                  ` (доступно сцен: ${formatNum(available)}, запрошено: ${formatNum(requested)})`,
                  ` (available scenes: ${formatNum(available)}, requested: ${formatNum(requested)})`
                )
              : "";
          setCleanupStatusMessage(
            tr(
              `Полное удаление сцен: выбрано ${formatNum(selected)} из ${formatNum(requested)}, удалено ${formatNum(deleted)}, ошибок ${formatNum(failed)}${shortageNote}.`,
              `Hard delete result: selected ${formatNum(selected)} of ${formatNum(requested)}, deleted ${formatNum(deleted)}, failed ${formatNum(failed)}${shortageNote}.`
            )
          );
          await Promise.all([
            loadStats(false, true, true),
            reloadCurrentObjectsView(),
          ]);
          if (failed > 0) {
            setCleanupWarningMessage(
              tr(
                "Часть сцен не удалена. Проверьте детали в ответе API/логах.",
                "Some scenes were not deleted. Check API response/logs for details."
              )
            );
          }
        });
      },
    });
  };

  const deleteDataset = async (dataset: string) => {
    openConfirmDialog({
      title: tr("Удалить датасет", "Delete dataset"),
      description: tr(
        `Полностью удалить датасет '${dataset}' (все сцены, векторы и VLM-аннотации)?`,
        `Delete dataset '${dataset}' entirely (all scenes, vectors, and VLM annotations)?`
      ),
      confirmLabel: tr("Удалить датасет", "Delete dataset"),
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
          setStorageStatusMessage(
            tr(
              `Датасет '${dataset}' обработан: выбрано ${formatNum(selected)}, удалено ${formatNum(deletedTotal)}, осталось ${formatNum(remaining)}, ошибок ${formatNum(failedTotal)}.`,
              `Dataset '${dataset}' processed: selected ${formatNum(selected)}, deleted ${formatNum(deletedTotal)}, remaining ${formatNum(remaining)}, failed ${formatNum(failedTotal)}.`
            )
          );
          if (hasObjectsFilter) {
            await Promise.all([loadStats(false, true, true), reloadCurrentObjectsView()]);
          } else {
            await Promise.all([loadStats(false, true, true), loadObjectsPage("", [], 1)]);
          }
          if (failedTotal > 0 || remaining > 0) {
            setStorageWarningMessage(
              tr(
                `При удалении датасета '${dataset}' остались проблемы: осталось ${formatNum(remaining)}, ошибок ${formatNum(failedTotal)}.`,
                `Dataset '${dataset}' delete completed with issues: remaining ${formatNum(remaining)}, failed ${formatNum(failedTotal)}.`
              )
            );
          }
        }, "storage");
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
      hint: tr("Подготовка snapshot...", "Preparing snapshot..."),
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
      setSnapshotExportInlineMessage(
        tr(`Файл '${filename}' выгружен.`, `File '${filename}' was downloaded.`)
      );
    }, "snapshot");

    stopSnapshotExportProgressPoll();
    setSnapshotAbortController(actionId, null);
    clearSnapshotProgress(actionId);
  };

  const startSnapshotImport = async (mode: SnapshotImportMode) => {
    if (!transferFile) {
      setSnapshotWarningMessage(
        tr("Выберите файл снапшота перед импортом.", "Choose a snapshot file before import.")
      );
      return;
    }
    const snapshotFile = transferFile;
    const modeQuery = mode === "append" ? "append" : "replace";
    const uploadMessage =
      mode === "append"
        ? tr("Загрузка снапшота (append) продолжается...", "Uploading snapshot (append)...")
        : tr("Загрузка снапшота продолжается...", "Uploading snapshot...");
    const processingMessage =
      mode === "append"
        ? tr(
            "Разархивация и append-импорт снапшота продолжаются...",
            "Extracting and append-importing snapshot..."
          )
        : tr("Разархивация и импорт снапшота продолжаются...", "Extracting and importing snapshot...");
    const actionId: SnapshotActionId = "import-snapshot";
    const importId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    setSnapshotImportInlineMessage(uploadMessage);
    const controller = new AbortController();
    setSnapshotAbortController(actionId, controller);
    updateSnapshotProgressMeta(actionId, {
      phase: "uploading",
      status: "running",
      hint: tr("Загрузка snapshot...", "Uploading snapshot..."),
    });
    updateSnapshotTransferSize(actionId, 0, Number(snapshotFile.size || 0));
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
        `/api/storage/transfer/import?import_id=${encodeURIComponent(importId)}&mode=${encodeURIComponent(modeQuery)}`,
        snapshotFile,
        {
          adapter: "xhr",
          headers: {
            "Content-Type": snapshotFile.type || "application/octet-stream",
          },
          signal: controller.signal,
          onUploadProgress: (event) => {
            const total = Number(event.total || 0);
            const loaded = Number(event.loaded || 0);
            updateSnapshotTransferSize(
              actionId,
              loaded,
              total > 0 ? total : Number(snapshotFile.size || 0)
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
                hint: tr("Распаковка и применение snapshot...", "Extracting and applying snapshot..."),
              });
              setSnapshotImportInlineMessage(processingMessage);
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
      setSnapshotImportInlineMessage(
        buildImportSummary(responsePayload.result, {
          language,
          formatNumberFn: formatNum,
        })
      );
      const importWarnings = buildImportWarnings(responsePayload.result, language);
      if (importWarnings.length > 0) {
        setSnapshotWarningMessage(importWarnings.join(" "));
      }
      setTransferFile(null);
      setTransferFileInputKey((value) => value + 1);
      if (hasObjectsFilter) {
        await Promise.all([loadStats(false, true, true), reloadCurrentObjectsView()]);
      } else {
        await Promise.all([loadStats(false, true, true), loadObjectsPage("", [], 1)]);
      }
    }, "snapshot");

    stopSnapshotImportProgressPoll();
    setSnapshotAbortController(actionId, null);
    clearSnapshotProgress(actionId);
  };

  const askImportSnapshot = async () => {
    if (!transferFile) {
      setSnapshotWarningMessage(
        tr("Выберите файл снапшота перед импортом.", "Choose a snapshot file before import.")
      );
      return;
    }
    openConfirmDialog({
      title: tr("Импорт snapshot", "Import snapshot"),
      description: tr(
        "Импорт с перезаписью заменяет VLM-схему/аннотации данными из файла (для VLM snapshot) и может перезаписать embeddings/добавить объекты для других форматов. Продолжить?",
        "Replace import overwrites VLM schema/annotations from file (for VLM snapshot) and may overwrite embeddings/add objects for other formats. Continue?"
      ),
      confirmLabel: tr("Импортировать с перезаписью", "Import with replace"),
      onConfirm: async () => startSnapshotImport("replace"),
      extraActions: [
        {
          label: tr("Добавить", "Append"),
          onAction: async () => startSnapshotImport("append"),
        },
      ],
    });
  };

  const refreshAll = async () => {
    setCleanupStatusMessage(null);
    setCleanupWarningMessage(null);
    setStorageStatusMessage(null);
    setStorageWarningMessage(null);
    setErrorMessage(null);
    setIsRefreshing(true);
    try {
      await Promise.all([
        loadStats(false, true, true),
        reloadCurrentObjectsView(),
      ]);
    } finally {
      setIsRefreshing(false);
    }
  };

  const avgImageBytes =
    stats.source.distinct_storage_paths > 0
      ? stats.storage.total_bytes / stats.source.distinct_storage_paths
      : 0;
  const embeddingsRemainingBytes = Math.round(
    avgImageBytes * stats.embeddings.pending_rows
  );
  const vlmRemainingBytes = Math.round(avgImageBytes * stats.vlm.pending_rows);
  const sourceTableMissing = stats.source_table_exists === false;
  const vlmFieldCoverageRows = Array.isArray(stats.vlm.field_coverage)
    ? stats.vlm.field_coverage
    : [];

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
      valueText: tr(`${formatNum(item.rows)} строк`, `${formatNum(item.rows)} rows`),
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
            ? tr("Свободно", "Free")
            : segment.label === "other_used"
              ? tr("Прочее занято", "Other used")
              : segment.label,
        percent: segment.percent_total_disk,
        color,
        valueText: formatBytes(segment.bytes),
      };
    }
  );

  const objectsToRender = hasObjectsFilter ? filteredObjects ?? [] : objects;
  const shouldVirtualizeObjectRows = objectsToRender.length > 40;
  const virtualRowsPerViewport = Math.max(
    1,
    Math.ceil(objectBrowserViewportHeight / OBJECT_BROWSER_ROW_HEIGHT_PX)
  );
  const virtualStartIndex = shouldVirtualizeObjectRows
    ? Math.max(
        0,
        Math.floor(objectBrowserScrollTop / OBJECT_BROWSER_ROW_HEIGHT_PX) -
          OBJECT_BROWSER_VIRTUAL_OVERSCAN_ROWS
      )
    : 0;
  const virtualEndIndex = shouldVirtualizeObjectRows
    ? Math.min(
        objectsToRender.length,
        virtualStartIndex +
          virtualRowsPerViewport +
          OBJECT_BROWSER_VIRTUAL_OVERSCAN_ROWS * 2
      )
    : objectsToRender.length;
  const virtualTopSpacerHeight = shouldVirtualizeObjectRows
    ? virtualStartIndex * OBJECT_BROWSER_ROW_HEIGHT_PX
    : 0;
  const virtualBottomSpacerHeight = shouldVirtualizeObjectRows
    ? Math.max(0, (objectsToRender.length - virtualEndIndex) * OBJECT_BROWSER_ROW_HEIGHT_PX)
    : 0;
  const visibleObjectRows = shouldVirtualizeObjectRows
    ? objectsToRender.slice(virtualStartIndex, virtualEndIndex)
    : objectsToRender;
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
        displayActiveLabel = tr("Загрузка...", "Uploading...");
      } else if (phase === "processing") {
        displayActiveLabel = tr("Распаковка...", "Extracting...");
      } else if (phase === "done") {
        displayActiveLabel = tr("Импорт...", "Importing...");
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
        title={isActive ? tr("Нажмите для отмены", "Click to cancel") : undefined}
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
      <h3 className="text-lg font-semibold text-slate-900">
        {tr("Выгрузка снапшота", "Transfer Snapshot")}
      </h3>
      <p className="mt-1 text-sm text-slate-600">
        {tr(
          "Экспорт/импорт полного storage и отдельной разметки (VLM/Embedder) через файл.",
          "Export/import full storage and separate annotation snapshots (VLM/Embedder) as files."
        )}
      </p>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <div className="text-sm font-medium text-slate-800">{tr("Выгрузка", "Export")}</div>
          <p className="mt-1 text-xs text-slate-500">
            {tr(
              "Файл можно перенести на другую VM и загрузить обратно после разметки.",
              "You can move this file to another VM and import it after annotation."
            )}
          </p>
          {snapshotExportInlineMessage && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
              {snapshotExportInlineMessage}
            </div>
          )}
          <div className="mt-3 flex flex-col items-start gap-2">
            {renderSnapshotProgressButton({
              actionId: "download-full",
              idleLabel: tr("Выгрузить хранилище полностью", "Download full storage"),
              activeLabel: tr("Архивация снапшота всего хранилища...", "Archiving full snapshot..."),
              onClick: () => downloadSnapshot("full"),
              disabled:
                actionInProgress !== null && actionInProgress !== "download-full",
              tone: "sky",
              fixedWidthClass: "w-full max-w-[30rem]",
              onCancel: askCancelSnapshotAction,
            })}
            {renderSnapshotProgressButton({
              actionId: "download-embeddings",
              idleLabel: tr("Скачать эмбеддинги", "Download Embeddings"),
              activeLabel: tr("Архивация embeddings...", "Archiving embeddings..."),
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
              idleLabel: tr("Скачать VLM разметку", "Download VLM Annotations"),
              activeLabel: tr("Архивация VLM разметки...", "Archiving VLM Annotations..."),
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
          <div className="text-sm font-medium text-slate-800">{tr("Загрузка файла", "File upload")}</div>
          <p className="mt-1 text-xs text-slate-500">
            {tr(
              "Поддерживаются снапшоты: полное хранилище; только эмбеддинги; только аннотации VLM.",
              "Supported snapshot types: full storage; embeddings-only; VLM-only."
            )}
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
              {tr("Выбрать файл", "Choose file")}
            </label>
            <div className="w-full max-w-[30rem] break-all px-1 text-xs text-slate-500">
              {transferFile
                ? tr(
                    `Выбрано: ${transferFile.name} (${formatBytes(transferFile.size)})`,
                    `Selected: ${transferFile.name} (${formatBytes(transferFile.size)})`
                  )
                : tr("Файл не выбран", "No file selected")}
            </div>
            {snapshotImportInlineMessage && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
                {snapshotImportInlineMessage}
              </div>
            )}
            {snapshotWarningMessage && (
              <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">
                {snapshotWarningMessage}
              </div>
            )}
            {renderSnapshotProgressButton({
              actionId: "import-snapshot",
              idleLabel: tr("Загрузить", "Upload"),
              activeLabel: tr("Импорт...", "Import..."),
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
              <h2 className="text-2xl font-semibold text-slate-900">
                {tr("Хранилище", "Storage")}
              </h2>
              <p className="mt-2 text-sm text-slate-600">
                {tr(
                  "Сводка по разметке, очистке и объёму данных.",
                  "Summary of annotations, cleanup operations, and data volume."
                )}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {tr("Последнее обновление", "Last update")}: {stats.timestamp}
              </p>
              {isLoading && !hasLoadedStats && (
                <p className="mt-1 text-xs text-slate-500">
                  Загружаем статистику... секции будут появляться по мере готовности.
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={refreshAll}
              disabled={isRefreshing}
              className="ml-auto rounded-full bg-sky-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isRefreshing ? tr("Обновляем...", "Refreshing...") : tr("Обновить", "Refresh")}
            </button>
          </div>

          {sourceTableMissing && (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
              {stats.warning ??
                tr(
                  "Данные еще не скачаны: исходная таблица с кадрами отсутствует. Пока отображается пустая статистика.",
                  "Data is not downloaded yet: the source frames table is missing, so stats are currently empty."
                )}
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
              <h3 className="text-lg font-semibold text-slate-900">
                {tr("Браузер объектов", "Object Browser")}
              </h3>
              <p className="mt-1 text-sm text-slate-600">
                {tr(
                  "Листинг объектов с постраничным просмотром, превью и удалением конкретного объекта.",
                  "Object listing with pagination, preview, and per-object deletion."
                )}
              </p>
              {hasObjectsFilter && (
                <p className="mt-1 text-xs text-slate-500">
                  {tr(
                    "Поиск выполняется с поэтапным сканированием и постраничной выдачей.",
                    "Search uses incremental scanning with paginated results."
                  )}
                </p>
              )}
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-2 text-sm text-slate-700">
              <input
                type="text"
                value={objectsSearchQuery}
                onChange={(event) => setObjectsSearchQuery(event.target.value)}
                placeholder={tr("Поиск: object_id / key / path...", "Search: object_id / key / path...")}
                className="w-72 rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900"
              />
              <select
                value={objectsDatasetFilter}
                onChange={(event) => setObjectsDatasetFilter(event.target.value)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900"
              >
                <option value="">{tr("Все датасеты", "All datasets")}</option>
                {(stats.storage.all_bucket_stats || stats.storage.bucket_stats).map((bucket) => (
                  <option key={bucket.bucket} value={bucket.bucket}>
                    {bucket.bucket}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2 text-sm text-slate-700">
              <span>{tr("На странице:", "Per page:")}</span>
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

          <div ref={objectBrowserViewportRef} className="mt-5 max-h-[65vh] overflow-auto">
            <table className="min-w-full w-full table-fixed divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="w-[16rem] px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                    {tr("Object ID", "Object ID")}
                  </th>
                  <th className="w-[45%] px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                    {tr("Bucket / Key", "Bucket / Key")}
                  </th>
                  <th className="w-[8rem] px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                    {tr("Размер", "Size")}
                  </th>
                  <th className="w-[13rem] px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                    {tr("Создан", "Created")}
                  </th>
                  <th className="w-[16rem] px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                    {tr("Действия", "Actions")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 bg-white">
                {objectsToRender.length === 0 && !objectsLoading && !filteredObjectsLoading && (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-sm text-slate-500">
                      {hasObjectsFilter
                        ? tr("По заданному фильтру объектов нет.", "No objects for the selected filter.")
                        : tr("Объекты не найдены.", "Objects were not found.")}
                    </td>
                  </tr>
                )}
                {filteredObjectsLoading && (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-sm text-slate-500">
                      {tr("Поиск по объектам...", "Searching objects...")}
                    </td>
                  </tr>
                )}
                {virtualTopSpacerHeight > 0 && (
                  <tr aria-hidden="true">
                    <td colSpan={5} className="p-0" style={{ height: `${virtualTopSpacerHeight}px` }} />
                  </tr>
                )}
                {visibleObjectRows.map((item) => (
                  <tr key={item.object_id} className="h-16">
                    <td className="px-4 py-2 text-xs text-slate-800 align-middle">
                      <div className="truncate" title={item.object_id}>
                        {item.object_id}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-sm text-slate-700 align-middle">
                      <div className="truncate font-medium" title={item.bucket}>
                        {item.bucket}
                      </div>
                      <div className="truncate text-xs text-slate-500" title={item.key}>
                        {item.key}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-sm text-slate-700 align-middle">{formatBytes(item.size_bytes)}</td>
                    <td className="px-4 py-2 text-sm text-slate-700 align-middle">
                      {item.created_at ? new Date(item.created_at).toLocaleString(numberLocale) : "-"}
                    </td>
                    <td className="px-4 py-2 align-middle">
                      <div className="flex items-center gap-2 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => setPreviewObjectId(item.object_id)}
                          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
                        >
                          {tr("Превью", "Preview")}
                        </button>
                        <a
                          href={`/api/objects/${encodeURIComponent(item.object_id)}`}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
                        >
                          {tr("Открыть", "Open")}
                        </a>
                        <button
                          type="button"
                          onClick={() => deleteObject(item.object_id)}
                          disabled={actionInProgress !== null}
                          className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {actionInProgress === `delete-object-${item.object_id}`
                            ? tr("Удаляем...", "Deleting...")
                            : tr("Удалить", "Delete")}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {virtualBottomSpacerHeight > 0 && (
                  <tr aria-hidden="true">
                    <td colSpan={5} className="p-0" style={{ height: `${virtualBottomSpacerHeight}px` }} />
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex items-center justify-between">
            <div className="text-sm text-slate-600">
              {hasObjectsFilter
                ? tr(
                    `Фильтр: страница ${filteredObjectsPage} ${filteredObjectsLoading ? "• загрузка..." : ""}`,
                    `Filtered: page ${filteredObjectsPage} ${filteredObjectsLoading ? "• loading..." : ""}`
                  )
                : tr(
                    `Страница ${objectsPage} ${objectsLoading ? "• загрузка..." : ""}`,
                    `Page ${objectsPage} ${objectsLoading ? "• loading..." : ""}`
                  )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  if (hasObjectsFilter) {
                    goToPrevFilteredObjectsPage();
                    return;
                  }
                  goToPrevObjectsPage();
                }}
                disabled={
                  hasObjectsFilter
                    ? filteredObjectsLoading || filteredObjectsPrevCursors.length === 0
                    : objectsPrevCursors.length === 0 || objectsLoading
                }
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {tr("← Назад", "← Previous")}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (hasObjectsFilter) {
                    goToNextFilteredObjectsPage();
                    return;
                  }
                  goToNextObjectsPage();
                }}
                disabled={
                  hasObjectsFilter
                    ? filteredObjectsLoading || !filteredObjectsNextCursor
                    : !objectsNextCursor || objectsLoading
                }
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {tr("Вперёд →", "Next →")}
              </button>
            </div>
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <h3 className="text-lg font-semibold text-slate-900">
              {tr("Покрытие датасетов", "Dataset Coverage")}
            </h3>
            <div className="mt-4 space-y-2 text-sm text-slate-700">
              <div>{tr("Строк в источнике", "Rows in source")}: {formatNum(stats.source.total_rows)}</div>
              <div>{tr("Строк с `storage_path`", "Rows with `storage_path`")}: {formatNum(stats.source.rows_with_storage_path)}</div>
              <div>{tr("Уникальных сцен", "Unique scenes")}: {formatNum(stats.source.distinct_storage_paths)}</div>
              <div>{tr("Дубликатов", "Duplicates")}: {formatNum(stats.source.duplicate_storage_rows)}</div>
            </div>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <h3 className="text-lg font-semibold text-slate-900">
              {tr("Векторная разметка", "Vector Annotation")}
            </h3>
            <div className="mt-4 text-sm text-slate-700">
              <div className="mb-2 flex justify-between">
                <span>{tr("Размечено", "Annotated")}</span>
                <span className="font-semibold">{pctText(stats.embeddings.annotated_percent)}</span>
              </div>
              <div className="h-2 w-full rounded-full bg-slate-200">
                <div
                  className="h-2 rounded-full bg-emerald-500"
                  style={{ width: `${Math.min(stats.embeddings.annotated_percent, 100)}%` }}
                />
              </div>
              <div className="mt-3">{tr("Осталось", "Remaining")}: {formatNum(stats.embeddings.pending_rows)}</div>
              <div>{tr("Размечено", "Annotated")}: {formatNum(stats.embeddings.annotated_rows)}</div>
              <div>{tr("Не размечено", "Not annotated")}: {pctText(stats.embeddings.pending_percent)}</div>
              <div>
                {tr("Размерность", "Dimension")}: query{" "}
                {stats.embeddings.dimensions?.query_dim ?? "?"} / stored{" "}
                {stats.embeddings.dimensions?.stored_dim ?? "?"}
              </div>
              {stats.embeddings.dimensions?.mismatch ? (
                <div className="text-xs text-amber-700">
                  {tr(
                    "Внимание: mismatch размерности эмбеддингов.",
                    "Warning: embedding dimensions mismatch."
                  )}
                </div>
              ) : null}
              <div className="mt-2 text-xs text-slate-500">
                {tr("Оценка оставшегося объёма", "Estimated remaining size")}: {formatBytes(embeddingsRemainingBytes)}
              </div>
            </div>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <h3 className="text-lg font-semibold text-slate-900">
              {tr("VLM Разметка", "VLM Annotation")}
            </h3>
            <div className="mt-4 text-sm text-slate-700">
              <div className="mb-2 flex justify-between">
                <span>{tr("Размечено", "Annotated")}</span>
                <span className="font-semibold">{pctText(stats.vlm.annotated_percent)}</span>
              </div>
              <div className="h-2 w-full rounded-full bg-slate-200">
                <div
                  className="h-2 rounded-full bg-indigo-500"
                  style={{ width: `${Math.min(stats.vlm.annotated_percent, 100)}%` }}
                />
              </div>
              <div className="mt-3">{tr("Осталось", "Remaining")}: {formatNum(stats.vlm.pending_rows)}</div>
              <div>{tr("Размечено", "Annotated")}: {formatNum(stats.vlm.annotated_rows)}</div>
              <div>
                {tr("Есть любая VLM разметка", "Any VLM annotation")}:{" "}
                {formatNum(Number(stats.vlm.partial_annotated_rows || 0))} (
                {pctText(Number(stats.vlm.partial_annotated_percent || 0))})
              </div>
              <div>
                {tr("Частично размечено", "Partially annotated")}:{" "}
                {formatNum(Number(stats.vlm.partial_only_rows || 0))} (
                {pctText(Number(stats.vlm.partial_only_percent || 0))})
              </div>
              <div>{tr("Не размечено", "Not annotated")}: {pctText(stats.vlm.pending_percent)}</div>
              <div>{tr("Поля VLM", "VLM fields")}: {formatNum(stats.vlm.configured_fields)}</div>
              <div className="mt-2 text-xs text-slate-500">
                {tr("Оценка оставшегося объёма", "Estimated remaining size")}: {formatBytes(vlmRemainingBytes)}
              </div>
            </div>
          </div>
        </div>

        {showVlmFieldBreakdown && (
          <VlmFieldCoverageChart
            rows={vlmFieldCoverageRows}
            summary={stats.vlm.field_coverage_summary || null}
            tr={tr}
          />
        )}

        <div className="grid gap-6 xl:grid-cols-2">
          <PieChart
            title={tr("Доля датасетов по строкам", "Dataset Share by Rows")}
            subtitle={tr("Доля датасетов от общего числа строк", "Dataset share of all source rows")}
            slices={rowsPieSlices}
            hoverHintLabel={tr("Наведите курсор", "Hover")}
            hoverHintValue={tr("Доля датасета", "Dataset share")}
          />
          <PieChart
            title={tr("Доля по памяти + свободное", "Dataset Share by Memory + Free")}
            subtitle={tr(
              "Доля датасетов от всего диска, включая свободное место",
              "Dataset share of total disk including free space"
            )}
            slices={memoryPieSlices}
            hoverHintLabel={tr("Наведите курсор", "Hover")}
            hoverHintValue={tr("Доля датасета", "Dataset share")}
          />
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <h3 className="text-lg font-semibold text-slate-900">
            {tr("Очистка и переразметка", "Cleanup & Re-Annotation")}
          </h3>
          <p className="mt-1 text-sm text-slate-600">
            {tr(
              "Частичный сброс разметки, очистка дублей и полное удаление случайных сцен.",
              "Partial annotation reset, duplicate cleanup, and full random scene deletion."
            )}
          </p>
          {cleanupStatusMessage && (
            <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800">
              {cleanupStatusMessage}
            </div>
          )}
          {cleanupWarningMessage && (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
              {cleanupWarningMessage}
            </div>
          )}
          <div className="mt-3">
            <label className="text-sm font-medium text-slate-700">
              {tr("Область датасетов", "Dataset scope")}
            </label>
            <div className="mt-2">
              <select
                value={cleanupDatasetFilter}
                onChange={(event) => setCleanupDatasetFilter(event.target.value)}
                className="w-56 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
              >
                <option value="all">{tr("Все датасеты", "All datasets")}</option>
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
                {tr("Случайные N для сброса векторов", "Random N for vector reset")}
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
                    ? tr("Удаление...", "Deleting...")
                    : tr("Удалить случайные embeddings", "Delete random embeddings")}
                </button>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <label className="text-sm font-medium text-slate-700">
                {tr("Случайные N для сброса VLM", "Random N for VLM reset")}
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
                    ? tr("Удаление...", "Deleting...")
                    : tr("Удалить случайные VLM", "Delete random VLM")}
                </button>
              </div>
            </div>

            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
              <label className="text-sm font-medium text-amber-800">
                {tr("Очистка дублей строк", "Duplicate rows cleanup")}
              </label>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-sm text-amber-800">
                  {tr(
                    "Удалить строки-дубли с одинаковым `storage_path`",
                    "Drop duplicate rows by identical `storage_path`"
                  )}
                </span>
                <button
                  type="button"
                  onClick={deleteDuplicates}
                  disabled={actionInProgress !== null}
                  className="rounded-full bg-amber-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {actionInProgress === "delete-duplicates"
                    ? tr("Удаление...", "Deleting...")
                    : tr("Удалить дубли", "Drop duplicates")}
                </button>
              </div>
            </div>

            <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4">
              <label className="text-sm font-medium text-rose-700">
                {tr("Случайные N для полного удаления", "Random N images hard delete")}
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
                    ? tr("Удаление...", "Deleting...")
                    : tr("Удалить сцены + метаданные", "Delete images + metadata")}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <h3 className="text-lg font-semibold text-slate-900">
            {tr("Хранилище изображений", "Image Storage")}
          </h3>
          {storageStatusMessage && (
            <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800">
              {storageStatusMessage}
            </div>
          )}
          {storageWarningMessage && (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
              {storageWarningMessage}
            </div>
          )}
          <div className="mt-4 grid gap-4 md:grid-cols-4">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
              {tr("Объектов", "Objects")}: <span className="font-semibold">{formatNum(stats.storage.total_objects)}</span>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
              {tr("Данные изображений", "Image data")}: <span className="font-semibold">{formatBytes(stats.storage.total_bytes)}</span>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
              {tr("Диск свободно", "Disk free")}: <span className="font-semibold">{formatBytes(stats.disk.free_bytes)}</span>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
              {tr("Диск занято", "Disk used")}: <span className="font-semibold">{pctText(stats.disk.used_percent)}</span>
            </div>
          </div>

          <div className="mt-5 overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                    {tr("Бакет", "Bucket")}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                    {tr("Объекты", "Objects")}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                    {tr("Размер", "Size")}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                    {tr("Статус", "Status")}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                    {tr("Действия", "Actions")}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                    <div className="flex items-center gap-2">
                      <span>{tr("Видимость", "Visibility")}</span>
                      <button
                        type="button"
                        onClick={() => {
                          if (allDatasetBuckets.length === 0) return;
                          const nextVisible = !allDatasetsVisible;
                          openConfirmDialog({
                            title: nextVisible
                              ? tr("Показать все датасеты", "Show all datasets")
                              : tr("Скрыть все датасеты", "Hide all datasets"),
                            description: nextVisible
                              ? tr(
                                  "Показать все датасеты во вкладках Browser, VLM, Annotation, Cleanup/Deletion и в аналитике Storage?",
                                  "Show all datasets across Browser, VLM, Annotation, Cleanup/Deletion, and Storage analytics?"
                                )
                              : tr(
                                  "Скрыть все датасеты из вкладок Browser, VLM, Annotation, Cleanup/Deletion и из аналитики Storage?",
                                  "Hide all datasets from Browser, VLM, Annotation, Cleanup/Deletion, and Storage analytics?"
                                ),
                            confirmLabel: nextVisible
                              ? tr("Показать все", "Show all")
                              : tr("Скрыть все", "Hide all"),
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
                                  loadStats(false, true, true),
                                  reloadCurrentObjectsView(),
                                ]);
                              }, "storage");
                            },
                          });
                        }}
                        disabled={isTogglingAllVisibility || actionInProgress !== null}
                        className="rounded-md border border-slate-300 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {allDatasetsVisible
                          ? tr("Скрыть все", "Hide all")
                          : tr("Показать все", "Show all")}
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
                      <td className="px-4 py-3 text-sm text-slate-700">{formatNum(bucket.objects)}</td>
                      <td className="px-4 py-3 text-sm text-slate-700">{formatBytes(bucket.bytes)}</td>
                      <td className="px-4 py-3 text-sm">
                        {bucket.error ? (
                          <span className="font-semibold text-amber-700">
                            {tr("Предупреждение", "Warning")}: {bucket.error}
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
                                  {tr("Удаление", "Deleting")}
                                </span>
                              </span>
                              <span className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center whitespace-nowrap text-rose-700">
                                {tr("Удаление", "Deleting")}
                              </span>
                              <span
                                className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center whitespace-nowrap text-white transition-[clip-path] duration-300 ease-out"
                                style={{ clipPath: `inset(0 ${100 - progress}% 0 0)` }}
                              >
                                {tr("Удаление", "Deleting")}
                              </span>
                            </>
                          ) : (
                            <span className="relative z-10">
                              {tr("Удалить датасет", "Delete dataset")}
                            </span>
                          )}
                        </button>
                      </td>
                      <td className="px-4 py-3 text-sm">
                        <button
                          type="button"
                          title={isVisible ? tr("Датасет видим", "Dataset is visible") : tr("Датасет скрыт", "Dataset is hidden")}
                          onClick={() => {
                            openConfirmDialog({
                              title: isVisible
                                ? tr("Скрыть датасет", "Hide dataset")
                                : tr("Показать датасет", "Show dataset"),
                              description: isVisible
                                ? tr(
                                    `Скрыть датасет '${bucket.bucket}' из Browser, VLM, Annotation, Cleanup/Deletion и аналитики Storage?`,
                                    `Hide dataset '${bucket.bucket}' from Browser, VLM, Annotation, Cleanup/Deletion, and Storage analytics?`
                                  )
                                : tr(
                                    `Снова показать датасет '${bucket.bucket}' в Browser, VLM, Annotation, Cleanup/Deletion и аналитике Storage?`,
                                    `Show dataset '${bucket.bucket}' again across Browser, VLM, Annotation, Cleanup/Deletion, and Storage analytics?`
                                  ),
                              confirmLabel: isVisible
                                ? tr("Скрыть датасет", "Hide dataset")
                                : tr("Показать датасет", "Show dataset"),
                              onConfirm: async () => {
                                await runStorageAction(visibilityActionId, async () => {
                                  await axios.post("/api/storage/dataset-visibility", {
                                    dataset: bucket.bucket,
                                    visible: !isVisible,
                                  });
                                  await Promise.all([
                                    loadStats(false, true, true),
                                    reloadCurrentObjectsView(),
                                  ]);
                                }, "storage");
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
                className="inline-flex h-10 items-center justify-center rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {tr("Отмена", "Cancel")}
              </button>
              {(confirmDialog.extraActions || []).map((action) => (
                <button
                  key={action.label}
                  type="button"
                  onClick={() => executeConfirmDialog(action.onAction)}
                  disabled={confirmDialogBusy}
                  className="inline-flex h-10 items-center justify-center rounded-lg border border-emerald-300 bg-emerald-50 px-4 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {action.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => executeConfirmDialog()}
                disabled={confirmDialogBusy}
                className="inline-flex h-10 items-center justify-center rounded-lg bg-rose-600 px-4 text-sm font-semibold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-60"
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
                  {tr("Превью объекта", "Object Preview")}
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
                {tr("Закрыть", "Close")}
              </button>
            </div>
            <Image
              src={`/api/objects/${encodeURIComponent(previewObjectId)}`}
              alt={previewObjectId}
              unoptimized
              width={1920}
              height={1080}
              className="max-h-[75vh] w-full rounded-xl border border-slate-200 bg-slate-100 object-contain"
            />
          </div>
        </div>
      )}
    </section>
  );
}
