const CACHE_NAME = 'stack-v29';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first strategy: always try fresh, fall back to cache when offline
self.addEventListener('fetch', e => {
  e.respondWith(
    fetch(e.request).then(response => {
      const clone = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
      return response;
    }).catch(() => caches.match(e.request))
  );
});

// Handle server-sent push notifications (works even when app is closed/locked)
self.addEventListener('push', e => {
  if (!e.data) return;
  try {
    const data = e.data.json();
    const options = {
      body: data.body || '',
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      tag: (data.title || 'stack').replace(/\s+/g, '-').toLowerCase(),
      renotify: true,
      requireInteraction: false
    };
    e.waitUntil(self.registration.showNotification(data.title || 'Stack Tracker', options));
  } catch (err) {
    // Fallback for plain text
    e.waitUntil(self.registration.showNotification('Stack Tracker', { body: e.data.text() }));
  }
});

// Handle notification clicks - open or focus the app
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      if (clients.length > 0) {
        return clients[0].focus();
      }
      return self.clients.openWindow('./');
    })
  );
});
