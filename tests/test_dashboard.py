from datetime import timedelta

import main_dashboard.main_app as dashboard


def make_sample_host(name="TestHost", error=None):
    payload = {
        "name": name,
        "fetch_time_utc": "2024-04-01T00:00:00Z",
        "system": {
            "cpu_percent": 42.0,
            "memory_percent": 50.0,
            "disks": [],
        },
        "gpus": [],
        "error": error,
    }
    if error:
        payload["system"]["error"] = error
    return payload


def test_host_metrics_cache_force_refresh(monkeypatch, sample_exporter_payload):
    async def fake_fetch():
        return [sample_exporter_payload]

    custom_cache = dashboard.HostMetricsCache(
        refresh_interval=1,
        stale_after=5,
    )

    monkeypatch.setattr(dashboard, "fetch_all_hosts_data", fake_fetch)

    data, snapshot = custom_cache.get_data(force_refresh=True)

    assert data == [sample_exporter_payload]
    assert snapshot["last_refresh_utc"] is not None
    assert snapshot["error"] is None

    cached_data, cached_snapshot = custom_cache.get_data()
    assert cached_data == data
    assert cached_snapshot["last_refresh_utc"] == snapshot["last_refresh_utc"]


def test_host_metrics_cache_refreshes_when_stale(monkeypatch):
    calls = {
        "refresh": 0,
    }

    async def fake_fetch():
        calls["refresh"] += 1
        return [make_sample_host("stale-host")]

    cache = dashboard.HostMetricsCache(refresh_interval=1, stale_after=2)
    monkeypatch.setattr(dashboard, "fetch_all_hosts_data", fake_fetch)

    data, _ = cache.get_data(force_refresh=True)
    assert data and calls["refresh"] == 1

    # Simulate stale cache by rewinding last refresh timestamp
    cache._last_refresh = dashboard.utc_now() - timedelta(seconds=5)
    data, _ = cache.get_data()
    assert data and calls["refresh"] == 2


def test_api_data_returns_cached_payload(monkeypatch):
    client = dashboard.app.test_client()
    sample_data = [make_sample_host("api-host")]
    sample_snapshot = {
        "last_refresh_utc": "2024-04-01T00:00:00Z",
        "stale_for_seconds": 0.1,
        "error": None,
    }

    def fake_get_data(force_refresh=False):
        return sample_data, sample_snapshot | {"served_from": "forced" if force_refresh else "cache"}

    monkeypatch.setattr(dashboard, "MONITORED_HOSTS", [{"name": "api-host", "api_url": "http://localhost"}])
    monkeypatch.setattr(dashboard.host_cache, "get_data", fake_get_data)

    response = client.get("/api/data")
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["data"] == sample_data
    assert payload["metadata"]["served_from"] == "cache"

    response = client.get("/api/data?fresh=1")
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["metadata"]["served_from"] == "forced"


def test_api_data_handles_no_hosts(monkeypatch):
    client = dashboard.app.test_client()
    monkeypatch.setattr(dashboard, "MONITORED_HOSTS", [])

    response = client.get("/api/data")
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["data"] == []
    assert payload["metadata"]["error"] == "No hosts configured."


def test_reload_config_triggers_cache_refresh(monkeypatch):
    client = dashboard.app.test_client()
    refresh_calls = []

    monkeypatch.setattr(dashboard, "load_host_config", lambda: refresh_calls.append("reloaded"))

    def fake_get_data(force_refresh=False):
        refresh_calls.append(force_refresh)
        return [], {}

    monkeypatch.setattr(dashboard.host_cache, "get_data", fake_get_data)

    response = client.post("/api/config/reload")
    assert response.status_code == 200
    assert refresh_calls == ["reloaded", True]

def test_websocket_route_removed():
    rules = {rule.rule for rule in dashboard.app.url_map.iter_rules()}
    assert "/ws/metrics" not in rules