// Server-only hint generators. They enumerate a bounded, deterministic set of legal plays and
// order them "cheapest first": no bombs/rockets unless nothing ordinary works, low main ranks
// before high ones, and attachments that do not break a four-of-a-kind or the joker pair.
//
// Both generators are pure. The room still owns turns; the engine only calls these after checking
// phase/turn, and the normal play command revalidates every suggested card.

import type { Card, GuandanDeclaration, GuandanKind, HintPlay } from '../shared/protocol';
import { kindLabel } from '../shared/protocol';
import {
  GUANDAN_LEVELS,
  enumerateGuandanPlays,
  guandanRankStrength,
  isGuandanWild,
  sortGuandanHand,
  strongestGuandanOption,
  type GuandanOption,
} from '../shared/guandan';
import { canBeat, detectPlay, sortHand, type PlayKind } from './rules';

const MAX_HINTS = 60;

function idsOf(cards: readonly Card[]): string[] {
  return cards.map((card) => card.id);
}

function dedupeKey(cards: readonly Card[]): string {
  return idsOf(cards).sort().join(',');
}

// ---------------------------------------------------------------- Doudizhu

interface DdzCandidate {
  cards: Card[];
  play: PlayKind;
}

function ddzBreakCost(cards: readonly Card[], handCounts: ReadonlyMap<number, number>): number {
  const used = new Map<number, number>();
  for (const card of cards) used.set(card.rank, (used.get(card.rank) ?? 0) + 1);
  let cost = 0;
  for (const [rank, count] of used) {
    const total = handCounts.get(rank) ?? 0;
    // Using part of a rank that holds a bomb destroys a real option; taking one card from a
    // triple or pair is cheaper but still worth avoiding when another single exists.
    if (rank < 16 && total === 4 && count < 4) cost += 3;
    else if (rank < 16 && total === 3 && count < 3) cost += 1;
    if (rank >= 16) cost += 1;
  }
  if ((handCounts.get(16) ?? 0) === 1 && (handCounts.get(17) ?? 0) === 1) {
    const usedJokers = (used.get(16) ?? 0) + (used.get(17) ?? 0);
    if (usedJokers === 1) cost += 2; // broke the rocket for one joker
  }
  return cost;
}

const DDZ_KIND_ORDER: Record<string, number> = {
  single: 0,
  pair: 1,
  triple: 2,
  triple_single: 3,
  triple_pair: 4,
  straight: 5,
  pairs_run: 6,
  triples_run: 7,
  airplane_single: 8,
  airplane_pair: 9,
  four_two_single: 10,
  four_two_pair: 11,
  bomb: 12,
  rocket: 13,
};

function ddzWeight(cards: readonly Card[]): number {
  return cards.reduce((sum, card) => sum + card.rank, 0);
}

