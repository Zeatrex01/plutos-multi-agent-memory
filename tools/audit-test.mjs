#!/usr/bin/env node
// plutos audit (lib/audit.mjs) on temp projects, with the Hub and the home folder isolated: a fresh
// kit is clean; the same with an older version's files is old, with each leftover found and the past
// AGENTS.md reported as an older copy Repair refreshes; a document citing a missing file is a records
// finding; a kind stops at the limit with a count; --clean refuses without an interactive terminal;
// the library mover moves only what it may, keeps the paths, and refuses over an uncommitted change;
// --json carries the full shape.
//
// Not tested: `plutos audit --clean` run in a pseudo-terminal. The terminal gate is cli.mjs
// requireTerminal (shared with approve and the memory verbs); the moving it guards is cleanLeftovers,
// tested here directly.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-audit-'));
process.env.PLUTOS_HOME = path.join(tmp, 'hub');
process.env.HOME = process.env.USERPROFILE = path.join(tmp, 'user-home');
process.env.APPDATA = path.join(tmp, 'user-home', 'AppData', 'Roaming');
fs.mkdirSync(process.env.APPDATA, { recursive: true });
for (const k of ['PLUTOS_DEV', 'PLUTOS_PROJECT_ROOT', 'CLAUDE_PROJECT_DIR']) delete process.env[k];
const { initTargetProject, PAST_KIT_RULES, planKitRefresh, pastPointers } = await import('../lib/workspaces.mjs');
const { auditProject, cleanLeftovers, AUDIT_SECTIONS, AUDIT_LIMIT } = await import('../lib/audit.mjs');
const { acceptClaims, findClaims } = await import('../lib/claims.mjs');

