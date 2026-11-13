// Server-only randomness; rule interpretation is shared with the private hand UI.
import { randomInt } from 'node:crypto';
export * from '../shared/doudizhu';

export function shuffle<T>(cards: T[]): T[] {
  const out = cards.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}
