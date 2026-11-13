// Synthesized table sound effects: no assets, no background music, no autoplay network.
//
// Every sound is built at play time from oscillators and a shared noise buffer, so the app
// ships zero audio files. One AudioContext exists lazily; iOS requires it to be created or
// resumed inside a user gesture, so the module installs a one-shot pointerdown/key unlock
// listener at import time and SoundToggle also unlocks explicitly when sound is switched on.
// The toggle persists in localStorage and defaults to on; while off, the game watcher keeps
// its bookkeeping up to date so re-enabling never replays a flood of stale events.

import { ref, watch, type Ref } from 'vue'
import type { Snapshot } from '../shared/protocol'

const STORAGE_KEY = 'table-sfx'

function readStored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== '0'
  } catch {
    return true
  }
}

/** Reactive base sound switch, shared by every SoundToggle instance. */
export const soundOn = ref<boolean>(readStored())

/** Toggle the composite switch; true means sounds are on after the call. */
export function toggleSound(): boolean {
  const next = !soundOn.value
  soundOn.value = next
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
  } catch {
    /* private mode: switch stays reactive for this session */
  }
  return next
}

type AudioCtor = new () => AudioContext

let ctx: AudioContext | null = null
let master: GainNode | null = null
let noise: AudioBuffer | null = null

/**
 * Create or resume the context. Returns null when sounds are off or the browser has no
 * WebAudio; callers must tolerate both. Every effect function re-enters through here, so
 * a context made inside the very first unlock gesture covers later non-gesture events.
 */
function ensure(): AudioContext | null {
  if (typeof window === 'undefined' || !soundOn.value) return null
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext
  if (!Ctor) return null
  if (!ctx) {
    ctx = new Ctor()
    master = ctx.createGain()
    master.gain.value = 0.9
    master.connect(ctx.destination)
    // 0.5s of uniform noise, reused by every percussive voice via its own source node.
    noise = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.5), ctx.sampleRate)
    const data = noise.getChannelData(0)
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1
  }
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

/** Call from any user-gesture handler to lift an autoplay block proactively. */
export function unlockAudio(): void {
  void ensure()
}

if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', unlockAudio, { once: false, passive: true })
  window.addEventListener('keydown', unlockAudio, { once: false })
}

function tone(
  ac: AudioContext,
  out: GainNode,
  t0: number,
  dur: number,
  cfreq: number,
  gain: number,
  type: OscillatorType = 'sine',
  slideTo?: number,
): void {
  const start = ac.currentTime + t0
  const osc = ac.createOscillator()
  osc.type = type
  osc.frequency.setValueAtTime(Math.max(20, cfreq), start)
  if (slideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), start + dur)
  const env = ac.createGain()
  env.gain.setValueAtTime(0.0001, start)
  env.gain.linearRampToValueAtTime(gain, start + 0.005)
  env.gain.exponentialRampToValueAtTime(0.0001, start + dur)
  osc.connect(env)
  env.connect(out)
  osc.start(start)
  osc.stop(start + dur + 0.03)
}

function burst(
  ac: AudioContext,
  out: GainNode,
  t0: number,
  dur: number,
  gain: number,
  fromHz: number,
  toHz: number,
): void {
  const start = ac.currentTime + t0
  const src = ac.createBufferSource()
  src.buffer = noise
  const filter = ac.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.setValueAtTime(fromHz, start)
  filter.frequency.exponentialRampToValueAtTime(Math.max(40, toHz), start + dur)
  const env = ac.createGain()
  env.gain.setValueAtTime(gain, start)
  env.gain.exponentialRampToValueAtTime(0.0001, start + dur)
  src.connect(filter)
  filter.connect(env)
  env.connect(out)
  src.start(start)
  src.stop(start + dur + 0.03)
}

export type SfxName = 'select' | 'play' | 'pass' | 'bomb' | 'king' | 'turn' | 'tribute' | 'win' | 'lose'

/**
 * Fire one named effect. `intensity` scales every voice: 1 for own actions, ~0.7 for the
 * table around you. Silently no-ops when sounds are off, the context is locked or absent.
 */
export function sfx(name: SfxName, intensity: number = 1): void {
  const ac = ensure()
  if (!ac || !master || !noise) return
  const k = Math.max(0, Math.min(1, intensity))
  try {
    switch (name) {
      case 'select':
        tone(ac, master, 0, 0.05, 1500, 0.05 * k, 'triangle', 1900)
        break
      case 'play':
        burst(ac, master, 0, 0.1, 0.38 * k, 2600, 450)
        tone(ac, master, 0, 0.06, 110, 0.22 * k, 'sine', 68)
        break
      case 'pass':
        tone(ac, master, 0, 0.055, 520, 0.2 * k, 'triangle', 330)
        tone(ac, master, 0.1, 0.06, 440, 0.17 * k, 'triangle', 285)
        break
      case 'bomb':
        tone(ac, master, 0, 0.45, 130, 0.42 * k, 'sine', 44)
        burst(ac, master, 0, 0.32, 0.24 * k, 1100, 90)
        break
      case 'king':
        tone(ac, master, 0, 0.62, 96, 0.5 * k, 'sine', 34)
        burst(ac, master, 0, 0.45, 0.3 * k, 800, 60)
        tone(ac, master, 0.03, 0.2, 240, 0.14 * k, 'triangle', 100)
        break
      case 'turn':
        tone(ac, master, 0, 0.09, 540, 0.13 * k, 'triangle')
        tone(ac, master, 0.12, 0.13, 720, 0.11 * k, 'triangle')
        break
      case 'tribute':
        tone(ac, master, 0, 0.55, 880, 0.1 * k)
        tone(ac, master, 0.02, 0.5, 1318, 0.045 * k)
        break
      case 'win':
        tone(ac, master, 0, 0.2, 523, 0.16 * k, 'triangle')
        tone(ac, master, 0.13, 0.22, 659, 0.16 * k, 'triangle')
        tone(ac, master, 0.26, 0.4, 784, 0.17 * k, 'triangle')
        break
      case 'lose':
        tone(ac, master, 0, 0.22, 330, 0.13 * k, 'triangle')
        tone(ac, master, 0.18, 0.42, 262, 0.13 * k, 'triangle')
        break
    }
  } catch {
    /* an effect must never break the game: swallow audio-graph errors */
  }
}

