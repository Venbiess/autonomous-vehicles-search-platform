"use client";

import { useState, useEffect, useCallback } from "react";
import axios from "axios";

interface SystemInfo {
  cpu: {
    usage_percent: number;
    cores: number;
  };
  memory: {
    total_gb: number;
    used_gb: number;
    available_gb: number;
    usage_percent: number;
  };
  disk: {
    total_gb: number;
    used_gb: number;
    available_gb: number;
    usage_percent: number;
  };
  gpu?: {
    available?: boolean;
    driver_version?: string;
    cuda_version?: string;
    gpus?: Array<{
      index: number;
      name: string;
      uuid?: string;
      utilization_percent?: number;
      memory_used_mb?: number;
      memory_total_mb?: number;
      memory_free_mb?: number;
      memory_used_percent?: number;
      temperature_c?: number;
    }>;
    error?: string;
  };
  services?: {
    embedder?: {
      name?: string;
      endpoint?: string;
      reachable?: boolean;
      status?: string;
      model?: string;
      device?: string;
      runtime?: {
        configured_device?: string;
        selected_device?: string;
        torch_cuda_available?: boolean;
        torch_mps_available?: boolean;
        cuda_device_count?: number;
        cuda_device_name?: string | null;
        dtype?: string;
      };
      memory?: {
        process_rss_mb?: number;
        gpu_allocated_mb?: number;
        gpu_reserved_mb?: number;
        gpu_total_mb?: number;
        gpu_free_mb?: number;
      };
      counters?: {
        received?: number;
        completed?: number;
        in_progress?: number;
      };
      error?: string;
    };
    vlm?: {
      name?: string;
      endpoint?: string;
      reachable?: boolean;
      status?: string;
      model?: string;
      device?: string;
      runtime?: {
        configured_device?: string;
        selected_device?: string;
        torch_cuda_available?: boolean;
        torch_mps_available?: boolean;
        cuda_device_count?: number;
        cuda_device_name?: string | null;
        dtype?: string;
      };
      memory?: {
        process_rss_mb?: number;
        gpu_allocated_mb?: number;
        gpu_reserved_mb?: number;
        gpu_total_mb?: number;
        gpu_free_mb?: number;
      };
      counters?: {
        received?: number;
        completed?: number;
        in_progress?: number;
      };
      error?: string;
    };
  };
  uptime_seconds: number;
  timestamp: string;
}

interface Job {
  job_id: string;
  job_type: string;
  dataset?: string;
  job_config?: Record<string, unknown>;
  status: "running" | "success" | "error" | "cancelled";
  cancel_requested?: boolean;
  progress: number;
  total_seen: number;
  total_inserted: number;
  total_embeddings_inserted?: number;
  total_limit: number;
  total_planned?: number;
  total_tasks_completed?: number;
  total_tasks_planned?: number;
  current_scene_tasks_completed?: number;
  current_scene_tasks_total?: number;
  current_scene_index?: number;
  extract_scene_tasks_completed?: number;
  extract_scene_tasks_total?: number;
  extract_scene_index?: number;
  extract_file_name?: string;
  extract_files_done?: number;
  download_label?: string;
  install_phase?: string;
  embed_on_install?: boolean;
  embedding_tasks_completed?: number;
  embedding_tasks_total?: number;
  embedding_worker_running?: boolean;
  phase?: string;
  upload_bytes_seen?: number;
  upload_bytes_total?: number;
  upload_progress?: number;
  extract_bytes_seen?: number;
  extract_bytes_total?: number;
  extract_progress?: number;
  job_log?: string[];
  job_log_path?: string;
  errors: Array<{ storage_path?: string; object_id?: string; error: string; log?: string }>;
  created_at: number;
  updated_at: number;
}

interface LogViewerState {
  title: string;
  content: string;
  jobId?: string;
  source?: "job" | "error";
}

interface ConfigViewerState {
  title: string;
  content: string;
}

interface WaymoAuthStartResponse {
  session_id?: string;
  auth_url?: string;
  awaiting_code?: boolean;
  status?: string;
  error?: string;
}

