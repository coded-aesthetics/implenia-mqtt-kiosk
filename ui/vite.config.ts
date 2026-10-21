import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd() + '/..', 'PORT');
  const serverPort = env.PORT || '3000';

  return {
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.ico'],
      manifest: {
        name: 'Implenia Kiosk',
        short_name: 'Kiosk',
        description: 'Baustellen-Sensor-Kiosk',
        theme_color: '#1a1a2e',
        background_color: '#1a1a2e',
        display: 'standalone',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        skipWaiting: true,
        clientsClaim: true,
        /*
         * **No `html`**: the app shell is deliberately not precached.
         *
         * A precached `index.html` makes a kiosk keep running the old UI for
         * one reload after every update. The sequence: the updater swaps
         * `ui/dist`, PM2 restarts, the WebSocket reconnects and the UI reloads
         * itself (useWebSocket.ts) — and that navigation is answered by the
         * *still-controlling old* service worker out of its precache, so the
         * old `index.html` comes back pointing at the old hashed bundle. The
         * new worker installs during that page's life and claims control, but
         * the new assets are only used by the *next* navigation, which a kiosk
         * never makes. Meanwhile `/status` comes from the restarted server, so
         * the header reports the new version while running the old UI. Every
         * UI-only release shipped this way and was invisible on site.
         *
         * Navigations go `NetworkFirst` instead (below). The cost that buys it
         * is small here: the UI is served by a server on the *same machine*,
         * and if that server is not answering the kiosk is dead anyway — no
         * WebSocket, no API, no readings. A precached shell could only ever
         * render a frozen app, which is worth less than always running the
         * version that is actually installed.
         *
         * The hashed assets stay precached. They are immutable and content-
         * addressed, so they cannot go stale the way the shell can.
         */
        globPatterns: ['**/*.{js,css,ico,png,svg,woff,woff2}'],
        // The experimental voice engine (vosk-browser, ~5.8 MB WASM) is loaded
        // lazily and must NOT be precached — that would force every kiosk to
        // download it on install over mobile data even if voice is never used.
        // It's cached on-demand via the runtimeCaching rule below instead.
        globIgnores: ['**/vosk-*.js'],
        /*
         * Overrides vite-plugin-pwa's default of `'index.html'`, which would
         * register a navigation route bound to a *precached* URL — and that
         * throws `non-precached-url` at worker startup now the shell is not in
         * the manifest. The navigation rule below replaces it.
         */
        navigateFallback: undefined,
        runtimeCaching: [
          {
            /*
             * The app shell, fresh whenever the server answers.
             *
             * First in the list: workbox matches routes in order, and a
             * navigation must not fall into the `/api/` rule below it.
             *
             * It is still cached, so a kiosk whose server is restarting gets
             * the last shell it saw rather than a browser error page — after
             * `networkTimeoutSeconds`, which is short because the server is
             * local: three seconds of silence from localhost means it is down,
             * not slow. Routing is hash-based, so every navigation is `/` and
             * one entry is the whole of it; the allowance is for the SPA
             * fallback serving a deep path somebody typed.
             */
            urlPattern: ({ request }) => request.mode === 'navigate',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'app-shell',
              networkTimeoutSeconds: 3,
              expiration: { maxEntries: 4 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Cache the lazily-loaded voice engine on first use so voice works
            // offline afterwards, without bloating the install-time precache.
            urlPattern: /\/assets\/vosk-.*\.js$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'voice-engine',
              expiration: {
                maxEntries: 2,
                maxAgeSeconds: 60 * 60 * 24 * 30,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /\/status$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-status',
              networkTimeoutSeconds: 5,
              expiration: {
                maxEntries: 1,
                maxAgeSeconds: 60,
              },
            },
          },
          {
            urlPattern: /\/api\/.*/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-data',
              networkTimeoutSeconds: 5,
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 300,
              },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': `http://localhost:${serverPort}`,
      '/status': `http://localhost:${serverPort}`,
      '/ws': {
        target: `ws://localhost:${serverPort}`,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Give the vosk-browser voice engine a stable chunk name so the PWA
          // precache glob can reliably exclude it (see globIgnores above).
          if (id.includes('vosk-browser')) return 'vosk';
        },
      },
    },
  },
};
});
