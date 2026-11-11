(() => {
  'use strict';

  const BUILD = '2026.11.11-PILOT-01';
  const ROOT_PATH = '/checklist/';
  const KEY_PREFIX = 'dmrt:';
  const BUILD_KEY = KEY_PREFIX + 'build';
  const BOOT_KEY = KEY_PREFIX + 'boot';
  const FAIL_KEY = KEY_PREFIX + 'fails';
  const REPAIR_KEY = KEY_PREFIX + 'lastRepair';
  const READY_EVENT = 'dm:runtime-ready';
  const MAX_BOOT_AGE_MS = 10 * 60 * 1000;
  const STALE_BOOT_MS = 20 * 1000;
  const REPAIR_COOLDOWN_MS = 15 * 60 * 1000;

  let readyState = false;
  let bootTimer = null;
  let bootStartedAt = Date.now();

  function now() { return Date.now(); }

  function safeParse(raw, fallback) {
    try { return raw ? JSON.parse(raw) : fallback; } catch (_) { return fallback; }
  }

  function lsGet(key, fallback = null) {
    try { return safeParse(localStorage.getItem(key), fallback); } catch (_) { return fallback; }
  }

  function lsSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
  }

  function ssRemoveByPrefix(prefixes) {
    try {
      const kill = [];
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (!k) continue;
        if (prefixes.some(p => k.indexOf(p) === 0)) kill.push(k);
      }
      kill.forEach(k => sessionStorage.removeItem(k));
      return kill.length;
    } catch (_) {
      return 0;
    }
  }

  function isChecklistUrl(url) {
    try {
      return new URL(url, location.href).pathname.indexOf(ROOT_PATH) === 0;
    } catch (_) {
      return false;
    }
  }

  async function unregisterLegacyWorkers() {
    if (!('serviceWorker' in navigator)) return 0;
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      const ours = regs.filter(reg => {
        try { return new URL(reg.scope).pathname.indexOf(ROOT_PATH) === 0; }
        catch (_) { return false; }
      });
      const results = await Promise.all(
        ours.map(reg => reg.unregister().catch(() => false))
      );
      return results.filter(Boolean).length;
    } catch (_) {
      return 0;
    }
  }

  async function clearChecklistCacheStorage() {
    if (!('caches' in window)) return 0;
    let removed = 0;
    try {
      const names = await caches.keys();
      for (const name of names) {
        try {
          const cache = await caches.open(name);
          const requests = await cache.keys();
          for (const req of requests) {
            if (!isChecklistUrl(req.url)) continue;
            try {
              if (await cache.delete(req)) removed++;
            } catch (_) {}
          }
        } catch (_) {}
      }
    } catch (_) {}
    return removed;
  }

  function clearInstantDataCache() {
    // Deliberately preserve dmSession, dmCurrentUser and remembered username.
    return ssRemoveByPrefix([
      'dmInstant:',
      'dmInstant:v20:',
      'dmInstant:v50:',
      'dmCache:',
      'dmBootstrap:'
    ]);
  }

  function pageName() {
    const p = (location.pathname.split('/').pop() || 'index').toLowerCase();
    return p || 'index';
  }

  function repairQueryPresent() {
    try { return new URLSearchParams(location.search).has('dmrepair'); }
    catch (_) { return false; }
  }

  function currentBoot() {
    return lsGet(BOOT_KEY, null);
  }

  function setBootPending(reason = 'boot') {
    lsSet(BOOT_KEY, {
      build: BUILD,
      page: pageName(),
      href: location.href,
      pending: true,
      reason,
      t: now()
    });
  }

  function markBootReady() {
    const b = currentBoot() || {};
    lsSet(BOOT_KEY, {
      build: BUILD,
      page: pageName(),
      href: location.href,
      pending: false,
      reason: 'ready',
      t: now()
    });
    lsSet(FAIL_KEY, { count: 0, t: now(), lastReason: '' });
  }

  function failureState() {
    return lsGet(FAIL_KEY, { count: 0, t: 0, lastReason: '' });
  }

  function registerFailure(reason) {
    const f = failureState();
    const next = {
      count: Math.min(9, Number(f.count || 0) + 1),
      t: now(),
      lastReason: String(reason || 'unknown').slice(0, 120)
    };
    lsSet(FAIL_KEY, next);
    return next;
  }

  function canAutoRepair() {
    if (repairQueryPresent()) return false;
    const r = lsGet(REPAIR_KEY, { t: 0 });
    return now() - Number(r.t || 0) > REPAIR_COOLDOWN_MS;
  }

  function withRepairQuery(url) {
    const u = new URL(url || location.href, location.href);
    u.searchParams.set('dmrepair', String(now()));
    u.searchParams.set('dmbuild', BUILD);
    return u.pathname + u.search + u.hash;
  }

  async function repair(options = {}) {
    const reload = options.reload !== false;
    const reason = String(options.reason || 'manual-repair');

    lsSet(REPAIR_KEY, { t: now(), reason, build: BUILD });
    clearInstantDataCache();

    await Promise.all([
      unregisterLegacyWorkers(),
      clearChecklistCacheStorage()
    ]);

    // Never delete authentication/session keys here.
    setBootPending('repair-complete');

    if (reload) {
      location.replace(withRepairQuery(location.href));
    }

    return true;
  }

  function emergencyOverlay(reason) {
    if (document.getElementById('dm-runtime-repair')) return;
    const root = document.body || document.documentElement;
    if (!root) return;

    const wrap = document.createElement('div');
    wrap.id = 'dm-runtime-repair';
    wrap.setAttribute('dir', 'rtl');
    wrap.style.cssText =
      'position:fixed;z-index:2147483646;inset:auto 12px 14px 12px;' +
      'max-width:520px;margin:auto;background:#101624;color:#fff;border:1px solid rgba(255,255,255,.12);' +
      'border-radius:18px;padding:15px 16px;box-shadow:0 20px 55px rgba(0,0,0,.35);' +
      'font-family:Tahoma,Arial,sans-serif;font-size:13px;line-height:1.8';

    const txt = document.createElement('div');
    txt.textContent = 'سامانه هنوز کامل آماده نشده است. در صورت ادامه مشکل، بازیابی امن فقط Cache پلتفرم را پاک می‌کند و اطلاعات ورود شما حذف نمی‌شود.';

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;margin-top:10px';

    const repairBtn = document.createElement('button');
    repairBtn.type = 'button';
    repairBtn.textContent = 'بازیابی امن';
    repairBtn.style.cssText =
      'flex:1;border:0;border-radius:12px;padding:10px;background:#d40026;color:#fff;font-weight:800';
    repairBtn.onclick = () => repair({ reason: reason || 'overlay', reload: true });

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = 'ادامه انتظار';
    closeBtn.style.cssText =
      'border:1px solid rgba(255,255,255,.18);border-radius:12px;padding:10px 14px;background:transparent;color:#fff';
    closeBtn.onclick = () => wrap.remove();

    row.appendChild(repairBtn);
    row.appendChild(closeBtn);
    wrap.appendChild(txt);
    wrap.appendChild(row);
    root.appendChild(wrap);
  }

  function ready(meta = '') {
    if (readyState) return;
    readyState = true;
    clearTimeout(bootTimer);
    markBootReady();
    const overlay = document.getElementById('dm-runtime-repair');
    if (overlay) overlay.remove();
    try {
      window.dispatchEvent(new CustomEvent(READY_EVENT, {
        detail: { build: BUILD, page: pageName(), meta }
      }));
    } catch (_) {}
  }

  function fail(reason = 'boot-failed', options = {}) {
    if (readyState) return;
    const f = registerFailure(reason);

    if (options.showOverlay !== false) {
      emergencyOverlay(reason);
    }

    // Auto-heal only after two consecutive failed boots.
    // A single slow backend request will never force a reload.
    if (f.count >= 2 && canAutoRepair() && options.autoRepair !== false) {
      setTimeout(() => {
        if (!readyState) repair({ reason: 'auto:' + reason, reload: true });
      }, 900);
    }
  }

  async function handleBuildChange() {
    let previous = '';
    try { previous = localStorage.getItem(BUILD_KEY) || ''; } catch (_) {}

    if (previous !== BUILD) {
      clearInstantDataCache();
      await Promise.all([
        unregisterLegacyWorkers(),
        clearChecklistCacheStorage()
      ]);
      try { localStorage.setItem(BUILD_KEY, BUILD); } catch (_) {}
      lsSet(FAIL_KEY, { count: 0, t: now(), lastReason: 'build-change' });
    } else {
      // Keep legacy workers out permanently even when build is unchanged.
      unregisterLegacyWorkers();
    }
  }

  function inspectPreviousBoot() {
    const previous = currentBoot();
    if (!previous || !previous.pending) return;

    const age = now() - Number(previous.t || 0);
    if (age >= STALE_BOOT_MS && age <= MAX_BOOT_AGE_MS) {
      registerFailure('previous-boot-not-ready:' + String(previous.page || 'unknown'));
    }
  }

  function boot() {
    inspectPreviousBoot();
    setBootPending('boot-start');

    handleBuildChange().catch(() => {});

    // Runtime itself loaded, but the app must call DMRuntime.ready().
    bootTimer = setTimeout(() => {
      if (!readyState) {
        fail('boot-watchdog', { autoRepair: true, showOverlay: true });
      }
    }, 25000);

    window.addEventListener('error', event => {
      if (readyState) return;
      const msg = event && event.message ? event.message : 'window-error';
      fail('js-error:' + msg, { autoRepair: true, showOverlay: true });
    });

    window.addEventListener('unhandledrejection', event => {
      if (readyState) return;
      let msg = 'promise-rejection';
      try {
        msg = event.reason && (event.reason.message || String(event.reason)) || msg;
      } catch (_) {}
      fail('promise:' + msg, { autoRepair: true, showOverlay: true });
    });
  }

  window.DMRuntime = {
    BUILD,
    ready,
    fail,
    repair,
    clearInstantDataCache,
    unregisterLegacyWorkers,
    clearChecklistCacheStorage,
    status() {
      return {
        build: BUILD,
        page: pageName(),
        ready: readyState,
        bootStartedAt,
        boot: currentBoot(),
        failures: failureState(),
        lastRepair: lsGet(REPAIR_KEY, null)
      };
    }
  };

  boot();
})();
