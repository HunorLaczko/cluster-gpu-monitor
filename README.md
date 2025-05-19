# Cluster GPU Monitor

A web-based dashboard to monitor CPU, RAM, and NVIDIA GPU stats (utilization, memory, processes) across multiple local and remote machines. It uses `nvitop` for data collection via remote exporters and offers both a condensed overview and a detailed metrics view.

## Features

* Real-time monitoring of CPU, System Memory, and NVIDIA GPU resources.
* Supports multiple local and remote machines.
* Web interface with:
    * **Overview:** Condensed view for monitoring many hosts at a glance.
    * **Detailed View:** In-depth metrics for individual hosts, including per-process GPU usage.
* Data is collected by lightweight Python exporters on each monitored machine.
* Deployment scripts provided to set up exporters on remote Linux systems (via SSH) and the main dashboard locally.
* Configurable refresh interval for the dashboard.

## Architecture

1.  **Metrics Exporter (`exporter_node/`):** A FastAPI app on each monitored host, exposing system/GPU data via an HTTP API. Uses `nvitop` and `psutil`.
2.  **Deployment Scripts (`deployment_scripts/`):**
    * `deploy_exporter.py`: Deploys exporters to remote Linux hosts using SSH and sets them up as `systemd` services.
    * `deploy_dashboard.py`: Sets up the main dashboard application and its `systemd` service on the current (local) machine.
3.  **Main Dashboard (`main_dashboard/`):** A Flask web application that queries exporter APIs, aggregates data, and presents it through a web UI with auto-refresh.

## Prerequisites

* **General:** Python 3.8+
* **Exporter Nodes:** Linux, NVIDIA GPU(s) with drivers, Python 3.8+, SSH server (for remote deployment).
* **Deployment Machine (for `deploy_exporter.py`):** Fabric (`pip install fabric`).
* **Dashboard Machine (for `deploy_dashboard.py`):** `sudo` access for service setup.

## Quick Setup

1.  **Clone the Repository:**
    ```bash
    git clone https://github.com/HunorLaczko/cluster-gpu-monitor.git
    cd cluster-gpu-monitor
    ```

2.  **Deploy Exporters to Remote Hosts:**
    * Navigate to `deployment_scripts/`.
    * Edit `hosts_config.json` with your remote server details (IP, username, deploy path, exporter port).
    * Run: `python deploy_exporter.py`
        *(This script will SSH to targets, install dependencies, and start the exporter service.)*

3.  **Deploy the Main Dashboard Locally:**
    * Navigate to `deployment_scripts/`.
    * Run with sudo: `sudo python3 deploy_dashboard.py`
        *(This sets up the dashboard service on the current machine. Options for deploy path and service user are available; see script help.)*

4.  **Configure Dashboard's Monitored Hosts:**
    * After deployment, edit the `monitored_hosts_config.json` file located in the dashboard's deployment path (e.g., `/opt/system_monitor_dashboard/monitored_hosts_config.json`).
    * Add the API URLs for each deployed exporter, for example:
        ```json
        [
            { "name": "ServerA", "api_url": "http://<IP_OF_SERVER_A>:<PORT>/metrics" },
            { "name": "ServerB", "api_url": "http://<IP_OF_SERVER_B>:<PORT>/metrics" }
        ]
        ```
    * Restart the dashboard service if it's already running: `sudo systemctl restart main_dashboard.service`, or use the "Reload Host Config" button in the UI.

## Running & Usage

* **Exporter Services:** Should start automatically on remote hosts after deployment (`metrics_exporter.service`).
* **Main Dashboard Service:** Should start automatically on the local machine after deployment (`main_dashboard.service`).
* **Access Dashboard:** Open your browser to `http://<IP_OF_DASHBOARD_MACHINE>:5000` (default port).
* **Interface:**
    * Switch between "Overview" and "Detailed" views using header links.
    * Configure refresh interval directly in the UI.
    * "Last Updated" timestamp shows data freshness.
    * "Reload Host Config" button reloads `monitored_hosts_config.json` without a full service restart.

## Troubleshooting

* **Exporters not running:** SSH to the node, check `sudo systemctl status metrics_exporter.service` and `journalctl -u metrics_exporter.service`. Ensure Python, `nvitop`, `psutil`, and `fastapi/uvicorn` are installed in the exporter's venv. Verify NVIDIA drivers with `nvidia-smi`.
* **Dashboard errors:** Check browser console for JavaScript errors. Ensure exporters are accessible and returning valid JSON. Verify `monitored_hosts_config.json` URLs.
* **Deployment script failures:** Check SSH connectivity, sudo permissions, and Python 3.8+ and venv availability on targets.

## License

This project is licensed under the Apache License, Version 2.0 - see the `LICENSE` file for details.