#!/usr/bin/env node
// Memory v1, part 1 (canonical architecture 2026-11-03 §6, research §4): decisions as records with a
// derived status, the cap that archives instead of dropping, the memory verbs, `plutos check --memory`
// and the digest migration. Temp projects only; the one read of this repository is the check's exit 0.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-memory-'));
process.env.PLUTOS_HOME = path.join(tmp, 'hub');
const { recordContextClaims, recordDecisions, normalizeLearned, normalizeDecided, assessContext, ageOutClaims, CONTEXT_LIMITS, contextPathFor, readRegistry } = await import('../lib/context.mjs');
const { recordSession, buildBrief, parseContinuity, continuityPathFor, digestText, digestId } = await import('../lib/continuity.mjs');
const { listMemory, openMemory, verifyMemory, supersedeMemory, retireMemory, memoryCheck, renderMemoryCheck, migrateDigestDecisions, nearDuplicates } = await import('../lib/memory.mjs');
const { hygieneReport, BUDGETS, commitsSinceDocChanged } = await import('../lib/hygiene.mjs');
const { findClaims } = await import('../lib/claims.mjs');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };
const project = (name) => { const root = path.join(tmp, name); fs.mkdirSync(path.join(root, 'docs', 'handoff'), { recursive: true }); return root; };
const write = (root, file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
const registry = root => JSON.parse(fs.readFileSync(contextPathFor(root), 'utf8'));
const archiveLines = root => {
    const dir = path.join(root, 'docs', 'handoff', 'archive');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => /^CONTEXT-.*\.jsonl$/.test(f)).flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)));
};
const kinds = report => new Set(report.findings.map(f => f.kind));
const cli = (cwd, ...args) => spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), ...args], { cwd, encoding: 'utf8', env: { ...process.env, PLUTOS_HOME: path.join(tmp, 'hub') } });
const kit = root => { write(root, 'AGENTS.md', '<!-- plutos:kit -->\n# rules\n'); write(root, '.plutos/plutos-launch.mjs', '// launcher\n'); };

