/**
 * Daily Market Field Visit - Auth Backend v1
 * Google Apps Script Web App
 *
 * Setup:
 * 1) فایل Master v2 را در Google Sheets باز کنید.
 * 2) Extensions > Apps Script
 * 3) این فایل را جایگزین Code.gs کنید.
 * 4) تابع setupAuth را یک بار Run کنید و دسترسی‌ها را تأیید کنید.
 * 5) Deploy > New deployment > Web app
 *    Execute as: Me
 *    Who has access: Anyone
 * 6) URL نهایی /exec را داخل app-config.js قرار دهید.
 */

const DM = Object.freeze({
  USERS: 'USERS',
  SESSIONS: 'SESSIONS',
  SETTINGS: 'SYSTEM_SETTINGS',
  AUDIT: 'AUDIT_LOG',
  TZ: 'Asia/Tehran'
});

function setupAuth() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('این اسکریپت باید به Google Sheet اصلی متصل باشد.');

  const props = PropertiesService.getScriptProperties();
  props.setProperty('SPREADSHEET_ID', ss.getId());
  if (!props.getProperty('AUTH_PEPPER')) {
    props.setProperty('AUTH_PEPPER', Utilities.getUuid() + Utilities.getUuid());
  }

  try { ss.setSpreadsheetTimeZone(DM.TZ); } catch (_) {}

  const sh = ss.getSheetByName(DM.USERS);
  if (!sh) throw new Error('Sheet USERS پیدا نشد.');

  const data = sh.getDataRange().getValues();
  if (data.length < 2) throw new Error('USERS خالی است.');
  const h = headerMap_(data[0]);
  requireHeaders_(h, ['username','password_seed','password_hash','active']);

  const pepper = props.getProperty('AUTH_PEPPER');
  const output = [];
  for (let i = 1; i < data.length; i++) {
    const username = String(data[i][h.username] || '').trim();
    const seed = String(data[i][h.password_seed] || '').trim();
    let hash = String(data[i][h.password_hash] || '').trim();
    if (username && seed && !hash) hash = hashPassword_(username, seed, pepper);
    output.push([hash]);
  }
  sh.getRange(2, h.password_hash + 1, output.length, 1).setValues(output);

  ensureSessionsSheet_(ss);
  cleanupExpiredSessions_();
  return 'AUTH_READY';
}

function doPost(e) {
  try {
    const p = (e && e.parameter) || {};
    const action = String(p.action || '').trim();
    if (action === 'login') return loginBridge_(p);
    return bridge_({ success: false, code: 'UNKNOWN_ACTION', message: 'درخواست نامعتبر است.' });
  } catch (err) {
    return bridge_({ success: false, code: 'SERVER_ERROR', message: safeMessage_(err) });
  }
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  const action = String(p.action || 'health').trim();
  const callback = safeCallback_(p.callback);

  let result;
  try {
    if (action === 'health') {
      result = { success: true, service: 'DailyMarket Field Visit', version: '1.0.0', serverTime: new Date().toISOString() };
    } else if (action === 'validateSession') {
      result = validateSessionAction_(p.token);
    } else if (action === 'logout') {
      result = logoutAction_(p.token);
    } else {
      result = { success: false, code: 'UNKNOWN_ACTION', message: 'درخواست نامعتبر است.' };
    }
  } catch (err) {
    result = { success: false, code: 'SERVER_ERROR', message: safeMessage_(err) };
  }

  return jsonp_(result, callback);
}

