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
  STORES: 'STORES',
  ROUTES: 'ROUTES',
  ROUTE_STORES: 'ROUTE_STORES',
  VISITS: 'VISITS',
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
  const p = (e && e.parameter) || {};
  const action = String(p.action || '').trim();
  const requestId = String(p.requestId || '').trim();
  let result;
  try {
    if (action === 'login') {
      return loginBridge_(p);
    } else if (action === 'regionalBootstrap') {
      result = regionalBootstrapAction_(p);
    } else if (action === 'suggestWeekRoutes') {
      result = suggestWeekRoutesAction_(p);
    } else if (action === 'saveWeekRoutes') {
      result = saveWeekRoutesAction_(p);
    } else {
      result = { success:false, code:'UNKNOWN_ACTION', message:'درخواست نامعتبر است.' };
    }
  } catch (err) {
    const msg = safeMessage_(err);
    if (msg === 'SESSION_INVALID') result = { success:false, code:'SESSION_INVALID', message:'نشست شما منقضی شده است.' };
    else if (msg === 'USER_INACTIVE') result = { success:false, code:'USER_INACTIVE', message:'حساب کاربری در دسترس نیست.' };
    else if (msg === 'ACCESS_DENIED') result = { success:false, code:'ACCESS_DENIED', message:'شما به این بخش دسترسی ندارید.' };
    else result = { success:false, code:'SERVER_ERROR', message:msg };
  }
  result.requestId = requestId;
  return bridge_(result);
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


/* =========================================================
 * ROUTE PLANNING V1
 * ======================================================= */

function setupRouting() {
  const ss = getSS_();
  ensureRoutingSchema_(ss);
  ensureRoutingSettings_(ss);
  return 'ROUTING_READY';
}

function regionalBootstrapAction_(p) {
  const actor = requireActor_(p.token, ['REGIONAL_MANAGER']);
  const ss = getSS_();
  ensureRoutingSchema_(ss);

  const weekStart = normalizeWeekStart_(p.weekStartIso);
  const weekDates = buildWeekDates_(weekStart);
  const allStores = getStoresForRegional_(actor.user.userId);
  const stats = getVisitStats_(allStores.map(function(s){ return s.storeCode; }), new Date());
  const areaHeads = summarizeAreaHeads_(allStores, stats);

  let selectedId = String(p.areaHeadUserId || '').trim();
  if (!selectedId && areaHeads.length) selectedId = areaHeads[0].userId;
  if (selectedId && !areaHeads.some(function(a){ return a.userId === selectedId; })) {
    return { success:false, code:'AREA_HEAD_FORBIDDEN', message:'این رئیس ناحیه زیرمجموعه شما نیست.' };
  }

  const selectedStores = allStores.filter(function(s){ return s.areaHeadUserId === selectedId; });
  const storePayload = selectedStores.map(function(s){ return storePayload_(s, stats[s.storeCode]); });
  const routes = selectedId ? loadWeekRoutes_(actor.user.userId, selectedId, weekDates, selectedStores) : [];
  const settings = routingSettingsPayload_();

  const totalNoHistory = allStores.filter(function(s){ return statusFromDays_((stats[s.storeCode] || {}).daysSinceLastVisit).level === 'NO_HISTORY'; }).length;
  const totalOverdue = allStores.filter(function(s){ return statusFromDays_((stats[s.storeCode] || {}).daysSinceLastVisit).level === 'OVERDUE'; }).length;
  const totalWarn12 = allStores.filter(function(s){ return statusFromDays_((stats[s.storeCode] || {}).daysSinceLastVisit).level === 'WARN12'; }).length;
  const totalWarn10 = allStores.filter(function(s){ return statusFromDays_((stats[s.storeCode] || {}).daysSinceLastVisit).level === 'WARN10'; }).length;
  const locationIssues = allStores.filter(function(s){ return String(s.locationStatus || '').toUpperCase() !== 'OK'; }).length;

  return {
    success:true,
    code:'REGIONAL_BOOTSTRAP_OK',
    manager:actor.user,
    settings:settings,
    summary:{
      areaHeads:areaHeads.length,
      stores:allStores.length,
      noHistory:totalNoHistory,
      overdue:totalOverdue,
      warn12:totalWarn12,
      warn10:totalWarn10,
      locationIssues:locationIssues
    },
    areaHeads:areaHeads,
    selectedAreaHead: selectedId ? {
      userId:selectedId,
      fullName:(areaHeads.find(function(a){return a.userId===selectedId;}) || {}).fullName || '',
      stores:storePayload
    } : null,
    week:{
      startIso:formatIsoDate_(weekStart),
      days:routes
    },
    serverTime:new Date().toISOString()
  };
}

