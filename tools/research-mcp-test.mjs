#!/usr/bin/env node
// The standalone research MCP (tools/make-research-mcp.mjs) builds into a folder that needs
// nothing from PLUT_OS, starts as a stdio server, lists the five research tools and runs a
// topic end to end. A rebuild deletes only a folder a build made, and the web UI answers only
// its own page. Offline: no page is fetched; a source is written through the store.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'research-mcp-build-'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'research-mcp-work-'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'research-mcp-folders-'));
// Nothing this test starts sees the real user folders or the PLUT_OS data folder.
const home = path.join(temp, 'home');
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    PLUTOS_HOME: path.join(temp, 'plutos-home'), RESEARCH_ROOT: work, PLUTOS_RESEARCH_PYTHON: 'off' };
const build = dir => spawnSync(process.execPath, [path.join(ROOT, 'tools', 'make-research-mcp.mjs'), dir], { encoding: 'utf8', env });
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const status = (port, method, pathname, headers, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(body);
});
let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log(`  ok  ${name}`); };
let client, ui;

try {
    execFileSync(process.execPath, [path.join(ROOT, 'tools', 'make-research-mcp.mjs'), out], { stdio: 'pipe' });
    // Stand in for `npm install`: the build's only dependency is the SDK this repo already has.
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(out, 'node_modules'), 'junction');

    await check('the build holds no import that reaches outside its own folder', () => {
        const files = fs.readdirSync(out, { recursive: true }).filter(f => f.endsWith('.mjs') && !f.startsWith('node_modules'));
        for (const file of files) {
            for (const [, spec] of fs.readFileSync(path.join(out, file), 'utf8').matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
                const target = path.resolve(path.dirname(path.join(out, file)), spec);
                assert.ok(target.startsWith(out + path.sep) && fs.existsSync(target), `${file} imports ${spec}`);
            }
        }
    });
    await check('a rebuild deletes the folder a build made, npm install output included, but not research records kept there', () => {
        const again = path.join(temp, 'again');
        const first = build(again);
        assert.equal(first.status, 0, first.stderr);
        fs.mkdirSync(path.join(again, 'node_modules', 'left-over'), { recursive: true });
        const rebuilt = build(again);
        assert.equal(rebuilt.status, 0, rebuilt.stderr);
        assert.ok(fs.existsSync(path.join(again, 'server.mjs')) && !fs.existsSync(path.join(again, 'node_modules')));
        const record = path.join(again, '.plutos', 'research', 'topic.json');
        fs.mkdirSync(path.dirname(record), { recursive: true });
        fs.writeFileSync(record, '{}');
        const kept = build(again);
        assert.ok(kept.status !== 0 && /refused: .* holds what no build wrote: \.plutos\./.test(kept.stderr), kept.stderr);
        assert.ok(fs.existsSync(record) && fs.existsSync(path.join(again, 'server.mjs')));
    });
    await check('the build refuses a folder or file it did not make, and deletes nothing', () => {
        const mine = path.join(temp, 'mine');
        fs.mkdirSync(mine);
        fs.writeFileSync(path.join(mine, 'notes.txt'), 'keep me');
        for (const target of [mine, path.join(mine, 'notes.txt')]) {
            const refused = build(target);
            assert.ok(refused.status !== 0 && /refused: .*Nothing was deleted/.test(refused.stderr), refused.stderr);
        }
        assert.deepEqual(fs.readdirSync(mine), ['notes.txt']);
        assert.equal(fs.readFileSync(path.join(mine, 'notes.txt'), 'utf8'), 'keep me');
    });

    client = new Client({ name: 'research-mcp-test', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(out, 'server.mjs')], env }));
    const call = async (name, args) => {
        const result = await client.callTool({ name, arguments: args });
        return { error: !!result.isError, body: result.content[0].text };
    };

    await check('the server lists the five research tools', async () => {
        const { tools } = await client.listTools();
        assert.deepEqual(tools.map(t => t.name).sort(), ['research_branch', 'research_fetch', 'research_images', 'research_note', 'research_read', 'research_topic']);
    });
    let topicId, branchId;
    await check('a topic and a branch are recorded under RESEARCH_ROOT', async () => {
        topicId = JSON.parse((await call('research_topic', { action: 'start', title: 'Tide puzzles', question: 'How do tide mechanics teach timing?', pages: 3 })).body).topicId;
        branchId = JSON.parse((await call('research_branch', { action: 'add', topicId, question: 'Examples' })).body).id;
        assert.ok(fs.existsSync(path.join(work, '.plutos', 'research')));
    });
    await check('a fetch without Python says what to install instead of failing silently', async () => {
        const { error, body } = await call('research_fetch', { topicId, url: 'https://example.org/' });
        assert.ok(error && /unavailable/i.test(body), body);
    });
    await check('a finding must cite a fetched source, and a quote must be on the page', async () => {
        const { addSource } = await import(pathToFileURL(path.join(out, 'lib', 'research', 'store.mjs')).href);
        const markdown = 'The tide rises every third move, so players learn to plan two moves ahead.';
        const { source } = addSource(work, topicId, { url: 'https://example.org/tide', finalUrl: 'https://example.org/tide', title: 'Tide',
            markdown, fetchedAt: Date.now(), hash: crypto.createHash('sha256').update(markdown).digest('hex') }, { branchId });
        const invented = await call('research_note', { kind: 'finding', topicId, branchId, claim: 'Tides teach planning', sourceIds: [source.id],
            quotes: [{ sourceId: source.id, text: 'tides make every puzzle easier' }] });
        assert.ok(invented.error && /Quote not found/.test(invented.body), invented.body);
        const real = await call('research_note', { kind: 'finding', topicId, branchId, claim: 'Tides teach planning', sourceIds: [source.id],
            quotes: [{ sourceId: source.id, text: 'players learn to plan two moves ahead' }] });
        assert.ok(!real.error, real.body);
    });
    await check('the web UI answers its own page and refuses another host or site', async () => {
        const port = await freePort();
        ui = spawn(process.execPath, [path.join(out, 'ui-server.mjs')], { env: { ...env, RESEARCH_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
        let said = '';
        ui.stdout.on('data', d => { said += d; });
        ui.stderr.on('data', d => { said += d; });
        for (let i = 0; i < 100 && !said.includes('running at'); i++) await new Promise(r => setTimeout(r, 50));
        assert.match(said, /running at/, said);
        const own = `127.0.0.1:${port}`;
        const topic = JSON.stringify({ title: 'Planted', question: 'Did another site post this?' });
        assert.equal(await status(port, 'GET', '/api/research/topics', { host: own }), 200);
        assert.equal(await status(port, 'GET', '/api/research/topics', { host: `evil.example:${port}` }), 403);
        assert.equal(await status(port, 'POST', '/api/research/topic', { host: own, origin: 'http://evil.example', 'content-type': 'text/plain' }, topic), 403);
        assert.equal(await status(port, 'POST', '/api/research/topic', { host: own, origin: `http://${own}`, 'content-type': 'application/json' }, topic), 200);
    });
    console.log(`Research MCP: ${checks} passed, 0 failed`);
} finally {
    await client?.close().catch(() => {});
    if (ui?.kill()) await new Promise(resolve => ui.once('exit', resolve));
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(temp, { recursive: true, force: true });
}