try {
    // A. the cap archives, never drops.
    check('the 81st claim sends the oldest unverified one to the archive with reason cap', () => {
        const root = project('cap');
        write(root, 'src/a.txt', 'PORT = 3000\n');
        recordContextClaims(root, normalizeLearned([{ claim: 'The port is 3000.', sources: [{ path: 'src/a.txt', evidence: 'PORT = 3000' }] }]), { ai: 'test' });
        recordContextClaims(root, normalizeLearned(Array.from({ length: 79 }, (_, i) => `Unverified note number ${i + 1}.`)), { ai: 'test' });
        assert.equal(registry(root).claims.length, 80);
        const r = recordContextClaims(root, normalizeLearned(['Unverified note number 80.']), { ai: 'test' });
        assert.equal(r.archived, 1);
        assert.equal(registry(root).claims.length, CONTEXT_LIMITS.claims);
        const gone = archiveLines(root);
        assert.equal(gone.length, 1);
        assert.equal(gone[0].claim, 'Unverified note number 1.');
        assert.equal(gone[0].reason, 'cap');
        assert.ok(registry(root).claims.some(c => c.claim === 'The port is 3000.'), 'the source-backed claim stays');
    });

    // B. decisions as records.
    const decRoot = project('decisions');
    write(decRoot, 'src/limits.js', 'MAX_UPLOAD_MB = 20\n');
    let first, second, sourced;
    check('a decision from session_end gets a d- id, status valid, and the digest line carries the id', () => {
        const r = recordSession(decRoot, { ai: 'Claude', headline: 'chose', decided: ['Use Stripe, not Paddle: existing merchant account.'] });
        assert.equal(r.context.decisions, 1);
        const reg = registry(decRoot);
        assert.equal(reg.decisions.length, 1);
        first = reg.decisions[0];
        assert.match(first.id, /^d-[0-9a-f]{12}$/);
        assert.equal(first.text, 'Use Stripe, not Paddle: existing merchant account.');
        const digest = parseContinuity(fs.readFileSync(continuityPathFor(decRoot), 'utf8')).digest;
        assert.equal(digestId(digest[0]), first.id);
        assert.equal(digestText(digest[0]), 'DECISION: Use Stripe, not Paddle: existing merchant account.');
        assert.equal(assessContext(decRoot).decisions.valid[0].status, 'valid');
    });
    check('session_end accepts the object form; supersedes reverses the old decision and the new one is valid', () => {
        const r = recordSession(decRoot, { ai: 'Claude', headline: 'changed', decided: [{ decision: 'Use Paddle after all: Stripe refused the account.', supersedes: first.id }] });
        assert.equal(r.context.reversed, 1);
        const ctx = assessContext(decRoot);
        assert.deepEqual(ctx.decisions.reversed.map(d => d.id), [first.id]);
        assert.deepEqual(ctx.decisions.reversed[0].reversedBy.length, 1);
        second = ctx.decisions.valid[0];
        assert.equal(second.supersedes, first.id);
        assert.equal(second.status, 'valid');
        assert.equal(registry(decRoot).decisions.length, 2, 'the old record stays in place');
    });
    check('a decision with a matching source is verified; a repeated text is not recorded twice', () => {
        const r = recordDecisions(decRoot, normalizeDecided([{ decision: 'Uploads stay at 20 MB.', sources: [{ path: 'src/limits.js', evidence: 'MAX_UPLOAD_MB = 20' }] }]), { ai: 'test' });
        assert.equal(r.added, 1);
        sourced = assessContext(decRoot).decisions.verified[0];
        assert.equal(sourced.text, 'Uploads stay at 20 MB.');
        assert.equal(recordDecisions(decRoot, normalizeDecided(['uploads stay at 20 mb.']), { ai: 'test' }).repeated, 1);
        assert.equal(registry(decRoot).decisions.length, 3);
    });
    check('the brief lists the standing decisions newest first, hides the reversed one and counts them', () => {
        const brief = buildBrief(decRoot, { ai: 'Codex' });
        assert.match(brief, /Uploads stay at 20 MB\. \(d-/);
        assert.match(brief, /Use Paddle after all/);
        assert.ok(!/⚖️ Use Stripe/.test(brief), 'the reversed decision is not listed');
        assert.match(brief, /3 decision\(s\) \(1 reversed\)/);
        assert.match(buildBrief(decRoot, { ai: 'Codex', full: true }), /\*\*Decided:\*\* Use Paddle after all/);
    });
    check('a fresh project\'s brief says nothing about decisions', () => {
        const fresh = project('fresh');
        const brief = buildBrief(fresh, { ai: 'Codex' });
        assert.ok(!/Settled decisions|decision\(s\)|plutos memory/.test(brief), brief);
    });
    check('a supersedes id that is not recorded is reported, not applied', () => {
        const r = recordSession(decRoot, { ai: 'Claude', headline: 'typo', decided: [{ decision: 'Nothing to reverse here.', supersedes: 'd-000000000000' }] });
        assert.deepEqual(r.context.supersedeMissed, ['d-000000000000']);
        assert.throws(() => normalizeDecided([{ decision: 'x', supersedes: 'not-an-id' }]), /decision id/);
    });

    // Hidden Unicode.
    check('zero-width and bidirectional characters are refused in learned and decided, and by the registry writer', () => {
        assert.throws(() => normalizeLearned(['Looks fine\u200B but is not.']), /hidden character/);
        assert.throws(() => normalizeLearned([{ claim: 'ok', sources: [{ path: 'src/a.txt', evidence: 'x\u202Ey' }] }]), /hidden character/);
        assert.throws(() => normalizeDecided(['\u2066reversed\u2069']), /hidden character/);
        assert.throws(() => recordContextClaims(decRoot, [{ claim: 'raw\uFEFFwrite', sources: [], origin: 'test' }], { ai: 'test' }), /hidden character/);
        assert.throws(() => recordDecisions(decRoot, [{ text: 'raw\u200Dwrite', sources: [] }], { ai: 'test' }), /hidden character/);
        assert.throws(() => recordSession(decRoot, { ai: 'Claude', headline: 'bad', decided: ['a\u200Cb'] }), /hidden character/);
    });

    // C. the verbs.
    check('memory list filters by type and status; open shows the card with its links', () => {
        const all = listMemory(decRoot);
        assert.equal(all.records.filter(r => r.type === 'decision').length, 4);
        assert.deepEqual(listMemory(decRoot, { status: 'reversed' }).records.map(r => r.id), [first.id]);
        assert.equal(listMemory(decRoot, { type: 'decision', status: 'verified' }).records[0].id, sourced.id);
        assert.throws(() => listMemory(decRoot, { type: 'lesson' }), /--type/);
        const card = openMemory(decRoot, second.id);
        assert.equal(card.supersedes, first.id);
        assert.equal(openMemory(decRoot, first.id).reversedBy[0], second.id);
        assert.equal(openMemory(decRoot, 'd-ffffffffffff'), null);
    });
    check('memory verify re-snapshots when the excerpt is still there and refuses when it is not', () => {
        const ok = verifyMemory(decRoot, sourced.id, { by: 'tester' });
        assert.equal(ok.verified, true);
        assert.equal(registry(decRoot).decisions.find(d => d.id === sourced.id).lastSeenBy, 'tester');
        fs.writeFileSync(path.join(decRoot, 'src/limits.js'), 'MAX_UPLOAD_MB = 50\n');
        const before = JSON.stringify(registry(decRoot));
        const no = verifyMemory(decRoot, sourced.id);
        assert.equal(no.verified, false);
        assert.match(no.failed[0], /src\/limits\.js/);
        assert.equal(JSON.stringify(registry(decRoot)), before, 'nothing changed');
        assert.equal(assessContext(decRoot).decisions.valid.some(d => d.id === sourced.id), true, 'a decision whose evidence moved is valid, with the reason');
        assert.equal(verifyMemory(decRoot, first.id).failed[0], 'the record cites no source; nothing to verify');
    });
    let third;
    check('memory supersede records the chain and the digest line; a reversed decision cannot be superseded again', () => {
        third = supersedeMemory(decRoot, second.id, 'Back to Stripe: the account was approved.', { by: 'owner' });
        assert.equal(third.oldId, second.id);
        const ctx = assessContext(decRoot);
        assert.ok(ctx.decisions.reversed.some(d => d.id === second.id));
        assert.ok(parseContinuity(fs.readFileSync(continuityPathFor(decRoot), 'utf8')).digest.some(l => digestId(l) === third.id));
        assert.throws(() => supersedeMemory(decRoot, first.id, 'Again.'), /already reversed/);
        assert.throws(() => supersedeMemory(decRoot, third.id, 'Back to Stripe: the account was approved.'), /already recorded/);
    });
    check('memory retire archives the record with the reason', () => {
        const r = retireMemory(decRoot, sourced.id, 'the limit moved to 50 MB');
        assert.equal(r.type, 'decision');
        assert.ok(!registry(decRoot).decisions.some(d => d.id === sourced.id));
        const gone = archiveLines(decRoot).find(l => l.id === sourced.id);
        assert.equal(gone.reason, 'retired: the limit moved to 50 MB');
        assert.throws(() => retireMemory(decRoot, sourced.id, 'again'), /No record/);
    });

    // D. the check, one finding of each kind on one temp project.
    check('near-duplicate texts are found with Turkish ı/İ folded', () => {
        const pairs = nearDuplicates([{ id: 'a', text: 'Işık the dashboard listens on 127.0.0.1 only' }, { id: 'b', text: 'IŞIK the dashboard listens on 127.0.0.1 only.' }, { id: 'c', text: 'Something else entirely about the board' }]);
        assert.equal(pairs.length, 1);
        assert.deepEqual([pairs[0].a, pairs[0].b], ['a', 'b']);
    });
    check('check --memory reports every finding kind and exits 0', () => {
        const root = project('check');
        kit(root);
        write(root, 'src/a.txt', 'PORT = 3000\n');
        recordContextClaims(root, normalizeLearned([{ claim: 'The port is 3000.', sources: [{ path: 'src/a.txt', evidence: 'PORT = 3000' }] }]), { ai: 'test' });
        recordContextClaims(root, normalizeLearned(Array.from({ length: 77 }, (_, i) => `Unverified note number ${i + 1}.`)), { ai: 'test' });
        recordContextClaims(root, normalizeLearned(['Unverified note number 1']), { ai: 'test' });   // near-duplicate of number 1.
        fs.writeFileSync(path.join(root, 'src/a.txt'), 'PORT = 4000\n');                          // anchor
        ageOutClaims(root);                                                                      // marks quarantinedAt
        const a = recordDecisions(root, normalizeDecided(['First ruling.']), { ai: 'test' }).ids[0];
        const b = recordDecisions(root, normalizeDecided([{ decision: 'Second ruling.', supersedes: a }]), { ai: 'test' }).ids[0];
        recordDecisions(root, normalizeDecided([{ decision: 'Third ruling.', supersedes: b }]), { ai: 'test' });  // chain of 3
        recordSession(root, { ai: 'Claude', headline: 'x' });
        fs.writeFileSync(continuityPathFor(root), fs.readFileSync(continuityPathFor(root), 'utf8').replace('## Digest — settled decisions\n', '## Digest — settled decisions\n- DECISION: An old line without a record.\n'));
        const reg = registry(root);
        reg.claims.push({ ...reg.claims[1] });                                                   // duplicate id
        reg.claims[2] = { ...reg.claims[2], capturedAt: '2026-01-01T00:00:00.000Z' };               // unverified for 30 days
        reg.claims[3] = { ...reg.claims[3], claim: 'hidden\u200Bcharacter' };                       // hidden unicode past the writer
        fs.writeFileSync(contextPathFor(root), JSON.stringify(reg, null, 2) + '\n');
        const later = new Date(Date.now() + 15 * 864e5);
        const report = memoryCheck(root, { now: later });
        for (const kind of ['anchor', 'duplicate-id', 'near-duplicate', 'chain', 'unverified-30d', 'ageing', 'cap', 'hidden-unicode', 'digest']) {
            assert.ok(kinds(report).has(kind), `${kind} missing in:\n${renderMemoryCheck(report)}`);
        }
        assert.match(report.summary, /A report, not a gate/);
        const run = cli(root, 'check', '--memory');
        assert.equal(run.status, 0, run.stderr);
        assert.match(run.stdout, /^Summary: /m);
    });
    check('check --memory on this repository exits 0 and prints a summary', () => {
        const run = cli(ROOT, 'check', ROOT, '--memory');
        assert.equal(run.status, 0, run.stderr);
        assert.match(run.stdout, /^Summary: /m);
    });

    // The migration.
    check('the digest migration dates records from the session, links lines, and is idempotent', () => {
        const root = project('migrate');
        kit(root);
        execFileSync('git', ['init', '-q'], { cwd: root });
        recordSession(root, { ai: 'Gemini', headline: 'old session', decided: ['Keep the port at 3000.'] });
        // Pre-2026-11-04 records carried no ids: strip them to get the legacy shape, and add a line no session names.
        let text = fs.readFileSync(continuityPathFor(root), 'utf8').replace(/ \(d-[0-9a-f]{12}\)/g, '');
        text = text.replace('## Digest — settled decisions\n', '## Digest — settled decisions\n- DECISION: A ruling without a session.\n');
        fs.writeFileSync(continuityPathFor(root), text);
        fs.writeFileSync(contextPathFor(root), JSON.stringify({ version: 1, updatedAt: null, claims: [] }, null, 2) + '\n');
        const first = migrateDigestDecisions(root);
        assert.equal(first.migrated, 2);
        assert.deepEqual(first.dated, { session: 1, git: 0, none: 1 });
        const reg = registry(root);
        const dated = reg.decisions.find(d => d.text === 'Keep the port at 3000.');
        assert.equal(dated.capturedBy, 'Gemini');
        assert.ok(dated.capturedAt);
        assert.equal(reg.decisions.find(d => d.text === 'A ruling without a session.').capturedAt, null);
        assert.ok(reg.decisions.every(d => d.origin === 'digest' && Number.isInteger(d.digestIndex)));
        const digest = parseContinuity(fs.readFileSync(continuityPathFor(root), 'utf8')).digest;
        assert.ok(digest.every(l => digestId(l)));
        const again = migrateDigestDecisions(root);
        assert.equal(again.migrated, 0);
        assert.equal(registry(root).decisions.length, 2);
        assert.ok(!kinds(memoryCheck(root)).has('digest'));
    });
    check('verify, supersede, retire and --apply need an interactive terminal; list and open do not', () => {
        kit(decRoot);
        for (const args of [['memory', 'retire', 'd-000000000000', 'why'], ['memory', 'supersede', 'd-000000000000', 'x'], ['memory', 'verify', 'd-000000000000'], ['check', '--memory', '--apply']]) {
            const run = cli(decRoot, ...args);
            assert.equal(run.status, 1, args.join(' '));
            assert.match(run.stderr, /interactive terminal/);
        }
        const list = cli(decRoot, 'memory', 'list', '--type', 'decision', '--status', 'reversed');
        assert.equal(list.status, 0, list.stderr);
        assert.match(list.stdout, /reversed/);
        assert.match(cli(decRoot, 'memory', 'open', first.id).stdout, /reversed by/);
    });

    // A3. the code-index staleness alarm.
    check('a code index rescanned after many commits is not called stale (the commit count alone would say so)', () => {
        const root = path.join(tmp, 'codeindex');
        fs.mkdirSync(path.join(root, 'docs', 'ai'), { recursive: true });
        const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
        git('init', '-q');
        git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'test');
        write(root, 'src/app.js', 'export const a = 1;\n');
        write(root, 'docs/ai/CODEINDEX.md', '# CODEINDEX\n[src/app.js] a\n');
        git('add', '-A'); git('commit', '-q', '-m', 'index');
        for (let i = 0; i < BUDGETS.docCommitsBehind + 2; i++) {
            write(root, 'notes.txt', `note ${i}\n`);
            git('add', '-A'); git('commit', '-q', '-m', `note ${i}`);
        }
        const past = new Date(Date.now() - 3600e3);
        fs.utimesSync(path.join(root, 'src', 'app.js'), past, past);
        write(root, 'docs/ai/CODEINDEX.md', '# CODEINDEX\n[src/app.js] a (rescanned)\n');   // a rescan, not committed
        assert.ok(commitsSinceDocChanged(root, 'docs/ai/CODEINDEX.md').commitsBehind > BUDGETS.docCommitsBehind, 'the count alone is over budget: this was the alarm');
        const tracked = hygieneReport(root).docs.find(d => d.name === 'CODEINDEX.md');
        assert.deepEqual(tracked.warnings, [], JSON.stringify(tracked));
        write(root, '.gitignore', 'docs/ai/CODEINDEX.md\n');
        const ignored = hygieneReport(root).docs.find(d => d.name === 'CODEINDEX.md');
        assert.deepEqual(ignored.warnings, [], JSON.stringify(ignored));
        assert.equal(ignored.commitsBehind, null, 'an ignored index has no commit count');
        write(root, 'src/app.js', 'export const a = 2;\n');
        assert.match(hygieneReport(root).docs.find(d => d.name === 'CODEINDEX.md').warnings[0].message, /source files changed after the last scan/);
    });

    // A4. docs/handoff citations are checked.
    check('a cited docs/handoff report must exist; the kit\'s optional files and dated archives are not findings', () => {
        const root = project('cites');
        write(root, 'docs/handoff/results/real.md', '# real\n');
        write(root, 'docs/x.md', 'See `docs/handoff/results/real.md` and `docs/handoff/results/missing.md`; the kit may write `docs/handoff/PROJECT_INTERVIEW.md` and `docs/handoff/PLUTOS_PROTOCOL.md`; archives are `docs/handoff/archive/SESSIONS-YYYY-MM.md` and `docs/handoff/archive/BOARD-2026-01.md`.\n');
        execFileSync('git', ['init', '-q'], { cwd: root });
        assert.deepEqual(findClaims(root).filter(f => f.check === 'missing-path').map(f => f.token), ['docs/handoff/results/missing.md']);
    });
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`memory-test: ${passed} checks passed`);
