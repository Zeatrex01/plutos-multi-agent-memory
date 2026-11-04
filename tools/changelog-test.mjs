#!/usr/bin/env node
// plutos changelog and plutos idea add one line to a long log without reading it: the line lands under
// ## [Unreleased] in the right section, a missing section or heading is created in order, and the
// commands work from a terminal on a scratch project.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyChangelogEntry } from '../lib/changelog.mjs';

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-changelog-'));
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log(`  ok  ${name}`); };
const log = ['# Changelog', '', '## [Unreleased]', '', '### Added', '- old feature', '', '### Fixed', '- old fix', '', '## [0.1.0] — 2026-01-01', '', '### Added', '- first', ''].join('\n');

try {
    check('an entry becomes the first bullet of its section under Unreleased', () => {
        const out = applyChangelogEntry(log, 'Fixed', 'the new fix');
        assert.match(out, /### Fixed\n- the new fix\n- old fix/);
        assert.equal(out.match(/the new fix/g).length, 1);
        assert.ok(out.indexOf('the new fix') < out.indexOf('## [0.1.0]'));
    });
    check('a missing section is created in Keep a Changelog order', () => {
        const out = applyChangelogEntry(log, 'Changed', 'a change');
        assert.ok(out.indexOf('### Changed') > out.indexOf('- old feature') && out.indexOf('### Changed') < out.indexOf('### Fixed'), out);
        const security = applyChangelogEntry(log, 'Security', 'a patch');
        assert.ok(security.indexOf('### Security') > security.indexOf('- old fix') && security.indexOf('### Security') < security.indexOf('## [0.1.0]'));
    });
    check('a changelog without Unreleased gets one above the first release; bad input is refused', () => {
        const out = applyChangelogEntry('# Changelog\n\n## [0.1.0]\n- first\n', 'Added', 'x');
        assert.match(out, /## \[Unreleased\]\n\n### Added\n- x\n\n## \[0\.1\.0\]/);
        assert.throws(() => applyChangelogEntry(log, 'Misc', 'x'), /section must be one of/);
        assert.throws(() => applyChangelogEntry(log, 'Added', '  '), /required/);
    });
    check('plutos changelog and plutos idea write a scratch project from a terminal', () => {
        const project = path.join(scratch, 'p');
        fs.mkdirSync(project);
        fs.writeFileSync(path.join(project, 'CHANGELOG.md'), log);
        const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--project', project], { encoding: 'utf8', env: { ...process.env, PLUTOS_HOME: path.join(scratch, 'home') } });
        const added = run('changelog', 'Added', 'from', 'the', 'terminal');
        assert.equal(added.status, 0, added.stderr);
        assert.match(fs.readFileSync(path.join(project, 'CHANGELOG.md'), 'utf8'), /### Added\n- from the terminal\n- old feature/);
        assert.notEqual(run('changelog', 'Misc', 'x').status, 0);
        assert.equal(run('idea', 'a', 'new', 'idea').status, 0);
        assert.match(fs.readFileSync(path.join(project, 'IDEAS.md'), 'utf8'), /- a new idea/);
        assert.match(run('idea', 'a', 'new', 'idea').stdout, /Already in/);
    });
    console.log(`${checks} changelog checks passed`);
} finally {
    fs.rmSync(scratch, { recursive: true, force: true });
}
