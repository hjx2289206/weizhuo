"""Shared portable inference runtime. No Torch or platform accelerator is imported."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

import onnxruntime as ort

ort.disable_telemetry_events()

ROOT = Path(__file__).resolve().parents[2]
MODEL_DIR = Path(os.environ.get('AI_MODEL_DIR') or ROOT / '.ai' / 'models')


def cpu_session(name: str) -> ort.InferenceSession:
    path = MODEL_DIR / name
    manifest = json.loads((MODEL_DIR / 'manifest.json').read_text())
    expected = manifest['models'][name]['sha256']
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise RuntimeError(f'model checksum mismatch: {path}')
    options = ort.SessionOptions()
    options.intra_op_num_threads = max(1, min(4, int(os.environ.get('AI_CPU_THREADS', '2'))))
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    session = ort.InferenceSession(str(path), sess_options=options, providers=['CPUExecutionProvider'])
    session.disable_fallback()
    if session.get_providers() != ['CPUExecutionProvider']:
        raise RuntimeError(f'unexpected providers: {session.get_providers()}')
    return session