export default function SystemMonitor({
  showRuntimePanels = false,
}: {
  showRuntimePanels?: boolean;
}) {
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancellingJobId, setCancellingJobId] = useState<string | null>(null);
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null);
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  const [logViewer, setLogViewer] = useState<LogViewerState | null>(null);
  const [configViewer, setConfigViewer] = useState<ConfigViewerState | null>(null);
  const [cancelDialogJob, setCancelDialogJob] = useState<Job | null>(null);
  const [waymoAuthModalOpen, setWaymoAuthModalOpen] = useState(false);
  const [waymoAuthSessionId, setWaymoAuthSessionId] = useState<string | null>(null);
  const [waymoAuthUrl, setWaymoAuthUrl] = useState<string | null>(null);
  const [waymoAuthCode, setWaymoAuthCode] = useState("");
  const [waymoAuthBusy, setWaymoAuthBusy] = useState(false);
  const [waymoAuthError, setWaymoAuthError] = useState<string | null>(null);
  const [waymoAuthSuccess, setWaymoAuthSuccess] = useState<string | null>(null);
  const [waymoAuthPromptedJobIds, setWaymoAuthPromptedJobIds] = useState<string[]>([]);

  const fetchSystemInfo = async () => {
    try {
      const response = await axios.get("/api/system-info");
      setSystemInfo(response.data);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Не удалось загрузить информацию о системе";
      setError(message);
    }
  };

  const fetchJobs = async () => {
    try {
      const response = await axios.get("/api/jobs");
      setJobs(response.data.jobs || []);
    } catch (err) {
      console.error("Failed to fetch jobs:", err);
    }
  };

  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      await Promise.all([fetchSystemInfo(), fetchJobs()]);
      setIsLoading(false);
    };
    
    loadData();
    const interval = setInterval(() => {
      fetchSystemInfo();
      fetchJobs();
    }, 5000); // Обновление каждые 5 секунд
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      setNowSeconds(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const formatUptime = (seconds: number): string => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${days}д ${hours}ч ${minutes}м`;
  };

  const getUsageColor = (percent: number): string => {
    if (percent < 50) return "bg-green-500";
    if (percent < 80) return "bg-yellow-500";
    return "bg-red-500";
  };

  const formatMb = (value?: number): string => {
    const safe = Number(value ?? 0);
    if (!Number.isFinite(safe) || safe <= 0) {
      return "0 MB";
    }
    if (safe >= 1024) {
      return `${(safe / 1024).toFixed(2)} GB`;
    }
    return `${safe.toFixed(2)} MB`;
  };

  const serviceStatusBadge = (reachable?: boolean): string => {
    return reachable ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700";
  };

  const getJobStatusColor = (status: string): { bg: string; text: string } => {
    switch (status) {
      case "running":
        return { bg: "bg-blue-500", text: "text-blue-600" };
      case "success":
        return { bg: "bg-green-500", text: "text-green-600" };
      case "error":
        return { bg: "bg-red-500", text: "text-red-600" };
      case "cancelled":
        return { bg: "bg-gray-500", text: "text-gray-600" };
      default:
        return { bg: "bg-gray-500", text: "text-gray-600" };
    }
  };

  const getJobStatusText = (status: string, cancelRequested?: boolean): string => {
    if (status === "running" && cancelRequested) {
      return "Cancelling";
    }
    switch (status) {
      case "running":
        return "Running";
      case "success":
        return "Success";
      case "error":
        return "Error";
      case "cancelled":
        return "Cancelled";
      default:
        return status;
    }
  };

  const getJobErrorLog = useCallback((job: Job): string => {
    if (!Array.isArray(job.errors) || job.errors.length === 0) {
      return "No error details available.";
    }
    return job.errors
      .map((entry, index) => {
        const base = entry.error || "Unknown error";
        const source = entry.storage_path
          ? `storage_path=${entry.storage_path}`
          : entry.object_id
            ? `object_id=${entry.object_id}`
            : "";
        const prefix = `${index + 1}. ${source ? `${source} | ` : ""}${base}`;
        const log = typeof entry.log === "string" ? entry.log.trim() : "";
        return log ? `${prefix}\n${log}` : prefix;
      })
      .join("\n\n");
  }, []);

  const getJobMainLog = useCallback((job: Job): string => {
    const lines = Array.isArray(job.job_log) ? job.job_log : [];
    if (lines.length === 0) {
      return "No job log available.";
    }
    return lines.join("\n");
  }, []);

  const formatDate = (timestamp: number): string => {
    return new Date(timestamp * 1000).toLocaleString("ru-RU");
  };

  const formatJobTypeLabel = useCallback((jobType: string): string => {
    if (jobType === "dataset_delete") return "Dataset Delete";
    if (jobType === "snapshot_import") return "Snapshot Import";
    if (jobType === "snapshot_transfer" || jobType === "snapshot_export") return "Snapshot Export";
    if (jobType === "snapshot_export_full") return "Snapshot Export (Full)";
    if (jobType === "snapshot_export_embeddings") return "Snapshot Export (Embeddings)";
    if (jobType === "snapshot_export_vlm") return "Snapshot Export (VLM)";
    if (jobType === "backfill_embeddings") return "Backfill Embeddings";
    if (jobType === "backfill_vlm") return "Backfill VLM";
    if (jobType === "install_waymo") return "Install Waymo";
    if (jobType === "install_argoverse") return "Install Argoverse";
    if (jobType === "install_nuimages") return "Install NuImages (nuScenes)";
    if (jobType === "install_once") return "Install ONCE";
    if (jobType === "install_drivingdojo") return "Install DrivingDojo";
    if (jobType === "install_nuscenes") return "Install NuScenes";
    if (jobType.startsWith("install_")) {
      const suffix = jobType.slice("install_".length);
      const pretty = suffix
        .split(/[_-]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
      return `Install ${pretty || "Dataset"}`;
    }
    return jobType;
  }, []);

  const formatDataSize = (bytes: number): string => {
    const safe = Math.max(0, Number(bytes) || 0);
    if (safe >= 1024 ** 3) {
      return `${(safe / (1024 ** 3)).toFixed(2)} GB`;
    }
    if (safe >= 1024 ** 2) {
      return `${(safe / (1024 ** 2)).toFixed(2)} MB`;
    }
    if (safe >= 1024) {
      return `${(safe / 1024).toFixed(2)} KB`;
    }
    return `${safe} B`;
  };

  const formatDuration = (seconds: number): string => {
    const safe = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const secs = safe % 60;
    if (hours > 0) {
      return `${hours}ч ${String(minutes).padStart(2, "0")}м ${String(secs).padStart(2, "0")}с`;
    }
    return `${minutes}м ${String(secs).padStart(2, "0")}с`;
  };

  const getJobTiming = (job: Job): { elapsed: string; eta: string } => {
    const start = Math.max(0, job.created_at || 0);
    const end = job.status === "running" ? nowSeconds : Math.max(start, job.updated_at || start);
    const elapsedSec = Math.max(0, end - start);

    const plannedTotalRaw = job.total_planned ?? job.total_limit ?? 0;
    const plannedTotal = Math.max(0, plannedTotalRaw);
    const completed = Math.max(0, Math.min(job.total_seen ?? 0, plannedTotal || Number.MAX_SAFE_INTEGER));
    const remaining = Math.max(0, plannedTotal - completed);
    const speed = elapsedSec > 0 ? completed / elapsedSec : 0;
    const etaSec =
      job.status === "running" && plannedTotal > 0 && speed > 0 && remaining > 0
        ? Math.ceil(remaining / speed)
        : 0;

    return {
      elapsed: formatDuration(elapsedSec),
      eta:
        job.status === "running"
          ? etaSec > 0
            ? formatDuration(etaSec)
            : "—"
          : "—",
    };
  };

  const getSceneTaskGradient = (sceneIndex: number): string => {
    const hue = (sceneIndex * 47) % 360;
    const nextHue = (hue + 52) % 360;
    return `linear-gradient(90deg, hsl(${hue} 75% 52%), hsl(${nextHue} 82% 58%))`;
  };

  const executeCancelJob = async (
    job: Job,
    install_cleanup_mode: "keep" | "delete" = "keep"
  ) => {
    try {
      setCancellingJobId(job.job_id);
      await axios.post("/api/jobs/cancel", {
        job_id: job.job_id,
        install_cleanup_mode,
      });
      setCancelDialogJob(null);
      await fetchJobs();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Не удалось отменить джобу";
      alert(`Ошибка: ${message}`);
    } finally {
      setCancellingJobId(null);
    }
  };

  const executeRetryJob = async (job: Job) => {
    try {
      setRetryingJobId(job.job_id);
      await axios.post("/api/jobs/retry", { job_id: job.job_id });
      await fetchJobs();
    } catch (err) {
      const detail = axios.isAxiosError(err) ? err.response?.data : null;
      const message =
        typeof detail?.detail === "string"
          ? detail.detail
          : typeof detail?.error === "string"
            ? detail.error
            : err instanceof Error
              ? err.message
              : "Не удалось перезапустить джобу";
      alert(`Ошибка: ${message}`);
    } finally {
      setRetryingJobId(null);
    }
  };

  const supportsCleanupChoice = (jobType: string): boolean =>
    jobType.startsWith("install_") ||
    jobType === "backfill_vlm" ||
    jobType === "backfill_embeddings";

  const getCancelDialogDescription = (jobType: string): string => {
    if (jobType.startsWith("install_")) {
      return "Выберите, что сделать с уже загруженными этой джобой данными.";
    }
    if (jobType === "backfill_vlm") {
      return "Выберите, что сделать с уже размеченными этой джобой сценами.";
    }
    if (jobType === "backfill_embeddings") {
      return "Выберите, что сделать с уже созданными этой джобой эмбеддингами.";
    }
    return "Подтвердите остановку джобы.";
  };

  const getCancelKeepLabel = (jobType: string): string => {
    if (jobType === "backfill_vlm") {
      return "Остановить и сохранить разметку";
    }
    if (jobType === "backfill_embeddings") {
      return "Остановить и сохранить эмбеддинги";
    }
    return "Остановить и сохранить";
  };

  const getCancelDeleteLabel = (jobType: string): string => {
    if (jobType === "backfill_vlm") {
      return "Остановить и удалить разметку";
    }
    if (jobType === "backfill_embeddings") {
      return "Остановить и удалить эмбеддинги";
    }
    return "Остановить и удалить";
  };

  const isWaymoAuthPermissionError = (job: Job): boolean => {
    if (job.job_type !== "install_waymo" || job.status !== "error") {
      return false;
    }
    const chunks: string[] = [];
    if (Array.isArray(job.errors)) {
      for (const entry of job.errors) {
        if (entry?.error) chunks.push(String(entry.error));
        if (entry?.log) chunks.push(String(entry.log));
      }
    }
    if (Array.isArray(job.job_log)) {
      chunks.push(job.job_log.join("\n"));
    }
    const haystack = chunks.join("\n").toLowerCase();
    return (
      haystack.includes("storage.objects.list") ||
      haystack.includes("google.api_core.exceptions.forbidden") ||
      haystack.includes("permission 'storage.objects.list' denied") ||
      haystack.includes("does not have storage.objects.list access")
    );
  };

  const fetchWaymoAuthLink = async () => {
    try {
      setWaymoAuthBusy(true);
      setWaymoAuthError(null);
      const response = await axios.post<WaymoAuthStartResponse>("/api/waymo/auth/start", {});
      const payload = response.data || {};
      const sessionId = String(payload.session_id || "").trim();
      const authUrl = String(payload.auth_url || "").trim();
      if (!sessionId) {
        throw new Error("Не удалось создать сессию авторизации Waymo.");
      }
      setWaymoAuthSessionId(sessionId);
      setWaymoAuthUrl(authUrl || null);
      if (!authUrl) {
        setWaymoAuthError(
          "Ссылка авторизации пока не получена. Нажмите «Обновить ссылку» через несколько секунд."
        );
      }
    } catch (err) {
      const detail = axios.isAxiosError(err) ? err.response?.data : null;
      const serverMessage =
        typeof detail?.detail === "string"
          ? detail.detail
          : typeof detail?.error === "string"
            ? detail.error
            : typeof err === "object" && err && "message" in err
              ? String((err as { message?: string }).message || "")
              : "Не удалось запустить авторизацию Waymo.";
      setWaymoAuthError(serverMessage);
    } finally {
      setWaymoAuthBusy(false);
    }
  };

  const submitWaymoAuthCode = async () => {
    if (!waymoAuthSessionId) {
      setWaymoAuthError("Сначала получите ссылку авторизации.");
      return;
    }
    const code = waymoAuthCode.trim();
    if (!code) {
      setWaymoAuthError("Введите код авторизации.");
      return;
    }
    try {
      setWaymoAuthBusy(true);
      setWaymoAuthError(null);
      const response = await axios.post("/api/waymo/auth/complete", {
        session_id: waymoAuthSessionId,
        code,
      });
      const message = String(response.data?.message || "").trim();
      setWaymoAuthSuccess(
        message || "Авторизация Google ADC выполнена. Повторите установку Waymo."
      );
      setWaymoAuthModalOpen(false);
      setWaymoAuthCode("");
      await fetchJobs();
    } catch (err) {
      const detail = axios.isAxiosError(err) ? err.response?.data?.detail : null;
      if (detail && typeof detail === "object" && Array.isArray(detail.logs_tail)) {
        setWaymoAuthError(
          `${String(detail.message || "Ошибка авторизации")}\n\n${detail.logs_tail.join("\n")}`
        );
      } else if (typeof detail === "string") {
        setWaymoAuthError(detail);
      } else {
        const message =
          err instanceof Error ? err.message : "Не удалось завершить авторизацию.";
        setWaymoAuthError(message);
      }
    } finally {
      setWaymoAuthBusy(false);
    }
  };

  const openWaymoAuthModal = async () => {
    setWaymoAuthModalOpen(true);
    setWaymoAuthError(null);
    setWaymoAuthSuccess(null);
    if (!waymoAuthSessionId) {
      await fetchWaymoAuthLink();
    }
  };

  useEffect(() => {
    const failedWaymo = jobs.find((job) => {
      if (!isWaymoAuthPermissionError(job)) {
        return false;
      }
      return !waymoAuthPromptedJobIds.includes(job.job_id);
    });
    if (!failedWaymo) {
      return;
    }
    setWaymoAuthPromptedJobIds((current) => [...current, failedWaymo.job_id]);
    setWaymoAuthModalOpen(true);
    setWaymoAuthError(null);
    setWaymoAuthSuccess(null);
  }, [jobs, waymoAuthPromptedJobIds]);

  useEffect(() => {
    if (!waymoAuthModalOpen) {
      return;
    }
    if (waymoAuthSessionId || waymoAuthBusy) {
      return;
    }
    fetchWaymoAuthLink();
  }, [waymoAuthModalOpen, waymoAuthSessionId, waymoAuthBusy]);

  useEffect(() => {
    if (!logViewer?.jobId || !logViewer.source) {
      return;
    }
    const job = jobs.find((item) => item.job_id === logViewer.jobId);
    if (!job) {
      return;
    }
    const nextTitle =
      logViewer.source === "job"
        ? `Job log for ${formatJobTypeLabel(job.job_type)}`
        : `Error log for ${formatJobTypeLabel(job.job_type)}`;
    const nextContent =
      logViewer.source === "job" ? getJobMainLog(job) : getJobErrorLog(job);
    setLogViewer((current) => {
      if (!current || current.jobId !== logViewer.jobId || current.source !== logViewer.source) {
        return current;
      }
      if (current.title === nextTitle && current.content === nextContent) {
        return current;
      }
      return {
        ...current,
        title: nextTitle,
        content: nextContent,
      };
    });
  }, [
    jobs,
    logViewer?.jobId,
    logViewer?.source,
    formatJobTypeLabel,
    getJobMainLog,
    getJobErrorLog,
  ]);

  useEffect(() => {
    if (!logViewer && !configViewer && !cancelDialogJob && !waymoAuthModalOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      if (logViewer) {
        setLogViewer(null);
        return;
      }
      if (configViewer) {
        setConfigViewer(null);
        return;
      }
      if (cancelDialogJob) {
        setCancelDialogJob(null);
        return;
      }
      if (waymoAuthModalOpen) {
        setWaymoAuthModalOpen(false);
        setWaymoAuthError(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [logViewer, configViewer, cancelDialogJob, waymoAuthModalOpen]);

  if (isLoading && !systemInfo) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-gray-500">Загрузка информации о системе...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-red-600">Ошибка: {error}</div>
      </div>
    );
  }

  if (!systemInfo) {
    return null;
  }

  const serviceEntries = [
    { key: "embedder", label: "Embedder", data: systemInfo.services?.embedder },
    { key: "vlm", label: "VLM", data: systemInfo.services?.vlm },
  ];
  const gpuList = Array.isArray(systemInfo.gpu?.gpus) ? systemInfo.gpu?.gpus : [];

  return (
    <div className="py-8">
      {waymoAuthSuccess && (
        <div className="mx-auto mb-4 max-w-4xl rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
          {waymoAuthSuccess}
        </div>
      )}

      <div className="max-w-4xl mx-auto bg-white rounded-lg shadow-lg p-6">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl font-bold text-gray-900">Мониторинг системы</h2>
          <button
            onClick={fetchSystemInfo}
            className="px-4 py-2 bg-blue-600 text-white font-bold rounded-lg hover:bg-blue-700 transition-colors"
          >
            Обновить
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* CPU */}
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="flex justify-between items-center mb-2">
              <h3 className="text-lg font-semibold text-gray-700">Процессор (CPU)</h3>
              <span className="text-sm text-gray-500">{systemInfo.cpu.cores} ядер</span>
            </div>
            <div className="mb-2">
              <div className="flex justify-between text-sm mb-1">
                <span className="text-gray-600">Использование</span>
                <span className="font-bold">{systemInfo.cpu.usage_percent.toFixed(1)}%</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-3">
                <div
                  className={`h-3 rounded-full transition-all duration-300 ${getUsageColor(
                    systemInfo.cpu.usage_percent
                  )}`}
                  style={{ width: `${systemInfo.cpu.usage_percent}%` }}
                ></div>
              </div>
            </div>
          </div>

          {/* Memory */}
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="flex justify-between items-center mb-2">
              <h3 className="text-lg font-semibold text-gray-700">Память (RAM)</h3>
              <span className="text-sm text-gray-500">
                {systemInfo.memory.total_gb.toFixed(1)} GB
              </span>
            </div>
            <div className="mb-2">
              <div className="flex justify-between text-sm mb-1">
                <span className="text-gray-600">Использовано</span>
                <span className="font-bold">
                  {systemInfo.memory.used_gb.toFixed(1)} GB / {systemInfo.memory.total_gb.toFixed(1)} GB
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-3">
                <div
                  className={`h-3 rounded-full transition-all duration-300 ${getUsageColor(
                    systemInfo.memory.usage_percent
                  )}`}
                  style={{ width: `${systemInfo.memory.usage_percent}%` }}
                ></div>
              </div>
            </div>
            <div className="text-xs text-gray-500 mt-1">
              Доступно: {systemInfo.memory.available_gb.toFixed(1)} GB
            </div>
          </div>

          {/* Disk */}
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="flex justify-between items-center mb-2">
              <h3 className="text-lg font-semibold text-gray-700">Диск</h3>
              <span className="text-sm text-gray-500">
                {systemInfo.disk.total_gb.toFixed(1)} GB
              </span>
            </div>
            <div className="mb-2">
              <div className="flex justify-between text-sm mb-1">
                <span className="text-gray-600">Использовано</span>
                <span className="font-bold">
                  {systemInfo.disk.used_gb.toFixed(1)} GB / {systemInfo.disk.total_gb.toFixed(1)} GB
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-3">
                <div
                  className={`h-3 rounded-full transition-all duration-300 ${getUsageColor(
                    systemInfo.disk.usage_percent
                  )}`}
                  style={{ width: `${systemInfo.disk.usage_percent}%` }}
                ></div>
              </div>
            </div>
            <div className="text-xs text-gray-500 mt-1">
              Доступно: {systemInfo.disk.available_gb.toFixed(1)} GB
            </div>
          </div>

          {/* Uptime */}
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="flex justify-between items-center mb-2">
              <h3 className="text-lg font-semibold text-gray-700">Время работы</h3>
            </div>
            <div className="text-2xl font-bold text-gray-900">
              {formatUptime(systemInfo.uptime_seconds)}
            </div>
            <div className="text-xs text-gray-500 mt-2">
              Последнее обновление: {new Date(systemInfo.timestamp).toLocaleString("ru-RU")}
            </div>
          </div>
        </div>

        {showRuntimePanels && (
          <>
            <div className="mt-6">
              <h3 className="text-lg font-semibold text-gray-800 mb-3">
                Модели и устройства
              </h3>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {serviceEntries.map((service) => {
                  const runtime = service.data?.runtime ?? {};
                  const memory = service.data?.memory ?? {};
                  const counters = service.data?.counters ?? {};
                  const selectedDevice =
                    String(runtime.selected_device || service.data?.device || "unknown");
                  return (
                    <div key={service.key} className="bg-slate-50 rounded-lg border border-slate-200 p-4">
                      <div className="flex items-center justify-between">
                        <h4 className="text-base font-semibold text-slate-800">{service.label}</h4>
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${serviceStatusBadge(
                            service.data?.reachable
                          )}`}
                        >
                          {service.data?.reachable ? "online" : "offline"}
                        </span>
                      </div>
                      <div className="mt-2 space-y-1 text-sm text-slate-700">
                        <div>
                          <span className="text-slate-500">Модель: </span>
                          <span className="font-medium">{service.data?.model || "—"}</span>
                        </div>
                        <div>
                          <span className="text-slate-500">Endpoint: </span>
                          <span className="font-mono text-xs">{service.data?.endpoint || "—"}</span>
                        </div>
                        <div>
                          <span className="text-slate-500">Устройство: </span>
                          <span className="font-semibold">{selectedDevice}</span>
                          {runtime.cuda_device_name ? (
                            <span className="text-xs text-slate-500">{` (${runtime.cuda_device_name})`}</span>
                          ) : null}
                        </div>
                        <div>
                          <span className="text-slate-500">Конфиг: </span>
                          <span>{String(runtime.configured_device || "—")}</span>
                          {runtime.dtype ? (
                            <span className="text-xs text-slate-500">{` · dtype=${runtime.dtype}`}</span>
                          ) : null}
                        </div>
                        <div>
                          <span className="text-slate-500">RAM процесса: </span>
                          <span>{formatMb(memory.process_rss_mb)}</span>
                        </div>
                        <div>
                          <span className="text-slate-500">GPU память: </span>
                          <span>
                            {`${formatMb(memory.gpu_allocated_mb)} alloc / ${formatMb(
                              memory.gpu_reserved_mb
                            )} reserved`}
                          </span>
                        </div>
                        {(memory.gpu_total_mb ?? 0) > 0 ? (
                          <div>
                            <span className="text-slate-500">GPU всего/свободно: </span>
                            <span>{`${formatMb(memory.gpu_total_mb)} / ${formatMb(
                              memory.gpu_free_mb
                            )}`}</span>
                          </div>
                        ) : null}
                        {typeof counters.in_progress === "number" ? (
                          <div>
                            <span className="text-slate-500">Запросы: </span>
                            <span>{`in_progress=${counters.in_progress}, completed=${counters.completed ?? 0}, received=${counters.received ?? 0}`}</span>
                          </div>
                        ) : null}
                        {service.data?.error ? (
                          <div className="text-xs text-rose-600">{service.data.error}</div>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="mt-6">
              <h3 className="text-lg font-semibold text-gray-800 mb-3">GPU хоста</h3>
              {gpuList.length === 0 ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                  {systemInfo.gpu?.error
                    ? `GPU недоступен: ${systemInfo.gpu.error}`
                    : "GPU не обнаружен на текущем хосте master-сервиса."}
                </div>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="min-w-full divide-y divide-slate-200 bg-white">
                    <thead className="bg-slate-50">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                          GPU
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                          Util
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                          Memory
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                          Temp
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {gpuList.map((gpu) => (
                        <tr key={`${gpu.index}-${gpu.uuid || gpu.name}`}>
                          <td className="px-3 py-2 text-sm text-slate-700">
                            <div className="font-medium">{`#${gpu.index} ${gpu.name}`}</div>
                            {gpu.uuid ? <div className="text-xs text-slate-500">{gpu.uuid}</div> : null}
                          </td>
                          <td className="px-3 py-2 text-sm text-slate-700">
                            {`${Number(gpu.utilization_percent ?? 0).toFixed(1)}%`}
                          </td>
                          <td className="px-3 py-2 text-sm text-slate-700">
                            {`${formatMb(gpu.memory_used_mb)} / ${formatMb(gpu.memory_total_mb)} (${Number(
                              gpu.memory_used_percent ?? 0
                            ).toFixed(1)}%)`}
                          </td>
                          <td className="px-3 py-2 text-sm text-slate-700">
                            {`${Number(gpu.temperature_c ?? 0).toFixed(0)}°C`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Таблица джобов */}
      <div className="max-w-[96rem] mx-auto bg-white rounded-lg shadow-lg p-6 mt-6">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl font-bold text-gray-900">Джобы</h2>
        </div>
        
        {jobs.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            Нет запущенных джоб
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    ID
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Тип
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Прогресс
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Статус
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Обработано
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Создано
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Время / ETA
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Действия
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {jobs.map((job) => {
                  const statusColors = getJobStatusColor(job.status);
                  const isCancellableJobType =
                    job.job_type === "backfill_vlm" ||
                    job.job_type === "backfill_embeddings" ||
                    job.job_type.startsWith("install_") ||
                    job.job_type === "snapshot_import" ||
                    job.job_type === "snapshot_transfer" ||
                    job.job_type === "snapshot_export" ||
                    job.job_type.startsWith("snapshot_export_") ||
                    job.job_type === "dataset_delete";
                  const canCancelJob =
                    isCancellableJobType && job.status === "running" && !job.cancel_requested;
                  const isVlmJob = job.job_type === "backfill_vlm";
                  const isInstallJob = job.job_type.startsWith("install_");
                  const isInstallDatasetJob = isInstallJob;
                  const isSnapshotTransferJob =
                    job.job_type === "snapshot_import" ||
                    job.job_type === "snapshot_transfer" ||
                    job.job_type === "snapshot_export" ||
                    job.job_type.startsWith("snapshot_export_");
                  const normalizeSnapshotProgress = () => {
                    const totalSeen = Math.max(0, Number(job.total_seen ?? 0));
                    const totalPlannedRaw = Number(job.total_planned ?? job.total_limit ?? 0);
                    const totalPlanned =
                      Number.isFinite(totalPlannedRaw) && totalPlannedRaw > 0 ? totalPlannedRaw : 0;
                    if (totalPlanned > 0 && totalSeen > 0 && totalSeen < totalPlanned) {
                      return Math.max(
                        0,
                        Math.min(100, Math.round((totalSeen / totalPlanned) * 100))
                      );
                    }
                    return Math.max(0, Math.min(100, Math.round(Number(job.progress || 0))));
                  };
                  const progress = isSnapshotTransferJob
                    ? normalizeSnapshotProgress()
                    : Math.max(0, Math.min(100, Math.round(Number(job.progress || 0))));
                  const plannedTotal = job.total_planned ?? job.total_limit;
                  const snapshotPhase = String(job.phase || "").trim().toLowerCase();
                  const snapshotUploadSeen = Math.max(
                    0,
                    Number(job.upload_bytes_seen ?? job.total_seen ?? 0)
                  );
                  const snapshotUploadTotalRaw = Number(
                    job.upload_bytes_total ?? job.total_planned ?? job.total_limit ?? 0
                  );
                  const snapshotUploadTotal =
                    Number.isFinite(snapshotUploadTotalRaw) && snapshotUploadTotalRaw > 0
                      ? snapshotUploadTotalRaw
                      : 0;
                  const snapshotUploadProgress =
                    snapshotUploadTotal > 0
                      ? Math.max(
                          0,
                          Math.min(100, Math.round((Math.min(snapshotUploadSeen, snapshotUploadTotal) / snapshotUploadTotal) * 100))
                        )
                      : Math.max(0, Math.min(100, Math.round(Number(job.upload_progress ?? 0))));
                  const snapshotExtractSeen = Math.max(
                    0,
                    Number(job.extract_bytes_seen ?? 0)
                  );
                  const snapshotExtractTotalRaw = Number(job.extract_bytes_total ?? 0);
                  const snapshotExtractTotal =
                    Number.isFinite(snapshotExtractTotalRaw) && snapshotExtractTotalRaw > 0
                      ? snapshotExtractTotalRaw
                      : 0;
                  const snapshotExtractProgress =
                    snapshotExtractTotal > 0
                      ? Math.max(
                          0,
                          Math.min(100, Math.round((Math.min(snapshotExtractSeen, snapshotExtractTotal) / snapshotExtractTotal) * 100))
                        )
                      : Math.max(0, Math.min(100, Math.round(Number(job.extract_progress ?? 0))));
                  const showSnapshotImportDetails =
                    job.job_type === "snapshot_import" && job.status === "running";
                  const snapshotMainLabel = (() => {
                    if (!isSnapshotTransferJob) return "";
                    if (job.job_type === "snapshot_import") {
                      if (snapshotPhase === "processing") {
                        return `Extract: ${formatDataSize(snapshotExtractSeen)} / ${
                          snapshotExtractTotal > 0 ? formatDataSize(snapshotExtractTotal) : "?"
                        }`;
                      }
                      return `Upload: ${formatDataSize(snapshotUploadSeen)} / ${
                        snapshotUploadTotal > 0 ? formatDataSize(snapshotUploadTotal) : "?"
                      }`;
                    }
                    return `${formatDataSize(job.total_seen ?? 0)} / ${
                      plannedTotal && plannedTotal > 0 ? formatDataSize(plannedTotal) : "?"
                    }`;
                  })();
                  const progressLabel = isSnapshotTransferJob
                    ? snapshotMainLabel
                    : `${job.total_seen} / ${plannedTotal ?? "?"}`;
                  const processedLabel = progressLabel;
                  const scenesSavedLabel = `Сцен сохранено: ${job.total_inserted}`;
                  const installScenesSavedLabel = `Сцен сохранено: ${job.total_inserted}`;
                  const embeddingTasksCompleted = job.embedding_tasks_completed ?? 0;
                  const embeddingTasksTotal = job.embedding_tasks_total ?? 0;
                  const embeddingProgress =
                    embeddingTasksTotal > 0
                      ? Math.min((embeddingTasksCompleted / embeddingTasksTotal) * 100, 100)
                      : 0;
                  const showEmbeddingProgress =
                    isInstallJob &&
                    Boolean(
                      job.embed_on_install ||
                        embeddingTasksTotal > 0 ||
                        (job.total_embeddings_inserted ?? 0) > 0
                    );
                  const embeddingStatusLabel =
                    embeddingTasksTotal > 0
                      ? `Embedding: ${embeddingTasksCompleted} / ${embeddingTasksTotal}`
                      : "Embedding: ожидание скачанных сцен";
                  const currentSceneTasksCompleted = job.current_scene_tasks_completed ?? 0;
                  const currentSceneTasksTotal = job.current_scene_tasks_total ?? 0;
                  const installPhase = String(job.install_phase ?? "").toLowerCase();
                  const currentSceneProgress =
                    currentSceneTasksTotal > 0
                      ? Math.min(
                          (currentSceneTasksCompleted / currentSceneTasksTotal) * 100,
                          100
                        )
                      : 0;
                  const currentSceneLabel = isInstallJob
                    ? `Install: ${currentSceneTasksCompleted} / ${currentSceneTasksTotal}`
                    : `VLM calls: ${currentSceneTasksCompleted} / ${currentSceneTasksTotal}`;
                  const currentSceneIndex = job.current_scene_index ?? 0;
                  const timing = getJobTiming(job);
                  const downloadLabelPrefix = String(job.download_label ?? "").trim() || "Download";
                  const installFileLabel = `${downloadLabelPrefix}: ${formatDataSize(
                    currentSceneTasksCompleted
                  )} / ${formatDataSize(currentSceneTasksTotal)}`;
                  const isNuimagesInstallJob =
                    job.job_type === "install_nuimages" || job.job_type === "install_nuscenes";
                  const isBddInstallJob = job.job_type === "install_bdd100k";
                  const isOnceInstallJob =
                    job.job_type === "install_once" || String(job.dataset ?? "").toLowerCase() === "once";
                  const installArchiveLabel = `Archive: ${formatDataSize(
                    currentSceneTasksCompleted
                  )} / ${formatDataSize(currentSceneTasksTotal)}`;
                  const installUploadLabel = `Upload: ${currentSceneTasksCompleted} / ${currentSceneTasksTotal} images`;
                  const installSplitLabel = `Split: ${currentSceneTasksCompleted} / ${currentSceneTasksTotal}`;
                  const installSecondaryLabel =
                    installPhase === "upload"
                      ? installUploadLabel
                      : installPhase === "download" && isOnceInstallJob
                        ? installSplitLabel
                      : isNuimagesInstallJob || isBddInstallJob
                        ? installArchiveLabel
                        : installFileLabel;
                  const extractTasksCompleted = job.extract_scene_tasks_completed ?? 0;
                  const extractTasksTotal = job.extract_scene_tasks_total ?? 0;
                  const extractSceneIndex = job.extract_scene_index ?? 0;
                  const extractSceneProgress =
                    extractTasksTotal > 0
                      ? Math.min((extractTasksCompleted / extractTasksTotal) * 100, 100)
                      : 0;
                  const extractFileName = String(job.extract_file_name ?? "").trim();
                  const extractFilesDone = job.extract_files_done ?? 0;
                  const extractLabelPrefix =
                    isOnceInstallJob && installPhase === "download" ? "Download file" : "Extract";
                  const extractLabelBase = `${extractLabelPrefix}: ${formatDataSize(
                    extractTasksCompleted
                  )} / ${formatDataSize(extractTasksTotal)}`;
                  const extractLabel = extractFileName
                    ? `${extractLabelBase} · ${extractFileName}`
                    : extractLabelBase;
                  const secondaryProgressLabel = isInstallDatasetJob
                    ? installSecondaryLabel
                    : currentSceneLabel;
                  const secondaryProgressGradient = isInstallDatasetJob
                    ? installPhase === "upload"
                      ? "linear-gradient(90deg, hsl(146 70% 42%), hsl(172 70% 38%))"
                      : "linear-gradient(90deg, hsl(200 78% 48%), hsl(160 78% 45%))"
                    : getSceneTaskGradient(currentSceneIndex);
                  const showSecondaryProgress =
                    job.status === "running" &&
                    currentSceneTasksTotal > 0 &&
                    (isVlmJob || isInstallJob);
                  const showExtractProgress =
                    job.status === "running" &&
                    isInstallDatasetJob &&
                    extractTasksTotal > 0 &&
                    (installPhase === "extract" || (isOnceInstallJob && installPhase === "download"));
                  const extractRightLabel =
                    isOnceInstallJob && installPhase === "download"
                      ? `File ${Math.min(extractSceneIndex, plannedTotal || extractSceneIndex)}`
                      : isBddInstallJob
                        ? `Archive ${Math.min(
                            extractSceneIndex,
                            plannedTotal || extractSceneIndex
                          )} · files ${extractFilesDone}`
                      : `Part ${Math.min(
                          extractSceneIndex,
                          plannedTotal || extractSceneIndex
                        )} · files ${extractFilesDone}`;
                  const hasErrorDetails = job.status === "error" && (job.errors?.length ?? 0) > 0;
                  const hasJobLogData =
                    Array.isArray(job.job_log) && job.job_log.length > 0;
                  const canOpenJobLogOnSuccess = job.status === "success" && hasJobLogData;
                  const canOpenJobLogOnRunning = job.status === "running" && hasJobLogData;
                  const canOpenJobLogOnCancelled = job.status === "cancelled" && hasJobLogData;
                  const canRetryJob = job.status === "error";
                  
                  return (
                    <tr key={job.job_id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        <button
                          type="button"
                          onClick={() => {
                            const config = job.job_config && typeof job.job_config === "object"
                              ? job.job_config
                              : {};
                            setConfigViewer({
                              title: `Job config for ${formatJobTypeLabel(job.job_type)}`,
                              content: JSON.stringify(config, null, 2),
                            });
                          }}
                          className="font-semibold text-sky-700 underline decoration-sky-600 underline-offset-2 hover:text-sky-800"
                        >
                          {job.job_id.substring(0, 8)}...
                        </button>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {formatJobTypeLabel(job.job_type)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="w-full">
                          <div className="flex justify-between text-xs mb-1">
                            <span className="text-gray-600">
                              {progressLabel}
                            </span>
                            <span className="font-medium">{progress}%</span>
                          </div>
                          <div className="w-full bg-gray-200 rounded-full h-2">
                            <div
                              className={`h-2 rounded-full transition-all duration-300 ${statusColors.bg}`}
                              style={{ width: `${progress}%` }}
                            ></div>
                          </div>
                          <div className="text-xs text-gray-500 mt-1">
                            {isVlmJob
                              ? scenesSavedLabel
                              : isInstallJob
                                ? installScenesSavedLabel
                                : `Вставлено: ${job.total_inserted}`}
                          </div>
                          {showSnapshotImportDetails && (
                            <div className="mt-3 space-y-2">
                              <div>
                                <div className="mb-1 flex justify-between gap-2 text-xs">
                                  <span className="text-gray-600">
                                    Upload: {formatDataSize(snapshotUploadSeen)} /{" "}
                                    {snapshotUploadTotal > 0
                                      ? formatDataSize(snapshotUploadTotal)
                                      : "?"}
                                  </span>
                                  <span className="font-medium">{snapshotUploadProgress}%</span>
                                </div>
                                <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200">
                                  <div
                                    className="h-1.5 rounded-full bg-sky-500 transition-all duration-300"
                                    style={{ width: `${snapshotUploadProgress}%` }}
                                  ></div>
                                </div>
                              </div>
                              <div>
                                <div className="mb-1 flex justify-between gap-2 text-xs">
                                  <span className="text-gray-600">
                                    Extract: {formatDataSize(snapshotExtractSeen)} /{" "}
                                    {snapshotExtractTotal > 0
                                      ? formatDataSize(snapshotExtractTotal)
                                      : "?"}
                                    {snapshotPhase === "processing" ? " (processing)" : ""}
                                  </span>
                                  <span className="font-medium">{snapshotExtractProgress}%</span>
                                </div>
                                <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200">
                                  <div
                                    className="h-1.5 rounded-full bg-emerald-500 transition-all duration-300"
                                    style={{ width: `${snapshotExtractProgress}%` }}
                                  ></div>
                                </div>
                              </div>
                            </div>
                          )}
                          {showEmbeddingProgress && (
                            <div className="text-xs text-gray-500 mt-1">
                              {`Эмбеддингов сохранено: ${job.total_embeddings_inserted ?? 0}`}
                            </div>
                          )}
                          {showSecondaryProgress && (
                            <div className="mt-3">
                              <div className="flex justify-between gap-2 text-xs mb-1">
                                <span className="text-gray-600">{secondaryProgressLabel}</span>
                                <span className="font-medium pl-2 whitespace-nowrap">
                                  {isInstallDatasetJob
                                    ? installPhase === "upload"
                                      ? `Scene ${Math.min(
                                          currentSceneIndex,
                                          plannedTotal || currentSceneIndex
                                        )}`
                                      : isNuimagesInstallJob
                                        ? `Archive ${Math.min(
                                            currentSceneIndex,
                                            plannedTotal || currentSceneIndex
                                          )}`
                                        : isBddInstallJob
                                          ? `Archive ${Math.min(
                                              currentSceneIndex,
                                              plannedTotal || currentSceneIndex
                                            )}`
                                        : `File ${Math.min(
                                            currentSceneIndex,
                                            plannedTotal || currentSceneIndex
                                          )}`
                                    : `Scene ${Math.min(
                                        currentSceneIndex,
                                        plannedTotal || currentSceneIndex
                                      )}`}
                                </span>
                              </div>
                              <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                                <div
                                  className="h-2 rounded-full transition-all duration-300"
                                  style={{
                                    width: `${currentSceneProgress}%`,
                                    backgroundImage: secondaryProgressGradient,
                                  }}
                                ></div>
                              </div>
                            </div>
                          )}
                          {showEmbeddingProgress && (
                            <div className="mt-3">
                              <div className="flex justify-between gap-2 text-xs mb-1">
                                <span className="text-gray-600">{embeddingStatusLabel}</span>
                                <span className="font-medium pl-2 whitespace-nowrap">
                                  {job.status === "running" && (job.embedding_worker_running ?? false)
                                    ? "Running"
                                    : "Done"}
                                </span>
                              </div>
                              <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                                <div
                                  className="h-2 rounded-full transition-all duration-300"
                                  style={{
                                    width: `${embeddingProgress}%`,
                                    backgroundImage:
                                      "linear-gradient(90deg, hsl(24 88% 52%), hsl(42 94% 55%))",
                                  }}
                                ></div>
                              </div>
                            </div>
                          )}
                          {showExtractProgress && (
                            <div className="mt-3">
                              <div className="flex justify-between gap-2 text-xs mb-1">
                                <span className="text-gray-600">{extractLabel}</span>
                                <span className="font-medium pl-2 whitespace-nowrap">
                                  {extractRightLabel}
                                </span>
                              </div>
                              <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                                <div
                                  className="h-2 rounded-full transition-all duration-300"
                                  style={{
                                    width: `${extractSceneProgress}%`,
                                    backgroundImage:
                                      "linear-gradient(90deg, hsl(28 88% 52%), hsl(14 84% 56%))",
                                  }}
                                ></div>
                              </div>
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        {hasErrorDetails ? (
                          <button
                            type="button"
                            onClick={() =>
                              setLogViewer({
                                title: `Error log for ${formatJobTypeLabel(job.job_type)}`,
                                content: getJobErrorLog(job),
                                jobId: job.job_id,
                                source: "error",
                              })
                            }
                            className="font-bold text-red-600 underline decoration-red-600 underline-offset-2 hover:text-red-700"
                          >
                            Error
                          </button>
                        ) : canOpenJobLogOnSuccess ? (
                          <button
                            type="button"
                            onClick={() =>
                              setLogViewer({
                                title: `Job log for ${formatJobTypeLabel(job.job_type)}`,
                                content: getJobMainLog(job),
                                jobId: job.job_id,
                                source: "job",
                              })
                            }
                            className="font-bold text-green-700 underline decoration-green-700 underline-offset-2 hover:text-green-800"
                          >
                            Success
                          </button>
                        ) : canOpenJobLogOnRunning ? (
                          <button
                            type="button"
                            onClick={() =>
                              setLogViewer({
                                title: `Job log for ${formatJobTypeLabel(job.job_type)}`,
                                content: getJobMainLog(job),
                                jobId: job.job_id,
                                source: "job",
                              })
                            }
                            className="font-bold text-blue-700 underline decoration-blue-700 underline-offset-2 hover:text-blue-800"
                          >
                            {getJobStatusText(job.status, job.cancel_requested)}
                          </button>
                        ) : canOpenJobLogOnCancelled ? (
                          <button
                            type="button"
                            onClick={() =>
                              setLogViewer({
                                title: `Job log for ${formatJobTypeLabel(job.job_type)}`,
                                content: getJobMainLog(job),
                                jobId: job.job_id,
                                source: "job",
                              })
                            }
                            className="font-bold text-gray-600 underline decoration-gray-500 underline-offset-2 hover:text-gray-700"
                          >
                            {getJobStatusText(job.status, job.cancel_requested)}
                          </button>
                        ) : (
                          <span className={`font-semibold ${statusColors.text}`}>
                            {getJobStatusText(job.status, job.cancel_requested)}
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {processedLabel}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {formatDate(job.created_at)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        <div className="leading-5">
                          <div className="font-medium text-gray-700">{timing.elapsed}</div>
                          <div className="text-xs text-gray-500">ETA: {timing.eta}</div>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        <div className="flex flex-col gap-2">
                          {canCancelJob ? (
                            <button
                              onClick={() => setCancelDialogJob(job)}
                              disabled={cancellingJobId === job.job_id}
                              className={`px-4 py-2 rounded-lg font-semibold transition-all duration-200 ${
                                cancellingJobId === job.job_id
                                  ? "bg-red-300 text-white cursor-not-allowed"
                                  : "bg-red-600 text-white hover:bg-red-700"
                              }`}
                            >
                              {cancellingJobId === job.job_id ? "Отмена..." : "Отменить"}
                            </button>
                          ) : isCancellableJobType && job.status === "cancelled" ? (
                            <span className="text-gray-500 font-medium">Отменено</span>
                          ) : isCancellableJobType &&
                            job.status === "running" &&
                            job.cancel_requested ? (
                            <span className="text-red-600 font-medium">Остановка...</span>
                          ) : (
                            !canRetryJob && <span className="text-gray-400">-</span>
                          )}

                          {isWaymoAuthPermissionError(job) && (
                            <button
                              type="button"
                              onClick={openWaymoAuthModal}
                              className="rounded-lg border border-indigo-300 px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-50"
                            >
                              Авторизовать Waymo
                            </button>
                          )}

                          {canRetryJob && (
                            <button
                              type="button"
                              onClick={() => executeRetryJob(job)}
                              disabled={retryingJobId === job.job_id}
                              title="Повторить джобу"
                              aria-label="Повторить джобу"
                              className={`inline-flex w-fit items-center justify-center rounded-md p-1 transition ${
                                retryingJobId === job.job_id
                                  ? "cursor-not-allowed text-slate-300"
                                  : "text-slate-700 hover:text-sky-700"
                              }`}
                            >
                              <svg
                                xmlns="http://www.w3.org/2000/svg"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                className="h-5 w-5 overflow-visible"
                                aria-hidden="true"
                              >
                                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                                <path d="M21 3v6h-6" />
                              </svg>
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {logViewer && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setLogViewer(null);
            }
          }}
        >
          <div className="max-h-[80vh] w-full max-w-4xl overflow-hidden rounded-xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <div>
                <div className="text-sm font-semibold text-slate-900">
                  {logViewer.title}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setLogViewer(null)}
                className="rounded-lg border border-slate-300 px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                Close
              </button>
            </div>
            <div className="max-h-[calc(80vh-72px)] overflow-auto p-5">
              <pre className="whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-4 font-mono text-xs leading-5 text-slate-100">
                {logViewer.content}
              </pre>
            </div>
          </div>
        </div>
      )}

      {configViewer && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setConfigViewer(null);
            }
          }}
        >
          <div className="max-h-[80vh] w-full max-w-4xl overflow-hidden rounded-xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <div className="text-sm font-semibold text-slate-900">{configViewer.title}</div>
              <button
                type="button"
                onClick={() => setConfigViewer(null)}
                className="rounded-lg border border-slate-300 px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                Close
              </button>
            </div>
            <div className="max-h-[calc(80vh-72px)] overflow-auto p-5">
              <pre className="whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-4 font-mono text-xs leading-5 text-slate-100">
                {configViewer.content}
              </pre>
            </div>
          </div>
        </div>
      )}

      {waymoAuthModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setWaymoAuthModalOpen(false);
              setWaymoAuthError(null);
            }
          }}
        >
          <div className="w-full max-w-2xl overflow-hidden rounded-xl bg-white shadow-2xl">
            <div className="border-b border-slate-200 px-5 py-4">
              <div className="text-base font-semibold text-slate-900">
                Авторизация доступа к Waymo
              </div>
              <div className="mt-1 text-xs text-slate-500">
                Требуется `gcloud auth application-default login` для чтения датасета.
              </div>
            </div>
            <div className="space-y-4 px-5 py-4">
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                1. Откройте ссылку ниже и войдите в Google-аккаунт с доступом к Waymo.
                <br />
                2. Скопируйте код подтверждения и вставьте его в поле.
                <br />
                3. Нажмите `Подтвердить код`.
              </div>

              <div>
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Ссылка авторизации
                </div>
                {waymoAuthUrl ? (
                  <a
                    href={waymoAuthUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="block break-all rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700 hover:bg-blue-100"
                  >
                    {waymoAuthUrl}
                  </a>
                ) : (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                    Ссылка пока не получена. Нажмите «Обновить ссылку».
                  </div>
                )}
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Код подтверждения
                </label>
                <input
                  type="text"
                  value={waymoAuthCode}
                  onChange={(event) => setWaymoAuthCode(event.target.value)}
                  placeholder="Вставьте код из Google"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm text-slate-900 outline-none ring-0 transition focus:border-indigo-500"
                />
              </div>

              {waymoAuthError && (
                <pre className="whitespace-pre-wrap rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
                  {waymoAuthError}
                </pre>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 px-5 py-4">
              <button
                type="button"
                onClick={() => {
                  setWaymoAuthModalOpen(false);
                  setWaymoAuthError(null);
                }}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                Закрыть
              </button>
              <button
                type="button"
                onClick={fetchWaymoAuthLink}
                disabled={waymoAuthBusy}
                className="rounded-lg border border-indigo-300 px-3 py-2 text-sm font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-60"
              >
                {waymoAuthBusy ? "Загрузка..." : "Обновить ссылку"}
              </button>
              <button
                type="button"
                onClick={submitWaymoAuthCode}
                disabled={waymoAuthBusy}
                className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
              >
                {waymoAuthBusy ? "Проверка..." : "Подтвердить код"}
              </button>
            </div>
          </div>
        </div>
      )}

      {cancelDialogJob && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setCancelDialogJob(null);
            }
          }}
        >
          <div className="w-full max-w-lg rounded-xl bg-white shadow-2xl">
            <div className="border-b border-slate-200 px-5 py-4">
              <div className="text-base font-semibold text-slate-900">
                Остановить джобу?
              </div>
              <div className="mt-1 text-xs text-slate-500">
                {formatJobTypeLabel(cancelDialogJob.job_type)} · {cancelDialogJob.job_id}
              </div>
            </div>
            <div className="px-5 py-4 text-sm text-slate-700">
              {getCancelDialogDescription(cancelDialogJob.job_type)}
            </div>
            <div className="flex flex-nowrap items-center justify-end gap-2 border-t border-slate-200 px-5 py-4">
              <button
                type="button"
                onClick={() => setCancelDialogJob(null)}
                className="inline-flex h-10 items-center justify-center rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                Закрыть
              </button>
              {supportsCleanupChoice(cancelDialogJob.job_type) ? (
                <>
                  <button
                    type="button"
                    onClick={() => executeCancelJob(cancelDialogJob, "keep")}
                    disabled={cancellingJobId === cancelDialogJob.job_id}
                    className="inline-flex h-10 items-center justify-center rounded-lg border border-blue-300 px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-60"
                  >
                    {getCancelKeepLabel(cancelDialogJob.job_type)}
                  </button>
                  <button
                    type="button"
                    onClick={() => executeCancelJob(cancelDialogJob, "delete")}
                    disabled={cancellingJobId === cancelDialogJob.job_id}
                    className="inline-flex h-10 items-center justify-center rounded-lg border border-red-600 bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60"
                  >
                    {getCancelDeleteLabel(cancelDialogJob.job_type)}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => executeCancelJob(cancelDialogJob, "keep")}
                  disabled={cancellingJobId === cancelDialogJob.job_id}
                  className="inline-flex h-10 items-center justify-center rounded-lg border border-red-600 bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60"
                >
                  Остановить
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
