from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
import nvitop
import psutil
import platform
import os
import pwd
import logging
from typing import List, Dict, Any, Optional
from datetime import datetime, timezone
import time
import threading

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Constants
CPU_MEASUREMENT_INTERVAL_SECONDS = 0.0  # Non-blocking
DOCKER_SOCKET_PATH = "/var/run/docker.sock"
# Docker cache settings
DOCKER_CACHE_INTERVAL_SECONDS = int(os.environ.get("DOCKER_METRICS_INTERVAL_SECONDS", 60))

app = FastAPI(
    title="System & GPU Metrics Exporter",
    description="Exposes system CPU, RAM, and NVIDIA GPU metrics.",
    version="1.0.5"
)

# Global variables for caching
_metrics_cache = None
_cache_timestamp = 0
CACHE_TTL_SECONDS = 2.0

# Docker specific cache
_docker_cache: Dict[str, Any] = {"error": "Loading..."}
_docker_lock = threading.Lock()

def get_docker_metrics() -> Dict[str, Any]:
    """Collects Docker statistics using docker CLI."""
    # check if docker socket exists first to avoid unnecessary subprocess calls
    if not os.path.exists(DOCKER_SOCKET_PATH):
         return {"error": "Docker socket not found"}

    try:
        import subprocess
        import json
        
        # 1. Containers
        # docker container ls -a --format '{{json .}}'
        cmd_containers = ["docker", "container", "ls", "-a", "--format", "{{json .}}"]
        output_containers = subprocess.check_output(cmd_containers, stderr=subprocess.STDOUT).decode('utf-8')
        containers = []
        running_count = 0
        
        for line in output_containers.strip().split('\n'):
            if line:
                try:
                    c = json.loads(line)
                    containers.append(c)
                    # Robust check for running status
                    state = c.get('State', '').lower()
                    status = c.get('Status', '').lower()
                    if state == 'running' or status.startswith('up'):
                        running_count += 1
                except json.JSONDecodeError:
                    pass
        
        # 2. Images
        # docker image ls --format '{{json .}}'
        cmd_images = ["docker", "image", "ls", "--format", "{{json .}}"]
        output_images = subprocess.check_output(cmd_images, stderr=subprocess.STDOUT).decode('utf-8')
        images = []
        for line in output_images.strip().split('\n'):
             if line:
                try:
                    images.append(json.loads(line))
                except json.JSONDecodeError:
                    pass

        # 3. Disk Usage Summary (Build Cache etc)
        # docker system df --format '{{json .}}'
        cmd_df = ["docker", "system", "df", "--format", "{{json .}}"]
        output_df = subprocess.check_output(cmd_df, stderr=subprocess.STDOUT).decode('utf-8')
        # Output is one JSON object per line: Images, Containers, Local Volumes, Build Cache
        df_summary = {}
        for line in output_df.strip().split('\n'):
             if line:
                try:
                    data = json.loads(line)
                    if "Type" in data:
                        df_summary[data["Type"]] = data
                except json.JSONDecodeError:
                    pass
        
        # OVERRIDE: Manually inject the accurate running count into the summary
        # If 'Containers' key missing, create it.
        if "Containers" not in df_summary:
            df_summary["Containers"] = {"TotalCount": len(containers), "Running": running_count, "Size": "0B"}
        else:
            df_summary["Containers"]["Running"] = running_count
            df_summary["Containers"]["TotalCount"] = len(containers)


        return {
            "containers": containers,
            "images": images,
            "summary": df_summary
        }

    except FileNotFoundError:
        return {"error": "docker CLI not found"}
    except subprocess.CalledProcessError as e:
        logger.warning("Error running docker command: %s", e.output)
        return {"error": f"Docker command failed: {e.output.decode('utf-8', errors='ignore')}"}
    except Exception as e:
        logger.warning("Error collecting docker metrics: %s", e, exc_info=True)
        return {"error": str(e)}

def _docker_collector_thread():
    """Background thread to collect Docker metrics periodically."""
    global _docker_cache
    logger.info(f"Starting Docker metrics collector (Interval: {DOCKER_CACHE_INTERVAL_SECONDS}s)")
    
    while True:
        try:
            start_time = time.time()
            data = get_docker_metrics()
            
            with _docker_lock:
                _docker_cache = data
            
            elapsed = time.time() - start_time
            logger.debug(f"Docker metrics collected in {elapsed:.2f}s")
            
            # Sleep remainder of interval
            sleep_time = max(1.0, DOCKER_CACHE_INTERVAL_SECONDS - elapsed)
            time.sleep(sleep_time)
            
        except Exception as e:
            logger.error(f"Error in Docker collector thread: {e}", exc_info=True)
            time.sleep(10) # Error backoff

@app.on_event("startup")
async def startup_event():
    # Start the background thread
    t = threading.Thread(target=_docker_collector_thread, daemon=True)
    t.start()

