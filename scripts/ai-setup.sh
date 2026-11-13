#!/usr/bin/env bash
# Inference dependencies only. No Torch, CoreML, CUDA or MPS packages.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PYTHON_BIN="${AI_SETUP_PYTHON:-}"
if [ -z "$PYTHON_BIN" ]; then
  if [ -x .guandan/venv/bin/python ]; then PYTHON_BIN=.guandan/venv/bin/python
  elif command -v python3.12 >/dev/null 2>&1; then PYTHON_BIN=python3.12
  else PYTHON_BIN=python3; fi
fi
if [ ! -x .ai/venv/bin/python ]; then "$PYTHON_BIN" -m venv .ai/venv; fi
.ai/venv/bin/python -m pip install -r requirements-ai.txt
.ai/venv/bin/python - <<'PY'
import importlib.util
import onnxruntime
assert importlib.util.find_spec('torch') is None, 'Inference venv must not contain Torch'
print('ONNX Runtime', onnxruntime.__version__, '; inference uses CPUExecutionProvider only')
PY
echo 'Models: .ai/models/manifest.json (export once with scripts/ai-export.py, or copy a verified bundle).'
