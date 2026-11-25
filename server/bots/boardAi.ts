import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Chess } from 'chess.js'
import { chessCoordinate, chessIndex, type ChessPromotion } from '../../shared/chess'
import { rewindXiangqiBoard, xiangqiDestinations, type XiangqiBoard } from '../../shared/xiangqi'
import { BOARD_AI_DIFFICULTIES, type BoardAiDifficulty, type BoardAiGame, type UciBoardAiGame } from '../../shared/boardAi'
import type { ChessGameFields, XiangqiGameFields } from '../../shared/protocol'
import { searchUci } from './uci'
import type { GomokuPosition } from './gomokuAi'
import { searchGomokuWorker } from './gomokuWorker'

export type BoardEngine = 'stockfish' | 'fairy' | 'pikafish'
export interface UciSearchPosition { kind: 'uci'; game: UciBoardAiGame; position: string; legalMoves: string[] }
export type BoardSearchPosition = UciSearchPosition | (GomokuPosition & { kind: 'gomoku'; game: 'gomoku' })
export interface UciBoardMove { kind: 'uci'; from: number; to: number; promotion?: ChessPromotion }
export type BoardAiMove = UciBoardMove | { kind: 'gomoku'; point: number }
export interface BoardAiPolicy {
  availability(game: BoardAiGame, difficulty: BoardAiDifficulty): { available: boolean; message: string | null }
  chooseMove(position: BoardSearchPosition, difficulty: BoardAiDifficulty, signal?: AbortSignal): Promise<BoardAiMove>
}
export interface EngineFile { path: string; sha256: string }
export interface BoardAiManifest {
  version: 1
  platform: string
  arch: string
  engines: Partial<Record<BoardEngine, { binary: EngineFile; network?: EngineFile; source: string; revision: string }>>
}
export const BOARD_AI_ROOT = resolve(process.env.BOARD_AI_DIR || join(dirname(fileURLToPath(import.meta.url)), '../../.board-ai'))
export const boardEngine = (game: UciBoardAiGame, level: BoardAiDifficulty): BoardEngine => game === 'chess' ? 'stockfish' : level === 'challenge' ? 'pikafish' : 'fairy'
/** Relative presets, intentionally without a human-Elo claim. Both time and nodes are bounded. */
export function boardAiProfile(game: UciBoardAiGame, level: BoardAiDifficulty) {
  const index = BOARD_AI_DIFFICULTIES.findIndex(item => item.id === level)
  return { skill: (game === 'chess' ? [0,3,8,14,20] : [-20,-8,4,14,20])[index]!, nodes: [300,1500,8000,40000,150000][index]!, movetime: [100,180,350,750,1500][index]! }
}
export const xiangqiUciSquare = (point: number) => `${'abcdefghi'[point%9]}${9-Math.floor(point/9)}`
export const xiangqiUciIndex = (square: string) => (9-Number(square[1]))*9+'abcdefghi'.indexOf(square[0]!)
/** Fairy's UCI uses ranks 1..10; Pikafish uses 0..9. Keep the room wire canonical. */
export function fairyXiangqiMove(move: string, direction: 1 | -1): string {
  const match = /^([a-i])(10|[0-9])([a-i])(10|[0-9])$/.exec(move)
  if (!match) throw new Error('Fairy-Stockfish 象棋坐标无效')
  const from=Number(match[2])+direction,to=Number(match[4])+direction
  if (from<(direction===1?1:0)||from>(direction===1?10:9)||to<(direction===1?1:0)||to>(direction===1?10:9)) throw new Error('Fairy-Stockfish 象棋坐标超出棋盘')
  return `${match[1]}${from}${match[3]}${to}`
}
export function xiangqiFen(board: XiangqiBoard, turn = 0): string {
  const names = { general:'k', advisor:'a', elephant:'b', horse:'n', rook:'r', cannon:'c', soldier:'p' }
  const rows = Array.from({length:10},(_,row)=>{ let text='',empty=0; for(const p of board.slice(row*9,row*9+9)) { if(!p)empty++;else {if(empty)text+=empty;empty=0;const name=names[p.rank];text+=p.side===0?name.toUpperCase():name} } return text+(empty||'') })
  return `${rows.join('/')} ${turn===0?'w':'b'} - - 0 1`
}
/** Keep the original position and complete legal history, including repetition and rights. */
export function boardSearchPosition(view: ChessGameFields | XiangqiGameFields): UciSearchPosition {
  if (view.game === 'chess') {
    const engine = new Chess(view.chess.fen), moves = view.chess.moves.map(m=>`${chessCoordinate(m.from)}${chessCoordinate(m.to)}${m.promotion??''}`)
    return { kind:'uci', game:'chess', position:`position fen ${view.chess.startFen}${moves.length?` moves ${moves.join(' ')}`:''}`, legalMoves:engine.moves({verbose:true}).map(m=>`${m.from}${m.to}${m.promotion??''}`) }
  }
  const initial = rewindXiangqiBoard(view.xiangqi.board, view.xiangqi.moves)
  const history = view.xiangqi.moves.map(m=>`${xiangqiUciSquare(m.from)}${xiangqiUciSquare(m.to)}`)
  const legalMoves = view.xiangqi.board.flatMap((p,from)=>p?.side===view.turn?xiangqiDestinations(view.xiangqi.board,from).map(to=>`${xiangqiUciSquare(from)}${xiangqiUciSquare(to)}`):[])
  return { kind:'uci', game:'xiangqi', position:`position fen ${xiangqiFen(initial)}${history.length?` moves ${history.join(' ')}`:''}`, legalMoves }
}
function decodeMove(game: UciBoardAiGame, move: string): UciBoardMove {
  if (!(game==='chess'?/^[a-h][1-8][a-h][1-8][qrbn]?$/:/^[a-i][0-9][a-i][0-9]$/).test(move)) throw new Error('引擎返回的走法格式无效')
  const index = game==='chess'?chessIndex:xiangqiUciIndex
  return { kind:'uci',from:index(move.slice(0,2)),to:index(move.slice(2,4)),...(move[4]?{promotion:move[4] as ChessPromotion}:{}) }
}
interface VerifiedEngine { binary:string; network?:string; files:{path:string;size:number;mtime:number}[] }
export class NativeBoardAiPolicy implements BoardAiPolicy {
  private engines = new Map<BoardEngine, VerifiedEngine>()
  private errors = new Map<BoardEngine,string>()
  private active = 0
  private waiters: { resolve:()=>void; reject:(e:Error)=>void; signal?:AbortSignal; abort:()=>void }[] = []
  constructor(readonly root = BOARD_AI_ROOT) {}
  async initialize(): Promise<void> {
    this.engines.clear(); this.errors.clear()
    let manifest: BoardAiManifest
    try { manifest=JSON.parse(await readFile(join(this.root,'manifest.json'),'utf8')); if(manifest.version!==1||manifest.platform!==process.platform||manifest.arch!==process.arch)throw new Error('引擎清单与当前系统不匹配') }
    catch { for(const key of ['stockfish','fairy','pikafish'] as const)this.errors.set(key,'棋类 AI 尚未安装，请运行 npm run setup:board-ai');return }
    for(const key of ['stockfish','fairy','pikafish'] as const) {
      try {
        const entry=manifest.engines[key];if(!entry)throw new Error('缺少引擎清单')
        const files:VerifiedEngine['files']=[]
        const verify=async(file:EngineFile)=>{
          if(!file||isAbsolute(file.path)||resolve(this.root,file.path).startsWith(`${resolve(this.root)}/`)===false)throw new Error('引擎清单路径无效')
          const path=resolve(this.root,file.path),bytes=await readFile(path),info=await stat(path)
          if(!bytes.length||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw new Error('引擎或权重校验失败，请重新安装')
          files.push({path,size:info.size,mtime:info.mtimeMs});return path
        }
        const binary=await verify(entry.binary),network=entry.network?await verify(entry.network):undefined
        if(key!=='stockfish'&&!network)throw new Error('缺少中国象棋 NNUE 权重')
        const verified={binary,network,files}
        // Prove the actual installed CPU binary and NNUE can search before enabling any level.
        const probe=await this.search(verified,key,{kind:'uci',game:key==='stockfish'?'chess':'xiangqi',position:'position startpos',legalMoves:[]},key==='pikafish'?'challenge':'beginner',undefined,true)
        if (!/NNUE evaluation/i.test(probe.output)) throw new Error('引擎未确认启用 NNUE，已停用以避免退回传统评估')
        this.engines.set(key,verified)
      } catch(error) { this.errors.set(key,error instanceof Error?error.message:'棋类引擎初始化失败') }
    }
  }
  availability(game: BoardAiGame, difficulty: BoardAiDifficulty) {
    if (game === 'gomoku') return { available:true, message:null }
    const key=boardEngine(game,difficulty),entry=this.engines.get(key)
    if(entry) {
      try { for(const file of entry.files){const info=statSync(file.path);if(info.size!==file.size||info.mtimeMs!==file.mtime)throw new Error('changed')}return {available:true,message:null} }
      catch { this.engines.delete(key);this.errors.set(key,'棋类引擎或权重已改变，请重启服务重新校验') }
    }
    return {available:false,message:this.errors.get(key)??'棋类 AI 尚未初始化'}
  }
  private async acquire(signal?:AbortSignal) {
    if(signal?.aborted)throw new Error('思考已取消')
    if(this.active<2){this.active++;return}
    if(this.waiters.length>=32)throw new Error('电脑对弈繁忙，请稍后重试')
    await new Promise<void>((resolve,reject)=>{const waiter={resolve,reject,signal,abort:()=>{this.waiters=this.waiters.filter(w=>w!==waiter);reject(new Error('思考已取消'))}};this.waiters.push(waiter);signal?.addEventListener('abort',waiter.abort,{once:true});if(signal?.aborted)waiter.abort()})
  }
  private release() { const next=this.waiters.shift();if(next){next.signal?.removeEventListener('abort',next.abort);next.resolve()}else this.active-- }
  async chooseMove(position: BoardSearchPosition,difficulty: BoardAiDifficulty,signal?:AbortSignal):Promise<BoardAiMove> {
    const status=this.availability(position.game,difficulty);if(!status.available)throw new Error(status.message!)
    if(position.kind==='uci'&&!position.legalMoves.length)throw new Error('当前局面没有合法走法')
    await this.acquire(signal)
    try {
      if (position.kind === 'gomoku') {
        const point = await searchGomokuWorker(position, difficulty, signal)
        if (point === null) throw new Error('当前局面没有合法走法')
        return { kind:'gomoku', point }
      }
      const key=boardEngine(position.game,difficulty),result=await this.search(this.engines.get(key)!,key,position,difficulty,signal)
      const move=key==='fairy'?fairyXiangqiMove(result.move,-1):result.move
      if(!position.legalMoves.includes(move))throw new Error('引擎返回了本局棋规不允许的走法')
      return decodeMove(position.game,move)
    } finally { this.release() }
  }
  private search(entry:VerifiedEngine,key:BoardEngine,position:UciSearchPosition,difficulty:BoardAiDifficulty,signal?:AbortSignal,probe=false) {
    const profile=boardAiProfile(position.game,difficulty)
    const options:Record<string,string|number|boolean>={Threads:1,Hash:32}
    if(key!=='pikafish'){options['Skill Level']=profile.skill;options.UCI_LimitStrength=false}
    if(key==='fairy'){options.UCI_Variant='xiangqi';options['Use NNUE']=true}
    if(entry.network)options.EvalFile=entry.network
    const enginePosition=key==='fairy'?position.position.replace(/ moves (.+)$/,(_,moves:string)=>` moves ${moves.split(' ').map(move=>fairyXiangqiMove(move,1)).join(' ')}`):position.position
    const legalMoves=key==='fairy'?position.legalMoves.map(move=>fairyXiangqiMove(move,1)):position.legalMoves
    return searchUci({binary:entry.binary,options,requiredOptions:key==='pikafish'?['EvalFile']:['Skill Level','UCI_LimitStrength'],position:enginePosition,
      go:`go nodes ${probe?1:profile.nodes} movetime ${probe?100:profile.movetime}${legalMoves.length?` searchmoves ${legalMoves.join(' ')}`:''}`,signal,timeoutMs:10000})
  }
}
export const boardAiPolicy = new NativeBoardAiPolicy()
