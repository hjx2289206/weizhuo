import type { GameKind, Snapshot } from '../shared/protocol'
import { GAME_DEFINITIONS, isBlackFirstGame, isBoardGame, isGameKind } from '../shared/gameCatalog'
import { junqiCoordinate, junqiSideName, junqiTeamName } from '../shared/junqi'
import { chessCoordinate, chessSideName } from '../shared/chess'
import { xiangqiCoordinate, xiangqiSideName } from '../shared/xiangqi'
import { reversiSideName } from '../shared/reversi'
import { scoreGame } from '../shared/doudizhu'
import { ICON_PATHS } from './icons'
import { bottomCardText, rankGlyph } from './screens/cardText'

export interface ResultRecord {
  key: string
  code: string
  game: GameKind
  date: string
  title: string
  detail: string
  players: { name: string; seat: number; delta?: number; total?: number }[]
  junqiVariant?: 'two' | 'four'
  plays: { seat: number; name: string; cards: string }[]
}
export const RESULT_HISTORY_KEY = 'tabletop:results:v1'
export const HISTORY_LIMIT = 100

/** Deliberately project only public information; never persist a snapshot or credential. */
export function resultFromSnapshot(snapshot: Snapshot, date = new Date().toISOString()): ResultRecord | null {
  if (snapshot.phase !== 'finished') return null
  if (snapshot.game === 'go' || snapshot.game === 'gomoku') {
    const x = snapshot.stones
    return { key: `${snapshot.code}:${snapshot.game}:${x.roundId}`, code: snapshot.code, game: snapshot.game, date,
      title: x.draw ? '和棋' : `${x.winner === 0 ? '黑方' : '白方'}获胜`, detail: `${x.size} 路 · ${x.reason} · 共 ${x.moves.length} 手`,
      players: snapshot.seats.map(player => ({ name: player.name ?? (player.id === 0 ? '黑方' : '白方'), seat: player.id })),
      plays: x.moves.map(move => ({ seat: move.side, name: move.side === 0 ? '黑方' : '白方', cards: move.notation })) }
  }
  if (snapshot.game === 'reversi') {
    const game = snapshot.reversi
    return { key: snapshot.code + ':reversi:' + game.roundId, code: snapshot.code, game: 'reversi', date,
      title: game.draw ? '和棋' : reversiSideName(game.winner!) + '获胜',
      detail: '黑 ' + game.counts[0] + ' 子 · 白 ' + game.counts[1] + ' 子 · ' + game.reason + ' · 共 ' + game.moves.length + ' 手',
      players: snapshot.seats.map(player => ({ name: player.name ?? reversiSideName(player.id), seat: player.id })),
      plays: game.moves.map(move => ({ seat: move.side, name: reversiSideName(move.side), cards: move.notation })) }
  }
  if (snapshot.game === 'chess') {
    const x = snapshot.chess
    return { key: `${snapshot.code}:chess:${x.roundId}`, code: snapshot.code, game: 'chess', date,
      title: x.draw ? '和棋' : `${chessSideName(x.winner!)}获胜`, detail: `${x.reason} · 共 ${x.moves.length} 手`,
      players: snapshot.seats.map(player => ({ name: player.name ?? chessSideName(player.id), seat: player.id })),
      plays: x.moves.map(move => ({ seat: move.side, name: chessSideName(move.side), cards: `${move.notation} · ${chessCoordinate(move.from)} → ${chessCoordinate(move.to)}${move.check ? ' · 将军' : ''}` })) }
  }
  if (snapshot.game === 'xiangqi') {
    const x = snapshot.xiangqi
    return { key: `${snapshot.code}:xiangqi:${x.roundId}`, code: snapshot.code, game: 'xiangqi', date,
      title: x.draw ? '和棋' : `${xiangqiSideName(x.winner!)}获胜`, detail: `${x.reason} · 共 ${x.moves.length} 步`,
      players: snapshot.seats.map(player => ({ name: player.name ?? `玩家${player.id + 1}`, seat: player.id })),
      plays: x.moves.map(move => ({ seat: move.side, name: xiangqiSideName(move.side), cards: `${move.notation} · ${xiangqiCoordinate(move.from)} → ${xiangqiCoordinate(move.to)}${move.check ? ' · 将军' : ''}` })) }
  }
  if (snapshot.game === 'junqi') {
    const j = snapshot.junqi
    const winner = j.variant === 'four' ? junqiTeamName(j.winnerTeam ?? 0, j.variant) : snapshot.seats.find(p => p.id === j.winner)?.name ?? junqiSideName(j.winner ?? 0)
    return { key: `${snapshot.code}:junqi:${j.roundId}`, code: snapshot.code, game: 'junqi', date,
      junqiVariant: j.variant,
      title: j.draw ? '军棋和棋' : `${winner}获胜`, detail: `${j.variant === 'four' ? '四国四暗' : '双人暗棋'} · ${j.reason} · 共 ${j.moves.length} 步`,
      players: snapshot.seats.map(p => ({ name: p.name ?? `玩家${p.id + 1}`, seat: p.id })),
      plays: j.moves.map(m => ({ seat: m.side, name: junqiSideName(m.side), cards: `${junqiCoordinate(m.from, j.variant)} → ${junqiCoordinate(m.to, j.variant)} · ${{ move: '行军', attacker: '进攻方胜', defender: '防守方胜', both: '同归于尽' }[m.outcome]}` })),
    }
  }
  if (snapshot.tablePlays.length === 0) return null
  const last = snapshot.tablePlays.at(-1)!
  const players: ResultRecord['players'] = snapshot.seats.map(s => ({ name: s.name ?? `${s.id + 1} 号座`, seat: s.id }))
  let title: string
  let detail: string
  if (snapshot.game === 'doudizhu') {
    if (snapshot.winner === null || snapshot.landlord === null) return null
    title = snapshot.winner === 'landlord' ? '地主获胜' : '农民获胜'
    const deltas = scoreGame({ winner: snapshot.winner, landlord: snapshot.landlord, bid: snapshot.bid, multiplier: snapshot.multiplier })
    for (const player of players) {
      player.delta = deltas[player.seat] ?? 0
      player.total = snapshot.scores[player.seat] ?? 0
    }
    const landlordPlays = snapshot.tablePlays.filter(p => p.seatId === snapshot.landlord).length
    const spring = snapshot.winner === 'landlord' && landlordPlays === snapshot.tablePlays.length ? ' · 春天' : snapshot.winner === 'farmers' && landlordPlays === 1 ? ' · 反春天' : ''
    detail = `叫分 ${snapshot.bid} × 最终倍数 ${snapshot.multiplier} = ${snapshot.bid * snapshot.multiplier}；地主按 2 份、农民各 1 份结算${spring ? `${spring}（已计入最终倍数）` : ''}`
  } else {
    const result = snapshot.guandan.result
    if (!result) return null
    title = `${result.winnerTeam === 0 ? '1、3 号座' : '2、4 号座'}获胜 · 升 ${result.upgrade} 级`
    if (snapshot.guandan.matchWinner !== null) title += ' · 过 A 赢得整场'
    detail = `第 ${snapshot.guandan.deal} 副 · 名次 ${result.order.map(s => players.find(p => p.seat === s)?.name ?? `${s + 1} 号座`).join(' → ')}${result.doubleDown ? '（双下）' : ''} · 级数 ${result.levelsBefore.map(rankGlyph).join(' / ')} → ${result.levelsAfter.map(rankGlyph).join(' / ')}`
  }
  return {
    key: `${snapshot.code}:${snapshot.game}:${snapshot.tablePlays[0]!.id}:${last.id}`,
    code: snapshot.code, game: snapshot.game, date, title, detail, players,
    plays: snapshot.tablePlays.map(p => ({ seat: p.seatId, name: players.find(s => s.seat === p.seatId)?.name ?? `${p.seatId + 1} 号座`, cards: p.cards.map(c => bottomCardText(c).text).join(' ') })),
  }
}

