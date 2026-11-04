#!/usr/bin/env node
// Settings → Updates (lib/update.mjs latestRelease and updateInChild, lib/update-routes.mjs), with no
// real network: the release check reads a fake fetch, and the git side runs against scratch
// repositories. The version compare (-beta before its release), the release list (drafts skipped,
// pre-releases counted, 404 is "none"), a check that never throws, the routes' shape, their refusals
// (packaged, submodule, development mode, no token, a token whose commits moved, a second update while
// one runs) and a real fast-forward through the child process.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compareVersions, githubRepo, latestRelease, updateInChild } from '../lib/update.mjs';
import { updateRoutes } from '../lib/update-routes.mjs';
import { scanRelease } from '../lib/release-scan.mjs';
import { ATTRIBUTION } from './publish-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`  ok  ${name}`); };
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-update-check-')));
Object.assign(process.env, { GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.invalid' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (dir, file, text) => { fs.writeFileSync(path.join(dir, file), text); git(dir, 'add', file); git(dir, 'commit', '-q', '-m', file); return git(dir, 'rev-parse', 'HEAD'); };

const PKG = { version: '0.5.0-beta', repository: { type: 'git', url: 'https://github.com/owner/repo.git' } };
const reply = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const release = (tag, extra = {}) => ({ tag_name: tag, html_url: `https://github.com/owner/repo/releases/tag/${tag}`, draft: false, ...extra });

// A route handler called the way dashboard.mjs calls it.
async function call(routes, key, { query = '', body } = {}) {
    const res = {};
    await routes[key]({ body }, res, new URL(`http://localhost/api/update${query}`));
    return { status: res.status, ...res.payload };
}
const sendJson = (res, status, obj) => { res.status = status; res.payload = obj; };
const readJsonBody = async req => req.body || {};

try {
    await check('compareVersions: x.y.z numerically, a pre-release before its release, a leading v ignored', () => {
        const order = ['0.4.9', '0.5.0-alpha', '0.5.0-beta', '0.5.0-beta.2', '0.5.0-beta.10', '0.5.0', '0.5.1', '0.10.0', '1.0.0'];
        for (let i = 0; i < order.length - 1; i++) {
            assert.equal(compareVersions(order[i], order[i + 1]), -1, `${order[i]} < ${order[i + 1]}`);
            assert.equal(compareVersions(order[i + 1], order[i]), 1, `${order[i + 1]} > ${order[i]}`);
        }
        assert.equal(compareVersions('v0.5.1', '0.5.1'), 0);
        assert.equal(compareVersions('0.5', '0.5.0'), 0);
        assert.equal(compareVersions('', '0.0.0'), 0);
    });
    await check('githubRepo: the owner/repo of every form package.json may hold, else empty', () => {
        assert.equal(githubRepo(PKG), 'owner/repo');
        assert.equal(githubRepo({ repository: 'github:owner/repo' }), 'owner/repo');
        assert.equal(githubRepo({ repository: 'owner/repo' }), 'owner/repo');
        assert.equal(githubRepo({ repository: { url: 'git+https://github.com/owner/repo.git' } }), 'owner/repo');
        assert.equal(githubRepo({ repository: 'https://gitlab.com/owner/repo' }), '');
        assert.equal(githubRepo({}), '');
    });
    await check("this package.json names its repository, and the release scan counts those lines as attribution", () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
        assert.match(githubRepo(pkg), /^[\w.-]+\/[\w.-]+$/);
        assert.ok(typeof pkg.homepage === 'string' && pkg.homepage.includes(githubRepo(pkg)));
        // The author's name is the term the scan would refuse; read it, never write it here.
        const findings = scanRelease(ROOT, { files: ['package.json'], terms: [pkg.author] }).filter(f => f.kind === 'terms');
        assert.ok(findings.length >= 2, 'the author, repository and homepage lines name the author');
        assert.deepEqual(findings.filter(f => !ATTRIBUTION(f)), []);
    });
    await check('latestRelease: a newer release is available, with its page', async () => {
        let asked = '';
        const r = await latestRelease({ pkg: PKG, fetchImpl: async (url, init) => { asked = url; assert.ok(init.signal); return reply(200, [release('v0.5.0')])(); } });
        assert.equal(asked, 'https://api.github.com/repos/owner/repo/releases?per_page=5');
        assert.deepEqual([r.state, r.current, r.latest, r.url], ['available', '0.5.0-beta', '0.5.0', 'https://github.com/owner/repo/releases/tag/v0.5.0']);
    });
    await check('latestRelease: the highest tag wins, a draft never counts, a pre-release does', async () => {
        const list = [release('v0.5.0-beta'), release('v0.9.0', { draft: true }), release('v0.5.1-rc.1'), release('v0.4.0')];
        const r = await latestRelease({ pkg: { ...PKG, version: '0.5.0' }, fetchImpl: reply(200, list) });
        assert.deepEqual([r.state, r.latest], ['available', '0.5.1-rc.1']);
    });
    await check('latestRelease: the same or an older release is current', async () => {
        assert.equal((await latestRelease({ pkg: PKG, fetchImpl: reply(200, [release('v0.5.0-beta')]) })).state, 'current');
        assert.equal((await latestRelease({ pkg: PKG, fetchImpl: reply(200, [release('0.4.2')]) })).state, 'current');
    });
    await check('latestRelease: 404 or an empty list is "none"', async () => {
        const r = await latestRelease({ pkg: PKG, fetchImpl: reply(404, { message: 'Not Found' }) });
        assert.deepEqual([r.state, r.url], ['none', 'https://github.com/owner/repo/releases']);
        assert.match(r.message, /No release published yet/);
        assert.equal((await latestRelease({ pkg: PKG, fetchImpl: reply(200, []) })).state, 'none');
        assert.equal((await latestRelease({ pkg: PKG, fetchImpl: reply(200, [release('v1.0.0', { draft: true })]) })).state, 'none');
    });
    await check('latestRelease: offline, a timeout, a rate limit or a bad answer is "error" with one line; it never throws', async () => {
        const offline = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };
        // AbortSignal.timeout's timer does not hold the process open; a real request's socket does.
        const hang = (url, { signal }) => new Promise((_, reject) => {
            const socket = setTimeout(() => {}, 10_000);
            signal.addEventListener('abort', () => { clearTimeout(socket); reject(signal.reason); });
        });
        const cases = [
            [offline, /ENOTFOUND/],
            [hang, /no answer within/],
            [reply(403, {}), /rate limit/],
            [reply(500, {}), /GitHub answered 500/],
            [async () => ({ status: 200, ok: true, json: async () => { throw new SyntaxError('Unexpected token'); } }), /Unexpected token/],
            [() => { throw new Error('sync throw'); }, /sync throw/],
        ];
        for (const [fetchImpl, reason] of cases) {
            const r = await latestRelease({ pkg: PKG, fetchImpl, timeoutMs: 50 });
            assert.equal(r.state, 'error');
            assert.match(r.message, /^Could not check for updates: /);
            assert.match(r.message, reason);
            assert.doesNotMatch(r.message, /\n/);
        }
        assert.equal((await latestRelease({ pkg: { version: '1.0.0' }, fetchImpl: reply(200, []) })).state, 'error', 'no repository');
        assert.equal((await latestRelease({ root: path.join(tmp, 'missing'), fetchImpl: reply(200, []) })).state, 'error', 'no package.json');
    });

    await check('routes, packaged: no network until asked, the release answer, and POST is refused with 400', async () => {
        let asked = 0;
        const routes = updateRoutes({ sendJson, readJsonBody, root: tmp, packaged: true, release: async () => { asked++; return { state: 'available', current: '0.5.0-beta', latest: '0.5.0', url: 'https://github.com/owner/repo/releases/tag/v0.5.0', message: 'x' }; } });
        let r = await call(routes, 'GET /api/update');
        assert.deepEqual([r.status, r.kind, r.state, asked], [200, 'packaged', 'unchecked', 0]);
        r = await call(routes, 'GET /api/update', { query: '?check=1' });
        assert.deepEqual([r.status, r.kind, r.state, r.latest, asked], [200, 'packaged', 'available', '0.5.0', 1]);
        assert.ok(!Number.isNaN(Date.parse(r.checkedAt)));
        r = await call(routes, 'GET /api/update');
        assert.deepEqual([r.state, asked], ['available', 1], 'the last answer, remembered, with no new request');
        r = await call(routes, 'POST /api/update', { body: {} });
        assert.deepEqual([r.status, r.success, r.kind], [400, false, 'packaged']);
        assert.match(r.message, /download the new version/);
    });
    await check('routes: a copy that is not a git checkout of its own asks for the release', async () => {
        const routes = updateRoutes({ sendJson, readJsonBody, root: tmp, run: async () => ({ kind: 'packaged', state: 'packaged' }), release: async () => ({ state: 'none', current: '0.5.0-beta', latest: null, url: '', message: 'none' }) });
        const r = await call(routes, 'GET /api/update', { query: '?check=1' });
        assert.deepEqual([r.kind, r.state], ['packaged', 'none']);
    });
    await check('routes: a submodule only reports; development mode and a missing token refuse POST', async () => {
        const sub = updateRoutes({ sendJson, readJsonBody, root: tmp, run: async () => ({ kind: 'submodule', state: 'up-to-date', behind: 2, description: 'pins which PLUT_OS commit runs here' }) });
        let r = await call(sub, 'GET /api/update', { query: '?check=1' });
        assert.deepEqual([r.kind, r.state, r.behind, r.token], ['submodule', 'up-to-date', 2, undefined]);
        r = await call(sub, 'POST /api/update', { body: {} });
        assert.deepEqual([r.status, r.kind], [409, 'submodule']);
        assert.match(r.message, /plutos update in a terminal/);
        const dev = updateRoutes({ sendJson, readJsonBody, root: tmp, devMode: true, run: async () => { throw new Error('must not run'); } });
        r = await call(dev, 'POST /api/update', { body: { token: 'x' } });
        assert.equal(r.status, 409);
        assert.match(r.message, /Development mode/);
        const plain = updateRoutes({ sendJson, readJsonBody, root: tmp, run: async () => { throw new Error('must not run'); } });
        r = await call(plain, 'POST /api/update', { body: {} });
        assert.equal(r.status, 409);
        assert.match(r.message, /Check for updates first/);
    });
    await check('routes: a second update while one runs answers 409', async () => {
        let finish;
        const routes = updateRoutes({ sendJson, readJsonBody, root: tmp, run: async (root, { check }) => check
            ? { kind: 'checkout', state: 'up-to-date', behind: 1, from: 'a', target: 'b', description: '1 new' }
            : new Promise(resolve => { finish = () => resolve({ kind: 'checkout', state: 'updated', description: 'Updated.' }); }) });
        const { token } = await call(routes, 'GET /api/update', { query: '?check=1' });
        const first = call(routes, 'POST /api/update', { body: { token } });
        await new Promise(r => setImmediate(r));
        const second = await call(routes, 'POST /api/update', { body: { token } });
        assert.deepEqual([second.status, second.state], [409, 'running']);
        finish();
        const done = await first;
        assert.deepEqual([done.status, done.state, done.restart], [200, 'updated', true]);
    });

    // A real install: a clone of a bare repository, one new upstream commit, through the child process.
    const origin = path.join(tmp, 'origin.git');
    git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
    const seed = path.join(tmp, 'seed');
    git(tmp, 'clone', '-q', origin, seed);
    commit(seed, 'README.md', 'one\n');
    git(seed, 'push', '-q', 'origin', 'HEAD:main');
    const install = path.join(tmp, 'install');
    git(tmp, 'clone', '-q', origin, install);
    const push = (file, text) => { const sha = commit(seed, file, text); git(seed, 'push', '-q', 'origin', 'HEAD:main'); return sha; };

    await check('updateInChild: a check reports new commits and changes nothing; a child past its time is an error', async () => {
        push('a.md', 'a\n');
        const before = git(install, 'rev-parse', 'HEAD');
        const r = await updateInChild(install, { check: true });
        assert.deepEqual([r.kind, r.state, r.behind, r.from], ['checkout', 'up-to-date', 1, before]);
        assert.equal(r.target, git(seed, 'rev-parse', 'HEAD'));
        assert.match(r.description, /1 new commit\(s\)/);
        assert.equal(git(install, 'rev-parse', 'HEAD'), before);
        const slow = await updateInChild(install, { check: true, timeoutMs: 1 });
        assert.equal(slow.state, 'error');
        assert.match(slow.message, /no answer within/);
    });
    await check('routes: check, then POST with its token fast-forwards the install and says to restart', async () => {
        const routes = updateRoutes({ sendJson, readJsonBody, root: install });
        const checked = await call(routes, 'GET /api/update', { query: '?check=1' });
        assert.deepEqual([checked.status, checked.kind, checked.state, checked.behind], [200, 'checkout', 'behind', 1]);
        assert.match(checked.token, /^[\da-f-]{36}$/);
        const r = await call(routes, 'POST /api/update', { body: { token: checked.token } });
        assert.deepEqual([r.status, r.success, r.state, r.restart], [200, true, 'updated', true]);
        assert.match(r.message, /Restart PLUT_OS/);
        assert.equal(git(install, 'rev-parse', 'HEAD'), git(seed, 'rev-parse', 'HEAD'));
        const again = await call(routes, 'POST /api/update', { body: { token: checked.token } });
        assert.equal(again.status, 409, 'a token is used once');
    });
    await check('routes: an upstream that moved after the check refuses the update and changes nothing', async () => {
        push('b.md', 'b\n');
        const routes = updateRoutes({ sendJson, readJsonBody, root: install });
        const { token } = await call(routes, 'GET /api/update', { query: '?check=1' });
        push('c.md', 'c\n');
        const before = git(install, 'rev-parse', 'HEAD');
        const r = await call(routes, 'POST /api/update', { body: { token } });
        assert.deepEqual([r.status, r.success, r.state], [409, false, 'refused']);
        assert.match(r.message, /changed since the last check/);
        assert.equal(git(install, 'rev-parse', 'HEAD'), before);
    });
    console.log(`Update check: ${passed} passed, 0 failed`);
} finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
