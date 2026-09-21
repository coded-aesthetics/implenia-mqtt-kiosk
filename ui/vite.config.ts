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
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
        // The experimental voice engine (vosk-browser, ~5.8 MB WASM) is loaded
        // lazily and must NOT be precached — that would force every kiosk to
        // download it on install over mobile data even if voice is never used.
        // It's cached on-demand via the runtimeCaching rule below instead.
        globIgnores: ['**/vosk-*.js'],
        runtimeCaching: [
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