function suggestWeekRoutesAction_(p) {
  const actor = requireActor_(p.token, ['REGIONAL_MANAGER']);
  const ss = getSS_();
  ensureRoutingSchema_(ss);

  const areaHeadUserId = String(p.areaHeadUserId || '').trim();
  if (!areaHeadUserId) return { success:false, code:'MISSING_AREA_HEAD', message:'رئیس ناحیه انتخاب نشده است.' };

  const allStores = getStoresForRegional_(actor.user.userId);
  const stores = allStores.filter(function(s){ return s.areaHeadUserId === areaHeadUserId; });
  if (!stores.length) return { success:false, code:'AREA_HEAD_FORBIDDEN', message:'فروشگاهی برای این رئیس ناحیه پیدا نشد.' };

  const weekStart = normalizeWeekStart_(p.weekStartIso);
  const settings = routingSettingsPayload_();
  let target = Number(p.targetDaily || settings.dailyTarget || 4);
  target = Math.max(3, Math.min(5, target));

  const stats = getVisitStats_(stores.map(function(s){ return s.storeCode; }), weekStart);
  const plan = generateSuggestedWeek_(stores, stats, weekStart, target);

  audit_(actor.user.userId, actor.user.role, 'ROUTE_SUGGESTED', 'ROUTE_WEEK', formatIsoDate_(weekStart), '', JSON.stringify({areaHeadUserId:areaHeadUserId,targetDaily:target}));

  return {
    success:true,
    code:'ROUTE_SUGGESTION_OK',
    areaHeadUserId:areaHeadUserId,
    weekStartIso:formatIsoDate_(weekStart),
    targetDaily:target,
    days:plan
  };
}

