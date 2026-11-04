(() => {
  'use strict';

  const VERSION = '53.0.0';
  const PREFIX = 'dmInstant:v53:';
  const MAX_ENTRIES_SESSION = 42;
  const MAX_ENTRIES_LOCAL = 22;
  const MAX_ITEM_CHARS = 900000;

  // Read-only endpoints eligible for stale-while-revalidate.
  // GPS / location actions are intentionally NOT here.
  const CACHEABLE = new Set([
    'areaHeadBootstrap',
    'areaHeadRouteBootstrap',
    'checklistBootstrap',
    'regionalBootstrap',
    'regionalChecklistBuilderBootstrap',
    'regionalPerformance',
    'executiveOverview',
    'executivePerformance',
    'adminBootstrap',
    'adminRegionalManagersBootstrap',
    'adminAreaHeadsBootstrap',
    'adminStoreMasterBootstrap',
    'alertsCenter',
    'visitHistory',
    'visitDetail',
    'adminPilotBootstrap'
  ]);

  // Persist only the operational reads that materially improve the Area Head's daily flow.
  // Keying by user + day prevents yesterday's operational snapshot from becoming today's truth.
  const LOCAL_PERSIST = new Set([
    'areaHeadBootstrap',
    'areaHeadRouteBootstrap',
    'checklistBootstrap'
  ]);

  const DAILY = new Set([
    'areaHeadBootstrap',
    'areaHeadRouteBootstrap',
    'executiveOverview',
    'adminBootstrap',
    'adminPilotBootstrap'
  ]);

  // These actions must always be live. They are never replayed from cache.
  const GPS_LIVE = new Set([
    'areaHeadVisitState',
    'startVisit',
    'confirmSoftPresence',
    'requestLocationApproval',
    'requestStoreLocationCorrection',
    'cancelPendingLocationCorrection',
    'cancelPendingApproval',
    'cancelVisitStart',
    'regionalGpsBadgeCounts',
    'regionalGpsCenter',
    'regionalLocationApprovals',
    'decideLocationApproval',
    'regionalLocationCorrections',
    'decideLocationCorrection'
  ]);

  const memory = new Map();
  const handlers = new Map();
  const inFlight = new Map();

  const metrics = {
    cacheHits: 0,
    memoryHits: 0,
    sessionHits: 0,
    localHits: 0,
    networkFresh: 0,
    backgroundRefreshes: 0,
    coalescedReads: 0,
    targetedInvalidations: 0,
    lastAction: '',
    lastNetworkMs: 0,
    lastCacheAgeMs: 0
  };

  let patched = false;
  let statusTimer = null;
  let originalPost = null;

  function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
      const out = {};
      Object.keys(value).sort().forEach(k => {
        if (k === 'token' || k === 'forceFresh' || k === '_fresh' || k === 'cacheBust') return;
        out[k] = stable(value[k]);
      });
      return out;
    }
    return value;
  }

  function canonicalParams(params) {
    const out = {};
    Object.keys(params || {}).forEach(k => {
      if (k === 'token' || k === 'forceFresh' || k === '_fresh' || k === 'cacheBust') return;
      out[k] = params[k];
    });
    return out;
  }

  function isForceFresh(params) {
    const v = params && (params.forceFresh ?? params._fresh);
    return v === true || String(v || '').toLowerCase() === 'true' || String(v || '') === '1';
  }

  function localDay() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function userKey() {
    try {
      const u = window.DMAuth && DMAuth.getUser ? DMAuth.getUser() : null;
      return `${String(u?.userId || 'anon')}|${String(u?.role || '')}`;
    } catch (_) {
      return 'anon|';
    }
  }

  function cacheKey(action, params) {
    const day = DAILY.has(action) ? `|${localDay()}` : '';
    const signature = JSON.stringify(stable(canonicalParams(params || {})));
    return `${PREFIX}${userKey()}|${action}${day}|${signature}`;
  }

  function sessionStore() {
    try { return window.sessionStorage; } catch (_) { return null; }
  }

  function localStore() {
    try { return window.localStorage; } catch (_) { return null; }
  }

  function ttlFor(action) {
    switch (action) {
      case 'areaHeadBootstrap': return 6 * 60 * 60 * 1000;
      case 'areaHeadRouteBootstrap': return 10 * 60 * 1000;
      case 'checklistBootstrap': return 20 * 60 * 1000;
      case 'regionalPerformance': return 20 * 1000;
      case 'visitHistory':
      case 'visitDetail':
      case 'alertsCenter': return 2 * 60 * 60 * 1000;
      default: return 6 * 60 * 60 * 1000;
    }
  }

  function parseEntry(raw, action, maxAgeMs) {
    if (!raw) return null;
    try {
      const entry = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!entry || entry.v !== VERSION || !entry.data) return null;
      const ageMs = Date.now() - Number(entry.t || 0);
      const maxAge = Number(maxAgeMs || ttlFor(action));
      if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > maxAge) return null;
      return { data: entry.data, ageMs, t: entry.t };
    } catch (_) {
      return null;
    }
  }

  function readEntry(action, params = {}, maxAgeMs) {
    const key = cacheKey(action, params);

    const mem = parseEntry(memory.get(key), action, maxAgeMs);
    if (mem) {
      metrics.memoryHits++;
      return { key, source: 'memory', ...mem };
    }
    memory.delete(key);

    const ss = sessionStore();
    if (ss) {
      try {
        const raw = ss.getItem(key);
        const hit = parseEntry(raw, action, maxAgeMs);
        if (hit) {
          memory.set(key, { v: VERSION, t: hit.t, data: hit.data });
          metrics.sessionHits++;
          return { key, source: 'session', ...hit };
        }
        if (raw) ss.removeItem(key);
      } catch (_) {}
    }

    if (LOCAL_PERSIST.has(action)) {
      const ls = localStore();
      if (ls) {
        try {
          const raw = ls.getItem(key);
          const hit = parseEntry(raw, action, maxAgeMs);
          if (hit) {
            const entry = { v: VERSION, t: hit.t, data: hit.data };
            memory.set(key, entry);
            try { ss?.setItem(key, JSON.stringify(entry)); } catch (_) {}
            metrics.localHits++;
            return { key, source: 'local', ...hit };
          }
          if (raw) ls.removeItem(key);
        } catch (_) {}
      }
    }

    return null;
  }

  function pruneStore(store, limit) {
    if (!store) return;
    const rows = [];
    try {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (!k || !k.startsWith(PREFIX)) continue;
        try {
          const e = JSON.parse(store.getItem(k) || 'null');
          rows.push({ k, t: Number(e?.t || 0) });
        } catch (_) {
          store.removeItem(k);
        }
      }
      rows.sort((a, b) => b.t - a.t);
      rows.slice(limit).forEach(x => store.removeItem(x.k));
    } catch (_) {}
  }

  function writeEntry(action, params, data, timestamp = Date.now()) {
    if (!data || data.success === false) return false;

    const key = cacheKey(action, params);
    const entry = { v: VERSION, t: timestamp, data };
    let payload;
    try {
      payload = JSON.stringify(entry);
      if (payload.length > MAX_ITEM_CHARS) return false;
    } catch (_) {
      return false;
    }

    memory.set(key, entry);

    const ss = sessionStore();
    try {
      ss?.setItem(key, payload);
      pruneStore(ss, MAX_ENTRIES_SESSION);
    } catch (_) {}

    if (LOCAL_PERSIST.has(action)) {
      const ls = localStore();
      try {
        ls?.setItem(key, payload);
        pruneStore(ls, MAX_ENTRIES_LOCAL);
      } catch (_) {}
    }

    return true;
  }

  function forEachUserCacheKey(fn) {
    const prefix = `${PREFIX}${userKey()}|`;

    [...memory.keys()].forEach(k => {
      if (k.startsWith(prefix)) fn({ type: 'memory', key: k, store: memory });
    });

    [sessionStore(), localStore()].forEach(store => {
      if (!store) return;
      try {
        const keys = [];
        for (let i = 0; i < store.length; i++) {
          const k = store.key(i);
          if (k && k.startsWith(prefix)) keys.push(k);
        }
        keys.forEach(k => fn({ type: 'storage', key: k, store }));
      } catch (_) {}
    });
  }

  function removeCacheKey(entry) {
    try {
      if (entry.type === 'memory') entry.store.delete(entry.key);
      else entry.store.removeItem(entry.key);
    } catch (_) {}
  }

  function clearUserCache() {
    forEachUserCacheKey(removeCacheKey);
  }

  function invalidateAction(action) {
    const marker = `|${String(action)}${DAILY.has(action) ? `|${localDay()}|` : ''}`;
    forEachUserCacheKey(entry => {
      const k = entry.key;
      const hit = DAILY.has(action)
        ? k.includes(marker)
        : k.includes(`|${String(action)}|`);
      if (hit) removeCacheKey(entry);
    });
    metrics.targetedInvalidations++;
  }

  function invalidateActions(actions) {
    (actions || []).forEach(invalidateAction);
  }

  function patchChecklistDraft(params, result) {
    const visitId = String(params?.visitId || '').trim();
    if (!visitId) return;

    const p = { visitId };
    const hit = readEntry('checklistBootstrap', p, 24 * 60 * 60 * 1000);
    if (!hit?.data?.success) return;

    let answers = {};
    try { answers = JSON.parse(String(params.answersJson || '{}')) || {}; } catch (_) {}

    const next = Object.assign({}, hit.data, {
      answers: result?.answers || answers,
      visitNotes: String(params.visitNotes || ''),
      progress: result?.progress || hit.data.progress
    });
    writeEntry('checklistBootstrap', p, next);
  }

  function handleWriteSuccess(action, params, result) {
    // Most frequent Area Head write: keep the operating cache intact.
    if (action === 'saveChecklistDraft') {
      patchChecklistDraft(params, result);
      return;
    }

    // This write does not change route/checklist state.
    if (action === 'createMaintenanceRequest') return;

    if (action === 'completeChecklist') {
      invalidateActions(['checklistBootstrap', 'areaHeadBootstrap', 'visitHistory', 'visitDetail', 'alertsCenter']);
      return;
    }

    if (action === 'reportCannotVisit') {
      invalidateActions(['areaHeadBootstrap']);
      return;
    }

    if (action === 'areaHeadSaveWeekRoutes' || action === 'setAreaHeadDayStatus' || action === 'setAreaHeadLeave') {
      invalidateActions(['areaHeadBootstrap', 'areaHeadRouteBootstrap']);
      return;
    }

    if (GPS_LIVE.has(action)) {
      // Location itself is never cached. Only dependent screen snapshots are invalidated.
      invalidateActions(['areaHeadBootstrap', 'checklistBootstrap', 'visitHistory', 'visitDetail']);
      return;
    }

    // Preserve correctness for other management write actions.
    clearUserCache();
  }

  function ensureStatus() {
    let el = document.getElementById('dm-instant-status');
    if (el) return el;

    const style = document.createElement('style');
    style.id = 'dm-instant-style';
    style.textContent = `
      #dm-instant-status{
        position:fixed;left:18px;bottom:18px;z-index:999998;
        display:flex;align-items:center;gap:7px;
        padding:8px 11px;border-radius:999px;
        background:rgba(20,25,34,.90);color:#fff;
        box-shadow:0 10px 30px rgba(17,24,39,.18);
        font-family:inherit;font-size:.63rem;font-weight:800;
        opacity:0;transform:translateY(8px);pointer-events:none;
        transition:opacity .18s ease,transform .18s ease;
        backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)
      }
      #dm-instant-status.show{opacity:1;transform:translateY(0)}
      #dm-instant-status .dot{width:7px;height:7px;border-radius:50%;background:#ff3858}
      #dm-instant-status.fresh .dot{background:#20b26b}
      @media(max-width:700px){
        #dm-instant-status{left:12px;bottom:76px;font-size:.58rem;padding:7px 9px}
      }
    `;
    document.head.appendChild(style);

    el = document.createElement('div');
    el.id = 'dm-instant-status';
    el.innerHTML = '<span class="dot"></span><span class="txt"></span>';
    (document.body || document.documentElement).appendChild(el);
    return el;
  }

  function status(text, fresh = false, keepMs = 1200) {
    if (!text) return;
    const el = ensureStatus();
    const t = el.querySelector('.txt');
    if (t) t.textContent = text;
    el.classList.toggle('fresh', !!fresh);
    el.classList.add('show');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => el.classList.remove('show'), keepMs);
  }

  function emit(action, params, data, meta) {
    const list = handlers.get(action) || [];
    list.forEach(fn => {
      try { fn(data, params || {}, meta || {}); }
      catch (e) { console.warn('[DMInstant handler]', action, e); }
    });

    try {
      window.dispatchEvent(new CustomEvent('dm:instant-fresh', {
        detail: { action, params: params || {}, data, meta: meta || {} }
      }));
    } catch (_) {}
  }

  function on(action, fn) {
    if (!handlers.has(action)) handlers.set(action, []);
    handlers.get(action).push(fn);
  }

  function peek(action, params = {}, maxAgeMs) {
    return readEntry(action, params, maxAgeMs || ttlFor(action));
  }

  function put(action, params = {}, data) {
    return writeEntry(action, params, data);
  }

  function networkKey(action, params) {
    return `${action}|${JSON.stringify(stable(canonicalParams(params || {})))}`;
  }

  async function networkRead(action, params, timeoutMs) {
    const key = networkKey(action, params);
    if (inFlight.has(key)) {
      metrics.coalescedReads++;
      return inFlight.get(key);
    }

    const p = (async () => {
      const t0 = performance.now();
      try {
        const fresh = await originalPost(action, params, timeoutMs);
        metrics.lastNetworkMs = Math.round(performance.now() - t0);
        metrics.networkFresh++;
        metrics.lastAction = action;

        if (fresh && fresh.success !== false) {
          writeEntry(action, canonicalParams(params), fresh);
          emit(action, canonicalParams(params), fresh, {
            source: 'fresh',
            networkMs: metrics.lastNetworkMs
          });

          if (action === 'areaHeadBootstrap') {
            const visitId = String(fresh?.openVisit?.visitId || '').trim();
            const status = String(fresh?.openVisit?.visitStatus || '').toUpperCase();
            if (visitId && status === 'IN_PROGRESS') {
              setTimeout(() => prefetch('checklistBootstrap', { visitId }, 40000), 120);
            }
          }
        }
        return fresh;
      } finally {
        inFlight.delete(key);
      }
    })();

    inFlight.set(key, p);
    return p;
  }

  function prefetch(action, params = {}, timeoutMs = 60000) {
    if (!CACHEABLE.has(action) || !originalPost) return;

    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn && (conn.saveData || /2g/.test(String(conn.effectiveType || '')))) return;

    const run = () => {
      if (readEntry(action, params, Math.min(ttlFor(action), 20 * 60 * 1000))) return;
      networkRead(action, canonicalParams(params), timeoutMs).catch(() => {});
    };

    if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 1200 });
    else setTimeout(run, 300);
  }

  function schedulePagePrefetch() {
    setTimeout(() => {
      const path = (location.pathname.split('/').pop() || '').toLowerCase();
      if (path.includes('areahead-dashboard')) {
        prefetch('areaHeadBootstrap', {}, 40000);
      } else if (path.includes('regional-dashboard')) {
        prefetch('regionalPerformance', { periodDays: 7 }, 60000);
      } else if (path.includes('executive-dashboard')) {
        prefetch('executivePerformance', { periodDays: 7 }, 60000);
      } else if (path.includes('admin-dashboard')) {
        prefetch('adminRegionalManagersBootstrap', {}, 60000);
        setTimeout(() => prefetch('adminAreaHeadsBootstrap', {}, 60000), 500);
      }
    }, 500);
  }

  function patchApiPost() {
    if (patched || !window.DMAuth || typeof DMAuth.apiPost !== 'function') return false;

    patched = true;
    originalPost = DMAuth.apiPost.bind(DMAuth);

    DMAuth.apiPost = async function(action, params = {}, timeoutMs) {
      action = String(action || '');
      params = params || {};

      // Writes and all GPS/location operations are always live.
      if (!CACHEABLE.has(action)) {
        const t0 = performance.now();
        const result = await originalPost(action, params, timeoutMs);
        metrics.lastNetworkMs = Math.round(performance.now() - t0);
        metrics.networkFresh++;
        metrics.lastAction = action;

        if (result && result.success !== false) {
          handleWriteSuccess(action, params, result);
        }
        return result;
      }

      const forceFresh = isForceFresh(params);
      const canonical = canonicalParams(params);
      const maxAge = ttlFor(action);

      if (forceFresh) {
        const fresh = await networkRead(action, canonical, timeoutMs);
        return fresh;
      }

      const cached = readEntry(action, canonical, maxAge);

      if (!cached) {
        return networkRead(action, canonical, timeoutMs);
      }

      metrics.cacheHits++;
      metrics.lastAction = action;
      metrics.lastCacheAgeMs = cached.ageMs;

      status(cached.source === 'local'
        ? 'نمایش فوری • همگام‌سازی'
        : 'نمایش فوری');

      // SWR: UI gets snapshot now; server refreshes in background.
      metrics.backgroundRefreshes++;
      networkRead(action, canonical, timeoutMs)
        .then(() => status('اطلاعات تازه شد', true, 900))
        .catch(err => {
          console.warn('[DMInstant refresh failed]', action, err);
          status('نسخه ذخیره‌شده فعال است');
        });

      return cached.data;
    };

    return true;
  }

  function init() {
    ensureStatus();

    if (!patchApiPost()) {
      let tries = 0;
      const timer = setInterval(() => {
        tries++;
        if (patchApiPost() || tries > 120) clearInterval(timer);
      }, 35);
    }

    schedulePagePrefetch();
  }

  window.DMInstant = {
    version: VERSION,
    on,
    peek,
    put,
    prefetch,
    invalidateAction,
    invalidateActions,
    clearUserCache,
    isGpsLive: action => GPS_LIVE.has(String(action || '')),
    stats: () => Object.assign({}, metrics),
    status
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
