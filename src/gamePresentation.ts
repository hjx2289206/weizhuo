import { GAME_KINDS } from '../shared/gameCatalog'
import type { GameKind } from '../shared/protocol'

export const GAME_NOTES: Record<GameKind, string> = {
  doudizhu: '3 人 · 1 副牌 · 地主对农民',
  guandan: '4 人 · 2 副牌 · 两两搭档',
  xiangqi: '双人同屏 / 联机 · 竖屏对弈',
  go: '9 / 13 / 19 路 · 数子法 · 基础 / 进阶教程',
  gomoku: '15 路无禁手 · 五子或以上连线获胜',
  reversi: '8×8 格 · 夹住翻子 · 子多者胜',
  chess: '双人同屏 / 联机 · 竖屏对弈',
  junqi: '双人 / 四国暗棋 · 竖屏对弈',
}

// The rules sheet puts the two chess games next to each other.
const tabs: GameKind[] = GAME_KINDS.filter(game => game !== 'chess')
tabs.splice(tabs.indexOf('xiangqi') + 1, 0, 'chess')
export const RULE_TABS: readonly GameKind[] = tabs
