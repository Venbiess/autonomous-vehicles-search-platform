"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import axios from "axios";
import {
  getLocalizedText,
  getUiLanguageLocale,
  type UiLanguageCode,
} from "../lib/uiLanguage";

interface RuntimeServiceData {
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
    attn_type?: string;
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
}

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
    embedder?: RuntimeServiceData;
    vlm?: RuntimeServiceData;
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

interface EtaCounters {
  completed: number;
  total: number;
}

interface JobEtaState {
  total: number;
  completed: number;
  lastObservedAt: number;
  lastProgressAt: number;
  smoothedSecPerUnit: number | null;
  lastEtaSec: number | null;
}

interface LogViewerState {
  title: string;
  content: string;
  jobId?: string;
  source?: "job" | "error" | "model";
  modelService?: "embedder" | "vlm";
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

type ModelServiceKey = "embedder" | "vlm";
type RuntimeServiceStatus = "online" | "starting" | "offline";

export default function SystemMonitor({
  language = "ru",
  showModelsPanel = true,
  showGpuPanel = true,
  isActive = true,
}: {
  language?: UiLanguageCode;
  showModelsPanel?: boolean;
  showGpuPanel?: boolean;
  isActive?: boolean;
}) {
  const tr = useCallback(
    (ru: string, en: string) => getLocalizedText(language, { ru, en }, en),
    [language]
  );
  const dateLocale = getUiLanguageLocale(language);
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
  const etaStateRef = useRef<Record<string, JobEtaState>>({});
  const sceneBarColorStateRef = useRef<
    Record<string, { paletteIndex: number; lastProgress: number }>
  >({});
  const [modelLogMeta, setModelLogMeta] = useState<
    Record<ModelServiceKey, { exists: boolean; updated_at?: string | null }>
  >({
    embedder: { exists: false, updated_at: null },
    vlm: { exists: false, updated_at: null },
  });
  const grafanaDashboardUrl =
    process.env.NEXT_PUBLIC_GRAFANA_DASHBOARD_URL?.trim() ||
    "http://localhost:3004/d/avsp-observability/avsp-observability?orgId=1";
  const grafanaContainerDashboardUrl =
    process.env.NEXT_PUBLIC_GRAFANA_CONTAINER_DASHBOARD_URL?.trim() ||
    "http://localhost:3004/d/avsp-container-drilldown/avsp-container-drilldown?orgId=1";
  const cadvisorContainersUrl =
    process.env.NEXT_PUBLIC_CADVISOR_CONTAINERS_URL?.trim() ||
    "http://localhost:8088/containers/";

  const fetchSystemInfo = useCallback(async () => {
    try {
      const response = await axios.get("/api/system-info");
      setSystemInfo(response.data);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : tr("Не удалось загрузить информацию о системе", "Failed to load system info");
      setError(message);
    }
  }, [tr]);

  const fetchJobs = useCallback(async () => {
    try {
      const response = await axios.get("/api/jobs", {
        validateStatus: () => true,
      });
      const payload = response?.data;
      setJobs((prev) => (Array.isArray(payload?.jobs) ? payload.jobs : prev));
      if (response.status >= 400) {
        const message =
          typeof payload?.error === "string" && payload.error.trim()
            ? payload.error
            : `HTTP ${response.status}`;
        console.warn("Jobs endpoint returned non-2xx status:", message);
      }
      if (typeof payload?.error === "string" && payload.error.trim()) {
        console.warn("Jobs endpoint returned a degraded response:", payload.error);
      }
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const fallbackJobs = err.response?.data?.jobs;
        if (Array.isArray(fallbackJobs)) {
          setJobs(fallbackJobs);
        }
        const message =
          typeof err.response?.data?.error === "string"
            ? err.response.data.error
            : err.message;
        if (message) {
          console.warn("Jobs polling temporary failure:", message);
        }
      }
    }
  }, []);

