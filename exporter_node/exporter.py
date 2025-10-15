from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
import nvitop
import psutil
import platform
import os
import logging
from typing import List, Dict, Any, Optional
from datetime import datetime

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

app = FastAPI(
    title="System & GPU Metrics Exporter",
    description="Exposes system CPU, RAM, and NVIDIA GPU metrics.",
    version="1.0.3" # Incremented version for these fixes
)

def get_disk_metrics() -> List[Dict[str, Any]]:
    """Collects disk usage for critical paths and /data-local mounts."""
    disk_entries: List[Dict[str, Any]] = []
    targets: List[Dict[str, str]] = []

    targets.append({"path": "/", "label": "Root (/)"})

    docker_path = "/var/lib/docker"
    if os.path.exists(docker_path):
        targets.append({"path": docker_path, "label": "Docker (/var/lib/docker)"})

    data_local_root = "/data-local"
    data_local_candidates = set()

    try:
        for part in psutil.disk_partitions(all=False):
            mount = part.mountpoint.rstrip("/") or "/"
            if mount.startswith(data_local_root):
                data_local_candidates.add(mount)
    except Exception as e:
        logger.warning(f"Error enumerating disk partitions: {e}", exc_info=True)

    if os.path.exists(data_local_root):
        try:
            for entry in os.listdir(data_local_root):
                candidate_path = os.path.join(data_local_root, entry)
                if os.path.isdir(candidate_path):
                    data_local_candidates.add(os.path.realpath(candidate_path).rstrip("/"))
        except Exception as e:
            logger.warning(f"Error listing directories under {data_local_root}: {e}", exc_info=True)

    for mount in sorted(data_local_candidates):
        display_name = os.path.basename(mount) or mount
        targets.append({"path": mount, "label": f"Data ({mount})" if mount.startswith(data_local_root) else display_name})

    seen_paths = set()
    for target in targets:
        path = target["path"].rstrip("/") or "/"
        label = target["label"]
        if path in seen_paths:
            continue
        seen_paths.add(path)

        if not os.path.exists(path):
            disk_entries.append({
                "path": path,
                "label": label,
                "error": "Path not found"
            })
            continue

        try:
            usage = psutil.disk_usage(path)
            total_gb = round(usage.total / (1024 ** 3), 2)
            used_gb = round(usage.used / (1024 ** 3), 2)
            free_gb = round(usage.free / (1024 ** 3), 2)
            percent_used = round(usage.percent, 2)

            disk_entries.append({
                "path": path,
                "label": label,
                "total_gb": total_gb,
                "used_gb": used_gb,
                "free_gb": free_gb,
                "percent_used": percent_used
            })
        except PermissionError:
            disk_entries.append({
                "path": path,
                "label": label,
                "error": "Permission denied"
            })
        except Exception as e:
            logger.warning(f"Error retrieving disk usage for {path}: {e}", exc_info=True)
            disk_entries.append({
                "path": path,
                "label": label,
                "error": f"Could not retrieve disk usage: {str(e)}"
            })

    return disk_entries

def get_system_metrics() -> Dict[str, Any]:
    """Gathers CPU and System Memory metrics."""
    try:
        cpu_percent = psutil.cpu_percent(interval=0.5)
        virtual_mem = psutil.virtual_memory()
        load_avg_1 = load_avg_5 = load_avg_15 = None
        try:
            load_avg_1, load_avg_5, load_avg_15 = os.getloadavg()
        except (AttributeError, OSError):
            logger.warning("os.getloadavg() not supported on this platform.")
        cpu_logical_count = psutil.cpu_count(logical=True) or os.cpu_count()
        return {
            "cpu_percent": cpu_percent,
            "memory_total_gb": round(virtual_mem.total / (1024**3), 2),
            "memory_used_gb": round(virtual_mem.used / (1024**3), 2),
            "memory_percent": virtual_mem.percent,
            "load_average_1m": round(load_avg_1, 2) if load_avg_1 is not None else None,
            "load_average_5m": round(load_avg_5, 2) if load_avg_5 is not None else None,
            "load_average_15m": round(load_avg_15, 2) if load_avg_15 is not None else None,
            "load_max": cpu_logical_count if cpu_logical_count is not None else None,
            "disks": get_disk_metrics(),
        }
    except Exception as e:
        logger.error(f"Error getting system metrics: {e}", exc_info=True)
        return {
            "cpu_percent": None,
            "memory_total_gb": None,
            "memory_used_gb": None,
            "memory_percent": None,
            "load_average_1m": None,
            "load_average_5m": None,
            "load_average_15m": None,
            "load_max": None,
            "disks": [],
            "error": f"Could not retrieve system metrics: {str(e)}"
        }

