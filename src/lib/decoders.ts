/**
 * Stem decoders that decode audio in small time ranges instead of all at once.
 * Only compressed bytes (Blob) stay in memory; PCM is produced per chunk.
 *
 * All positions are in output samples at the AudioContext sample rate.
 */

export interface DecodedSlice {
  buffer: AudioBuffer
  /** global output-sample index of buffer[0] */
  base: number
}

export interface StemDecoder {
  /** total length in output samples */
  readonly length: number
  /** decode a slice covering [start, end) (may include extra margin) */
  decodeRange(start: number, end: number): Promise<DecodedSlice>
}

const PEAK_BARS = 600

export function computePeaks(buffer: AudioBuffer, bars = PEAK_BARS): number[] {
  const channels: Float32Array[] = []
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c))
  const block = Math.max(1, Math.floor(buffer.length / bars))
  const peaks: number[] = new Array(bars).fill(0)
  for (let i = 0; i < bars; i++) {
    const start = i * block
    const end = Math.min(buffer.length, start + block)
    const stride = Math.max(1, Math.floor((end - start) / 200))
    let max = 0
    for (const data of channels) {
      for (let j = start; j < end; j += stride) {
        const v = Math.abs(data[j])
        if (v > max) max = v
      }
    }
    peaks[i] = max
  }
  return peaks
}

/** Waveform peaks from a low-sample-rate decode to keep memory small. */
async function peaksFromBytes(bytes: ArrayBuffer): Promise<number[]> {
  for (const rate of [8000, 22050]) {
    try {
      const off = new OfflineAudioContext(1, 1, rate)
      const buf = await off.decodeAudioData(bytes.slice(0))
      return computePeaks(buf)
    } catch {
      /* try next rate */
    }
  }
  return new Array(PEAK_BARS).fill(0)
}

// ---------------------------------------------------------------- MP3

const BR_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
const BR_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]
const SR: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }

interface FrameHeader {
  length: number
  sampleRate: number
  spf: number
  sideInfo: number
}

function readFrameHeader(b: Uint8Array, p: number): FrameHeader | null {
  if (p + 4 > b.length || b[p] !== 0xff || (b[p + 1] & 0xe0) !== 0xe0) return null
  const ver = (b[p + 1] >> 3) & 3
  const layer = (b[p + 1] >> 1) & 3
  if (ver === 1 || layer !== 1) return null // reserved version / not Layer III
  const brIdx = b[p + 2] >> 4
  const srIdx = (b[p + 2] >> 2) & 3
  if (brIdx === 0 || brIdx === 15 || srIdx === 3) return null
  const pad = (b[p + 2] >> 1) & 1
  const mono = b[p + 3] >> 6 === 3
  const bitrate = (ver === 3 ? BR_V1_L3 : BR_V2_L3)[brIdx] * 1000
  const sampleRate = SR[ver][srIdx]
  const spf = ver === 3 ? 1152 : 576
  const length = Math.floor(((spf / 8) * bitrate) / sampleRate) + pad
  const sideInfo = ver === 3 ? (mono ? 17 : 32) : mono ? 9 : 17
  return { length, sampleRate, spf, sideInfo }
}

interface Mp3Index {
  offsets: Uint32Array // frame start offsets + end sentinel
  spf: number
  sampleRate: number
  /** samples of priming silence at the start (encoder delay + decoder delay) */
  delay: number
  /** encoder padding at the end */
  padding: number
}

const DECODER_DELAY = 529 // standard MP3 decoder (MDCT/filterbank) delay

/** Encoder delay/padding from a LAME/Lavc tag inside the Xing/Info frame, if present. */
function lameGapless(b: Uint8Array, xingAt: number): { delay: number; padding: number } {
  const flags = (b[xingAt + 4] << 24) | (b[xingAt + 5] << 16) | (b[xingAt + 6] << 8) | b[xingAt + 7]
  let o = xingAt + 8
  if (flags & 1) o += 4
  if (flags & 2) o += 4
  if (flags & 4) o += 100
  if (flags & 8) o += 4
  const enc = String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3])
  if (enc !== 'LAME' && enc !== 'Lavc' && enc !== 'Lavf') return { delay: 0, padding: 0 }
  return { delay: (b[o + 21] << 4) | (b[o + 22] >> 4), padding: ((b[o + 22] & 0x0f) << 8) | b[o + 23] }
}