function saveWeekRoutesAction_(p) {
  const actor = requireActor_(p.token, ['REGIONAL_MANAGER']);
  const ss = getSS_();
  ensureRoutingSchema_(ss);

  const areaHeadUserId = String(p.areaHeadUserId || '').trim();
  if (!areaHeadUserId) return { success:false, code:'MISSING_AREA_HEAD', message:'رئیس ناحیه انتخاب نشده است.' };

  let plan;
  try { plan = JSON.parse(String(p.planJson || '[]')); }
  catch (_) { return { success:false, code:'INVALID_PLAN', message:'ساختار برنامه معتبر نیست.' }; }
  if (!Array.isArray(plan) || !plan.length) return { success:false, code:'EMPTY_PLAN', message:'برنامه‌ای برای ثبت وجود ندارد.' };

  const regionalStores = getStoresForRegional_(actor.user.userId);
  const allowedStores = regionalStores.filter(function(s){ return s.areaHeadUserId === areaHeadUserId; });
  if (!allowedStores.length) return { success:false, code:'AREA_HEAD_FORBIDDEN', message:'این رئیس ناحیه زیرمجموعه شما نیست.' };
  const allowedMap = {};
  allowedStores.forEach(function(s){ allowedMap[s.storeCode] = s; });

  const sourceType = String(p.sourceType || 'MANUAL').toUpperCase();
  const settings = routingSettingsPayload_();
  const warnings = [];
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    plan.forEach(function(day) {
      const dateIso = validIsoDate_(day.dateIso);
      if (!dateIso) throw new Error('تاریخ Route معتبر نیست.');
      const rawCodes = Array.isArray(day.storeCodes) ? day.storeCodes : [];
      const codes = [];
      const seen = {};
      rawCodes.forEach(function(x){
        const code = String(x || '').trim();
        if (!code || seen[code]) return;
        if (!allowedMap[code]) throw new Error('فروشگاه ' + code + ' متعلق به این رئیس ناحیه نیست.');
        seen[code] = true;
        codes.push(code);
      });

      if (codes.length < Number(settings.dailyMin || 3)) warnings.push(dateIso + ': کمتر از حد استاندارد روزانه');
      if (codes.length > Number(settings.dailyMax || 5)) warnings.push(dateIso + ': بیشتر از حد استاندارد روزانه');

      upsertRouteDay_(actor.user, areaHeadUserId, dateIso, String(day.dateFa || ''), codes, sourceType, allowedMap);
    });
  } finally {
    lock.releaseLock();
  }

  audit_(actor.user.userId, actor.user.role, 'ROUTE_WEEK_SAVED', 'ROUTE_WEEK', String(p.weekStartIso || ''), '', JSON.stringify({areaHeadUserId:areaHeadUserId,sourceType:sourceType,warnings:warnings}));

  return { success:true, code:'ROUTE_WEEK_SAVED', message:'برنامه هفتگی با موفقیت ثبت شد.', warnings:warnings };
}

function requireActor_(token, roles) {
  const session = getValidSession_(token, true);
  if (!session) throw new Error('SESSION_INVALID');
  const found = findUserById_(session.userId);
  if (!found || !isTrue_(found.row[found.h.active])) throw new Error('USER_INACTIVE');
  const user = userObject_(found.row, found.h);
  if (roles && roles.length && roles.indexOf(user.role) === -1) throw new Error('ACCESS_DENIED');
  return { session:session, user:user };
}

function ensureRoutingSchema_(ss) {
  const stores = ss.getSheetByName(DM.STORES);
  const routes = ss.getSheetByName(DM.ROUTES);
  const routeStores = ss.getSheetByName(DM.ROUTE_STORES);
  const visits = ss.getSheetByName(DM.VISITS);
  if (!stores || !routes || !routeStores || !visits) throw new Error('یکی از Sheetهای STORES / ROUTES / ROUTE_STORES / VISITS وجود ندارد.');

  ensureColumns_(routes, ['route_id','route_date_jalali','regional_user_id','area_head_user_id','status','created_by','created_at_server','updated_at_server','notes','route_date_iso','source_type']);
  ensureColumns_(routeStores, ['route_item_id','route_id','sequence_no','store_code','planned_status','visit_id','locked_after_visit_start','added_at_server','planned_reason','distance_from_previous_m']);
}

function ensureColumns_(sheet, headers) {
  const lastCol = Math.max(1, sheet.getLastColumn());
  let current = sheet.getRange(1,1,1,lastCol).getValues()[0].map(function(x){return String(x||'').trim();});
  headers.forEach(function(name){
    if (current.indexOf(name) !== -1) return;
    const col = current.length + 1;
    sheet.getRange(1,col).setValue(name);
    current.push(name);
  });
}

function ensureRoutingSettings_(ss) {
  const sh = ss.getSheetByName(DM.SETTINGS);
  if (!sh) throw new Error('SYSTEM_SETTINGS پیدا نشد.');
  const values = sh.getDataRange().getValues();
  const h = headerMap_(values[0]);
  requireHeaders_(h,['setting_key','setting_value','data_type','description','editable_by','active']);
  const existing = {};
  for (let i=1;i<values.length;i++) existing[String(values[i][h.setting_key]||'')] = true;
  const rows = [
    ['ROUTE_DAILY_MIN',3,'NUMBER','حداقل استاندارد بازدید روزانه رئیس ناحیه','ADMIN',true],
    ['ROUTE_DAILY_TARGET',4,'NUMBER','هدف پیش‌فرض تعداد بازدید روزانه در Route پیشنهادی','ADMIN',true],
    ['ROUTE_DAILY_MAX',5,'NUMBER','حداکثر استاندارد بازدید روزانه رئیس ناحیه','ADMIN',true]
  ];
  rows.forEach(function(r){ if(!existing[r[0]]) sh.appendRow(r); });
}

