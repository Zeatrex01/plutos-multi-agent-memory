// Project readiness — what this project has, and therefore what can honestly be done in it.
//
// The gap this closes: "first it learns a project ... only then
// does it become active — it cannot critique from scratch anyway". Exactly right, and the
// dependency was never expressed anywhere. The intake step existed (AGENTS.md Rule 1) and the
// brief even pointed at it, but nothing said that reviewing,
// comparing or advising REQUIRES it. An AI could open a project it had never read and start
// producing verdicts, and the system would happily record them.
//
// It also fixes the cold start. A first session's brief was mostly empty — no map, no
// sessions, no board — which reads as "this product does nothing" rather than "you are at
// the beginning". Stages turn that emptiness into a path.
//
// Three stages, each defined by evidence on disk rather than by a stored flag, so it cannot
// go stale or be set to a lie:
//   1 unmapped  — nobody has understood this project yet. Intake is the only honest move.
//   2 mapped    — the map exists: normal work can proceed (board, tasks, sessions).
//   3 informed  — there is also history (sessions/decisions). Only here does review or
//                 comparison have something to be right or wrong about.
import fs from 'fs';
import path from 'path';
import { continuityPathFor, parseContinuity } from './continuity.mjs';
import { boardPathFor } from './roadmap.mjs';
import { parseBoardEntries } from './board.mjs';

// Enough recorded history that a review has ground to stand on. Two is deliberate: one
// session is an anecdote, and waiting for more would keep the stage locked for weeks.
const INFORMED_SESSIONS = 2;

function readIfExists(file) {
    try { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null; } catch (e) { return null; }
}

// → { stage, has: {...}, next: {…}|null, blocked: [..] }
// Never throws: an unreadable project reports stage 'unmapped' rather than failing a brief.
export function projectReadiness(projectRoot) {
    const empty = { stage: 'unmapped', has: { map: false, sessions: 0, boardEntries: 0 }, next: null, blocked: [] };
    if (!projectRoot || !fs.existsSync(projectRoot)) return empty;

    const mapText = readIfExists(path.join(projectRoot, 'docs', 'ai', 'PROJECT_MAP.md'));
    // A map that exists but says nothing is not a map. The scaffolded placeholder is short;
    // a real intake writes paragraphs.
    const map = !!(mapText && mapText.trim().length > 200);

    let sessions = 0;
    const cont = readIfExists(continuityPathFor(projectRoot));
    if (cont) {
        try { sessions = parseContinuity(cont).sessions.length; } catch (e) { sessions = 0; }
    }

    let boardEntries = 0;
    const board = readIfExists(boardPathFor(projectRoot));
    if (board) {
        try { boardEntries = parseBoardEntries(board).length; } catch (e) { boardEntries = 0; }
    }

    const stage = !map ? 'unmapped' : (sessions >= INFORMED_SESSIONS ? 'informed' : 'mapped');

    // What to do next, and what it opens up. Phrased as guidance, never as a refusal —
    // PLUT_OS does not block an AI, it tells it what it is standing on.
    const next = stage === 'unmapped'
        ? {
            action: 'Read the project (AGENTS.md Rule 1) and write docs/ai/PROJECT_MAP.md.',
            why: 'Nobody has read this project yet. Reviewing, comparing or advising on it now would be guesswork.'
        }
        : stage === 'mapped'
            ? {
                action: 'Do the work: claim a board task, and close the session with session_end (what changed, what you learned).',
                why: `Review and comparison need history to judge against — ${INFORMED_SESSIONS} recorded sessions unlock them.`
            }
            : null;

    // Work that needs more than this project currently has.
    const blocked = stage === 'unmapped'
        ? ['review / critique', 'comparison against alternatives', 'architecture advice']
        : stage === 'mapped'
            ? ['review that weighs decisions against their outcomes']
            : [];

    return { stage, has: { map, sessions, boardEntries }, next, blocked };
}

// One short block for the session brief. Silent at 'informed': a project that is ready
// should not be told so on every single session.
export function readinessBrief(projectRoot) {
    const r = projectReadiness(projectRoot);
    if (r.stage === 'informed') return [];
    const out = [`## Project readiness: ${r.stage}`];
    if (r.next) out.push(`- **Next:** ${r.next.action}`, `- **Why:** ${r.next.why}`);
    if (r.blocked.length) out.push(`- **Not yet grounded:** ${r.blocked.join('; ')} — do the above first.`);
    out.push('');
    return out;
}