function loginBridge_(p) {
  const username = normalizeDigits_(p.username);
  const password = normalizeDigits_(p.password);
  const userAgent = String(p.userAgent || '').slice(0, 500);

  if (!username || !password) {
    return bridge_({ success: false, code: 'MISSING_CREDENTIALS', message: 'کد کاربری و رمز عبور را وارد کنید.' });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = getSS_();
    const sh = ss.getSheetByName(DM.USERS);
    const values = sh.getDataRange().getValues();
    const h = headerMap_(values[0]);
    requireHeaders_(h, [
      'user_id','username','password_seed','full_name','role','role_fa','executive_name',
      'regional_manager_name','parent_user_id','active','password_hash','failed_attempts','locked_until','last_login'
    ]);

    let rowIndex = -1;
    for (let i = 1; i < values.length; i++) {
      if (normalizeDigits_(values[i][h.username]) === username) { rowIndex = i; break; }
    }

    // پیام خطا عمداً برای Username اشتباه و Password اشتباه یکسان است.
    if (rowIndex === -1) {
      audit_('', '', 'LOGIN_FAILED', 'AUTH', username, '', 'Unknown username');
      Utilities.sleep(180);
      return bridge_({ success: false, code: 'INVALID_LOGIN', message: 'کد کاربری یا رمز عبور صحیح نیست.' });
    }

    const row = values[rowIndex];
    const userId = String(row[h.user_id] || '');
    const role = String(row[h.role] || '');
    if (!isTrue_(row[h.active])) {
      audit_(userId, role, 'LOGIN_BLOCKED', 'AUTH', userId, '', 'Inactive user');
      return bridge_({ success: false, code: 'INACTIVE', message: 'این حساب غیرفعال است.' });
    }

    const now = new Date();
    const lockedUntil = asDate_(row[h.locked_until]);
    if (lockedUntil && lockedUntil.getTime() > now.getTime()) {
      const mins = Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 60000));
      return bridge_({ success: false, code: 'LOCKED', message: 'ورود موقتاً قفل شده است. حدود ' + mins + ' دقیقه دیگر دوباره تلاش کنید.' });
    }

    const settings = settings_();
    const pepper = PropertiesService.getScriptProperties().getProperty('AUTH_PEPPER');
    if (!pepper) throw new Error('ابتدا تابع setupAuth را اجرا کنید.');

    let storedHash = String(row[h.password_hash] || '').trim();
    if (!storedHash) {
      const seed = String(row[h.password_seed] || '').trim();
      if (!seed) throw new Error('Password این کاربر مقداردهی نشده است.');
      storedHash = hashPassword_(username, seed, pepper);
      sh.getRange(rowIndex + 1, h.password_hash + 1).setValue(storedHash);
    }

    const submittedHash = hashPassword_(username, password, pepper);
    if (!constantTimeEquals_(storedHash, submittedHash)) {
      let attempts = Number(row[h.failed_attempts] || 0) + 1;
      let newLockedUntil = '';
      const maxAttempts = Number(settings.LOGIN_MAX_FAILED_ATTEMPTS || 5);
      if (attempts >= maxAttempts) {
        newLockedUntil = new Date(now.getTime() + Number(settings.LOGIN_LOCK_MINUTES || 15) * 60000);
        attempts = 0;
      }
      sh.getRange(rowIndex + 1, h.failed_attempts + 1).setValue(attempts);
      sh.getRange(rowIndex + 1, h.locked_until + 1).setValue(newLockedUntil);
      audit_(userId, role, 'LOGIN_FAILED', 'AUTH', userId, '', 'Invalid password');
      Utilities.sleep(220);
      return bridge_({ success: false, code: 'INVALID_LOGIN', message: 'کد کاربری یا رمز عبور صحیح نیست.' });
    }

    // موفق
    sh.getRange(rowIndex + 1, h.failed_attempts + 1).setValue(0);
    sh.getRange(rowIndex + 1, h.locked_until + 1).clearContent();
    sh.getRange(rowIndex + 1, h.last_login + 1).setValue(now);

    const session = createSession_(ss, userId, userAgent, Number(settings.SESSION_HOURS || 12));
    const user = userObject_(row, h);
    audit_(userId, role, 'LOGIN_SUCCESS', 'AUTH', userId, '', 'Successful login');

    return bridge_({
      success: true,
      code: 'LOGIN_OK',
      sessionToken: session.token,
      expiresAt: session.expiresAt.toISOString(),
      redirect: roleRedirect_(role),
      user: user
    });
  } finally {
    lock.releaseLock();
  }
}

function validateSessionAction_(token) {
  const session = getValidSession_(token, true);
  if (!session) return { success: false, code: 'SESSION_INVALID', message: 'نشست شما منقضی شده است.' };

  const user = findUserById_(session.userId);
  if (!user || !isTrue_(user.row[user.h.active])) {
    return { success: false, code: 'USER_INACTIVE', message: 'حساب کاربری در دسترس نیست.' };
  }

  return {
    success: true,
    expiresAt: session.expiresAt.toISOString(),
    user: userObject_(user.row, user.h)
  };
}

function logoutAction_(token) {
  if (!token) return { success: true };
  const ss = getSS_();
  const sh = ss.getSheetByName(DM.SESSIONS);
  if (!sh) return { success: true };
  const values = sh.getDataRange().getValues();
  const h = headerMap_(values[0]);
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][h.session_token] || '') === String(token)) {
      sh.getRange(i + 1, h.active + 1).setValue(false);
      audit_(String(values[i][h.user_id] || ''), '', 'LOGOUT', 'AUTH', '', '', 'User logout');
      break;
    }
  }
  return { success: true };
}

function createSession_(ss, userId, userAgent, hours) {
  const sh = ensureSessionsSheet_(ss);
  const token = randomToken_();
  const created = new Date();
  const expires = new Date(created.getTime() + Math.max(1, hours) * 3600000);
  sh.appendRow([token, userId, created, expires, created, true, userAgent]);
  return { token: token, expiresAt: expires };
}

function getValidSession_(token, touch) {
  token = String(token || '').trim();
  if (!token) return null;
  const ss = getSS_();
  const sh = ss.getSheetByName(DM.SESSIONS);
  if (!sh) return null;
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return null;
  const h = headerMap_(values[0]);
  const now = new Date();
  for (let i = values.length - 1; i >= 1; i--) {
    if (String(values[i][h.session_token] || '') !== token) continue;
    if (!isTrue_(values[i][h.active])) return null;
    const expires = asDate_(values[i][h.expires_at]);
    if (!expires || expires.getTime() <= now.getTime()) {
      sh.getRange(i + 1, h.active + 1).setValue(false);
      return null;
    }
    if (touch) sh.getRange(i + 1, h.last_seen_at + 1).setValue(now);
    return { rowNumber: i + 1, userId: String(values[i][h.user_id] || ''), expiresAt: expires };
  }
  return null;
}

