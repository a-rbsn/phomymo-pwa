/**
 * Service Worker for Phomemo Print PWA
 * Handles: share target image receiving, offline caching
 */

const CACHE_NAME = 'phomemo-print-v14';
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
 * Handle share target: extract shared image or text, cache it, redirect to app
 */
async function handleShareTarget(request) {
  const appUrl = new URL('./', self.location).href;
  const debug = { fields: {}, files: {}, result: 'none', error: null };

  try {
    const formData = await request.formData();

    // Log everything in the form data for debugging
    for (const [key, value] of formData.entries()) {
      if (value instanceof File) {
        debug.files[key] = { name: value.name, type: value.type, size: value.size };
      } else {
        debug.fields[key] = value;
      }
    }

    // Check for shared image file first
    const files = formData.getAll('image');
    const file = files[0];
    if (file && file.size > 0) {
      const cache = await caches.open('shared-image');
      await cache.put('latest', new Response(file, {
        headers: { 'Content-Type': file.type || 'image/png' },
      }));
      debug.result = 'image';
      await saveDebug(debug);
      return Response.redirect(appUrl + '?share=image', 303);
    }

    // Check for text shared as a file
    const textFiles = formData.getAll('textfile');
    const textFile = textFiles[0];
    if (textFile && textFile.size > 0) {
      const fileText = await textFile.text();
      if (fileText) {
        const cache = await caches.open('shared-image');
        await cache.put('shared-text', new Response(JSON.stringify({ title: '', text: fileText }), {
          headers: { 'Content-Type': 'application/json' },
        }));
        debug.result = 'textfile';
        await saveDebug(debug);
        return Response.redirect(appUrl + '?share=text', 303);
      }
    }

    // Check for shared text via form fields
    const title = formData.get('title') || '';
    const text = formData.get('text') || '';
    if (title || text) {
      const cache = await caches.open('shared-image');
      await cache.put('shared-text', new Response(JSON.stringify({ title, text }), {
        headers: { 'Content-Type': 'application/json' },
      }));
      debug.result = 'formfield';
      await saveDebug(debug);
      return Response.redirect(appUrl + '?share=text', 303);
    }
  } catch (e) {
    debug.error = e.message;
    console.error('Share target error:', e);
  }

  await saveDebug(debug);
  return Response.redirect(appUrl + '?share=debug', 303);
}

async function saveDebug(data) {
  const cache = await caches.open('shared-image');
  await cache.put('share-debug', new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  }));
}
