import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StemEngine, SupersededError, type MixState, type StemInfo } from './lib/engine'
import { fetchLibrary, sourcesFromSong, sourcesFromZip, type LibrarySong, type StemSource } from './lib/sources'
import { SONGS_BASE_URL } from './config'
import { Waveform } from './components/Waveform'

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const defaultMix = (): MixState => ({ muted: false, solo: false, volume: 1 })

export default function App() {
  const engineRef = useRef<StemEngine | null>(null)
  const [stems, setStems] = useState<StemInfo[]>([])
  const [mix, setMix] = useState<MixState[]>([])
  const [playing, setPlaying] = useState(false)
  const [pos, setPos] = useState(0)
  const [duration, setDuration] = useState(0)
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [library, setLibrary] = useState<LibrarySong[]>([])
  const [songId, setSongId] = useState('')

  // one AudioContext for the app's lifetime (iOS limits how many you can create)
  const getEngine = () => {
    if (!engineRef.current) {
      const e = new StemEngine()
      e.onEnded = () => {
        setPlaying(false)
        setPos(0)
      }
      e.onError = (err) => setError(err instanceof Error ? err.message : 'Playback error.')
      engineRef.current = e
      if (import.meta.env.DEV) (window as unknown as { __engine: StemEngine }).__engine = e
    }
    return engineRef.current
  }

  useEffect(() => {
    if (!SONGS_BASE_URL) return
    fetchLibrary(SONGS_BASE_URL)
      .then(setLibrary)
      .catch(() => setLibrary([]))
  }, [])

  // playhead ticker
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => {
      setPos(engineRef.current?.position ?? 0)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing])

  // ref mirrors state so rapid taps always build on the latest mix
  const mixRef = useRef<MixState[]>([])
  const updateMix = useCallback((next: MixState[]) => {
    mixRef.current = next
    setMix(next)
    engineRef.current?.applyMix(next)
  }, [])

  const loadSong = async (songTitle: string, getSources: () => Promise<StemSource[]>) => {
    setError(null)
    const engine = getEngine() // created inside the user gesture
    engine.unload()
    setStems([])
    setPlaying(false)
    setPos(0)
    setLoading('Preparing…')
    try {
      const sources = await getSources()
      const infos = await engine.load(sources, (d, t, name) =>
        setLoading(name ? `Loading ${d + 1}/${t}: ${name}` : null),
      )
      setStems(infos)
      updateMix(infos.map(defaultMix))
      setDuration(engine.duration)
      setTitle(songTitle)
    } catch (e) {
      if (e instanceof SupersededError) return
      setError(e instanceof Error ? e.message : 'Failed to load song.')
    } finally {
      setLoading(null)
    }
  }

  const onFile = (file: File | undefined) => {
    if (!file) return
    setSongId('')
    void loadSong(file.name.replace(/\.zip$/i, ''), () => sourcesFromZip(file))
  }

  const onPickSong = (id: string) => {
    setSongId(id)
    const song = library.find((s) => s.id === id)
    if (!song) return
    void loadSong(song.title, async () => (await sourcesFromSong(SONGS_BASE_URL, song.id)).sources)
  }

  const togglePlay = async () => {
    const engine = engineRef.current
    if (!engine) return
    if (engine.isPlaying) {
      engine.pause()
      setPos(engine.position)
      setPlaying(false)
    } else {
      setPlaying(true)
      await engine.play()
    }
  }

  const seekFraction = async (f: number) => {
    const engine = engineRef.current
    if (!engine) return
    await engine.seek(f * duration)
    setPos(engine.position)
  }

  const masterPeaks = useMemo(() => {
    if (stems.length === 0) return []
    return stems[0].peaks.map((_, i) => Math.min(1, Math.max(...stems.map((s) => s.peaks[i] ?? 0))))
  }, [stems])

  const patch = (i: number, p: Partial<MixState>) =>
    updateMix(mixRef.current.map((m, idx) => (idx === i ? { ...m, ...p } : m)))

  const anySolo = mix.some((m) => m.solo)
  const progress = duration > 0 ? pos / duration : 0

  // group stems by folder, preserving order
  const groups = useMemo(() => {
    const map = new Map<string, number[]>()
    stems.forEach((s, i) => map.set(s.group, [...(map.get(s.group) ?? []), i]))
    return [...map.entries()]
  }, [stems])

  return (
    <div className="min-h-dvh bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-2xl px-3 pb-24 pt-4">
        <header className="mb-4 flex items-center justify-between gap-2">
          <h1 className="text-lg font-semibold tracking-tight">SCMC Practice Mix</h1>
          <div className="flex gap-2">
            {stems.length > 0 && (
              <button
                className="rounded-full border border-slate-700 px-3 py-1.5 text-sm"
                onClick={() => updateMix(stems.map(defaultMix))}
              >
                Reset
              </button>
            )}
            <label className="cursor-pointer rounded-full bg-teal-600 px-4 py-1.5 text-sm font-medium text-white">
              Open zip
              <input
                type="file"
                accept=".zip,application/zip"
                className="hidden"
                onChange={(e) => {
                  onFile(e.target.files?.[0])
                  e.target.value = ''
                }}
              />
            </label>
          </div>
        </header>

        {library.length > 0 && (
          <label className="mb-3 block">
            <span className="sr-only">Song library</span>
            <select
              value={songId}
              onChange={(e) => onPickSong(e.target.value)}
              className="w-full rounded-xl border border-slate-800 bg-slate-900 px-3 py-2.5 text-sm"
            >
              <option value="">Choose a song from the library…</option>
              {library.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </label>
        )}

        {loading && <p className="rounded-lg bg-slate-900 p-3 text-sm text-slate-300">{loading}</p>}
        {error && (
          <p role="alert" className="mt-2 rounded-lg bg-red-950 p-3 text-sm text-red-200">
            {error}
          </p>
        )}

        {stems.length === 0 && !loading && (
          <p className="mt-16 text-center text-slate-400">
            {library.length > 0 ? 'Pick a song above, or open' : 'Open'} a zip of mp3/wav stems to play them together.
          </p>
        )}

        {stems.length > 0 && (
          <>
            <section className="rounded-2xl border border-slate-800 bg-slate-900 p-3">
              <div className="flex items-center gap-3">
                <button
                  aria-label={playing ? 'Pause' : 'Play'}
                  onClick={togglePlay}
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-teal-600 text-xl"
                >
                  {playing ? '❚❚' : '▶'}
                </button>
                <div className="min-w-0">
                  <p className="truncate font-medium">{title}</p>
                  <p className="text-xs text-slate-400">
                    {stems.length} stems{anySolo ? ' · solo active' : ''}
                  </p>
                </div>
              </div>
              <div className="mt-3">
                <Waveform peaks={masterPeaks} progress={progress} height={64} onSeek={seekFraction} />
                <div className="mt-1 flex justify-between text-xs text-slate-400">
                  <span>{fmt(pos)}</span>
                  <span>{fmt(duration)}</span>
                </div>
              </div>
            </section>

            <div className="mt-3 space-y-3">
              {groups.map(([group, idxs]) => (
                <div key={group || 'root'}>
                  {group && <h2 className="mb-1 px-1 text-xs uppercase tracking-wide text-slate-500">{group}</h2>}
                  <ul className="space-y-2">
                    {idxs.map((i) => {
                      const s = stems[i]
                      const m = mix[i]
                      if (!m) return null
                      const silent = m.muted || (anySolo && !m.solo)
                      return (
                        <li key={s.id} className="rounded-xl border border-slate-800 bg-slate-900/70 p-2">
                          <div className="flex items-center gap-2">
                            <span className={`min-w-0 flex-1 truncate text-sm font-medium ${silent ? 'text-slate-500' : ''}`}>
                              {s.name}
                            </span>
                            <button
                              aria-pressed={m.muted}
                              aria-label={`Mute ${s.name}`}
                              onClick={() => patch(i, { muted: !m.muted })}
                              className={`h-9 w-9 rounded-lg text-sm font-bold ${m.muted ? 'bg-red-600 text-white' : 'bg-slate-800 text-slate-300'}`}
                            >
                              M
                            </button>
                            <button
                              aria-pressed={m.solo}
                              aria-label={`Solo ${s.name}`}
                              onClick={() => patch(i, { solo: !m.solo })}
                              className={`h-9 w-9 rounded-lg text-sm font-bold ${m.solo ? 'bg-amber-500 text-slate-950' : 'bg-slate-800 text-slate-300'}`}
                            >
                              S
                            </button>
                          </div>
                          <div className="mt-2">
                            <Waveform peaks={s.peaks} progress={progress} dim={silent} onSeek={seekFraction} />
                          </div>
                          <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.01}
                            value={m.volume}
                            aria-label={`Volume ${s.name}`}
                            onChange={(e) => patch(i, { volume: Number(e.target.value) })}
                            className="mt-1 w-full accent-teal-500"
                          />
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