function cleanupExpiredSessions_() {
  const ss = getSS_();
  const sh = ss.getSheetByName(DM.SESSIONS);
  if (!sh || sh.getLastRow() < 2) return;
  const values = sh.getDataRange().getValues();
  const h = headerMap_(values[0]);
  const now = new Date();
  const updates = [];
  for (let i = 1; i < values.length; i++) {
    const exp = asDate_(values[i][h.expires_at]);
    const active = isTrue_(values[i][h.active]);
    updates.push([active && exp && exp.getTime() > now.getTime()]);
  }
  sh.getRange(2, h.active + 1, updates.length, 1).setValues(updates);
}

function ensureSessionsSheet_(ss) {
  let sh = ss.getSheetByName(DM.SESSIONS);
  if (!sh) sh = ss.insertSheet(DM.SESSIONS);
  if (sh.getLastRow() === 0) {
    sh.appendRow(['session_token','user_id','created_at','expires_at','last_seen_at','active','user_agent']);
  }
  return sh;
}

function findUserById_(userId) {
  const sh = getSS_().getSheetByName(DM.USERS);
  const values = sh.getDataRange().getValues();
  const h = headerMap_(values[0]);
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][h.user_id] || '') === String(userId)) return { row: values[i], h: h, rowNumber: i + 1 };
  }
  return null;
}

function userObject_(row, h) {
  return {
    userId: String(row[h.user_id] || ''),
    username: String(row[h.username] || ''),
    fullName: String(row[h.full_name] || ''),
    role: String(row[h.role] || ''),
    roleFa: String(row[h.role_fa] || ''),
    executiveName: String(row[h.executive_name] || ''),
    regionalManagerName: String(row[h.regional_manager_name] || ''),
    parentUserId: String(row[h.parent_user_id] || '')
  };
}

function roleRedirect_(role) {
  if (role === 'EXECUTIVE_MANAGER') return 'executive-dashboard.html';
  if (role === 'REGIONAL_MANAGER') return 'regional-dashboard.html';
  if (role === 'AREA_HEAD') return 'areahead-dashboard.html';
  return 'index.html';
}

function settings_() {
  const sh = getSS_().getSheetByName(DM.SETTINGS);
  const out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  const v = sh.getDataRange().getValues();
  const h = headerMap_(v[0]);
  for (let i = 1; i < v.length; i++) {
    if (!isTrue_(v[i][h.active])) continue;
    out[String(v[i][h.setting_key] || '')] = v[i][h.setting_value];
  }
  return out;
}

function audit_(userId, role, action, entityType, entityId, storeCode, details) {
  try {
    const sh = getSS_().getSheetByName(DM.AUDIT);
    if (!sh) return;
    sh.appendRow([
      'LOG-' + Utilities.getUuid().slice(0, 8).toUpperCase(),
      new Date(), userId || '', role || '', action || '', entityType || '', entityId || '', storeCode || '', details || ''
    ]);
  } catch (_) {}
}

function hashPassword_(username, password, pepper) {
  const input = String(username) + '|' + String(password) + '|' + String(pepper || '');
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, input, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}

function constantTimeEquals_(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomToken_() {
  return (Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

function normalizeDigits_(value) {
  return String(value == null ? '' : value)
    .replace(/[۰-۹]/g, function(d){ return String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)); })
    .replace(/[٠-٩]/g, function(d){ return String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)); })
    .trim();
}

function asDate_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return v;
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function isTrue_(v) {
  return v === true || String(v).toLowerCase() === 'true' || String(v) === '1' || String(v) === 'فعال';
}

function getSS_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('ابتدا setupAuth را اجرا کنید.');
  return SpreadsheetApp.openById(id);
}

function headerMap_(headers) {
  const map = {};
  headers.forEach(function (x, i) { map[String(x || '').trim()] = i; });
  return map;
}

function requireHeaders_(h, names) {
  names.forEach(function (name) {
    if (h[name] === undefined) throw new Error('ستون ' + name + ' پیدا نشد.');
  });
}

function safeCallback_(cb) {
  cb = String(cb || 'callback');
  return /^[A-Za-z_$][0-9A-Za-z_$\.]{0,100}$/.test(cb) ? cb : 'callback';
}

function jsonp_(obj, callback) {
  return ContentService
    .createTextOutput(callback + '(' + JSON.stringify(obj).replace(/</g, '\\u003c') + ');')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function bridge_(obj) {
  const payload = JSON.stringify(Object.assign({ source: 'DM_AUTH' }, obj)).replace(/</g, '\\u003c');
  const html = '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
    '<script>try{window.parent.postMessage(' + payload + ',"*");}catch(e){}<\/script></body></html>';
  return HtmlService.createHtmlOutput(html)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function safeMessage_(err) {
  const msg = err && err.message ? String(err.message) : 'خطای سرور';
  return msg.slice(0, 250);
}