function routingSettingsPayload_() {
  const s = settings_();
  return {
    dailyMin:Number(s.ROUTE_DAILY_MIN || 3),
    dailyTarget:Number(s.ROUTE_DAILY_TARGET || 4),
    dailyMax:Number(s.ROUTE_DAILY_MAX || 5),
    yellowDay:Number(s.VISIT_WARN_DAY_YELLOW || 10),
    orangeDay:Number(s.VISIT_WARN_DAY_ORANGE || 12),
    overdueDay:Number(s.VISIT_OVERDUE_DAY || 14),
    geoRadiusM:Number(s.GEO_RADIUS_M || 300)
  };
}

function getStoresForRegional_(regionalUserId) {
  const sh = getSS_().getSheetByName(DM.STORES);
  const v = sh.getDataRange().getValues();
  const h = headerMap_(v[0]);
  requireHeaders_(h,['store_code','store_name','regional_user_id','regional_manager_name','area_head_user_id','area_head_name','latitude','longitude','location_status','active']);
  const out = [];
  for (let i=1;i<v.length;i++) {
    if (!isTrue_(v[i][h.active])) continue;
    if (String(v[i][h.regional_user_id]||'') !== String(regionalUserId)) continue;
    out.push({
      storeCode:String(v[i][h.store_code]||''),
      storeName:String(v[i][h.store_name]||''),
      regionalUserId:String(v[i][h.regional_user_id]||''),
      regionalManagerName:String(v[i][h.regional_manager_name]||''),
      areaHeadUserId:String(v[i][h.area_head_user_id]||''),
      areaHeadName:String(v[i][h.area_head_name]||''),
      lat:Number(v[i][h.latitude]),
      lng:Number(v[i][h.longitude]),
      locationStatus:String(v[i][h.location_status]||'OK')
    });
  }
  return out;
}

function getVisitStats_(storeCodes, refDate) {
  const wanted = {};
  storeCodes.forEach(function(c){ wanted[String(c)] = true; });
  const out = {};
  storeCodes.forEach(function(c){ out[String(c)] = {lastVisit:null,daysSinceLastVisit:999,visits7:0,visits14:0}; });

  const sh = getSS_().getSheetByName(DM.VISITS);
  if (!sh || sh.getLastRow() < 2) return out;
  const v = sh.getDataRange().getValues();
  const h = headerMap_(v[0]);
  requireHeaders_(h,['store_code','visit_status','checkin_at_server','checkout_at_server']);
  const ref = startOfDay_(refDate || new Date());
  const ms7 = 7*86400000, ms14 = 14*86400000;

  for (let i=1;i<v.length;i++) {
    const code = String(v[i][h.store_code]||'');
    if (!wanted[code]) continue;
    const checkout = asDate_(v[i][h.checkout_at_server]);
    const checkin = asDate_(v[i][h.checkin_at_server]);
    const status = String(v[i][h.visit_status]||'').toUpperCase();
    const completed = !!checkout || status === 'COMPLETED' || status === 'DONE';
    if (!completed) continue;
    const d = checkout || checkin;
    if (!d) continue;
    if (startOfDay_(d).getTime() > ref.getTime()) continue;
    if (!out[code].lastVisit || d.getTime() > out[code].lastVisit.getTime()) out[code].lastVisit = d;
    const age = ref.getTime() - startOfDay_(d).getTime();
    if (age >= 0 && age < ms7) out[code].visits7++;
    if (age >= 0 && age < ms14) out[code].visits14++;
  }

  Object.keys(out).forEach(function(code){
    const d = out[code].lastVisit;
    out[code].daysSinceLastVisit = d ? Math.max(0, Math.floor((ref.getTime()-startOfDay_(d).getTime())/86400000)) : 999;
  });
  return out;
}

