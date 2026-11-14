const DM_SW_BUILD = '20261114-V60';
const CACHE_NAME = 'dm-checklist-v60-clean';

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Production checklist is online-required.
  // Never serve cached HTML/JS/config for operational pages.
  if (
    req.mode === 'navigate' ||
    /\.(?:html?|js|json)$/i.test(url.pathname) ||
    url.pathname.endsWith('/checklist/') ||
    url.pathname.includes('/checklist/')
  ) {
    event.respondWith(
      fetch(req, { cache: 'no-store' }).catch(async () => {
        return new Response(
          '<!doctype html><meta charset="utf-8"><title>Offline</title><body style="font-family:sans-serif;padding:24px">اتصال اینترنت برقرار نیست. برای استفاده از سامانه به اینترنت متصل شوید.</body>',
          { headers: {'Content-Type':'text/html; charset=utf-8'}, status:503 }
        );
      })
    );
  }
});
