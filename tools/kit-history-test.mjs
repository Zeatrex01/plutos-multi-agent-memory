#!/usr/bin/env node
// The leftover catalogue stays complete (lib/kit-history.mjs).
//
// A feature that stops writing a kit file adds its path to the catalogue, or this test fails.
//
// Every path a PLUT_OS version ever wrote into a project is listed in EVER_WRITTEN (built from git
// history). Each one must be written by today's kit (what initTargetProject creates on a temp folder,
// KIT_FILES, and RUNTIME_WRITES, the dashboard's and the MCP server's own writes, checked against
// their writers' source) or be in the catalogue, LEFTOVERS. A new kit file must appear in
// EVER_WRITTEN, so that removing it later forces a catalogue entry. Every catalogue entry names the
// day it stopped, why, what --clean or Repair does with it, and the commit that stopped it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-kit-history-'));
process.env.PLUTOS_HOME = path.join(tmp, 'hub');
process.env.HOME = process.env.USERPROFILE = path.join(tmp, 'user-home');
process.env.APPDATA = path.join(tmp, 'user-home', 'AppData', 'Roaming');
fs.mkdirSync(process.env.APPDATA, { recursive: true });
const { initTargetProject, KIT_FILES } = await import('../lib/workspaces.mjs');
const { LEFTOVERS, EVER_WRITTEN, RUNTIME_WRITES, LEFTOVER_ACTIONS, patternCovers } = await import('../lib/kit-history.mjs');

let passed = 0, failed = 0;
const check = (name, fn) => {
    try { fn(); passed++; console.log(`  ok  ${name}`); }
    catch (e) { failed++; console.log(`  FAIL ${name}: ${e.message}`); }
};
const gitIn = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

// Every file, and every empty folder (as name/), project-relative, git internals left out.
function created(root, relative = '', out = []) {
    const names = fs.readdirSync(path.join(root, relative));
    if (relative && !names.length) out.push(`${relative}/`);
    for (const name of names) {
        const next = relative ? `${relative}/${name}` : name;
        if (next === '.git') continue;
        if (fs.statSync(path.join(root, next)).isDirectory()) created(root, next, out); else out.push(next);
    }
    return out;
}
function kitProject(name, setup = () => {}) {
    const root = path.join(tmp, name);
    fs.mkdirSync(root, { recursive: true });
    gitIn(root, ['init', '-q']);
    setup(root);
    const before = new Set(created(root));
    initTargetProject(root, { withInterview: true });
    return created(root).filter(p => !before.has(p));
}

