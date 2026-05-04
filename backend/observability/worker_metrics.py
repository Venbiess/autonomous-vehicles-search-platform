from __future__ import annotations

import os
import threading
import time
from typing import Optional

from prometheus_client import Counter, Gauge, Histogram, start_http_server

try:
    import pynvml  # type: ignore
except Exception:  # noqa: BLE001
    pynvml = None


jobs_total = Counter(
    "avsp_worker_jobs_total",
    "Total worker jobs processed.",
    ["worker", "task", "status"],
)

job_duration_seconds = Histogram(
    "avsp_worker_job_duration_seconds",
    "Worker job execution duration in seconds.",
    ["worker", "task"],
    buckets=(0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300),
)

gpu_available = Gauge(
    "avsp_worker_gpu_available",
    "Whether GPU metrics are available for this worker process.",
    ["worker"],
)

gpu_device_utilization_percent = Gauge(
    "avsp_worker_gpu_device_utilization_percent",
    "GPU device utilization percent visible to the worker.",
    ["worker"],
)

gpu_memory_total_bytes = Gauge(
    "avsp_worker_gpu_memory_total_bytes",
    "Total GPU memory in bytes for the selected device.",
    ["worker"],
)

gpu_memory_used_bytes = Gauge(
    "avsp_worker_gpu_memory_used_bytes",
    "GPU memory in bytes used by this worker process.",
    ["worker"],
)

gpu_process_count = Gauge(
    "avsp_worker_gpu_process_count",
    "Number of GPU compute processes visible on the selected device.",
    ["worker"],
)

_metrics_started = False
_metrics_lock = threading.Lock()


def start_metrics_server(worker_name: str) -> None:
    global _metrics_started
    with _metrics_lock:
        if _metrics_started:
            return
        port = int(os.getenv("WORKER_METRICS_PORT", "9108"))
        bind_addr = os.getenv("WORKER_METRICS_HOST", "0.0.0.0").strip() or "0.0.0.0"
        start_http_server(port, addr=bind_addr)
        gpu_available.labels(worker=worker_name).set(0)
        thread = threading.Thread(
            target=_gpu_metrics_loop,
            args=(worker_name,),
            name=f"{worker_name}-gpu-metrics",
            daemon=True,
        )
        thread.start()
        _metrics_started = True


def observe_job(worker_name: str, task_name: str, status: str, duration_sec: float) -> None:
    jobs_total.labels(worker=worker_name, task=task_name, status=status).inc()
    job_duration_seconds.labels(worker=worker_name, task=task_name).observe(
        max(0.0, duration_sec)
    )


def _gpu_metrics_loop(worker_name: str) -> None:
    poll_interval = float(os.getenv("WORKER_GPU_METRICS_POLL_INTERVAL_SEC", "2.0"))
    handle = _init_nvml_handle()
    if handle is None:
        gpu_available.labels(worker=worker_name).set(0)
        return

    gpu_available.labels(worker=worker_name).set(1)
    pid = os.getpid()

    while True:
        try:
            util = pynvml.nvmlDeviceGetUtilizationRates(handle)
            mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
            proc_mem = 0
            proc_count = 0
            try:
                processes = pynvml.nvmlDeviceGetComputeRunningProcesses(handle)
            except Exception:  # noqa: BLE001
                processes = []
            for proc in processes:
                proc_count += 1
                if int(getattr(proc, "pid", -1)) == pid:
                    proc_mem += int(getattr(proc, "usedGpuMemory", 0) or 0)
            gpu_device_utilization_percent.labels(worker=worker_name).set(
                float(getattr(util, "gpu", 0.0) or 0.0)
            )
            gpu_memory_total_bytes.labels(worker=worker_name).set(
                float(getattr(mem, "total", 0) or 0)
            )
            gpu_memory_used_bytes.labels(worker=worker_name).set(float(proc_mem))
            gpu_process_count.labels(worker=worker_name).set(float(proc_count))
        except Exception:  # noqa: BLE001
            gpu_available.labels(worker=worker_name).set(0)
        time.sleep(max(0.5, poll_interval))


def _init_nvml_handle() -> Optional[object]:
    if pynvml is None:
        return None
    try:
        pynvml.nvmlInit()
        visible = os.getenv("CUDA_VISIBLE_DEVICES", "").strip()
        if visible:
            first = visible.split(",")[0].strip()
            device_index = int(first) if first.isdigit() else 0
        else:
            device_index = 0
        return pynvml.nvmlDeviceGetHandleByIndex(device_index)
    except Exception:  # noqa: BLE001
        return None
