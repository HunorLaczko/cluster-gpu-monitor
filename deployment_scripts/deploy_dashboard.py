import os
import shutil
import subprocess
import getpass
import argparse
import logging
import sys

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# --- Configuration ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DASHBOARD_APP_SRC_DIR = os.path.join(os.path.dirname(BASE_DIR), "main_dashboard")

def check_sudo():
    """Checks if the script is run with sudo privileges."""
    if os.geteuid() != 0:
        logger.error("This script needs to be run with sudo privileges to manage systemd services and file ownership.")
        logger.info("Please run again using: sudo python3 deploy_dashboard_local.py [options]")
        sys.exit(1)
    logger.info("Sudo privileges detected.")

def run_command(command, check=True, capture_output=False, text=True, shell=False, cwd=None, verbose=True):
    """Helper function to run shell commands."""
    if verbose:
        logger.info(f"Executing: {' '.join(command) if isinstance(command, list) else command}")
    try:
        # For subprocess.run, if shell=True, command should be a string.
        # If shell=False, command should be a list.
        cmd_to_run = command
        if shell and isinstance(command, list):
            cmd_to_run = ' '.join(command)
        elif not shell and isinstance(command, str):
            # This case is problematic, but we'll try to split. Better to pass lists for non-shell.
            cmd_to_run = command.split()

        process = subprocess.run(cmd_to_run, check=check, capture_output=capture_output, text=text, shell=shell, cwd=cwd)
        return process
    except subprocess.CalledProcessError as e:
        logger.error(f"Command failed: {e}")
        if capture_output:
            logger.error(f"Stdout: {e.stdout}" if e.stdout else "No stdout")
            logger.error(f"Stderr: {e.stderr}" if e.stderr else "No stderr")
        raise
    except FileNotFoundError as e: # Handle command not found
        logger.error(f"Command not found: {command[0] if isinstance(command, list) else command.split()[0]}. Ensure it's installed and in PATH.")
        raise


def check_system_dependencies(python_executable="python3"):
    """Checks for necessary system-level dependencies."""
    logger.info("Checking for system dependencies...")
    missing_deps = []

    # 1. Check for Python executable
    if not shutil.which(python_executable):
        missing_deps.append(f"Python interpreter: '{python_executable}' (not found in PATH)")
    else:
        logger.info(f"Python interpreter '{python_executable}' found at {shutil.which(python_executable)}")

        # 2. Check for venv module availability for the specified Python
        # A more direct check for venv capability:
        try:
            # Use a very simple venv command, like creating a dummy venv and immediately cleaning it up,
            # or just checking help. Checking help is less intrusive.
            venv_check_cmd = [python_executable, "-m", "venv", "--help"]
            result = run_command(venv_check_cmd, capture_output=True, check=False, verbose=False) # Don't check=True, we evaluate returncode
            if result.returncode != 0:
                missing_deps.append(f"Python venv module for '{python_executable}' (command '{' '.join(venv_check_cmd)}' failed. On Debian/Ubuntu, try: sudo apt install {python_executable}-venv)")
            else:
                logger.info(f"Python venv module for '{python_executable}' appears to be available.")
        except FileNotFoundError: # Should have been caught by shutil.which(python_executable)
             missing_deps.append(f"Python interpreter '{python_executable}' for venv check (not found in PATH)")
        except subprocess.CalledProcessError as e: # Should not happen with check=False
             missing_deps.append(f"Python venv module for '{python_executable}' (check command failed unexpectedly: {e}. On Debian/Ubuntu, try: sudo apt install {python_executable}-venv)")


    # 3. Check for Git
    if not shutil.which("git"):
        missing_deps.append("Git (command: 'git') (not found in PATH. On Debian/Ubuntu, try: sudo apt install git)")
    else:
        logger.info(f"Git found at {shutil.which('git')}")

    if missing_deps:
        logger.error("---------------------------------------------------------")
        logger.error("Missing system dependencies. Please install them manually:")
        for dep in missing_deps:
            logger.error(f"  - {dep}")
        logger.error("---------------------------------------------------------")
        sys.exit(1)

    logger.info("All checked system dependencies are present.")
    return True


def setup_dashboard_files(deploy_path, service_user):
    """Creates deployment directory and copies application files."""
    logger.info(f"Setting up dashboard files at {deploy_path}")
    if not os.path.exists(deploy_path):
        run_command(["mkdir", "-p", deploy_path])
        logger.info(f"Created directory: {deploy_path}")
    else:
        logger.info(f"Deployment directory {deploy_path} already exists. Files will be overwritten.")

    # Avoid copying static/templates into themselves if deploy_path is inside DASHBOARD_APP_SRC_DIR
    for item in os.listdir(DASHBOARD_APP_SRC_DIR):
        s = os.path.join(DASHBOARD_APP_SRC_DIR, item)
        d = os.path.join(deploy_path, item)
        # Skip copying if source and destination are the same directory (prevents static/static, etc.)
        if os.path.abspath(s) == os.path.abspath(d):
            logger.info(f"Skipping copy of {s} into itself.")
            continue
        if os.path.isdir(s):
            # If destination exists and is a directory, remove it first to avoid nested copy
            if os.path.exists(d) and os.path.isdir(d):
                shutil.rmtree(d)
            run_command(["cp", "-R", s, d])
        else:
            run_command(["cp", s, d])

    logger.info(f"Copied application files from {DASHBOARD_APP_SRC_DIR} to {deploy_path}")

    run_command(["chown", "-R", f"{service_user}:{service_user}", deploy_path])
    logger.info(f"Set ownership of {deploy_path} to {service_user}")

    start_script_path = os.path.join(deploy_path, "start_main_app.sh")
    if os.path.exists(start_script_path):
        run_command(["chmod", "+x", start_script_path])
        logger.info(f"Made {start_script_path} executable.")