export function doudizhuHints(hand: readonly Card[], last: PlayKind | null): HintPlay[] {
  const sorted = sortHand([...hand]);
  const byRank = new Map<number, Card[]>();
  for (const card of sorted) {
    const bucket = byRank.get(card.rank);
    if (bucket) bucket.push(card);
    else byRank.set(card.rank, [card]);
  }
  const handCounts = new Map<number, number>();
  for (const [rank, cards] of byRank) handCounts.set(rank, cards.length);
  const ranks = [...byRank.keys()].sort((a, b) => a - b);
  const lead = last === null;
  const followKind = last?.kind ?? null;
  const followLength = last?.length ?? 0;
  const candidates = new Map<string, DdzCandidate>();
  const rocket = [...(byRank.get(16) ?? []), ...(byRank.get(17) ?? [])];

  function add(cards: Card[]): void {
    if (cards.length === 0 || cards.length > hand.length) return;
    if (new Set(cards.map((card) => card.id)).size !== cards.length) return;
    const play = detectPlay(cards);
    if (!play) return;
    if (!canBeat(play, last)) return;
    // When following, only same-shape ordinary plays and bombs/rockets are useful. This also
    // prevents a generated straight from being read as a lower-value shape after wing juggling.
    if (!lead && play.kind !== 'bomb' && play.kind !== 'rocket' &&
        (followKind !== play.kind || play.length !== followLength)) return;
    const key = dedupeKey(cards);
    const current = candidates.get(key);
    if (current) {
      // Same physical set: keep the reading that actually beats the cursor. detectPlay is
      // deterministic, so this only guards against future shape changes.
      if (!canBeat(current.play, last) && canBeat(play, last)) candidates.set(key, { cards, play });
      return;
    }
    candidates.set(key, { cards, play });
  }

  function pickRank(rank: number, count: number): Card[] {
    return (byRank.get(rank) ?? []).slice(0, count);
  }

  function pickCheapest(pool: readonly Card[], count: number, maxPerRank = 99): Card[] | null {
    const ordered = [...pool].sort((a, b) => {
      const ca = ddzBreakCost([a], handCounts) * 100 + a.rank;
      const cb = ddzBreakCost([b], handCounts) * 100 + b.rank;
      return ca - cb || a.rank - b.rank;
    });
    const out: Card[] = [];
    const perRank = new Map<number, number>();
    for (const card of ordered) {
      if (out.length >= count) break;
      const used = perRank.get(card.rank) ?? 0;
      if (used >= maxPerRank) continue;
      // A joker may never pair with another joker as a wing in Doudizhu; only one copy exists.
      if (card.rank >= 16 && used >= 1) continue;
      out.push(card);
      perRank.set(card.rank, used + 1);
    }
    return out.length === count ? out : null;
  }

  function pairRanksOutside(excluded: ReadonlySet<number>, count: number): number[][] {
    const options = ranks
      .filter((rank) => rank < 16 && !excluded.has(rank) && (byRank.get(rank)?.length ?? 0) >= 2)
      .sort((a, b) => a - b);
    const result: number[][] = [];
    // Generate the cheapest few pair combinations so the user can cycle without a combinatorial
    // explosion. One combination is enough for a hint; two covers most real hands.
    function walk(start: number, chosen: number[]): void {
      if (result.length >= count) return;
      if (chosen.length === 2) {
        result.push([...chosen]);
        return;
      }
      for (let index = start; index < options.length; index += 1) walk(index + 1, [...chosen, options[index]]);
    }
    walk(0, []);
    return result;
  }

  // Singles and groups.
  for (const rank of ranks) {
    add(pickRank(rank, 1));
    if ((byRank.get(rank)?.length ?? 0) >= 2) add(pickRank(rank, 2));
    if (rank < 16 && (byRank.get(rank)?.length ?? 0) >= 3) add(pickRank(rank, 3));
    if (rank < 16 && (byRank.get(rank)?.length ?? 0) === 4) add(pickRank(rank, 4));
  }
  if (rocket.length === 2) add(rocket);

  // Triple + wing(s).
  for (const rank of ranks) {
    if (rank >= 16 || (byRank.get(rank)?.length ?? 0) < 3) continue;
    const body = pickRank(rank, 3);
    const used = new Set(body.map((card) => card.id));
    const outside = sorted.filter((card) => !used.has(card.id));
    const single = pickCheapest(outside, 1);
    if (single) add([...body, ...single]);
    const pairRank = ranks.find(
      (candidate) => candidate < 16 && candidate !== rank && (byRank.get(candidate)?.length ?? 0) >= 2,
    );
    if (pairRank !== undefined) add([...body, ...pickRank(pairRank, 2)]);
  }

  // Straights and consecutive groups.
  const straightLengths = lead ? [5, 6, 7, 8, 9, 10, 11, 12] : [followLength];
  if (lead || followKind === 'straight' || followKind === 'pairs_run' || followKind === 'triples_run' ||
      followKind === 'airplane_single' || followKind === 'airplane_pair') {
    for (const length of straightLengths) {
      if (length < 5) continue;
      for (let start = 3; start + length - 1 <= 14; start += 1) {
        const window: number[] = [];
        for (let rank = start; rank < start + length; rank += 1) window.push(rank);
        if (!window.every((rank) => (byRank.get(rank)?.length ?? 0) >= 1)) continue;
        add(window.flatMap((rank) => pickRank(rank, 1)));
      }
    }
  }
  const pairLengths = lead ? [6, 8, 10, 12, 14, 16, 18, 20] : [followLength];
  for (const length of pairLengths) {
    if (length < 6 || length % 2 !== 0) continue;
    const span = length / 2;
    for (let start = 3; start + span - 1 <= 14; start += 1) {
      const window: number[] = [];
      for (let rank = start; rank < start + span; rank += 1) window.push(rank);
      if (!window.every((rank) => (byRank.get(rank)?.length ?? 0) >= 2)) continue;
      add(window.flatMap((rank) => pickRank(rank, 2)));
    }
  }
  const tripleLengths = lead ? [6, 9, 12, 15, 18] : [followLength];
  for (const length of tripleLengths) {
    if (length < 6 || length % 3 !== 0) continue;
    const span = length / 3;
    for (let start = 3; start + span - 1 <= 14; start += 1) {
      const window: number[] = [];
      for (let rank = start; rank < start + span; rank += 1) window.push(rank);
      if (!window.every((rank) => (byRank.get(rank)?.length ?? 0) >= 3)) continue;
      add(window.flatMap((rank) => pickRank(rank, 3)));
    }
  }

  // Airplane with single wings.
  if (lead || followKind === 'airplane_single') {
    const sizes = lead ? [2, 3, 4, 5] : [followLength / 4];
    for (const k of sizes) {
      if (!Number.isInteger(k) || k < 2) continue;
      const need = 4 * k;
      if (need > hand.length) continue;
      for (let start = 3; start + k - 1 <= 14; start += 1) {
        const bodyRanks: number[] = [];
        for (let rank = start; rank < start + k; rank += 1) bodyRanks.push(rank);
        if (!bodyRanks.every((rank) => (byRank.get(rank)?.length ?? 0) >= 3)) continue;
        const body = bodyRanks.flatMap((rank) => pickRank(rank, 3));
        const used = new Set(body.map((card) => card.id));
        const outside = sorted.filter((card) => !used.has(card.id));
        // A wing rank may appear at most twice; prefer low cards and never touch a bomb.
        const wings = pickCheapest(outside, k, 2);
        if (wings) add([...body, ...wings]);
      }
    }
  }

  // Airplane with pair wings.
  if (lead || followKind === 'airplane_pair') {
    const sizes = lead ? [2, 3, 4] : [followLength / 5];
    for (const k of sizes) {
      if (!Number.isInteger(k) || k < 2) continue;
      const need = 5 * k;
      if (need > hand.length) continue;
      for (let start = 3; start + k - 1 <= 14; start += 1) {
        const bodyRanks: number[] = [];
        for (let rank = start; rank < start + k; rank += 1) bodyRanks.push(rank);
        if (!bodyRanks.every((rank) => (byRank.get(rank)?.length ?? 0) >= 3)) continue;
        const body = bodyRanks.flatMap((rank) => pickRank(rank, 3));
        const bodySet = new Set(body.map((card) => card.id));
        const excluded = new Set(bodyRanks);
        const pairOptions = ranks.filter(
          (rank) => rank < 16 && !excluded.has(rank) && (byRank.get(rank)?.length ?? 0) >= 2,
        );
        if (pairOptions.length < k) continue;
        const wings: Card[] = [];
        for (const rank of pairOptions.slice(0, k)) {
          const pair = pickRank(rank, 2).filter((card) => !bodySet.has(card.id));
          if (pair.length === 2) wings.push(...pair);
        }
        if (wings.length === 2 * k) add([...body, ...wings]);
      }
    }
  }

  // Four with two singles / two pairs.
  for (const rank of ranks) {
    if (rank >= 16 || (byRank.get(rank)?.length ?? 0) !== 4) continue;
    const body = pickRank(rank, 4);
    const used = new Set(body.map((card) => card.id));
    const outside = sorted.filter((card) => !used.has(card.id));
    const twoSingles = pickCheapest(outside, 2);
    if (twoSingles) add([...body, ...twoSingles]);
    const pairRanks = pairRanksOutside(new Set([rank]), 2);
    for (const pairChoice of pairRanks) {
      if (pairChoice.length !== 2) continue;
      add([...body, ...pairChoice.flatMap((pairRank) => pickRank(pairRank, 2))]);
    }
  }

  const list = [...candidates.values()].map(({ cards, play }) => {
    const bombTier = play.kind === 'rocket' ? 2 : play.kind === 'bomb' ? 1 : 0;
    return {
      cards,
      play,
      bombTier,
      breakCost: ddzBreakCost(cards, handCounts),
      weight: ddzWeight(cards),
    };
  });
  list.sort((a, b) =>
    a.bombTier - b.bombTier ||
    (DDZ_KIND_ORDER[a.play.kind] ?? 99) - (DDZ_KIND_ORDER[b.play.kind] ?? 99) ||
    a.breakCost - b.breakCost ||
    a.play.main - b.play.main ||
    a.cards.length - b.cards.length ||
    a.weight - b.weight ||
    dedupeKey(a.cards).localeCompare(dedupeKey(b.cards)),
  );
  return list.slice(0, MAX_HINTS).map(({ cards, play }) => ({
    cards: idsOf(cards),
    label: kindLabel(play.kind),
  }));
}

