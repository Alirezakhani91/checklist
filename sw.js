self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    try {
      await self.clients.claim();
    } catch (_) {}

    try {
      await self.registration.unregister();
    } catch (_) {}
  })());
});

// عمداً هیچ fetch handler وجود ندارد.
// تمام درخواست‌های سامانه مستقیم به Network می‌روند.