def setup_virtual_environment(deploy_path, service_user, python_executable="python3"):
    """Creates a virtual environment and installs Python dependencies."""
    venv_path = os.path.join(deploy_path, "venv")
    logger.info(f"Setting up Python virtual environment at {venv_path} using {python_executable}")

    # Run venv creation as the service_user. The deploy_path is already owned by service_user.
    run_command(["sudo", "-u", service_user, python_executable, "-m", "venv", venv_path])

    pip_executable = os.path.join(venv_path, "bin/pip")
    requirements_file = os.path.join(deploy_path, "requirements.txt")

    logger.info("Installing Python dependencies from requirements.txt...")
    run_command(["sudo", "-u", service_user, pip_executable, "install", "--upgrade", "pip"])
    run_command(["sudo", "-u", service_user, pip_executable, "install", "-r", requirements_file])
    logger.info("Python dependencies installed.")

def setup_systemd_service(deploy_path, service_user):
    """Creates and enables the systemd service for the dashboard."""
    logger.info("Setting up systemd service for the main dashboard...")
    service_template_path = os.path.join(deploy_path, "systemd_service_template_main.service")

    if not os.path.exists(service_template_path):
        logger.error(f"Systemd template not found at {service_template_path}")
        raise FileNotFoundError(f"Systemd template not found at {service_template_path}")

    with open(service_template_path, "r") as f:
        service_content = f.read()

    service_content = service_content.replace("{{DASHBOARD_USER}}", service_user)
    service_content = service_content.replace("{{DASHBOARD_DEPLOY_PATH}}", deploy_path)

    service_file_path = "/etc/systemd/system/main_dashboard.service"
    # Writing this file requires root privileges, which we have due to check_sudo().
    with open(service_file_path, "w") as f:
        f.write(service_content)
    logger.info(f"Created systemd service file at {service_file_path}")

    run_command(["systemctl", "daemon-reload"])
    run_command(["systemctl", "enable", "main_dashboard.service"])
    run_command(["systemctl", "restart", "main_dashboard.service"])

    result = run_command(["systemctl", "is-active", "main_dashboard.service"], capture_output=True, check=False)
    if result.stdout.strip() == "active":
        logger.info("Main dashboard service is active.")
    else:
        logger.warning(f"Main dashboard service status: {result.stdout.strip()}. Check with 'journalctl -u main_dashboard.service'")


def main():
    parser = argparse.ArgumentParser(description="Deploy the Main Monitoring Dashboard application locally.")
    parser.add_argument(
        "--deploy-path",
        default="/opt/system_monitor_dashboard",
        help="Absolute path where the dashboard application files will be deployed. (Default: /opt/system_monitor_dashboard)"
    )
    parser.add_argument(
        "--service-user",
        default=getpass.getuser(),
        help="System user that will own the deployment files and run the dashboard service. (Default: current sudo-calling user if applicable, else current user)"
    )
    parser.add_argument(
        "--python-executable",
        default="python3",
        help="Python interpreter to use for creating the virtual environment (e.g., 'python3.9'). (Default: python3)"
    )
    args = parser.parse_args()

    # If script is run with sudo, getpass.getuser() might return 'root'.
    # Try to get the original user from SUDO_USER environment variable.
    actual_service_user = args.service_user
    if os.geteuid() == 0 and 'SUDO_USER' in os.environ:
        if args.service_user == 'root' or args.service_user == getpass.getuser(): # if default or explicitly root
            actual_service_user = os.environ['SUDO_USER']
            logger.info(f"Running as root, service user will be the original sudo user: {actual_service_user} (unless overridden by --service-user)")
    if args.service_user != getpass.getuser() and args.service_user != (os.environ.get('SUDO_USER') if os.geteuid() == 0 else None) : # if user explicitly set it to something else
        actual_service_user = args.service_user
        logger.info(f"Service user explicitly set to: {actual_service_user}")


    check_sudo() # Ensure script is run with sudo for systemd and file operations

    try:
        logger.info(f"Starting local deployment of Main Dashboard to {args.deploy_path} for user {actual_service_user}")

        check_system_dependencies(args.python_executable) # This will exit if deps are missing
        setup_dashboard_files(args.deploy_path, actual_service_user)
        setup_virtual_environment(args.deploy_path, actual_service_user, args.python_executable)
        setup_systemd_service(args.deploy_path, actual_service_user)

        logger.info("Main Dashboard local deployment completed successfully!")
        logger.info(f"The dashboard should soon be accessible (default: http://<your_ip>:5000).")
        logger.info(f"Remember to configure 'monitored_hosts_config.json' in {args.deploy_path} if you haven't already.")

    except FileNotFoundError as e:
        logger.error(f"Deployment FAILED due to missing file: {e}")
    except subprocess.CalledProcessError as e:
        logger.error(f"Deployment FAILED due to a command error: {e}")
    except Exception as e:
        logger.error(f"An unexpected error occurred during deployment: {e}", exc_info=True)

if __name__ == "__main__":
    if not os.path.isdir(DASHBOARD_APP_SRC_DIR):
        logger.error(f"Main dashboard application source directory not found: {DASHBOARD_APP_SRC_DIR}")
        logger.error("Ensure this script is in 'deployment_scripts' and 'main_dashboard' is a sibling directory containing the app.")
    else:
        main()