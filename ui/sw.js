// PLUT_OS service worker, served at /sw.js (dashboard.mjs) and registered by ui/modules/updates.js.
// Its one job: when PLUT_OS is not running, an installed app window shows a page that says so and
// how to start it, instead of the browser's connection error.
//
// - install: caches that one page, written below; nothing else is ever cached.
// - fetch: a navigation (a page load) goes to the network first, and the cached page answers only
//   when the network fails (the server is off). /api/ requests and every request that is not a
//   navigation (scripts, styles, images, fetch calls) are not touched at all, so the app always
//   runs the files and data the server has now.
// - activate: deletes every older plutos-offline-* cache. Change CACHE when the page changes.
const CACHE = 'plutos-offline-v2';
const OFFLINE_URL = '/__plutos_offline__';

const OFFLINE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>PLUT_OS is not running</title>
<style>
:root { --bg: #f4f4f2; --card: #ffffff; --border: #e5e4e0; --title: #1b1c21; --body: #4c515b; --brand: #b45309; --on-brand: #ffffff; }
@media (prefers-color-scheme: dark) { :root { --bg: #0b1120; --card: #111a2e; --border: #22304d; --title: #eef1f7; --body: #a9b3c6; --brand: #f2a541; --on-brand: #101826; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--body);
  font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 440px; width: 100%; background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 28px; text-align: center; }
h1 { color: var(--title); font-size: 1.25rem; margin: 0 0 8px; }
p { margin: 0 0 12px; }
code { font: 0.9em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
button { margin-top: 8px; border: 0; border-radius: 8px; padding: 9px 22px; font: inherit; font-weight: 600; cursor: pointer; background: var(--brand); color: var(--on-brand); }
</style></head>
<body><main>
<h1>PLUT_OS is not running</h1>
<p>Start it with <code>START_PLUT_OS.bat</code>, the PLUT_OS app, or <code>node dashboard.mjs</code>, then retry.</p>
<button type="button" onclick="location.reload()">Retry</button>
</main></body></html>`;

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE)
        .then(cache => cache.put(OFFLINE_URL, new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })))
        .then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
    event.waitUntil(caches.keys()
        .then(keys => Promise.all(keys.filter(key => key.startsWith('plutos-offline-') && key !== CACHE).map(key => caches.delete(key))))
        .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.mode !== 'navigate' || request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)
        .then(page => page || new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))));
});