export function indexMp3(b: Uint8Array): Mp3Index | null {
  let p = 0
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
    const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f)
    p = 10 + size + (b[5] & 0x10 ? 10 : 0)
  }
  const offsets: number[] = []
  let first: FrameHeader | null = null
  let end = p
  let gapless = { delay: 0, padding: 0 }
  while (p + 4 <= b.length) {
    const h = readFrameHeader(b, p)
    // when resyncing, require the next frame to look valid too
    const ok =
      h &&
      (!first || h.sampleRate === first.sampleRate) &&
      (offsets.length > 0 || p + h.length >= b.length || readFrameHeader(b, p + h.length))
    if (!h || !ok) {
      p++
      continue
    }
    if (!first) {
      first = h
      const t = p + 4 + h.sideInfo
      const tag = String.fromCharCode(b[t], b[t + 1], b[t + 2], b[t + 3])
      const vbri = String.fromCharCode(b[p + 36], b[p + 37], b[p + 38], b[p + 39])
      if (tag === 'Xing' || tag === 'Info' || vbri === 'VBRI') {
        if (tag !== 'VBRI') gapless = lameGapless(b, t)
        p += h.length // skip metadata frame
        continue
      }
    }
    if (p + h.length > b.length) break
    offsets.push(p)
    p += h.length
    end = p
  }
  if (!first || offsets.length < 2) return null
  offsets.push(end)
  return {
    offsets: Uint32Array.from(offsets),
    spf: first.spf,
    sampleRate: first.sampleRate,
    delay: gapless.delay + DECODER_DELAY,
    padding: gapless.padding,
  }
}

class Mp3Decoder implements StemDecoder {
  private readonly ctx: BaseAudioContext
  private readonly blob: Blob
  private readonly idx: Mp3Index

  constructor(ctx: BaseAudioContext, blob: Blob, idx: Mp3Index) {
    this.ctx = ctx
    this.blob = blob
    this.idx = idx
  }

  private get frames() {
    return this.idx.offsets.length - 1
  }
  private get ratio() {
    return this.ctx.sampleRate / this.idx.sampleRate
  }
  get length() {
    return Math.floor((this.frames * this.idx.spf - this.idx.delay - this.idx.padding) * this.ratio)
  }

  async decodeRange(start: number, end: number): Promise<DecodedSlice> {
    const { spf, offsets, delay } = this.idx
    const r = this.ratio
    // timeline position 0 = first real sample, i.e. decoder sample `delay`
    // leading frames rebuild the bit reservoir / decoder state; trailing ones flush it
    const f0 = Math.max(0, Math.floor((start / r + delay) / spf) - 10)
    const f1 = Math.min(this.frames, Math.ceil((end / r + delay) / spf) + 3)
    const data = await this.blob.slice(offsets[f0], offsets[f1]).arrayBuffer()
    const buffer = await this.ctx.decodeAudioData(data)
    // anchor at the slice end: robust if a decoder drops/pads leading frames
    return { buffer, base: Math.round((f1 * spf - delay) * r - buffer.length) }
  }
}

// ---------------------------------------------------------------- WAV

interface WavInfo {
  code: number
  channels: number
  rate: number
  bits: number
  blockAlign: number
  dataOffset: number
  frames: number
}

export function parseWav(u8: Uint8Array): WavInfo | null {
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  const tag = (o: number) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3])
  if (u8.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null
  let p = 12
  let fmt: Omit<WavInfo, 'dataOffset' | 'frames'> | null = null
  while (p + 8 <= u8.length) {
    const id = tag(p)
    const size = v.getUint32(p + 4, true)
    const body = p + 8
    if (id === 'fmt ') {
      let code = v.getUint16(body, true)
      if (code === 0xfffe && size >= 26) code = v.getUint16(body + 24, true)
      fmt = {
        code,
        channels: v.getUint16(body + 2, true),
        rate: v.getUint32(body + 4, true),
        blockAlign: v.getUint16(body + 12, true),
        bits: v.getUint16(body + 14, true),
      }
    } else if (id === 'data') {
      if (!fmt || (fmt.code !== 1 && fmt.code !== 3) || !fmt.blockAlign) return null
      const avail = u8.length - body
      const len = size === 0 || size > avail ? avail : size
      return { ...fmt, dataOffset: body, frames: Math.floor(len / fmt.blockAlign) }
    }
    p = body + size + (size & 1)
  }
  return null
}

