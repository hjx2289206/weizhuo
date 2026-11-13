"""ONNX scoring with the upstream observation codec; no native model/eval classes.

The upstream engine/encoder/tokenizer still contain macOS extensions. They are
deliberately separate from model execution and remain a Linux migration task.
"""
import numpy as np

from danzero.encoding.encoder_v1 import build_tribute_received_rel, encode_batch_v1t
from danzero.encoding.tokenizer import tokenize_state
from onnx_cpu import cpu_session

AGENT_REGISTRY = {'danlm_v1': 'guandan-danlm.onnx', 'danzero_v1t': 'guandan-danzero.onnx'}


class OnnxGuandanAgent:
    def __init__(self, key: str):
        self.key = key
        self.session = cpu_session(AGENT_REGISTRY[key])
        self.records = []

    def reset_round(self, level):
        self.level = level
        self.records = []

    def notify_tribute(self, records):
        self.records = list(records)

    def observe_action(self, player, vector, new_trick):
        # Both representations derive public action history from the round itself.
        pass

    def get_q_values(self, obs, rnd):
        if self.key == 'danzero_v1t':
            tribute = build_tribute_received_rel(self.records, obs.player) if self.records else None
            batch = encode_batch_v1t(obs, tribute).astype(np.float32)
            feed = {self.session.get_inputs()[0].name: batch}
        else:
            tokens = tokenize_state(self.level, self.records, rnd.state.global_play_history, obs.player)
            if len(tokens) > 1280:
                raise ValueError(f'Token sequence too long: {len(tokens)} > 1280')
            feed = {
                'token_ids': np.asarray([tokens], dtype=np.int64),
                'seq_lens': np.asarray([len(tokens)], dtype=np.int64),
                'hand': np.asarray(obs.hand, dtype=np.float32)[None, :],
                'action': np.asarray(obs.legal_plays, dtype=np.float32)[None, :, :],
                'self_abs': np.asarray([obs.player], dtype=np.int64),
            }
        return self.session.run(None, feed)[0].reshape(-1)
