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

    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        token: String(payload.sessionToken),
        expiresAt: payload.expiresAt || null
      })
    );

    localStorage.setItem(
      USER_KEY,
      JSON.stringify(payload.user)
    );

    return true;
  }

  function isExpired(expiresAt) {
    if (!expiresAt) return false;

    const t = new Date(expiresAt).getTime();

    return !Number.isFinite(t) || t <= Date.now();
  }

  /*
   * Client-side page guard.
   * این بررسی فقط برای تجربه کاربری صفحه است.
   * تمام عملیات حساس در Apps Script
   * دوباره Token را سمت سرور بررسی می‌کنند.
   */
  async function validateSession(expectedRole) {
    const session = getSession();
    const user = getUser();

    if (!session || !session.token || !user) {
      return {
        ok: false,
        reason: 'NO_SESSION'
      };
    }

    if (isExpired(session.expiresAt)) {
      clearAuth();

      return {
        ok: false,
        reason: 'SESSION_EXPIRED'
      };
    }

    if (
      expectedRole &&
      String(user.role || '') !== String(expectedRole)
    ) {
      return {
        ok: false,
        reason: 'WRONG_ROLE',
        user: user
      };
    }

    return {
      ok: true,
      user: user,
      expiresAt: session.expiresAt,
      token: session.token
    };
  }

  function getToken() {
    const session = getSession();

    if (
      !session ||
      !session.token ||
      isExpired(session.expiresAt)
    ) {
      return '';
    }

    return String(session.token);
  }

  /*
   * GET request
   */
  async function apiGet(action, params) {
    const base = CFG.APPS_SCRIPT_URL;

    if (!base) {
      throw new Error('آدرس سرویس تنظیم نشده است.');
    }

    const query = new URLSearchParams(
      Object.assign(
        {},
        params || {},
        {
          action: action,
          token: getToken()
        }
      )
    );

    const url =
      base +
      (base.includes('?') ? '&' : '?') +
      query.toString();

    const response = await fetch(
      url,
      {
        method: 'GET',
        redirect: 'follow',
        cache: 'no-store'
      }
    );

    if (!response.ok) {
      throw new Error('ارتباط با سرور برقرار نشد.');
    }

    const data = await response.json();

    if (
      data &&
      (
        data.code === 'SESSION_INVALID' ||
        data.code === 'USER_INACTIVE'
      )
    ) {
      clearAuth();
      location.replace('index.html');

      throw new Error(
        'نشست شما پایان یافته است.'
      );
    }

    return data;
  }

  /*
   * POST request through hidden iframe.
   * این روش برای GitHub Pages + Apps Script
   * استفاده می‌شود.
   */
  function apiPost(action, params, timeoutMs) {
    const base = CFG.APPS_SCRIPT_URL;

    if (!base) {
      return Promise.reject(
        new Error('آدرس سرویس تنظیم نشده است.')
      );
    }

    return new Promise(function (resolve, reject) {

      const requestId =
        'REQ-' +
        Date.now() +
        '-' +
        Math.random()
          .toString(36)
          .slice(2, 10);

      const frameName =
        'dmApiFrame_' +
        requestId.replace(
          /[^A-Za-z0-9_]/g,
          ''
        );

      const iframe =
        document.createElement('iframe');

      iframe.name = frameName;
      iframe.title = 'api';
      iframe.style.display = 'none';

      document.body.appendChild(iframe);

      const form =
        document.createElement('form');

      form.method = 'POST';
      form.action = base;
      form.target = frameName;
      form.style.display = 'none';

      const payload =
        Object.assign(
          {},
          params || {},
          {
            action: action,
            token: getToken(),
            requestId: requestId
          }
        );

      Object.keys(payload).forEach(
        function (name) {

          const input =
            document.createElement('input');

          input.type = 'hidden';
          input.name = name;

          const value =
            payload[name];

          input.value =
            typeof value === 'string'
              ? value
              : JSON.stringify(value);

          form.appendChild(input);
        }
      );

      document.body.appendChild(form);

      let done = false;

      function cleanup() {
        window.removeEventListener(
          'message',
          onMessage
        );

        try {
          form.remove();
        } catch (_) {}

        setTimeout(
          function () {
            try {
              iframe.remove();
            } catch (_) {}
          },
          300
        );
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
        ) {
          return;
        }

        if (done) return;

        done = true;
        cleanup();

        if (
          data.code === 'SESSION_INVALID' ||
          data.code === 'USER_INACTIVE'
        ) {
          clearAuth();

          location.replace(
            'index.html'
          );

          reject(
            new Error(
              'نشست شما پایان یافته است.'
            )
          );

          return;
        }

        resolve(data);
      }

      window.addEventListener(
        'message',
        onMessage
      );

      try {
        form.submit();
      } catch (err) {
        finishError(err);
        return;
      }

      setTimeout(
        function () {
          finishError(
            new Error(
              'پاسخی از سرور دریافت نشد. دوباره تلاش کنید.'
            )
          );
        },
        Number(timeoutMs || 30000)
      );
    });
  }

  /*
   * Logout
   */
  async function logout() {
    const token = getToken();
    const base = CFG.APPS_SCRIPT_URL;

    /*
     * اول Session مرورگر پاک می‌شود
     * تا اگر سرور کند بود
     * کاربر داخل صفحه گیر نکند.
     */
    clearAuth();

    if (token && base) {
      try {
        const url =
          base +
          (base.includes('?') ? '&' : '?') +
          new URLSearchParams({
            action: 'logout',
            token: token
          }).toString();

        fetch(
          url,
          {
            method: 'GET',
            mode: 'no-cors',
            keepalive: true
          }
        ).catch(function () {});

      } catch (_) {}
    }

    location.replace(
      'index.html'
    );
  }

  /*
   * Global API
   */
  window.DMAuth = {
    getSession: getSession,
    getUser: getUser,
    getToken: getToken,
    clearAuth: clearAuth,
    saveAuth: saveAuth,
    validateSession: validateSession,
    apiGet: apiGet,
    apiPost: apiPost,
    logout: logout
  };

})();
