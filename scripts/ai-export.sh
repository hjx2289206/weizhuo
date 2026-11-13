#!/usr/bin/env bash
# Offline build environment. Never used by server workers.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PYTHON_BIN="${AI_EXPORT_PYTHON:-}"
if [ -z "$PYTHON_BIN" ]; then
  if [ -x .guandan/venv/bin/python ]; then PYTHON_BIN=.guandan/venv/bin/python
  elif command -v python3.12 >/dev/null 2>&1; then PYTHON_BIN=python3.12
  else PYTHON_BIN=python3; fi
fi
if [ ! -x .ai/export-venv/bin/python ]; then "$PYTHON_BIN" -m venv .ai/export-venv; fi
.ai/export-venv/bin/python -m pip install -r requirements-ai-export.txt
.ai/export-venv/bin/python scripts/ai-export.py "$@"
