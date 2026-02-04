import atexit
import asyncio
import copy
import httpx
import json
import logging
import math
import os
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from flask import Flask, jsonify, render_template, request, has_request_context

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

app = Flask(__name__)

# --- Configuration ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
HOST_CONFIG_PATH = os.path.join(BASE_DIR, "monitored_hosts_config.json")
MONITORED_HOSTS = []

CACHE_REFRESH_SECONDS = float(os.getenv("CACHE_REFRESH_SECONDS", "10"))
CACHE_STALE_AFTER_SECONDS = float(os.getenv("CACHE_STALE_AFTER_SECONDS", "30"))


def _get_env_float(name: str, default: float) -> float:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return float(value)
    except ValueError:
        logger.warning("Invalid float for %s: %s. Using default %.2f", name, value, default)
        return default


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def utc_iso(dt: Optional[datetime]) -> Optional[str]:
    if dt is None:
        return None
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

def load_host_config():
    global MONITORED_HOSTS
    try:
        if os.path.exists(HOST_CONFIG_PATH):
            with open(HOST_CONFIG_PATH, 'r') as f:
                MONITORED_HOSTS = json.load(f)
            logger.info(f"Loaded {len(MONITORED_HOSTS)} hosts from config.")
        else:
            logger.warning(f"Host configuration file not found: {HOST_CONFIG_PATH}. No hosts will be monitored.")
            MONITORED_HOSTS = []
    except Exception as e:
        logger.error(f"Error loading host configuration: {e}", exc_info=True)
        MONITORED_HOSTS = []

load_host_config()


