#!/usr/bin/env node
// The claims engine reports what a project's records name that the repository does not show, and
// a baseline lets old debt stand while a new finding fails `plutos check`. A scratch repository
// with planted findings; the planted personal address is built at run time.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findClaims, acceptClaims, checkClaimsAgainstBaseline } from '../lib/claims.mjs';
import { CRITIQUE_MENTION, contractFindings } from '../lib/contract-check.mjs';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(appRoot, 'cli.mjs');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-claims-'));
const write = (root, file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
const tokens = (root, check) => findClaims(root).filter(f => f.check === check).map(f => f.token).sort();
const run = (...args) => spawnSync(process.execPath, [cli, 'check', ...args], { encoding: 'utf8', env: { ...process.env, PLUTOS_HOME: path.join(scratch, 'home') } });
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log(`  ok  ${name}`); };

try {
    const root = path.join(scratch, 'project');
    write(root, 'package.json', JSON.stringify({ name: 'fixture', scripts: { test: 'node t.mjs' } }));
    write(root, 'lib/a.mjs', Array.from({ length: 10 }, (_, i) => `// line ${i + 1}`).join('\n') + '\n');
    write(root, '.gitignore', 'dist/\n');
    write(root, 'docs/x.md', [
        'The parser is `lib/a.mjs:5`, its end `lib/a.mjs:40`.',
        'It calls `lib/missing.mjs` for the rest.',
        'The old `lib/old.mjs` was removed in the spring.',
        'A kit project has `.plutos/local.json`; the studio has `modules/other/x.md`; a module is `lib/<name>.mjs`.',
        'See [the parser](../lib/a.mjs) and [the helper](../lib/nope.mjs).',
        'Run `npm run test`, not `npm run nope`. The build writes `dist/out.js`.',
    ].join('\n'));
    write(root, 'docs/snap.md', '<!-- plutos:snapshot -->\nOn that day `lib/gone.mjs` held it.\n');
    write(root, 'CHANGELOG.md', '- Removed nothing, named `lib/history.mjs`.\n');
    write(root, 'lib/contact.mjs', `export const owner = '${['jane', 'corp.io'].join('@')}';\nexport const rules = '@AGENTS.md';\n`);
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });

    check('a path, a link and a line citation that the repository does not hold are found', () => {
        assert.deepEqual(tokens(root, 'missing-path'), ['../lib/nope.mjs', 'lib/missing.mjs']);
        assert.deepEqual(tokens(root, 'line-past-end'), ['lib/a.mjs:40']);
    });
    check('an npm script package.json does not define is found', () => {
        assert.deepEqual(tokens(root, 'npm-script'), ['nope']);
    });
    check('kit paths, placeholders, another repository\'s paths, gone files and ignored output are not', () => {
        const named = findClaims(root).map(f => f.token).join(' ');
        for (const token of ['.plutos/local.json', 'modules/other/x.md', 'lib/<name>.mjs', 'lib/old.mjs', 'dist/out.js']) assert.ok(!named.includes(token), token);
    });
    check('history is not a current record: a snapshot document and CHANGELOG.md are left out', () => {
        const files = new Set(findClaims(root).map(f => f.file));
        assert.ok(!files.has('docs/snap.md') && !files.has('CHANGELOG.md'));
    });
    check('a personal address in a tracked file is a release finding; an import line is not', () => {
        const release = findClaims(root).filter(f => f.check === 'release');
        assert.deepEqual(release.map(f => `${f.file}:${f.line}`), ['lib/contact.mjs:1']);
    });
    check('the baseline accepts today\'s findings; a new one is fresh, a fixed one is counted', () => {
        assert.equal(checkClaimsAgainstBaseline(root).fresh.length, 5);
        acceptClaims(root, findClaims(root));
        assert.equal(checkClaimsAgainstBaseline(root).fresh.length, 0);
        fs.appendFileSync(path.join(root, 'docs/x.md'), '\nNow it also needs `lib/new.mjs`.\n');
        write(root, 'lib/missing.mjs', '');
        const result = checkClaimsAgainstBaseline(root);
        assert.deepEqual(result.fresh.map(f => f.token), ['lib/new.mjs']);
        assert.equal(result.fixed, 1);
        assert.ok(fs.existsSync(path.join(root, '.plutos', 'claims-baseline.json')), 'a project keeps its baseline in .plutos/');
    });
    check('a line added above a finding does not make it new', () => {
        const doc = path.join(root, 'docs/x.md');
        fs.writeFileSync(doc, 'A new first line.\n' + fs.readFileSync(doc, 'utf8'));
        assert.deepEqual(checkClaimsAgainstBaseline(root).fresh.map(f => f.token), ['lib/new.mjs']);
    });
    check('plutos check exits 1 on a fresh finding, 0 once it is accepted, and --json is JSON', () => {
        const fresh = run(root);
        assert.equal(fresh.status, 1, fresh.stdout + fresh.stderr);
        assert.match(fresh.stdout, /docs\/x\.md:\d+ {2}lib\/new\.mjs/);
        assert.equal(run(root, '--accept').status, 0);
        assert.equal(run(root).status, 0);
        assert.equal(JSON.parse(run(root, '--json').stdout).fresh.length, 0);
    });
    check('in PLUT_OS\'s own documents a suite count that is not the runner\'s is found; records and the past are not', () => {
        const source = path.join(scratch, 'plutos-source');
        write(source, 'package.json', JSON.stringify({ name: 'plut-os' }));
        write(source, 'index.mjs', '');
        write(source, 'lib/drawers.mjs', '');
        write(source, 'tools/run-all-tests.mjs', "const suites = ['smoke-test.mjs', 'tools/a-test.mjs'];\n");
        write(source, 'docs/ai/PROJECT_MAP.md', 'npm test runs 3 suites.\nEach of the 2 suites has a timeout.\nIt used to be 4 suites.\n');
        write(source, 'docs/handoff/BOARD.md', '### Claude · DONE · x\n- **Result / Output:** npm test: all 5 suites passed.\n');
        execFileSync('git', ['init', '-q'], { cwd: source });
        assert.deepEqual(tokens(source, 'count'), ['3 suites (runs 2)']);
        assert.deepEqual(tokens(root, 'count'), [], 'another project has no runner to count');
    });
    const other = path.join(scratch, 'weighed');
    write(other, 'AGENTS.md', '# rules\n');
    write(other, 'docs/handoff/BOARD.md', '# BOARD\n\n' + Array.from({ length: 12 }, (_, i) => `### Claude · TODO · task ${i + 1}\n- **Task:** t\n`).join('\n'));
    check('plutos check --weight lists each part against its limit and marks what is over', () => {
        const out = run(other, '--weight');
        assert.equal(out.status, 0, out.stderr);
        assert.match(out.stdout, /session brief\s+[\d,]+ characters of 10,000/);
        assert.match(out.stdout, /AGENTS\.md\s+8 bytes of 32,768/);
        assert.match(out.stdout, /^! BOARD\.md\s+12 active entries of 10$/m);
    });
    const { recordSession } = await import('../lib/continuity.mjs');
    check('plutos report labels what is verified and what is claimed, one next step per AI', () => {
        recordSession(other, { ai: 'Codex', headline: 'one', next: 'Codex next' });
        recordSession(other, { ai: 'Claude Code', headline: 'two', next: 'Old next' });
        recordSession(other, { ai: 'Claude Code', headline: 'three', next: 'New next' });
        const out = spawnSync(process.execPath, [cli, 'report', other], { encoding: 'utf8', env: { ...process.env, PLUTOS_HOME: path.join(scratch, 'home') } });
        assert.equal(out.status, 0, out.stderr);
        const next = out.stdout.split('## Next steps')[1] || '';
        assert.match(out.stdout, /## What happened \(assumption: /);
        assert.match(next, /New next/);
        assert.match(next, /Codex next/);
        assert.doesNotMatch(next, /Old next/, 'an AI\'s newer record supersedes its older one');
    });
    // The critique gate: a scratch PLUT_OS-shaped repository whose first commit carries the gate.
    const gate = path.join(scratch, 'gate');
    const sh = (...args) => execFileSync('git', args, { cwd: gate, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const commit = msg => { sh('add', '-A'); sh('commit', '-qm', msg); return sh('rev-parse', 'HEAD'); };
    const tool = description => ['const TOOLS = [', '  {', '    name: "board_read",', `    description: "${description}",`,
        '    inputSchema: { type: "object", properties: {}, required: [] },', '  },', '];', ''].join('\n');
    const block = (head, did) => `\n### 2026-11-04T12:00:00.000Z · Claude Code · a session\n- **Did:** ${did}\n- **Next:** the critique gate in plutos check\n- **HEAD:** ${head}\n`;
    write(gate, 'package.json', JSON.stringify({ name: 'plut-os' }));
    write(gate, 'index.mjs', tool('Reads a board.'));
    write(gate, 'lib/drawers.mjs', '');
    write(gate, 'lib/route-policy.mjs', "export const PROJECT_READ_ROUTES = new Set([\n    'GET /api/board',\n    'GET /api/state'\n]);\n");
    write(gate, 'lib/contract-check.mjs', '// the gate\n');
    // One unrelated session: the gate judges only a repository that keeps the session record.
    write(gate, 'docs/handoff/CONTINUITY.md', '# Continuity\n\n## Sessions\n' + block('0000000', 'set the project up'));
    execFileSync('git', ['init', '-q'], { cwd: gate });
    sh('config', 'user.email', 'test@example.invalid'); sh('config', 'user.name', 'test');
    const start = commit('the gate');
    const gateCheck = (...args) => spawnSync(process.execPath, [cli, 'check', gate, ...args], { encoding: 'utf8', env: { ...process.env, PLUTOS_HOME: path.join(scratch, 'home') } });
    let edit, removal;
    check('a published copy without any session record is not judged by the gate', () => {
        const pub = path.join(scratch, 'published');
        const psh = (...args) => execFileSync('git', args, { cwd: pub, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        write(pub, 'package.json', JSON.stringify({ name: 'plut-os' }));
        write(pub, 'index.mjs', tool('Reads a board.'));
        write(pub, 'lib/contract-check.mjs', '// the gate\n');
        write(pub, 'docs/handoff/CONTINUITY.md', '# Continuity\n\n## Sessions\n\n(no sessions recorded yet)\n');
        execFileSync('git', ['init', '-q'], { cwd: pub });
        psh('config', 'user.email', 'test@example.invalid'); psh('config', 'user.name', 'test');
        psh('add', '-A'); psh('commit', '-qm', 'the first public release');
        write(pub, 'index.mjs', tool('Reads a board, edited in a pull request.'));
        psh('add', '-A'); psh('commit', '-qm', 'a contract change');
        assert.deepEqual(contractFindings(pub), []);
    });
    check('a committed contract change with no critique-seat record is a finding: the file, the line, the commit and the hint', () => {
        write(gate, 'index.mjs', tool('Reads a board, edited.'));
        edit = commit('edit board_read');
        const found = contractFindings(gate);
        assert.deepEqual(found.map(f => [f.check, f.file, f.line, f.token]), [['contract-unreviewed', 'index.mjs', 4, edit.slice(0, 7)]]);
        assert.match(found[0].text, /run a critique seat on the diff/);
        assert.ok(found[0].text.includes(`index.mjs at ${edit.slice(0, 7)}`), found[0].text);
    });
    check('a comment in the same file is not one; a removed route is', () => {
        write(gate, 'index.mjs', '// a comment above the tools\n' + tool('Reads a board, edited.'));
        commit('a comment');
        assert.deepEqual(contractFindings(gate).map(f => f.token), [edit.slice(0, 7)]);
        write(gate, 'lib/route-policy.mjs', "export const PROJECT_READ_ROUTES = new Set([\n    'GET /api/board'\n]);\n");
        removal = commit('drop a route');
        assert.deepEqual(contractFindings(gate).map(f => `${f.file}@${f.token}`), [`index.mjs@${edit.slice(0, 7)}`, `lib/route-policy.mjs@${removal.slice(0, 7)}`]);
    });
    check('plutos check exits 1 on it and prints the hint; --accept keys it per commit', () => {
        const out = gateCheck();
        assert.equal(out.status, 1, out.stdout + out.stderr);
        assert.match(out.stdout, /contract-unreviewed: 2\n {2}index\.mjs:\d+ {2}a contract line changed in index\.mjs at [0-9a-f]{7}; run a critique seat/);
        assert.equal(gateCheck('--accept').status, 0);
        const accepted = JSON.parse(fs.readFileSync(path.join(gate, 'tools', 'claims-baseline.json'), 'utf8')).accepted;
        assert.ok(accepted.includes(`contract-unreviewed|index.mjs|${edit.slice(0, 7)}`), accepted.join(' '));
        assert.equal(gateCheck().status, 0);
        fs.rmSync(path.join(gate, 'tools'), { recursive: true });
    });
    check('a critique mention needs the seat, a lead-in, a count and what it found; a plan is not one', () => {
        for (const t of ['A critique seat found 17 items; the four that mattered', 'Critique seat: 21 items; the ones that changed the build', 'The critique seat found three blockers first (liveness',
            'with a critique seat (24 findings; the plan was stale', 'A critique seat ran in parallel and found 17 items', 'Critique seat first: four blockers folded in.']) assert.match(t, CRITIQUE_MENTION);
        for (const t of ['the critique gate in plutos check (no critique-seat result in the record is reported)', 'Critique office', 'The critique seat first: the stamp takes precedence', 'A critique seat found nothing']) assert.doesNotMatch(t, CRITIQUE_MENTION);
    });
    check('a block whose HEAD is the commit\'s parent and whose Did names the seat with its count covers it, from the archive too; a plan does not', () => {
        fs.appendFileSync(path.join(gate, 'docs/handoff/CONTINUITY.md'), block(start, 'Planned the critique gate in plutos check.'));
        assert.equal(contractFindings(gate).length, 2, 'a plan covers nothing');
        write(gate, 'docs/handoff/archive/SESSIONS-2026-11.md', '# Session archive\n' + block(start, 'Edited board_read. A critique seat found 3 items; none blocked.'));
        assert.deepEqual(contractFindings(gate).map(f => f.token), [removal.slice(0, 7)]);
    });
    check('a later block covers an earlier commit when its Did names the seat, its count and the sha', () => {
        fs.appendFileSync(path.join(gate, 'docs/handoff/CONTINUITY.md'), block(edit, `Dropped a route at ${removal.slice(0, 7)}. Critique seat: 2 items, both folded in.`));
        assert.deepEqual(contractFindings(gate), []);
    });
    check('the working tree is a note, never a finding, until a block with the current HEAD names a seat', () => {
        write(gate, 'index.mjs', tool('Reads a board, edited again.'));
        const before = checkClaimsAgainstBaseline(gate);
        assert.deepEqual(before.fresh, []);
        assert.match(before.notes.join('\n'), /index\.mjs:\d+.*next commit/);
        assert.match(gateCheck().stdout, /^note: contract lines changed in the working tree/m);
        fs.appendFileSync(path.join(gate, 'docs/handoff/CONTINUITY.md'), block(sh('rev-parse', 'HEAD'), 'Edited again; a critique seat found 1 item.'));
        assert.deepEqual(checkClaimsAgainstBaseline(gate).notes, []);
    });
    check('no gate commit, a detached HEAD or no commit at all gives nothing', () => {
        const source = path.join(scratch, 'plutos-source');
        execFileSync('git', ['add', '-A'], { cwd: source });
        execFileSync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=test', 'commit', '-qm', 'source'], { cwd: source });
        assert.deepEqual(contractFindings(source), [], 'the gate was never committed here');
        sh('checkout', '-q', '--detach');
        try { assert.deepEqual(contractFindings(gate), []); } finally { sh('checkout', '-q', '-'); }
        assert.deepEqual(contractFindings(root), [], 'no commit');
    });
    check('PLUT_OS\'s own records hold no finding beyond its baseline', () => {
        const { fresh } = checkClaimsAgainstBaseline(appRoot);
        assert.deepEqual(fresh.map(f => `${f.check} ${f.file}:${f.line} ${f.token}`), [],
            'fix each, or accept it with "node cli.mjs check --accept" and say why in the commit');
    });
    console.log(`${checks} claims checks passed`);
} finally {
    fs.rmSync(scratch, { recursive: true, force: true });
}
