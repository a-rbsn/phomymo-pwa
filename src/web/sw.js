/**
 * Service Worker for Phomemo Print PWA
 * Handles: share target image receiving, offline caching
 */

const CACHE_NAME = 'phomemo-print-v1';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './ble.js',
  './printer.js',
  './constants.js',
  './printers.json',
  './style.css',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-maskable.svg',
];

// Install — cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate — clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME && k !== 'shared-image')
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Fetch — handle share target + cache-first for assets
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Handle share target POST
  if (url.pathname.endsWith('/share-target') && event.request.method === 'POST') {
    event.respondWith(handleShareTarget(event.request));
    return;
  }

  // Cache-first for app assets, network fallback
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).catch(() => {
        // Offline fallback for navigation
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});

/**
 * Handle share target: extract shared image, cache it, redirect to app
 */
async function handleShareTarget(request) {
  try {
    const formData = await request.formData();
    const files = formData.getAll('image');
    const file = files[0];

    if (file && file.size > 0) {
      // Store shared image in a temporary cache
      const cache = await caches.open('shared-image');
      await cache.put('latest', new Response(file, {
        headers: { 'Content-Type': file.type || 'image/png' },
      }));
    }
  } catch (e) {
    console.error('Share target error:', e);
  }

  // Redirect to main app with share flag
  const appUrl = new URL('./', self.location).href;
  return Response.redirect(appUrl + '?share=1', 303);
}
