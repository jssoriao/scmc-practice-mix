import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, loadEnv } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { songsPlugin } from './dev/songs-plugin.ts'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [
      react(),
      tailwindcss(),
      // dev only: serves SONGS_DIR (default ./songs) at /songs, mimicking S3/CloudFront
      songsPlugin(env.SONGS_DIR || 'songs'),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.svg'],
        manifest: {
          name: 'SCMC Practice Mix',
          short_name: 'SCMC Worship',
          description: 'Play stems together with mute and solo.',
          theme_color: '#020617',
          background_color: '#020617',
          display: 'standalone',
          icons: [
            { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          // never let the service worker cache/intercept song audio
          navigateFallbackDenylist: [/^\/songs\//],
        },
      }),
    ],
  }
})
