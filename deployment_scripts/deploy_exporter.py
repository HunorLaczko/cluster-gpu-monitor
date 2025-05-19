import json
import os
from fabric import Connection, Config
from fabric.transfer import Transfer
from getpass import getpass
import logging

# Configure logging for the deployment script
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# --- Configuration ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
EXPORTER_NODE_DIR = os.path.join(os.path.dirname(BASE_DIR), "exporter_node") # Path to exporter_node directory
HOSTS_CONFIG_FILE = os.path.join(BASE_DIR, "hosts_config.json") # Expects hosts_config.json, not example
DEFAULT_PYTHON_VERSION = "python3" # Minimum, adjust if needed
START_EXPORTER_TEMPLATE_NAME = "start_exporter_template.sh" 
START_EXPORTER_SCRIPT_NAME = "start_exporter.sh" # Final name on remote


def get_ssh_password(host_details):
    """Prompt for SSH password if not using key-based auth or if key is passphrase protected."""
    return getpass(f"Enter SSH password for {host_details['username']}@{host_details['address']}: ")

def deploy_to_host(host_details):
    """Deploys the exporter to a single host."""
    logger.info(f"Starting deployment to host: {host_details['name']} ({host_details['address']})")

    connection_kwargs = {}
    if host_details.get("ssh_key_path"):
        connection_kwargs['key_filename'] = os.path.expanduser(host_details["ssh_key_path"])
    else:
        # Prompt for password if no key is provided
        password = get_ssh_password(host_details)
        connection_kwargs['password'] = password
    

    try:
        config = Config(overrides={'sudo': {'password': getpass("Enter SUDO password: ")}})
        c = Connection(
            host_details['address'], 
            user=host_details['username'], 
            port=host_details.get("ssh_port", 22),
            connect_kwargs=connection_kwargs,
            config=config
        )
        c.open()
        logger.info(f"Successfully connected to {host_details['address']}")

        deploy_path = host_details["deploy_path"]
        remote_user = host_details["username"]
        exporter_port = str(host_details.get("exporter_port", 8000)) # Get port from config, default 8000

        # 1. Create deployment directory (remains the same)
        logger.info(f"Creating deployment directory: {deploy_path}")
        c.sudo(f"mkdir -p {deploy_path}", warn=True)
        c.sudo(f"chown {remote_user}:{remote_user} {deploy_path}", warn=True)

        # 2. Upload exporter files
        logger.info("Uploading exporter files...")
        files_to_upload = ["exporter.py", "requirements.txt"]
        for file_name in files_to_upload:
            local_path = os.path.join(EXPORTER_NODE_DIR, file_name)
            remote_file_path = os.path.join(deploy_path, file_name)
            c.put(local_path, remote=remote_file_path)
        
        # --- Process and upload start_exporter.sh ---
        start_script_template_path = os.path.join(EXPORTER_NODE_DIR, START_EXPORTER_TEMPLATE_NAME)
        if not os.path.exists(start_script_template_path):
            logger.error(f"Start script template {START_EXPORTER_TEMPLATE_NAME} not found in {EXPORTER_NODE_DIR}")
            return False
            
        with open(start_script_template_path, "r") as f:
            start_script_content = f.read()
        
        start_script_content = start_script_content.replace("{{DEPLOY_PATH}}", deploy_path)
        start_script_content = start_script_content.replace("{{EXPORTER_PORT}}", exporter_port)
        
        # Write processed script to a temporary local file
        temp_start_script_local_path = os.path.join(BASE_DIR, f"temp_{START_EXPORTER_SCRIPT_NAME}")
        with open(temp_start_script_local_path, "w") as f_local:
            f_local.write(start_script_content)
        
        remote_start_script_path = os.path.join(deploy_path, START_EXPORTER_SCRIPT_NAME)
        c.put(temp_start_script_local_path, remote=remote_start_script_path)
        os.remove(temp_start_script_local_path) # Clean up local temp file
        
        c.run(f"chmod +x {remote_start_script_path}")
        logger.info(f"Uploaded and configured {START_EXPORTER_SCRIPT_NAME} to {remote_start_script_path}")

        # 3. Install dependencies (remains largely the same)
        # ... (ensure python_executable and pip_executable paths are correct relative to deploy_path) ...
        logger.info("Setting up Python environment and installing dependencies...")
        python_executable = host_details.get("python_executable", DEFAULT_PYTHON_VERSION)
        
        c.sudo("apt-get update -qq", hide=True, warn=True)
        c.sudo(f"apt-get install -y -qq {python_executable} {python_executable}-venv git", hide=True, warn=True)

        c.run(f"{python_executable} -m venv {deploy_path}/venv")
        pip_executable = f"{deploy_path}/venv/bin/pip"
        requirements_file_remote = f"{deploy_path}/requirements.txt" # Ensure this uses deploy_path
        c.run(f"{pip_executable} install --upgrade pip", hide=True)
        c.run(f"{pip_executable} install -r {requirements_file_remote}", hide=True)


        # 4. Setup systemd service (remains largely the same)
        # The systemd service file already uses {{DEPLOY_PATH}} which is correct
        # The ExecStart in systemd service calls `{{DEPLOY_PATH}}/start_exporter.sh`
        # which will now use the correct templated DEPLOY_PATH and EXPORTER_PORT internally.
        logger.info("Setting up systemd service...")
        service_template_path = os.path.join(EXPORTER_NODE_DIR, "systemd_service_template.service")
        # ... (rest of systemd setup logic, ensure {{REMOTE_USER}} and {{DEPLOY_PATH}} are correctly replaced)
        with open(service_template_path, "r") as f:
            service_content = f.read()
        
        service_content = service_content.replace("{{REMOTE_USER}}", remote_user)
        service_content = service_content.replace("{{DEPLOY_PATH}}", deploy_path) # This is correct
        
        remote_service_file_path = "/etc/systemd/system/metrics_exporter.service"
        temp_service_file_local_path_systemd = os.path.join(BASE_DIR, "temp_metrics_exporter_local.service")
        
        with open(temp_service_file_local_path_systemd, "w") as f_local:
            f_local.write(service_content)
        
        remote_temp_service_file = f"/tmp/metrics_exporter.service" # Standardize temp path
        c.put(temp_service_file_local_path_systemd, remote=remote_temp_service_file)
        os.remove(temp_service_file_local_path_systemd)

        c.sudo(f"mv {remote_temp_service_file} {remote_service_file_path}")
        c.sudo(f"chown root:root {remote_service_file_path}")
        c.sudo(f"chmod 644 {remote_service_file_path}")

        c.sudo("systemctl daemon-reload")
        c.sudo("systemctl enable metrics_exporter.service")
        c.sudo("systemctl restart metrics_exporter.service")
        
        result = c.sudo("systemctl is-active metrics_exporter.service", warn=True, hide=True)
        if result.stdout.strip() == "active":
            logger.info(f"Metrics exporter service is active on {host_details['name']} (Port: {exporter_port}).")
        else:
            logger.warning(f"Metrics exporter service status on {host_details['name']}: {result.stdout.strip()}")
            logger.warning("Check logs on the remote host: journalctl -u metrics_exporter.service")

        logger.info(f"Deployment to {host_details['name']} completed successfully.")
        return True

    except Exception as e:
        logger.error(f"Deployment to {host_details['name']} FAILED: {e}", exc_info=True)
        return False
    finally:
        if 'c' in locals() and c.is_connected:
            c.close()