function wavHeader(w: WavInfo, dataLen: number): Uint8Array {
  const v = new DataView(new ArrayBuffer(44))
  const s = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  s(0, 'RIFF')
  v.setUint32(4, 36 + dataLen, true)
  s(8, 'WAVE')
  s(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, w.code, true)
  v.setUint16(22, w.channels, true)
  v.setUint32(24, w.rate, true)
  v.setUint32(28, w.rate * w.blockAlign, true)
  v.setUint16(32, w.blockAlign, true)
  v.setUint16(34, w.bits, true)
  s(36, 'data')
  v.setUint32(40, dataLen, true)
  return new Uint8Array(v.buffer)
}

class WavDecoder implements StemDecoder {
  private readonly ctx: BaseAudioContext
  private readonly blob: Blob
  private readonly w: WavInfo

  constructor(ctx: BaseAudioContext, blob: Blob, w: WavInfo) {
    this.ctx = ctx
    this.blob = blob
    this.w = w
  }

  private get ratio() {
    return this.ctx.sampleRate / this.w.rate
  }
  get length() {
    return Math.floor(this.w.frames * this.ratio)
  }

  async decodeRange(start: number, end: number): Promise<DecodedSlice> {
    const r = this.ratio
    const { blockAlign, dataOffset, frames } = this.w
    const s0 = Math.max(0, Math.floor(start / r) - 64) // margin for resampler edges
    const s1 = Math.min(frames, Math.ceil(end / r) + 64)
    const pcm = await this.blob.slice(dataOffset + s0 * blockAlign, dataOffset + s1 * blockAlign).arrayBuffer()
    const file = new Uint8Array(44 + pcm.byteLength)
    file.set(wavHeader(this.w, pcm.byteLength), 0)
    file.set(new Uint8Array(pcm), 44)
    const buffer = await this.ctx.decodeAudioData(file.buffer)
    return { buffer, base: Math.round(s0 * r) }
  }
}

// ---------------------------------------------------------------- fallback

/** For formats we can't slice (m4a, ogg, flac): decode fully once. */
class FullDecoder implements StemDecoder {
  private readonly buffer: AudioBuffer
  constructor(buffer: AudioBuffer) {
    this.buffer = buffer
  }
  get length() {
    return this.buffer.length
  }
  async decodeRange(): Promise<DecodedSlice> {
    return { buffer: this.buffer, base: 0 }
  }
}

export async function createDecoder(
  ctx: BaseAudioContext,
  blob: Blob,
  ext: string,
): Promise<{ decoder: StemDecoder; peaks: number[]; kind: 'mp3' | 'wav' | 'full' }> {
  const bytes = await blob.arrayBuffer()
  const u8 = new Uint8Array(bytes)
  if (ext === 'mp3') {
    const idx = indexMp3(u8)
    if (idx) return { decoder: new Mp3Decoder(ctx, blob, idx), peaks: await peaksFromBytes(bytes), kind: 'mp3' }
  }
  if (ext === 'wav') {
    const w = parseWav(u8)
    if (w) return { decoder: new WavDecoder(ctx, blob, w), peaks: await peaksFromBytes(bytes), kind: 'wav' }
  }
  const buffer = await ctx.decodeAudioData(bytes)
  return { decoder: new FullDecoder(buffer), peaks: computePeaks(buffer), kind: 'full' }
}

/** Native sample rate of an mp3/wav without decoding (null if unknown). */
export function sniffSampleRate(bytes: Uint8Array, ext: string): number | null {
  if (ext === 'mp3') return indexMp3(bytes)?.sampleRate ?? null
  if (ext === 'wav') return parseWav(bytes)?.rate ?? null
  return null
}
