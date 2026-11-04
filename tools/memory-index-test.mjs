#!/usr/bin/env node
// Memory v1, part 2 (canonical architecture 2026-11-03 §6, research §4): the index in
// .plutos/memory.db, `memory find` in English and Turkish, the floor, the cold archive, the manifest
// rebuild, the scan fallback, the Memory card in plutos_context_for_task, and the Shown field. Temp
// projects only; the one read of this repository is a find that must not throw.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-memory-index-'));
process.env.PLUTOS_HOME = path.join(tmp, 'hub');
const { recordContextClaims, recordDecisions, normalizeLearned, normalizeDecided, archiveRecords, contextPathFor } = await import('../lib/context.mjs');
const { recordSession, parseContinuity, continuityPathFor, shownField } = await import('../lib/continuity.mjs');
const { findMemory, renderFind, queryTerms, idsShownIn, memoryCheck, FIND_FLOOR, informativeLimit, shownHistory } = await import('../lib/memory.mjs');
const { ensureIndex, openIndex, collectRecords, scanRecords, indexPathFor, matchExpression, checkIndex, INDEX_SCHEMA } = await import('../lib/memory-index.mjs');
const { taskContext, resetTaskContextCache } = await import('../lib/task-context.mjs');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };
const write = (root, file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
const cli = (cwd, ...args) => spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), ...args], { cwd, encoding: 'utf8', env: { ...process.env, PLUTOS_HOME: path.join(tmp, 'hub') } });