def get_gpu_metrics() -> List[Dict[str, Any]]:
    """Gathers metrics for all available NVIDIA GPUs."""
    gpu_data_list = []
    try:
        devices = nvitop.Device.all()
        if not devices:
            return [{"message": "No NVIDIA GPUs found or nvitop could not access them."}]

        for i, gpu_device in enumerate(devices): # Renamed to gpu_device to avoid conflict
            processes_info = []
            try:
                # Corrected access: gpu_device.processes() returns a Dict[int, GpuProcess]
                # The values of this dictionary are the GpuProcess instances.
                # We also call GpuProcess.take_snapshots to get enriched Snapshot objects
                # which have more readily available attributes and handle errors/NA values.
                
                # Get the dictionary of GpuProcess objects
                gpu_process_map = gpu_device.processes() 
                
                if gpu_process_map:
                    # Convert GpuProcess objects to Snapshot objects for consistent data access
                    # GpuProcess.take_snapshots() is a class method that takes an iterable of GpuProcess
                    process_snapshots = nvitop.GpuProcess.take_snapshots(gpu_process_map.values(), failsafe=True)

                    for p_snapshot in process_snapshots:
                        # p_snapshot is now a nvitop.Snapshot object for a GpuProcess
                        processes_info.append({
                            "pid": p_snapshot.pid,
                            "username": p_snapshot.username if p_snapshot.username is not None else 'N/A',
                            "command": p_snapshot.command if p_snapshot.command is not None else 'N/A',
                            # gpu_memory_human is already in MiB with "MiB" suffix in snapshot, 
                            # we need raw MiB value. Snapshot stores gpu_memory in bytes.
                            "gpu_memory_used_mib": round(p_snapshot.gpu_memory / (1024**2), 2) if p_snapshot.gpu_memory not in (None, nvitop.NA) else 0,
                            "cpu_percent": p_snapshot.cpu_percent if p_snapshot.cpu_percent not in (None, nvitop.NA) else 0.0,
                        })
                else:
                    logger.info(f"No processes reported by nvitop for GPU {gpu_device.index}")

            except Exception as proc_e:
                log_msg = f"Error retrieving or processing GPU processes for GPU {gpu_device.index}: {proc_e}"
                logger.warning(log_msg, exc_info=True)
                processes_info.append({"error": f"Could not retrieve processes: {str(proc_e)}"})
            
            power_usage_mw = gpu_device.power_usage()
            power_limit_mw = gpu_device.power_limit()

            power_usage_watts = round(power_usage_mw / 1000.0, 2) if power_usage_mw not in (None, nvitop.NA) else None
            power_limit_watts = round(power_limit_mw / 1000.0, 2) if power_limit_mw not in (None, nvitop.NA) else None
            
            utilization_gpu = None
            if gpu_device.utilization_rates() is not None:
                utilization_gpu = gpu_device.utilization_rates().gpu

            gpu_data_list.append({
                "id": gpu_device.index,
                "name": gpu_device.name(),
                "uuid": gpu_device.uuid(),
                "utilization_gpu_percent": utilization_gpu,
                "memory_total_mib": round(gpu_device.memory_total() / (1024**2), 2),
                "memory_used_mib": round(gpu_device.memory_used() / (1024**2), 2),
                "memory_percent": (gpu_device.memory_used() / gpu_device.memory_total()) * 100 if gpu_device.memory_total() > 0 else 0,
                "temperature_celsius": gpu_device.temperature(),
                "power_usage_watts": power_usage_watts,
                "power_limit_watts": power_limit_watts,
                "fan_speed_percent": gpu_device.fan_speed(),
                "processes": processes_info,
            })
    except nvitop.NVMLError as e:
        logger.error(f"NVML Error (NVIDIA drivers/libs issue?): {e}", exc_info=True)
        return [{"error": f"NVIDIA driver/library issue: {str(e)}"}]
    except Exception as e:
        logger.error(f"Error getting GPU metrics: {e}", exc_info=True)
        return [{"error": f"Could not retrieve GPU metrics: {str(e)}"}]
    return gpu_data_list

@app.get("/metrics", response_model=Optional[Dict[str, Any]])
async def read_metrics():
    try:
        hostname = platform.node()
        system_info = get_system_metrics()
        gpu_info = get_gpu_metrics()

        return {
            "hostname": hostname,
            "timestamp_utc": datetime.utcnow().isoformat(),
            "system": system_info,
            "gpus": gpu_info,
        }
    except Exception as e:
        logger.error(f"Critical error in /metrics endpoint: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")

@app.get("/health")
async def health_check():
    """Simple health check endpoint."""
    return {"status": "ok"}

if __name__ == "__main__":
    import uvicorn
    logger.info("Starting exporter with Uvicorn for local testing on http://localhost:8000")
    uvicorn.run(app, host="0.0.0.0", port=8000)