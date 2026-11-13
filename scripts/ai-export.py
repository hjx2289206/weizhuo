#!/usr/bin/env python3
"""Offline, CPU-only export of the pinned original weights to standard ONNX.

Requires requirements-ai-export.txt and both upstream setup sources. DanLM export
must currently run on macOS/Python 3.12, where its upstream model class can load.
Linux inference only needs the resulting ONNX bundle, not these export imports.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import shutil
import sys
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / '.guandan/DanLM'), str(ROOT / '.guandan/DanLM/ui'),
                str(ROOT / '.douzero/douzero-src')]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check(path, reference, cases, names):
    onnx.checker.check_model(onnx.load(path))
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    session = ort.InferenceSession(str(path), sess_options=options, providers=['CPUExecutionProvider'])
    maximum = 0.0
    with torch.no_grad():
        for args in cases:
            expected = reference(*args).numpy()
            actual = session.run(None, dict(zip(names, (arg.numpy() for arg in args))))[0]
            maximum = max(maximum, float(np.max(np.abs(actual - expected))))
            np.testing.assert_allclose(actual, expected, rtol=1e-4, atol=1e-5)
            if actual.argmax() != expected.argmax():
                raise AssertionError(f'{path.name}: argmax mismatch')
    return {'cases': len(cases), 'maxAbsError': maximum, 'allArgmaxSame': True}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--game', choices=['all', 'guandan', 'douzero'], default='all')
    parser.add_argument('--out', type=Path, default=ROOT / '.ai/models')
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    manifest_path = args.out / 'manifest.json'
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {'format': 1, 'models': {}}
    torch.set_num_threads(2)
    torch.manual_seed(20261018)
    torch.set_grad_enabled(False)

    def record(path, original, parity=None):
        manifest['models'][path.name] = {
            'sha256': digest(path), 'bytes': path.stat().st_size,
            'source': str(original.relative_to(ROOT)), 'sourceSha256': digest(original),
            'backend': 'onnxruntime', 'provider': 'CPUExecutionProvider', 'parity': parity,
        }
        print(json.dumps({path.name: manifest['models'][path.name]}, ensure_ascii=False), flush=True)

    if args.game in ('all', 'guandan'):
        from ui_agent import _load_model, AGENT_REGISTRY

        class DanLM(torch.nn.Module):
            def __init__(self, inner):
                super().__init__()
                self.inner = inner

            def forward(self, token_ids, seq_lens, hand, action, self_abs):
                return self.inner(token_ids, seq_lens, hand, action, self_abs=self_abs)

        inner, _, _ = _load_model(AGENT_REGISTRY['danlm_v1'])
        model = DanLM(inner).eval().cpu()
        names = ['token_ids', 'seq_lens', 'hand', 'action', 'self_abs']
        def sample(history, count):
            return (torch.randint(1, 91, (1, history)), torch.tensor([history]),
                    torch.randint(0, 3, (1, 54)).float(), torch.rand(1, count, 80), torch.tensor([0]))
        examples = sample(8, 7)
        path = args.out / 'guandan-danlm.onnx'
        shapes = ({1: torch.export.Dim('history', min=1, max=1280)}, {}, {},
                  {1: torch.export.Dim('candidates', min=1, max=16384)}, {})
        torch.onnx.export(model, examples, str(path), input_names=names, output_names=['q_values'],
                          opset_version=18, dynamo=True, dynamic_shapes=shapes, external_data=False)
        parity = check(path, model, [sample(h, n) for h in [2, 32, 128, 1280] for n in [1, 7, 375]], names)
        record(path, Path(AGENT_REGISTRY['danlm_v1']['path']), parity)
        source = Path(AGENT_REGISTRY['danzero_v1t']['path'])
        path = args.out / 'guandan-danzero.onnx'
        shutil.copyfile(source, path)
        onnx.checker.check_model(onnx.load(path))
        record(path, source, {'unchangedBytes': True})

    if args.game in ('all', 'douzero'):
        spec = importlib.util.spec_from_file_location('official_models', ROOT / '.douzero/douzero-src/douzero/dmc/models.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        model_dict = module.model_dict

        class DouZero(torch.nn.Module):
            def __init__(self, inner):
                super().__init__()
                self.inner = inner

            def forward(self, z, x):
                return self.inner(z, x, return_value=True)['values']

        for role in ['landlord', 'landlord_down', 'landlord_up']:
            source = ROOT / f'.douzero/weights/douzero_WP/{role}.ckpt'
            inner = model_dict[role]()
            inner.load_state_dict(torch.load(source, map_location='cpu', weights_only=True), strict=True)
            model = DouZero(inner).eval().cpu()
            width = 373 if role == 'landlord' else 484
            def sample(count):
                return torch.rand(count, 5, 162), torch.rand(count, width)
            path = args.out / f'douzero-{role}.onnx'
            # Standard ONNX LSTM handles dynamic candidate batches across CPU runtimes.
            torch.onnx.export(model, sample(2), str(path), input_names=['z', 'x'], output_names=['values'],
                              opset_version=18, dynamo=False, external_data=False,
                              dynamic_axes={'z': {0: 'candidates'}, 'x': {0: 'candidates'}, 'values': {0: 'candidates'}})
            parity = check(path, model, [sample(n) for n in [1, 2, 7, 100, 375]], ['z', 'x'])
            record(path, source, parity)
    manifest['exportVersions'] = {'torch': torch.__version__, 'onnx': onnx.__version__, 'onnxruntime': ort.__version__}
    temporary = manifest_path.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    temporary.replace(manifest_path)


if __name__ == '__main__':
    main()
