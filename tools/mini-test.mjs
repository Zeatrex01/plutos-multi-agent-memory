#!/usr/bin/env node
// PLUT_OS mini (mini/, tools/pack-mini.mjs): packed standalone, it runs outside this repository, and what it writes
// is read back by the full PLUT_OS's own parsers, so a project can move between the two without losing a record.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { packMini } from './pack-mini.mjs';
import { parseContinuity, buildBrief } from '../lib/continuity.mjs';
import { parseBoardEntries } from '../lib/board.mjs';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-mini-'));
try {
    const { dest } = packMini(path.join(tmp, 'out'), { zip: false });
    const project = path.join(tmp, 'My Game');
    fs.mkdirSync(project);
    const run = (script, ...a) => spawnSync(process.execPath, [script, ...a], { cwd: tmp, encoding: 'utf8', timeout: 30_000 });
    const packed = path.join(dest, 'skills', 'plutos-mini', 'scripts', 'plutos-mini.mjs');
    check('the packed script runs outside the repository and prints its usage', () => {
        const r = run(packed, '--help');
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /init \[project\]/);
    });
    check('init writes the handoff files, copies both skills and adds one SessionStart hook', () => {
        assert.equal(run(packed, 'init', project).status, 0);
        assert.equal(run(packed, 'init', project).status, 0);   // twice: still one hook
        for (const f of ['docs/handoff/BOARD.md', 'docs/handoff/CONTINUITY.md', '.claude/skills/plutos-mini/scripts/scope.mjs', '.claude/skills/project-scissors/SKILL.md']) {
            assert.ok(fs.existsSync(path.join(project, f)), f);
        }
        const hooks = JSON.parse(fs.readFileSync(path.join(project, '.claude', 'settings.local.json'), 'utf8')).hooks.SessionStart;
        assert.equal(hooks.length, 1);
        assert.match(hooks[0].hooks[0].command, /plutos-mini\.mjs brief/);
    });
    const local = path.join(project, '.claude', 'skills', 'plutos-mini', 'scripts', 'plutos-mini.mjs');
    check('the brief from the project copy: scope line, the working agreement and how to finish', () => {
        const r = run(local, 'brief', project);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /## Scope\nNo `SCOPE\.md`: PLAN first/);
        assert.ok(r.stdout.includes('`.claude/skills/project-scissors/SKILL.md`'), 'the skill, named relative to the project');
        assert.match(r.stdout, /WORKING AGREEMENT/);
        assert.match(r.stdout, /3\. Scope before features/);
        assert.match(r.stdout, /Finish with: node .*plutos-mini\.mjs end/);
    });
    check('board entries are the full PLUT_OS board format', () => {
        assert.equal(run(local, 'board', 'start', '--ai', 'claude', '--title', 'Woodpiles', '--task', 'place two by the road', '--project', project).status, 0);
        assert.equal(run(local, 'board', 'done', '--ai', 'claude', '--title', 'Woodpiles', '--result', 'core/terrain.gd', '--project', project).status, 0);
        const entries = parseBoardEntries(fs.readFileSync(path.join(project, 'docs', 'handoff', 'BOARD.md'), 'utf8'));
        assert.equal(entries.length, 1);
        assert.equal(entries[0].status, 'DONE');
        assert.equal(entries[0].fields['Result / Output'], 'core/terrain.gd');
    });
    check('sessions and decisions are the full PLUT_OS continuity format; old sessions archive after five', () => {
        for (let k = 1; k <= 7; k++) {
            const r = run(local, 'end', '--ai', 'claude', '--headline', `session ${k}`, '--did', 'work', '--decided', k === 1 ? 'wood opens with the first second step; PC first' : '', '--next', `step ${k + 1}`, '--story', 'Oturum bitti.', '--project', project);
            assert.equal(r.status, 0, r.stderr);
        }
        const parsed = parseContinuity(fs.readFileSync(path.join(project, 'docs', 'handoff', 'CONTINUITY.md'), 'utf8'));
        assert.equal(parsed.sessions.length, 5);
        assert.equal(parsed.sessions.at(-1).headline, 'session 7');
        assert.ok(parsed.digest.some(l => /DECISION: PC first/.test(l)));
        const archive = fs.readdirSync(path.join(project, 'docs', 'handoff', 'archive'));
        assert.equal(archive.length, 1);
    });
    check('the full PLUT_OS brief reads the same project', () => {
        const full = buildBrief(project, { ai: 'test' });
        assert.match(full, /session 7/);
        const mini = run(local, 'brief', project).stdout;
        assert.match(mini, /session 7 — next: step 8/);
        assert.match(mini, /DECISION: PC first/);
    });
    check('a missing field is refused with a clear message', () => {
        const r = run(local, 'end', '--ai', 'claude', '--project', project);
        assert.equal(r.status, 2);
        assert.match(r.stderr, /needs --ai and --headline/);
    });
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`mini: ${passed} checks passed`);
