self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    (async function () {
      try {
        await self.clients.claim();
      } catch (_) {}

      try {
        await self.registration.unregister();
      } catch (_) {}
    })()
  );
});

// Rollback:
// هیچ درخواست شبکه‌ای توسط Service Worker کنترل نمی‌شود.
// سامانه مستقیماً از Network بارگذاری می‌شود.
