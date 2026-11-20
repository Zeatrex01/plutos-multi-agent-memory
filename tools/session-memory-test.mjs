// Session-completion regression tests. All state stays in a disposable Hub/project tree.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-session-memory-'));
process.env.PLUTOS_HOME = path.join(tmpRoot, 'hub');
process.env.HOME = process.env.USERPROFILE = path.join(tmpRoot, 'home');
const { buildBrief, recordSession, recordDecision, decisionReply, parseContinuity, continuityPathFor, CONTINUITY_BUDGETS,
    SILENT_SESSION_GRACE_MS, SILENT_ENDING_TOLERANCE_MS } = await import('../lib/continuity.mjs');
const { recordArrival } = await import('../lib/presence.mjs');
const { sessionBriefParts, sessionBrief, BRIEF_PART_CHARS, READ_ONLY_LINE, readOnlyLine, agreementSummary } = await import('../lib/session-brief.mjs');
const { withPackServers, SESSION_END_LINE } = await import('../lib/continuity.mjs');
const { assessContext, contextPathFor, QUARANTINE_DAYS, CLAIM_REVIEW_DAYS } = await import('../lib/context.mjs');
const { recordDecisions, normalizeDecided } = await import('../lib/context.mjs');
const { verifyMemory } = await import('../lib/memory.mjs');
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
    // core's trial (2026-11): a decision the owner gave only in chat survived later sessions when it was
    // written where the next session's start shows it. A session can end without session_end; the
    // SessionEnd hook then records it from git, which cannot hold a chat decision.
    await test("an owner's decision recorded mid-session reaches the next brief though session_end never runs", () => {
        const root = project('decide-mid-session');
        const text = 'Ship on Steam first, not itch.io: the owner wants Steam reviews before launch';
        const { id, added } = recordDecision(root, text, { ai: 'Claude' });
        assert.equal(added, true);
        assert.match(id, /^d-[0-9a-f]{12}$/);
        recordSession(root, { ai: 'Claude', headline: 'Ended without session_end: recorded from git by the SessionEnd hook', origin: 'session-close-hook' });
        const brief = buildBrief(root, { ai: 'Gemini' });
        const settled = brief.indexOf('## Settled decisions');
        assert.ok(settled >= 0 && brief.indexOf('Ship on Steam first') > settled, brief);
        assert.ok(brief.includes(`(${id})`));
        assert.match(fs.readFileSync(continuityPathFor(root), 'utf8'), new RegExp(`- DECISION: Ship on Steam first.*\\(${id}\\)`));
        assert.equal(JSON.parse(fs.readFileSync(contextPathFor(root), 'utf8')).decisions.filter(d => d.id === id).length, 1);
    });
    await test('the same decision recorded again, or again at session_end, stays one record and one digest line', () => {
        const root = project('decide-repeat');
        const first = recordDecision(root, 'Keep the save format JSON: modders read it', { ai: 'Claude' });
        const again = recordDecision(root, 'keep the save format json: modders read it', { ai: 'Codex' });
        assert.equal(again.added, false);
        assert.equal(again.id, first.id);
        recordSession(root, { ai: 'Claude', headline: 'save work', decided: ['Keep the save format JSON: modders read it'] });
        assert.equal((fs.readFileSync(continuityPathFor(root), 'utf8').match(/DECISION: Keep the save format/gi) || []).length, 1);
        assert.equal(JSON.parse(fs.readFileSync(contextPathFor(root), 'utf8')).decisions.length, 1);
    });
    await test('a decision is refused when empty, too long or carrying hidden characters', () => {
        const root = project('decide-refused');
        assert.throws(() => recordDecision(root, '   ', { ai: 'Claude' }), /required/);
        assert.throws(() => recordDecision(root, 'x'.repeat(5000), { ai: 'Claude' }));
        assert.throws(() => recordDecision(root, 'Use Godot\u200b 4.7', { ai: 'Claude' }), /hidden/);
        assert.ok(!fs.existsSync(contextPathFor(root)) || JSON.parse(fs.readFileSync(contextPathFor(root), 'utf8')).decisions.length === 0);
    });
    await test('a decision the owner changes supersedes the earlier one by id, and the brief shows only the new one', () => {
        const root = project('decide-supersede');
        const a = recordDecision(root, 'Ship on itch.io first: no store fee', { ai: 'Claude' });
        assert.throws(() => recordDecision(root, 'Ship on Steam first', { ai: 'Claude', supersedes: 'd-000000000000' }), /No decision d-000000000000/);
        assert.throws(() => recordDecision(root, 'Ship on Steam first', { ai: 'Claude', supersedes: 'nonsense' }), /decision id/);
        const b = recordDecision(root, 'Ship on Steam first: the owner wants reviews', { ai: 'Claude', supersedes: a.id });
        assert.equal(b.added, true);
        const brief = buildBrief(root, { ai: 'Gemini' });
        assert.match(brief, /Ship on Steam first/);
        assert.doesNotMatch(brief, /Ship on itch\.io first/);
        assert.throws(() => recordDecision(root, 'Ship on GOG first', { ai: 'Claude', supersedes: a.id }), /already reversed/);
    });
    await test('restating a reversed decision records it anew and the brief shows it again', () => {
        const root = project('decide-restate');
        const a = recordDecision(root, 'Use Godot 4.7', { ai: 'Claude' });
        recordDecision(root, 'Use Unity 6', { ai: 'Claude', supersedes: a.id });
        const again = recordDecision(root, 'Use Godot 4.7', { ai: 'Claude' });
        assert.equal(again.added, true);
        assert.notEqual(again.id, a.id);
        assert.match(buildBrief(root, { ai: 'Gemini' }), /Use Godot 4\.7/);
    });
    await test('a decision that is not a string is refused', () => {
        const root = project('decide-type');
        assert.throws(() => recordDecision(root, 42, { ai: 'Claude' }), /must be a string/);
        assert.throws(() => recordDecision(root, { decision: 'x' }, { ai: 'Claude' }), /must be a string/);
    });
    await test('recording an existing decision again repairs a digest line that was never written', () => {
        const root = project('decide-repair');
        const { id } = recordDecision(root, 'Keep levels under two minutes', { ai: 'Claude' });
        const file = continuityPathFor(root);
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^- DECISION: Keep levels.*\n/m, ''));
        const again = recordDecision(root, 'Keep levels under two minutes', { ai: 'Claude' });
        assert.equal(again.added, false);
        assert.equal(again.id, id);
        assert.match(fs.readFileSync(file, 'utf8'), new RegExp(`- DECISION: Keep levels under two minutes \\(${id}\\)`));
    });
    await test('a digest past its line budget is reported when a decision is recorded', () => {
        const root = project('decide-budget');
        let last;
        for (let i = 0; i <= CONTINUITY_BUDGETS.digestLines; i++) last = recordDecision(root, `Decision number ${i}`, { ai: 'Claude' });
        assert.equal(last.digestOverBudget, true);
    });
    await test('the budget note is said once, on the decision that crosses it, with the MCP remedy', () => {
        const root = project('decide-budget-once');
        const replies = [];
        for (let i = 0; i <= CONTINUITY_BUDGETS.digestLines + 2; i++) replies.push(recordDecision(root, `Decision number ${i}`, { ai: 'Claude' }));
        assert.deepEqual(replies.map((r, i) => r.digestOverBudget ? i : -1).filter(i => i >= 0), [CONTINUITY_BUDGETS.digestLines]);
        const note = decisionReply(replies[CONTINUITY_BUDGETS.digestLines]);
        assert.match(note, /supersedes: <id>/);
        assert.doesNotMatch(note, /plutos memory supersede/);
        assert.doesNotMatch(decisionReply(replies.at(-1)), /NOTE/);
    });
    await test('the budget counts standing DECISION lines only, not legacy notes', () => {
        const root = project('decide-budget-legacy');
        recordDecision(root, 'Seed decision', { ai: 'Claude' });
        const file = continuityPathFor(root);
        const notes = Array.from({ length: CONTINUITY_BUDGETS.digestLines }, (_, i) => `- Legacy note ${i}`).join('\n');
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^(- DECISION: Seed decision.*)$/m, `$1\n${notes}`));
        assert.equal(recordDecision(root, 'One more decision', { ai: 'Claude' }).digestOverBudget, false);
    });
    await test('a superseded decision leaves the digest on every supersede path', () => {
        const root = project('decide-supersede-digest');
        const file = continuityPathFor(root);
        const a = recordDecision(root, 'Ship weekly', { ai: 'Claude' });
        const b = recordDecision(root, 'Ship every two weeks', { ai: 'Claude', supersedes: a.id });
        let digest = parseContinuity(fs.readFileSync(file, 'utf8')).digest;
        assert(!digest.some(l => l.includes(a.id)), digest.join('\n'));
        assert(digest.some(l => l.includes(b.id)));
        recordSession(root, { ai: 'Claude', headline: 'Cadence again', decided: [{ decision: 'Ship monthly', supersedes: b.id }] });
        digest = parseContinuity(fs.readFileSync(file, 'utf8')).digest;
        assert(!digest.some(l => l.includes(b.id)), digest.join('\n'));
        assert(digest.some(l => /Ship monthly/.test(l)));
    });
    await test('a Next that a later decision or board entry may have overtaken is marked', () => {
        const root = project('stale-next');
        recordSession(root, { ai: 'Claude', headline: 'Planned', next: 'Build the shop screen', decided: ['Keep the shop'] });
        const calm = buildBrief(root, { ai: 'Gemini' });
        assert.doesNotMatch(calm, /Newer than this/, 'the session\'s own decision is not news');
        assert(calm.split('\n').includes('- **Next:** Build the shop screen'), 'nothing newer: Next is unchanged');
        now += 60 * 60 * 1000;
        const later = recordDecision(root, 'Drop the shop for launch', { ai: 'Claude' });
        fs.mkdirSync(path.join(root, 'docs', 'handoff'), { recursive: true });
        fs.writeFileSync(path.join(root, 'docs', 'handoff', 'BOARD.md'), `# Board\n\n### Claude · IN_PROGRESS · Rework the menu\n- **Started:** ${new RealDate(now).toISOString()}\n- **Task:** menu\n\n### Claude · IN_PROGRESS · Old work\n- **Started:** ${new RealDate(start - 1000).toISOString()}\n`);
        const brief = buildBrief(root, { ai: 'Gemini' });
        const lines = brief.split('\n');
        assert(!lines.includes('- **Next:** Build the shop screen'), 'with newer items the plain Next line is gone');
        const at = lines.indexOf('- **Next (older than the newer items below; verify before following):** Build the shop screen');
        assert(at >= 0, brief);
        assert(lines[at + 1].startsWith(`- **Newer than this:** decision ${later.id}; IN_PROGRESS on the board: "Rework the menu"`), brief);
        assert.doesNotMatch(lines[at + 1], /Old work/);
    });
    await test('the brief served over MCP names the drawers and says look-ups are tool calls', () => {
        const root = project('brief-drawers');
        recordSession(root, { ai: 'Claude', headline: 'Anything' });
        const brief = buildBrief(root, { ai: 'Gemini', mcp: true });
        assert.match(brief, /look-ups are tool calls.*agents for judgment/);
        assert.match(brief, /^- research: /m);
        assert.match(brief, /`plutos_modules open <id>`/);
    });
    await test('plutos decide records the decision from the command line, and can supersede one', () => {
        const root = project('decide-cli');
        fs.mkdirSync(path.join(root, 'docs', 'handoff'), { recursive: true });
        fs.writeFileSync(path.join(root, 'docs', 'handoff', 'PLUTOS_PROTOCOL.md'), '# protocol\n');
        const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
        const out = execFileSync(process.execPath, [cli, 'decide', 'Levels unlock in any order', root], { encoding: 'utf8' });
        const oldId = out.match(/Recorded (d-[0-9a-f]{12})/)[1];
        execFileSync(process.execPath, [cli, 'decide', 'Levels unlock in order: the owner tested skipping and disliked it', root, '--supersedes', oldId], { encoding: 'utf8' });
        const brief = buildBrief(root, { ai: 'Gemini' });
        assert.match(brief, /Levels unlock in order/);
        assert.doesNotMatch(brief, /Levels unlock in any order/);
    });
    await test('plutos decide in a folder that is not a PLUT_OS project is refused and writes nothing', () => {
        const root = project('decide-not-a-project');
        const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
        let error;
        try { execFileSync(process.execPath, [cli, 'decide', 'Anything at all', root], { encoding: 'utf8', stdio: 'pipe' }); } catch (e) { error = e; }
        assert.ok(error && /no PLUT_OS kit/.test(String(error.stderr) + String(error.stdout)), String(error?.stderr));
        assert.ok(!fs.existsSync(path.join(root, 'docs')));
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
    // A busy project: a long Next, many decisions, a full board, so the whole brief is past the part cap.
    function busy(name) {
        const root = project(name);
        for (let i = 0; i < 6; i++) recordDecision(root, `Owner decision number ${i}: ${'keep the long reason here '.repeat(6)}`);
        now += 1000;
        recordSession(root, { ai: 'Claude', headline: 'Busy work', next: `Do the next thing. ${'More next detail. '.repeat(14)}`, notChecked: 'Windows.' });
        const board = path.join(root, 'docs/handoff/BOARD.md');
        fs.mkdirSync(path.dirname(board), { recursive: true });
        fs.writeFileSync(board, '# BOARD\n\n' + Array.from({ length: 6 }, (_, i) => `### Gemini · TODO · Board task ${i}\n- **Task:** something\n`).join('\n'));
        return root;
    }
    await test('part 1 of the brief holds the cap, puts what the session acts on first and names how to get the rest', () => {
        const root = busy('paged');
        const one = sessionBriefParts(root, 'Codex', { writes: false, mcp: true });
        const text = one.context + one.rules;
        assert(text.length <= BRIEF_PART_CHARS + 200, String(text.length));
        assert(one.parts >= 2);
        const at = s => { const i = text.indexOf(s); assert(i >= 0, `part 1 lacks ${s}`); return i; };
        assert(at('WORKING AGREEMENT') < at('**Next:**') && at('**Next:**') < at('## Settled decisions') && at('## Settled decisions') < at('## Other open board items'));
        const last = text.trim().split('\n').pop();
        assert.match(last, /^Brief part 1 of \d+; the rest: `session_start` with \{"part": 2\}\./);
        assert(last.endsWith(SESSION_END_LINE), 'the session_end line still closes part 1');
        // Every later part exists, holds the cap and together they carry the full agreement and the rest.
        const later = Array.from({ length: one.parts - 1 }, (_, i) => sessionBrief(root, 'Codex', { part: i + 2 }));
        for (const page of later) assert(page.length <= BRIEF_PART_CHARS + 200, String(page.length));
        assert(later[0].includes('1. Play back first:'), 'part 2 starts with the full working agreement');
        assert(text.includes('## What this is') && text.includes('## Project readiness: unmapped'), 'what the project is and its readiness are in part 1');
        assert.match(sessionBrief(root, 'Codex', { part: one.parts + 1 }), /there is no part/);
    });
    await test('a read-only side session writes nothing and is told to leave one results file, not to write the board or end the session', () => {
        const root = busy('read-only');
        const roster = path.join(root, 'docs/handoff/ROSTER.md');
        const before = fs.existsSync(roster) ? fs.readFileSync(roster, 'utf8') : null;
        const one = sessionBriefParts(root, 'Side', { mcp: true, readOnly: true });
        const text = one.context + one.rules;
        assert(text.includes(READ_ONLY_LINE));
        assert(!/session_end`? \(rule 8\)|plutos_decide|leave it on the board/.test(text), 'no write instruction');
        assert(!text.includes(SESSION_END_LINE));
        assert.match(text, /"readOnly": true/);
        const all = [text, ...Array.from({ length: one.parts - 1 }, (_, i) => sessionBrief(root, 'Side', { part: i + 2, readOnly: true }))].join('\n');
        assert(!/^\d+\. Record before you stop/m.test(all) && !all.includes('plutos_decide'), 'rules that write are left out');
        assert.equal(fs.existsSync(roster) ? fs.readFileSync(roster, 'utf8') : null, before, 'no arrival written');
        sessionBriefParts(root, 'Side', { mcp: true });
        assert.notEqual(fs.existsSync(roster) ? fs.readFileSync(roster, 'utf8') : null, before, 'a normal session_start does record its arrival');
    });
    await test('a fresh project\'s part 1 carries what this is, its readiness and its scope (Rule 1 before real work)', () => {
        const root = project('fresh-part-1');
        const one = sessionBriefParts(root, 'Claude', { writes: false, mcp: true });
        const text = one.context + one.rules;
        assert(text.length <= BRIEF_PART_CHARS + 200, String(text.length));
        for (const s of ['## What this is', 'write it first (AGENTS.md Rule 1)', '## Project readiness: unmapped', 'write docs/ai/PROJECT_MAP.md', 'Not yet grounded', '## Scope']) assert(text.includes(s), `part 1 lacks ${s}`);
    });
    await test('a read-only brief keeps what a line says and drops only the clause that asks for a write', () => {
        const root = project('read-only-unmapped');
        fs.mkdirSync(path.join(root, 'src'), { recursive: true });
        const one = sessionBriefParts(root, 'Side', { mcp: true, readOnly: true });
        const all = [one.context + one.rules, ...Array.from({ length: one.parts - 1 }, (_, i) => sessionBrief(root, 'Side', { part: i + 2, readOnly: true }))].join('\n');
        assert(!/write it first|write docs\/|before the first UI change, write it|do the above first/.test(all), all);
        assert(all.includes('No `docs/ai/PROJECT_MAP.md` yet.'), 'the map is still said to be missing');
        assert(all.includes('## Project readiness: unmapped') && all.includes('**Not yet grounded:** review / critique'), 'readiness still says what is not grounded');
        assert.equal(readOnlyLine('- **Next:** Fix the parser; then call session_end with what you learned.'), '- **Next:** Fix the parser.');
        assert.equal(readOnlyLine('- **Next:** Do the work: claim a board task, and close the session with session_end (what changed, what you learned).'), '- **Next:** Do the work.');
        assert.equal(readOnlyLine('No `DESIGN.md`: before the first UI change, write it (template `x`; skill `y`); for an app, propose the design kickoff (the owner picks drafts).'),
            'No `DESIGN.md`: for an app, propose the design kickoff (the owner picks drafts).');
        assert.equal(readOnlyLine('8. Record before you stop: call session_end.'), '');
        assert.equal(readOnlyLine('Tools: look-ups are tool calls; agents for judgment.'), 'Tools: look-ups are tool calls; agents for judgment.');
    });
    await test('a later part runs none of the upkeep: no arrival written, nothing moved between pages', () => {
        const root = busy('later-part');
        const roster = path.join(root, 'docs/handoff/ROSTER.md');
        const before = fs.existsSync(roster) ? fs.readFileSync(roster, 'utf8') : null;
        sessionBriefParts(root, 'Codex', { mcp: true, part: 2 });
        assert.equal(fs.existsSync(roster) ? fs.readFileSync(roster, 'utf8') : null, before, 'part 2 recorded no arrival');
        sessionBriefParts(root, 'Codex', { mcp: true });
        assert.notEqual(fs.existsSync(roster) ? fs.readFileSync(roster, 'utf8') : null, before, 'part 1 still does');
    });
    await test('a long owner agreement is summarised within part 1\'s cap, the rest named in part 2', () => {
        const rules = Array.from({ length: 40 }, (_, i) => `${i + 1}. ${'Rule heading that is long enough '.repeat(3).slice(0, 70)}: body ${i}`).join('\n');
        const short = agreementSummary(rules, 800);
        assert(short.length <= 800, String(short.length));
        assert.match(short, /…the rest in part 2\.$/);
        assert.match(agreementSummary('1. Play back first: x\n2. Smallest change: y'), /1\. Play back first · 2\. Smallest change\.$/);
        const own = path.join(process.env.PLUTOS_HOME, 'WORKING_AGREEMENT.md');
        fs.mkdirSync(path.dirname(own), { recursive: true });
        fs.writeFileSync(own, rules);
        try {
            const root = project('long-agreement');
            const one = sessionBriefParts(root, 'Claude', { writes: false, mcp: true });
            assert((one.context + one.rules).length <= BRIEF_PART_CHARS, String((one.context + one.rules).length));
            assert((one.context).includes('…the rest in part 2.'));
            assert(sessionBrief(root, 'Claude', { part: 2 }).includes('40. Rule heading'), 'the full agreement is paged');
        } finally { fs.rmSync(own, { force: true }); }
    });
    await test('in git, New results lists only results changed since the session, not files a checkout touched, and no symlink', () => {
        const root = project('new-results-git');
        const g = (...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'ignore' });
        g('init', '-q');
        const dir = path.join(root, 'docs/handoff/results');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, '2026-01-01-old.md'), '# Old report\n');
        g('add', '-A'); g('commit', '-qm', 'old');
        recordSession(root, { ai: 'Claude', headline: 'Main work', next: 'Go on.' });
        const line = () => buildBrief(root, { ai: 'Claude' }).split('\n').find(l => l.startsWith('New results')) || '';
        // A pull or branch switch rewrites the old file: newer mtime, nothing changed.
        fs.utimesSync(path.join(dir, '2026-01-01-old.md'), new RealDate(), new RealDate());
        assert.equal(line(), '', 'a checked-out old report is not new');
        fs.writeFileSync(path.join(dir, '2026-09-09-side.md'), '# Side finding\n');
        const outside = path.join(tmpRoot, 'outside-secret.md');
        fs.writeFileSync(outside, '# Outside secret\n');
        try { fs.symlinkSync(outside, path.join(dir, '2026-09-09-link.md')); } catch (e) { /* no symlinks on this machine */ }
        assert.match(line(), /2026-09-09-side\.md` \(Side finding\)/);
        assert(!line().includes('old.md') && !line().includes('Outside secret') && !line().includes('link.md'), line());
        // Committed since the session counts, whatever its mtime.
        fs.writeFileSync(path.join(dir, '2026-09-10-pulled.md'), '# Pulled report\n');
        g('add', '2026-09-10-pulled.md'.replace(/^/, 'docs/handoff/results/')); g('commit', '-qm', 'pulled');
        fs.utimesSync(path.join(dir, '2026-09-10-pulled.md'), new RealDate('2020-01-01'), new RealDate('2020-01-01'));
        assert.match(line(), /2026-09-10-pulled\.md/);
    });
    await test('the main brief lists results files newer than the last session record, at most five, with their first heading', () => {
        const root = project('new-results');
        recordSession(root, { ai: 'Claude', headline: 'Main work', next: 'Go on.' });
        const dir = path.join(root, 'docs/handoff/results');
        fs.mkdirSync(dir, { recursive: true });
        for (let i = 0; i < 7; i++) fs.writeFileSync(path.join(dir, `2026-09-09-side-${i}.md`), `# Side finding ${i}\n\nbody`);
        fs.writeFileSync(path.join(dir, '2026-01-01-old.md'), '# Old report\n');
        fs.utimesSync(path.join(dir, '2026-01-01-old.md'), new RealDate('2026-01-01'), new RealDate('2026-01-01'));
        const line = buildBrief(root, { ai: 'Claude' }).split('\n').find(l => l.startsWith('New results'));
        assert(line, 'a New results line');
        assert.equal((line.match(/docs\/handoff\/results\//g) || []).length, 5);
        assert.match(line, /\(Side finding \d\)/);
        assert.match(line, /and 2 more/);
        assert(!line.includes('old.md'));
        assert(sessionBrief(root, 'Claude').includes(line), 'the line is in part 1');
    });
    await test('the tool map adds one line per active pack MCP server, and nothing when the export is absent', () => {
        const tools = ['Tools: drawers', '- research: web', ''];
        assert.deepEqual(withPackServers(tools, 'x', undefined), tools);
        const out = withPackServers(tools, 'x', () => [{ name: 'codebase-memory', pack: 'code-memory', description: 'code graph' }, 'context-mode']);
        assert.deepEqual(out, ['Tools: drawers', '- research: web', '- MCP server `codebase-memory` (pack code-memory): code graph', '- MCP server `context-mode` (skill pack)', '']);
        assert.equal(withPackServers([], 'x', () => ['a'])[0], 'Tools: MCP servers from active skill packs:');
        assert.deepEqual(withPackServers(tools, 'x', () => { throw new Error('broken pack'); }), tools);
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
    await test('the brief marks an AI-recorded decision unverified, clears it on owner verify, and names what a decision replaced', () => {
        const root = project('decision-author');
        fs.mkdirSync(path.join(root, 'src'), { recursive: true });
        fs.writeFileSync(path.join(root, 'src', 'limits.js'), 'MAX_UPLOAD_MB = 20\n');
        const ai = recordDecision(root, 'Uploads stay at 20 MB for now', { ai: 'codex', origin: 'plutos_decide' });
        const owner = recordDecision(root, 'Billing runs on Paddle', { ai: 'plutos decide', origin: 'decide-cli' });
        let brief = buildBrief(root, { ai: 'Claude', full: true });
        assert.ok(brief.includes(`(${ai.id}, recorded by codex, unverified)`), brief);
        assert.ok(brief.includes(`(${owner.id})`) && !brief.includes(`${owner.id}, recorded by`), 'an owner-path decision carries no tag');
        const swap = recordDecision(root, 'Uploads stay at 25 MB', { ai: 'gemini', origin: 'plutos_decide', supersedes: ai.id });
        brief = buildBrief(root, { ai: 'Claude', full: true });
        assert.ok(brief.includes(`(${swap.id}, recorded by gemini, unverified, replaces ${ai.id})`), brief);
        // The owner verifies a record that cites a source: the tag goes away.
        const sourced = normalizeDecided([{ decision: 'Uploads are capped in code', sources: [{ path: 'src/limits.js', evidence: 'MAX_UPLOAD_MB = 20' }] }]);
        const rec = recordDecisions(root, sourced, { ai: 'codex', origin: 'plutos_decide' }).ids[0];
        assert.ok(buildBrief(root, { ai: 'Claude', full: true }).includes(`(${rec}, recorded by codex, unverified)`));
        assert.equal(verifyMemory(root, rec).verified, true);
        assert.ok(buildBrief(root, { ai: 'Claude', full: true }).includes(`(${rec})`), 'verified reads as today');
    });
} finally {
    globalThis.Date = RealDate;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
}
console.log(`\nSession memory: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
