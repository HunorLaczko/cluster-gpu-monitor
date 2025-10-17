import sys
from pathlib import Path
from typing import Any, Dict, List

import pytest


# Ensure the project root is importable for tests.
PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


@pytest.fixture
def sample_disk_entries() -> List[Dict[str, Any]]:
    return [
        {
            "path": "/",
            "label": "Root (/)",
            "total_gb": 100.0,
            "used_gb": 55.0,
            "free_gb": 45.0,
            "percent_used": 55.0,
        },
        {
            "path": "/data-local/job",
            "label": "Data (/data-local/job)",
            "total_gb": 200.0,
            "used_gb": 50.0,
            "free_gb": 150.0,
            "percent_used": 25.0,
        },
    ]


@pytest.fixture
def sample_system_metrics(sample_disk_entries):
    return {
        "cpu_percent": 37.5,
        "memory_total_gb": 64.0,
        "memory_used_gb": 21.5,
        "memory_percent": 33.6,
        "load_average_1m": 1.23,
        "load_average_5m": 0.95,
        "load_average_15m": 0.81,
        "load_max": 32,
        "disks": sample_disk_entries,
    }


@pytest.fixture
def sample_gpu_metrics():
    return [
        {
            "id": 0,
            "name": "Mock GPU",
            "uuid": "GPU-1234",
            "utilization_gpu_percent": 75,
            "memory_total_mib": 16384,
            "memory_used_mib": 8192,
            "memory_percent": 50.0,
            "temperature_celsius": 55,
            "power_usage_watts": 120.0,
            "power_limit_watts": 200.0,
            "fan_speed_percent": 35,
            "processes": [
                {
                    "pid": 1001,
                    "username": "alice",
                    "command": "python train.py",
                    "gpu_memory_used_mib": 4096,
                    "cpu_percent": 12.5,
                }
            ],
        }
    ]


@pytest.fixture
def sample_exporter_payload(sample_system_metrics, sample_gpu_metrics):
    return {
        "hostname": "mock-host",
        "timestamp_utc": "2024-04-01T00:00:00Z",
        "system": sample_system_metrics,
        "gpus": sample_gpu_metrics,
    }


@pytest.fixture
def async_return():
    """Convenience helper to convert a value into an awaitable."""

    async def _inner(value):
        return value

    return _inner


# Individual tests can request a fresh event loop by using the
# ``event_loop`` fixture provided by ``pytest-asyncio`` when needed.