function summarizeAreaHeads_(stores, stats) {
  const map = {};
  stores.forEach(function(s){
    if (!map[s.areaHeadUserId]) map[s.areaHeadUserId] = {userId:s.areaHeadUserId,fullName:s.areaHeadName,storeCount:0,noHistory:0,overdue:0,warn12:0,warn10:0,locationIssues:0};
    const a = map[s.areaHeadUserId];
    a.storeCount++;
    const st = statusFromDays_((stats[s.storeCode]||{}).daysSinceLastVisit).level;
    if (st==='NO_HISTORY') a.noHistory = (a.noHistory || 0) + 1;
    else if (st==='OVERDUE') a.overdue++;
    else if (st==='WARN12') a.warn12++;
    else if (st==='WARN10') a.warn10++;
    if (String(s.locationStatus||'').toUpperCase() !== 'OK') a.locationIssues++;
  });
  return Object.keys(map).map(function(k){return map[k];}).sort(function(a,b){return String(a.fullName).localeCompare(String(b.fullName),'fa');});
}

function storePayload_(s, stat) {
  stat = stat || {daysSinceLastVisit:999,visits7:0,visits14:0,lastVisit:null};
  const status = statusFromDays_(stat.daysSinceLastVisit);
  return {
    storeCode:s.storeCode,
    storeName:s.storeName,
    lat:s.lat,
    lng:s.lng,
    locationStatus:s.locationStatus,
    daysSinceLastVisit:stat.daysSinceLastVisit,
    lastVisitIso:stat.lastVisit ? stat.lastVisit.toISOString() : '',
    visits7:stat.visits7 || 0,
    visits14:stat.visits14 || 0,
    priorityLevel:status.level,
    priorityLabel:status.label
  };
}

function statusFromDays_(days) {
  days = Number(days);
  if (!isFinite(days) || days >= 999) return {level:'NO_HISTORY',label:'بدون سابقه بازدید'};
  if (days >= 14) return {level:'OVERDUE',label:days + ' روز بدون بازدید'};
  if (days >= 12) return {level:'WARN12',label:'هشدار ۱۲ روز'};
  if (days >= 10) return {level:'WARN10',label:'هشدار ۱۰ روز'};
  return {level:'NORMAL',label:days + ' روز از آخرین بازدید'};
}

