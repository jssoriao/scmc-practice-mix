/**
 * Dev-only: serves a local folder of songs at /songs with the same layout we
 * will use on S3/CloudFront:
 *
 *   /songs/index.json                 -> [{ id, title }]
 *   /songs/<id>/manifest.json         -> { title, stems: [{ file, name, group }] }
 *   /songs/<id>/<file>                -> audio bytes (Range supported)
 *
 * Each subfolder of the root is a song; nested folders become stem groups.
 * index.json and manifests are generated on the fly.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

const AUDIO = /\.(mp3|wav|m4a|aac|ogg|flac)$/i
const MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
}

const isDir = (p: string) => fs.existsSync(p) && fs.statSync(p).isDirectory()
const hidden = (n: string) => n.startsWith('.') || n === '__MACOSX'

function listAudio(dir: string, rel: string[] = []): string[][] {
  const out: string[][] = []
  for (const name of fs.readdirSync(dir)) {
    if (hidden(name)) continue
    const full = path.join(dir, name)
    if (isDir(full)) out.push(...listAudio(full, [...rel, name]))
    else if (AUDIO.test(name)) out.push([...rel, name])
  }
  return out
}

function manifest(songDir: string, title: string) {
  const files = listAudio(songDir)
  // drop a single wrapping folder, same as the zip loader
  const roots = new Set(files.map((f) => (f.length > 1 ? f[0] : '')))
  const strip = roots.size === 1 && !roots.has('')
  return {
    title,
    stems: files.map((parts) => {
      const groupParts = parts.slice(strip ? 1 : 0, -1)
      return {
        file: parts.map(encodeURIComponent).join('/'),
        name: parts[parts.length - 1].replace(AUDIO, '').replace(/_+/g, ' ').trim(),
        group: groupParts.join(' / '),
      }
    }),
  }
}

function json(res: ServerResponse, body: unknown) {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

function sendFile(req: IncomingMessage, res: ServerResponse, file: string) {
  const size = fs.statSync(file).size
  res.setHeader('Content-Type', MIME[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream')
  res.setHeader('Accept-Ranges', 'bytes')
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : size - Number(m[2])
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
    if (start > end || start >= size) {
      res.statusCode = 416
      res.setHeader('Content-Range', `bytes */${size}`)
      return res.end()
    }
    res.statusCode = 206
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
    res.setHeader('Content-Length', end - start + 1)
    return fs.createReadStream(file, { start, end }).pipe(res)
  }
  res.setHeader('Content-Length', size)
  fs.createReadStream(file).pipe(res)
}

export function songsPlugin(rootDir: string, mount = '/songs'): Plugin {
  const root = path.resolve(rootDir)
  return {
    name: 'scmc-practice-mix-songs',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(mount, (req, res, next) => {
        try {
          const segs = new URL(req.url ?? '/', 'http://x').pathname
            .split('/')
            .filter(Boolean)
            .map(decodeURIComponent)
          if (segs.some((s) => s === '..' || s.includes('\0'))) {
            res.statusCode = 400
            return res.end()
          }
          if (!isDir(root)) return json(res, [])

          if (segs.length === 1 && segs[0] === 'index.json') {
            const songs = fs
              .readdirSync(root)
              .filter((n) => !hidden(n) && isDir(path.join(root, n)) && listAudio(path.join(root, n)).length > 0)
              .sort((a, b) => a.localeCompare(b))
              .map((n) => ({ id: n, title: n }))
            return json(res, songs)
          }

          const full = path.resolve(root, ...segs)
          if (full !== root && !full.startsWith(root + path.sep)) {
            res.statusCode = 400
            return res.end()
          }
          if (segs.length === 2 && segs[1] === 'manifest.json') {
            const dir = path.join(root, segs[0])
            if (!isDir(dir)) return next()
            return json(res, manifest(dir, segs[0]))
          }
          if (segs.length >= 2 && AUDIO.test(full) && fs.existsSync(full) && !isDir(full)) {
            return sendFile(req, res, full)
          }
          next()
        } catch (e) {
          next(e)
        }
      })
    },
  }
}
