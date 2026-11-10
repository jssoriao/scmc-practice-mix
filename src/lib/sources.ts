import JSZip from 'jszip'

/**
 * A stem source only knows how to produce its (compressed) bytes.
 * Zip, local dev server and S3/CloudFront all map onto this.
 */
export interface StemSource {
  id: string
  name: string
  group: string
  ext: string
  getBlob(): Promise<Blob>
}

export const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|flac)$/i

const extOf = (file: string) => file.split('.').pop()!.toLowerCase()

export function prettyName(file: string) {
  return file.replace(AUDIO_EXT, '').replace(/_+/g, ' ').trim()
}

const sortStems = (a: StemSource, b: StemSource) =>
  a.group.localeCompare(b.group) || a.name.localeCompare(b.name, undefined, { numeric: true })

// ---------------------------------------------------------------- zip

export async function sourcesFromZip(file: File): Promise<StemSource[]> {
  const zip = await JSZip.loadAsync(file)
  const entries = Object.values(zip.files).filter(
    (e) =>
      !e.dir &&
      AUDIO_EXT.test(e.name) &&
      !e.name.startsWith('__MACOSX/') &&
      !e.name.split('/').pop()!.startsWith('.'),
  )
  if (entries.length === 0) throw new Error('No mp3/wav files found in the zip.')

  // If every file sits inside one shared top-level folder (e.g. macOS "Compress"), drop it.
  const roots = new Set(entries.map((e) => (e.name.includes('/') ? e.name.split('/')[0] : '')))
  const stripRoot = roots.size === 1 && !roots.has('')

  return entries
    .map((entry) => {
      const parts = entry.name.split('/')
      if (stripRoot) parts.shift()
      const base = parts.pop()!
      return {
        id: entry.name,
        name: prettyName(base),
        group: parts.join(' / '),
        ext: extOf(base),
        getBlob: () => entry.async('blob'),
      }
    })
    .sort(sortStems)
}

// ---------------------------------------------------------------- library (dev server / S3)

/** `${base}/index.json` */
export interface LibrarySong {
  id: string
  title: string
}

/** `${base}/${id}/manifest.json` — `file` is relative to the manifest URL */
interface SongManifest {
  title: string
  stems: { file: string; name?: string; group?: string }[]
}

const absolute = (u: string) => new URL(u, window.location.href)

async function getJson<T>(url: URL): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to load ${url.pathname} (${res.status})`)
  return res.json() as Promise<T>
}

export async function fetchLibrary(base: string): Promise<LibrarySong[]> {
  return getJson<LibrarySong[]>(absolute(`${base}/index.json`))
}

export async function sourcesFromSong(
  base: string,
  id: string,
): Promise<{ title: string; sources: StemSource[] }> {
  const manifestUrl = absolute(`${base}/${encodeURIComponent(id)}/manifest.json`)
  const m = await getJson<SongManifest>(manifestUrl)
  const sources = m.stems.map((s) => {
    const fileName = decodeURIComponent(s.file.split('/').pop()!)
    const url = new URL(s.file, manifestUrl)
    return {
      id: s.file,
      name: s.name ?? prettyName(fileName),
      group: s.group ?? '',
      ext: extOf(fileName),
      getBlob: async () => {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`Failed to download ${fileName} (${res.status})`)
        return res.blob()
      },
    }
  })
  return { title: m.title, sources: sources.sort(sortStems) }
}
