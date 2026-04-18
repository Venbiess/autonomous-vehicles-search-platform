"use client";

import { useState, useEffect } from "react";
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
  uptime_seconds: number;
  timestamp: string;
}

interface Job {
  job_id: string;
  job_type: string;
  status: "running" | "success" | "error" | "cancelled";
  cancel_requested?: boolean;
  progress: number;
  total_seen: number;
  total_inserted: number;
  total_limit: number;
  total_planned?: number;
  total_tasks_completed?: number;
  total_tasks_planned?: number;
  current_scene_tasks_completed?: number;
  current_scene_tasks_total?: number;
  current_scene_index?: number;
  errors: Array<{ storage_path?: string; error: string }>;
  created_at: number;
  updated_at: number;
}

export default function SystemMonitor() {
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancellingJobId, setCancellingJobId] = useState<string | null>(null);
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));

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

  const formatDate = (timestamp: number): string => {
    return new Date(timestamp * 1000).toLocaleString("ru-RU");
  };

  const formatJobTypeLabel = (jobType: string): string => {
    if (jobType === "backfill_embeddings") return "Backfill Embeddings";
    if (jobType === "backfill_vlm") return "Backfill VLM";
    if (jobType === "install_waymo") return "Install Waymo";
    if (jobType === "install_argoverse") return "Install Argoverse";
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
  };

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

  const cancelVlmJob = async (jobId: string) => {
    try {
      setCancellingJobId(jobId);
      await axios.post("/api/jobs/cancel", { job_id: jobId });
      await fetchJobs();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Не удалось отменить VLM джобу";
      alert(`Ошибка: ${message}`);
    } finally {
      setCancellingJobId(null);
    }
  };

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

  return (
    <div className="py-8">
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
      </div>

      {/* Таблица джобов */}
      <div className="max-w-7xl mx-auto bg-white rounded-lg shadow-lg p-6 mt-6">
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
                  const progress = job.progress;
                  const canCancelJob =
                    (job.job_type === "backfill_vlm" ||
                      job.job_type === "backfill_embeddings") &&
                    job.status === "running" &&
                    !job.cancel_requested;
                  const isVlmJob = job.job_type === "backfill_vlm";
                  const isWaymoInstallJob = job.job_type === "install_waymo";
                  const plannedTotal = job.total_planned ?? job.total_limit;
                  const progressLabel = `${job.total_seen} / ${plannedTotal}`;
                  const processedLabel = `${job.total_seen} / ${plannedTotal}`;
                  const scenesSavedLabel = `Сцен сохранено: ${job.total_inserted}`;
                  const downloadedFilesLabel = `Скачано файлов: ${job.total_seen}`;
                  const currentSceneTasksCompleted = job.current_scene_tasks_completed ?? 0;
                  const currentSceneTasksTotal = job.current_scene_tasks_total ?? 0;
                  const currentSceneProgress =
                    currentSceneTasksTotal > 0
                      ? Math.min(
                          (currentSceneTasksCompleted / currentSceneTasksTotal) * 100,
                          100
                        )
                      : 0;
                  const currentSceneLabel = `VLM calls: ${currentSceneTasksCompleted} / ${currentSceneTasksTotal}`;
                  const currentSceneIndex = job.current_scene_index ?? 0;
                  const timing = getJobTiming(job);
                  const installFileLabel = `Download: ${formatDataSize(
                    currentSceneTasksCompleted
                  )} / ${formatDataSize(currentSceneTasksTotal)}`;
                  const secondaryProgressLabel = isWaymoInstallJob
                    ? installFileLabel
                    : currentSceneLabel;
                  const secondaryProgressGradient = isWaymoInstallJob
                    ? "linear-gradient(90deg, hsl(200 78% 48%), hsl(160 78% 45%))"
                    : getSceneTaskGradient(currentSceneIndex);
                  const showSecondaryProgress =
                    job.status === "running" &&
                    currentSceneTasksTotal > 0 &&
                    (isVlmJob || isWaymoInstallJob);
                  
                  return (
                    <tr key={job.job_id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {job.job_id.substring(0, 8)}...
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
                              : isWaymoInstallJob
                                ? downloadedFilesLabel
                                : `Вставлено: ${job.total_inserted}`}
                          </div>
                          {showSecondaryProgress && (
                            <div className="mt-3">
                              <div className="flex justify-between text-xs mb-1">
                                <span className="text-gray-600">{secondaryProgressLabel}</span>
                                <span className="font-medium">
                                  {isWaymoInstallJob
                                    ? `File ${Math.min(
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
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`font-semibold ${statusColors.text}`}>
                          {getJobStatusText(job.status, job.cancel_requested)}
                        </span>
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
                        {canCancelJob ? (
                          <button
                            onClick={() => cancelVlmJob(job.job_id)}
                            disabled={cancellingJobId === job.job_id}
                            className={`px-4 py-2 rounded-lg font-semibold transition-all duration-200 ${
                              cancellingJobId === job.job_id
                                ? "bg-red-300 text-white cursor-not-allowed"
                                : "bg-red-600 text-white hover:bg-red-700"
                            }`}
                          >
                            {cancellingJobId === job.job_id ? "Отмена..." : "Отменить"}
                          </button>
                        ) : (job.job_type === "backfill_vlm" ||
                            job.job_type === "backfill_embeddings") &&
                          job.status === "cancelled" ? (
                          <span className="text-gray-500 font-medium">Отменено</span>
                        ) : (job.job_type === "backfill_vlm" ||
                            job.job_type === "backfill_embeddings") &&
                          job.status === "running" &&
                          job.cancel_requested ? (
                          <span className="text-red-600 font-medium">Остановка...</span>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
