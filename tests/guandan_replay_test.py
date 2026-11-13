"""Regression tests against the installed native DanLM engine, without loading weights."""
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("worker", ROOT / "server/bots/guandan_worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def card(rank, suit="spade"):
    return {"r": rank, "s": suit}


def play_row(seat, cards, kind="single", rank=None, leading=None):
    row = {"seat": seat, "cards": cards,
           "claim": {"kind": kind, "primaryRank": cards[0]["r"] if rank is None else rank}}
    if leading is not None:
        row["leading"] = leading
    return row


class Observer:
    def __init__(self):
        self.actions = []

    def observe_action(self, seat, vector, new_trick):
        self.actions.append((seat, worker.play_type_of(vector), new_trick))


class BorrowedLeadReplay(unittest.TestCase):
    def replay(self, head_cards, partner_cards, rows, stop_seat, leading):
        payload = {"deal": {"hands": [partner_cards, [card(5), card(6)], head_cards, [card(7), card(8)]]}}
        rnd = worker.GuanDanRound(
            level=2, hands=worker.hands_from_payload(payload), first_player=2, team_levels=(2, 2),
        )
        agent = Observer()
        obs = worker.replay_to_decision(agent, rnd, rnd.get_observation(), rows, stop_seat, leading)
        return obs, rnd, agent

    def test_legacy_room_can_pass_before_replaying_a_lower_borrowed_lead(self):
        # The 276J failure: a big-joker finish, then its partner leads a lower pair.
        rows = [play_row(2, [card(17, "joker")]),
                play_row(0, [card(3), card(3, "heart")], "pair")]
        obs, rnd, agent = self.replay(
            [card(17, "joker")], [card(3), card(3, "heart"), card(4)], rows, 1, False,
        )
        self.assertEqual(obs.player, 1)
        self.assertEqual(list(rnd.state.finish_order), [2])
        self.assertEqual([a[:2] for a in agent.actions],
                         [(2, "single"), (3, "pass"), (0, "pass"), (1, "pass"), (0, "double")])

    def test_explicit_boundary_distinguishes_a_legal_beat_from_a_new_lead(self):
        rows = [play_row(2, [card(3)], leading=True),
                play_row(0, [card(17, "joker")], leading=True)]
        obs, _, agent = self.replay([card(3)], [card(17, "joker"), card(4)], rows, 1, False)
        self.assertEqual(obs.player, 1)
        self.assertIn((0, "pass", False), agent.actions)
        self.assertEqual(len(agent.actions), 5)

    def test_current_decision_at_partner_waits_until_the_trick_is_cleared(self):
        rows = [play_row(2, [card(3)], leading=True)]
        obs, _, agent = self.replay([card(3)], [card(17, "joker"), card(4)], rows, 0, True)
        self.assertEqual(obs.player, 0)
        self.assertTrue(obs.is_leading)
        self.assertEqual([a[:2] for a in agent.actions],
                         [(2, "single"), (3, "pass"), (0, "pass"), (1, "pass")])

    def test_current_response_does_not_pass_past_the_first_visit(self):
        rows = [play_row(2, [card(3)], leading=True)]
        obs, _, agent = self.replay([card(3)], [card(17, "joker"), card(4)], rows, 0, False)
        self.assertEqual(obs.player, 0)
        self.assertFalse(obs.is_leading)
        self.assertEqual(len(agent.actions), 2)

    def test_corrupt_history_fails_without_passing_a_free_lead(self):
        rows = [play_row(2, [card(14)], leading=True)]
        with self.assertRaisesRegex(RuntimeError, "历史出牌"):
            self.replay([card(3)], [card(17, "joker"), card(4)], rows, 0, True)


class WildcardDeclarationReplay(unittest.TestCase):
    def test_fullhouse_replay_preserves_the_declared_triple_not_the_first_matching_cards(self):
        previous = [card(12), card(12, "club"), card(15, "club"),
                    card(15, "diamond"), card(15, "heart")]
        following = [card(13), card(13), card(13, "club"),
                     card(15, "club"), card(15, "diamond")]
        hands = [following + [card(3)], previous + [card(4)],
                 [card(5), card(6)], [card(7), card(8)]]
        rows = [play_row(1, previous, "triplePair", 12, True),
                play_row(0, following, "triplePair", 13, False)]
        rnd = worker.GuanDanRound(level=2, hands=worker.hands_from_payload({"deal": {"hands": hands}}),
                                 first_player=1, team_levels=(2, 2))
        obs = worker.replay_to_decision(Observer(), rnd, rnd.get_observation(), rows, 1, False)
        self.assertEqual(obs.player, 1)
        self.assertEqual(int(sum(obs.hand)), 1)
        # The exact PMVY cards were accepted after three Qs, not after three level 2s.
        self.assertFalse(obs.is_leading)

    def test_a_level_triple_fullhouse_is_not_silently_replayed_as_a_lower_one(self):
        previous = [card(12), card(12, "club"), card(15, "club"),
                    card(15, "diamond"), card(15, "heart")]
        following = [card(13), card(13), card(13, "club"),
                     card(15, "club"), card(15, "diamond")]
        hands = [following + [card(3)], previous + [card(4)],
                 [card(5), card(6)], [card(7), card(8)]]
        rows = [play_row(1, previous, "triplePair", 15, True),
                play_row(0, following, "triplePair", 13, False)]
        rnd = worker.GuanDanRound(level=2, hands=worker.hands_from_payload({"deal": {"hands": hands}}),
                                 first_player=1, team_levels=(2, 2))
        with self.assertRaisesRegex(RuntimeError, "历史出牌"):
            worker.replay_to_decision(Observer(), rnd, rnd.get_observation(), rows, 1, False)


if __name__ == "__main__":
    unittest.main()
