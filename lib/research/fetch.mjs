// Web page fetching for the research studio, through Scrapling (Python) when it is installed.
// Optional by design: without Python + Scrapling the research tools still record and audit,
// they just cannot fetch, and say exactly what to install.
//
// The safety rules (public addresses only, robots.txt, honest user agent, no stealth) live in
// scrapling_bridge.py, where every redirect hop is visible. This side adds what only a
// long-lived process can: a per-domain pace, a cache, and a hard timeout on the child.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { APP_ROOT } from '../approot.mjs';

// Resolved from the app root, not this module: in the packaged app this code is bundled into
// one file, and build.mjs ships the bridge at the same relative path next to it.
const BRIDGE = path.join(APP_ROOT, 'lib', 'research', 'scrapling_bridge.py');
const USER_AGENT = 'PLUT_OS-research/0.2 (local research assistant; respects robots.txt)';
const DOMAIN_GAP_MS = 2000;
const CHILD_TIMEOUT_MS = 90_000;   // a rendered page needs a browser start, the load and up to 10 s of settling
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_PAGE_CHARS = 200_000;

let runtime;   // memoized { available, python?, reason? }
const lastHit = new Map();

function pythonCandidates() {
    return process.platform === 'win32' ? [['python', []], ['py', ['-3']]] : [['python3', []], ['python', []]];
}

// Probed once per process: a missing interpreter does not appear mid-session.
export function fetchRuntime({ refresh = false } = {}) {
    if (runtime && !refresh) return runtime;
    if (process.env.PLUTOS_RESEARCH_PYTHON === 'off') return (runtime = { available: false, reason: 'Disabled by PLUTOS_RESEARCH_PYTHON=off.' });
    let sawPython = false;
    for (const [command, prefix] of pythonCandidates()) {
        const probe = spawnSync(command, [...prefix, '-c', 'import scrapling, markdownify, protego; print(scrapling.__version__)'],
            { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
        if (probe.status === 0) return (runtime = { available: true, python: [command, ...prefix], scrapling: probe.stdout.trim() });
        if (probe.error?.code === 'ENOENT' || /No installed Python/i.test(`${probe.stderr || ''}${probe.stdout || ''}`)) continue;
        sawPython = true;
    }
    if (sawPython) return (runtime = { available: false, reason: 'Python is installed but Scrapling is not. Run: pip install "scrapling[fetchers]" markdownify' });
    return (runtime = { available: false, reason: 'Python 3.10+ was not found. Install it, then: pip install "scrapling[fetchers]" markdownify' });
}

export function normalizeUrl(raw) {
    let url;
    try { url = new URL(String(raw || '').trim()); } catch { throw new Error('Not a valid URL.'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http and https pages can be fetched.');
    url.hash = '';
    return url.href;
}

const cacheKey = (url, render) => crypto.createHash('sha256').update(render ? `render:${url}` : url).digest('hex').slice(0, 32);

function readCache(cacheDir, url, render) {
    const file = path.join(cacheDir, `${cacheKey(url, render)}.json`);
    try {
        const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (entry.url === url && !!entry.rendered === render && Date.now() - entry.fetchedAt < CACHE_TTL_MS) return { ...entry, cached: true };
    } catch { /* miss */ }
    return null;
}

function writeCache(cacheDir, entry) {
    fs.mkdirSync(cacheDir, { recursive: true });
    const file = path.join(cacheDir, `${cacheKey(entry.url, entry.rendered)}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(entry));
    fs.renameSync(`${file}.tmp`, file);
}

function runBridge(python, request, timeoutMs = CHILD_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const [command, ...prefix] = python;
        const child = spawn(command, [...prefix, BRIDGE], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
        let out = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error('The page took too long to fetch.')); }, timeoutMs);
        child.stdout.on('data', chunk => { out += chunk; });
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', () => {
            clearTimeout(timer);
            try { resolve(JSON.parse(out)); } catch { reject(new Error('The fetch helper returned no readable result.')); }
        });
        child.stdin.end(JSON.stringify(request));
    });
}

// Returns { url, finalUrl, title, markdown, fetchedAt, hash, cached, rendered }. Throws with a reason.
// render runs the page's scripts in headless Chromium first (see scrapling_bridge.py).
export async function fetchPage(rawUrl, { cacheDir, fresh = false, render = false } = {}) {
    const url = normalizeUrl(rawUrl);
    if (cacheDir && !fresh) {
        const hit = readCache(cacheDir, url, render);
        if (hit) return hit;
    }
    const rt = fetchRuntime();
    if (!rt.available) throw new Error(`Web fetching is unavailable: ${rt.reason}`);
    const host = new URL(url).host;
    const wait = (lastHit.get(host) || 0) + DOMAIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    lastHit.set(host, Date.now());
    const result = await runBridge(rt.python, { url, userAgent: USER_AGENT, maxChars: MAX_PAGE_CHARS, timeout: 25, render });
    if (!result.ok) throw Object.assign(new Error(result.error), { code: result.code });
    const entry = { url, finalUrl: result.finalUrl, title: result.title, markdown: result.markdown, truncated: !!result.truncated,
        fetchedAt: Date.now(), hash: crypto.createHash('sha256').update(result.markdown).digest('hex'), rendered: render };
    if (cacheDir) writeCache(cacheDir, entry);
    return { ...entry, cached: false };
}

// Saves the images a page offers into outDir (see scrapling_bridge.py, mode "images").
// Returns { finalUrl, images: [{ url, finalUrl, file, bytes, type, sha256 }], skipped, candidates }.
export async function fetchImages(rawUrl, { outDir, max = 12, maxBytes = 5_000_000 } = {}) {
    const url = normalizeUrl(rawUrl);
    const rt = fetchRuntime();
    if (!rt.available) throw new Error(`Web fetching is unavailable: ${rt.reason}`);
    fs.mkdirSync(outDir, { recursive: true });
    const host = new URL(url).host;
    const wait = (lastHit.get(host) || 0) + DOMAIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    lastHit.set(host, Date.now());
    const count = Math.max(1, Math.min(Number(max) || 12, 30));
    // one page plus each image's own request, at most about 4 s each
    const result = await runBridge(rt.python, { mode: 'images', url, outDir, maxImages: count, maxBytes, userAgent: USER_AGENT, timeout: 25 },
        CHILD_TIMEOUT_MS + count * 4000);
    if (!result.ok) throw Object.assign(new Error(result.error), { code: result.code });
    return { finalUrl: result.finalUrl, images: result.images || [], skipped: result.skipped || [], candidates: result.candidates || 0 };
}
