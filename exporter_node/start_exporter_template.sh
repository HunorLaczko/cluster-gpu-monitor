#!/bin/bash

# This script is intended to be run by systemd to start the metrics exporter.

# These values will be replaced by deploy_exporter.py
EXPORTER_DIR="{{DEPLOY_PATH}}"
EXPORTER_PORT="{{EXPORTER_PORT}}"

PYTHON_EXEC="$EXPORTER_DIR/venv/bin/python3"
UVICORN_EXEC="$EXPORTER_DIR/venv/bin/uvicorn"
APP_MODULE="exporter:app"

cd "$EXPORTER_DIR" || { echo "Exporter directory $EXPORTER_DIR not found."; exit 1; }

if [ ! -x "$UVICORN_EXEC" ]; then
    echo "Uvicorn not found or not executable at $UVICORN_EXEC"
    exit 1
fi

HOST="0.0.0.0" # Listen on all interfaces

echo "Starting System & GPU Metrics Exporter on $HOST:$EXPORTER_PORT at $(date)"

exec "$UVICORN_EXEC" "$APP_MODULE" --host "$HOST" --port "$EXPORTER_PORT"