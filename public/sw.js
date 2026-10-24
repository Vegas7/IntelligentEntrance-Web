// 离线缓存：页面与静态资源"先用缓存秒开，后台再拉新版本"（stale-while-revalidate）。
// /api/* 永远走网络，不缓存。修改静态文件后无需改版本号，下次打开即自动更新。
const CACHE = 'ie-shell-v28';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'i18n.js', 'vendor/qrcode.js', 'ghost.svg', 'icon.svg', 'icon-dark.svg', 'icon-192.png', 'apple-touch-icon.png', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;

  const key = req.mode === 'navigate' ? new URL('./', self.registration.scope).href : req;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(key, { ignoreSearch: true });
      const network = fetch(req, { cache: 'no-cache' })
        .then((res) => {
          if (res.ok) cache.put(key, res.clone());
          return res;
        })
        .catch(() => cached);
      if (cached) {
        e.waitUntil(network);
        return cached;
      }
      return network;
    })
  );
});