function loadWeekRoutes_(regionalUserId, areaHeadUserId, weekDates, stores) {
  const ss = getSS_();
  const routesSh = ss.getSheetByName(DM.ROUTES);
  const itemsSh = ss.getSheetByName(DM.ROUTE_STORES);
  const rv = routesSh.getDataRange().getValues();
  const rh = headerMap_(rv[0]);
  const iv = itemsSh.getDataRange().getValues();
  const ih = headerMap_(iv[0]);
  const storeMap = {};
  stores.forEach(function(s){storeMap[s.storeCode]=s;});

  const byDate = {};
  weekDates.forEach(function(d){ byDate[formatIsoDate_(d)] = {dateIso:formatIsoDate_(d),routeId:'',status:'DRAFT',sourceType:'',items:[]}; });
  const routeIds = {};
  for (let i=1;i<rv.length;i++) {
    if (String(rv[i][rh.regional_user_id]||'') !== String(regionalUserId)) continue;
    if (String(rv[i][rh.area_head_user_id]||'') !== String(areaHeadUserId)) continue;
    const iso = String(rv[i][rh.route_date_iso]||'');
    if (!byDate[iso]) continue;
    const routeId = String(rv[i][rh.route_id]||'');
    byDate[iso].routeId = routeId;
    byDate[iso].status = String(rv[i][rh.status]||'PLANNED');
    byDate[iso].sourceType = String(rv[i][rh.source_type]||'');
    routeIds[routeId] = iso;
  }
  for (let i=1;i<iv.length;i++) {
    const routeId = String(iv[i][ih.route_id]||'');
    const iso = routeIds[routeId];
    if (!iso) continue;
    const code = String(iv[i][ih.store_code]||'');
    const s = storeMap[code] || {storeCode:code,storeName:code,lat:null,lng:null,locationStatus:'UNKNOWN'};
    byDate[iso].items.push({
      routeItemId:String(iv[i][ih.route_item_id]||''),
      sequenceNo:Number(iv[i][ih.sequence_no]||0),
      storeCode:code,
      storeName:s.storeName,
      lat:s.lat,
      lng:s.lng,
      locationStatus:s.locationStatus,
      plannedStatus:String(iv[i][ih.planned_status]||'PLANNED'),
      visitId:String(iv[i][ih.visit_id]||''),
      locked:isTrue_(iv[i][ih.locked_after_visit_start]),
      plannedReason:String(iv[i][ih.planned_reason]||''),
      distanceFromPreviousM:Number(iv[i][ih.distance_from_previous_m]||0)
    });
  }
  Object.keys(byDate).forEach(function(k){ byDate[k].items.sort(function(a,b){return a.sequenceNo-b.sequenceNo;}); });
  return weekDates.map(function(d){return byDate[formatIsoDate_(d)];});
}

function generateSuggestedWeek_(stores, stats, weekStart, targetDaily) {
  const state = {};
  stores.forEach(function(s){
    state[s.storeCode] = {
      store:s,
      baseDays:(function(v){ v=Number(v); return isFinite(v) ? v : 999; })((stats[s.storeCode]||{}).daysSinceLastVisit),
      lastScheduledDay:null,
      scheduleCount:0
    };
  });
  const days = [];
  for (let dayIndex=0; dayIndex<7; dayIndex++) {
    const selected = [];
    const selectedCodes = {};
    let previous = null;
    for (let slot=0; slot<targetDaily && slot<stores.length; slot++) {
      let best = null;
      let bestScore = -Infinity;
      Object.keys(state).forEach(function(code){
        if (selectedCodes[code]) return;
        const st = state[code];
        const effectiveDays = st.lastScheduledDay === null ? st.baseDays + dayIndex : dayIndex - st.lastScheduledDay;
        let score = urgencyScore_(effectiveDays);
        if (st.lastScheduledDay !== null) {
          const gap = dayIndex - st.lastScheduledDay;
          if (gap === 1) score -= 24000;
          else if (gap === 2) score -= 8000;
          score -= st.scheduleCount * 1200;
        }
        let dist = 0;
        if (previous && String(previous.locationStatus||'OK').toUpperCase()==='OK' && String(st.store.locationStatus||'OK').toUpperCase()==='OK') {
          dist = haversineM_(previous.lat, previous.lng, st.store.lat, st.store.lng);
          score -= Math.min(18000, (dist/1000) * 900);
        }
        if (score > bestScore) {
          bestScore = score;
          best = {state:st,effectiveDays:effectiveDays,distance:dist};
        }
      });
      if (!best) break;
      const s = best.state.store;
      const pri = statusFromDays_(best.effectiveDays);
      let reason = pri.label;
      if (previous && best.distance > 0 && best.distance < 2500 && pri.level === 'NORMAL') reason = 'نزدیک به ایستگاه قبلی';
      selected.push({
        storeCode:s.storeCode,
        storeName:s.storeName,
        lat:s.lat,
        lng:s.lng,
        locationStatus:s.locationStatus,
        priorityLevel:pri.level,
        priorityLabel:pri.label,
        plannedReason:reason,
        distanceFromPreviousM:Math.round(best.distance || 0)
      });
      selectedCodes[s.storeCode] = true;
      best.state.lastScheduledDay = dayIndex;
      best.state.scheduleCount++;
      previous = s;
    }
    const date = addDays_(weekStart, dayIndex);
    days.push({dateIso:formatIsoDate_(date),items:selected});
  }
  return days;
}

