#!/usr/bin/env node
// Research studio rules (lib/research): unsourced findings and invented quotes are refused,
// budgets hold, briefs are built only from cited material, and the fetch bridge never reads
// the local network. Offline by default; PLUTOS_RESEARCH_LIVE=1 adds one real fetch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as store from '../lib/research/store.mjs';
import { fetchPage, fetchImages, fetchRuntime, normalizeUrl } from '../lib/research/fetch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-research-'));
let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log(`  ok  ${name}`); };
const page = (url, markdown) => ({ url, finalUrl: url, title: url, markdown, fetchedAt: Date.now(),
    hash: crypto.createHash('sha256').update(markdown).digest('hex') });
const SWISS = 'Swiss Style emphasises cleanliness, readability, and objectivity.\nHallmarks are asymmetric layouts, a grid, and sans-serif typefaces such as Akzidenz-Grotesk.';

try {
    const topic = store.startTopic(root, { title: 'Swiss style', question: 'What makes a layout Swiss style?', goal: 'Design a landing page in it', pages: 2, depth: 2 });
    const branch = store.addBranch(root, topic.id, { question: 'Typography' });
    const { source } = store.addSource(root, topic.id, page('https://example.org/swiss', SWISS), { branchId: branch.id });

    await check('budgets are validated when a topic starts', () => {
        assert.throws(() => store.startTopic(root, { title: 't', question: 'q', pages: 0 }), /Page budget/);
        assert.throws(() => store.startTopic(root, { title: 't', question: 'q', depth: 9 }), /Depth/);
    });
    await check('branch depth is a hard limit', () => {
        const child = store.addBranch(root, topic.id, { question: 'Grid ratios', parentId: branch.id });
        assert.equal(child.depth, 2);
        assert.throws(() => store.addBranch(root, topic.id, { question: 'Too deep', parentId: child.id }), /Depth budget/);
    });
    await check('a finding without a fetched source is refused', () => {
        assert.throws(() => store.addFinding(root, topic.id, { branchId: branch.id, claim: 'Uses grids', sourceIds: [] }), /at least one fetched source/);
        assert.throws(() => store.addFinding(root, topic.id, { branchId: branch.id, claim: 'Uses grids', sourceIds: ['source-0123456789'] }), /never fetched/);
    });
    await check('a quote that is not on the page is refused; a re-wrapped real one is accepted', () => {
        assert.throws(() => store.addFinding(root, topic.id, { branchId: branch.id, claim: 'Serif fonts', sourceIds: [source.id],
            quotes: [{ sourceId: source.id, text: 'Swiss Style prefers ornate serif typefaces' }] }), /Quote not found/);
        const finding = store.addFinding(root, topic.id, { branchId: branch.id, claim: 'Sans-serif type on a grid', sourceIds: [source.id],
            quotes: [{ sourceId: source.id, text: 'a grid,   and sans-serif   typefaces' }] });
        assert.equal(finding.quotes.length, 1);
    });
    await check('a branch closes as answered only with a finding under it', () => {
        const empty = store.addBranch(root, topic.id, { question: 'Colour' });
        assert.throws(() => store.setBranchStatus(root, topic.id, { branchId: empty.id, status: 'answered' }), /answered only once/);
        assert.throws(() => store.setBranchStatus(root, topic.id, { branchId: empty.id, status: 'dead_end' }), /why/);
        store.setBranchStatus(root, topic.id, { branchId: empty.id, status: 'dead_end', note: 'Sources disagree; colour is secondary.' });
        store.setBranchStatus(root, topic.id, { branchId: branch.id, status: 'answered' });
    });
    await check('the page budget is a hard limit, and refetching the same page does not spend it', () => {
        assert.equal(store.addSource(root, topic.id, page('https://example.org/swiss', SWISS)).duplicate, true);
        store.addSource(root, topic.id, page('https://example.org/two', 'Second page.'));
        assert.throws(() => store.addSource(root, topic.id, page('https://example.org/three', 'Third page.')), /Page budget of 2/);
    });
    await check('a principle must rest on findings', () => {
        assert.throws(() => store.addPrinciple(root, topic.id, { statement: 'Use a grid', findingIds: [] }), /rest on at least one finding/);
    });
    await check('status names the gaps, and the brief is a draft until they close', () => {
        const status = store.topicStatus(root, topic.id);
        assert.equal(status.ready, false);
        assert.ok(status.gaps.some(g => /Open branch "Grid ratios"/.test(g)));
        assert.match(store.topicBrief(root, topic.id).markdown, /> Draft:/);
    });
    await check('a finished topic briefs from cited material only, with numbered sources', () => {
        const t = store.readTopicFull(root, topic.id);
        const open = t.branches.find(b => b.question === 'Grid ratios');
        store.setBranchStatus(root, topic.id, { branchId: open.id, status: 'dead_end', note: 'Not covered by the fetched sources.' });
        store.addPrinciple(root, topic.id, { statement: 'Set type in a sans-serif on a visible grid', findingIds: [t.findings[0].id], kind: 'do' });
        const brief = store.topicBrief(root, topic.id);
        assert.equal(brief.ready, true);
        assert.match(brief.markdown, /## Do\n- Set type in a sans-serif on a visible grid \[1\]/);
        assert.match(brief.markdown, /> "a grid,   and sans-serif   typefaces" \[1\]/);
        assert.match(brief.markdown, /1\. https:\/\/example\.org\/swiss — https:\/\/example\.org\/swiss/);
    });
    await check('ids from outside the store cannot reach other folders', () => {
        assert.throws(() => store.readSourceText(root, '../../etc', 'source-0123456789'), /Unknown id|No such research topic/);
    });
    await check('only http(s) URLs are accepted', () => {
        assert.throws(() => normalizeUrl('file:///c:/Windows/win.ini'), /http and https/);
        assert.equal(normalizeUrl('https://example.org/a#frag'), 'https://example.org/a');
    });
    await check('a rendered fetch never reuses the plain fetch of the same page from the cache', async () => {
        const url = 'https://example.invalid/page';
        const cacheDir = store.cacheDir(root);
        fs.mkdirSync(cacheDir, { recursive: true });
        const plain = { url, finalUrl: url, title: 'cached', markdown: 'plain text', fetchedAt: Date.now(), hash: 'x' };
        fs.writeFileSync(path.join(cacheDir, `${crypto.createHash('sha256').update(url).digest('hex').slice(0, 32)}.json`), JSON.stringify(plain));
        assert.equal((await fetchPage(url, { cacheDir })).markdown, 'plain text');
        await assert.rejects(fetchPage(url, { cacheDir, render: true }));
    });
    await check('saved images are recorded once each, with the page they came from', () => {
        const image = { url: 'https://example.org/a.png', file: 'aaaa.png', bytes: 9000, type: 'image/png', sha256: 'a'.repeat(64) };
        const first = store.addImages(root, topic.id, 'https://example.org/page', [image, { ...image, url: 'https://example.org/copy.png' }]);
        assert.equal(first.total, 1, 'the same bytes from two URLs are one image');
        assert.equal(first.images[0].pageUrl, 'https://example.org/page');
        assert.match(first.images[0].file, /^images\/aaaa\.png$/);
        assert.throws(() => store.addImages(root, topic.id, 'https://example.org/page', [image], { branchId: 'branch-0000000000' }), /Branch not found/);
    });
    // The bridge refuses private addresses before it imports Scrapling, so this runs wherever Python does, with
    // its site packages switched off (-S) to prove the check needs none of them.
    const py = ['python3', 'python'].find(cmd => spawnSync(cmd, ['-c', 'pass']).status === 0);
    if (py) {
        await check('the bridge refuses a private address before it needs Scrapling', async () => {
            for (const url of ['http://127.0.0.1/', 'http://192.168.1.1/']) for (const mode of [undefined, 'images']) {
                const r = spawnSync(py, ['-I', '-S', path.join(ROOT, 'lib', 'research', 'scrapling_bridge.py')],
                    { input: JSON.stringify({ url, mode, outDir: os.tmpdir() }), encoding: 'utf8' });
                assert.equal(JSON.parse(r.stdout).code, 'private', `${url} ${mode || 'page'}: ${r.stdout}${r.stderr}`);
            }
        });
    } else console.log('  --  offline bridge check skipped: no Python');
    const rt = fetchRuntime();
    if (rt.available) {
        await check('the bridge refuses this machine and the home network', async () => {
            for (const url of ['http://localhost:3040/', 'http://127.0.0.1/', 'http://192.168.1.1/', 'http://10.0.0.1/']) {
                await assert.rejects(fetchPage(url), error => error.code === 'private', url);
                await assert.rejects(fetchPage(url, { render: true }), error => error.code === 'private', `${url} rendered`);
                await assert.rejects(fetchImages(url, { outDir: path.join(root, 'images-test') }), error => error.code === 'private', `${url} images`);
            }
        });
    } else console.log(`  --  bridge checks skipped: ${rt.reason}`);
    if (rt.available && process.env.PLUTOS_RESEARCH_LIVE === '1') {
        await check('a real public page fetches as readable text', async () => {
            const live = await fetchPage('https://en.wikipedia.org/wiki/Swiss_Style_(design)', { cacheDir: store.cacheDir(root) });
            assert.match(live.markdown, /Swiss/);
        });
        await check('a script-filled page (Steam reviews) is read only when rendered', async () => {
            const url = 'https://steamcommunity.com/app/413150/reviews/?browsefilter=mostrecent&filterLanguage=english';
            const plain = await fetchPage(url, { cacheDir: store.cacheDir(root) });
            const rendered = await fetchPage(url, { cacheDir: store.cacheDir(root), render: true });
            assert.doesNotMatch(plain.markdown, /hrs on record/);
            assert.match(rendered.markdown, /hrs on record/);
        });
        await check('a Steam game\'s store data gives its screenshots as image files', async () => {
            const outDir = path.join(root, 'live-images');
            const result = await fetchImages('https://store.steampowered.com/api/appdetails?appids=413150', { outDir, max: 3 });
            assert.ok(result.images.length >= 1, JSON.stringify(result.skipped));
            for (const image of result.images) assert.ok(fs.statSync(path.join(outDir, image.file)).size === image.bytes);
        });
        await check('a JSON answer is read as indented text', async () => {
            const json = await fetchPage('https://store.steampowered.com/api/appdetails?appids=413150', { cacheDir: store.cacheDir(root) });
            assert.match(json.markdown, /"steam_appid": 413150/);
        });
    }
    console.log(`Research studio: ${checks} passed, 0 failed`);
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