def get_disk_metrics() -> List[Dict[str, Any]]:
    """Collects disk usage for critical paths and /data-local mounts."""
    disk_entries: List[Dict[str, Any]] = []
    targets: Dict[str, str] = {}  # path -> label mapping

    # Root is always tracked
    targets["/"] = "Root (/)"

    # Docker path if it exists
    docker_path = "/var/lib/docker"
    if os.path.exists(docker_path):
        targets[docker_path] = "Docker (/var/lib/docker)"

    # Collect /data-local mount points
    data_local_root = "/data-local"
    data_local_candidates = set()

    try:
        for part in psutil.disk_partitions(all=False):
            mount = part.mountpoint.rstrip("/") or "/"
            if mount.startswith(data_local_root):
                data_local_candidates.add(mount)
    except Exception as e:
        logger.warning("Error enumerating disk partitions: %s", e, exc_info=True)

    if os.path.exists(data_local_root):
        try:
            for entry in os.listdir(data_local_root):
                candidate_path = os.path.join(data_local_root, entry)
                if os.path.isdir(candidate_path):
                    data_local_candidates.add(os.path.realpath(candidate_path).rstrip("/"))
        except Exception as e:
            logger.warning("Error listing directories under %s: %s", data_local_root, e, exc_info=True)

    # Add data-local paths to targets
    for mount in sorted(data_local_candidates):
        normalized = mount.rstrip("/") or "/"
        display_name = os.path.basename(mount) or mount
        label = f"Data ({mount})" if mount.startswith(data_local_root) else display_name
        targets[normalized] = label

    # Process all unique targets
    for path, label in targets.items():
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
        except (PermissionError, OSError) as e:
            disk_entries.append({
                "path": path,
                "label": label,
                "error": f"Access denied: {type(e).__name__}"
            })
        except Exception as e:
            logger.warning("Error retrieving disk usage for %s: %s", path, e, exc_info=True)
            disk_entries.append({
                "path": path,
                "label": label,
                "error": f"Could not retrieve disk usage: {str(e)}"
            })

    return disk_entries

def get_system_metrics() -> Dict[str, Any]:
    """Gathers CPU and System Memory metrics."""
    try:
        cpu_percent = psutil.cpu_percent(interval=CPU_MEASUREMENT_INTERVAL_SECONDS)
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
            "load_max": cpu_logical_count if cpu_logical_count is not None else None,
            "disks": get_disk_metrics(),
            "users": [
                {
                    "name": u.name,
                    "terminal": u.terminal or "N/A",
                    "host": u.host or "N/A",
                    "started": u.started
                } for u in psutil.users()
            ],
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

        for gpu_device in devices:
            processes_info = []
            try:
                # Get the dictionary of GpuProcess objects
                gpu_process_map = gpu_device.processes()
                
                if gpu_process_map:
                    # Convert GpuProcess objects to Snapshot objects for consistent data access
                    process_snapshots = nvitop.GpuProcess.take_snapshots(
                        gpu_process_map.values(), failsafe=True
                    )

                    for p_snapshot in process_snapshots:
                        processes_info.append({
                            "pid": p_snapshot.pid,
                            "username": p_snapshot.username if p_snapshot.username is not None else 'N/A',
                            "command": p_snapshot.command if p_snapshot.command is not None else 'N/A',
                            "gpu_memory_used_mib": round(p_snapshot.gpu_memory / (1024**2), 2) 
                                if p_snapshot.gpu_memory not in (None, nvitop.NA) else 0,
                            "cpu_percent": p_snapshot.cpu_percent 
                                if p_snapshot.cpu_percent not in (None, nvitop.NA) else 0.0,
                        })
                else:
                    logger.info("No processes reported by nvitop for GPU %s", gpu_device.index)

            except Exception as proc_e:
                logger.warning(
                    "Error retrieving or processing GPU processes for GPU %s: %s",
                    gpu_device.index, proc_e, exc_info=True
                )
                processes_info.append({"error": f"Could not retrieve processes: {str(proc_e)}"})
            
            # Get GPU metrics - each call is a separate NVML query
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
                "memory_percent": (gpu_device.memory_used() / gpu_device.memory_total()) * 100 
                    if gpu_device.memory_total() > 0 else 0,
                "temperature_celsius": gpu_device.temperature(),
                "power_usage_watts": power_usage_watts,
                "power_limit_watts": power_limit_watts,
                "fan_speed_percent": gpu_device.fan_speed(),
                "processes": processes_info,
            })
    except nvitop.NVMLError as e:
        logger.error("NVML Error (NVIDIA drivers/libs issue?): %s", e, exc_info=True)
        return [{"error": f"NVIDIA driver/library issue: {str(e)}"}]
    except Exception as e:
        logger.error("Error getting GPU metrics: %s", e, exc_info=True)
        return [{"error": f"Could not retrieve GPU metrics: {str(e)}"}]
    return gpu_data_list


@app.get("/users", response_model=Dict[str, List[Dict[str, Any]]])
async def get_users():
    """Returns a list of users (UID >= 1000 or root)."""
    try:
        users = []
        for p in pwd.getpwall():
            if p.pw_uid >= 1000 or p.pw_uid == 0:
                users.append({
                    "username": p.pw_name,
                    "uid": p.pw_uid,
                    "gid": p.pw_gid
                })
        return {"users": users}
    except Exception as e:
        logger.error(f"Error getting system users: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


@app.get("/metrics", response_model=Optional[Dict[str, Any]])
async def read_metrics():
    global _metrics_cache, _cache_timestamp
    
    now = time.time()
    if _metrics_cache and (now - _cache_timestamp) < CACHE_TTL_SECONDS:
        logger.debug("Serving cached metrics")
        return _metrics_cache

    try:
        hostname = platform.node()
        system_info = get_system_metrics()
        gpu_info = get_gpu_metrics()
        
        # Use simple global caching for Docker to prevent blocking
        with _docker_lock:
             docker_info = _docker_cache

        result = {
            "hostname": hostname,
            "timestamp_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "system": system_info,
            "gpus": gpu_info,
            "docker": docker_info,
        }
        
        _metrics_cache = result
        _cache_timestamp = now
        return result
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