export function appendResult(history: ResultRecord[], record: ResultRecord): ResultRecord[] {
  return [record, ...history.filter(r => r.key !== record.key)].slice(0, HISTORY_LIMIT)
}

export function readResults(storage: Pick<Storage, 'getItem'>): ResultRecord[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(RESULT_HISTORY_KEY) ?? '[]')
    if (!Array.isArray(value)) return []
    return value.filter((r): r is ResultRecord => !!r && typeof r.key === 'string' && typeof r.code === 'string'
      && isGameKind(r.game) && typeof r.date === 'string' && typeof r.title === 'string' && typeof r.detail === 'string'
      && Array.isArray(r.players) && r.players.every((p: ResultRecord['players'][number]) => p && typeof p.name === 'string' && Number.isInteger(p.seat))
      && Array.isArray(r.plays) && r.plays.every((p: ResultRecord['plays'][number]) => p && typeof p.name === 'string' && typeof p.cards === 'string' && Number.isInteger(p.seat))).slice(0, HISTORY_LIMIT)
  } catch { return [] }
}

export function resultSeatLabel(game: GameKind, seat: number): string {
  if (isBlackFirstGame(game)) return reversiSideName(seat)
  if (game === 'chess') return chessSideName(seat)
  if (game === 'xiangqi') return xiangqiSideName(seat)
  if (game === 'junqi') return junqiSideName(seat)
  return seat % 2 === 0 ? '1、3 号座' : '2、4 号座'
}

