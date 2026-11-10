# SCMC Practice Mix

Play a song's stems together with mute / solo / volume. Installable PWA (iOS + Android + desktop).

## Run

```sh
pnpm install
pnpm dev            # http://localhost:5173
pnpm dev --host     # also reachable from a phone on the same Wi-Fi
```

## Two ways to load a song

1. **Open zip**: a zip of mp3/wav files. Flat, one wrapping folder, or subfolders (shown as groups) all work.
2. **Library**: songs from `VITE_SONGS_BASE_URL`.

### Local library (dev)

Put song folders (or symlinks) in `./songs` (gitignored), or set `SONGS_DIR` in `.env.local`:

```
songs/
  Clap Your Hands/
    bass.mp3
    drums.mp3
    ...
```

`pnpm dev` serves them at `/songs` with the same layout S3/CloudFront will use:

| URL | Content |
| --- | --- |
| `/songs/index.json` | `[{ "id", "title" }]` |
| `/songs/<id>/manifest.json` | `{ "title", "stems": [{ "file", "name", "group" }] }` |
| `/songs/<id>/<file>` | audio |

Switching to S3/CloudFront later = upload the same files + JSON, then set
`VITE_SONGS_BASE_URL=https://<distribution>.cloudfront.net` and build.

## How playback works

Only compressed audio is kept in memory. Stems are decoded in 8 s chunks around the
playhead (mp3 and wav are sliced natively; other formats fall back to a full decode)
and scheduled sample-accurately on the Web Audio clock. The audio graph runs at the
stems' native sample rate so chunk joins are bit-exact. A 12-stem, 6.5-minute song
uses ~120 MB of JS heap while playing instead of ~2 GB.
