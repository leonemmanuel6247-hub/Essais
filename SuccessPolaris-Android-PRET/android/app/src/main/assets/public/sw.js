const CACHE_NAME = 'polaris-cache-v2';
const OFFLINE_CACHE = 'polaris-offline-v2';
const DB_NAME = 'PolarisDB';
const DB_VERSION = 1;

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-72x72.png',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png'
];

const GOOGLE_PATTERNS = [
  'google.com/spreadsheets',
  'script.google.com',
  'googleusercontent.com',
  'generativelanguage.googleapis.com',
  'googleapis.com'
];

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('sheets_cache')) {
        db.createObjectStore('sheets_cache', { keyPath: 'url' });
      }
      if (!db.objectStoreNames.contains('app_data')) {
        db.createObjectStore('app_data', { keyPath: 'key' });
      }
    };
  });
}

function saveToIndexedDB(storeName, data) {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      store.put(data);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }).catch(() => {});
}

function getFromIndexedDB(storeName, key) {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }).catch(() => null);
}

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS.map(url => new Request(url, { cache: 'no-cache' })))
        .catch(() => {});
    })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then(cacheNames => {
        return Promise.all(
          cacheNames
            .filter(name => name !== CACHE_NAME && name !== OFFLINE_CACHE)
            .map(name => caches.delete(name))
        );
      })
    ])
  );
});

self.addEventListener('fetch', event => {
  const url = event.request.url;

  if (event.request.method !== 'GET') return;

  const isGoogleAPI = GOOGLE_PATTERNS.some(pattern => url.includes(pattern));

  if (isGoogleAPI) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response.ok) {
            const cloned = response.clone();
            cloned.text().then(text => {
              saveToIndexedDB('sheets_cache', {
                url: url,
                data: text,
                timestamp: Date.now()
              });
            });
          }
          return response;
        })
        .catch(async () => {
          const cached = await getFromIndexedDB('sheets_cache', url);
          if (cached) {
            return new Response(cached.data, {
              headers: {
                'Content-Type': 'text/plain',
                'X-Polaris-Offline': 'true'
              }
            });
          }
          return new Response(JSON.stringify({ error: 'offline', total: 0 }), {
            headers: { 'Content-Type': 'application/json' }
          });
        })
    );
    return;
  }

  if (url.includes('cdn.tailwindcss.com') ||
      url.includes('fonts.googleapis.com') ||
      url.includes('fonts.gstatic.com') ||
      url.includes('cdnjs.cloudflare.com')) {
    event.respondWith(
      caches.open(OFFLINE_CACHE).then(cache => {
        return cache.match(event.request).then(cached => {
          if (cached) return cached;
          return fetch(event.request).then(response => {
            if (response.ok) cache.put(event.request, response.clone());
            return response;
          }).catch(() => new Response('', { status: 503 }));
        });
      })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok) {
          const cloned = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, cloned));
        }
        return response;
      }).catch(async () => {
        const offlinePage = await caches.match('/index.html');
        return offlinePage || new Response('Hors ligne', { status: 503 });
      });
    })
  );
});

self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
