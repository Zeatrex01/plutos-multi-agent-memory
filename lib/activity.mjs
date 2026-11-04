// Live activity — "what is happening in this project right now".
//
// Scope, stated honestly because it is easy to expect more: PLUT_OS cannot see an AI's
// terminal. Claude Code, Cursor and the rest run as separate processes in their own
// windows, and no dashboard can attach to them. What PLUT_OS *can* see is the evidence
// those tools leave on disk as they work, and that turns out to be the interesting part:
//
//   - the working tree, which is literally the file the AI is editing this second
//   - new commits, which is work becoming permanent
//   - writes to the coordination files (boards, roster, session memory), which is the
//     AI telling everyone else what it is doing
//
// Everything here is READ-ONLY and derived on request; nothing is stored, so it cannot go
// stale. Every git call is bounded by a timeout and every failure degrades to "unknown"
// rather than throwing — a dashboard panel must never be able to take the server down.
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { boardPathFor, agentBoardPathFor } from './roadmap.mjs';
import { rosterPathFor } from './roster.mjs';
import { continuityPathFor } from './continuity.mjs';
import { contextPathFor } from './context.mjs';
import { participants, describeAge } from './presence.mjs';
import { detectTier } from './mcps.mjs';
import { projectReadiness } from './readiness.mjs';

export const ACTIVITY_LIMITS = {
    dirtyFiles: 40,      // working-tree entries returned (dirtyCount still reports the truth)
    commits: 5,          // recent commits in the strip
    gitTimeoutMs: 4000   // a slow/locked repo must not hang the request
};

// trim defaults to true, but `status --porcelain` MUST NOT be trimmed: its first field is
// the two-column status code, and an unstaged change starts with a space (" M path").
// Trimming eats that space and shifts every field by one, which silently truncates the
// first filename — it read "ashboard.mjs" before this was caught.
function git(projectRoot, args, { trim = true } = {}) {
    const out = execFileSync('git', args, {
        cwd: projectRoot,
        windowsHide: true,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: ACTIVITY_LIMITS.gitTimeoutMs,
        maxBuffer: 4 * 1024 * 1024
    });
    return trim ? out.trim() : out;
}

// git status --porcelain codes → something a human can read. The two columns are
// (index, working tree); we report whichever side actually changed.
function describeStatus(code) {
    if (code === '??') return 'untracked';
    const c = code.replace(/ /g, '');
    if (c.includes('D')) return 'deleted';
    if (c.includes('A')) return 'added';
    if (c.includes('R')) return 'renamed';
    if (c.includes('M')) return 'modified';
    return 'changed';
}

function mtimeOf(file) {
    try { return fs.statSync(file).mtime.toISOString(); } catch (e) { return null; }
}

// The coordination files an AI writes when it participates: the two boards, the roster,
// the session memory. A fresh mtime here means an AI just said something.
function coordinationFiles(projectRoot) {
    const candidates = [
        { name: 'BOARD.md', file: boardPathFor(projectRoot) },
        { name: 'AGENT_BOARD.md', file: agentBoardPathFor(projectRoot) },
        { name: 'ROSTER.md', file: rosterPathFor(projectRoot) },
        { name: 'CONTINUITY.md', file: continuityPathFor(projectRoot) },
        { name: 'CONTEXT.json', file: contextPathFor(projectRoot) }
    ];
    return candidates
        .map(c => ({ name: c.name, mtime: mtimeOf(c.file) }))
        .filter(c => c.mtime)
        .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
}

// → { at, isGitRepo, branch, head, dirty[], dirtyCount, commits[], coordination[], fingerprint }
// Never throws: any part that cannot be determined comes back null/empty.
export function getActivity(projectRoot) {
    const at = new Date().toISOString();
    if (!projectRoot || !fs.existsSync(projectRoot)) {
        return { at, hasProject: false, isGitRepo: false, branch: null, head: null, dirty: [], dirtyCount: 0, commits: [], coordination: [], participants: [], setup: null, readiness: null, fingerprint: 'no-project' };
    }

    let isGitRepo = true, branch = null, head = null, commits = [];
    let dirty = [], dirtyCount = 0;

    try {
        branch = git(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
    } catch (e) {
        isGitRepo = false;
    }

    if (isGitRepo) {
        try {
            const raw = git(projectRoot, ['log', '-n', String(ACTIVITY_LIMITS.commits), '--pretty=%h%cI%s'])
                .split('\n').filter(Boolean);
            commits = raw.map(l => {
                const [hash, date, ...rest] = l.split('');
                return { hash, date, subject: rest.join('') };
            });
            head = commits[0] || null;
        } catch (e) { /* a repo with no commits yet — leave head null */ }

        try {
            // -z: NUL-separated, so a path with a newline or a quote cannot desync the parse.
            const raw = git(projectRoot, ['status', '--porcelain', '-z', '--untracked-files=normal'], { trim: false });
            const entries = raw.split('\0').filter(Boolean);
            const all = [];
            for (let i = 0; i < entries.length; i++) {
                const e = entries[i];
                const code = e.slice(0, 2);
                let file = e.slice(3);
                // A rename entry is followed by its origin path as a separate record.
                if (code.replace(/ /g, '').includes('R')) i++;
                if (!file) continue;
                all.push({ path: file, kind: describeStatus(code), mtime: mtimeOf(path.join(projectRoot, file)) });
            }
            dirtyCount = all.length;
            // Newest first: the file being edited right now belongs at the top.
            all.sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''));
            dirty = all.slice(0, ACTIVITY_LIMITS.dirtyFiles);
        } catch (e) { /* status unavailable — report the repo without a working-tree view */ }
    }

    const coordination = coordinationFiles(projectRoot);

    // Who else is on this project belongs in "what is happening right now" — and folding it
    // in here keeps the strip on ONE poll instead of two requests every five seconds.
    // `fresh` is the 30-minute window: recent enough that the AI is plausibly still working.
    const peers = participants(projectRoot).map(p => ({
        name: p.name,
        age: describeAge(p.minutesAgo),
        fresh: p.minutesAgo !== null && p.minutesAgo < 30
    }));

    // The setup tier measures native PLUT_OS only. Third-party MCPs remain visible in MCP
    // Manager but their absence is not a degraded state and must not nag in the activity bar.
    let setup = null;
    try {
        const { tier, missing } = detectTier(projectRoot);
        setup = { tier, missing };
    } catch (e) { /* unreadable .mcp.json — say nothing rather than guess */ }

    // Where the project stands. The AIs get this in their briefing; the owner sees the same
    // progression instead of a first screen that looks empty for no stated reason.
    let readiness = null;
    try { readiness = projectReadiness(projectRoot); } catch (e) { /* never block the strip */ }

    // A cheap change token. The client polls; when this is unchanged it knows nothing moved
    // and can skip re-rendering (and skip flashing the panel at the user for no reason).
    const fingerprint = [
        head ? head.hash : 'nohead',
        String(dirtyCount),
        dirty.map(d => `${d.kind}:${d.path}:${d.mtime || ''}`).join('|'),
        coordination.map(c => `${c.name}:${c.mtime}`).join('|'),
        peers.map(p => `${p.name}:${p.age}`).join('|'),
        setup ? `${setup.tier}:${setup.missing.join(',')}` : 'notier',
        readiness ? readiness.stage : 'nostage'
    ].join('~');

    return { at, hasProject: true, isGitRepo, branch, head, dirty, dirtyCount, commits, coordination, participants: peers, setup, readiness, fingerprint };
}
