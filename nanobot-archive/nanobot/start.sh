#!/bin/bash
cd /home/container
mkdir -p /home/container/workspace
pip install -r requirements.txt --quiet
exec uvicorn bridge:app --host 0.0.0.0 --port ${SERVER_PORT:-8080}
