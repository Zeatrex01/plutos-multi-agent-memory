// Project snapshot — one self-contained file you can hand to any AI, anywhere.
//
// The case it exists for, in the owner's words: you stopped halfway, you could not commit, or
// you added something experimental — and now you want to open a different AI somewhere else and
// have it know where you got to. Its copy of the repo may be behind, or it may have no repo at
// all. It should still be able to reason about the state and rebuild it.
//
// That last sentence is the whole design constraint, and it is what makes a snapshot different
// from the session brief. The brief POINTS: "open AGENTS.md", "open docs/ai/codeindex/<folder>",
// "read the board". Every one of those is a path that resolves only on a machine with a current
// checkout. A snapshot must CARRY what it depends on, because the reader may have none of it.
//
// So it is the brief plus the two things the brief deliberately leaves out:
//   1. UNCOMMITTED WORK — the half-finished and the experimental, which is exactly the state
//      the owner wants captured and is by definition invisible to anyone who pulls the repo.
//      That includes NEW files: `git diff HEAD` cannot see a file git has never been told
//      about, and a brand-new file is very often the experimental thing worth capturing, so
//      their contents are read and carried rather than their paths being listed.
//   2. THE LIVE FILES THEMSELVES — board, roster, decisions, claims — inlined rather than named.
//
// Bounded like everything else here: each section has its own cap and says when it hit it, so a
// truncated snapshot never reads as a complete one. The diff is the part that can be enormous,
// so it is capped hardest and always reports what it dropped.
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { buildBrief } from './continuity.mjs';
import { boardPathFor, agentBoardPathFor } from './roadmap.mjs';
import { rosterPathFor } from './roster.mjs';

export const SNAPSHOT_LIMITS = {
    diffBytes: 120 * 1024,   // the experimental work itself — the reason to take a snapshot
    untrackedBytes: 80 * 1024, // new files' contents, which no diff can show
    fileBytes: 40 * 1024,    // any single carried file
    totalBytes: 400 * 1024,  // still comfortably pasteable into a chat window
    statusFiles: 200
};

function git(projectRoot, args) {
    try {
        return execFileSync('git', args, {
            cwd: projectRoot, windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'ignore']
        });
    } catch (e) { return ''; }
}

