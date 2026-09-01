(() => {
  'use strict';

  const DEFAULT_TITLE = 'در حال دریافت و به‌روزرسانی اطلاعات…';
  const SLOW_TEXT = 'هنوز در حال دریافت اطلاعات هستیم…';
  const DONE_TEXT = 'اطلاعات به‌روز شد';
  const stateMap = new WeakMap();

  let apiPending = 0;
  let apiTimer = null;
  let topProgress = 0;
  let topInterval = null;
  let patched = false;

  function injectCss() {
    if (document.getElementById('dm-loading-style')) return;
    const style = document.createElement('style');
    style.id = 'dm-loading-style';
    style.textContent = `
      #dm-network-progress{
        position:fixed;top:0;left:0;right:0;height:4px;z-index:1000000;
        pointer-events:none;opacity:0;transition:opacity .18s ease;
        direction:ltr;
      }
      #dm-network-progress.dm-visible{opacity:1}
      #dm-network-progress .dm-net-bar{
        width:0;height:100%;
        background:linear-gradient(90deg,#d30024,#ff4968);
        box-shadow:0 0 12px rgba(211,0,36,.24);
        border-radius:0 3px 3px 0;
        transition:width .24s cubic-bezier(.22,.61,.36,1);
      }

      .dm-progress-overlay{
        background:rgba(246,248,251,.80)!important;
        backdrop-filter:blur(7px);
        -webkit-backdrop-filter:blur(7px);
      }
      .dm-progress-overlay .loader,
      .dm-progress-overlay .loader-card,
      .dm-progress-overlay .loading-card{
        width:min(390px,calc(100vw - 34px))!important;
        min-width:0!important;
        padding:23px 24px 21px!important;
        border-radius:22px!important;
        border:1px solid rgba(218,223,232,.95)!important;
        background:rgba(255,255,255,.96)!important;
        box-shadow:0 22px 60px rgba(22,31,49,.14)!important;
        display:block!important;
        text-align:right!important;
      }
      .dm-progress-overlay .spin,
      .dm-progress-overlay .spinner{
        display:none!important;
      }
      .dm-progress-overlay .dm-original-loader-text{
        display:none!important;
      }
      .dm-loading-copy{display:block}
      .dm-loading-title{
        display:block;
        margin:0;
        font-size:.91rem;
        font-weight:900;
        line-height:1.8;
        color:#161b24;
      }
      .dm-loading-detail{
        display:block;
        min-height:21px;
        margin-top:3px;
        color:#7b8391;
        font-size:.67rem;
        font-weight:500;
        line-height:1.8;
        white-space:nowrap;
        overflow:hidden;
        text-overflow:ellipsis;
      }
      .dm-progress-track{
        height:9px;
        margin-top:17px;
        overflow:hidden;
        border-radius:999px;
        background:#edf0f4;
        direction:ltr;
        box-shadow:inset 0 1px 2px rgba(25,35,50,.04);
      }
      .dm-progress-fill{
        width:5%;
        height:100%;
        border-radius:inherit;
        background:linear-gradient(90deg,#a9001c,#dc0025,#f04461);
        transition:width .34s cubic-bezier(.22,.61,.36,1);
        position:relative;
      }
      .dm-progress-fill:after{
        content:"";
        position:absolute;
        inset:0;
        width:34%;
        transform:translateX(-130%);
        background:linear-gradient(90deg,transparent,rgba(255,255,255,.48),transparent);
        animation:dmProgressShine 1.35s linear infinite;
      }
      @keyframes dmProgressShine{
        to{transform:translateX(420%)}
      }
      .dm-progress-footer{
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:10px;
        margin-top:9px;
        color:#8a919e;
        font-size:.58rem;
      }
      .dm-progress-pulse{
        display:inline-flex;align-items:center;gap:6px;
      }
      .dm-progress-pulse:before{
        content:"";
        width:6px;height:6px;border-radius:50%;
        background:#d00023;
        box-shadow:0 0 0 0 rgba(208,0,35,.28);
        animation:dmPulse 1.5s ease-out infinite;
      }
      @keyframes dmPulse{
        0%{box-shadow:0 0 0 0 rgba(208,0,35,.28)}
        70%{box-shadow:0 0 0 7px rgba(208,0,35,0)}
        100%{box-shadow:0 0 0 0 rgba(208,0,35,0)}
      }
      .dm-progress-overlay.dm-completing .dm-progress-fill{
        transition:width .18s ease-out;
      }
      .dm-progress-overlay.dm-completing .dm-progress-fill:after{
        display:none;
      }
      @media(max-width:600px){
        .dm-progress-overlay .loader,
        .dm-progress-overlay .loader-card,
        .dm-progress-overlay .loading-card{
          padding:20px 19px 18px!important;
          border-radius:19px!important;
        }
        .dm-loading-title{font-size:.86rem}
        .dm-loading-detail{font-size:.64rem}
        .dm-progress-track{height:8px;margin-top:14px}
      }
      @media(prefers-reduced-motion:reduce){
        .dm-progress-fill,.dm-net-bar{transition:none!important}
        .dm-progress-fill:after,.dm-progress-pulse:before{animation:none!important}
      }
    `;
    document.head.appendChild(style);
  }

  function ensureTopBar() {
    let root = document.getElementById('dm-network-progress');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'dm-network-progress';
    root.innerHTML = '<div class="dm-net-bar"></div>';
    (document.body || document.documentElement).appendChild(root);
    return root;
  }

  function topSet(value) {
    topProgress = Math.max(topProgress, value);
    const root = ensureTopBar();
    const bar = root.querySelector('.dm-net-bar');
    bar.style.width = Math.min(100, topProgress) + '%';
  }

  function hasActiveOverlay() {
    return !!document.querySelector('.dm-progress-overlay:not(.hidden)');
  }

  function networkStart() {
    apiPending++;
    if (apiPending !== 1) return;

    clearTimeout(apiTimer);
    apiTimer = setTimeout(() => {
      if (!apiPending || hasActiveOverlay()) return;
      const root = ensureTopBar();
      root.classList.add('dm-visible');
      topProgress = 8;
      topSet(8);

      clearInterval(topInterval);
      topInterval = setInterval(() => {
        if (!apiPending) return;
        if (topProgress < 55) topSet(topProgress + Math.max(3, (58-topProgress)*.12));
        else if (topProgress < 82) topSet(topProgress + 1.5);
        else if (topProgress < 91) topSet(topProgress + .35);
      }, 280);
    }, 180);
  }

  function networkEnd() {
    apiPending = Math.max(0, apiPending - 1);
    if (apiPending) return;

    clearTimeout(apiTimer);
    clearInterval(topInterval);

    const root = document.getElementById('dm-network-progress');
    if (!root) return;

    topSet(100);
    setTimeout(() => {
      root.classList.remove('dm-visible');
      setTimeout(() => {
        const bar = root.querySelector('.dm-net-bar');
        if (bar) bar.style.width = '0%';
        topProgress = 0;
      }, 220);
    }, 100);
  }

  function findOverlay(target) {
    if (target && target.nodeType === 1) return target;
    if (typeof target === 'string' && target) return document.getElementById(target);
    return document.getElementById('loading') ||
           document.getElementById('loadingScreen') ||
           document.querySelector('.loading-screen,.loading');
  }

  function cardFor(overlay) {
    return overlay.querySelector('.loader,.loader-card,.loading-card') || overlay;
  }

  function prepare(overlay) {
    if (!overlay) return null;
    let st = stateMap.get(overlay);
    if (st) return st;

    injectCss();
    overlay.classList.add('dm-progress-overlay');

    const card = cardFor(overlay);

    // A tiny inline fallback is embedded in each HTML so the very first paint
    // already shows a progress bar even before this shared file is downloaded.
    // Once the shared controller is ready, remove that fallback and take over.
    const firstPaintFallback = card.querySelector('.dm-firstpaint-fallback');
    if (firstPaintFallback) firstPaintFallback.remove();

    const originalStrong = card.querySelector('strong');
    const initialDetail = originalStrong ? originalStrong.textContent.trim() : '';

    if (originalStrong) originalStrong.classList.add('dm-original-loader-text');

    const wrap = document.createElement('div');
    wrap.className = 'dm-loading-ui';
    wrap.innerHTML = `
      <div class="dm-loading-copy">
        <strong class="dm-loading-title">${DEFAULT_TITLE}</strong>
        <span class="dm-loading-detail"></span>
      </div>
      <div class="dm-progress-track">
        <div class="dm-progress-fill"></div>
      </div>
      <div class="dm-progress-footer">
        <span class="dm-progress-pulse">در حال همگام‌سازی آخرین داده‌ها</span>
        <span>دیلی مارکت</span>
      </div>
    `;
    card.appendChild(wrap);

    st = {
      overlay,
      card,
      fill: wrap.querySelector('.dm-progress-fill'),
      title: wrap.querySelector('.dm-loading-title'),
      detail: wrap.querySelector('.dm-loading-detail'),
      progress: 5,
      startedAt: 0,
      interval: null,
      slowTimer: null,
      finishTimer: null,
      initialDetail
    };
    stateMap.set(overlay, st);
    return st;
  }

  function setProgress(st, value) {
    st.progress = Math.max(st.progress, Math.min(100, value));
    st.fill.style.width = st.progress + '%';
  }

  function start(target, detail) {
    const overlay = findOverlay(target);
    if (!overlay) return;
    const st = prepare(overlay);
    if (!st) return;

    clearInterval(st.interval);
    clearTimeout(st.slowTimer);
    clearTimeout(st.finishTimer);

    overlay.classList.remove('dm-completing');
    overlay.classList.remove('hidden');
    st.title.textContent = DEFAULT_TITLE;

    const cleanDetail = String(detail || '').trim();
    st.detail.textContent =
      cleanDetail && cleanDetail !== DEFAULT_TITLE
        ? cleanDetail
        : (st.initialDetail && !/در حال دریافت اطلاعات/.test(st.initialDetail)
            ? st.initialDetail
            : 'در حال همگام‌سازی آخرین داده‌های سامانه');

    st.startedAt = Date.now();
    st.progress = 6;
    st.fill.style.width = '6%';

    // Quick initial movement: user immediately sees progress.
    requestAnimationFrame(() => setProgress(st, 14));
    setTimeout(() => setProgress(st, 24), 180);

    st.interval = setInterval(() => {
      const elapsed = Date.now() - st.startedAt;
      if (st.progress < 52) {
        setProgress(st, st.progress + 4 + Math.random()*3);
      } else if (st.progress < 72) {
        setProgress(st, st.progress + 1.8 + Math.random()*2);
      } else if (st.progress < 86) {
        setProgress(st, st.progress + .55 + Math.random()*.75);
      } else if (st.progress < 92 && elapsed > 7000) {
        setProgress(st, st.progress + .18);
      }
    }, 380);

    st.slowTimer = setTimeout(() => {
      if (!overlay.classList.contains('hidden')) {
        st.detail.textContent = SLOW_TEXT;
      }
    }, 4800);
  }

  function finish(target) {
    const overlay = findOverlay(target);
    if (!overlay) return;
    const st = prepare(overlay);
    if (!st) {
      overlay.classList.add('hidden');
      return;
    }

    clearInterval(st.interval);
    clearTimeout(st.slowTimer);
    clearTimeout(st.finishTimer);

    // If it was never actually visible, close immediately.
    if (overlay.classList.contains('hidden')) return;

    overlay.classList.add('dm-completing');
    st.title.textContent = DONE_TEXT;
    st.detail.textContent = 'آخرین اطلاعات سامانه دریافت شد';
    setProgress(st, 100);

    st.finishTimer = setTimeout(() => {
      overlay.classList.add('hidden');
      overlay.classList.remove('dm-completing');
      st.title.textContent = DEFAULT_TITLE;
    }, 190);
  }

  function set(on, detail, target) {
    if (on) start(target, detail);
    else finish(target);
  }

  function patchApiPost() {
    if (patched || !window.DMAuth || typeof window.DMAuth.apiPost !== 'function') return false;
    patched = true;

    const original = window.DMAuth.apiPost.bind(window.DMAuth);
    window.DMAuth.apiPost = async function(...args) {
      networkStart();
      try {
        return await original(...args);
      } finally {
        networkEnd();
      }
    };
    return true;
  }

  function init() {
    injectCss();

    // Upgrade any page loader already visible on initial page render.
    const overlays = [
      document.getElementById('loading'),
      document.getElementById('loadingScreen')
    ].filter(Boolean);

    overlays.forEach(overlay => {
      prepare(overlay);
      if (!overlay.classList.contains('hidden')) {
        const strong = cardFor(overlay).querySelector('.dm-original-loader-text');
        start(overlay, strong ? strong.textContent : '');
      }
    });

    if (!patchApiPost()) {
      let tries = 0;
      const timer = setInterval(() => {
        tries++;
        if (patchApiPost() || tries > 80) clearInterval(timer);
      }, 50);
    }
  }

  window.DMLoading = {
    set,
    start,
    finish,
    networkStart,
    networkEnd,
    init
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, {once:true});
  } else {
    init();
  }
})();
