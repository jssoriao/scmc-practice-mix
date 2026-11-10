import { createDecoder, sniffSampleRate, type StemDecoder } from './decoders'
import type { StemSource } from './sources'

export interface MixState {
  muted: boolean
  solo: boolean
  volume: number // 0..1
}

export interface StemInfo {
  id: string
  name: string
  group: string
  peaks: number[]
}

/** Thrown when a load is replaced by a newer one. */
export class SupersededError extends Error {}

const CHUNK_SEC = 8 // decoded PCM chunk size
const AHEAD_SEC = 20 // how far ahead to decode + schedule
const PUMP_MS = 250

interface Track {
  info: StemInfo
  decoder: StemDecoder
  gain: GainNode
  cache: Map<number, Promise<AudioBuffer | null>>
}

/**
 * Plays many stems in sync while only keeping ~AHEAD_SEC of decoded audio
 * per stem in memory. Chunks are scheduled on the AudioContext clock at exact
 * sample boundaries, so stems stay sample-aligned and chunk joins are seamless.
 */
export class StemEngine {
  private _ctx: AudioContext
  private tracks: Track[] = []
  private sources = new Set<AudioBufferSourceNode>()
  private playing = false
  private startedAt = 0 // ctx time corresponding to position 0
  private pausedAt = 0
  private gen = 0 // bumps on every stop/seek to cancel stale async work
  private loadGen = 0
  private nextChunk = 0
  private timer: ReturnType<typeof setInterval> | undefined
  onEnded?: () => void
  onError?: (e: unknown) => void

  constructor() {
    this._ctx = StemEngine.createContext()
  }

  get ctx() {
    return this._ctx
  }

  private static createContext(sampleRate?: number): AudioContext {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (sampleRate) {
      try {
        return new Ctor({ sampleRate })
      } catch {
        /* rate not supported: fall back to the device rate */
      }
    }
    return new Ctor()
  }

  /**
   * Run the graph at the stems' native rate so chunk decodes need no
   * resampling (bit-exact joins). The browser converts to the device rate once.
   */
  private async matchSampleRate(rate: number | null) {
    if (!rate || rate === this._ctx.sampleRate) return
    const old = this._ctx
    this._ctx = StemEngine.createContext(rate)
    await old.close().catch(() => {})
  }

  private get chunkLen() {
    return Math.round(CHUNK_SEC * this.ctx.sampleRate)
  }
  private get chunkSec() {
    return this.chunkLen / this.ctx.sampleRate
  }

  get duration() {
    return this.tracks.reduce((m, t) => Math.max(m, t.decoder.length), 0) / this.ctx.sampleRate
  }

  get isPlaying() {
    return this.playing
  }

  get position() {
    const p = this.playing ? this.ctx.currentTime - this.startedAt : this.pausedAt
    return Math.min(Math.max(p, 0), this.duration)
  }

