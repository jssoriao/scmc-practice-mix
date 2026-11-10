import { useEffect, useRef } from 'react'

interface Props {
  peaks: number[]
  /** 0..1 playback progress */
  progress: number
  height?: number
  dim?: boolean
  onSeek?: (fraction: number) => void
}

export function Waveform({ peaks, progress, height = 48, dim = false, onSeek }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = height
    canvas.width = Math.floor(w * dpr)
    canvas.height = Math.floor(h * dpr)
    const g = canvas.getContext('2d')!
    g.scale(dpr, dpr)
    g.clearRect(0, 0, w, h)
    const n = peaks.length
    const barW = w / n
    const mid = h / 2
    for (let i = 0; i < n; i++) {
      const played = (i + 0.5) / n <= progress
      g.fillStyle = played ? (dim ? '#3b6f7a' : '#5eead4') : dim ? '#374651' : '#7b8a97'
      const bh = Math.max(1, peaks[i] * h * 0.95)
      g.fillRect(i * barW, mid - bh / 2, Math.max(1, barW - 0.5), bh)
    }
  }, [peaks, progress, height, dim])

  return (
    <canvas
      ref={ref}
      style={{ width: '100%', height }}
      className={onSeek ? 'cursor-pointer touch-none' : ''}
      onPointerDown={(e) => {
        if (!onSeek) return
        const r = e.currentTarget.getBoundingClientRect()
        onSeek(Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1))
      }}
    />
  )
}
