#!/usr/bin/env node
// The project scope page (lib/scope.mjs): SCOPE.md read for the session brief, and the brief always carries a
// Scope line, so no AI starts a task without the project's scope state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readScope, scopeBriefLines, SCOPE_SKILL } from '../lib/scope.mjs';
import { buildBrief } from '../lib/continuity.mjs';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-scope-'));
const page = (body) => fs.writeFileSync(path.join(dir, 'SCOPE.md'), body);
const NOW = Date.parse('2026-11-05T12:00:00Z');
try {
    check('the skill ships with PLUT_OS', () => assert.ok(fs.existsSync(SCOPE_SKILL)));
    check('no SCOPE.md: the brief says PLAN first and names the skill', () => {
        assert.equal(readScope(dir), null);
        const text = scopeBriefLines(dir, NOW).join('\n');
        assert.match(text, /No `SCOPE\.md`: PLAN first/);
        assert.ok(text.includes(SCOPE_SKILL));
    });
    const example = `# SCOPE.md - Art Hub
Status: ACTIVE
Appetite: 7 days (start 2026-11-04, hard stop 2026-11-11)
Problem: lose track of models.
Architecture (approved 2026-11-04, change only with OK):
  Modules: UnityBridge, BlenderBridge, History, UI
Do not touch: Assets/Scenes/, *.meta
Later (parking lot — new ideas go here, not into code):
  - AI review of changes (parked 2026-11-04)
  - Batch export
Done means:
  [ ] Acceptance test passes
`;
    check('an active page: status, days left, an approved architecture and the parked ideas', () => {
        page(example);
        assert.deepEqual(readScope(dir), { status: 'ACTIVE', stop: '2026-11-11', architecture: true, parked: 2, queue: [] });
        const text = scopeBriefLines(dir, NOW).join('\n');
        assert.match(text, /Status ACTIVE · 7 day\(s\) of appetite left \(hard stop 2026-11-11\) · 2 idea\(s\) parked in Later/);
    });
    check('past the hard stop: the brief says CUT', () => {
        assert.match(scopeBriefLines(dir, Date.parse('2026-11-14T09:00:00Z')).join('\n'), /appetite passed 2 day\(s\) ago.*CUT, then SHIP, re-scope or ARCHIVE/);
    });
    check('a page without an approved Architecture: PLAN first', () => {
        page(example.replace('(approved 2026-11-04, change only with OK)', '(draft)'));
        assert.match(scopeBriefLines(dir, NOW).join('\n'), /no approved Architecture: PLAN first/);
    });
    check('the queue: the numbered In scope lines, the first named as next, with the count', () => {
        page(example.replace('Do not touch:', 'In scope (the queue):\n  1. Pull from Unity\n  2. Write back with the same settings\nDo not touch:'));
        assert.deepEqual(readScope(dir).queue, ['Pull from Unity', 'Write back with the same settings']);
        assert.match(scopeBriefLines(dir, NOW).join('\n'), /2 in the queue, next: Pull from Unity/);
    });
    check('nothing parked: the line leaves the count out', () => {
        page(example.replace(/Later \(parking lot[^]*?Done means:/, 'Later: IDEAS.md\nDone means:'));
        assert.doesNotMatch(scopeBriefLines(dir, NOW).join('\n'), /parked in Later/);
    });
    check("PLUT_OS's own page is planned and names its next job (the published core ships without it)", () => {
        // The working repository's SCOPE.md is its own queue and stays private on publish
        // (tools/publish-core.mjs PRIVATE), so a checkout without the page has nothing to judge.
        const root = path.resolve(path.dirname(SCOPE_SKILL), '..', '..');
        if (!fs.existsSync(path.join(root, 'SCOPE.md'))) return;
        const own = readScope(root);
        assert.ok(own && own.architecture && own.queue.length > 0, JSON.stringify(own));
    });
    check('the session brief carries the Scope section', () => {
        assert.match(buildBrief(dir, { ai: 'test' }), /## Scope\n`SCOPE\.md`: Status ACTIVE/);
    });
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`scope: ${passed} checks passed`);
