# SCMC Practice Mix: project context

Stem player PWA for the SCMC worship team (~10-15 musicians). Load a song's stems,
play them in sync, and mute/solo/adjust volume per stem (like LoopMastering's stem
view, without the stem splitting). Personal project, not HYKE.

## Stack
- Vite 8 + React 19 + TypeScript 7, Tailwind v4, vite-plugin-pwa, JSZip. pnpm, Node 22 via fnm.
- No backend yet. `pnpm build` (tsc + vite) and `pnpm lint` (oxlint). No test framework yet.

## Layout
- `src/lib/engine.ts`: `StemEngine`. Chunked playback: decodes 8 s chunks around the
  playhead, keeps about 20 s ahead, and schedules `AudioBufferSourceNode`s at exact sample
  frames. One `GainNode` per stem. Solo rule: any solo means non-soloed stems are silent,
  and mute always wins. Recreates the AudioContext at the stems' native sample rate.
- `src/lib/decoders.ts`: MP3 frame indexer (Xing/LAME gapless delay and padding) and WAV
  slicer, each decoding byte-range slices. Other formats fall back to a full decode
  (memory heavy). Waveform peaks come from an 8 kHz OfflineAudioContext decode.
- `src/lib/sources.ts`: `StemSource` abstraction (zip, library manifest). Strips a
  single wrapping folder, ignores `__MACOSX` and dotfiles, and turns subfolders into groups.
- `src/config.ts`: `SONGS_BASE_URL` (dev default `/songs`, prod from `VITE_SONGS_BASE_URL`).
- `dev/songs-plugin.ts`: dev-only Vite middleware serving `./songs` (or `SONGS_DIR`) as
  `/songs/index.json`, `/songs/<id>/manifest.json` and `/songs/<id>/<file>` (Range
  supported, path traversal blocked). This is the same layout S3 will use.
- `songs/` is gitignored. Song folders or symlinks go there for local testing.

## Verified (desktop Chrome, 12-stem 6:25 MP3 song)
- JS heap about 120 MB while playing, down from about 1.95 GB with a full decode.
- Load about 3.8 s, time to sound about 150 ms, seek about 40 ms.
- Chunked decode is bit-exact against a full decode (including at chunk joins), and
  all stems are aligned.

## Not yet verified
- Real iOS Safari or Android devices (memory, sync, sample-rate recreation). Test next with `pnpm dev --host`.
- WAV stems (code written, untested with real files). m4a/ogg/flac full-decode fallback.

## Decisions
- PWA over native: Web Audio gives sample-accurate multi-track sync on both platforms.
- Stems are distributed via zip now. Later: S3 + CloudFront (budget up to $5/month),
  with a static manifest per song and no database. Login (Cognito or Auth0, undecided)
  only once shared storage exists. Switching = upload the files + JSON, then set
  `VITE_SONGS_BASE_URL`.
- Prefer MP3/AAC at 256-320 kbps for the team, since phone data and load time matter.

## Possible next steps
- Device testing on iPhone and Android.
- A-B loop region, playback speed, metronome.
- S3/CloudFront infra plus an admin upload page (presigned PUT, peaks precomputed at upload).

## Git
- Commit identity is set repo-locally to the personal account (johnstephensoriao19@gmail.com).
- Push over SSH with the `github.me` alias (`~/.ssh/ghme_ed25519`, account `jssoriao`):
  `git@github.me:jssoriao/scmc-practice-mix.git`. Not pushed yet; the GitHub repo is not created yet.
- `gh` CLI is logged in as the work account (`jss-hyke`). Don't use `gh` for this repo
  unless switched to `jssoriao`.