  async load(
    sources: StemSource[],
    onProgress?: (done: number, total: number, name: string) => void,
  ): Promise<StemInfo[]> {
    this.unload()
    const myLoad = ++this.loadGen
    const tracks: Track[] = []
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i]
      onProgress?.(i, sources.length, s.name)
      let created
      try {
        const blob = await s.getBlob()
        if (i === 0) {
          const head = new Uint8Array(await blob.slice(0, 256 * 1024).arrayBuffer())
          await this.matchSampleRate(sniffSampleRate(head, s.ext))
        }
        created = await createDecoder(this.ctx, blob, s.ext)
      } catch (e) {
        if (myLoad !== this.loadGen) throw new SupersededError()
        throw new Error(`Could not read "${s.name}": ${e instanceof Error ? e.message : 'unsupported or corrupt audio'}`)
      }
      if (myLoad !== this.loadGen) throw new SupersededError()
      const gain = this.ctx.createGain()
      gain.connect(this.ctx.destination)
      tracks.push({
        info: { id: s.id, name: s.name, group: s.group, peaks: created.peaks },
        decoder: created.decoder,
        gain,
        cache: new Map(),
      })
    }
    onProgress?.(sources.length, sources.length, '')
    this.tracks = tracks
    this.applyMix(tracks.map(() => ({ muted: false, solo: false, volume: 1 })))
    return tracks.map((t) => t.info)
  }

  unload() {
    this.halt()
    this.loadGen++
    this.tracks.forEach((t) => t.gain.disconnect())
    this.tracks = []
    this.pausedAt = 0
  }

  applyMix(mix: MixState[]) {
    const anySolo = mix.some((m) => m.solo)
    mix.forEach((m, i) => {
      const audible = !m.muted && (!anySolo || m.solo)
      const gain = this.tracks[i]?.gain
      if (gain) gain.gain.setTargetAtTime(audible ? m.volume : 0, this.ctx.currentTime, 0.01)
    })
  }

  async play() {
    if (this.playing || this.tracks.length === 0) return
    const resumed = this.ctx.resume() // call inside the tap for iOS
    const gen = ++this.gen
    const offset = this.pausedAt >= this.duration ? 0 : this.pausedAt
    const k0 = Math.floor(offset / this.chunkSec)
    // make sure the first two chunks of every stem are ready before starting
    await Promise.all([resumed, ...this.tracks.flatMap((t) => [this.chunk(t, k0), this.chunk(t, k0 + 1)])])
    if (gen !== this.gen) return
    const sr = this.ctx.sampleRate
    // snap to a sample frame so every chunk boundary lands on an exact frame
    this.startedAt = Math.round((this.ctx.currentTime + 0.08 - offset) * sr) / sr
    this.playing = true
    this.nextChunk = k0
    this.pump(gen)
    this.timer = setInterval(() => this.pump(gen), PUMP_MS)
  }

  pause() {
    if (!this.playing) return
    this.pausedAt = this.position
    this.halt()
  }

  async seek(seconds: number) {
    const wasPlaying = this.playing
    const t = Math.min(Math.max(seconds, 0), this.duration)
    if (wasPlaying) this.halt()
    this.pausedAt = t
    if (wasPlaying) await this.play()
  }

  async dispose() {
    this.unload()
    await this._ctx.close()
  }

  private halt() {
    this.gen++
    clearInterval(this.timer)
    this.timer = undefined
    for (const s of this.sources) {
      s.onended = null
      try {
        s.stop()
      } catch {
        /* not started / already stopped */
      }
      s.disconnect()
    }
    this.sources.clear()
    this.playing = false
  }

  private pump(gen: number) {
    if (gen !== this.gen || !this.playing) return
    const pos = this.position
    if (pos >= this.duration) {
      this.halt()
      this.pausedAt = 0
      this.onEnded?.()
      return
    }
    const horizon = Math.min(pos + AHEAD_SEC, this.duration)
    while (this.nextChunk * this.chunkSec < horizon) {
      const k = this.nextChunk++
      for (const t of this.tracks) {
        this.chunk(t, k).then(
          (buf) => {
            if (buf && gen === this.gen) this.schedule(t, buf, k)
          },
          (e) => {
            t.cache.delete(k)
            if (gen === this.gen) this.onError?.(e)
          },
        )
      }
    }
    this.evict(Math.floor(pos / this.chunkSec))
  }

  private schedule(t: Track, buf: AudioBuffer, k: number) {
    let when = this.startedAt + k * this.chunkSec
    let offset = 0
    const now = this.ctx.currentTime + 0.005
    if (when < now) {
      // late (or first chunk after a seek): start mid-chunk to stay in sync
      offset = now - when
      when = now
      if (offset >= buf.duration) return
    }
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.connect(t.gain)
    src.start(when, offset)
    src.onended = () => {
      src.disconnect()
      this.sources.delete(src)
    }
    this.sources.add(src)
  }

  private evict(current: number) {
    const keepTo = current + Math.ceil(AHEAD_SEC / this.chunkSec) + 1
    for (const t of this.tracks) {
      for (const k of t.cache.keys()) if (k < current || k > keepTo) t.cache.delete(k)
    }
  }

  /** Exact chunk k (chunkLen samples, last one shorter) for a track, cached. */
  private chunk(t: Track, k: number): Promise<AudioBuffer | null> {
    let p = t.cache.get(k)
    if (!p) {
      p = this.buildChunk(t, k)
      t.cache.set(k, p)
    }
    return p
  }

  private async buildChunk(t: Track, k: number): Promise<AudioBuffer | null> {
    const g0 = k * this.chunkLen
    const g1 = Math.min(g0 + this.chunkLen, t.decoder.length)
    if (g0 >= g1) return null
    const { buffer, base } = await t.decoder.decodeRange(g0, g1)
    const len = g1 - g0
    const out = this.ctx.createBuffer(buffer.numberOfChannels, len, this.ctx.sampleRate)
    const off = g0 - base
    const from = Math.max(0, off)
    const to = Math.min(buffer.length, off + len)
    if (to > from) {
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        out.getChannelData(c).set(buffer.getChannelData(c).subarray(from, to), from - off)
      }
    }
    return out
  }
}
