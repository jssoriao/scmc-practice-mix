/**
 * Where the song library lives.
 * - dev: defaults to `/songs`, served from ./songs by the dev plugin
 * - prod: set VITE_SONGS_BASE_URL (e.g. https://dxxxx.cloudfront.net); empty = zip-only
 */
const configured = (import.meta.env.VITE_SONGS_BASE_URL as string | undefined) ?? (import.meta.env.DEV ? '/songs' : '')

export const SONGS_BASE_URL = configured.replace(/\/+$/, '')
