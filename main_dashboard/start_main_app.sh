#!/bin/bash

# This script is intended to be run by systemd to start the main dashboard app.

# Define the directory where the main_app is installed
APP_DIR="/opt/system_monitor_dashboard" # This path should match your deployment path
PYTHON_EXEC="$APP_DIR/venv/bin/python3"
GUNICORN_EXEC="$APP_DIR/venv/bin/gunicorn"
APP_MODULE="main_app:app" # Flask app module and instance (filename:app_instance)

# Navigate to the app directory
cd "$APP_DIR" || { echo "Main app directory $APP_DIR not found."; exit 1; }

# Activate virtual environment (optional if gunicorn and dependencies are globally available)
# source "$APP_DIR/venv/bin/activate"

if [ ! -x "$GUNICORN_EXEC" ]; then
    echo "Gunicorn not found or not executable at $GUNICORN_EXEC"
    exit 1
fi

# Define host, port, and workers for Gunicorn
HOST="0.0.0.0"
PORT="5000" # Ensure this port is open
WORKERS="1" # Use a single worker to keep the in-memory cache consistent across connections
WORKER_CLASS="gthread" # Threaded workers handle concurrent requests without websocket dependencies
THREADS="64" # Increased to handle multiple SSE connections (1 per tab) + concurrent requests
LOG_FILE="$APP_DIR/dashboard.log"

echo "Starting Main Dashboard Application on $HOST:$PORT with $WORKERS workers at $(date)" # >> "$LOG_FILE" 2>&1

# Run Gunicorn
# For Flask, you typically point to the "wsgi:app" or "filename:flask_instance_name"
# --log-level info can be helpful
# --access-logfile - and --error-logfile - to log to stdout/stderr for journald
exec "$GUNICORN_EXEC" --workers "$WORKERS" --worker-class "$WORKER_CLASS" --threads "$THREADS" --bind "$HOST:$PORT" "$APP_MODULE" \
    --access-logfile "$APP_DIR/gunicorn_access.log" \
    --error-logfile "$APP_DIR/gunicorn_error.log" \
    --log-level info
# Or to send logs to journald (systemd will capture stdout/stderr):
# exec "$GUNICORN_EXEC" --workers "$WORKERS" --bind "$HOST:$PORT" "$APP_MODULE" --log-level info