class HostMetricsCache:
    def __init__(
        self,
        refresh_interval: float,
        stale_after: float,
    ) -> None:
        self._lock = threading.Lock()
        self._fetch_lock = threading.Lock()
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._data: List[Dict[str, Any]] = []
        self._last_refresh: Optional[datetime] = None
        self._last_error: Optional[str] = None
        self._refresh_interval = max(1.0, refresh_interval)
        self._base_stale_after = max(self._refresh_interval, stale_after)
        self.stale_after: float = self._base_stale_after

    # --- Thread management -------------------------------------------------
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run_loop, name="HostMetricsCache", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=5)

    # --- Cache access ------------------------------------------------------
    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            data_copy = copy.deepcopy(self._data)
            last_refresh = self._last_refresh
            last_error = self._last_error
            refresh_interval = self._refresh_interval

        stale_seconds: Optional[float] = None
        if last_refresh:
            stale_seconds = max(0.0, (utc_now() - last_refresh).total_seconds())

        return {
            "data": data_copy,
            "last_refresh_utc": utc_iso(last_refresh),
            "stale_for_seconds": stale_seconds,
            "error": last_error,
            "refresh_interval_seconds": refresh_interval,
        }

    def get_data(self, force_refresh: bool = False) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
        if force_refresh or self._is_stale():
            logger.info("Triggering synchronous cache refresh (force=%s)", force_refresh)
            self._refresh_once()

        snapshot_metadata = self.snapshot()
        return snapshot_metadata["data"], snapshot_metadata

    # --- Internal helpers --------------------------------------------------
    @property
    def refresh_interval(self) -> float:
        with self._lock:
            return self._refresh_interval

    def set_refresh_interval(self, seconds: float) -> bool:
        seconds = max(1.0, float(seconds))
        with self._lock:
            if math.isclose(self._refresh_interval, seconds, rel_tol=0.05, abs_tol=0.25):
                return False
            self._refresh_interval = seconds
            self.stale_after = max(self._base_stale_after, seconds)
            logger.debug("HostMetricsCache refresh interval set to %.2fs (stale_after=%.2fs)", seconds, self.stale_after)
            return True

    def _is_stale(self) -> bool:
        with self._lock:
            last_refresh = self._last_refresh
            stale_after = self.stale_after
        
        if last_refresh is None:
            return True
        age = (utc_now() - last_refresh).total_seconds()
        return age >= stale_after

    def _run_loop(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        logger.info(
            "Starting background metrics cache refresh loop (interval=%ss, stale_after=%ss)",
            self.refresh_interval,
            self.stale_after,
        )
        try:
            while not self._stop_event.is_set():
                start_time = time.monotonic()
                try:
                    with self._fetch_lock:
                        data = loop.run_until_complete(fetch_all_hosts_data())
                    self._update_cache(data)
                except Exception as exc:
                    logger.error("Background refresh failed: %s", exc, exc_info=True)
                    with self._lock:
                        self._last_error = str(exc)
                elapsed = time.monotonic() - start_time
                interval = self.refresh_interval
                wait_time = max(1.0, interval - elapsed)
                if self._stop_event.wait(wait_time):
                    break
        finally:
            loop.close()
            logger.info("Background metrics cache loop stopped.")

    def _refresh_once(self) -> None:
        try:
            with self._fetch_lock:
                data = asyncio.run(fetch_all_hosts_data())
            self._update_cache(data)
        except Exception as exc:
            logger.error("Synchronous cache refresh failed: %s", exc, exc_info=True)
            with self._lock:
                self._last_error = str(exc)

    def _update_cache(self, data: List[Dict[str, Any]]) -> None:
        now = utc_now()
        with self._lock:
            # Store data as-is, deep copy only happens in snapshot() for safety
            self._data = data
            self._last_refresh = now
            self._last_error = None


class ClientIntervalTracker:
    def __init__(
        self,
        fallback_interval: float,
        idle_multiplier: float = 3.0,
        min_idle_seconds: float = 30.0,
    ) -> None:
        self._fallback_interval = max(1.0, fallback_interval)
        self._idle_multiplier = max(1.0, idle_multiplier)
        self._min_idle_seconds = max(5.0, min_idle_seconds)
        self._lock = threading.Lock()
        self._clients: Dict[str, Dict[str, Any]] = {}

    def update(self, client_id: str, interval_seconds: float) -> None:
        if not client_id:
            client_id = "unknown"
        try:
            interval = max(1.0, float(interval_seconds))
        except (TypeError, ValueError):
            return

        now = utc_now()
        with self._lock:
            self._clients[client_id] = {
                "interval": interval,
                "last_seen": now,
            }

    def _prune_locked(self, now: datetime) -> None:
        expired: List[str] = []
        for client_id, meta in self._clients.items():
            interval = meta.get("interval", self._fallback_interval)
            last_seen: datetime = meta.get("last_seen", now)
            idle_limit = max(self._min_idle_seconds, interval * self._idle_multiplier)
            if (now - last_seen).total_seconds() > idle_limit:
                expired.append(client_id)
        for client_id in expired:
            self._clients.pop(client_id, None)

    def effective_interval(self) -> float:
        now = utc_now()
        with self._lock:
            self._prune_locked(now)
            if not self._clients:
                return self._fallback_interval
            return min(meta["interval"] for meta in self._clients.values())

    def active_clients(self) -> int:
        now = utc_now()
        with self._lock:
            self._prune_locked(now)
            return len(self._clients)

host_cache = HostMetricsCache(
    refresh_interval=CACHE_REFRESH_SECONDS,
    stale_after=CACHE_STALE_AFTER_SECONDS,
)

client_interval_tracker = ClientIntervalTracker(
    fallback_interval=CACHE_REFRESH_SECONDS,
    idle_multiplier=_get_env_float("CLIENT_INTERVAL_IDLE_MULTIPLIER", 3.0),
    min_idle_seconds=_get_env_float("CLIENT_INTERVAL_MIN_IDLE_SECONDS", 30.0),
)

_cache_started = False
_cache_lock = threading.Lock()


def _start_cache_background() -> None:
    host_cache.start()


def _stop_cache_background() -> None:
    host_cache.stop()


def _ensure_cache_started() -> None:
    global _cache_started
    if _cache_started:
        return
    with _cache_lock:
        if not _cache_started:
            _start_cache_background()
            _cache_started = True


if hasattr(app, "before_serving") and hasattr(app, "after_serving"):
    app.before_serving(_start_cache_background)
    app.after_serving(lambda: _stop_cache_background())
else:
    app.before_request(_ensure_cache_started)
    atexit.register(_stop_cache_background)


async def fetch_single_host_data(client: httpx.AsyncClient, host_config: dict) -> dict:
    url = host_config.get("api_url")
    name = host_config.get("name", url)
    raw_data = {
        "name": name,
        "url": url,
        "hostname": name,
        "timestamp_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "system": {"error": "Not fetched"},
        "gpus": [{"error": "Not fetched"}],
        "error": None,
        "status_code": None,
        "fetch_time_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    }
    try:
        response = await client.get(url, timeout=10.0)
        raw_data["status_code"] = response.status_code
        response.raise_for_status()
        data = response.json()
        raw_data.update(data)
        raw_data["name"] = name
        if "error" in data:
            raw_data["error"] = f"Exporter reported error: {data['error']}"
        # Extract unique usernames for each GPU for the overview
        if "gpus" in raw_data and isinstance(raw_data["gpus"], list):
            for gpu_info in raw_data["gpus"]:
                if isinstance(gpu_info, dict) and "processes" in gpu_info and isinstance(gpu_info["processes"], list):
                    usernames = sorted(list(set(p.get("username", "N/A") for p in gpu_info["processes"] if isinstance(p, dict))))
                    gpu_info["process_usernames"] = usernames if usernames else ["None"]
                elif isinstance(gpu_info, dict):  # Ensure process_usernames key exists
                    gpu_info["process_usernames"] = ["N/A"]

        return raw_data
    except httpx.HTTPStatusError as e:
        logger.warning(f"HTTP error fetching data from {name} ({url}): {e.response.status_code} - {e.response.text[:100]}")
        raw_data["error"] = f"HTTP Error: {e.response.status_code}. Response: {e.response.text[:100]}"
    except httpx.RequestError as e:
        logger.warning(f"Request error fetching data from {name} ({url}): {type(e).__name__}")
        raw_data["error"] = f"Request Error: {type(e).__name__} (Host unreachable or DNS issue?)"
    except json.JSONDecodeError as e:
        logger.warning(f"JSON decode error from {name} ({url}): {e}")
        raw_data["error"] = "Invalid JSON response from exporter."
    except Exception as e:
        logger.error(f"Unexpected error fetching data from {name} ({url}): {e}", exc_info=True)
        raw_data["error"] = f"Unexpected error: {str(e)}"

    if "system" not in raw_data:
        raw_data["system"] = {}
    if "gpus" not in raw_data:
        raw_data["gpus"] = []

    return raw_data


async def fetch_all_hosts_data() -> list:
    if not MONITORED_HOSTS:
        return []

    async with httpx.AsyncClient() as client:
        tasks = [fetch_single_host_data(client, host_conf) for host_conf in MONITORED_HOSTS]
        results = await asyncio.gather(*tasks)
    return results


def _resolve_client_identifier() -> str:
    forwarded_for = request.headers.get("X-Forwarded-For", "") if has_request_context() else ""
    client_address = forwarded_for.split(",")[0].strip() if forwarded_for else (request.remote_addr if has_request_context() else "")
    user_agent = request.headers.get("User-Agent", "") if has_request_context() else ""
    ua_token = user_agent.split()[0] if user_agent else ""
    parts = [part for part in (client_address, ua_token) if part]
    return "|".join(parts) if parts else "unknown"

def _render_dashboard_view(view_name: str):
    template_name = f"{view_name}.html"
    return render_template(
        template_name,
        initial_hosts_config=MONITORED_HOSTS,
        current_view=view_name,
    )


@app.route('/')
def overview_page():
    """Renders the new overview dashboard page."""
    return _render_dashboard_view("overview")


@app.route('/detailed')
def detailed_page():
    """Renders the detailed dashboard page."""
    return _render_dashboard_view("detailed")

@app.route('/docker')
def docker_page():
    """Renders the docker statistics dashboard page."""
    return _render_dashboard_view("docker")

@app.route('/api/data')
def get_all_data_api():
    """API endpoint delivering cached metrics with optional on-demand refresh."""
    if not MONITORED_HOSTS:
        return jsonify({
            "data": [],
            "metadata": {
                "error": "No hosts configured.",
                "last_refresh_utc": None,
                "stale_for_seconds": None,
            },
        })

    force_flag = request.args.get("fresh", "").lower() in {"1", "true", "yes"} or request.args.get("force", "").lower() in {"1", "true", "yes"}

    interval_param = request.args.get("client_interval_seconds")
    if interval_param is None:
        interval_param = request.args.get("clientIntervalSeconds")

    if interval_param is not None:
        client_interval_tracker.update(_resolve_client_identifier(), interval_param)

    effective_interval = client_interval_tracker.effective_interval()
    interval_changed = host_cache.set_refresh_interval(effective_interval)
    if interval_changed:
        logger.info(
            "Adjusted cache refresh interval to %.2fs based on active clients (count=%d)",
            effective_interval,
            client_interval_tracker.active_clients(),
        )

    data, snapshot = host_cache.get_data(force_refresh=force_flag)
    response = {
        "data": data,
        "metadata": {
            "last_refresh_utc": snapshot.get("last_refresh_utc"),
            "stale_for_seconds": snapshot.get("stale_for_seconds"),
            "error": snapshot.get("error"),
            "hosts_count": len(data),
            "served_from": "forced" if force_flag else "cache",
            "cache_refresh_interval_seconds": host_cache.refresh_interval,
            "client_effective_interval_seconds": effective_interval,
            "active_client_count": client_interval_tracker.active_clients(),
        },
    }

    return jsonify(response)

@app.route('/api/config/reload', methods=['POST'])
def reload_config_api():
    logger.info("Received request to reload host configuration.")
    load_host_config()
    # Trigger a refresh so clients receive new host list promptly
    host_cache.get_data(force_refresh=True)
    return jsonify({"message": f"Configuration reloaded. Monitoring {len(MONITORED_HOSTS)} hosts.", "hosts_count": len(MONITORED_HOSTS)})

if __name__ == '__main__':
    app.run(debug=False, host='0.0.0.0', port=5000)