export async function exportResultImage(record: ResultRecord): Promise<void> {
  const canvas = document.createElement('canvas')
  canvas.width = 1100
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器无法生成战绩图片')
  ctx.font = '20px sans-serif'
  const lines: string[] = []
  let line = ''
  for (const glyph of record.detail) {
    if (ctx.measureText(line + glyph).width > 950) { lines.push(line); line = '' }
    line += glyph
  }
  if (line) lines.push(line)
  canvas.height = 410 + lines.length * 29 + record.players.length * 82
  ctx.fillStyle = '#f4f0e5'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.strokeStyle = '#d4d6c5'
  ctx.lineWidth = 1
  ctx.strokeRect(30, 30, canvas.width - 60, canvas.height - 60)
  ctx.fillStyle = '#244b3c'
  ctx.font = '25px sans-serif'
  ctx.fillText('桌游合集', 70, 84)
  ctx.textAlign = 'right'
  ctx.font = '19px sans-serif'
  ctx.fillText(`${GAME_DEFINITIONS[record.game].name} · 房间 ${record.code}`, 1030, 84)
  ctx.textAlign = 'left'
  ctx.beginPath(); ctx.moveTo(70, 110); ctx.lineTo(1030, 110); ctx.stroke()
  ctx.fillStyle = '#eee6d0'; ctx.beginPath(); ctx.arc(109, 175, 35, 0, Math.PI * 2); ctx.fill()
  ctx.strokeStyle = '#c5ad75'; ctx.stroke()
  ctx.save(); ctx.translate(92, 157); ctx.scale(1.5, 1.5)
  ctx.strokeStyle = '#92713b'; ctx.lineWidth = 1.3; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
  for (const path of ICON_PATHS.trophy) ctx.stroke(new Path2D(path))
  ctx.restore()
  ctx.fillStyle = '#244b3c'; ctx.font = 'bold 36px sans-serif'
  ctx.fillText(record.title.split(' · ')[0]!, 166, 178, 830)
  ctx.fillStyle = '#657461'; ctx.font = '17px sans-serif'
  ctx.fillText('本局结算', 168, 207)
  ctx.font = '20px sans-serif'
  let y = 255
  for (const text of lines) { ctx.fillText(text, 70, y); y += 29 }
  y += 15
  ctx.fillStyle = '#e9ecdf'; ctx.fillRect(70, y, 960, 38)
  ctx.fillStyle = '#657461'; ctx.font = '17px sans-serif'
  ctx.fillText('玩家', 90, y + 26)
  ctx.textAlign = 'right'
  ctx.fillText(record.game === 'doudizhu' ? '本局' : isBoardGame(record.game) ? '执方' : '搭档', 810, y + 26)
  if (record.game === 'doudizhu') ctx.fillText('累计', 1008, y + 26)
  ctx.textAlign = 'left'; y += 38
  for (const player of record.players) {
    ctx.fillStyle = '#faf9f0'; ctx.fillRect(70, y, 960, 82)
    ctx.strokeStyle = '#dce0cf'; ctx.beginPath(); ctx.moveTo(70, y + 82); ctx.lineTo(1030, y + 82); ctx.stroke()
    ctx.fillStyle = '#e8ecdd'; ctx.beginPath(); ctx.arc(110, y + 40, 21, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = '#52694a'; ctx.font = '22px sans-serif'; ctx.textAlign = 'center'
    ctx.fillText(player.name.slice(0, 1), 110, y + 48)
    ctx.textAlign = 'left'; ctx.fillStyle = '#244b3c'; ctx.font = '24px sans-serif'
    ctx.fillText(player.name, 151, y + 39, 500)
    ctx.fillStyle = '#657461'; ctx.font = '15px sans-serif'; ctx.fillText(`${player.seat + 1} 号座`, 153, y + 62)
    ctx.textAlign = 'right'; ctx.font = '26px Georgia, serif'
    ctx.fillStyle = (player.delta ?? 0) > 0 ? '#365e3e' : '#77695c'
    ctx.fillText(player.delta !== undefined ? `${player.delta > 0 ? '+' : ''}${player.delta}` : resultSeatLabel(record.game, player.seat), 810, y + 49)
    if (player.total !== undefined) { ctx.fillStyle = '#657461'; ctx.font = '22px sans-serif'; ctx.fillText(String(player.total), 1008, y + 49) }
    ctx.textAlign = 'left'; y += 82
  }
  ctx.fillStyle = '#657461'; ctx.font = '16px sans-serif'
  ctx.fillText(new Date(record.date).toLocaleString('zh-CN'), 70, canvas.height - 58)
  ctx.textAlign = 'right'; ctx.fillText('桌游合集 · 聚一局好牌', 1030, canvas.height - 58)
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('图片生成失败')), 'image/png'))
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `桌游战绩-${record.code}-${record.date.slice(0, 10)}.png`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
