#!/usr/bin/env bash
# ClaudeWebUI - Developed by acidvegas in Python (https://github.com/acidvegas)
# claudewebui/start.sh

set -e
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "Creating virtualenv…"
  python3 -m venv .venv
fi

source .venv/bin/activate

pip install -q -r requirements.txt

PORT=${PORT:-5000}
echo "Starting Claude Code Web IDE on http://localhost:$PORT"
python app.py