interface SoundBookkeeping {
  primed: boolean
  lastPlayId: string
  lastPassSig: string
  lastTurn: number | null
  lastPhase: string
  lastStage: string
}

/**
 * Watch a game snapshot and speak for the table: accepted plays (own louder), bombs,
 * 不要 knocks when a seat passes, "your turn" chimes, tribute bells and round win/lose.
 * Bookkeeping always advances so a muted session stays flood-free when unmuted.
 */
/** Tablet rooms have one loudspeaker: the public table. Phone-only rooms keep local audio. */
export function receivesGameAudio(snapshot: Pick<Snapshot, 'roomMode' | 'role'> | null): boolean {
  return snapshot !== null && (snapshot.roomMode === 'phone' || snapshot.role === 'table')
}

export function attachGameSounds(state: Ref<Snapshot | null>, emit: typeof sfx = sfx): void {
  const fresh = (): SoundBookkeeping => ({
    primed: false,
    lastPlayId: '',
    lastPassSig: '',
    lastTurn: null,
    lastPhase: '',
    lastStage: '',
  })
  let book = fresh()
  let roomKey = ''

  watch(state, (snapshot) => {
    if (!snapshot) { book = fresh(); roomKey = ''; return }
    const key = `${snapshot.code}:${snapshot.role}:${snapshot.selfSeat}`
    if (key !== roomKey) { book = fresh(); roomKey = key }
    const play: typeof sfx = (name, intensity) => {
      if (receivesGameAudio(snapshot)) emit(name, intensity)
    }
    const phase = snapshot.phase
    const selfSeat = snapshot.selfSeat

    // Accepted plays: newest row only, never replayed on resync.
    const plays = snapshot.tablePlays
    const newest = plays[plays.length - 1]
    if (newest && newest.id !== book.lastPlayId) {
      const firstTime = book.primed
      book.lastPlayId = newest.id
      if (firstTime && newest.cards.length > 0 && phase === 'playing') {
        const claimed = newest.claim?.kind ?? ''
        const rawKind = newest.kind
        const own = newest.seatId === selfSeat
        if (claimed === 'fourJokers' || rawKind === 'rocket') play('king', own ? 1 : 0.6)
        else if (claimed === 'bomb' || claimed === 'straightFlush' || rawKind === 'bomb') play('bomb', own ? 1 : 0.6)
        else play('play', own ? 1 : 0.72)
      }
    }

    // 不要: a seat that was open is now marked passed for this trick.
    const passSig = snapshot.seats.map((seat) => (seat.passed ? 1 : 0)).join('')
    if (passSig !== book.lastPassSig) {
      const previous = book.lastPassSig.split('')
      if (book.primed && phase === 'playing') {
        snapshot.seats.forEach((seat, index) => {
          const isNew = seat.passed && previous[index] !== '1'
          if (isNew) {
            play('pass', seat.id === selfSeat ? 0.85 : 0.6)
          }
        })
      }
      book.lastPassSig = passSig
    }

    // The table announces every new actor; phone-only rooms announce this player's turn.
    if (phase === 'playing' && snapshot.turn !== null &&
        (snapshot.turn !== book.lastTurn || book.lastPhase !== phase) &&
        (snapshot.role === 'table' || snapshot.turn === selfSeat) && book.primed) {
      play('turn', 0.9)
    }
    book.lastTurn = snapshot.turn

    // Tribute/return bells for the exchange stage.
    if (snapshot.game === 'guandan') {
      const stage = phase === 'tribute' ? snapshot.guandan.exchange.stage : ''
      if (stage !== book.lastStage) {
        if (book.primed && (stage === 'tribute' || stage === 'return')) play('tribute', 0.9)
        book.lastStage = stage
      }
    }

    // Round settle: win/lose chime depending on this viewer's side.
    if (phase === 'finished' && book.lastPhase !== 'finished' && book.primed) {
      if (snapshot.role === 'table') play('win')
      else if (selfSeat !== null && snapshot.game === 'guandan') {
        const result = snapshot.guandan.result
        if (result) {
          play(selfSeat % 2 === result.winnerTeam ? 'win' : 'lose')
        }
      } else if (selfSeat !== null && snapshot.game === 'doudizhu') {
        const winner = snapshot.winner
        const landlord = snapshot.landlord
        if (winner && landlord !== null) {
          const iWon = winner === 'landlord' ? selfSeat === landlord : selfSeat !== landlord
          play(iWon ? 'win' : 'lose')
        }
      }
    }
    book.lastPhase = phase

    // The first snapshot after (re)entry only primes markers; a mid-game resume must not sing.
    book.primed = true
  })
}
