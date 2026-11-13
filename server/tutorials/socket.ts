import type { WebSocket } from 'ws'
import { TUTORIAL_VERSION, type TeachingRequest, type TeachingResponse } from '../../shared/tutorialProtocol'
import { TeachingSession } from './session'

/** One private teaching session per connection. No room, player token, collector or model bridge. */
export function connectTutorialSocket(socket: WebSocket): void {
  let session: TeachingSession | null = null
  const requests = new Set<string>()
  let alive = true
  socket.on('pong', () => { alive = true })
  const timer = setInterval(() => { if (!alive) socket.terminate(); else { alive = false; socket.ping() } }, 20000)
  timer.unref()
  const send = (message: TeachingResponse) => { if (socket.readyState === 1) socket.send(JSON.stringify(message)) }
  socket.on('message', raw => {
    let request: TeachingRequest | undefined
    try {
      const parsed = JSON.parse(String(raw))
      if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string' || parsed.id.length > 128 || typeof parsed.type !== 'string') throw new Error('教学消息格式不正确')
      request = parsed as TeachingRequest
      if (requests.has(request.id)) throw new Error('这次请求已经处理')
      requests.add(request.id)
      if (requests.size > 256) requests.delete(requests.values().next().value!)
      if (request!.type === 'exit') { session = null; socket.close(1000, 'tutorial exit'); return }
      if (request!.type === 'start') {
        const game = request!.game
        if (game !== 'doudizhu' && game !== 'guandan' && game !== 'junqi' && game !== 'xiangqi' && game !== 'chess' && game !== 'go' && game !== 'gomoku') throw new Error('未知的教学游戏')
        if (request.level !== undefined && request.level !== 'basic' && request.level !== 'advanced') throw new Error('未知的教程分区')
        const resume = request!.courseVersion === TUTORIAL_VERSION && typeof request!.clipId === 'string' ? request!.clipId : undefined
        session = new TeachingSession(game, resume, request.level); send(session.start(request!.id)); return
      }
      if (!session) throw new Error('请先开始教学对局')
      send(session.request(request!))
    } catch (reason) { send({ type: 'tutorial-error', id: request?.id, message: reason instanceof Error ? reason.message : '教学暂时无法继续' }) }
  })
  socket.on('close', () => { clearInterval(timer); session = null })
  socket.on('error', () => socket.close())
}