try {
    // Our own AGENTS.md, and a project that keeps its own AGENTS.md and CLAUDE.md: between them,
    // every file the kit writes (the protocol and the Claude rule appear only in the second).
    const today = [...new Set([
        ...kitProject('ours'),
        ...kitProject('own-rules', root => {
            fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Our rules\n');
            fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Our Claude notes\n');
        })
    ])].sort();
    const runtime = RUNTIME_WRITES.map(r => r.path);
    const writtenToday = entry => KIT_FILES.includes(entry) || runtime.includes(entry) || today.some(p => patternCovers(entry, p));
    const qualified = entry => Boolean(entry.contains || entry.names || entry.recorded);

    check('the kit wrote something on a temp folder', () => assert.ok(today.includes('AGENTS.md') && today.includes('docs/handoff/PLUTOS_PROTOCOL.md'), today.join(', ')));
    check('(c) every path today\'s kit creates is in EVER_WRITTEN', () => {
        assert.deepEqual(today.filter(p => !EVER_WRITTEN.some(e => patternCovers(e, p))), [], 'add these to EVER_WRITTEN in lib/kit-history.mjs');
    });
    check('(c) every KIT_FILES entry and every runtime write is in EVER_WRITTEN', () => {
        assert.deepEqual([...KIT_FILES, ...runtime].filter(p => !EVER_WRITTEN.includes(p)), []);
    });
    check('(a) every path ever written is written today or is in the catalogue', () => {
        const orphans = EVER_WRITTEN.filter(e => !writtenToday(e) && !LEFTOVERS.some(l => l.path === e));
        assert.deepEqual(orphans, [], 'the kit stopped writing these: add a LEFTOVERS entry for each in lib/kit-history.mjs');
    });
    check('every catalogue path is in EVER_WRITTEN, once', () => {
        assert.deepEqual(LEFTOVERS.map(l => l.path).filter(p => !EVER_WRITTEN.includes(p)), []);
        assert.equal(new Set(EVER_WRITTEN).size, EVER_WRITTEN.length, 'EVER_WRITTEN lists a path twice');
    });
    check('a catalogue path without a qualifier is not one today\'s kit writes', () => {
        assert.deepEqual(LEFTOVERS.filter(l => !qualified(l) && writtenToday(l.path)).map(l => l.path), []);
    });
    check('(b) every catalogue entry names its day, its reason, its action and its commit', () => {
        const now = new Date().toISOString().slice(0, 10);
        for (const l of LEFTOVERS) {
            assert.match(l.since, /^\d{4}-\d{2}-\d{2}$/, `${l.path}: since`);
            assert.ok(!Number.isNaN(Date.parse(l.since)) && l.since <= now, `${l.path}: since is not a past day`);
            assert.ok(typeof l.why === 'string' && l.why.trim().length > 10 && !l.why.includes('\n'), `${l.path}: why is one line`);
            assert.ok(LEFTOVER_ACTIONS.includes(l.action), `${l.path}: action ${l.action}`);
            assert.match(l.commit, /^[0-9a-f]{7,40}$/, `${l.path}: commit`);
        }
    });
    check('each cited commit exists and is dated the day the entry says it stopped', () => {
        if (gitIn(ROOT, ['rev-parse', '--git-dir']).status !== 0) return console.log('      (no git checkout: skipped)');
        // A published copy or a shallow clone carries none of the history the catalogue cites;
        // there the check has nothing to read. A history holding some cited commits must hold all.
        const shown = LEFTOVERS.map(l => ({ l, shown: gitIn(ROOT, ['show', '-s', '--format=%ad', '--date=short', l.commit]) }));
        if (shown.every(s => s.shown.status !== 0)) return console.log('      (the cited history is not in this checkout: skipped)');
        for (const { l, shown: s } of shown) {
            assert.equal(s.status, 0, `${l.path}: commit ${l.commit} is not in this repository`);
            assert.equal(s.stdout.trim(), l.since, `${l.path}: ${l.commit} is dated ${s.stdout.trim()}`);
        }
    });
    check('each runtime write is still in its writer\'s source', () => {
        for (const r of RUNTIME_WRITES) {
            const source = fs.readFileSync(path.join(ROOT, r.writer), 'utf8');
            assert.ok(source.includes(r.evidence), `${r.path}: ${r.writer} no longer holds ${r.evidence}; if it stopped writing, move the path to LEFTOVERS`);
        }
    });
    check('a pattern covers what it names and nothing beside it', () => {
        assert.ok(patternCovers('docs/boards/*.md', 'docs/boards/design.md'));
        assert.ok(!patternCovers('docs/boards/*.md', 'docs/boards/attachments/a.png'));
        assert.ok(patternCovers('docs/roadmap/', 'docs/roadmap/data/roadmap-data.js'));
        assert.ok(patternCovers('.claude/skills/*', '.claude/skills/alpha/SKILL.md'));
        assert.ok(!patternCovers('docs/handoff/SYSTEM.md', 'docs/handoff/SYSTEM.md.bak'));
        assert.ok(patternCovers('.studio/status/plutos.*.json', '.studio/status/plutos.1234.json'));
        assert.ok(!patternCovers('.studio/status/plutos.*.json', '.studio/status/frame.1234.json'));
    });
} finally {
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best effort */ }
}
console.log(`Kit history: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
