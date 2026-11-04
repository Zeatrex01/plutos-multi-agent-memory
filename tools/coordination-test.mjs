// Coordination correctness: a board entry goes to the AI it names and no one with a similar name
// (B24); a ticket's recorded result is never trusted on a forged file (S10); the handoff state
// and its log are written atomically and the log stays bounded (D5, D7); the session brief's byte
// cap holds over the whole reply (B19); the pending-ticket limit is kept under a lock (D9).
import fs from 'fs';
import os from 'os';
import path from 'path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-coordination-home-'));
process.env.PLUTOS_HOME = home;
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-coordination-project-'));
const { sameAi: aiMatches } = await import('../lib/board.mjs');
const { createApproval, answerApproval, runApprovedAction, readApproval, approvalsDir, askSeal } = await import('../lib/approvals.mjs');
const { updateState, readState, LOG_KEEP } = await import('../lib/state.mjs');
const { boundedBrief, buildBrief, recordSession, CONTINUITY_LIMITS } = await import('../lib/continuity.mjs');
const { writeBoardEntry } = await import('../lib/board-store.mjs');

let passed = 0, failed = 0;
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ok  ${name}`); } else { failed++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); } };
const throws = fn => { try { fn(); return ''; } catch (e) { return e.message; } };

try {
    // --- B24: identities match at a word boundary, never inside a hyphenated name ---
    check('an AI name matches its board entry exactly, case-insensitively', aiMatches('Claude Code', 'claude code'));
    check('a short name matches a name it is the first word of ("claude" ~ "Claude Code")', aiMatches('Claude Code', 'claude') && aiMatches('claude', 'Claude Code'));
    check('a shorter name never claims a hyphenated sibling ("codex" is not "codex-reviewer")', !aiMatches('codex', 'codex-reviewer') && !aiMatches('codex-reviewer', 'codex'));
    check('a substring inside a word is not a match ("ode" is not "codex")', !aiMatches('codex', 'ode') && !aiMatches('Antigravity', 'gravity'));

    // --- the brief's board part follows the same identity rule ---
    writeBoardEntry(project, { agent: 'Claude', status: 'TODO', title: 'Own backlog item', task: 'BACKLOG-DETAIL' });
    writeBoardEntry(project, { agent: 'Gemini', status: 'TODO', title: 'Assigned review', task: 'ASSIGNED-DETAIL', assignee: 'Claude' });
    writeBoardEntry(project, { agent: 'Claude', status: 'TODO', title: 'Handed to Gemini', assignee: 'Gemini' });
    const brief = buildBrief(project, { ai: 'Claude Code' });
    const mine = brief.split('## Assigned to you')[1]?.split('\n## ')[0] || '';
    check('a "Claude Code" session sees the work the board gives "Claude"', mine.includes('Assigned review') && mine.includes('Own backlog item'));
    check('an assignment arrives with its task; your own backlog arrives as its title', mine.includes('ASSIGNED-DETAIL') && !brief.includes('BACKLOG-DETAIL'));
    check('an entry you assigned to another AI is theirs, not yours', !mine.includes('Handed to Gemini') && brief.includes('Gemini: Handed to Gemini'));
    recordSession(project, { ai: 'Claude', headline: 'many decisions', decided: Array.from({ length: 14 }, (_, i) => `settled choice ${i + 1}`) });
    const decided = buildBrief(project, { ai: 'Claude', full: true });
    check('the full brief shows the newest 12 decisions and counts the rest', (decided.match(/\*\*Decided:\*\*/g) || []).length === 12
        && decided.includes('settled choice 14') && !decided.includes('settled choice 2\n') && decided.includes('…and 2 older one(s)'));
    const short = buildBrief(project, { ai: 'Claude' });
    check('the session brief shows the newest 3 and counts the rest', (short.match(/^- ⚖️ /gm) || []).length === 3
        && short.includes('settled choice 14') && short.includes('settled choice 12') && !short.includes('settled choice 11') && short.includes('…and 11 older one(s)'));

    // --- S10: a forged result is never returned as done. The ticket is minted in the shape of
    // before 2026-11-04 (the only tickets that carry an action), sealed with the real key.
    const action = { kind: 'profile_full', projectRoot: project, packageId: 'profile:full', version: 'a'.repeat(64), target: 'full', proposal: { kernel: 'Claude Code', casts: [] } };
    const now = Date.now();
    const ticket = { id: `ask-${now.toString(36)}-abcdef`, agent: 'Codex', question: 'Cast?', context: null, options: null, action,
        status: 'pending', note: null, option: null, tier: 'T2', createdAt: now, expiresAt: now + 30 * 60_000, answeredAt: null, answeredVia: null };
    ticket.askSeal = askSeal(ticket);
    fs.mkdirSync(approvalsDir(project), { recursive: true });
    const file = path.join(approvalsDir(project), `${ticket.id}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...ticket, actionResult: { status: 'succeeded', detail: 'forged', completedAt: Date.now() } }));
    check('the ticket from before the cut still reads as pending', readApproval(project, ticket.id)?.status === 'pending');
    let ran = false;
    const message = throws(() => runApprovedAction(project, ticket.id, action, () => { ran = true; return 'ran'; }));
    check('a forged "succeeded" on an unsealed ticket is refused, not returned as done', /Invalid approval action|changed outside PLUTOS/.test(message) && !ran, message);

    // --- D9: the pending limit is counted under a lock ---
    for (let i = 0; i < 19; i++) createApproval(project, { agent: 'Codex', question: `q${i}` });
    check('the 20th pending question is refused', /20 questions are already waiting/.test(throws(() => createApproval(project, { agent: 'Codex', question: 'one more' }))));
    check('the pending lock is released after the refusal', !fs.existsSync(path.join(approvalsDir(project), 'pending.lock')));
    answerApproval(project, ticket.id, { decision: 'rejected' });
    check('answering one frees a slot', !throws(() => createApproval(project, { agent: 'Codex', question: 'now it fits' })));

    // --- D5 / D7: atomic state, bounded log ---
    const stateProject = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-coordination-state-'));
    for (let i = 0; i < LOG_KEEP + 25; i++) updateState(stateProject, { taskName: `task ${i}`, status: 'DONE', notes: i === 3 ? 'two\nlines' : '' });
    const logLines = fs.readFileSync(path.join(stateProject, '.plutos', 'logs', 'activity.log'), 'utf8').split('\n').filter(Boolean);
    check(`the activity log keeps the last ${LOG_KEEP} lines`, logLines.length === LOG_KEEP && logLines.at(-1).includes(`task ${LOG_KEEP + 24}`) && logLines[0].includes('task 25'), String(logLines.length));
    check('a note with a newline stays one log line', !logLines.some(l => l.startsWith('lines')));
    const read = readState(stateProject);
    check('readState returns the last state and the newest twenty lines first', read.state.lastTask === `task ${LOG_KEEP + 24}` && read.recent.length === 20 && read.recent[0].includes(`task ${LOG_KEEP + 24}`));
    check('no lock or temp file is left beside the state files', !fs.readdirSync(path.join(stateProject, '.plutos')).some(n => /\.lock|\.tmp/.test(n)) && !fs.readdirSync(path.join(stateProject, '.plutos', 'logs')).some(n => /\.lock|\.tmp/.test(n)));
    fs.rmSync(stateProject, { recursive: true, force: true });

    // --- B19: the cap over the whole reply ---
    const big = 'x'.repeat(CONTINUITY_LIMITS.briefBytes + 5000);
    const capped = boundedBrief(big);
    check('boundedBrief holds the byte cap and says it truncated', Buffer.byteLength(capped) <= CONTINUITY_LIMITS.briefBytes && /truncated/.test(capped));
    check('boundedBrief leaves a short text alone', boundedBrief('short') === 'short');
} finally {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
}
console.log(`Coordination: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