function urgencyScore_(days) {
  days = Number(days);
  if (!isFinite(days) || days >= 999) return 130000;
  if (days >= 14) return 100000 + days*250;
  if (days >= 12) return 72000 + days*220;
  if (days >= 10) return 52000 + days*200;
  return Math.max(0, days)*1500;
}

function upsertRouteDay_(actor, areaHeadUserId, dateIso, dateFa, codes, sourceType, allowedMap) {
  const ss = getSS_();
  const routesSh = ss.getSheetByName(DM.ROUTES);
  const itemsSh = ss.getSheetByName(DM.ROUTE_STORES);
  const rv = routesSh.getDataRange().getValues();
  const rh = headerMap_(rv[0]);
  let routeRow = -1, routeId = '';
  for (let i=1;i<rv.length;i++) {
    if (String(rv[i][rh.regional_user_id]||'')===actor.userId && String(rv[i][rh.area_head_user_id]||'')===areaHeadUserId && String(rv[i][rh.route_date_iso]||'')===dateIso) {
      routeRow = i+1;
      routeId = String(rv[i][rh.route_id]||'');
      break;
    }
  }

  if (routeId && routeHasStarted_(routeId)) throw new Error('Route تاریخ ' + dateIso + ' شروع شده و دیگر قابل تغییر نیست.');

  const now = new Date();
  if (!routeId) {
    routeId = 'RT-' + Utilities.getUuid().slice(0,10).toUpperCase();
    const row = new Array(routesSh.getLastColumn()).fill('');
    row[rh.route_id]=routeId;
    row[rh.route_date_jalali]=dateFa;
    row[rh.regional_user_id]=actor.userId;
    row[rh.area_head_user_id]=areaHeadUserId;
    row[rh.status]='PLANNED';
    row[rh.created_by]=actor.userId;
    row[rh.created_at_server]=now;
    row[rh.updated_at_server]=now;
    row[rh.route_date_iso]=dateIso;
    row[rh.source_type]=sourceType;
    routesSh.appendRow(row);
  } else {
    routesSh.getRange(routeRow,rh.route_date_jalali+1).setValue(dateFa);
    routesSh.getRange(routeRow,rh.status+1).setValue('PLANNED');
    routesSh.getRange(routeRow,rh.updated_at_server+1).setValue(now);
    routesSh.getRange(routeRow,rh.source_type+1).setValue(sourceType);
    deleteRouteItems_(routeId);
  }

  const rows = [];
  let prev = null;
  codes.forEach(function(code, idx){
    const s = allowedMap[code];
    const dist = prev && String(prev.locationStatus||'OK').toUpperCase()==='OK' && String(s.locationStatus||'OK').toUpperCase()==='OK' ? Math.round(haversineM_(prev.lat,prev.lng,s.lat,s.lng)) : 0;
    const row = new Array(itemsSh.getLastColumn()).fill('');
    const ih = headerMap_(itemsSh.getRange(1,1,1,itemsSh.getLastColumn()).getValues()[0]);
    row[ih.route_item_id]='RI-' + Utilities.getUuid().slice(0,10).toUpperCase();
    row[ih.route_id]=routeId;
    row[ih.sequence_no]=idx+1;
    row[ih.store_code]=code;
    row[ih.planned_status]='PLANNED';
    row[ih.visit_id]='';
    row[ih.locked_after_visit_start]=false;
    row[ih.added_at_server]=now;
    row[ih.planned_reason]=sourceType === 'SMART' ? 'پیشنهاد سیستم' : 'برنامه مدیر منطقه';
    row[ih.distance_from_previous_m]=dist;
    rows.push(row);
    prev=s;
  });
  if (rows.length) itemsSh.getRange(itemsSh.getLastRow()+1,1,rows.length,itemsSh.getLastColumn()).setValues(rows);
}

