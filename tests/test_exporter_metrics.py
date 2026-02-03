import pytest
from fastapi.testclient import TestClient
from typing import Iterable

import exporter_node.exporter as exporter


@pytest.fixture
def exporter_client(monkeypatch, sample_system_metrics, sample_gpu_metrics):
    """Provide a TestClient with patched metric collectors."""
    monkeypatch.setattr(exporter, "get_system_metrics", lambda: sample_system_metrics)
    monkeypatch.setattr(exporter, "get_gpu_metrics", lambda: sample_gpu_metrics)
    return TestClient(exporter.app)


def test_get_system_metrics_success(monkeypatch, sample_disk_entries):
    class FakeVMem:
        total = 64 * 1024 ** 3
        used = 21.5 * 1024 ** 3
        percent = 33.6

    monkeypatch.setattr(exporter.psutil, "cpu_percent", lambda interval=0.5: 42.0)
    monkeypatch.setattr(exporter.psutil, "virtual_memory", lambda: FakeVMem)
    monkeypatch.setattr(exporter.psutil, "cpu_count", lambda logical=True: 32)
    monkeypatch.setattr(exporter.os, "getloadavg", lambda: (1.2, 0.8, 0.5))
    monkeypatch.setattr(exporter, "get_disk_metrics", lambda: sample_disk_entries)

    metrics = exporter.get_system_metrics()

    assert metrics["cpu_percent"] == pytest.approx(42.0)
    assert metrics["memory_total_gb"] == pytest.approx(64.0)
    assert metrics["load_average_5m"] == pytest.approx(0.8, rel=1e-3)
    assert metrics["disks"] == sample_disk_entries


def test_get_system_metrics_handles_exception(monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("psutil failure")

    monkeypatch.setattr(exporter.psutil, "cpu_percent", boom)

    result = exporter.get_system_metrics()
    assert result["error"].startswith("Could not retrieve system metrics")
    assert result["disks"] == []


def test_get_gpu_metrics_no_devices(monkeypatch):
    monkeypatch.setattr(exporter.nvitop.Device, "all", classmethod(lambda cls: []))
    metrics = exporter.get_gpu_metrics()
    assert metrics == [{"message": "No NVIDIA GPUs found or nvitop could not access them."}]


def test_get_gpu_metrics_with_single_device(monkeypatch):
    class FakeSnapshot:
        pid = 4321
        username = "bob"
        command = "python render.py"
        gpu_memory = 2 * 1024 ** 3  # bytes
        cpu_percent = 9.25

    class FakeGpuProcess:
        pass

    class FakeDevice:
        index = 0

        def name(self):
            return "Mock RTX"

        def uuid(self):
            return "GPU-FAKE-001"

        def utilization_rates(self):
            return type("Util", (), {"gpu": 82})()

        def memory_total(self):
            return 12 * 1024 ** 3

        def memory_used(self):
            return 6 * 1024 ** 3

        def temperature(self):
            return 60

        def power_usage(self):
            return 110_000  # milliwatts

        def power_limit(self):
            return 200_000

        def fan_speed(self):
            return 45

        def processes(self):
            return {0: FakeGpuProcess()}

    def fake_take_snapshots(cls, processes: Iterable, failsafe: bool = True):
        return [FakeSnapshot()]

    monkeypatch.setattr(exporter.nvitop.Device, "all", classmethod(lambda cls: [FakeDevice()]))
    monkeypatch.setattr(exporter.nvitop.GpuProcess, "take_snapshots", classmethod(fake_take_snapshots))

    metrics = exporter.get_gpu_metrics()

    assert len(metrics) == 1
    gpu = metrics[0]
    assert gpu["name"] == "Mock RTX"
    assert gpu["power_usage_watts"] == pytest.approx(110.0)
    assert gpu["memory_percent"] == pytest.approx(50.0)
    assert gpu["processes"][0]["gpu_memory_used_mib"] == pytest.approx(2048.0)


def test_metrics_endpoint_returns_payload(exporter_client, sample_system_metrics, sample_gpu_metrics):
    response = exporter_client.get("/metrics")
    assert response.status_code == 200
    payload = response.json()
    assert payload["system"] == sample_system_metrics
    assert payload["gpus"] == sample_gpu_metrics
    assert "timestamp_utc" in payload


def test_metrics_endpoint_handles_exception(monkeypatch):
    # Reset cache to ensure we hit the logic that raises exception
    exporter._metrics_cache = None
    exporter._cache_timestamp = 0
    monkeypatch.setattr(exporter, "get_system_metrics", lambda: (_ for _ in ()).throw(RuntimeError("boom")))
    client = TestClient(exporter.app)
    response = client.get("/metrics")
    assert response.status_code == 500
    assert "Internal server error" in response.text


def test_health_endpoint(exporter_client):
    response = exporter_client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
