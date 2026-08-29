(function () {
  'use strict';

  const CFG = window.DM_CONFIG || {};

  const SESSION_KEY =
    CFG.SESSION_STORAGE_KEY || 'dmSession';

  const USER_KEY =
    CFG.USER_STORAGE_KEY || 'dmCurrentUser';


  function safeJsonParse(value) {
    try {
      return JSON.parse(value || 'null');
    } catch (_) {
      return null;
    }
  }


  function getSession() {
    return safeJsonParse(
      localStorage.getItem(SESSION_KEY)
    );
  }


  function getUser() {
    return safeJsonParse(
      localStorage.getItem(USER_KEY)
    );
  }


  function clearAuth() {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(USER_KEY);
  }


  function saveAuth(payload) {

    if (
      !payload ||
      !payload.sessionToken ||
      !payload.user
    ) {
      return false;
    }

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

    if (!expiresAt) {
      return false;
    }

    const time =
      new Date(expiresAt).getTime();

    return (
      !Number.isFinite(time) ||
      time <= Date.now()
    );
  }


  /*
   ===============================
   PAGE SESSION CHECK
   ===============================
  */

  async function validateSession(expectedRole) {

    const session = getSession();
    const user = getUser();


    if (
      !session ||
      !session.token ||
      !user
    ) {
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
      String(user.role || '') !==
      String(expectedRole)
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


  /*
   ===============================
   GET SESSION TOKEN
   ===============================
  */

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
   ===============================
   API GET
   ===============================
  */

  async function apiGet(action, params) {

    const base =
      CFG.APPS_SCRIPT_URL;

    if (!base) {
      throw new Error(
        'آدرس سرویس تنظیم نشده است.'
      );
    }


    const query =
      new URLSearchParams(
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


    const response =
      await fetch(
        url,
        {
          method: 'GET',
          redirect: 'follow',
          cache: 'no-store'
        }
      );


    if (!response.ok) {

      throw new Error(
        'ارتباط با سرور برقرار نشد.'
      );
    }


    const data =
      await response.json();


    if (
      data &&
      (
        data.code === 'SESSION_INVALID' ||
        data.code === 'USER_INACTIVE'
      )
    ) {

      clearAuth();

      location.replace(
        'index.html'
      );

      throw new Error(
        'نشست شما پایان یافته است.'
      );
    }


    return data;
  }


  /*
   ===============================
   LOGOUT
   ===============================
  */

  async function logout() {

    const token =
      getToken();

    const base =
      CFG.APPS_SCRIPT_URL;


    /*
      اول از سمت مرورگر Session را پاک می‌کنیم
      تا حتی اگر Apps Script پاسخ نداد
      کاربر داخل صفحه گیر نکند
    */

    clearAuth();


    if (
      token &&
      base
    ) {

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
        ).catch(
          function () {}
        );

      } catch (_) {}

    }


    location.replace(
      'index.html'
    );
  }


  /*
   ===============================
   EXPOSE FUNCTIONS
   ===============================
  */

  window.DMAuth = {

    getSession: getSession,

    getUser: getUser,

    getToken: getToken,

    clearAuth: clearAuth,

    saveAuth: saveAuth,

    validateSession: validateSession,

    apiGet: apiGet,

    logout: logout
  };

})();
