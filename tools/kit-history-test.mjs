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
const { initTargetProject, KIT_FILES, kitProtocolText } = await import('../lib/workspaces.mjs');
const { createAgent } = await import('../lib/agents.mjs');
const { LEFTOVERS, EVER_WRITTEN, RUNTIME_WRITES, LEFTOVER_ACTIONS, patternCovers } = await import('../lib/kit-history.mjs');
const { PLUTOS_STATE } = await import('../lib/kit-history.mjs');
const { MACHINE_IGNORES, SHARED_STATE, planKitRefresh, PAST_PROTOCOLS, CLAUDE_RULE_HEADER } = await import('../lib/workspaces.mjs');
const { auditProject } = await import('../lib/audit.mjs');
const { createHash } = await import('node:crypto');

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
    // Field reports 2026-11-14: sub-agents spent long runs on look-ups a tool answers, because no
    // text they read said so. Every kit text a sub-agent reads carries the "tools before agents" line.
    check('the kit texts a sub-agent reads say tools before agents', () => {
        const rule = /Tools before agents:?\*?\*? look-ups and lists are PLUT_OS tool calls/;
        assert.match(fs.readFileSync(path.join(tmp, 'ours', 'AGENTS.md'), 'utf8').replace(/\s+/g, ' '), rule);
        assert.match(kitProtocolText(), rule);
        assert.equal(fs.readFileSync(path.join(tmp, 'own-rules', 'docs', 'handoff', 'PLUTOS_PROTOCOL.md'), 'utf8'), kitProtocolText());
        const made = createAgent(path.join(tmp, 'ours'), { name: 'tools-check', owner: 'claude', role: 'test' });
        const definition = fs.readFileSync(path.join(tmp, 'ours', '.claude', 'agents', 'tools-check.md'), 'utf8');
        assert.ok(made.created !== false);
        assert.match(definition.replace(/\s+/g, ' '), /Tools before agents: look-ups and lists are PLUT_OS tool calls .*name their tools in the brief/);
    });
    // A project that keeps its own AGENTS.md and CLAUDE.md got the protocol once, at init; init never
    // rewrites it. An unedited past copy must reach today's text through Repair, and audit must not
    // call it the owner's edit (critique seat, 2026-11-14).
    check('an unedited past board protocol is refreshed by Repair and audited as older', () => {
        const root = path.join(tmp, 'own-rules');
        const rule7 = /^7\. \*\*Tools before agents:.*\n/m;
        const past = kitProtocolText().replace(rule7, '');
        assert.notEqual(past, kitProtocolText());
        assert.ok(PAST_PROTOCOLS.includes(createHash('sha256').update(past).digest('hex')), 'the protocol before rule 7 is a past protocol');
        const protocolFile = path.join(root, 'docs', 'handoff', 'PLUTOS_PROTOCOL.md');
        const ruleFile = path.join(root, '.claude', 'rules', 'plutos.md');
        fs.writeFileSync(protocolFile, past.replace(/\n/g, '\r\n'));
        fs.writeFileSync(ruleFile, CLAUDE_RULE_HEADER + past);
        const audited = auditProject(root).sections.kitFiles;
        const kinds = Object.fromEntries(audited.map(f => [f.path, f.kind]));
        assert.equal(kinds['docs/handoff/PLUTOS_PROTOCOL.md'], 'older-copy', JSON.stringify(audited));
        assert.equal(kinds['.claude/rules/plutos.md'], 'older-copy', JSON.stringify(audited));
        const changes = planKitRefresh(root);
        assert.equal(changes.find(c => c.path === protocolFile)?.content, kitProtocolText());
        assert.equal(changes.find(c => c.path === ruleFile)?.content, CLAUDE_RULE_HEADER + kitProtocolText());
        // An edited copy stays the owner's.
        fs.writeFileSync(protocolFile, past + 'Our note.\n');
        assert.ok(!planKitRefresh(root).some(c => c.path === protocolFile));
        fs.writeFileSync(protocolFile, kitProtocolText());
        fs.writeFileSync(ruleFile, CLAUDE_RULE_HEADER + kitProtocolText());
    });
    // Like PAST_KIT_RULES for AGENTS.md: when kitProtocolText changes, HEAD's text joins PAST_PROTOCOLS.
    check('HEAD\'s board protocol is today\'s or a past protocol', () => {
        const head = gitIn(ROOT, ['show', 'HEAD:lib/workspaces.mjs']);
        if (head.status !== 0) return;
        const body = head.stdout.match(/^export function kitProtocolText\(\) \{[\s\S]*?^\}/m)?.[0];
        if (!body) return;
        const text = new Function(`${body.replace(/^export /, '')}; return kitProtocolText();`)();
        assert.ok(text === kitProtocolText() || PAST_PROTOCOLS.includes(createHash('sha256').update(text).digest('hex')),
            'add the sha256 of HEAD\'s kitProtocolText() to PAST_PROTOCOLS in lib/workspaces.mjs');
    });
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
    // Item 7 of feedback/2026-11-14.verified.md: which .plutos/ files are shared and which per machine.
    check('every .plutos/ path the kit or the runtime writes today has a shared-or-machine ruling, with its reason', () => {
        const ruled = PLUTOS_STATE.map(s => s.path);
        const unruled = EVER_WRITTEN.filter(e => e.startsWith('.plutos/') && writtenToday(e) && !ruled.includes(e));
        assert.deepEqual(unruled, [], 'add a PLUTOS_STATE entry in lib/kit-history.mjs for each');
        assert.equal(new Set(ruled).size, ruled.length, 'PLUTOS_STATE lists a path twice');
        for (const s of PLUTOS_STATE) {
            assert.ok(['shared', 'machine'].includes(s.share), `${s.path}: share ${s.share}`);
            assert.ok(typeof s.why === 'string' && s.why.trim().length > 10 && !s.why.includes('\n'), `${s.path}: why is one line`);
        }
    });
    check('the ruling is what the kit carries out: machine paths are ignore lines, shared ones never are and the files are audited', () => {
        const ignored = p => MACHINE_IGNORES.some(e => patternCovers(e, p));
        assert.deepEqual(PLUTOS_STATE.filter(s => s.share === 'machine' && !ignored(s.path)).map(s => s.path), [], 'add these to MACHINE_IGNORES in lib/workspaces.mjs');
        assert.deepEqual(PLUTOS_STATE.filter(s => s.share === 'shared' && ignored(s.path)).map(s => s.path), [], 'shared state must not be a MACHINE_IGNORES line');
        const sharedFiles = PLUTOS_STATE.filter(s => s.share === 'shared' && !s.path.endsWith('/') && !KIT_FILES.includes(s.path)).map(s => s.path);
        assert.deepEqual(sharedFiles.filter(p => !SHARED_STATE.includes(p)), [], 'add these to SHARED_STATE in lib/workspaces.mjs');
        assert.deepEqual(SHARED_STATE.filter(p => !sharedFiles.includes(p)), [], 'SHARED_STATE holds a path PLUTOS_STATE does not rule shared');
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