  const fetchModelLogMeta = useCallback(async () => {
    try {
      const [embedderResponse, vlmResponse] = await Promise.allSettled([
        axios.get("/api/model-logs", {
          params: { service: "embedder", meta_only: "1" },
        }),
        axios.get("/api/model-logs", {
          params: { service: "vlm", meta_only: "1" },
        }),
      ]);
      const embedderData =
        embedderResponse.status === "fulfilled" ? embedderResponse.value.data : null;
      const vlmData = vlmResponse.status === "fulfilled" ? vlmResponse.value.data : null;
      setModelLogMeta({
        embedder: {
          exists: Boolean(embedderData?.exists),
          updated_at:
            typeof embedderData?.updated_at === "string"
              ? embedderData.updated_at
              : null,
        },
        vlm: {
          exists: Boolean(vlmData?.exists),
          updated_at:
            typeof vlmData?.updated_at === "string"
              ? vlmData.updated_at
              : null,
        },
      });
      if (embedderResponse.status === "rejected" || vlmResponse.status === "rejected") {
        console.warn("Model log metadata partially unavailable", {
          embedder:
            embedderResponse.status === "rejected" ? String(embedderResponse.reason || "") : "ok",
          vlm: vlmResponse.status === "rejected" ? String(vlmResponse.reason || "") : "ok",
        });
      }
    } catch (err) {
      console.error("Failed to fetch model log metadata:", err);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let coreTimer: ReturnType<typeof setTimeout> | null = null;
    let modelLogTimer: ReturnType<typeof setTimeout> | null = null;

    const getCoreDelay = (): number => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return 20000;
      }
      return isActive ? 5000 : 12000;
    };

    const getModelDelay = (): number => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return 30000;
      }
      return isActive ? 10000 : 20000;
    };

    const scheduleCore = () => {
      const delay = getCoreDelay();
      coreTimer = setTimeout(async () => {
        if (cancelled) return;
        await Promise.all([fetchSystemInfo(), fetchJobs()]);
        if (!cancelled) {
          scheduleCore();
        }
      }, delay);
    };

    const scheduleModel = () => {
      const delay = getModelDelay();
      modelLogTimer = setTimeout(async () => {
        if (cancelled) return;
        await fetchModelLogMeta();
        if (!cancelled) {
          scheduleModel();
        }
      }, delay);
    };

    const boot = async () => {
      setIsLoading(true);
      await Promise.all([fetchSystemInfo(), fetchJobs(), fetchModelLogMeta()]);
      if (!cancelled) {
        setIsLoading(false);
        scheduleCore();
        scheduleModel();
      }
    };

    const onVisibilityChange = () => {
      if (cancelled) return;
      if (coreTimer) clearTimeout(coreTimer);
      if (modelLogTimer) clearTimeout(modelLogTimer);
      fetchSystemInfo();
      fetchJobs();
      fetchModelLogMeta();
      scheduleCore();
      scheduleModel();
    };

    boot();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (coreTimer) clearTimeout(coreTimer);
      if (modelLogTimer) clearTimeout(modelLogTimer);
    };
  }, [isActive, fetchJobs, fetchModelLogMeta, fetchSystemInfo]);

  useEffect(() => {
    const timer = setInterval(() => {
      setNowSeconds(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const activeIds = new Set(jobs.map((job) => job.job_id));
    const nextState: Record<string, JobEtaState> = {};
    for (const [jobId, state] of Object.entries(etaStateRef.current)) {
      if (activeIds.has(jobId)) {
        nextState[jobId] = state;
      }
    }
    etaStateRef.current = nextState;
  }, [jobs]);

  const formatUptime = (seconds: number): string => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return tr(`${days}д ${hours}ч ${minutes}м`, `${days}d ${hours}h ${minutes}m`);
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

  const serviceStatusBadge = (status: RuntimeServiceStatus): string => {
    if (status === "online") return "bg-emerald-100 text-emerald-700";
    if (status === "starting") return "bg-blue-100 text-blue-700";
    return "bg-rose-100 text-rose-700";
  };

  const getServiceStatusLabel = (status: RuntimeServiceStatus): string => {
    if (status === "online") return tr("онлайн", "online");
    if (status === "starting") return tr("запуск", "starting");
    return tr("офлайн", "offline");
  };

  const getServiceUiStatus = (
    serviceKey: ModelServiceKey,
    serviceData: RuntimeServiceData | undefined
  ): RuntimeServiceStatus => {
    if (serviceData?.reachable) {
      return "online";
    }
    const statusRaw = String(serviceData?.status || "").toLowerCase();
    if (statusRaw === "starting" || statusRaw === "initializing" || statusRaw === "loading") {
      return "starting";
    }
    const meta = modelLogMeta[serviceKey];
    if (meta?.exists) {
      const updatedAtMs = meta.updated_at ? Date.parse(meta.updated_at) : NaN;
      const ageMs = Number.isFinite(updatedAtMs) ? Date.now() - updatedAtMs : Number.POSITIVE_INFINITY;
      if (ageMs <= 20 * 60 * 1000) {
        return "starting";
      }
    }
    return "offline";
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
      return tr("Отмена", "Cancelling");
    }
    switch (status) {
      case "running":
        return tr("В работе", "Running");
      case "success":
        return tr("Успех", "Success");
      case "error":
        return tr("Ошибка", "Error");
      case "cancelled":
        return tr("Отменено", "Cancelled");
      default:
        return status;
    }
  };

  const getJobErrorLog = useCallback((job: Job): string => {
    if (!Array.isArray(job.errors) || job.errors.length === 0) {
      return tr("Детали ошибок отсутствуют.", "No error details available.");
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
  }, [tr]);

  const getJobMainLog = useCallback((job: Job): string => {
    const lines = Array.isArray(job.job_log) ? job.job_log : [];
    if (lines.length === 0) {
      return tr("Лог джобы отсутствует.", "No job log available.");
    }
    return lines.join("\n");
  }, [tr]);

  const formatDate = (timestamp: number): string => {
    return new Date(timestamp * 1000).toLocaleString(dateLocale);
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
      return tr(
        `${hours}ч ${String(minutes).padStart(2, "0")}м ${String(secs).padStart(2, "0")}с`,
        `${hours}h ${String(minutes).padStart(2, "0")}m ${String(secs).padStart(2, "0")}s`
      );
    }
    return tr(
      `${minutes}м ${String(secs).padStart(2, "0")}с`,
      `${minutes}m ${String(secs).padStart(2, "0")}s`
    );
  };

  const getEtaCounters = (job: Job): EtaCounters => {
    const tasksPlanned = Math.max(0, Number(job.total_tasks_planned ?? 0));
    const tasksCompleted = Math.max(0, Number(job.total_tasks_completed ?? 0));
    if (tasksPlanned > 0) {
      return {
        completed: Math.min(tasksCompleted, tasksPlanned),
        total: tasksPlanned,
      };
    }

    const plannedTotalRaw = job.total_planned ?? job.total_limit ?? 0;
    const plannedTotal = Math.max(0, Number(plannedTotalRaw));
    const completed = Math.max(
      0,
      Math.min(Number(job.total_seen ?? 0), plannedTotal || Number.MAX_SAFE_INTEGER)
    );
    return { completed, total: plannedTotal };
  };

  const getJobTiming = (job: Job): { elapsed: string; eta: string } => {
    const start = Math.max(0, job.created_at || 0);
    const end = job.status === "running" ? nowSeconds : Math.max(start, job.updated_at || start);
    const elapsedSec = Math.max(0, end - start);
    const { completed, total } = getEtaCounters(job);
    const remaining = Math.max(0, total - completed);

    const prevState = etaStateRef.current[job.job_id];
    const needsReset =
      !prevState ||
      prevState.total !== total ||
      completed < prevState.completed ||
      job.status !== "running";

    if (needsReset) {
      etaStateRef.current[job.job_id] = {
        total,
        completed,
        lastObservedAt: nowSeconds,
        lastProgressAt: nowSeconds,
        smoothedSecPerUnit:
          completed > 0 && elapsedSec > 0 ? elapsedSec / completed : null,
        lastEtaSec: null,
      };
    }

    const state = etaStateRef.current[job.job_id];
    let hadProgress = false;
    let etaSec: number | null = null;
    if (job.status === "running" && total > 0 && remaining > 0) {
      if (completed > state.completed) {
        hadProgress = true;
        const deltaUnits = completed - state.completed;
        const deltaTime = Math.max(1, nowSeconds - state.lastProgressAt);
        const instantSecPerUnit = deltaTime / deltaUnits;
        const alpha = 0.35;
        state.smoothedSecPerUnit =
          state.smoothedSecPerUnit == null
            ? instantSecPerUnit
            : alpha * instantSecPerUnit + (1 - alpha) * state.smoothedSecPerUnit;
        state.completed = completed;
        state.lastProgressAt = nowSeconds;
      }
      state.lastObservedAt = nowSeconds;
      state.total = total;

      if (state.smoothedSecPerUnit != null && Number.isFinite(state.smoothedSecPerUnit)) {
        etaSec = Math.max(1, Math.ceil(remaining * state.smoothedSecPerUnit));
      } else if (completed > 0 && elapsedSec > 0) {
        etaSec = Math.max(1, Math.ceil((remaining * elapsedSec) / completed));
      } else {
        etaSec = null;
      }

      if (!hadProgress && state.lastEtaSec != null && etaSec != null) {
        // Do not inflate ETA while waiting for the next completed unit.
        etaSec = Math.min(etaSec, state.lastEtaSec);
      }
      state.lastEtaSec = etaSec;
    } else {
      state.lastEtaSec = null;
    }

    return {
      elapsed: formatDuration(elapsedSec),
      eta:
        job.status === "running"
          ? etaSec && etaSec > 0
            ? formatDuration(etaSec)
            : "—"
          : "—",
    };
  };

  const getSceneTaskGradient = (paletteIndex: number): string => {
    const hue = (paletteIndex * 47) % 360;
    const nextHue = (hue + 52) % 360;
    return `linear-gradient(90deg, hsl(${hue} 75% 52%), hsl(${nextHue} 82% 58%))`;
  };

  const getStableSceneTaskGradient = (jobId: string, progressPercent: number): string => {
    const clamped = Math.max(0, Math.min(100, Number(progressPercent) || 0));
    const state = sceneBarColorStateRef.current[jobId];
    if (!state) {
      sceneBarColorStateRef.current[jobId] = {
        paletteIndex: 0,
        lastProgress: clamped,
      };
      return getSceneTaskGradient(0);
    }

    const didResetToNewCycle = state.lastProgress > 0 && clamped <= 0.1;
    if (didResetToNewCycle) {
      state.paletteIndex += 1;
    }
    state.lastProgress = clamped;
    return getSceneTaskGradient(state.paletteIndex);
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
        err instanceof Error ? err.message : tr("Не удалось отменить джобу", "Failed to cancel job");
      alert(`${tr("Ошибка", "Error")}: ${message}`);
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
              : tr("Не удалось перезапустить джобу", "Failed to retry job");
      alert(`${tr("Ошибка", "Error")}: ${message}`);
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
      return tr(
        "Выберите, что сделать с уже загруженными этой джобой данными.",
        "Choose what to do with data already downloaded by this job."
      );
    }
    if (jobType === "backfill_vlm") {
      return tr(
        "Выберите, что сделать с уже размеченными этой джобой сценами.",
        "Choose what to do with scenes already annotated by this job."
      );
    }
    if (jobType === "backfill_embeddings") {
      return tr(
        "Выберите, что сделать с уже созданными этой джобой эмбеддингами.",
        "Choose what to do with embeddings already created by this job."
      );
    }
    return tr("Подтвердите остановку джобы.", "Confirm stopping the job.");
  };

  const getCancelKeepLabel = (jobType: string): string => {
    if (jobType === "backfill_vlm") {
      return tr("Остановить и сохранить разметку", "Stop and keep annotations");
    }
    if (jobType === "backfill_embeddings") {
      return tr("Остановить и сохранить эмбеддинги", "Stop and keep embeddings");
    }
    return tr("Остановить и сохранить", "Stop and keep");
  };

  const getCancelDeleteLabel = (jobType: string): string => {
    if (jobType === "backfill_vlm") {
      return tr("Остановить и удалить разметку", "Stop and delete annotations");
    }
    if (jobType === "backfill_embeddings") {
      return tr("Остановить и удалить эмбеддинги", "Stop and delete embeddings");
    }
    return tr("Остановить и удалить", "Stop and delete");
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

  const fetchWaymoAuthLink = useCallback(async () => {
    try {
      setWaymoAuthBusy(true);
      setWaymoAuthError(null);
      const response = await axios.post<WaymoAuthStartResponse>("/api/waymo/auth/start", {});
      const payload = response.data || {};
      const sessionId = String(payload.session_id || "").trim();
      const authUrl = String(payload.auth_url || "").trim();
      if (!sessionId) {
        throw new Error(
          tr(
            "Не удалось создать сессию авторизации Waymo.",
            "Failed to create a Waymo auth session."
          )
        );
      }
      setWaymoAuthSessionId(sessionId);
      setWaymoAuthUrl(authUrl || null);
      if (!authUrl) {
        setWaymoAuthError(
          tr(
            "Ссылка авторизации пока не получена. Нажмите «Обновить ссылку» через несколько секунд.",
            "The auth link is not ready yet. Click Refresh link in a few seconds."
          )
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
              : tr("Не удалось запустить авторизацию Waymo.", "Failed to start Waymo auth.");
      setWaymoAuthError(serverMessage);
    } finally {
      setWaymoAuthBusy(false);
    }
  }, [tr]);

  const submitWaymoAuthCode = async () => {
    if (!waymoAuthSessionId) {
      setWaymoAuthError(tr("Сначала получите ссылку авторизации.", "Get the auth link first."));
      return;
    }
    const code = waymoAuthCode.trim();
    if (!code) {
      setWaymoAuthError(tr("Введите код авторизации.", "Enter the auth code."));
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
        message ||
          tr(
            "Авторизация Google ADC выполнена. Повторите установку Waymo.",
            "Google ADC authorization completed. Retry Waymo installation."
          )
      );
      setWaymoAuthModalOpen(false);
      setWaymoAuthCode("");
      await fetchJobs();
    } catch (err) {
      const detail = axios.isAxiosError(err) ? err.response?.data?.detail : null;
      if (detail && typeof detail === "object" && Array.isArray(detail.logs_tail)) {
        setWaymoAuthError(
          `${String(detail.message || tr("Ошибка авторизации", "Authorization error"))}\n\n${detail.logs_tail.join("\n")}`
        );
      } else if (typeof detail === "string") {
        setWaymoAuthError(detail);
      } else {
        const message =
          err instanceof Error
            ? err.message
            : tr("Не удалось завершить авторизацию.", "Failed to complete authorization.");
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
  }, [waymoAuthModalOpen, waymoAuthSessionId, waymoAuthBusy, fetchWaymoAuthLink]);

  useEffect(() => {
    if (!logViewer?.jobId || !logViewer.source || logViewer.source === "model") {
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
    if (logViewer?.source !== "model" || !logViewer.modelService) {
      return;
    }

    let active = true;
    const service = logViewer.modelService;
    const loadLogs = async () => {
      try {
        const response = await axios.get("/api/model-logs", {
          params: { service, tail: 1200 },
        });
        const updatedAtRaw = String(response.data?.updated_at || "").trim();
        const updatedAtLabel = updatedAtRaw
          ? new Date(updatedAtRaw).toLocaleTimeString(dateLocale)
          : "—";
        const content =
          typeof response.data?.content === "string" && response.data.content.trim()
            ? response.data.content
            : tr("Пока нет startup-логов.", "No startup logs yet.");
        if (!active) {
          return;
        }
        setLogViewer((current) => {
          if (!current || current.source !== "model" || current.modelService !== service) {
            return current;
          }
          return {
            ...current,
            title: tr(
              `${service.toUpperCase()} startup-логи (обновлено ${updatedAtLabel})`,
              `${service.toUpperCase()} startup logs (updated ${updatedAtLabel})`
            ),
            content,
          };
        });
      } catch (err) {
        if (!active) {
          return;
        }
        const message = err instanceof Error ? err.message : tr("Не удалось загрузить model logs", "Failed to load model logs");
        setLogViewer((current) => {
          if (!current || current.source !== "model" || current.modelService !== service) {
            return current;
          }
          return {
            ...current,
            content: tr(
              `Не удалось загрузить логи: ${message}`,
              `Failed to load logs: ${message}`
            ),
          };
        });
      }
    };

    loadLogs();
    const interval = setInterval(loadLogs, 2500);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [logViewer?.source, logViewer?.modelService, dateLocale, tr]);

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
        <div className="text-gray-500">
          {tr("Загрузка информации о системе...", "Loading system information...")}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-red-600">{tr("Ошибка", "Error")}: {error}</div>
      </div>
    );
  }

  if (!systemInfo) {
    return null;
  }

  const serviceEntries: Array<{ key: ModelServiceKey; label: string; data: RuntimeServiceData | undefined }> = [
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
          <h2 className="text-2xl font-bold text-gray-900">
            {tr("Мониторинг системы", "System Monitor")}
          </h2>
          <button
            onClick={fetchSystemInfo}
            className="px-4 py-2 bg-blue-600 text-white font-bold rounded-lg hover:bg-blue-700 transition-colors"
          >
            {tr("Обновить", "Refresh")}
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="flex justify-between items-center mb-2">
              <h3 className="text-lg font-semibold text-gray-700">{tr("Процессор (CPU)", "CPU")}</h3>
              <span className="text-sm text-gray-500">
                {systemInfo.cpu.cores} {tr("ядер", "cores")}
              </span>
            </div>
            <div className="mb-2">
              <div className="flex justify-between text-sm mb-1">
                <span className="text-gray-600">{tr("Использование", "Usage")}</span>
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

          <div className="bg-gray-50 rounded-lg p-4">
            <div className="flex justify-between items-center mb-2">
              <h3 className="text-lg font-semibold text-gray-700">{tr("Память (RAM)", "Memory (RAM)")}</h3>
              <span className="text-sm text-gray-500">
                {systemInfo.memory.total_gb.toFixed(1)} GB
              </span>
            </div>
            <div className="mb-2">
              <div className="flex justify-between text-sm mb-1">
                <span className="text-gray-600">{tr("Использовано", "Used")}</span>
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
              {tr("Доступно", "Available")}: {systemInfo.memory.available_gb.toFixed(1)} GB
            </div>
          </div>

          <div className="bg-gray-50 rounded-lg p-4">
            <div className="flex justify-between items-center mb-2">
              <h3 className="text-lg font-semibold text-gray-700">{tr("Диск", "Disk")}</h3>
              <span className="text-sm text-gray-500">
                {systemInfo.disk.total_gb.toFixed(1)} GB
              </span>
            </div>
            <div className="mb-2">
              <div className="flex justify-between text-sm mb-1">
                <span className="text-gray-600">{tr("Использовано", "Used")}</span>
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
              {tr("Доступно", "Available")}: {systemInfo.disk.available_gb.toFixed(1)} GB
            </div>
          </div>

          <div className="bg-gray-50 rounded-lg p-4">
            <div className="flex justify-between items-center mb-2">
              <h3 className="text-lg font-semibold text-gray-700">{tr("Время работы", "Uptime")}</h3>
            </div>
            <div className="text-2xl font-bold text-gray-900">
              {formatUptime(systemInfo.uptime_seconds)}
            </div>
            <div className="text-xs text-gray-500 mt-2">
              {tr("Последнее обновление", "Last update")}:{" "}
              {new Date(systemInfo.timestamp).toLocaleString(dateLocale)}
            </div>
          </div>
        </div>

        {(showModelsPanel || showGpuPanel) && (
          <>
            {showModelsPanel && (
              <div className="mt-6">
                <h3 className="text-lg font-semibold text-gray-800 mb-3">
                  {tr("Модели и устройства", "Models and devices")}
                </h3>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {serviceEntries.map((service) => {
                    const runtime = service.data?.runtime ?? {};
                    const memory = service.data?.memory ?? {};
                    const uiStatus = getServiceUiStatus(service.key, service.data);
                    const canOpenStartupLogs =
                      uiStatus === "starting" || Boolean(modelLogMeta[service.key]?.exists);
                    const selectedDevice =
                      String(runtime.selected_device || service.data?.device || "unknown");
                    return (
                      <div key={service.key} className="bg-slate-50 rounded-lg border border-slate-200 p-4">
                        <div className="flex items-center justify-between">
                          <h4 className="text-base font-semibold text-slate-800">{service.label}</h4>
                          <button
                            type="button"
                            onClick={() =>
                              setLogViewer({
                                title: tr(
                                  `${service.label} startup-логи`,
                                  `${service.label} startup logs`
                                ),
                                content: tr("Загрузка startup-логов...", "Loading startup logs..."),
                                source: "model",
                                modelService: service.key,
                              })
                            }
                            className={`rounded-full px-2 py-0.5 text-xs font-semibold transition hover:opacity-90 ${
                              serviceStatusBadge(uiStatus)
                            } ${canOpenStartupLogs ? "underline decoration-current underline-offset-2" : "cursor-default"}`}
                            disabled={!canOpenStartupLogs}
                            title={
                              canOpenStartupLogs
                                ? tr("Открыть startup-логи", "Open startup logs")
                                : tr("Startup-логи пока недоступны", "No startup logs available yet")
                            }
                          >
                            {getServiceStatusLabel(uiStatus)}
                          </button>
                        </div>
                        <div className="mt-2 space-y-1 text-sm text-slate-700">
                          <div>
                            <span className="text-slate-500">{tr("Модель", "Model")}: </span>
                            <span className="font-medium">{service.data?.model || "—"}</span>
                          </div>
                          <div>
                            <span className="text-slate-500">{tr("Endpoint", "Endpoint")}: </span>
                            <span className="font-mono text-xs">{service.data?.endpoint || "—"}</span>
                          </div>
                          <div>
                            <span className="text-slate-500">{tr("Устройство", "Device")}: </span>
                            <span className="font-semibold">{selectedDevice}</span>
                            {runtime.cuda_device_name ? (
                              <span className="text-xs text-slate-500">{` (${runtime.cuda_device_name})`}</span>
                            ) : null}
                          </div>
                          <div>
                            <span className="text-slate-500">{tr("Конфиг", "Config")}: </span>
                            <span>{String(runtime.configured_device || "—")}</span>
                            {runtime.dtype ? (
                              <span className="text-xs text-slate-500">{` · dtype=${runtime.dtype}`}</span>
                            ) : null}
                            {runtime.attn_type ? (
                              <span className="text-xs text-slate-500">{` · attn=${runtime.attn_type}`}</span>
                            ) : null}
                          </div>
                          <div>
                            <span className="text-slate-500">{tr("RAM процесса", "Process RAM")}: </span>
                            <span>{formatMb(memory.process_rss_mb)}</span>
                          </div>
                          <div>
                            <span className="text-slate-500">{tr("GPU память", "GPU memory")}: </span>
                            <span>
                              {tr(
                                `${formatMb(memory.gpu_allocated_mb)} выделено / ${formatMb(
                                  memory.gpu_reserved_mb
                                )} зарезервировано`,
                                `${formatMb(memory.gpu_allocated_mb)} alloc / ${formatMb(
                                  memory.gpu_reserved_mb
                                )} reserved`
                              )}
                            </span>
                          </div>
                          {(memory.gpu_total_mb ?? 0) > 0 ? (
                            <div>
                              <span className="text-slate-500">{tr("GPU всего/свободно", "GPU total/free")}: </span>
                              <span>{`${formatMb(memory.gpu_total_mb)} / ${formatMb(
                                memory.gpu_free_mb
                              )}`}</span>
                            </div>
                          ) : null}
                          {service.data?.error ? (
                            uiStatus === "starting" ? null : (
                              <div className="text-xs text-rose-600">{service.data.error}</div>
                            )
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {showGpuPanel && (
              <div className="mt-6">
                <h3 className="text-lg font-semibold text-gray-800 mb-3">{tr("GPU хоста", "Host GPU")}</h3>
                {gpuList.length === 0 ? (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                    {systemInfo.gpu?.error
                      ? tr(
                          `GPU недоступен: ${systemInfo.gpu.error}`,
                          `GPU unavailable: ${systemInfo.gpu.error}`
                        )
                      : tr(
                          "GPU не обнаружен на текущем хосте master-сервиса.",
                          "GPU was not detected on the current master-service host."
                        )}
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
            )}
          </>
        )}
      </div>

      <div className="max-w-[96rem] mx-auto bg-white rounded-lg shadow-lg p-6 mt-6">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl font-bold text-gray-900">
            {tr("Джобы", "Jobs")}
          </h2>
          <div className="flex items-center gap-2">
            <a
              href={grafanaDashboardUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
              title="Open AVSP Grafana dashboard"
            >
              Grafana
            </a>
            <a
              href={grafanaContainerDashboardUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
              title="Open container drilldown dashboard"
            >
              Container Dash
            </a>
            <a
              href={cadvisorContainersUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
              title="Open cAdvisor container list with process tabs"
            >
              Processes
            </a>
          </div>
        </div>
        
        {jobs.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            {tr("Нет запущенных джоб", "No running jobs")}
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
                    {tr("Тип", "Type")}
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    {tr("Прогресс", "Progress")}
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    {tr("Статус", "Status")}
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    {tr("Обработано", "Processed")}
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    {tr("Создано", "Created")}
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    {tr("Время / ETA", "Time / ETA")}
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    {tr("Действия", "Actions")}
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
                  const scenesSavedLabel = tr(
                    `Сцен сохранено: ${job.total_inserted}`,
                    `Scenes saved: ${job.total_inserted}`
                  );
                  const installScenesSavedLabel = tr(
                    `Сцен сохранено: ${job.total_inserted}`,
                    `Scenes saved: ${job.total_inserted}`
                  );
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
                      : tr("Embedding: ожидание скачанных сцен", "Embedding: waiting for downloaded scenes");
                  const currentSceneTasksCompleted = job.current_scene_tasks_completed ?? 0;
                  const currentSceneTasksTotal = job.current_scene_tasks_total ?? 0;
                  const isApiBatchVlmJob =
                    job.job_type === "backfill_vlm" &&
                    Boolean(job.job_config?.use_openai_batch_api) &&
                    Boolean(job.job_config?.combine_fields_into_json);
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
                    : isApiBatchVlmJob
                      ? `Batch items: ${currentSceneTasksCompleted} / ${currentSceneTasksTotal}`
                      : `Schema fields: ${currentSceneTasksCompleted} / ${currentSceneTasksTotal}`;
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
                    : getStableSceneTaskGradient(job.job_id, currentSceneProgress);
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
                                    : tr(
                                        `Вставлено: ${job.total_inserted}`,
                                        `Inserted: ${job.total_inserted}`
                                      )}
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
                              {tr(
                                `Эмбеддингов сохранено: ${job.total_embeddings_inserted ?? 0}`,
                                `Embeddings saved: ${job.total_embeddings_inserted ?? 0}`
                              )}
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
                              {cancellingJobId === job.job_id
                                ? tr("Отмена...", "Cancelling...")
                                : tr("Отменить", "Cancel")}
                            </button>
                          ) : isCancellableJobType && job.status === "cancelled" ? (
                            <span className="text-gray-500 font-medium">{tr("Отменено", "Cancelled")}</span>
                          ) : isCancellableJobType &&
                            job.status === "running" &&
                            job.cancel_requested ? (
                            <span className="text-red-600 font-medium">{tr("Остановка...", "Stopping...")}</span>
                          ) : (
                            !canRetryJob && <span className="text-gray-400">-</span>
                          )}

                          {isWaymoAuthPermissionError(job) && (
                            <button
                              type="button"
                              onClick={openWaymoAuthModal}
                              className="rounded-lg border border-indigo-300 px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-50"
                            >
                              {tr("Авторизовать Waymo", "Authorize Waymo")}
                            </button>
                          )}

                          {canRetryJob && (
                            <button
                              type="button"
                              onClick={() => executeRetryJob(job)}
                              disabled={retryingJobId === job.job_id}
                              title={tr("Повторить джобу", "Retry job")}
                              aria-label={tr("Повторить джобу", "Retry job")}
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
                {logViewer.source === "model" ? (
                  <div className="text-xs text-slate-500">
                    {tr("Обновление в реальном времени: каждые 2.5с", "Live refresh: every 2.5s")}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => setLogViewer(null)}
                className="rounded-lg border border-slate-300 px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                {tr("Закрыть", "Close")}
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
                {tr("Закрыть", "Close")}
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
                {tr("Авторизация доступа к Waymo", "Waymo Access Authorization")}
              </div>
              <div className="mt-1 text-xs text-slate-500">
                {tr(
                  "Требуется `gcloud auth application-default login` для чтения датасета.",
                  "`gcloud auth application-default login` is required to read this dataset."
                )}
              </div>
            </div>
            <div className="space-y-4 px-5 py-4">
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                {tr(
                  "1. Откройте ссылку ниже и войдите в Google-аккаунт с доступом к Waymo.",
                  "1. Open the link below and sign in to a Google account with Waymo access."
                )}
                <br />
                {tr(
                  "2. Скопируйте код подтверждения и вставьте его в поле.",
                  "2. Copy the verification code and paste it into the field."
                )}
                <br />
                {tr("3. Нажмите `Подтвердить код`.", "3. Click `Confirm code`.")}
              </div>

              <div>
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {tr("Ссылка авторизации", "Authorization link")}
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
                    {tr(
                      "Ссылка пока не получена. Нажмите «Обновить ссылку».",
                      "Link is not available yet. Click Refresh link."
                    )}
                  </div>
                )}
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {tr("Код подтверждения", "Verification code")}
                </label>
                <input
                  type="text"
                  value={waymoAuthCode}
                  onChange={(event) => setWaymoAuthCode(event.target.value)}
                  placeholder={tr("Вставьте код из Google", "Paste code from Google")}
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
                {tr("Закрыть", "Close")}
              </button>
              <button
                type="button"
                onClick={fetchWaymoAuthLink}
                disabled={waymoAuthBusy}
                className="rounded-lg border border-indigo-300 px-3 py-2 text-sm font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-60"
              >
                {waymoAuthBusy ? tr("Загрузка...", "Loading...") : tr("Обновить ссылку", "Refresh link")}
              </button>
              <button
                type="button"
                onClick={submitWaymoAuthCode}
                disabled={waymoAuthBusy}
                className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
              >
                {waymoAuthBusy ? tr("Проверка...", "Checking...") : tr("Подтвердить код", "Confirm code")}
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
                {tr("Остановить джобу?", "Stop job?")}
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
                {tr("Закрыть", "Close")}
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
                  {tr("Остановить", "Stop")}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
