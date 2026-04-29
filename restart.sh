#!/usr/bin/env bash
# Restart the Claude Web UI server. Always-stable single-string command,
# safe to auto-approve once.
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
pkill -f "${ROOT}/app.py" 2>/dev/null || true
sleep 1
nohup "${ROOT}/.venv/bin/python" "${ROOT}/app.py" \
  >/tmp/webui.log 2>&1 </dev/null &
disown
sleep 2
tail -3 /tmp/webui.log
