(function () {
  'use strict';

  const CFG = window.DM_CONFIG || {};
  const SESSION_KEY = CFG.SESSION_STORAGE_KEY || 'dmSession';
  const USER_KEY = CFG.USER_STORAGE_KEY || 'dmCurrentUser';

  function safeJsonParse(value) {
    try { return JSON.parse(value || 'null'); }
    catch (_) { return null; }
  }

  function getSession() {
    return safeJsonParse(localStorage.getItem(SESSION_KEY));
  }

  function getUser() {
    return safeJsonParse(localStorage.getItem(USER_KEY));
  }

  function clearAuth() {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(USER_KEY);
  }

  function saveAuth(payload) {
    if (!payload || !payload.sessionToken || !payload.user) return false;

    localStorage.setItem(SESSION_KEY, JSON.stringify({
      token: String(payload.sessionToken),
      expiresAt: payload.expiresAt || null
    }));

    localStorage.setItem(USER_KEY, JSON.stringify(payload.user));
    return true;
  }

  function isExpired(expiresAt) {
    if (!expiresAt) return false;
    const t = new Date(expiresAt).getTime();
    return !Number.isFinite(t) || t <= Date.now();
  }

  /**
   * Client-side page guard.
   * Important: GitHub Pages is a static frontend, so this guard is UX only.
   * Every protected Apps Script action must validate the session token server-side.
   */
  async function validateSession(expectedRole) {
    const session = getSession();
    const user = getUser();

    if (!session || !session.token || !user) {
      return { ok: false, reason: 'NO_SESSION' };
    }

    if (isExpired(session.expiresAt)) {
      clearAuth();
      return { ok: false, reason: 'SESSION_EXPIRED' };
    }

    if (expectedRole && String(user.role || '') !== String(expectedRole)) {
      return { ok: false, reason: 'WRONG_ROLE', user };
    }

    return {
      ok: true,
      user,
      expiresAt: session.expiresAt,
      token: session.token
    };
  }

  function getToken() {
    const session = getSession();
    if (!session || !session.token || isExpired(session.expiresAt)) return '';
    return String(session.token);
  }

  /**
   * Server calls used by the operational pages.
   * Protected endpoints must receive token and validate it inside Apps Script.
   */
  async function apiGet(action, params) {
    const base = CFG.APPS_SCRIPT_URL;
    if (!base) throw new Error('آدرس سرویس تنظیم نشده است.');

    const query = new URLSearchParams(Object.assign({}, params || {}, {
      action: action,
      token: getToken()
    }));

    const response = await fetch(base + (base.includes('?') ? '&' : '?') + query.toString(), {
      method: 'GET',
      redirect: 'follow',
      cache: 'no-store'
    });

    if (!response.ok) throw new Error('ارتباط با سرور برقرار نشد.');
    const data = await response.json();

    if (data && (data.code === 'SESSION_INVALID' || data.code === 'USER_INACTIVE')) {
      clearAuth();
      location.replace('index.html');
      throw new Error('نشست شما پایان یافته است.');
    }

    return data;
  }



  const READ_RETRY_ACTIONS = new Set([
    'alertsCenter','productionHealth','scaleReadiness',
    'adminBootstrap','adminStoreMasterBootstrap','adminStoreImportPreview',
    'adminRegionalManagersBootstrap','adminRegionalManagerDeletePreview',
    'adminAreaHeadsBootstrap','adminAreaHeadDeletePreview',
    'adminPilotBootstrap',
    'executiveOverview','executivePerformance','executiveRegionDetail','executiveAreaHeadDetail',
    'visitHistory','visitDetail',
    'regionalOverview','regionalPerformance','regionalBootstrap','suggestWeekRoutes',
    'areaHeadRouteBootstrap','areaHeadBootstrap',
    'regionalGpsBadgeCounts','regionalLocationApprovals','regionalLocationCorrections',
    'checklistBootstrap'
  ]);

  const API_MAX_CONCURRENT = 2;
  let apiActive = 0;
  const apiQueue = [];

  function apiDrainQueue() {
    while (apiActive < API_MAX_CONCURRENT && apiQueue.length) {
      const job = apiQueue.shift();
      apiActive++;

      Promise.resolve()
        .then(job.run)
        .then(job.resolve, job.reject)
        .finally(function(){
          apiActive--;
          apiDrainQueue();
        });
    }
  }

  function apiSchedule(run) {
    return new Promise(function(resolve, reject){
      apiQueue.push({run:run, resolve:resolve, reject:reject});
      apiDrainQueue();
    });
  }

  function sleepMs(ms) {
    return new Promise(function(resolve){
      setTimeout(resolve, ms);
    });
  }

  function apiPostAttempt(action, params, timeoutMs, requestId) {
    const base = CFG.APPS_SCRIPT_URL;

    if (!base) {
      return Promise.reject(new Error('آدرس سرویس تنظیم نشده است.'));
    }

    return new Promise(function(resolve, reject) {
      const attemptTag = Math.random().toString(36).slice(2, 7);
      const frameName =
        'dmApiFrame_' +
        requestId.replace(/[^A-Za-z0-9_]/g, '') +
        '_' +
        attemptTag;

      const iframe = document.createElement('iframe');
      iframe.name = frameName;
      iframe.title = 'api';
      iframe.style.display = 'none';
      document.body.appendChild(iframe);

      const form = document.createElement('form');
      form.method = 'POST';
      form.action = base;
      form.target = frameName;
      form.style.display = 'none';

      const payload = Object.assign({}, params || {}, {
        action: action,
        token: getToken(),
        requestId: requestId
      });

      Object.keys(payload).forEach(function(name) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;

        const value = payload[name];
        input.value =
          (typeof value === 'string')
            ? value
            : JSON.stringify(value);

        form.appendChild(input);
      });

      document.body.appendChild(form);

      let done = false;

      function cleanup() {
        window.removeEventListener('message', onMessage);
        try { form.remove(); } catch (_) {}

        setTimeout(function(){
          try { iframe.remove(); } catch (_) {}
        }, 300);
      }

      function finishError(error) {
        if (done) return;
        done = true;
        cleanup();
        reject(error);
      }

      function onMessage(event) {
        const data = event.data;

        if (
          !data ||
          data.source !== 'DM_AUTH' ||
          data.requestId !== requestId
        ) return;

        if (done) return;

        done = true;
        cleanup();

        if (
          data.code === 'SESSION_INVALID' ||
          data.code === 'USER_INACTIVE'
        ) {
          clearAuth();
          location.replace('index.html');
          reject(new Error('نشست شما پایان یافته است.'));
          return;
        }

        resolve(data);
      }

      window.addEventListener('message', onMessage);

      try {
        form.submit();
      } catch (err) {
        finishError(err);
        return;
      }

      setTimeout(function() {
        finishError(
          new Error('پاسخی از سرور دریافت نشد. دوباره تلاش کنید.')
        );
      }, Number(timeoutMs || 30000));
    });
  }

  function apiPost(action, params, timeoutMs) {
    return apiSchedule(async function(){
      const requestId =
        'REQ-' +
        Date.now() +
        '-' +
        Math.random().toString(36).slice(2, 10);

      // Only READ actions retry automatically.
      // Writes remain single-shot to avoid accidental duplicate mutations.
      const maxAttempts =
        READ_RETRY_ACTIONS.has(String(action || ''))
          ? 2
          : 1;

      let lastError = null;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          return await apiPostAttempt(
            action,
            params,
            timeoutMs,
            requestId
          );
        } catch (err) {
          lastError = err;

          if (attempt >= maxAttempts - 1) break;

          // Random backoff prevents hundreds of browsers
          // retrying at exactly the same millisecond.
          await sleepMs(
            550 + Math.floor(Math.random() * 950)
          );
        }
      }

      throw lastError ||
        new Error('ارتباط با سرور برقرار نشد.');
    });
  }
  async function logout() {
    const token = getToken();
    const base = CFG.APPS_SCRIPT_URL;

    // Logout must never trap the user on the page if Apps Script is slow/unreachable.
    clearAuth();

    if (token && base) {
      try {
        const url = base + (base.includes('?') ? '&' : '?') +
          new URLSearchParams({ action: 'logout', token: token }).toString();
        fetch(url, { method: 'GET', mode: 'no-cors', keepalive: true }).catch(function () {});
      } catch (_) {}
    }

    location.replace('index.html');
  }

  window.DMAuth = {
    version: '21.0.0',
    getSession,
    getUser,
    getToken,
    clearAuth,
    saveAuth,
    validateSession,
    apiGet,
    apiPost,
    logout
  };
})();
