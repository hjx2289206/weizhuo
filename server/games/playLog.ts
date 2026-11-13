// Room-lifetime play stamping shared by every game engine: the id sequence never restarts (not even
// for a new deal) and the landing scatter is drawn exactly once per accepted play.

import { randomInt } from 'node:crypto';
import type { Card, GuandanDeclaration, TablePlay } from '../../shared/protocol';
import type { GameContext } from './types';

export function createPlayStamper(roomCode: string): GameContext {
  let seq = 0;
  return {
    stampPlay(seatId: number, cards: Card[], kind: string, claim?: GuandanDeclaration): TablePlay {
      seq += 1;
      const play: TablePlay = {
        id: `${roomCode}:${seq}`,
        seatId,
        cards,
        kind,
        ...(claim ? { claim } : {}),
        scatter: {
          x: randomInt(-45, 46) / 1000,
          y: randomInt(-45, 46) / 1000,
          angle: randomInt(-8, 9),
        },
      };
      // Accepted history is immutable: later snapshots, passes and resizes reuse this record verbatim.
      return Object.freeze(play);
    },
  };
}