try {
    // The fixture: 2 claims, 3 decisions (one superseded), 2 sessions, 1 archived record.
    const root = path.join(tmp, 'fixture');
    fs.mkdirSync(path.join(root, 'docs', 'handoff'), { recursive: true });
    write(root, 'AGENTS.md', '<!-- plutos:kit -->\n# rules\n');
    write(root, '.plutos/plutos-launch.mjs', '// launcher\n');
    write(root, 'src/limits.js', 'MAX_UPLOAD_MB = 20\nPORT = 3000\n');
    write(root, 'src/billing.mjs', 'export function chargeCard() {}\n');
    recordContextClaims(root, normalizeLearned([
        { claim: 'Uploads are capped at 20 MB in src/limits.js.', sources: [{ path: 'src/limits.js', evidence: 'MAX_UPLOAD_MB = 20' }] },
        'The dashboard listens on 127.0.0.1 only; Işık checked it.'
    ]), { ai: 'test' });
    const ids = recordDecisions(root, normalizeDecided([
        'Use Stripe for payments: the merchant account already exists.',
        'Kullanıcı ayarları local.json içinde tutulur, asla git ile paylaşılmaz.'
    ]), { ai: 'test' }).ids;
    const [stripeId, settingsId] = ids;
    const paddleId = recordDecisions(root, normalizeDecided([{ decision: 'Use Paddle after all: Stripe refused the account.', supersedes: stripeId }]), { ai: 'test' }).ids[0];
    recordSession(root, { ai: 'Claude', headline: 'Billing provider chosen', did: 'Compared Stripe and Paddle fees.', next: 'Wire the webhook.' });
    recordSession(root, { ai: 'Codex', headline: 'Upload limit raised', did: 'Raised the upload cap and documented it.', notChecked: 'The Windows build.' });
    archiveRecords(root, [{ id: 'a'.repeat(24), claim: 'The old cold storage bucket was named plutos-legacy-archive.', strength: 'unverified', sources: [], capturedAt: '2026-09-01T00:00:00.000Z', archivedAt: '2026-10-01T00:00:00.000Z', reason: 'cap' }]);

    check('the index builds from the fixture with every record and rebuilds only when a file changes', () => {
        const first = ensureIndex(root);
        assert.equal(first.engine, 'fts5', JSON.stringify(first));
        assert.equal(first.built, true);
        assert.equal(first.nodes, 8, 'records: 2 claims + 3 decisions + 2 sessions + 1 archived');
        assert.ok(fs.existsSync(indexPathFor(root)));
        const again = ensureIndex(root);
        assert.equal(again.built, false);
        const db = openIndex(root);
        assert.ok(db, 'the index opens');
        assert.equal(db.prepare('SELECT count(*) AS n FROM nodes').get().n, 8);
        assert.equal(db.prepare('SELECT count(*) AS n FROM nodes WHERE archived = 1').get().n, 1);
        db.close();
        assert.equal(checkIndex(root).ok, true);
    });
    check('find in English returns the decision with why and the floor line', () => {
        const r = findMemory(root, 'which payment provider: Stripe or Paddle');
        assert.equal(r.engine, 'fts5');
        assert.ok(r.cards.length >= 1 && r.cards.length <= 3, renderFind(r));
        assert.ok(r.cards.some(c => c.id === paddleId || c.id === stripeId), renderFind(r));
        assert.ok(r.cards[0].why.length >= FIND_FLOOR.terms);
        assert.ok(r.cards.every(c => c.text.length <= 500));
        assert.match(renderFind(r), /why: /);
    });
    check('find in Turkish with ı/İ folded and the dictionary reaches the record', () => {
        const r = findMemory(root, 'KULLANICI AYARLARI nerede tutuluyor');
        assert.equal(r.cards[0]?.id, settingsId, renderFind(r));
        const en = findMemory(root, 'Ödeme için Stripe mi Paddle mı seçildi');
        assert.ok(en.cards.some(c => c.id === paddleId || c.id === stripeId), renderFind(en));
        assert.deepEqual(queryTerms('Işık İstemci').terms, ['isik', 'client', 'istemci']);
    });
    check('the floor hides a nonsense query and the answer says so', () => {
        const r = findMemory(root, 'a thing that never existed xyzzy');
        assert.equal(r.cards.length, 0, renderFind(r));
        assert.match(renderFind(r), /No record matches above the floor/);
        assert.equal(findMemory(root, 'the and of').engine, 'none');
    });
    check('--archived reveals the cold record and it is labelled; without it the record stays hidden', () => {
        const cold = findMemory(root, 'cold storage bucket plutos-legacy-archive', { archived: true });
        assert.equal(cold.cards[0]?.id, 'a'.repeat(24), renderFind(cold));
        assert.equal(cold.cards[0].archived, true);
        assert.match(renderFind(cold), /archived: history, not current/);
        const warm = findMemory(root, 'cold storage bucket plutos-legacy-archive');
        assert.ok(!warm.cards.some(c => c.id === 'a'.repeat(24)), renderFind(warm));
    });
    check('a path or id in the query is a fact key: trigram hit, one term is enough', () => {
        const byPath = findMemory(root, 'src/limits.js');
        assert.ok(byPath.cards.some(c => c.why.includes('path:src/limits.js')), renderFind(byPath));
        const byId = findMemory(root, `what was ${stripeId}`);
        assert.equal(byId.cards[0]?.id, stripeId, renderFind(byId));
        assert.equal(matchExpression(['pay', 'payment', 'a"b']), '"pay" OR "payment"* OR "a""b"');
    });
    check('a change to CONTEXT.json rebuilds the index (manifest)', () => {
        recordDecisions(root, normalizeDecided(['Backups run nightly to the office NAS.']), { ai: 'test' });
        const r = ensureIndex(root);
        assert.equal(r.built, true);
        assert.equal(r.nodes, 9);
        assert.ok(findMemory(root, 'nightly backups NAS').cards.some(c => c.text.startsWith('Backups run nightly')));
    });
    check('the floor needs an informative term: two common fixture words are refused, one rare word added passes', () => {
        // 9 records: a term in more than ceil(0.9) = 1 record is common. "stripe" is in 3, "paddle" in 2, "fees" in 1.
        const { records } = collectRecords(root);
        assert.equal(informativeLimit(records.length), 1);
        const db = openIndex(root);
        const df = term => db.prepare('SELECT df FROM terms WHERE term = ?').get(term)?.df || 0;
        assert.equal(db.prepare("SELECT value FROM manifest WHERE key = 'schema'").get().value, String(INDEX_SCHEMA));
        assert.deepEqual([df('stripe'), df('paddle'), df('fees')], [3, 2, 1], 'the terms table holds each folded term\'s document frequency');
        db.close();
        const common = findMemory(root, 'Stripe Paddle');
        assert.equal(common.engine, 'fts5');
        assert.deepEqual(common.informative, [], JSON.stringify(common));
        assert.equal(common.cards.length, 0, renderFind(common));
        assert.match(common.line, /Every query word is common in the records \(stripe, paddle\); add a specific word/);
        const rare = findMemory(root, 'Stripe Paddle fees');
        assert.deepEqual(rare.informative, ['fees'], JSON.stringify(rare));
        assert.ok(rare.cards.length >= 1 && rare.cards[0].why.includes('fees'), renderFind(rare));
        assert.equal(rare.cards[0].title, 'Billing provider chosen');
        // The scan applies the same floor from the same frequencies.
        const parsed = queryTerms('Stripe Paddle fees');
        const scan = scanRecords(records, parsed);
        assert.deepEqual([...scan.df.entries()], [['stripe', 3], ['paddle', 2], ['fees', 1]]);
        assert.equal(scan.total, records.length);
        // Rebuilt: an archived record counts (df is over every record), and a schema-1 database is rebuilt.
        archiveRecords(root, [{ id: 'b'.repeat(24), claim: 'The Stripe sandbox keys lived in the vault.', strength: 'unverified', sources: [], capturedAt: '2026-09-02T00:00:00.000Z', archivedAt: '2026-10-02T00:00:00.000Z', reason: 'cap' }]);
        assert.equal(ensureIndex(root).built, true);
        const rebuilt = openIndex(root);
        assert.equal(rebuilt.prepare('SELECT df FROM terms WHERE term = ?').get('stripe').df, 4);
        rebuilt.prepare("UPDATE manifest SET value = '1' WHERE key = 'schema'").run();
        rebuilt.close();
        assert.equal(ensureIndex(root).built, true, 'an index at schema 1 is rebuilt');
        assert.equal(ensureIndex(root).built, false);
    });
    check('the scan fallback returns the same top-1 as FTS5 on the fixtures', () => {
        const { records } = collectRecords(root);
        for (const q of ['which payment provider: Stripe or Paddle', 'KULLANICI AYARLARI', 'nightly backups NAS', 'upload limit raised']) {
            const parsed = queryTerms(q);
            const fts = findMemory(root, q);
            const scan = scanRecords(records, parsed);
            assert.equal(fts.engine, 'fts5');
            assert.equal(scan.rows[0]?.id, fts.cards[0]?.id, `${q}: scan ${scan.rows[0]?.id} vs fts ${fts.cards[0]?.id}`);
        }
        // A broken database file is not an exception: find scans and says so.
        fs.writeFileSync(indexPathFor(root), 'not a database');
        const r = findMemory(root, 'which payment provider: Stripe or Paddle');
        assert.ok(['scan', 'fts5'].includes(r.engine));
        assert.ok(r.cards.some(c => c.id === paddleId || c.id === stripeId), renderFind(r));
        assert.ok(ensureIndex(root).engine === 'fts5', 'the broken file is rebuilt');
    });
    check('plutos_context_for_task carries a Memory heading on a task that names a decision, one card at most', () => {
        resetTaskContextCache();
        const r = taskContext(root, 'chargeCard: switch the payment provider from Stripe');
        assert.match(r.text, /^Memory:$/m, r.text);
        assert.equal((r.text.match(/^- \S+ (decision|claim|session) \(/gm) || []).length, 1, r.text);
        assert.ok(r.memory && r.memory.why.includes('stripe'), JSON.stringify(r.memory));
        const tight = taskContext(root, 'chargeCard: switch the payment provider from Stripe', { budgetTokens: 200 });
        assert.ok(!/^Memory:$/m.test(tight.text), 'the card is the first thing cut when the budget is tight');
        const none = taskContext(root, 'switch the payment provider from Stripe to Paddle');
        assert.match(none.text, /^Memory:$/m, 'a task with no code match still gets the card');
    });
    check('a project without handoff records gets no index and nothing written', () => {
        const bare = path.join(tmp, 'bare');
        write(bare, 'src/a.mjs', 'export const a = 1;\n');
        const before = fs.readdirSync(bare, { recursive: true }).map(String).sort();
        assert.equal(findMemory(bare, 'anything at all here').engine, 'none');
        assert.equal(ensureIndex(bare).built, false);
        resetTaskContextCache();
        taskContext(bare, 'change a in src/a.mjs');
        assert.deepEqual(fs.readdirSync(bare, { recursive: true }).map(String).sort(), before);
    });
    check('session_end writes Shown (ids only, bounded) and parseContinuity reads a block without it', () => {
        const shown = [paddleId, 'a'.repeat(24), 'not-an-id', paddleId];
        recordSession(root, { ai: 'Claude', headline: 'Shown test', shown });
        const parsed = parseContinuity(fs.readFileSync(continuityPathFor(root), 'utf8'));
        const last = parsed.sessions.at(-1);
        assert.equal(last.fields.Shown, `${paddleId}, ${'a'.repeat(24)}`);
        assert.equal(parsed.sessions[0].fields.Shown, undefined, 'the first block has no Shown field and parses');
        assert.equal(parsed.sessions.length, 3);
        assert.ok(shownField(Array.from({ length: 60 }, (_, i) => `d-${String(i).padStart(12, '0')}`)).length <= 400);
        assert.deepEqual(idsShownIn(`see ${paddleId} and ${'b'.repeat(24)} twice ${paddleId}`), [paddleId, 'b'.repeat(24)]);
        const history = shownHistory(root);
        assert.equal(history.blocks, 1);
        assert.equal(history.lastShown.get(paddleId), last.time);
    });
    check('check --memory counts unseen decisions only from the first Shown block, and runs the index integrity check', () => {
        // Tracking began 45 days ago (the first Shown block, backdated here); the Paddle decision was shown today.
        const file = continuityPathFor(root);
        const stamped = parseContinuity(fs.readFileSync(file, 'utf8')).sessions.at(-1).time;
        const old = new Date(Date.now() - 45 * 864e5).toISOString();
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(`### ${stamped}`, `### ${old}`));
        recordSession(root, { ai: 'Claude', headline: 'Shown again', shown: [paddleId] });
        // Both decisions are 60 days old; only the settings one was never shown.
        const reg = JSON.parse(fs.readFileSync(contextPathFor(root), 'utf8'));
        for (const d of reg.decisions) if (d.id === settingsId || d.id === paddleId) d.capturedAt = new Date(Date.now() - 60 * 864e5).toISOString();
        fs.writeFileSync(contextPathFor(root), JSON.stringify(reg, null, 2) + '\n');
        const later = new Date(Date.now() + 5 * 864e5);
        const report = memoryCheck(root, { now: later });
        const unseen = report.findings.filter(f => f.kind === 'unseen-30d');
        assert.ok(unseen.some(f => f.text.startsWith(settingsId)), JSON.stringify(unseen));
        assert.ok(!unseen.some(f => f.text.startsWith(paddleId)), 'the shown decision is not unseen');
        assert.match(report.summary, /shown-id tracking since/);
        assert.equal(report.index.ok, true);
        const fresh = path.join(tmp, 'untracked');
        fs.mkdirSync(path.join(fresh, 'docs', 'handoff'), { recursive: true });
        recordDecisions(fresh, normalizeDecided(['An old ruling.']), { ai: 'test' });
        const r = memoryCheck(fresh, { now: later });
        assert.ok(!r.findings.some(f => f.kind === 'unseen-30d'));
        assert.match(r.summary, /tracking starts at the next session_end/);
        const run = cli(root, 'check', '--memory');
        assert.equal(run.status, 0, run.stderr);
    });
    check('the CLI: memory find prints cards, --json gives the shape, --budget is bounded, and the query goes before the flags', () => {
        const run = cli(root, 'memory', 'find', 'payment provider Stripe', '--budget', '1');
        assert.equal(run.status, 0, run.stderr);
        assert.match(run.stdout, /session|decision/);
        assert.ok(!/ExperimentalWarning/.test(run.stderr), run.stderr);
        const json = JSON.parse(cli(root, 'memory', 'find', 'payment provider Stripe', '--json').stdout);
        assert.equal(json.engine, 'fts5');
        assert.ok(json.cards.length <= 3);
        assert.equal(cli(root, 'memory', 'find', 'payment', '--budget', '7').status, 1);
        assert.equal(cli(root, 'memory', 'find').status, 1);
    });
    check('a find on this repository does not throw', () => {
        // The published core ships without the working repository's records (docs/handoff is private),
        // so there the honest answer is 'none'; the point is that nothing throws.
        const r = findMemory(ROOT, 'which file holds the push gate stamp');
        assert.ok(['fts5', 'scan', 'none'].includes(r.engine));
    });
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`memory-index-test: ${passed} checks passed`);