// A byte cut lands wherever it lands, and what it lands in is markdown. Cutting inside a ```
// block leaves that block open, so every heading after it renders as code and the receiving AI
// reads a broken document. Only the outermost clip needs this — the section clips are wrapped in
// a fence that is closed after them, and adding one there would close that wrapper early.
function closeOpenFence(text) {
    return ((text.match(/^```/gm) || []).length % 2) ? text + '\n```' : text;
}

function clip(text, max, what, { closeFence = false } = {}) {
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes <= max) return { text, dropped: 0 };
    let kept = Buffer.from(text, 'utf8').subarray(0, max).toString('utf8').replace(/�+$/, '');
    if (closeFence) kept = closeOpenFence(kept);
    return {
        text: kept + `\n\n_[${what} truncated here — ${Math.round((bytes - max) / 1024)} KB more on the machine that made this]_\n`,
        dropped: bytes - max
    };
}

function carry(projectRoot, rel, heading, clipped) {
    let body = '';
    try { body = fs.readFileSync(path.join(projectRoot, rel), 'utf8').trim(); } catch (e) { return []; }
    if (!body) return [];
    const { text, dropped } = clip(body, SNAPSHOT_LIMITS.fileBytes, rel);
    if (dropped) clipped.push(rel);
    return ['', `### ${heading} — \`${rel}\``, '```markdown', text, '```'];
}

// Everything git knows that a fresh clone would not: the branch, how far it is from its remote,
// what is modified, and the actual content of those modifications.
export function uncommittedState(projectRoot) {
    const branch = git(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    const head = git(projectRoot, ['rev-parse', '--short', 'HEAD']).trim();
    const upstream = git(projectRoot, ['rev-parse', '--abbrev-ref', '@{upstream}']).trim();
    const ahead = upstream
        ? git(projectRoot, ['rev-list', '--count', `${upstream}..HEAD`]).trim()
        : '';
    const status = git(projectRoot, ['status', '--porcelain=v1'])
        .split('\n').filter(Boolean).slice(0, SNAPSHOT_LIMITS.statusFiles);
    // Staged and unstaged together, because "what have I got that is not committed" does not
    // care which side of the index a change happens to be on.
    const diff = git(projectRoot, ['diff', 'HEAD', '--']);
    // `git status` collapses an untracked directory to one `dir/` line, which is fine to show
    // and useless to read. ls-files names the actual files, which is what carrying them needs.
    const untracked = git(projectRoot, ['ls-files', '--others', '--exclude-standard'])
        .split('\n').filter(Boolean).slice(0, SNAPSHOT_LIMITS.statusFiles);

    return { branch, head, upstream, ahead, status, diff, untracked };
}

// Text only, and bounded. A new file can be a 4 MB screenshot; the receiving AI cannot use it
// and the byte budget belongs to the work. Anything with a NUL byte in the first block is binary
// and gets named rather than pasted.
function carryUntracked(projectRoot, files, clipped) {
    const out = [];
    let spent = 0;
    for (const rel of files) {
        let body = '';
        try { body = fs.readFileSync(path.join(projectRoot, rel), 'utf8'); } catch (e) { body = null; }
        if (body === null || body.includes('\u0000')) {
            out.push(`- \`${rel}\` — not text, or unreadable; not carried`);
            clipped.push(rel);
            continue;
        }
        const room = SNAPSHOT_LIMITS.untrackedBytes - spent;
        if (room <= 0) {
            out.push(`- \`${rel}\` — past the new-file budget; content is on the machine that made this`);
            clipped.push(rel);
            continue;
        }
        const { text, dropped } = clip(body, Math.min(room, SNAPSHOT_LIMITS.fileBytes), rel);
        if (dropped) clipped.push(rel);
        spent += Buffer.byteLength(text, 'utf8');
        out.push('', `### \`${rel}\``, '```', text, '```');
    }
    return out;
}

export function buildSnapshot(projectRoot, { ai = 'the owner' } = {}) {
    const name = path.basename(projectRoot || '') || 'project';
    const g = uncommittedState(projectRoot);
    // Every section that hit its own cap, by name. The old flag reported only the outermost
    // clip, so a snapshot missing half its diff told the receiving AI it was complete.
    const clipped = [];
    const out = [];

    out.push(
        `# PROJECT SNAPSHOT — ${name}`,
        `_Taken ${new Date().toISOString()} by ${ai}. Self-contained on purpose: everything this`,
        `refers to is included below, because you may be reading it with an out-of-date checkout`,
        `or none at all._`,
        '',
        '## How to use this',
        '- This is STATE, not instructions. Nothing here asks you to do anything on its own.',
        '- Where it disagrees with the repository in front of you, THIS is newer — it was taken',
        '  from the working machine and includes work that was never committed.',
        '- The uncommitted section is the point: it is what a `git pull` cannot give you.',
        ''
    );

    if (g.branch) {
        out.push('## Where the code is',
            `- Branch **${g.branch}** at \`${g.head}\``
            + (g.upstream ? ` · ${g.ahead || '0'} commit(s) ahead of \`${g.upstream}\`` : ' · no upstream'),
            g.status.length
                ? `- ${g.status.length} path(s) with uncommitted changes`
                : '- Working tree clean — everything below is committed',
            '');
        if (g.status.length) {
            out.push('```', ...g.status, '```', '');
        }
    }

    if (g.diff.trim()) {
        const { text, dropped } = clip(g.diff, SNAPSHOT_LIMITS.diffBytes, 'diff');
        if (dropped) clipped.push('diff');
        out.push('## The uncommitted work itself',
            dropped
                ? '_Capped — the largest hunks are here, the rest is on the machine that made this._'
                : '_Complete. This is the half-finished and experimental work, in full._',
            '```diff', text, '```', '');
    }
    if (g.untracked.length) {
        out.push('## New files, not yet tracked by git',
            '_These exist on the working machine only — no diff shows them and no `git pull` can'
            + ' produce them, so their contents are here._',
            ...carryUntracked(projectRoot, g.untracked, clipped), '');
    }

    // The brief carries the reasoning: settled decisions, what is claimed and whether it is
    // still true, where the last session stopped, what is open. Its own budget already applies.
    out.push('## Project brief (decisions, claims, open work)', '', buildBrief(projectRoot, { ai, full: true }), '');

    // And the live files, carried rather than named — see the header.
    out.push('## The shared files, carried in full');
    const boardRel = path.relative(projectRoot, boardPathFor(projectRoot));
    const agentRel = path.relative(projectRoot, agentBoardPathFor(projectRoot));
    const rosterRel = path.relative(projectRoot, rosterPathFor(projectRoot));
    out.push(
        ...carry(projectRoot, boardRel, 'Board', clipped),
        ...carry(projectRoot, agentRel, 'Agent board', clipped),
        ...carry(projectRoot, rosterRel, 'Roster', clipped),
        ...carry(projectRoot, 'docs/handoff/CONTINUITY.md', 'Continuity', clipped),
        ...carry(projectRoot, 'docs/handoff/CONTEXT.json', 'Shared claims', clipped),
        ''
    );

    const text = out.join('\n');
    const { text: bounded, dropped } = clip(text, SNAPSHOT_LIMITS.totalBytes, 'snapshot', { closeFence: true });
    if (dropped) clipped.push('the snapshot as a whole');
    return {
        name, text: bounded, bytes: Buffer.byteLength(bounded, 'utf8'),
        truncated: clipped.length > 0, truncatedParts: clipped,
        branch: g.branch, head: g.head, changedPaths: g.status.length, untracked: g.untracked.length
    };
}