let passed = 0, failed = 0;
const test = (name, fn) => {
    try { fn(); passed++; console.log(`  ok  ${name}`); }
    catch (e) { failed++; console.log(`  FAIL ${name}: ${e.stack}`); }
};
const sha = text => createHash('sha256').update(text).digest('hex');
const git = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
};
const write = (root, relative, text) => { fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); fs.writeFileSync(path.join(root, relative), text); };
const exists = (root, relative) => fs.existsSync(path.join(root, relative));
function kitProject(name) {
    const root = path.join(tmp, name);
    fs.mkdirSync(root, { recursive: true });
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'audit@example.invalid');
    git(root, 'config', 'user.name', 'audit test');
    git(root, 'config', 'commit.gpgsign', 'false');
    initTargetProject(root);
    commit(root, 'kit');
    return root;
}
const commit = (root, message) => { git(root, 'add', '-A'); git(root, 'commit', '-q', '--allow-empty', '-m', message); };
const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), 'audit', ...args], { encoding: 'utf8', env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
const all = report => AUDIT_SECTIONS.flatMap(s => report.sections[s]);

// A past kit AGENTS.md: one this repository shipped (its hash is in PAST_KIT_RULES), else a stand-in.
function pastRules() {
    const log = spawnSync('git', ['log', '--format=%h', '-n', '80', '--', 'AGENTS.md'], { cwd: ROOT, encoding: 'utf8' });
    for (const c of (log.status === 0 ? log.stdout.split('\n').filter(Boolean) : [])) {
        const text = spawnSync('git', ['show', `${c}:AGENTS.md`], { cwd: ROOT, encoding: 'utf8' }).stdout.replace(/\r\n/g, '\n');
        if (PAST_KIT_RULES.includes(sha(text))) return { text, rules: PAST_KIT_RULES };
    }
    console.log('      (no git history with a past AGENTS.md: a stand-in past version is used)');
    const text = '<!-- plutos:kit -->\nold rules\n';
    return { text, rules: [...PAST_KIT_RULES, sha(text)] };
}

try {
    const fresh = kitProject('fresh');

    test('a project made with today\'s kit is clean', () => {
        const r = auditProject(fresh);
        assert.equal(r.verdict, 'clean', `${r.why}\n${JSON.stringify(all(r), null, 1)}`);
        assert.equal(r.counts.high + r.counts.medium, 0);
        assert.equal(r.sections.leftovers.length, 0);
        assert.ok(r.facts.kit && r.facts.currentKitFiles > 0);
    });

    test('the audit reads only: git sees no change in the project afterwards, ignored files included', () => {
        const before = git(fresh, 'status', '--porcelain', '--ignored');
        auditProject(fresh);
        assert.equal(git(fresh, 'status', '--porcelain', '--ignored'), before);
    });

    const old = kitProject('old');
    const past = pastRules();
    write(old, 'AGENTS.md', past.text);
    write(old, 'docs/handoff/SYSTEM.md', '# SYSTEM — component roles\n');
    write(old, 'docs/handoff/system-roles/kernel.md', '# KERNEL\n');
    write(old, '.plutos/profile.json', '{ "profile": "lite" }\n');
    write(old, 'docs/boards/design.md', '# design board\n');
    commit(old, 'an older kit');

    test('the same project with an older version\'s files is old, each leftover found', () => {
        const r = auditProject(old, { pastRules: past.rules });
        assert.equal(r.verdict, 'old', r.why);
        const found = r.sections.leftovers.map(f => f.path);
        for (const p of ['docs/handoff/SYSTEM.md', 'docs/handoff/system-roles/', '.plutos/profile.json', 'docs/boards/design.md']) assert.ok(found.includes(p), `${p} not found in ${found}`);
        for (const f of r.sections.leftovers) {
            assert.equal(f.fix, 'move');
            assert.ok(f.movable && f.since && f.commit && f.size > 0 && f.lastCommit, JSON.stringify(f));
        }
    });

    test('the past AGENTS.md is an older copy that Repair refreshes', () => {
        const r = auditProject(old, { pastRules: past.rules });
        const agents = r.sections.kitFiles.find(f => f.path === 'AGENTS.md');
        assert.ok(agents, JSON.stringify(r.sections.kitFiles));
        assert.equal(agents.kind, 'older-copy');
        assert.equal(agents.fix, 'repair');
        assert.match(agents.message, /Repair refreshes it/);
    });

    test('the first pointer (2026-07) is an older copy, and Repair plans its refresh', () => {
        const root = kitProject('first-pointer');
        const [first] = pastPointers('CLAUDE.md', true);
        write(root, 'CLAUDE.md', first);
        const finding = auditProject(root).sections.kitFiles.find(f => f.path === 'CLAUDE.md');
        assert.equal(finding?.kind, 'older-copy');
        assert.ok(planKitRefresh(root).some(change => path.basename(change.path) === 'CLAUDE.md'));
        write(root, 'CLAUDE.md', first + 'my own line\n');
        assert.equal(auditProject(root).sections.kitFiles.find(f => f.path === 'CLAUDE.md')?.kind, 'edited');
    });

    test('a document citing a missing file is a records finding; the baseline makes it accepted, not gone', () => {
        const root = kitProject('records');
        write(root, 'src/app.mjs', 'export const x = 1;\n');
        write(root, 'docs/notes.md', '# Notes\n\nThe entry point is `src/missing.mjs`.\n');
        commit(root, 'notes');
        let r = auditProject(root);
        const f = r.sections.records.find(x => x.kind === 'missing-path');
        assert.ok(f, JSON.stringify(r.sections.records));
        assert.equal(f.path, 'docs/notes.md');
        assert.equal(f.line, 3);
        assert.equal(f.severity, 'medium');
        assert.equal(r.verdict, 'mixed');
        acceptClaims(root, findClaims(root));
        r = auditProject(root);
        const accepted = r.sections.records.find(x => x.kind === 'missing-path');
        assert.equal(accepted?.accepted, true);
        assert.equal(accepted.severity, 'low');
    });

    test(`a kind stops at ${AUDIT_LIMIT} findings and counts the rest`, () => {
        const root = kitProject('many');
        for (let i = 1; i <= AUDIT_LIMIT + 5; i++) write(root, `docs/boards/role-${i}.md`, `# role ${i}\n`);
        const r = auditProject(root);
        assert.equal(r.sections.leftovers.length, AUDIT_LIMIT);
        assert.equal(r.omitted.leftovers.leftover, 5);
        assert.equal(r.facts.certainLeftovers, AUDIT_LIMIT + 5);
    });

    test('--clean without an interactive terminal refuses and moves nothing', () => {
        const r = cli(old, '--clean');
        assert.equal(r.status, 1);
        assert.match(r.stderr, /needs an interactive terminal/);
        assert.ok(exists(old, 'docs/handoff/SYSTEM.md') && exists(old, '.plutos/profile.json'));
    });

    test('--json is the full report, and the command exits 0', () => {
        const r = cli(old, '--json');
        assert.equal(r.status, 0, r.stderr);
        const report = JSON.parse(r.stdout);
        for (const key of ['root', 'project', 'auditedAt', 'verdict', 'why', 'counts', 'omittedCount', 'facts', 'sections', 'omitted']) assert.ok(key in report, key);
        assert.deepEqual(Object.keys(report.sections), AUDIT_SECTIONS);
        assert.ok(['clean', 'mixed', 'old'].includes(report.verdict));
        for (const f of all(report)) {
            assert.ok(['high', 'medium', 'low'].includes(f.severity), JSON.stringify(f));
            assert.ok(['repair', 'move', 'ai', 'owner'].includes(f.fix), JSON.stringify(f));
            assert.ok(typeof f.kind === 'string' && typeof f.path === 'string' && typeof f.message === 'string', JSON.stringify(f));
        }
        const text = cli(old);
        assert.equal(text.status, 0);
        assert.match(text.stdout.split('\n')[1], /^Verdict: /);
        assert.match(text.stdout, /What fixes what/);
    });

    test('the mover keeps relative paths in the Hub, moves only what it may, and refuses over an uncommitted change', () => {
        const root = kitProject('clean');
        write(root, 'docs/handoff/SYSTEM.md', '# SYSTEM\n');
        write(root, 'shared-skills/ponytail/SKILL.md', '# ponytail\n');
        write(root, 'shared-skills/mine/SKILL.md', '# my own skill\n');
        write(root, '.claude/skills/brainstorming/SKILL.md', '# brainstorming\n');
        write(root, '.plutos/install-manifest.json', JSON.stringify({ 'skill:brainstorming': [{ rel: '.claude/skills/brainstorming/SKILL.md', sha256: sha('# brainstorming\n') }] }));
        commit(root, 'leftovers');
        const home = path.join(tmp, 'hub');
        let report = auditProject(root);
        const by = p => report.sections.leftovers.find(f => f.path === p);
        assert.equal(by('shared-skills/')?.movable, false, 'an unrecorded folder is the owner\'s');
        assert.equal(by('.claude/skills/brainstorming/')?.movable, true, 'recorded and unedited');
        assert.equal(by('.plutos/install-manifest.json')?.movable, false, 'still lists a file');
        write(root, 'docs/handoff/SYSTEM.md', '# SYSTEM, edited\n');
        const refused = cleanLeftovers(root, report, { home, stamp: 'refused' });
        assert.match(refused.refused || '', /docs\/handoff\/SYSTEM\.md/);
        assert.ok(exists(root, 'docs/handoff/SYSTEM.md') && !fs.existsSync(path.join(home, 'audit-leftovers', 'clean', 'refused')));
        git(root, 'checkout', '--', 'docs/handoff/SYSTEM.md');
        report = auditProject(root);
        const done = cleanLeftovers(root, report, { home, stamp: 'stamp' });
        assert.equal(done.target, path.join(home, 'audit-leftovers', 'clean', 'stamp'));
        assert.deepEqual(done.moved.sort(), ['.claude/skills/brainstorming', '.plutos/install-manifest.json', 'docs/handoff/SYSTEM.md']);
        for (const p of done.moved) { assert.ok(!exists(root, p), `${p} still in the project`); assert.ok(fs.existsSync(path.join(done.target, p)), `${p} not in the Hub`); }
        assert.ok(exists(root, 'shared-skills/mine/SKILL.md'), 'the owner\'s folder stays');
        assert.equal(auditProject(root).sections.leftovers.filter(f => f.movable).length, 0);
    });
} finally {
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best effort */ }
}
console.log(`Audit: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
