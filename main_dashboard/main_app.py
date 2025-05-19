from flask import Flask, render_template, jsonify, request # Added request
import httpx
import asyncio
import json
import os
import logging
from datetime import datetime

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

app = Flask(__name__)

# --- Configuration ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
HOST_CONFIG_PATH = os.path.join(BASE_DIR, "monitored_hosts_config.json")
MONITORED_HOSTS = []

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

async def fetch_single_host_data(client: httpx.AsyncClient, host_config: dict) -> dict:
    url = host_config.get("api_url")
    name = host_config.get("name", url)
    raw_data = {
        "name": name,
        "url": url,
        "hostname": name, 
        "timestamp_utc": datetime.utcnow().isoformat(),
        "system": {"error": "Not fetched"},
        "gpus": [{"error": "Not fetched"}],
        "error": None,
        "status_code": None,
        "fetch_time_utc": datetime.utcnow().isoformat()
    }
    try:
        response = await client.get(url, timeout=10.0)
        raw_data["status_code"] = response.status_code
        response.raise_for_status()
        data = response.json()
        raw_data.update(data)
        raw_data["name"] = name 
        if "error" in data :
             raw_data["error"] = f"Exporter reported error: {data['error']}"
        # Extract unique usernames for each GPU for the overview
        if "gpus" in raw_data and isinstance(raw_data["gpus"], list):
            for gpu_info in raw_data["gpus"]:
                if isinstance(gpu_info, dict) and "processes" in gpu_info and isinstance(gpu_info["processes"], list):
                    usernames = sorted(list(set(p.get("username", "N/A") for p in gpu_info["processes"] if isinstance(p, dict))))
                    gpu_info["process_usernames"] = usernames if usernames else ["None"]
                elif isinstance(gpu_info, dict): # Ensure process_usernames key exists
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
    
    if "system" not in raw_data: raw_data["system"] = {}
    if "gpus" not in raw_data: raw_data["gpus"] = []
    
    return raw_data

async def fetch_all_hosts_data() -> list:
    if not MONITORED_HOSTS:
        return []
    
    async with httpx.AsyncClient() as client:
        tasks = [fetch_single_host_data(client, host_conf) for host_conf in MONITORED_HOSTS]
        results = await asyncio.gather(*tasks)
    return results

@app.route('/')
def overview_page():
    """Renders the new overview dashboard page."""
    return render_template('overview.html', initial_hosts_config=MONITORED_HOSTS, current_view="overview")

@app.route('/detailed')
def detailed_page():
    """Renders the detailed dashboard page."""
    return render_template('detailed.html', initial_hosts_config=MONITORED_HOSTS, current_view="detailed")

@app.route('/api/data')
async def get_all_data_api():
    """API endpoint to fetch fresh data from all monitored hosts."""
    if not MONITORED_HOSTS:
        return jsonify({"error": "No hosts configured.", "data": []})
    
    all_data = await fetch_all_hosts_data()
    return jsonify(all_data)

@app.route('/api/config/reload', methods=['POST'])
def reload_config_api():
    logger.info("Received request to reload host configuration.")
    load_host_config()
    return jsonify({"message": f"Configuration reloaded. Monitoring {len(MONITORED_HOSTS)} hosts.", "hosts_count": len(MONITORED_HOSTS)})

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)