// ---------------------------------------------------------------- Guandan

interface GuandanCandidate {
  option: GuandanOption;
  breakCost: number;
  weight: number;
}

const GUANDAN_KIND_ORDER: Record<GuandanKind, number> = {
  single: 0,
  pair: 1,
  triple: 2,
  triplePair: 3,
  straight: 4,
  threePairs: 5,
  twoTriples: 6,
  bomb: 7,
  straightFlush: 8,
  fourJokers: 9,
};

function guandanTier(declaration: GuandanDeclaration): number {
  switch (declaration.kind) {
    case 'fourJokers':
      return 6;
    case 'bomb':
      if (declaration.count >= 6) return 5;
      return declaration.count === 5 ? 3 : 2;
    case 'straightFlush':
      return 4;
    default:
      return 1;
  }
}

function guandanCorePower(declaration: GuandanDeclaration, level: number): number {
  if (declaration.kind === 'straight' || declaration.kind === 'straightFlush' ||
      declaration.kind === 'threePairs' || declaration.kind === 'twoTriples') {
    return declaration.low ?? 0;
  }
  return guandanRankStrength(declaration.primaryRank, level);
}

function guandanBreakCost(cards: readonly Card[], hand: readonly Card[], level: number): number {
  const total = new Map<number, number>();
  for (const card of hand) total.set(card.rank, (total.get(card.rank) ?? 0) + 1);
  const used = new Map<number, number>();
  for (const card of cards) used.set(card.rank, (used.get(card.rank) ?? 0) + 1);
  let cost = 0;
  for (const [rank, count] of used) {
    const held = total.get(rank) ?? 0;
    if (rank < 16 && held >= 4 && count < 4) cost += 3;
    else if (rank < 16 && held === 3 && count < 3) cost += 1;
    if (rank >= 16) cost += 1;
  }
  cost += cards.filter((card) => isGuandanWild(card, level)).length * 1.5;
  return cost;
}

