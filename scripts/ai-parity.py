#!/usr/bin/env python3
"""Compare the production ONNX adapters with original CPU agents on full deals.

Offline validation only: run in the export environment, which has Torch and the
original DanLM macOS classes. Inference workers never import these references.
"""
import importlib.util
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'server/bots'), str(ROOT / '.guandan/DanLM/ui')]
os.environ['GUANDAN_SRC'] = str(ROOT / '.guandan/DanLM')
import guandan_worker as guandan
import douzero_worker as douzero
from ui_agent import UIAgent
from danzero.engine.tribute import TributeRecord
from douzero.env.env import Env, get_obs


def main():
    torch.set_num_threads(2)
    torch.set_grad_enabled(False)
    rng = np.random.default_rng(20261018)
    report = {}

    def compare(name, old, new, metrics):
        error = float(np.max(np.abs(old - new)))
        metrics['maxAbsError'] = max(metrics['maxAbsError'], error)
        metrics['decisions'] += 1
        np.testing.assert_allclose(new, old, rtol=1e-4, atol=1e-5, err_msg=name)
        if np.argmax(old) != np.argmax(new):
            raise AssertionError(f'{name}: different best action')

    for key in ['danlm_v1', 'danzero_v1t']:
        reference, runtime = UIAgent(key), guandan.agent_for(key)
        metrics = {'decisions': 0, 'maxAbsError': 0.0, 'deals': 0, 'oldMs': [], 'newMs': []}
        for level in [2, 7, 14]:
            for tribute in [False, True]:
                deck = np.repeat(np.arange(54), 2)
                rng.shuffle(deck)
                hands = np.asarray([np.bincount(row, minlength=54) for row in deck.reshape(4, 27)])
                reference.reset_round(level)
                runtime.reset_round(level)
                if tribute:
                    given, returned = int(deck[0]), int(deck[27])
                    records = [TributeRecord(0, 1, given), TributeRecord(1, 0, returned)]
                    for giver, receiver, card in [(0, 1, given), (1, 0, returned)]:
                        hands[giver, card] -= 1
                        hands[receiver, card] += 1
                    reference.notify_tribute(records)
                    runtime.notify_tribute(records)
                rnd = guandan.GuanDanRound(level=level, hands=hands, first_player=0, team_levels=(level, level))
                obs = rnd.get_observation()
                turns = 0
                while obs is not None:
                    start = time.perf_counter()
                    expected = reference.get_q_values(obs, rnd)
                    metrics['oldMs'].append((time.perf_counter() - start) * 1000)
                    start = time.perf_counter()
                    actual = runtime.get_q_values(obs, rnd)
                    metrics['newMs'].append((time.perf_counter() - start) * 1000)
                    compare(key, expected, actual, metrics)
                    index = int(np.argmax(actual))
                    player, vector = int(obs.player), np.array(obs.legal_plays[index], copy=True)
                    obs = rnd.step(index)
                    reference.observe_action(player, vector, obs is not None and bool(obs.is_leading))
                    turns += 1
                    if turns > 600:
                        raise AssertionError(f'{key}: deal did not finish')
                metrics['deals'] += 1
        report[key] = metrics
        print(key, metrics['decisions'], 'decisions; max error', metrics['maxAbsError'], flush=True)

    spec = importlib.util.spec_from_file_location('official_models', ROOT / '.douzero/douzero-src/douzero/dmc/models.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    models = douzero.load_models()
    references = {}
    for role in douzero.ROLES:
        model = module.model_dict[role]()
        model.load_state_dict(torch.load(ROOT / f'.douzero/weights/douzero_WP/{role}.ckpt', map_location='cpu', weights_only=True))
        references[role] = model.eval()
        report[role] = {'decisions': 0, 'maxAbsError': 0.0, 'oldMs': [], 'newMs': []}
    np.random.seed(20261018)
    for _ in range(6):
        env = Env('wp')
        env.reset()
        turns = 0
        while not env._game_over:
            role = env.infoset.player_position
            obs = get_obs(env.infoset)
            start = time.perf_counter()
            expected = references[role](torch.from_numpy(obs['z_batch']).float(), torch.from_numpy(obs['x_batch']).float(), return_value=True)['values'].numpy().reshape(-1)
            report[role]['oldMs'].append((time.perf_counter() - start) * 1000)
            start = time.perf_counter()
            actual = models[role].scores(obs)
            report[role]['newMs'].append((time.perf_counter() - start) * 1000)
            compare(role, expected, actual, report[role])
            ranked, _, _, _ = douzero.choose(models[role], env.infoset)
            assert ranked[0] == env.infoset.legal_actions[int(np.argmax(expected))]
            env.step(ranked[0])
            turns += 1
            if turns > 600:
                raise AssertionError('DouZero deal did not finish')
    for metrics in report.values():
        for key in ['oldMs', 'newMs']:
            metrics[key] = {'p50': float(np.percentile(metrics[key], 50)), 'p95': float(np.percentile(metrics[key], 95))}
        metrics['allArgmaxSame'] = True
    output = ROOT / '.ai/parity-report.json'
    output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
