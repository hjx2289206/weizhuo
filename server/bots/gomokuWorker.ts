import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'
import type { BoardAiDifficulty } from '../../shared/boardAi'
import { chooseGomokuMove, type GomokuPosition } from './gomokuAi'

interface SearchJob { position: GomokuPosition; difficulty: BoardAiDifficulty }

if (!isMainThread) {
  const { position, difficulty } = workerData as SearchJob
  parentPort!.postMessage(chooseGomokuMove(position, difficulty))
}

export function searchGomokuWorker(position: GomokuPosition, difficulty: BoardAiDifficulty, signal?: AbortSignal): Promise<number | null> {
  if (signal?.aborted) return Promise.reject(new Error('思考已取消'))
  return new Promise((resolve, reject) => {
    const job: SearchJob = { position, difficulty }
    const worker = new Worker(new URL(import.meta.url), { workerData: job })
    let aborting = false
    const cleanup = () => signal?.removeEventListener('abort', abort)
    const abort = () => {
      aborting = true
      cleanup()
      // Wait for the thread to exit before the policy releases its concurrency slot.
      void worker.terminate().then(() => reject(new Error('思考已取消')), reject)
    }
    worker.once('message', (point: number | null) => { cleanup(); if (!aborting) resolve(point) })
    worker.once('error', error => { cleanup(); if (!aborting) reject(error) })
    worker.once('exit', () => { cleanup(); if (!aborting) reject(new Error('五子棋搜索线程未返回结果')) })
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}
