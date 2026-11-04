// Session-completion regression tests. All state stays in a disposable Hub/project tree.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-session-memory-'));
process.env.PLUTOS_HOME = path.join(tmpRoot, 'hub');
const { buildBrief, recordSession, parseContinuity, continuityPathFor, CONTINUITY_BUDGETS,
    SILENT_SESSION_GRACE_MS, SILENT_ENDING_TOLERANCE_MS } = await import('../lib/continuity.mjs');
const { recordArrival } = await import('../lib/presence.mjs');
const { assessContext, contextPathFor, QUARANTINE_DAYS, CLAIM_REVIEW_DAYS } = await import('../lib/context.mjs');
const RealDate = Date;
const start = RealDate.parse('2026-09-08T08:00:00.000Z');
let now = start;
globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
};
let passed = 0;
let failed = 0;
const warning = 'no ending recorded for its last activity';
const uncertain = 'ending for its last activity could not be verified';

function project(name) {
    now = start;
    const root = path.join(tmpRoot, name);
    fs.mkdirSync(root, { recursive: true });
    return root;
}
function archive(root, name, content) {
    const file = path.join(root, 'docs', 'handoff', 'archive', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
}
function session(ai, time = start, headline = 'legacy completion') {
    return `### ${new RealDate(time).toISOString()} · ${ai} · ${headline}\n- **Did:** Finished work.\n`;
}
function participantLine(root, ai = 'Gemini') {
    const brief = buildBrief(root, { ai });
    return brief.split('\n').find(line => line.startsWith('- **Claude**')) || '';
}
function age() { now += SILENT_SESSION_GRACE_MS + 60 * 60 * 1000; }
function rotate(root) {
    for (let i = 0; i < CONTINUITY_BUDGETS.keepSessions; i++) {
        now += 1000;
        recordSession(root, { ai: 'Gemini', headline: `Other work ${i}` });
    }
}
async function test(name, run) {
    try { await run(); passed++; console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
}

try {
    for (const reference of ['unchanged', 'changed', 'missing']) {
        await test(`a surviving excerpt still verifies its ${reference} referenced code`, () => {
            const root = project(`excerpt-reference-${reference}`);
            fs.mkdirSync(path.join(root, 'src'));
            const source = path.join(root, 'src', 'app.js'), guide = path.join(root, 'guide.md');
            fs.writeFileSync(source, 'export const mode = "safe";\n');
            fs.writeFileSync(guide, 'The mode is safe. See `src/app.js`.\n');
            recordSession(root, { ai: 'Claude', headline: 'Captured source contract',
                learned: [{ claim: 'The documented mode is safe.', sources: [{ path: 'guide.md', evidence: 'The mode is safe.' }] }] });
            fs.appendFileSync(guide, '\nAn unrelated note.\n');
            if (reference === 'changed') fs.writeFileSync(source, 'export const mode = "fast";\n');
            if (reference === 'missing') fs.rmSync(source);
            const assessment = assessContext(root);
            assert.equal(assessment.review.length, reference === 'unchanged' ? 1 : 0);
            assert.equal(assessment.stale.length, reference === 'unchanged' ? 0 : 1);
            if (reference !== 'unchanged') assert.match(assessment.stale[0].reasons.join(' '), /referenced (code changed|file is missing)/);
        });
    }
    await test('a surviving excerpt still checks document-to-code commit drift', () => {
        const root = project('excerpt-document-drift');
        fs.mkdirSync(path.join(root, 'src'));
        fs.writeFileSync(path.join(root, 'src', 'app.js'), 'export const mode = "safe";\n');
        const guide = path.join(root, 'guide.md');
        fs.writeFileSync(guide, 'The mode is safe.\n');
        const git = (...args) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
        git('init', '-q'); git('config', 'user.email', 'fixture@example.test'); git('config', 'user.name', 'Fixture');
        git('add', '.'); git('commit', '-qm', 'Capture documented safe mode');
        recordSession(root, { ai: 'Claude', headline: 'Captured guide',
            learned: [{ claim: 'The documented mode is safe.', sources: [{ path: 'guide.md', evidence: 'The mode is safe.' }] }] });
        fs.writeFileSync(path.join(root, 'src', 'app.js'), 'export const mode = "fast";\n');
        git('add', 'src/app.js'); git('commit', '-qm', 'Change implementation');
        fs.appendFileSync(guide, '\nSee `src/app.js`.\n');
        const assessment = assessContext(root);
        assert.equal(assessment.review.length, 0);
        assert.equal(assessment.stale.length, 1);
        assert.match(assessment.stale[0].reasons.join(' '), /document references changed code/);
    });
    await test(`a claim whose source never changes is listed for review after ${CLAIM_REVIEW_DAYS} days, until captured again`, () => {
        const root = project('half-life');
        fs.writeFileSync(path.join(root, 'guide.md'), 'The store takes PayPal.\n');
        const learned = [{ claim: 'The store takes PayPal.', sources: [{ path: 'guide.md', evidence: 'The store takes PayPal.' }] }];
        recordSession(root, { ai: 'Claude', headline: 'Captured the payment rule', learned });
        now = start + (CLAIM_REVIEW_DAYS - 1) * 864e5;
        assert.equal(assessContext(root).current.length, 1);
        now = start + (CLAIM_REVIEW_DAYS + 1) * 864e5;
        const old = assessContext(root);
        assert.deepEqual([old.current.length, old.review.length], [0, 1]);
        assert.match(old.review[0].reasons.join(' '), new RegExp(`captured ${CLAIM_REVIEW_DAYS + 1} days ago and not captured again since`));
        recordSession(root, { ai: 'Codex', headline: 'Confirmed the payment rule', learned });
        assert.equal(assessContext(root).current.length, 1, 'captured again, it is current');
    });
    const claimsOf = root => JSON.parse(fs.readFileSync(contextPathFor(root), 'utf8')).claims;
    await test(`a claim quarantined for ${QUARANTINE_DAYS} days goes to the archive at a session end`, () => {
        const root = project('aging');
        fs.writeFileSync(path.join(root, 'a.md'), 'Port is 3041.\n');
        recordSession(root, { ai: 'Claude', headline: 'capture', learned: [{ claim: 'The port is 3041.', sources: [{ path: 'a.md', evidence: 'Port is 3041.' }] }] });
        fs.writeFileSync(path.join(root, 'a.md'), 'Port is 4000.\n');
        now += 1000;
        recordSession(root, { ai: 'Claude', headline: 'first sighting' });
        assert.equal(claimsOf(root).length, 1);
        assert.ok(claimsOf(root)[0].quarantinedAt, 'a session end marks when it first saw the claim quarantined');
        now += (QUARANTINE_DAYS + 1) * 24 * 3600e3;
        recordSession(root, { ai: 'Claude', headline: 'two weeks on' });
        assert.equal(claimsOf(root).length, 0);
        const archived = fs.readdirSync(path.join(root, 'docs', 'handoff', 'archive')).filter(f => /^CONTEXT-\d{4}-\d{2}\.jsonl$/.test(f));
        assert.equal(archived.length, 1);
        assert.match(fs.readFileSync(path.join(root, 'docs', 'handoff', 'archive', archived[0]), 'utf8'), /The port is 3041\..*"reason"/);
    });
    await test('a claim that recovers loses its quarantine mark, and a correction archives the claim it corrects', () => {
        const root = project('correction');
        const doc = path.join(root, 'b.md');
        fs.writeFileSync(doc, 'Port is 3041. Also 4000.\n');
        recordSession(root, { ai: 'Claude', headline: 'capture', learned: [{ claim: 'The port is 3041.', sources: [{ path: 'b.md', evidence: 'Port is 3041.' }] }] });
        fs.writeFileSync(doc, 'Also 4000.\n');
        now += 1000; recordSession(root, { ai: 'Claude', headline: 'quarantined' });
        fs.writeFileSync(doc, 'Port is 3041. Also 4000.\n');
        now += 1000; recordSession(root, { ai: 'Claude', headline: 'recovered' });
        assert.equal(claimsOf(root)[0].quarantinedAt, undefined);
        now += 1000;
        recordSession(root, { ai: 'Claude', headline: 'correct it', learned: [{ claim: 'The port is 4000.', replaces: 'The port is 3041.', sources: [{ path: 'b.md', evidence: 'Also 4000.' }] }] });
        assert.deepEqual(claimsOf(root).map(c => c.claim), ['The port is 4000.']);
        const archive = fs.readdirSync(path.join(root, 'docs', 'handoff', 'archive')).find(f => f.startsWith('CONTEXT-'));
        assert.match(fs.readFileSync(path.join(root, 'docs', 'handoff', 'archive', archive), 'utf8'), /replaced by: The port is 4000\./);
        const archived = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'handoff', 'archive', archive), 'utf8').trim().split('\n').pop());
        assert.equal(archived.supersededBy, claimsOf(root)[0].id, 'the archived claim points at its successor');
        now += 1000;
        const missed = recordSession(root, { ai: 'Claude', headline: 'bad correction', learned: [{ claim: 'The port is 5000.', replaces: 'The port was never this.', sources: [{ path: 'b.md', evidence: 'Also 4000.' }] }] });
        assert.deepEqual(missed.context.replaceMissed, ['The port was never this.'], 'a replaces that matches nothing is reported');
    });
    await test('what a session did not check is recorded and reaches the next brief', () => {
        const root = project('not-checked');
        recordSession(root, { ai: 'Claude', headline: 'partly verified', notChecked: 'the Gemini import was not run' });
        assert.match(fs.readFileSync(continuityPathFor(root), 'utf8'), /- \*\*Not checked:\*\* the Gemini import was not run/);
        assert.match(buildBrief(root, { ai: 'Gemini' }), /\*\*Not checked:\*\* the Gemini import was not run/);
    });
    await test('a valid completion remains recognized after five other sessions rotate it', () => {
        const root = project('rotated');
        recordArrival(root, 'Claude');
        recordSession(root, { ai: 'Claude', headline: 'Completed work', did: 'Archived detail stays cold.' });
        rotate(root);
        const live = parseContinuity(fs.readFileSync(continuityPathFor(root), 'utf8'));
        assert.equal(live.sessions.length, CONTINUITY_BUDGETS.keepSessions);
        assert(!live.sessions.some(entry => entry.ai === 'Claude'));
        age();
        const brief = buildBrief(root, { ai: 'Gemini' });
        const row = participantLine(root);
        assert(row && !row.includes('⚠'), row);
        assert(!brief.includes('Archived detail stays cold.'));
    });
    await test('pre-existing monthly archives work without a new session or migration write', () => {
        const root = project('legacy');
        recordArrival(root, 'Claude');
        const file = archive(root, 'SESSIONS-2026-08.md', session(' cLaUdE '));
        const before = fs.readFileSync(file, 'utf8');
        age();
        assert(!participantLine(root).includes('⚠'));
        assert.equal(fs.readFileSync(file, 'utf8'), before);
        assert(!fs.existsSync(continuityPathFor(root)));
        assert.equal(participantLine(root, ' CLAUDE '), '');
    });
    await test('an old arrival with no completion still warns', () => {
        const root = project('missing');
        recordArrival(root, 'Claude');
        age();
        assert(participantLine(root).includes(warning));
    });
    await test('recent activity remains within the in-progress grace', () => {
        const root = project('working');
        recordArrival(root, 'Claude');
        now += SILENT_SESSION_GRACE_MS - 1;
        assert(!participantLine(root).includes('⚠'));
    });
    for (const location of ['live', 'archive']) {
        await test(`later unclosed activity is not excused by an older ${location} completion`, () => {
            const root = project(`later-${location}`);
            recordSession(root, { ai: 'cLaUdE', headline: 'Earlier completed work' });
            if (location === 'archive') rotate(root);
            now = start + SILENT_ENDING_TOLERANCE_MS + 1;
            recordArrival(root, 'Claude');
            age();
            assert(participantLine(root).includes(warning));
        });
    }
    await test('activity at the ending tolerance still matches a legacy archived completion', () => {
        const root = project('tolerance');
        archive(root, 'SESSIONS-2026-08.md', session('CLAUDE'));
        now += SILENT_ENDING_TOLERANCE_MS;
        recordArrival(root, 'Claude');
        age();
        assert(!participantLine(root).includes('⚠'));
    });
    await test('idempotent retries preserve the original ending and later rotation', () => {
        const root = project('retry');
        const payload = { ai: 'Claude', headline: 'Completed once', operationId: 'same-request' };
        recordSession(root, payload);
        const before = fs.readFileSync(continuityPathFor(root), 'utf8');
        now += SILENT_ENDING_TOLERANCE_MS + 1;
        recordArrival(root, 'Claude');
        assert.equal(recordSession(root, payload).duplicate, true);
        assert.equal(recordSession(root, { ...payload, operationId: '' }).duplicate, true);
        assert.equal(fs.readFileSync(continuityPathFor(root), 'utf8'), before);
        rotate(root);
        age();
        assert(participantLine(root).includes(warning));
        const archived = fs.readFileSync(path.join(root, 'docs/handoff/archive/SESSIONS-2026-09.md'), 'utf8');
        assert.equal(parseContinuity(archived).sessions.length, 1);
    });
    for (const [name, content] of [
        ['invalid-date', '### invalid · Claude · Broken date\n'],
        ['broken-header', '### 2026-09-08T08:00:00Z Claude incomplete\n'],
        ['empty-history', 'damaged archive contents\n']
    ]) {
        await test(`${name} is uncertainty, not proof of a missing ending`, () => {
            const root = project(name);
            recordArrival(root, 'Claude');
            archive(root, 'SESSIONS-2026-08.md', content);
            age();
            const row = participantLine(root);
            assert(row.includes(uncertain), row);
            assert(!row.includes(warning));
        });
    }
    await test('an unreadable archive cannot establish that no ending exists', () => {
        const root = project('unreadable');
        recordArrival(root, 'Claude');
        fs.mkdirSync(path.join(root, 'docs/handoff/archive/SESSIONS-2026-08.md'), { recursive: true });
        age();
        assert(participantLine(root).includes(uncertain));
    });
    await test('archive byte budget limits reads and reports incomplete history', () => {
        const root = project('byte-budget');
        recordArrival(root, 'Claude');
        archive(root, 'SESSIONS-2026-08.md', 'x'.repeat(CONTINUITY_BUDGETS.completionArchiveBytes + 1));
        age();
        assert(participantLine(root).includes(uncertain));
    });
    await test('archive file budget cannot become a false missing-ending warning', () => {
        const root = project('file-budget');
        recordArrival(root, 'Claude');
        for (let i = 0; i <= CONTINUITY_BUDGETS.completionArchiveFiles; i++) {
            archive(root, `SESSIONS-${2000 + i}-01.md`, session(i ? 'Gemini' : 'Claude'));
        }
        age();
        assert(participantLine(root).includes(uncertain));
    });
    await test('a recent match stops before older unreadable history or fenced examples', () => {
        const root = project('early-stop');
        recordArrival(root, 'Claude');
        archive(root, 'SESSIONS-2026-09.md', `\`\`\`\n### invalid example\n\`\`\`\n${session('Claude')}`);
        fs.mkdirSync(path.join(root, 'docs/handoff/archive/SESSIONS-2026-08.md'));
        age();
        assert(!participantLine(root).includes('⚠'));
    });
    await test('parallel writers preserve all sessions while rotating a bounded live ledger', async () => {
        const root = project('parallel');
        const moduleUrl = new URL('../lib/continuity.mjs', import.meta.url).href;
        await Promise.all(['Claude', 'Gemini'].map(ai => new Promise((resolve, reject) => {
            const source = `import { recordSession } from ${JSON.stringify(moduleUrl)};
                for (let i = 0; i < 4; i++) recordSession(${JSON.stringify(root)},
                    {ai: ${JSON.stringify(ai)}, headline: 'Concurrent work ' + i, operationId: ${JSON.stringify(ai)} + i});`;
            const child = spawn(process.execPath, ['--input-type=module', '-e', source], { windowsHide: true });
            let stderr = '';
            child.stderr.on('data', data => { stderr += data; });
            child.on('error', reject);
            child.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr || `writer exit ${code}`)));
        })));
        const live = parseContinuity(fs.readFileSync(continuityPathFor(root), 'utf8')).sessions;
        const archiveDir = path.join(root, 'docs/handoff/archive');
        const old = fs.readdirSync(archiveDir).flatMap(name => parseContinuity(fs.readFileSync(path.join(archiveDir, name), 'utf8')).sessions);
        assert.equal(live.length, CONTINUITY_BUDGETS.keepSessions);
        assert.equal(live.length + old.length, 8);
        assert.equal(new Set([...live, ...old].map(entry => entry.fields.Op)).size, 8);
    });
} finally {
    globalThis.Date = RealDate;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
}
console.log(`\nSession memory: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
