(() => {
  'use strict';

  const VERSION = '23.5.0';
  const PREFIX = 'dmInstant:v20:';
  const MAX_ENTRIES = 28;
  const MAX_ITEM_CHARS = 780000;

  // Only read-only endpoints are eligible for stale-while-revalidate.
  const CACHEABLE = new Set([
    'areaHeadBootstrap',
    'areaHeadRouteBootstrap',
    'regionalBootstrap',
    'regionalOverview',
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

  // These actions describe "today"; never replay yesterday's snapshot as today.
  const DAILY = new Set([
    'areaHeadBootstrap',
    'regionalOverview',
    'executiveOverview',
    'adminBootstrap',
    'adminPilotBootstrap'
  ]);

  const handlers = new Map();
  const metrics = {
    cacheHits: 0,
    networkFresh: 0,
    backgroundRefreshes: 0,
    lastAction: '',
    lastNetworkMs: 0,
    lastCacheAgeMs: 0
  };

  let patched = false;
  let statusTimer = null;

  function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
      const out = {};
      Object.keys(value).sort().forEach(k => {
        if (k === 'token') return;
        out[k] = stable(value[k]);
      });
      return out;
    }
    return value;
  }

  function localDay() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,'0');
    const day = String(d.getDate()).padStart(2,'0');
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
    const signature = JSON.stringify(stable(params || {}));
    return `${PREFIX}${userKey()}|${action}${day}|${signature}`;
  }

  function storage() {
    try { return window.sessionStorage; }
    catch (_) { return null; }
  }

  function readEntry(action, params, maxAgeMs) {
    const s = storage();
    if (!s) return null;
    const key = cacheKey(action, params);
    try {
      const raw = s.getItem(key);
      if (!raw) return null;
      const entry = JSON.parse(raw);
      if (!entry || entry.v !== VERSION || !entry.data) {
        s.removeItem(key);
        return null;
      }
      const ageMs = Date.now() - Number(entry.t || 0);
      if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > Number(maxAgeMs || 21600000)) {
        s.removeItem(key);
        return null;
      }
      return { key, data: entry.data, ageMs, t: entry.t };
    } catch (_) {
      try { s.removeItem(key); } catch (_) {}
      return null;
    }
  }

  function prune() {
    const s = storage();
    if (!s) return;
    const rows = [];
    try {
      for (let i=0; i<s.length; i++) {
        const k = s.key(i);
        if (!k || !k.startsWith(PREFIX)) continue;
        try {
          const e = JSON.parse(s.getItem(k) || 'null');
          rows.push({k, t:Number(e?.t || 0)});
        } catch (_) {
          s.removeItem(k);
        }
      }
      rows.sort((a,b)=>b.t-a.t);
      rows.slice(MAX_ENTRIES).forEach(x=>s.removeItem(x.k));
    } catch (_) {}
  }

  function writeEntry(action, params, data) {
    if (!data || data.success === false) return false;
    const s = storage();
    if (!s) return false;
    const key = cacheKey(action, params);
    try {
      const payload = JSON.stringify({v:VERSION,t:Date.now(),data});
      if (payload.length > MAX_ITEM_CHARS) return false;
      s.setItem(key, payload);
      prune();
      return true;
    } catch (_) {
      // Quota: remove older Instant cache entries and retry once.
      try {
        const kill = [];
        for (let i=0;i<s.length;i++) {
          const k=s.key(i);
          if(k&&k.startsWith(PREFIX)) kill.push(k);
        }
        kill.slice(0,Math.max(1,Math.ceil(kill.length/2))).forEach(k=>s.removeItem(k));
        const payload = JSON.stringify({v:VERSION,t:Date.now(),data});
        if (payload.length <= MAX_ITEM_CHARS) {
          s.setItem(key,payload);
          return true;
        }
      } catch (_) {}
      return false;
    }
  }

  function clearUserCache() {
    const s = storage();
    if (!s) return;
    const prefix = `${PREFIX}${userKey()}|`;
    try {
      const keys=[];
      for(let i=0;i<s.length;i++){
        const k=s.key(i);
        if(k&&k.startsWith(prefix))keys.push(k);
      }
      keys.forEach(k=>s.removeItem(k));
    } catch (_) {}
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
        transition:opacity .2s ease,transform .2s ease;
        backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)
      }
      #dm-instant-status.show{opacity:1;transform:translateY(0)}
      #dm-instant-status .dot{width:7px;height:7px;border-radius:50%;background:#ff3858}
      #dm-instant-status.fresh .dot{background:#20b26b}
      @media(max-width:700px){#dm-instant-status{left:12px;bottom:76px;font-size:.58rem;padding:7px 9px}}
    `;
    document.head.appendChild(style);
    el = document.createElement('div');
    el.id='dm-instant-status';
    el.innerHTML='<span class="dot"></span><span class="txt"></span>';
    (document.body||document.documentElement).appendChild(el);
    return el;
  }

  function status(text, fresh=false, keepMs=1600) {
    if (!text) return;
    const el=ensureStatus();
    el.querySelector('.txt').textContent=text;
    el.classList.toggle('fresh',!!fresh);
    el.classList.add('show');
    clearTimeout(statusTimer);
    statusTimer=setTimeout(()=>el.classList.remove('show'),keepMs);
  }

  function emit(action, params, data, meta) {
    const list = handlers.get(action) || [];
    list.forEach(fn => {
      try { fn(data, params || {}, meta || {}); } catch (e) { console.warn('[DMInstant handler]', action, e); }
    });
    try {
      window.dispatchEvent(new CustomEvent('dm:instant-fresh',{detail:{action,params:params||{},data,meta:meta||{}}}));
    } catch (_) {}
  }

  function on(action, fn) {
    if (!handlers.has(action)) handlers.set(action, []);
    handlers.get(action).push(fn);
  }

  function peek(action, params={}, maxAgeMs=21600000) {
    return readEntry(action,params,maxAgeMs);
  }

  function prefetch(action, params={}, timeoutMs=60000) {
    if (!CACHEABLE.has(action) || !window.DMAuth || typeof DMAuth.apiPost !== 'function') return;
    const conn=navigator.connection||navigator.mozConnection||navigator.webkitConnection;
    if (conn && (conn.saveData || /2g/.test(String(conn.effectiveType||'')))) return;

    const run=()=>{
      // Existing cache means there is no need to spend network on speculative prefetch.
      if (readEntry(action,params,20*60*1000)) return;
      Promise.resolve(DMAuth.apiPost(action,params,timeoutMs)).catch(()=>{});
    };
    if ('requestIdleCallback' in window) requestIdleCallback(run,{timeout:2500});
    else setTimeout(run,1600);
  }

  function schedulePagePrefetch() {
    setTimeout(()=>{
      const path=(location.pathname.split('/').pop()||'').toLowerCase();
      if(path.includes('regional-dashboard')) prefetch('regionalPerformance',{periodDays:7},60000);
      else if(path.includes('executive-dashboard')) prefetch('executivePerformance',{periodDays:7},60000);
      else if(path.includes('admin-dashboard')){
        prefetch('adminRegionalManagersBootstrap',{},60000);
        setTimeout(()=>prefetch('adminAreaHeadsBootstrap',{},60000),700);
      }
    },2200);
  }

  function patchApiPost() {
    if (patched || !window.DMAuth || typeof DMAuth.apiPost !== 'function') return false;
    patched=true;
    const original = DMAuth.apiPost.bind(DMAuth);

    DMAuth.apiPost = async function(action, params={}, timeoutMs) {
      action=String(action||'');
      params=params||{};

      if (!CACHEABLE.has(action)) {
        const result = await original(action,params,timeoutMs);
        if (result && result.success !== false) clearUserCache();
        return result;
      }

      // max replay age: current operational pages 6h; filtered historical views 2h.
      const maxAge =
        action==='regionalOverview' ? 15*1000 :
        action==='regionalPerformance' ? 20*1000 :
        ((action==='visitHistory'||action==='visitDetail'||action==='alertsCenter')
          ? 2*60*60*1000
          : 6*60*60*1000);
      const cached = readEntry(action,params,maxAge);

      if (!cached) {
        const t0=performance.now();
        const fresh=await original(action,params,timeoutMs);
        metrics.lastNetworkMs=Math.round(performance.now()-t0);
        metrics.networkFresh++;
        metrics.lastAction=action;
        if (fresh && fresh.success !== false) writeEntry(action,params,fresh);
        return fresh;
      }

      metrics.cacheHits++;
      metrics.backgroundRefreshes++;
      metrics.lastAction=action;
      metrics.lastCacheAgeMs=cached.ageMs;
      status('نمایش فوری • در حال بروزرسانی');

      // Background refresh; caller receives cache now.
      const t0=performance.now();
      Promise.resolve(original(action,params,timeoutMs)).then(fresh=>{
        metrics.lastNetworkMs=Math.round(performance.now()-t0);
        metrics.networkFresh++;
        if (!fresh || fresh.success===false) return;
        writeEntry(action,params,fresh);
        emit(action,params,fresh,{source:'fresh',background:true,networkMs:metrics.lastNetworkMs});
        status('اطلاعات تازه شد',true,1100);
      }).catch(err=>{
        console.warn('[DMInstant refresh failed]',action,err);
        status('نمایش نسخه ذخیره‌شده');
      });

      return cached.data;
    };
    return true;
  }

  function init() {
    ensureStatus();
    if(!patchApiPost()){
      let tries=0;
      const timer=setInterval(()=>{
        tries++;
        if(patchApiPost()||tries>120)clearInterval(timer);
      },35);
    }
    schedulePagePrefetch();
  }

  window.DMInstant={
    version:VERSION,
    on,
    peek,
    prefetch,
    clearUserCache,
    stats:()=>Object.assign({},metrics),
    status
  };

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init,{once:true});
  else init();
})();
