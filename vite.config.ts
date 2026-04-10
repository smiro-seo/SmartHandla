import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    server: {
      port: 3000,
      host: '0.0.0.0',
    },
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        manifest: false, // maintained manually in /public/manifest.webmanifest
        includeAssets: ['favicon-32.png', 'apple-touch-icon.png', 'icon*.png', 'icon.svg'],
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
          navigateFallback: '/index.html',
          runtimeCaching: [
            // esm.sh CDN — React, Firebase, Gemini SDK, lucide-react all load from here.
            // MUST be cached or the app shell won't render offline at all.
            {
              urlPattern: /^https:\/\/esm\.sh\//,
              handler: 'CacheFirst',
              options: {
                cacheName: 'esm-sh-modules',
                expiration: { maxEntries: 80, maxAgeSeconds: 86400 * 30 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            // Tailwind CDN — UI is completely broken without this.
            {
              urlPattern: /^https:\/\/cdn\.tailwindcss\.com\//,
              handler: 'CacheFirst',
              options: {
                cacheName: 'tailwind-cdn',
                expiration: { maxEntries: 5, maxAgeSeconds: 86400 * 30 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            // Google Fonts CSS stylesheet.
            {
              urlPattern: /^https:\/\/fonts\.googleapis\.com\//,
              handler: 'StaleWhileRevalidate',
              options: {
                cacheName: 'google-fonts-css',
                expiration: { maxEntries: 5, maxAgeSeconds: 86400 * 7 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            // Google Fonts binary files — immutable per URL, safe to cache 1 year.
            {
              urlPattern: /^https:\/\/fonts\.gstatic\.com\//,
              handler: 'CacheFirst',
              options: {
                cacheName: 'google-fonts-files',
                expiration: { maxEntries: 10, maxAgeSeconds: 86400 * 365 },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
            // Gemini API — requires live API key embedded in bundle; never cache.
            {
              urlPattern: /^https:\/\/generativelanguage\.googleapis\.com\//,
              handler: 'NetworkOnly',
            },
            // Firebase Firestore — real-time sync; app has its own localStorage fallback.
            {
              urlPattern: /^https:\/\/firestore\.googleapis\.com\//,
              handler: 'NetworkOnly',
            },
            // Firebase Auth endpoints.
            {
              urlPattern: /^https:\/\/identitytoolkit\.googleapis\.com\//,
              handler: 'NetworkOnly',
            },
            {
              urlPattern: /^https:\/\/securetoken\.googleapis\.com\//,
              handler: 'NetworkOnly',
            },
          ],
        },
      }),
    ],
    define: {
      'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
  };
});
