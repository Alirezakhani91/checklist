const STATIC_CACHE='dm-static-v50';
const RUNTIME_CACHE='dm-runtime-v50';
const PRECACHE=[
  './','./index.html','./app-config.js','./auth-client.js','./dm-loading.js','./dm-instant.js',
  './regional-dashboard.html','./areahead-dashboard.html','./areahead-route.html','./areahead-store-health.html',
  './executive-dashboard.html','./admin-dashboard.html','./visit-history.html','./alerts.html','./manifest.webmanifest'
];

self.addEventListener('install',event=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(STATIC_CACHE);
    await Promise.all(PRECACHE.map(async url=>{
      try{
        const r=await fetch(url,{cache:'reload'});
        if(r&&r.ok)await cache.put(url,r.clone());
      }catch(_){}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.filter(k=>k.startsWith('dm-static-')||k.startsWith('dm-runtime-')).filter(k=>k!==STATIC_CACHE&&k!==RUNTIME_CACHE).map(k=>caches.delete(k)));
    if(self.registration.navigationPreload){try{await self.registration.navigationPreload.enable();}catch(_){}}
    await self.clients.claim();
  })());
});

async function staleWhileRevalidate(request){
  const cache=await caches.open(RUNTIME_CACHE);
  const cached=await caches.match(request);
  const network=fetch(request).then(async response=>{
    if(response&&response.ok&&response.type!=='opaque'){
      try{await cache.put(request,response.clone());}catch(_){}
    }
    return response;
  }).catch(()=>null);
  if(cached){network.catch(()=>{});return cached;}
  const fresh=await network;return fresh||new Response('Offline',{status:503,statusText:'Offline'});
}

self.addEventListener('fetch',event=>{
  const req=event.request;
  if(req.method!=='GET')return;
  const url=new URL(req.url);
  if(url.origin!==self.location.origin)return;
  if(url.pathname.endsWith('/sw.js'))return;

  if(req.mode==='navigate'){
    event.respondWith((async()=>{
      const preload=await event.preloadResponse;
      const cached=await caches.match(req);
      if(cached){
        event.waitUntil(fetch(req).then(async r=>{if(r&&r.ok){const c=await caches.open(RUNTIME_CACHE);await c.put(req,r.clone());}}).catch(()=>{}));
        return cached;
      }
      if(preload){const c=await caches.open(RUNTIME_CACHE);try{await c.put(req,preload.clone());}catch(_){}return preload;}
      return staleWhileRevalidate(req);
    })());
    return;
  }

  const dest=req.destination;
  if(['script','style','image','font'].includes(dest)||/\.(js|css|html|png|jpg|jpeg|webp|svg|woff2?|json|webmanifest)$/i.test(url.pathname)){
    event.respondWith(staleWhileRevalidate(req));
  }
});

self.addEventListener('message',event=>{
  const m=event.data||{};
  if(m.type==='SKIP_WAITING')self.skipWaiting();
  if(m.type==='CLEAR_RUNTIME')event.waitUntil(caches.delete(RUNTIME_CACHE));
});
