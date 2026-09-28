const CACHE = 'cachetray-phone-v7';
const SHELL = ['/received.html', '/received.css?v=7', '/received.js?v=7', '/transfer-config.js?v=7', '/logo-icon.png', '/icon-192.png', '/icon-512.png'];
const FRESH_ASSETS = new Set(['/received.html', '/received.css', '/received.js', '/transfer-config.js']);
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))));
  self.clients.claim();
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  const options = FRESH_ASSETS.has(url.pathname) ? { cache: 'no-store' } : undefined;
  event.respondWith(fetch(event.request, options).catch(() => caches.match(event.request)));
});