def main():
    logger.info("Starting exporter deployment process...")
    
    if not os.path.exists(HOSTS_CONFIG_FILE):
        logger.error(f"Hosts configuration file not found: {HOSTS_CONFIG_FILE}")
        logger.error("Please create it based on 'hosts_config_example.json'.")
        return

    with open(HOSTS_CONFIG_FILE, "r") as f:
        hosts = json.load(f)

    if not hosts:
        logger.info("No hosts configured in hosts_config.json. Exiting.")
        return

    successful_deployments = 0
    for host_details in hosts:
        logger.info(f"\n--- Deploying to: {host_details.get('name', host_details['address'])} ---")
        if deploy_to_host(host_details):
            successful_deployments += 1
        else:
            logger.error(f"Failed to deploy to {host_details.get('name', host_details['address'])}.")
            # Decide if you want to stop on first failure or continue
            # continue

    logger.info(f"\n--- Deployment Summary ---")
    logger.info(f"Successfully deployed to {successful_deployments}/{len(hosts)} hosts.")


if __name__ == "__main__":
    # Ensure exporter_node files are accessible
    if not os.path.isdir(EXPORTER_NODE_DIR):
        logger.error(f"Exporter node directory not found: {EXPORTER_NODE_DIR}")
        logger.error("Make sure this script is in 'deployment_scripts' and 'exporter_node' is a sibling directory.")
    elif not os.path.exists(os.path.join(EXPORTER_NODE_DIR, START_EXPORTER_TEMPLATE_NAME)):
        logger.error(f"Start script template '{START_EXPORTER_TEMPLATE_NAME}' not found in {EXPORTER_NODE_DIR}")
    else:
        main()