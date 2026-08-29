(function () {
  'use strict';

  const CFG = window.DM_CONFIG || {};

  function getSession() {
    try {
      return JSON.parse(localStorage.getItem(CFG.SESSION_STORAGE_KEY || 'dmSession') || 'null');
    } catch (_) {
      return null;
    }
  }

  function getUser() {
    try {
      return JSON.parse(localStorage.getItem(CFG.USER_STORAGE_KEY || 'dmCurrentUser') || 'null');
    } catch (_) {
      return null;
    }
  }

  function clearAuth() {
    localStorage.removeItem(CFG.SESSION_STORAGE_KEY || 'dmSession');
    localStorage.removeItem(CFG.USER_STORAGE_KEY || 'dmCurrentUser');
  }

  function saveAuth(payload) {
    localStorage.setItem(CFG.SESSION_STORAGE_KEY || 'dmSession', JSON.stringify({
      token: payload.sessionToken,
      expiresAt: payload.expiresAt
    }));
    localStorage.setItem(CFG.USER_STORAGE_KEY || 'dmCurrentUser', JSON.stringify(payload.user));
  }

  function jsonp(action, params) {
    return new Promise((resolve, reject) => {
      const base = CFG.APPS_SCRIPT_URL;
      if (!base || base.includes('PASTE_YOUR')) {
        reject(new Error('آدرس Apps Script هنوز در app-config.js تنظیم نشده است.'));
        return;
      }

      const cb = '__dm_cb_' + Date.now() + '_' + Math.random().toString(36).slice(2);
      const script = document.createElement('script');
      const query = new URLSearchParams(Object.assign({}, params || {}, { action, callback: cb }));
      const timeout = setTimeout(() => cleanup(new Error('پاسخی از سرور دریافت نشد.')), 15000);

      function cleanup(err, data) {
        clearTimeout(timeout);
        delete window[cb];
        script.remove();
        if (err) reject(err); else resolve(data);
      }

      window[cb] = (data) => cleanup(null, data);
      script.onerror = () => cleanup(new Error('ارتباط با سرور برقرار نشد.'));
      script.src = base + (base.includes('?') ? '&' : '?') + query.toString();
      document.head.appendChild(script);
    });
  }

  async function validateSession(expectedRole) {
    const session = getSession();
    if (!session || !session.token) return { ok: false, reason: 'NO_SESSION' };

    const result = await jsonp('validateSession', { token: session.token });
    if (!result || !result.success) {
      clearAuth();
      return { ok: false, reason: 'INVALID_SESSION' };
    }

    if (expectedRole && result.user.role !== expectedRole) {
      return { ok: false, reason: 'WRONG_ROLE', user: result.user };
    }

    localStorage.setItem(CFG.USER_STORAGE_KEY || 'dmCurrentUser', JSON.stringify(result.user));
    return { ok: true, user: result.user, expiresAt: result.expiresAt };
  }

  async function logout() {
    const session = getSession();
    if (session && session.token) {
      try { await jsonp('logout', { token: session.token }); } catch (_) {}
    }
    clearAuth();
    location.href = 'index.html';
  }

  window.DMAuth = { getSession, getUser, clearAuth, saveAuth, validateSession, logout, jsonp };
})();
