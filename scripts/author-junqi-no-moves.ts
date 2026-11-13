// Offline course authoring. The emitted commands are replayed and checked by the normal engine.
import { writeFileSync } from 'node:fs'
import { JunqiGame } from '../server/games/junqi'
import { armyBoard, fullBoard } from '../server/tutorials/junqi'
import { junqiCombat, junqiDestinations, JUNQI_POWER, type JunqiRank } from '../shared/junqi'

const initial = armyBoard('two', [[30, 0, 'commander'], [25, 1, 'company'], [58, 0, 'flag'], [1, 1, 'flag']])
const distance = (a: number, b: number) => Math.abs(Math.floor(a / 5) - Math.floor(b / 5)) + Math.abs(a % 5 - b % 5)
for (let seed = 1; seed <= 100; seed++) {
  const game = new JunqiGame('two', () => initial); game.start()
  game.command(0, 'junqiSetup', { action: 'confirm' }); game.command(1, 'junqiSetup', { action: 'confirm' })
  const actions: { from: number; to: number }[] = [], seen = new Map<string, number>()
  for (let turn = 0; turn < 1600 && game.phase === 'playing'; turn++) {
    const side = game.view(0).turn!, board = fullBoard(game)
    const stateKey = board.map(piece => piece ? `${piece.side}${piece.rank}` : '-').join(',') + side
    seen.set(stateKey, (seen.get(stateKey) ?? 0) + 1)
    const options = board.flatMap((piece, from) => piece?.side === side ? junqiDestinations(board, from).flatMap(to => {
      const defender = board[to]
      if (defender?.rank === 'flag') return []
      const outcome = defender?.rank ? junqiCombat(piece.rank!, defender.rank) : null
      const targets = board.flatMap((other, point) => {
        if (!other?.rank || other.side === side || other.rank === 'flag' || other.rank === 'mine') return []
        const result = side === 0 ? junqiCombat(piece.rank!, other.rank) : junqiCombat(piece.rank!, other.rank)
        if (side === 0 ? result === 'defender' : result === 'attacker') return []
        return [point]
      })
      const nearest = (point: number) => Math.min(30, ...targets.map(target => distance(point, target)))
      let score = (nearest(from) - nearest(to)) * 8 - nearest(to) * .5
      if (defender) {
        if (side === 0) score += outcome === 'attacker' ? 150 + JUNQI_POWER[defender.rank!] * 10 : outcome === 'both' ? 90 + JUNQI_POWER[defender.rank!] * 3 : -500
        else score += outcome === 'defender' ? 250 + JUNQI_POWER[piece.rank!] * 10 : outcome === 'both' ? 180 : -200
      }
      const future = [...board]; future[from] = null
      if (outcome === null || outcome === 'attacker') future[to] = piece
      else if (outcome === 'both') future[to] = null
      const futureKey = future.map(p => p ? `${p.side}${p.rank}` : '-').join(',') + (1 - side)
      score -= (seen.get(futureKey) ?? 0) * 35
      score += (((from * 103 + to * 37 + turn * 11 + seed * 29) % 97) / 97) * (seed % 7 + 1)
      return [{ from, to, score }]
    }) : [])
    options.sort((a, b) => b.score - a.score)
    const move = options[0]
    if (!move) break
    const result = game.command(side, 'junqiMove', move)
    if (!result.ok) throw new Error(result.message)
    actions.push({ from: move.from, to: move.to })
  }
  const end = game.view(0).junqi
  if (end.reason === '对方无棋可走') {
    writeFileSync('server/tutorials/junqiNoMoves.json', JSON.stringify({ initial, actions, reason: end.reason, winner: end.winner }, null, 2) + '\n')
    console.log(JSON.stringify({ seed, moves: actions.length, winner: end.winner, reason: end.reason })); process.exit(0)
  }
}
throw new Error('No legal no-moves ending found')
