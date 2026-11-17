// Offline cache for the gym app. Bump V whenever files change.
const V = 'gym-1.4';
// Clips and posters live in their own cache so a new app version does not download them again.
const M = 'gym-media';
const isMedia = u => /\/v\/[^/]+\.(mp4|jpg)$/.test(new URL(u, self.location.href).pathname);
const SHELL = ['./', './index.html', './manifest.json', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
  './fonts/IRANSansX-Regular.woff', './fonts/IRANSansX-Medium.woff', './fonts/IRANSansX-Bold.woff', './fonts/IRANSansX-ExtraBold.woff', './fonts/IRANSansX-ExtraBlack.woff'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== V && k !== M && k.startsWith('gym-')).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// The page sends the list of clips; store each one whole so it plays offline.
self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type !== 'precache' || !Array.isArray(d.urls)) return;
  e.waitUntil((async () => {
    const c = await caches.open(M);
    const want = new Set(d.urls.map(u => new URL(u, self.location.href).href));
    for (const k of await c.keys()) if (!want.has(k.url)) await c.delete(k);
    let n = 0;
    for (const u of d.urls) {
      try {
        if (!(await c.match(u))) {
          const r = await fetch(u, {cache: 'no-cache'});
          if (r.ok && r.status === 200) await c.put(u, r);
        }
        n++;
      } catch (err) { /* try again next visit */ }
    }
    const clients = await self.clients.matchAll();
    clients.forEach(cl => cl.postMessage({type: 'precached', n, total: d.urls.length}));
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (req.headers.has('range')) e.respondWith(rangeFromCache(req));
    else if (req.mode === 'navigate') e.respondWith(networkFirst(req));
    else e.respondWith(cacheFirst(req));
  } else if (/(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    e.respondWith(staleWhileRevalidate(req));
  }
});

async function networkFirst(req) {
  const c = await caches.open(V);
  try {
    const r = await fetch(req);
    if (r.ok) c.put('./index.html', r.clone());
    return r;
  } catch (err) {
    return (await c.match('./index.html')) || (await c.match('./')) || Response.error();
  }
}

async function cacheFirst(req) {
  const c = await caches.open(isMedia(req.url) ? M : V);
  const hit = await c.match(req, {ignoreSearch: true});
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok && r.status === 200 && r.type === 'basic') c.put(req, r.clone());
  return r;
}

// Safari asks for video in byte ranges; answer them from the cached file.
async function rangeFromCache(req) {
  const c = await caches.open(isMedia(req.url) ? M : V);
  const hit = await c.match(req.url.split('#')[0], {ignoreSearch: true});
  if (!hit) {
    try { return await fetch(req); } catch (err) { return new Response('', {status: 504}); }
  }
  const buf = await hit.arrayBuffer();
  const size = buf.byteLength;
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
  let start = 0, end = size - 1;
  if (m) {
    if (m[1] === '' && m[2] !== '') start = Math.max(0, size - parseInt(m[2], 10));
    else {
      start = parseInt(m[1] || '0', 10);
      if (m[2] !== '') end = Math.min(parseInt(m[2], 10), size - 1);
    }
  }
  if (start >= size) return new Response('', {status: 416, headers: {'Content-Range': `bytes */${size}`}});
  const body = buf.slice(start, end + 1);
  return new Response(body, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': hit.headers.get('Content-Type') || 'video/mp4',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(body.byteLength),
      'Accept-Ranges': 'bytes'
    }
  });
}

async function staleWhileRevalidate(req) {
  const c = await caches.open(V);
  const hit = await c.match(req);
  const net = fetch(req).then(r => {
    if (r && (r.ok || r.type === 'opaque')) c.put(req, r.clone());
    return r;
  }).catch(() => hit);
  return hit || net;
}
