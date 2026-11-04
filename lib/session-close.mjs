#!/usr/bin/env node
// The session close (board P1, 2026-09-02: "nothing forces a session to open or close through
// PLUT_OS"). The SessionStart hook hands every session its brief; this closes the other end, with
// no model call:
//
//   - The SessionEnd hook (`node lib/session-close.mjs`, the Hooks panel): a session that ends with
//     work in git and no session record since it began gets one, written from git, so the next
//     brief shows what it did and says that nothing it learned or decided was recorded.
//   - unrecordedWork(), read by the claim check: a session that says its work is done while that
//     work is unrecorded is sent back once to call session_end (lib/claim-check.mjs).
//
// A session began at the first timestamp in its transcript, and it is recorded when CONTINUITY.md
// holds a session from then on or its transcript holds a session_end call. Whatever cannot be
// worked out (no transcript, no git, no CONTINUITY.md) leaves the session alone. When the
// shared-context capture is on (lib/context-automation.mjs), its SessionEnd job writes a fuller
// record with a model call, so this hook leaves that session to it.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { transcriptHasManualSessionEnd } from './context-capture.mjs';
import { isEntry } from './entry.mjs';
import { clientFromEnv } from './presence.mjs';

const tryGit = (dir, args) => {
    try { return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim(); }
    catch { return null; }
};
const MAX_SHOWN = 8;

/** The first timestamp in a transcript (JSONL, as Claude Code writes it), or null. */
export function transcriptStart(transcriptPath) {
    let text = '';
    try {
        const fd = fs.openSync(transcriptPath, 'r');
        try {
            const buffer = Buffer.alloc(256 * 1024);
            text = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8');
        } finally { fs.closeSync(fd); }
    } catch { return null; }
    for (const line of text.split('\n')) {
        try {
            const stamp = JSON.parse(line)?.timestamp;
            if (stamp && !Number.isNaN(Date.parse(stamp))) return new Date(stamp);
        } catch { /* a line cut at the buffer's end */ }
    }
    return null;
}

/** Whether CONTINUITY.md holds a session written at or after `since`. */
function recordedSince(root, since) {
    let text;
    try { text = fs.readFileSync(path.join(root, 'docs', 'handoff', 'CONTINUITY.md'), 'utf8'); } catch { return true; }
    return [...text.matchAll(/^### (\d{4}-\d{2}-\d{2}T\S+) · /gm)].some(m => Date.parse(m[1]) >= since.getTime());
}

/** What a session did that no record holds: { root, since, commits: ['abc1234 subject'], changed },
 *  or null when it is recorded, left nothing in git, or cannot be worked out. */
export function unrecordedWork(dir, transcriptPath) {
    const since = transcriptPath ? transcriptStart(transcriptPath) : null;
    const root = since && tryGit(dir, ['rev-parse', '--show-toplevel']);
    if (!root || recordedSince(root, since) || transcriptHasManualSessionEnd(transcriptPath)) return null;
    const commits = (tryGit(root, ['log', `--since=${since.toISOString()}`, '--format=%h %s', '-n', '50']) || '').split('\n').filter(Boolean);
    const changed = (tryGit(root, ['status', '--porcelain']) || '').split('\n').filter(Boolean).length;
    return commits.length || changed ? { root, since, commits, changed } : null;
}

/** The SessionEnd hook: records an unrecorded session from git. Returns the record, or null. */
export async function closeSession(input = {}, { env = process.env } = {}) {
    const work = unrecordedWork(env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd(), input.transcript_path);
    if (!work) return null;
    const { contextAutomationStatus } = await import('./context-automation.mjs');
    if (contextAutomationStatus(work.root).events?.SessionEnd) return null;
    const { recordSession } = await import('./continuity.mjs');
    const shown = work.commits.slice(0, MAX_SHOWN);
    const did = [
        shown.length ? `Commits: ${shown.join('; ')}${work.commits.length > shown.length ? `; and ${work.commits.length - shown.length} more` : ''}` : 'No commits',
        work.changed ? `${work.changed} uncommitted file(s) left at the end` : '',
    ].filter(Boolean).join('. ');
    return recordSession(work.root, {
        // The client that fired the hook, from its environment: the hook has no handshake.
        ai: clientFromEnv(env) || 'AI Client',
        headline: 'Ended without session_end: recorded from git by the SessionEnd hook',
        did: `${did}.`,
        notChecked: `The session ended (${String(input.reason || 'reason not given').slice(0, 40)}) without calling session_end, so nothing it learned or decided was recorded; this entry comes from git alone.`,
        origin: 'session-close-hook',
    });
}

// The hook reads its event from stdin and never fails the session's end: SessionEnd cannot be blocked.
if (isEntry(import.meta.url)) {
    let input = {};
    try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { /* no event: nothing to close */ }
    closeSession(input)
        .then(r => { if (r && !r.duplicate) console.error('PLUT_OS recorded this session from git: session_end was not called.'); })
        .catch(e => console.error(`PLUT_OS session close: ${e.message}`))
        .finally(() => process.exit(0));
}
