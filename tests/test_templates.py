import json
import re

import pytest

import main_dashboard.main_app as dashboard


@pytest.fixture
def sample_hosts_config():
    return [
        {"name": "Sample Host", "api_url": "http://localhost:8000/metrics"}
    ]


def extract_json_script(rendered_html: str, script_id: str):
    pattern = rf'<script id="{script_id}" type="application/json">(.*?)</script>'
    match = re.search(pattern, rendered_html, re.DOTALL)
    assert match, f"Script tag with id '{script_id}' missing"
    json_payload = match.group(1).strip()
    assert json_payload, f"Script tag '{script_id}' contained no JSON"
    return json.loads(json_payload)


def test_overview_template_renders(sample_hosts_config, monkeypatch):
    monkeypatch.setattr(dashboard, "MONITORED_HOSTS", sample_hosts_config)
    with dashboard.app.test_request_context('/'):
        rendered = dashboard.overview_page()
    hosts = extract_json_script(rendered, "initial-hosts-config")
    assert hosts == sample_hosts_config
    assert "initializeDashboard(initialHostsConfig, 'overview')" in rendered


def test_detailed_template_renders(sample_hosts_config, monkeypatch):
    monkeypatch.setattr(dashboard, "MONITORED_HOSTS", sample_hosts_config)
    with dashboard.app.test_request_context('/detailed'):
        rendered = dashboard.detailed_page()
    hosts = extract_json_script(rendered, "initial-hosts-config")
    assert hosts == sample_hosts_config
    assert "initializeDashboard(initialHostsConfig, 'detailed')" in rendered


def test_dashboard_settings_script_removed(sample_hosts_config, monkeypatch):
    monkeypatch.setattr(dashboard, "MONITORED_HOSTS", sample_hosts_config)
    with dashboard.app.test_request_context('/'):
        rendered = dashboard.overview_page()

    assert 'dashboard-settings' not in rendered
