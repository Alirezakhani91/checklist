(() => {
  'use strict';

  const VERSION = '50.0.0';
  const PREFIX = 'dmInstant:v50:';
  const SESSION_MAX_ENTRIES = 32;
  const LOCAL_MAX_ENTRIES = 18;
  const SESSION_MAX_CHARS = 850000;
  const LOCAL_MAX_CHARS = 420000;

  const POLICY = {
    areaHeadBootstrap:{freshMs:15000,staleMs:6*60*60*1000,persist:true,daily:true,tags:['TOPOLOGY','ROUTES','VISITS','DAYSTATUS','SETTINGS']},
    areaHeadRouteBootstrap:{freshMs:20000,staleMs:6*60*60*1000,persist:true,tags:['TOPOLOGY','ROUTES','VISITS','DAYSTATUS','SETTINGS']},
    regionalBootstrap:{freshMs:15000,staleMs:4*60*60*1000,persist:true,tags:['TOPOLOGY','ROUTES','VISITS','DAYSTATUS','SETTINGS']},
    regionalChecklistBuilderBootstrap:{freshMs:120000,staleMs:8*60*60*1000,persist:true,tags:['CHECKLIST','TOPOLOGY']},
    regionalPerformance:{freshMs:60000,staleMs:6*60*60*1000,persist:true,tags:['TOPOLOGY','ROUTES','VISITS','CHECKLIST','HEALTH','DAYSTATUS']},
    storeHealthList:{freshMs:90000,staleMs:6*60*60*1000,persist:true,tags:['TOPOLOGY','VISITS','CHECKLIST','HEALTH']},
    storeHealth360:{freshMs:120000,staleMs:6*60*60*1000,persist:true,tags:['TOPOLOGY','VISITS','CHECKLIST','HEALTH']},
    executiveOverview:{freshMs:30000,staleMs:4*60*60*1000,persist:true,daily:true,tags:['TOPOLOGY','ROUTES','VISITS','DAYSTATUS']},
    executivePerformance:{freshMs:60000,staleMs:6*60*60*1000,persist:true,tags:['TOPOLOGY','ROUTES','VISITS','CHECKLIST','HEALTH','DAYSTATUS']},
    executiveRegionDetail:{freshMs:60000,staleMs:4*60*60*1000,persist:true,tags:['TOPOLOGY','ROUTES','VISITS','CHECKLIST','HEALTH']},
    executiveAreaHeadDetail:{freshMs:60000,staleMs:4*60*60*1000,persist:true,tags:['TOPOLOGY','ROUTES','VISITS','CHECKLIST','HEALTH']},
    adminNationalPerformance:{freshMs:45000,staleMs:4*60*60*1000,persist:true,tags:['TOPOLOGY','ROUTES','VISITS','CHECKLIST','HEALTH','DAYSTATUS']},
    adminNationalAreaHeadDetail:{freshMs:60000,staleMs:4*60*60*1000,persist:true,tags:['TOPOLOGY','ROUTES','VISITS','CHECKLIST','HEALTH']},
    adminBootstrap:{freshMs:45000,staleMs:4*60*60*1000,persist:true,daily:true,tags:['TOPOLOGY','SETTINGS','ADMIN','GPS']},
    adminRegionalManagersBootstrap:{freshMs:180000,staleMs:12*60*60*1000,persist:true,tags:['TOPOLOGY','ADMIN']},
    adminAreaHeadsBootstrap:{freshMs:180000,staleMs:12*60*60*1000,persist:true,tags:['TOPOLOGY','ADMIN']},
    adminStoreMasterBootstrap:{freshMs:180000,staleMs:12*60*60*1000,persist:true,tags:['TOPOLOGY','ADMIN','GPS']},
    adminPilotBootstrap:{freshMs:60000,staleMs:4*60*60*1000,persist:true,daily:true,tags:['ADMIN']},
    alertsCenter:{freshMs:20000,staleMs:2*60*60*1000,persist:true,daily:true,tags:['ROUTES','VISITS','DAYSTATUS','GPS']},
    visitHistory:{freshMs:60000,staleMs:4*60*60*1000,persist:true,tags:['TOPOLOGY','VISITS','CHECKLIST','GPS']},
    visitDetail:{freshMs:180000,staleMs:12*60*60*1000,persist:true,tags:['TOPOLOGY','VISITS','CHECKLIST','GPS']},
    checklistBootstrap:{freshMs:8000,staleMs:30*60*1000,persist:false,daily:true,tags:['VISITS','CHECKLIST','DRAFT']}
  };

  const WRITE_TAGS = {
    adminStoreUpsert:['TOPOLOGY','ROUTES','HEALTH','ADMIN'],
    adminStoreBulkApply:['TOPOLOGY','ROUTES','HEALTH','ADMIN'],
    adminUpdateStoreLocation:['TOPOLOGY','GPS','ROUTES','ADMIN'],
    adminRegionalManagerUpsert:['TOPOLOGY','ROUTES','ADMIN'],
    adminRegionalManagerArchive:['TOPOLOGY','ROUTES','ADMIN'],
    adminAreaHeadUpsert:['TOPOLOGY','ROUTES','ADMIN'],
    adminAreaHeadArchive:['TOPOLOGY','ROUTES','ADMIN'],
    adminUserCommand:['TOPOLOGY','ADMIN'],
    adminUpdateSettings:['SETTINGS','ROUTES','GPS','ADMIN'],
    adminPilotSaveCohort:['ADMIN'],adminPilotUpdateTest:['ADMIN'],adminPilotSaveIssue:['ADMIN'],adminPilotSetStatus:['ADMIN'],
    regionalChecklistQuestionUpsert:['CHECKLIST','HEALTH'],
    regionalChecklistQuestionSetActive:['CHECKLIST','HEALTH'],
    regionalChecklistOrderSave:['CHECKLIST','HEALTH'],
    saveWeekRoutes:['ROUTES'],areaHeadSaveWeekRoutes:['ROUTES'],setRoutePlanningMode:['ROUTES'],
    setAreaHeadDayStatus:['DAYSTATUS','ROUTES'],setAreaHeadLeave:['DAYSTATUS','ROUTES'],
    reportCannotVisit:['ROUTES','VISITS'],regionalResolveCannotVisit:['ROUTES','VISITS'],
    startVisit:['VISITS','ROUTES','GPS'],confirmSoftPresence:['VISITS','ROUTES','GPS'],requestLocationApproval:['VISITS','GPS'],
    requestStoreLocationCorrection:['VISITS','GPS','TOPOLOGY'],cancelPendingLocationCorrection:['VISITS','GPS'],
    cancelPendingApproval:['VISITS','GPS'],cancelVisitStart:['VISITS','ROUTES'],
    decideLocationApproval:['VISITS','ROUTES','GPS'],decideLocationCorrection:['VISITS','ROUTES','GPS','TOPOLOGY'],
    saveChecklistDraft:['DRAFT'],completeChecklist:['DRAFT','CHECKLIST','VISITS','HEALTH','ROUTES'],
    saveManagerValidation:['CHECKLIST','HEALTH'],createMaintenanceRequest:['VISITS']
  };

  const handlers = new Map();
  const memory = new Map();
  const inflight = new Map();
  const dirtyTags = new Set();
  const metrics = {
    memoryHits:0, sessionHits:0, localHits:0, networkFresh:0,
    skippedRefreshes:0, backgroundRefreshes:0, coalesced:0,
    lastAction:'', lastNetworkMs:0, lastCacheAgeMs:0
  };

  let patched = false;
  let statusTimer = null;
  let channel = null;

  function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
      const out = {};
      Object.keys(value).sort().forEach(k => {
        if (['token','requestId','forceFresh','_dmNoCache','cacheBust','_'].includes(k)) return;
        out[k] = stable(value[k]);
      });
      return out;
    }
    return value;
  }

  function tehranDay() {
    try {
      const parts = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tehran',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
      const m={}; parts.forEach(x=>m[x.type]=x.value);
      return `${m.year}-${m.month}-${m.day}`;
    } catch (_) {
      const d=new Date();
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }
  }

  function userKey() {
    try {
      const u = window.DMAuth && typeof DMAuth.getUser === 'function' ? DMAuth.getUser() : null;
      return `${String(u?.userId || 'anon')}|${String(u?.role || '')}`;
    } catch (_) { return 'anon|'; }
  }

  function cacheKey(action, params) {
    const p = POLICY[action];
    const day = p?.daily ? `|${tehranDay()}` : '';
    return `${PREFIX}${userKey()}|${action}${day}|${JSON.stringify(stable(params||{}))}`;
  }

  function entryPrefixForUser(){ return `${PREFIX}${userKey()}|`; }
  function safeStorage(kind){ try { return kind==='local'?window.localStorage:window.sessionStorage; } catch(_){ return null; } }

  function parseEntry(raw, policy) {
    if (!raw) return null;
    try {
      const e = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!e || e.v !== VERSION || !e.data) return null;
      const ageMs = Date.now() - Number(e.t||0);
      if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > Number(policy?.staleMs||0)) return null;
      return {...e,ageMs};
    } catch (_) { return null; }
  }

  function readEntry(action, params, overrideMaxAgeMs) {
    const policy = POLICY[action];
    if (!policy) return null;
    const key = cacheKey(action,params);
    const effectivePolicy = overrideMaxAgeMs ? {...policy,staleMs:Number(overrideMaxAgeMs)} : policy;

    const mem = parseEntry(memory.get(key),effectivePolicy);
    if (mem) { metrics.memoryHits++; return {key,...mem,source:'memory'}; }
    memory.delete(key);

    const ss = safeStorage('session');
    if (ss) {
      const e = parseEntry(ss.getItem(key),effectivePolicy);
      if (e) { memory.set(key,e); metrics.sessionHits++; return {key,...e,source:'session'}; }
      try { ss.removeItem(key); } catch (_) {}
    }

    if (policy.persist) {
      const ls = safeStorage('local');
      if (ls) {
        const e = parseEntry(ls.getItem(key),effectivePolicy);
        if (e) { memory.set(key,e); metrics.localHits++; return {key,...e,source:'local'}; }
        try { ls.removeItem(key); } catch (_) {}
      }
    }
    return null;
  }

  function pruneStorage(storage,maxEntries){
    if(!storage)return;
    try{
      const rows=[];
      for(let i=0;i<storage.length;i++){
        const k=storage.key(i); if(!k||!k.startsWith(PREFIX))continue;
        try{const e=JSON.parse(storage.getItem(k)||'null');rows.push({k,t:Number(e?.t||0)});}catch(_){storage.removeItem(k);}
      }
      rows.sort((a,b)=>b.t-a.t);
      rows.slice(maxEntries).forEach(x=>storage.removeItem(x.k));
    }catch(_){}
  }

  function writeEntry(action,params,data){
    const policy=POLICY[action];
    if(!policy||!data||data.success===false)return false;
    const key=cacheKey(action,params);
    const entry={v:VERSION,t:Date.now(),tags:policy.tags||[],data};
    memory.set(key,entry);
    let payload='';
    try{payload=JSON.stringify(entry);}catch(_){return true;}

    const ss=safeStorage('session');
    if(ss&&payload.length<=SESSION_MAX_CHARS){
      try{ss.setItem(key,payload);pruneStorage(ss,SESSION_MAX_ENTRIES);}catch(_){}
    }
    if(policy.persist&&payload.length<=LOCAL_MAX_CHARS){
      const ls=safeStorage('local');
      if(ls){try{ls.setItem(key,payload);pruneStorage(ls,LOCAL_MAX_ENTRIES);}catch(_){}}
    }
    return true;
  }

  function deleteMatching(predicate){
    for(const [k,e] of [...memory.entries()]){ if(k.startsWith(entryPrefixForUser())&&predicate(e,k)) memory.delete(k); }
    ['session','local'].forEach(kind=>{
      const s=safeStorage(kind); if(!s)return;
      const keys=[];
      try{
        for(let i=0;i<s.length;i++){
          const k=s.key(i); if(!k||!k.startsWith(entryPrefixForUser()))continue;
          try{const e=JSON.parse(s.getItem(k)||'null');if(predicate(e,k))keys.push(k);}catch(_){keys.push(k);}
        }
        keys.forEach(k=>s.removeItem(k));
      }catch(_){}
    });
  }

  function invalidateTags(tags,broadcast=true,markDirty=true){
    const set=new Set((tags||[]).map(x=>String(x).toUpperCase()));
    if(!set.size)return;
    if(markDirty)set.forEach(t=>dirtyTags.add(t));
    deleteMatching(e=>(e?.tags||[]).some(t=>set.has(String(t).toUpperCase())));
    if(broadcast&&channel){ try{channel.postMessage({type:'invalidate',user:userKey(),tags:[...set]});}catch(_){} }
  }

  function clearUserCache(broadcast=true){
    deleteMatching(()=>true);
    if(broadcast&&channel){try{channel.postMessage({type:'clear',user:userKey()});}catch(_){} }
  }

  function ensureStatus(){
    let el=document.getElementById('dm-instant-status'); if(el)return el;
    const style=document.createElement('style'); style.id='dm-instant-style-v50';
    style.textContent=`#dm-instant-status{position:fixed;left:18px;bottom:18px;z-index:999998;display:flex;align-items:center;gap:7px;padding:8px 11px;border-radius:999px;background:rgba(20,25,34,.9);color:#fff;box-shadow:0 10px 30px rgba(17,24,39,.18);font-family:inherit;font-size:.62rem;font-weight:800;opacity:0;transform:translateY(8px);pointer-events:none;transition:opacity .18s ease,transform .18s ease;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}#dm-instant-status.show{opacity:1;transform:translateY(0)}#dm-instant-status .dot{width:7px;height:7px;border-radius:50%;background:#ff3858}#dm-instant-status.fresh .dot{background:#20b26b}@media(max-width:700px){#dm-instant-status{left:10px;bottom:76px;font-size:.57rem;padding:7px 9px}}`;
    document.head.appendChild(style);
    el=document.createElement('div');el.id='dm-instant-status';el.innerHTML='<span class="dot"></span><span class="txt"></span>';
    (document.body||document.documentElement).appendChild(el);return el;
  }

  function status(text,fresh=false,keepMs=1200){
    if(!text)return;const el=ensureStatus();const t=el.querySelector('.txt');if(t)t.textContent=text;
    el.classList.toggle('fresh',!!fresh);el.classList.add('show');clearTimeout(statusTimer);
    statusTimer=setTimeout(()=>el.classList.remove('show'),keepMs);
  }

  function emit(action,params,data,meta){
    const list=handlers.get(action)||[];list.forEach(fn=>{try{fn(data,params||{},meta||{});}catch(e){console.warn('[DMInstant handler]',action,e);}});
    try{window.dispatchEvent(new CustomEvent('dm:instant-fresh',{detail:{action,params:params||{},data,meta:meta||{}}}));}catch(_){}
  }
  function on(action,fn){if(!handlers.has(action))handlers.set(action,[]);handlers.get(action).push(fn);}
  function peek(action,params={},maxAgeMs){return readEntry(String(action||''),params,maxAgeMs);}

  function requestKey(action,params){return `${action}|${JSON.stringify(stable(params||{}))}`;}

  async function fetchFresh(original,action,params,timeoutMs,background=false){
    const k=requestKey(action,params);
    if(inflight.has(k)){metrics.coalesced++;return inflight.get(k);}
    const p=(async()=>{
      const t0=performance.now();
      try{
        const fresh=await original(action,params,timeoutMs);
        metrics.lastNetworkMs=Math.round(performance.now()-t0);metrics.networkFresh++;metrics.lastAction=action;
        if(fresh&&fresh.success!==false){
          writeEntry(action,params,fresh);
          (POLICY[action]?.tags||[]).forEach(t=>dirtyTags.delete(String(t).toUpperCase()));
          emit(action,params,fresh,{source:'fresh',background,networkMs:metrics.lastNetworkMs});
        }
        return fresh;
      }finally{inflight.delete(k);}
    })();
    inflight.set(k,p);return p;
  }

  function writeTagsFor(action){return WRITE_TAGS[String(action||'')]||[];}

  function patchApiPost(){
    if(patched||!window.DMAuth||typeof DMAuth.apiPost!=='function')return false;
    patched=true;
    const original=DMAuth.apiPost.bind(DMAuth);
    window.__DM_ORIGINAL_API_POST__=original;

    DMAuth.apiPost=async function(action,params={},timeoutMs){
      action=String(action||'');params=params||{};
      const policy=POLICY[action];
      const force=!!(params.forceFresh===true||String(params.forceFresh).toLowerCase()==='true'||params._dmNoCache===true||String(params._dmNoCache).toLowerCase()==='true');

      if(!policy){
        const result=await original(action,params,timeoutMs);
        if(result&&result.success!==false){
          const tags=writeTagsFor(action);
          if(tags.length)invalidateTags(tags,true,true);
          if(action==='logout')clearUserCache(true);
        }
        return result;
      }

      const policyTags=(policy.tags||[]).map(t=>String(t).toUpperCase());
      const actorNeedsFresh=policyTags.some(t=>dirtyTags.has(t));
      if(force||actorNeedsFresh){
        const freshParams=actorNeedsFresh&&!force?Object.assign({},params,{forceFresh:'true'}):params;
        return fetchFresh(original,action,freshParams,timeoutMs,false);
      }

      const cached=readEntry(action,params);
      if(!cached)return fetchFresh(original,action,params,timeoutMs,false);

      metrics.lastAction=action;metrics.lastCacheAgeMs=cached.ageMs;
      if(cached.ageMs<=policy.freshMs){
        metrics.skippedRefreshes++;
        return cached.data;
      }

      metrics.backgroundRefreshes++;
      status('نمایش فوری • بروزرسانی در پس‌زمینه');
      fetchFresh(original,action,params,timeoutMs,true).then(()=>status('اطلاعات تازه شد',true,850)).catch(()=>status('نسخه ذخیره‌شده نمایش داده شد'));
      return cached.data;
    };
    return true;
  }

  function prefetch(action,params={},timeoutMs=60000){
    action=String(action||'');const policy=POLICY[action];if(!policy||!window.DMAuth||typeof DMAuth.apiPost!=='function')return;
    const conn=navigator.connection||navigator.mozConnection||navigator.webkitConnection;
    if(conn&&(conn.saveData||/2g/.test(String(conn.effectiveType||''))))return;
    const hit=readEntry(action,params); if(hit&&hit.ageMs<=policy.freshMs)return;
    const run=()=>Promise.resolve(DMAuth.apiPost(action,params,timeoutMs)).catch(()=>{});
    if('requestIdleCallback'in window)requestIdleCallback(run,{timeout:900}); else setTimeout(run,80);
  }

  function currentSaturdayIso(offsetWeeks=0){
    const d=new Date();d.setHours(12,0,0,0);const diff=(d.getDay()+1)%7;d.setDate(d.getDate()-diff+offsetWeeks*7);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  function warmRole(){
    let u=null;try{u=DMAuth.getUser?.();}catch(_){}
    const role=String(u?.role||'');
    const jobs=[];
    if(role==='AREA_HEAD'){
      jobs.push(['areaHeadBootstrap',{}],['storeHealthList',{}],['alertsCenter',{}]);
      const b=readEntry('areaHeadBootstrap',{});
      if(b?.data?.canSelfRoute)jobs.push(['areaHeadRouteBootstrap',{weekStartIso:currentSaturdayIso(0)}],['areaHeadRouteBootstrap',{weekStartIso:currentSaturdayIso(1)}]);
    }else if(role==='REGIONAL_MANAGER'){
      jobs.push(['regionalBootstrap',{}],['regionalPerformance',{periodDays:10}],['storeHealthList',{}],['regionalChecklistBuilderBootstrap',{}]);
    }else if(role==='EXECUTIVE_MANAGER'){
      jobs.push(['executiveOverview',{}],['executivePerformance',{periodDays:7}],['executivePerformance',{periodDays:10}]);
    }else if(role==='SYSTEM_ADMIN'){
      jobs.push(['adminNationalPerformance',{periodDays:10}],['adminBootstrap',{}],['adminRegionalManagersBootstrap',{}],['adminAreaHeadsBootstrap',{}],['adminStoreMasterBootstrap',{}]);
    }
    jobs.forEach((j,i)=>setTimeout(()=>prefetch(j[0],j[1],70000),120+i*260));
  }

  function navigationWarmup(target){
    const s=String(target||'').toLowerCase();
    if(s.includes('areahead-route')){
      prefetch('areaHeadRouteBootstrap',{weekStartIso:currentSaturdayIso(0)},60000);
      prefetch('areaHeadRouteBootstrap',{weekStartIso:currentSaturdayIso(1)},60000);
    }else if(s.includes('areahead-store-health'))prefetch('storeHealthList',{},60000);
    else if(s.includes('alerts'))prefetch('alertsCenter',{},45000);
    else if(s.includes('visit-history'))prefetch('visitHistory',{days:30,page:1,pageSize:25,query:'',regionalUserId:'',areaHeadUserId:'',status:'ALL',planned:'ALL',location:'ALL'},60000);
    else if(s.includes('regional-dashboard')){prefetch('regionalBootstrap',{},60000);prefetch('regionalPerformance',{periodDays:10},60000);}
    else if(s.includes('executive-dashboard')){prefetch('executiveOverview',{},60000);prefetch('executivePerformance',{periodDays:7},60000);}
    else if(s.includes('admin-dashboard'))prefetch('adminNationalPerformance',{periodDays:10},60000);
  }

  function bindNavigationWarmup(){
    const handler=e=>{
      const el=e.target?.closest?.('a,button');if(!el)return;
      const href=el.getAttribute?.('href')||'';const oc=el.getAttribute?.('onclick')||'';
      const target=href||oc;if(target)navigationWarmup(target);
    };
    document.addEventListener('pointerover',handler,{passive:true,capture:true});
    document.addEventListener('touchstart',handler,{passive:true,capture:true});
  }

  function initChannel(){
    try{
      channel=new BroadcastChannel('dm-instant-v50');
      channel.onmessage=e=>{
        const m=e.data||{};if(m.user!==userKey())return;
        if(m.type==='invalidate')invalidateTags(m.tags||[],false,true);
        else if(m.type==='clear')clearUserCache(false);
      };
    }catch(_){}
  }

  function registerServiceWorker(){
    if(!('serviceWorker'in navigator))return;
    try{
      window.addEventListener('load',()=>{
        navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'}).then(reg=>{
          try{reg.update();}catch(_){}
        }).catch(()=>{});
      },{once:true});
    }catch(_){}
  }

  function init(){
    ensureStatus();initChannel();registerServiceWorker();bindNavigationWarmup();
    if(!patchApiPost()){
      let tries=0;const timer=setInterval(()=>{tries++;if(patchApiPost()||tries>160)clearInterval(timer);},25);
    }
    setTimeout(warmRole,180);
    window.addEventListener('pageshow',e=>{if(e.persisted)setTimeout(warmRole,50);});
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)setTimeout(warmRole,80);});
  }

  window.DMInstant={
    version:VERSION,on,peek,prefetch,clearUserCache,invalidateTags,status,warm:warmRole,
    stats:()=>Object.assign({},metrics),policy:action=>POLICY[action]||null
  };

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
