"""Opt-in runtime smoke: run with .ai/venv/bin/python (no Torch installed)."""
import importlib.util
import os
import sys
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'server/bots'))
import numpy as np
from onnx_cpu import cpu_session
import onnx_cpu


class PortableCpu(unittest.TestCase):
    def test_inference_environment_has_no_torch(self):
        self.assertIsNone(importlib.util.find_spec('torch'))

    def test_damaged_weights_fail_before_inference(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            (folder / 'broken.onnx').write_bytes(b'broken')
            (folder / 'manifest.json').write_text(json.dumps({'models': {'broken.onnx': {'sha256': '0' * 64}}}))
            with patch.object(onnx_cpu, 'MODEL_DIR', folder):
                with self.assertRaisesRegex(RuntimeError, 'checksum mismatch'):
                    cpu_session('broken.onnx')

    def test_all_five_models_dynamic_batches_and_cpu_provider(self):
        rng = np.random.default_rng(7)
        for name in ['guandan-danlm.onnx', 'guandan-danzero.onnx',
                     'douzero-landlord.onnx', 'douzero-landlord_down.onnx', 'douzero-landlord_up.onnx']:
            session = cpu_session(name)
            self.assertEqual(session.get_providers(), ['CPUExecutionProvider'])
            for count in [1, 7, 512]:
                if name == 'guandan-danlm.onnx':
                    for history in [2, 1280]:
                        feed = {'token_ids': rng.integers(1, 91, (1, history), dtype=np.int64),
                                'seq_lens': np.asarray([history], np.int64),
                                'self_abs': np.asarray([3], np.int64),
                                'hand': np.zeros((1, 54), np.float32),
                                'action': np.zeros((1, count, 80), np.float32)}
                        values = session.run(None, feed)[0]
                        self.assertEqual(values.size, count)
                        self.assertTrue(np.isfinite(values).all())
                else:
                    if name == 'guandan-danzero.onnx':
                        feed = {session.get_inputs()[0].name: np.zeros((count, 964), np.float32)}
                    else:
                        width = 373 if name == 'douzero-landlord.onnx' else 484
                        feed = {'z': np.zeros((count, 5, 162), np.float32), 'x': np.zeros((count, width), np.float32)}
                    values = session.run(None, feed)[0]
                    self.assertEqual(values.size, count)
                    self.assertTrue(np.isfinite(values).all())
        self.assertNotIn('torch', sys.modules)

    def test_worker_imports_keep_original_models_unloaded(self):
        import douzero_worker
        douzero_worker.load_models()
        source = ROOT / '.guandan/DanLM'
        if source.exists() and sys.platform == 'darwin':
            os.environ['GUANDAN_SRC'] = str(source)
            import guandan_worker
            for key in guandan_worker.AGENT_REGISTRY:
                guandan_worker.agent_for(key)
            agent = guandan_worker.agent_for('danlm_v1')
            agent.reset_round(2)
            with patch('guandan_onnx.tokenize_state', return_value=[1] * 1281):
                with self.assertRaisesRegex(ValueError, 'Token sequence too long'):
                    agent.get_q_values(SimpleNamespace(player=0), SimpleNamespace(state=SimpleNamespace(global_play_history=[])))
        self.assertNotIn('torch', sys.modules)
        self.assertNotIn('ui_agent', sys.modules)
        self.assertFalse(any(name.startswith(('danzero.model', 'danzero.eval')) for name in sys.modules))


if __name__ == '__main__':
    unittest.main()