function guandanWeight(cards: readonly Card[], level: number): number {
  return cards.reduce((sum, card) => sum + guandanRankStrength(card.rank, level), 0);
}

function guandanWindowRanks(low: number, span: number): number[] {
  if (low === 1) {
    const ranks = [14];
    for (let index = 0; index < span - 1; index += 1) ranks.push(GUANDAN_LEVELS[index]);
    return ranks;
  }
  const start = low - 2;
  const ranks: number[] = [];
  for (let index = 0; index < span; index += 1) ranks.push(GUANDAN_LEVELS[start + index]);
  return ranks;
}

export function guandanHints(
  hand: readonly Card[],
  level: number,
  last: GuandanDeclaration | null,
): HintPlay[] {
  // Nothing beats four jokers; leave the player with the honest single option.
  if (last?.kind === 'fourJokers') return [];
  const sorted = sortGuandanHand([...hand], level);
  const wilds = sorted.filter((card) => isGuandanWild(card, level));
  const byRank = new Map<number, Card[]>();
  for (const card of sorted) {
    if (isGuandanWild(card, level)) continue; // wilds are only used to fill deficits
    const bucket = byRank.get(card.rank);
    if (bucket) bucket.push(card);
    else byRank.set(card.rank, [card]);
  }
  const ranks = [...byRank.keys()].sort((a, b) => a - b);
  const lead = last === null;
  const followKind = last?.kind ?? null;
  const found = new Map<string, GuandanCandidate>();

  function chooseGroups(groups: { rank: number; count: number }[]): Card[] | null {
    let wildIndex = 0;
    const out: Card[] = [];
    for (const group of groups) {
      const bucket = byRank.get(group.rank) ?? [];
      const natural = bucket.slice(0, group.count);
      const deficit = group.count - natural.length;
      if (deficit > 0) {
        if (group.rank >= 16) return null; // wildcards can never stand in for a joker
        if (wildIndex + deficit > wilds.length) return null;
        out.push(...natural, ...wilds.slice(wildIndex, wildIndex + deficit));
        wildIndex += deficit;
      } else {
        out.push(...natural);
      }
    }
    return out;
  }

  function add(cards: Card[] | null): void {
    if (!cards || cards.length === 0) return;
    if (new Set(cards.map((card) => card.id)).size !== cards.length) return;
    let options: GuandanOption[] = [];
    try {
      options = enumerateGuandanPlays(cards, level);
    } catch {
      return;
    }
    const option = strongestGuandanOption(options, level, last);
    if (option) {
      const declaration = option.declaration;
      const key = declaration.key;
      const candidate: GuandanCandidate = {
        option,
        breakCost: guandanBreakCost(option.cards, hand, level),
        weight: guandanWeight(option.cards, level),
      };
      const current = found.get(key);
      if (!current || candidate.breakCost < current.breakCost ||
          (candidate.breakCost === current.breakCost && candidate.weight < current.weight)) {
        found.set(key, candidate);
      }
    }
  }

  // Singles: one representative per face is enough, but duplicate faces keep the physical id
  // honest. Deduplication happens by declaration key below.
  for (const card of sorted) add([card]);

  // Pairs and triples, natural or wildcard-assisted.
  for (const rank of ranks) {
    if (rank < 16) {
      add(chooseGroups([{ rank, count: 2 }]));
      add(chooseGroups([{ rank, count: 3 }]));
    } else {
      // Joker pairs/triples are never formed with wildcards, but two identical jokers do pair.
      const bucket = byRank.get(rank) ?? [];
      if (bucket.length >= 2) add(bucket.slice(0, 2));
    }
  }
  if (wilds.length === 2) add([wilds[0], wilds[1]]); // two wildcards can name any pair rank

  // Three with two. Enumerate both ranks so a low triple does not consume the only high pair.
  if (lead || followKind === 'triplePair') {
    const pairRanks = [...GUANDAN_LEVELS, 16, 17];
    for (const tripleRank of GUANDAN_LEVELS) {
      for (const pairRank of pairRanks) {
        if (pairRank === tripleRank) continue;
        add(chooseGroups([
          { rank: tripleRank, count: 3 },
          { rank: pairRank, count: 2 },
        ]));
      }
    }
  }

  // Sequences and pair/triple runs.
  if (lead || followKind === 'straight' || followKind === 'straightFlush') {
    for (let low = 1; low <= 10; low += 1) {
      const window = guandanWindowRanks(low, 5);
      add(chooseGroups(window.map((rank) => ({ rank, count: 1 }))));
      for (const suit of ['spade', 'heart', 'club', 'diamond'] as const) {
        let wildIndex = 0;
        const cards: Card[] = [];
        let ok = true;
        for (const rank of window) {
          const natural = (byRank.get(rank) ?? []).find((card) => card.suit === suit);
          if (natural) cards.push(natural);
          else if (rank < 16 && wildIndex < wilds.length) cards.push(wilds[wildIndex++]);
          else { ok = false; break; }
        }
        if (ok) add(cards);
      }
    }
  }
  if (lead || followKind === 'threePairs') {
    for (let low = 1; low <= 12; low += 1) {
      add(chooseGroups(guandanWindowRanks(low, 3).map((rank) => ({ rank, count: 2 }))));
    }
  }
  if (lead || followKind === 'twoTriples') {
    for (let low = 1; low <= 13; low += 1) {
      add(chooseGroups(guandanWindowRanks(low, 2).map((rank) => ({ rank, count: 3 }))));
    }
  }

  // Bombs: every size from 4 to the physical maximum. They sort after ordinary plays.
  for (const rank of GUANDAN_LEVELS) {
    const natural = byRank.get(rank)?.length ?? 0;
    const max = rank === level ? 8 : Math.min(10, natural + wilds.length);
    for (let count = 4; count <= max; count += 1) {
      if (count <= natural + wilds.length) add(chooseGroups([{ rank, count }]));
    }
  }
  const jokers = sorted.filter((card) => card.rank >= 16);
  if (jokers.length === 4) add(jokers);

  const list = [...found.values()];
  list.sort((a, b) => {
    const tier = guandanTier(a.option.declaration) - guandanTier(b.option.declaration);
    if (tier !== 0) return tier;
    const aDecl = a.option.declaration;
    const bDecl = b.option.declaration;
    const kind = GUANDAN_KIND_ORDER[aDecl.kind] - GUANDAN_KIND_ORDER[bDecl.kind];
    if (kind !== 0) return kind;
    if (a.breakCost !== b.breakCost) return a.breakCost - b.breakCost;
    // A longer bomb outranks a shorter one before rank matters.
    if (aDecl.kind === 'bomb' && bDecl.kind === 'bomb' && aDecl.count !== bDecl.count) {
      return aDecl.count - bDecl.count;
    }
    const power = guandanCorePower(aDecl, level) - guandanCorePower(bDecl, level);
    if (power !== 0) return power;
    return a.weight - b.weight;
  });
  return list.slice(0, MAX_HINTS).map(({ option }) => ({
    cards: idsOf(option.cards),
    label: option.declaration.label,
    claim: option.declaration.key,
  }));
}
