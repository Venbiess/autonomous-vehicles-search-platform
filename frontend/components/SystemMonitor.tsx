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

export default function SystemMonitor() {
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSystemInfo = async () => {
    try {
      setIsLoading(true);
      setError(null);
      const response = await axios.get("/api/system-info");
      setSystemInfo(response.data);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Не удалось загрузить информацию о системе";
      setError(message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchSystemInfo();
    const interval = setInterval(fetchSystemInfo, 5000); // Обновление каждые 5 секунд
    return () => clearInterval(interval);
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
    <div className="max-w-4xl mx-auto py-8">
      <div className="bg-white rounded-lg shadow-lg p-6">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl font-bold text-gray-900">Мониторинг системы</h2>
          <button
            onClick={fetchSystemInfo}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
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
    </div>
  );
}