function deleteRouteItems_(routeId) {
  const sh = getSS_().getSheetByName(DM.ROUTE_STORES);
  if (sh.getLastRow() < 2) return;
  const v = sh.getDataRange().getValues();
  const h = headerMap_(v[0]);
  for (let i=v.length-1;i>=1;i--) if (String(v[i][h.route_id]||'')===routeId) sh.deleteRow(i+1);
}

function routeHasStarted_(routeId) {
  const sh = getSS_().getSheetByName(DM.ROUTE_STORES);
  if (!sh || sh.getLastRow()<2) return false;
  const v = sh.getDataRange().getValues();
  const h = headerMap_(v[0]);
  for (let i=1;i<v.length;i++) {
    if (String(v[i][h.route_id]||'')!==routeId) continue;
    if (isTrue_(v[i][h.locked_after_visit_start]) || String(v[i][h.visit_id]||'').trim()) return true;
  }
  return false;
}

function normalizeWeekStart_(iso) {
  let d = validIsoDate_(iso) ? parseIsoDate_(iso) : startOfDay_(new Date());
  // JS: Sunday 0 ... Saturday 6. Move backwards to Saturday.
  const diff = (d.getDay() + 1) % 7;
  d.setDate(d.getDate() - diff);
  return startOfDay_(d);
}

function buildWeekDates_(start) {
  const out=[];
  for(let i=0;i<7;i++) out.push(addDays_(start,i));
  return out;
}

function validIsoDate_(s) {
  s=String(s||'');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const d=parseIsoDate_(s);
  return isNaN(d.getTime()) ? '' : s;
}

function parseIsoDate_(s) {
  const p=String(s).split('-').map(Number);
  return new Date(p[0],p[1]-1,p[2]);
}

function formatIsoDate_(d) {
  return Utilities.formatDate(d, DM.TZ, 'yyyy-MM-dd');
}

function addDays_(d,n) {
  const x=new Date(d.getTime());
  x.setDate(x.getDate()+n);
  return startOfDay_(x);
}

function startOfDay_(d) {
  const x=new Date(d instanceof Date ? d.getTime() : d);
  x.setHours(0,0,0,0);
  return x;
}

function haversineM_(lat1,lng1,lat2,lng2) {
  lat1=Number(lat1);lng1=Number(lng1);lat2=Number(lat2);lng2=Number(lng2);
  if (![lat1,lng1,lat2,lng2].every(isFinite)) return 999999;
  const R=6371000, toRad=Math.PI/180;
  const p1=lat1*toRad,p2=lat2*toRad,dp=(lat2-lat1)*toRad,dl=(lng2-lng1)*toRad;
  const a=Math.sin(dp/2)*Math.sin(dp/2)+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)*Math.sin(dl/2);
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
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

  // Apps Script may serve HtmlService through an additional googleusercontent frame.
  // Send the result to both parent and top, more than once, so the GitHub page reliably receives it.
  const html = '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
    '<script>' +
    '(function(){' +
      'var msg=' + payload + ';' +
      'function send(){' +
        'try{window.parent.postMessage(msg,"*");}catch(e){}' +
        'try{window.top.postMessage(msg,"*");}catch(e){}' +
        'try{if(window.opener)window.opener.postMessage(msg,"*");}catch(e){}' +
      '}' +
      'send();setTimeout(send,250);setTimeout(send,800);setTimeout(send,1600);' +
    '})();' +
    '<\/script></body></html>';

  return HtmlService.createHtmlOutput(html)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function safeMessage_(err) {
  const msg = err && err.message ? String(err.message) : 'خطای سرور';
  return msg.slice(0, 250);
}
