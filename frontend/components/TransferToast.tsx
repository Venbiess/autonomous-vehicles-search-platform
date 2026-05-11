"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";

type SnapshotTransferJob = {
  job_id?: string;
  job_type?: string;
  status?: string;
  phase?: string;
  progress?: number;
  total_seen?: number;
  total_planned?: number;
  total_limit?: number;
  created_at?: number;
};

function isSnapshotTransferJob(job: SnapshotTransferJob): boolean {
  const type = String(job.job_type || "").trim();
  return (
    type === "snapshot_import" ||
    type === "snapshot_transfer" ||
    type === "snapshot_export" ||
    type.startsWith("snapshot_export_")
  );
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

function getJobTitle(job: SnapshotTransferJob): string {
  const type = String(job.job_type || "").trim();
  if (type === "snapshot_import") return "Импорт snapshot";
  if (type === "snapshot_transfer" || type === "snapshot_export") return "Выгрузка snapshot";
  if (type === "snapshot_export_full") return "Выгрузка full snapshot";
  if (type === "snapshot_export_embeddings") return "Выгрузка embeddings";
  if (type === "snapshot_export_vlm") return "Выгрузка VLM";
  return "Transfer snapshot";
}

function getJobPhaseHint(job: SnapshotTransferJob): string {
  const type = String(job.job_type || "").trim();
  const phase = String(job.phase || "").trim().toLowerCase();
  const isExport =
    type === "snapshot_transfer" ||
    type === "snapshot_export" ||
    type.startsWith("snapshot_export_");
  if (type === "snapshot_import") {
    if (phase === "uploading") return "Загрузка snapshot...";
    if (phase === "processing") return "Разархивация snapshot...";
  }
  if (isExport) {
    if (phase === "preparing") return "Подготовка snapshot...";
    if (phase === "archiving") return "Архивация snapshot...";
    if (phase === "streaming") return "Скачивание snapshot...";
  }
  return "";
}

function normalizeProgress(job: SnapshotTransferJob): number {
  const totalSeen = Math.max(0, Number(job.total_seen || 0));
  const totalPlannedRaw = Number(job.total_planned || job.total_limit || 0);
  const totalPlanned =
    Number.isFinite(totalPlannedRaw) && totalPlannedRaw > 0 ? totalPlannedRaw : 0;
  if (totalPlanned > 0 && totalSeen > 0 && totalSeen < totalPlanned) {
    return Math.max(0, Math.min(100, Math.round((totalSeen / totalPlanned) * 100)));
  }
  return Math.max(0, Math.min(100, Math.round(Number(job.progress || 0))));
}

export default function TransferToast({
  onOpenTransfer,
  isStorageMode = false,
}: {
  onOpenTransfer?: () => void;
  isStorageMode?: boolean;
}) {
  const [jobs, setJobs] = useState<SnapshotTransferJob[]>([]);
  const pollTokenRef = useRef(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const token = pollTokenRef.current;
    const getPollDelay = (): number => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return 4000;
      }
      return isStorageMode ? 700 : 1500;
    };
    const poll = async () => {
      try {
        const response = await axios.get("/api/jobs");
        const list = Array.isArray(response.data?.jobs)
          ? (response.data.jobs as SnapshotTransferJob[])
          : [];
        const running = list
          .filter((job) => isSnapshotTransferJob(job) && String(job.status || "").toLowerCase() === "running")
          .sort((left, right) => Number(right.created_at || 0) - Number(left.created_at || 0));
        setJobs(running);
      } catch {
      } finally {
        if (token === pollTokenRef.current) {
          pollTimerRef.current = setTimeout(poll, getPollDelay());
        }
      }
    };

    poll();
    return () => {
      pollTokenRef.current += 1;
      const timer = pollTimerRef.current;
      if (timer) {
        clearTimeout(timer);
        pollTimerRef.current = null;
      }
    };
  }, [isStorageMode]);

  const primaryJob = jobs[0];
  const hasJobs = Boolean(primaryJob);
  const remainingCount = Math.max(0, jobs.length - 1);

  const progress = useMemo(
    () => (primaryJob ? normalizeProgress(primaryJob) : 0),
    [primaryJob]
  );

  if (!hasJobs || !primaryJob) {
    return null;
  }

  const totalSeen = Math.max(0, Number(primaryJob.total_seen || 0));
  const totalPlannedRaw = Number(primaryJob.total_planned || primaryJob.total_limit || 0);
  const totalPlanned =
    Number.isFinite(totalPlannedRaw) && totalPlannedRaw > 0 ? totalPlannedRaw : null;
  const strokeWidth = 7;
  const radius = 20;
  const size = 54;
  const center = size / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - progress / 100);
  const phase = String(primaryJob.phase || "").trim().toLowerCase();
  const phaseHint = getJobPhaseHint(primaryJob);
  const isImportExtractPhase =
    String(primaryJob.job_type || "").trim() === "snapshot_import" && phase === "processing";
  const progressStrokeColor = isImportExtractPhase ? "#10b981" : "#0ea5e9";
  const progressTrackColor = isImportExtractPhase ? "#d1fae5" : "#dbeafe";

  return (
    <div className="fixed bottom-4 right-4 z-[80]">
      <button
        type="button"
        onClick={() => {
          if (typeof onOpenTransfer === "function") {
            onOpenTransfer();
          }
        }}
        className="flex min-w-[18rem] items-center gap-3 rounded-2xl border border-slate-200 bg-white/95 px-4 py-3 text-left shadow-xl backdrop-blur transition hover:border-sky-300 hover:bg-white"
        title="Открыть раздел Transfer Snapshot"
      >
        <div className="relative h-[54px] w-[54px] shrink-0">
          <svg
            viewBox={`0 0 ${size} ${size}`}
            className="h-full w-full"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            aria-label={`${getJobTitle(primaryJob)} ${progress}%`}
          >
            <circle
              cx={center}
              cy={center}
              r={radius}
              stroke={progressTrackColor}
              strokeWidth={strokeWidth}
              fill="none"
            />
            <circle
              cx={center}
              cy={center}
              r={radius}
              stroke={progressStrokeColor}
              strokeWidth={strokeWidth}
              fill="none"
              strokeLinecap="round"
              strokeDasharray={`${circumference} ${circumference}`}
              strokeDashoffset={dashOffset}
              transform={`rotate(-90 ${center} ${center})`}
              className="transition-[stroke-dashoffset] duration-300 ease-out"
            />
          </svg>
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] font-semibold text-slate-700">
            {progress}%
          </span>
        </div>

        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-slate-900">
            {getJobTitle(primaryJob)}
          </div>
          <div className="truncate text-xs text-slate-600">
            {totalPlanned && totalPlanned > 0
              ? `${formatBytes(totalSeen)} / ${formatBytes(totalPlanned)}`
              : formatBytes(totalSeen)}
          </div>
          {phaseHint && <div className="truncate text-xs text-slate-500">{phaseHint}</div>}
          {remainingCount > 0 && (
            <div className="text-[11px] text-slate-500">{`+${remainingCount} active`}</div>
          )}
        </div>
      </button>
    </div>
  );
}
