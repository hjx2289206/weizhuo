import type { GameKind } from '../../shared/protocol'
import { isStoneGame } from '../../shared/gameCatalog'
import { TUTORIAL_VERSION, type TeachingClip, type TeachingLevel, type TeachingRequest, type TeachingState } from '../../shared/tutorialProtocol'
import { buildReversiClips } from './reversi'
import { buildStoneClips } from './stones'
import { doudizhuCourse } from './doudizhu'
import { guandanCourse } from './guandan'
import { chessCourse } from './chess'
import { xiangqiCourse } from './xiangqi'
import { junqiCourse } from './junqi'
import type { TeachingCourse } from './model'
import { buildClips } from './clips'

const courses = new Map<GameKind, TeachingCourse>(), clips = new Map<GameKind, TeachingClip[]>()
export function teachingCourse(game: GameKind): TeachingCourse {
  let course = courses.get(game)
  if (!course) { course = isStoneGame(game) || game === 'reversi' ? { game, matches: [] } : game === 'chess' ? chessCourse() : game === 'xiangqi' ? xiangqiCourse() : game === 'doudizhu' ? doudizhuCourse() : game === 'guandan' ? guandanCourse() : junqiCourse(); courses.set(game, course) }
  return course
}
export function teachingClips(game: GameKind): TeachingClip[] {
  let value = clips.get(game)
  if (!value) { value = game === 'reversi' ? buildReversiClips() : isStoneGame(game) ? buildStoneClips(game) : buildClips(teachingCourse(game)); clips.set(game, value) }
  return value
}

/** Viewing only: every clip is an immutable engine replay, never a practice room. */
export class TeachingSession {
  private readonly clips: TeachingClip[]
  private index = 0
  private version = 0
  private seen = new Set<string>()
  constructor(readonly game: GameKind, resume?: string, readonly level: TeachingLevel = 'basic') {
    this.clips = teachingClips(game).filter(clip => game !== 'go' || (clip.level ?? 'basic') === level)
    if (resume) this.index = Math.max(0, this.clips.findIndex(clip => clip.id === resume))
  }
  state(id = 'initial'): TeachingState {
    return { type: 'tutorial-state', id, version: this.version, courseVersion: TUTORIAL_VERSION, game: this.game,
      index: this.index, total: this.clips.length, clips: this.clips.map(({ id, title, chapter, tags, level }) => ({ id, title, chapter, tags, level })), clip: this.clips[this.index]!, ...(this.game === 'go' ? { level: this.level } : {}) }
  }
  start(id = 'start'): TeachingState { return this.state(id) }
  request(request: TeachingRequest): TeachingState {
    if (!request.id || this.seen.has(request.id)) throw new Error('这次请求已经处理')
    if (request.version !== this.version) throw new Error('教程片段已变化，请重新选择')
    if (request.type !== 'scene') throw new Error('动画教程只支持观看和选段，无需出牌或行棋')
    const index = this.clips.findIndex(clip => clip.id === request.clipId)
    if (index < 0) throw new Error('没有这个教学片段')
    this.seen.add(request.id)
    if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value!)
    this.index = index; this.version++
    return this.state(request.id)
  }
}
