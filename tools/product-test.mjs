#!/usr/bin/env node
// The product (docs/PRODUCT.md, tools/product.mjs): what the build ships holds no personal
// information, secret or source map; a file git ignores is not copied; both bundles build with the
// build's own options; the bundled MCP server answers; and every bundled package's licence ships.
// It bundles in a temp folder and does not run the full build, which copies the Node binary.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { scanRelease } from '../lib/release-scan.mjs';
import { SHIPPED_DIRS, SHIPPED_FILES, copyReleaseFiles, shippedSources, bundleOptions, bundledPackages, noticesText } from './product.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-product-'));
let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log(`  ok  ${name}`); };

/** The first stdout line of `node file` that answers request 1, or null after `ms`. */
function firstAnswer(file, env, ms = 15000) {
    return new Promise(resolve => {
        const child = spawn(process.execPath, [file], { cwd: scratch, env, stdio: ['pipe', 'pipe', 'ignore'] });
        let out = '';
        const done = value => { clearTimeout(timer); child.kill(); resolve(value); };
        const timer = setTimeout(() => done(null), ms);
        child.stdout.on('data', chunk => {
            out += chunk;
            for (const line of out.split('\n')) {
                try { const message = JSON.parse(line); if (message.id === 1) return done(message); } catch { /* a partial line */ }
            }
        });
        child.on('exit', () => done(null));
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'product-test', version: '1' } } }) + '\n');
    });
}

try {
    await check('the shipped files hold no personal address, home-folder path, secret or source map', () => {
        const files = shippedSources(root);
        assert.ok(files.length > 140, `${files.length} shipped files`);
        const found = scanRelease(root, { terms: [], files }).filter(f => ['personal', 'secret', 'maps'].includes(f.kind));
        assert.deepEqual(found.map(f => `${f.kind} ${f.file}:${f.line}`), []);
    });

    await check('nothing from the records, research or tests is on the shipped list', () => {
        for (const item of [...SHIPPED_DIRS, ...SHIPPED_FILES]) {
            assert.ok(!/^(docs|graphify-out|tasks|\.claude|\.plutos)(\/|$)|-test\.mjs$|^(CHANGELOG|IDEAS|ROADMAP|MVP)\.md$/.test(item), item);
        }
    });

    await check('an ignored local file stays behind; a new file not yet added ships', () => {
        const repo = path.join(scratch, 'repo');
        fs.mkdirSync(path.join(repo, 'skills', 'theirs'), { recursive: true });
        fs.writeFileSync(path.join(repo, '.gitignore'), 'skills/theirs/\n');
        fs.writeFileSync(path.join(repo, 'skills', 'ours.md'), 'ours\n');
        fs.writeFileSync(path.join(repo, 'skills', 'theirs', 'SKILL.md'), 'not ours to ship\n');
        execFileSync('git', ['init', '-q'], { cwd: repo });
        execFileSync('git', ['add', '-A'], { cwd: repo });
        fs.writeFileSync(path.join(repo, 'skills', 'new.md'), 'written after the last add\n');
        copyReleaseFiles(path.join(repo, 'skills'), path.join(scratch, 'copy'));
        assert.deepEqual(fs.readdirSync(path.join(scratch, 'copy')).sort(), ['new.md', 'ours.md']);
    });

    const bundles = bundleOptions(root);
    const out = path.join(scratch, 'dist');
    const dashboard = await build({ ...bundles.dashboard, outfile: path.join(out, 'server.cjs'), write: false, logLevel: 'silent' });
    const mcp = await build({ ...bundles.mcp, outfile: path.join(out, 'index.mjs'), logLevel: 'silent' });

    await check('both bundles build with the build\'s options and carry no source map', () => {
        assert.deepEqual(dashboard.outputFiles.map(f => path.basename(f.path)), ['server.cjs'], 'a CommonJS bundle allows no top-level await');
        assert.deepEqual(fs.readdirSync(out), ['index.mjs']);
        for (const text of [dashboard.outputFiles[0].text, fs.readFileSync(path.join(out, 'index.mjs'), 'utf8')]) {
            assert.ok(!text.includes(['sourceMapping', 'URL='].join('')));
        }
    });

    await check('the bundled MCP server answers: no module inside it runs as a command', async () => {
        const answer = await firstAnswer(path.join(out, 'index.mjs'), { ...process.env, PLUTOS_HOME: path.join(scratch, 'home') });
        assert.ok(answer?.result?.serverInfo, `no answer to initialize: ${JSON.stringify(answer)}`);
        // The server names itself plutos with the package version, inlined at build time (no runtime file read).
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        assert.equal(answer.result.serverInfo.name, 'plutos');
        assert.equal(answer.result.serverInfo.version, pkg.version);
    });

    await check('THIRD_PARTY_NOTICES carries the licence of every bundled package and of Node.js', () => {
        const bundled = bundledPackages(root, [dashboard.metafile, mcp.metafile]);
        assert.ok(bundled.some(p => p.name === '@modelcontextprotocol/sdk'), bundled.map(p => p.name).join(', '));
        assert.deepEqual(bundled.filter(p => !p.text).map(p => p.name), [], 'each bundled package keeps a licence file');
        const text = noticesText(bundled, { nodeLicense: null });
        for (const p of bundled) assert.ok(text.includes(`${p.name} ${p.version} (${p.license})`), p.name);
        assert.match(text, new RegExp(`Node\\.js ${process.version.replace(/\./g, '\\.')}[\\s\\S]*nodejs/node/blob/${process.version.replace(/\./g, '\\.')}/LICENSE`));
    });

    console.log(`${checks} product checks passed`);
} finally {
    fs.rmSync(scratch, { recursive: true, force: true });
}
