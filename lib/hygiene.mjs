// Document hygiene — the mechanical half of "the board is a live workbench, not an archive".
//
// AGENTS.md has always said boards stay short and stale DONE entries get moved off, but
// nothing ever checked: a rule no one measures is a rule that quietly rots. Two failure modes
// this module makes visible (and fixable) instead of silent:
//   1. Bloat — boards and memory files grow until an AI reading them skims the middle and
//      loses exactly the detail it needed ("lost in the middle"). Budgets below are numbers, not adjectives, because "keep it short" is not a
//      constraint an agent can verify itself against.
//   2. Staleness — PROJECT_MAP.md / CODEINDEX.md describing a codebase that moved on. Measured
//      the only honest way: how many commits landed since the doc was last committed.
//
// Everything here is read-only reporting except archiveDoneEntries(), which is the one-click
// mechanical cleanup — no AI needed to tidy a board.
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { historyGit } from './git-history.mjs';
import { findBlocks, parseBoardEntries } from './board.mjs';
import { updateFileAtomically } from './atomic.mjs';
import { joinLines } from './lines.mjs';
import { boardPathFor } from './roadmap.mjs';
import { claimLog } from './claim-check.mjs';
import { isSourceNewerThan, GENERIC_EXTS } from './codeindex.mjs';

// Tunable in one place. Chosen to be generous — these flag genuine neglect, not normal use.
export const BUDGETS = {
    activeEntries: 10,          // non-DONE entries on one board
    doneEntries: 3,             // DONE entries sitting unarchived
    boardBytes: 20 * 1024,      // a board past this is being used as an archive
    entryLines: 8,              // one entry block (header + fields + notes)
    docCommitsBehind: 30,       // commits since the map/index was last committed
    driftCommitsBehind: 5,      // grace window before stale references are raised as drift
    resultsFiles: 20,           // reports in results/ — cold storage, not the brief
    resultsBytes: 400 * 1024,   // total size of those reports
    memoryBytes: 8 * 1024,      // one MEMORY.md (~2 pages of distilled lessons)
    generatedBytes: 200 * 1024  // CODEINDEX / OBSIDIAN_INDEX overwrite in place
};

// The main board may still be a legacy root BOARD.md; resolve it the way every reader does.
const boardFile = (projectRoot, board) => board.key === 'board' ? boardPathFor(projectRoot) : path.join(projectRoot, ...board.rel);

const BOARDS = [
    { key: 'board', name: 'BOARD.md', rel: ['docs', 'handoff', 'BOARD.md'] },
    { key: 'agents', name: 'AGENT_BOARD.md', rel: ['docs', 'handoff', 'AGENT_BOARD.md'] }
];

const TRACKED_DOCS = [
    { name: 'PROJECT_MAP.md', rel: ['docs', 'ai', 'PROJECT_MAP.md'], hint: 'read the project again and refresh it' },
    { name: 'CODEINDEX.md', rel: ['docs', 'ai', 'CODEINDEX.md'], hint: 'rescan from the Code map page' }
];

// Every query here reads history only, so it is answered once per repository state.
function git(projectRoot, args) {
    return historyGit(projectRoot, args);
}

// → { commitsBehind, lastCommit } or null when git/history can't answer (not a repo, never committed)
export function commitsSinceDocChanged(projectRoot, relPath) {
    try {
        const sha = git(projectRoot, ['log', '-1', '--format=%H', '--', relPath]);
        if (!sha) return null; // tracked doc that was never committed
        const date = git(projectRoot, ['log', '-1', '--format=%cI', sha]);
        const behind = Number(git(projectRoot, ['rev-list', '--count', `${sha}..HEAD`]));
        return { commitsBehind: Number.isFinite(behind) ? behind : 0, lastCommit: date };
    } catch (e) {
        return null;
    }
}

// --- Doc drift ---------------------------------------------------------------
//
// The budgets above catch a document that grew too big. This catches the other failure, the
// one that actually bit this project: a document that quietly stopped being true. Measured
// against the files the document itself names — a path in backticks, or a markdown link that
// resolves to a real file — so a doc is only called stale when something it actually
// describes changed after it was last committed. Raw commit count is the wrong signal alone:
// a README does not rot because someone edited a shader it never mentions.
//
// Complements analyzeDoc() above rather than repeating it: that one asks "is this generated
// map old", this one asks "did the code under this prose move".
const DRIFT_WINDOW = 1000;  // commits scanned; a doc older than the window is reported
                            // against the window only — it under-reports, never invents

const REF_PATTERNS = [
    /`([^`\n]+)`/g,     // `lib/codeindex.mjs`
    /\]\(([^)\s]+)\)/g  // [scanner](lib/codeindex.mjs)
];

// A dated audit or competitive scan is SUPPOSED to describe the code as it was. Left
// unmarked it drifts further every week and never gets fixed, which trains everyone to
// ignore the amber — one permanent false alarm is enough to kill a warning system. An HTML
// comment because it is machine-readable, invisible when rendered, and cannot be tripped by
// prose the way a phrase could.
const SNAPSHOT_MARKER = '<!-- plutos:snapshot -->';

function isSnapshot(content) {
    return content.split(/\r?\n/, 12).some(l => l.includes(SNAPSHOT_MARKER));
}

// Repo files the doc names. Other markdown is skipped on purpose: this measures doc-vs-code
// drift, and doc-to-doc links are already drawn as edges in the Document Hub.
export function referencedFiles(projectRoot, docRel) {
    let content;
    try { content = fs.readFileSync(path.join(projectRoot, docRel), 'utf8'); } catch (e) { return []; }

    const refs = new Set();
    for (const re of REF_PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(content))) {
            const raw = m[1].trim().replace(/^\.\//, '').split('#')[0].replace(/\\/g, '/');
            if (!raw || /\s/.test(raw) || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue; // prose, URLs
            if (raw.endsWith('.md')) continue;
            if (raw.startsWith('/') || raw.includes('..')) continue;
            if (!raw.includes('/') && !/\.\w{1,5}$/.test(raw)) continue;              // bare words
            try {
                if (fs.statSync(path.join(projectRoot, raw)).isFile()) refs.add(raw);
            } catch (e) { /* named but not present — nothing to compare against */ }
        }
    }
    return [...refs];
}

// → { '<rel path>': { tracked, commitsBehind, lastCommit, referenced, staleRefs } }
// Every requested path gets an entry; `tracked: false` means git had no answer (uncommitted
// file, no repo, or older than the window) and the UI must say nothing rather than guess.
export function docDrift(projectRoot, relPaths) {
    const out = {};
    for (const rel of relPaths) {
        out[rel] = { tracked: false, snapshot: false, commitsBehind: null, lastCommit: null, referenced: 0, staleRefs: [] };
    }
    if (!projectRoot || !relPaths.length) return out;

    let log;
    try {
        log = git(projectRoot, ['log', '-n', String(DRIFT_WINDOW), '--format=%x01%H %cI', '--name-only']);
    } catch (e) {
        return out;
    }

    // One pass: commit order plus the files each commit touched.
    const commits = [];
    for (const line of log.split(/\r?\n/)) {
        if (line.startsWith('\u0001')) {
            const [sha, date] = line.slice(1).split(' ');
            commits.push({ sha, date, files: [] });
        } else if (line.trim() && commits.length) {
            commits[commits.length - 1].files.push(line.trim());
        }
    }

    // Newest commit that touched each path — index 0 is HEAD, so the index IS commits-behind.
    const lastTouch = new Map();
    commits.forEach((c, i) => c.files.forEach(f => { if (!lastTouch.has(f)) lastTouch.set(f, i); }));

    for (const rel of relPaths) {
        const at = lastTouch.get(rel);
        if (at === undefined) continue;
        const changedSince = new Set();
        for (let i = 0; i < at; i++) for (const f of commits[i].files) changedSince.add(f);
        const referenced = referencedFiles(projectRoot, rel);
        let snapshot = false;
        try { snapshot = isSnapshot(fs.readFileSync(path.join(projectRoot, rel), 'utf8')); } catch (e) {}
        // Still measured for a snapshot — the number is real and shown as history. It just
        // isn't raised as something to go fix.
        const staleRefs = referenced.filter(f => changedSince.has(f)).sort();
        out[rel] = {
            tracked: true,
            snapshot,
            commitsBehind: at,
            lastCommit: commits[at].date,
            referenced: referenced.length,
            staleRefs,
            // Measured always, raised only when it means something. A document is not
            // neglected because you committed code five minutes after writing it — a status
            // file naming twenty modules would otherwise go amber on every single commit,
            // which is the same alarm fatigue the snapshot marker exists to prevent.
            drifted: !snapshot && staleRefs.length > 0 && at > BUDGETS.driftCommitsBehind
        };
    }
    return out;
}

function analyzeBoard(projectRoot, board) {
    const full = boardFile(projectRoot, board);
    const info = { key: board.key, name: board.name, exists: fs.existsSync(full), bytes: 0, active: 0, done: 0, oversized: [], warnings: [] };
    if (!info.exists) return info;

    const content = fs.readFileSync(full, 'utf8');
    info.bytes = Buffer.byteLength(content, 'utf8');

    const entries = parseBoardEntries(content);
    info.done = entries.filter(e => e.status === 'DONE').length;
    info.active = entries.length - info.done;

    // Entry length is measured from the real block ranges, so fields AND notes count.
    const lines = content.split(/\r?\n/);
    for (const block of findBlocks(lines)) {
        const length = block.end - block.start;
        if (length > BUDGETS.entryLines) info.oversized.push({ title: block.title, lines: length });
    }

    if (info.active > BUDGETS.activeEntries) {
        info.warnings.push({ level: 'warn', message: `${info.active} active entries (budget ${BUDGETS.activeEntries}) — split or finish work before adding more.` });
    }
    if (info.done > BUDGETS.doneEntries) {
        info.warnings.push({ level: 'action', message: `${info.done} DONE entries waiting to be archived.`, action: 'archive' });
    }
    if (info.bytes > BUDGETS.boardBytes) {
        info.warnings.push({ level: 'warn', message: `${Math.round(info.bytes / 1024)} KB — a board this size is being read as an archive; agents will skim it.` });
    }
    if (info.oversized.length) {
        info.warnings.push({ level: 'warn', message: `${info.oversized.length} entr${info.oversized.length === 1 ? 'y is' : 'ies are'} over ${BUDGETS.entryLines} lines — detail belongs in results/, not on the board.` });
    }
    return info;
}

function countMarkdownDir(dir) {
    const out = { files: 0, bytes: 0 };
    if (!fs.existsSync(dir)) return out;
    for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.md')) continue;
        try {
            const st = fs.statSync(path.join(dir, name));
            if (st.isFile()) { out.files++; out.bytes += st.size; }
        } catch (e) { /* vanished between readdir and stat */ }
    }
    return out;
}

// Newest-first listing of docs/handoff/results/*.md. The session brief shows a short tail;
// hygiene counts the whole folder. Archives are a different class and are not listed here.
export function listResultMarkdown(projectRoot) {
    const dir = path.join(projectRoot, 'docs', 'handoff', 'results');
    const out = [];
    if (!projectRoot || !fs.existsSync(dir)) return out;
    for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.md')) continue;
        const full = path.join(dir, name);
        try {
            const st = fs.statSync(full);
            if (st.isFile()) out.push({ name, bytes: st.size, mtime: st.mtimeMs });
        } catch (e) { /* vanished between readdir and stat */ }
    }
    out.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
    return out;
}

function listMemoryFiles(projectRoot) {
    const root = path.join(projectRoot, '.agents');
    const out = [];
    if (!projectRoot || !fs.existsSync(root)) return out;
    for (const name of fs.readdirSync(root)) {
        const rel = `.agents/${name}/MEMORY.md`;
        try {
            const st = fs.statSync(path.join(projectRoot, rel));
            if (st.isFile()) out.push({ path: rel, bytes: st.size });
        } catch (e) { /* no memory file for this agent */ }
    }
    return out;
}

function listGeneratedMaps(projectRoot) {
    const out = [];
    const add = (rel) => {
        try {
            const st = fs.statSync(path.join(projectRoot, rel));
            if (st.isFile()) out.push({ path: rel, bytes: st.size });
        } catch (e) { /* generated map not present yet */ }
    };
    add('docs/ai/CODEINDEX.md');
    add('docs/ai/OBSIDIAN_INDEX.md');
    for (const dirRel of ['docs/ai/codeindex', 'docs/ai/obsidian']) {
        const dir = path.join(projectRoot, dirRel);
        if (!fs.existsSync(dir)) continue;
        for (const name of fs.readdirSync(dir)) {
            if (name.endsWith('.md')) add(`${dirRel}/${name}`);
        }
    }
    return out;
}

// Live files stay bounded. Cold files (results/, archive/) may grow on disk — they are git
// history, not the next session's reading list. Generated maps overwrite in place.
function analyzeInventory(projectRoot) {
    const results = listResultMarkdown(projectRoot);
    const resultBytes = results.reduce((n, f) => n + f.bytes, 0);
    const archives = countMarkdownDir(path.join(projectRoot, 'docs', 'handoff', 'archive'));
    const memories = listMemoryFiles(projectRoot);
    const generated = listGeneratedMaps(projectRoot);
    const warnings = [];

    if (results.length > BUDGETS.resultsFiles) {
        warnings.push({
            level: 'warn',
            source: 'results/',
            message: `${results.length} reports (budget ${BUDGETS.resultsFiles}) — cold storage, not live memory. Follow board Result/Output paths; do not list the folder.`
        });
    }
    if (resultBytes > BUDGETS.resultsBytes) {
        warnings.push({
            level: 'warn',
            source: 'results/',
            message: `${Math.round(resultBytes / 1024)} KB of reports (budget ${Math.round(BUDGETS.resultsBytes / 1024)} KB) — keep new reports short; git already keeps history.`
        });
    }
    for (const mem of memories) {
        if (mem.bytes > BUDGETS.memoryBytes) {
            warnings.push({
                level: 'warn',
                source: mem.path,
                message: `${Math.max(1, Math.round(mem.bytes / 1024))} KB (budget ${Math.round(BUDGETS.memoryBytes / 1024)} KB) — compact distilled lessons, never transcripts.`
            });
        }
    }
    for (const g of generated) {
        if (g.bytes > BUDGETS.generatedBytes) {
            warnings.push({
                level: 'warn',
                source: g.path,
                message: `${Math.round(g.bytes / 1024)} KB (budget ${Math.round(BUDGETS.generatedBytes / 1024)} KB) — regenerate the index; do not append a second copy.`
            });
        }
    }

    return {
        results: { files: results.length, bytes: resultBytes },
        archives,
        memories,
        generated,
        warnings
    };
}

// Working-tree questions, so not cached with the history reads.
function isGitIgnored(projectRoot, rel) {
    try {
        execFileSync('git', ['check-ignore', '-q', '--no-index', rel], { cwd: projectRoot, windowsHide: true, stdio: 'ignore' });
        return true;
    } catch { return false; }
}
function indexIsFresh(projectRoot, full) {
    try { return !isSourceNewerThan(projectRoot, GENERIC_EXTS, fs.statSync(full).mtimeMs); } catch { return false; }
}

function analyzeDoc(projectRoot, doc) {
    const rel = doc.rel.join('/');
    const full = path.join(projectRoot, ...doc.rel);
    const info = { name: doc.name, path: rel, exists: fs.existsSync(full), commitsBehind: null, lastCommit: null, warnings: [] };
    if (!info.exists) {
        if (doc.name === 'PROJECT_MAP.md') {
            info.warnings.push({ level: 'info', message: `No project map yet — the first session should ${doc.hint} (AGENTS.md Rule 1).` });
        }
        return info;
    }
    // The code index is generated in place and git-ignored in a kit project, so the commit count
    // from the last commit that touched it only grows (2026-11-04: 107 commits behind here, right
    // after a rescan). An index newer than every source file is current, whatever the count says;
    // for an ignored one the count is not even measured.
    const generated = doc.name === 'CODEINDEX.md';
    const ignored = generated && isGitIgnored(projectRoot, rel);
    const age = ignored ? null : commitsSinceDocChanged(projectRoot, rel);
    if (age) {
        info.commitsBehind = age.commitsBehind;
        info.lastCommit = age.lastCommit;
        if (age.commitsBehind > BUDGETS.docCommitsBehind && !(generated && indexIsFresh(projectRoot, full))) {
            info.warnings.push({ level: 'warn', message: `${age.commitsBehind} commits behind — likely stale, ${doc.hint}.` });
        }
    } else if (ignored && !indexIsFresh(projectRoot, full)) {
        info.warnings.push({ level: 'warn', message: `source files changed after the last scan — ${doc.hint}.` });
    }
    return info;
}

// → { project, boards: [...], docs: [...], warnings: [...], ok }
export function hygieneReport(projectRoot, { sourceRoot = projectRoot, indexRoot = projectRoot } = {}) {
    if (!projectRoot || !fs.existsSync(projectRoot)) {
        return {
            project: '',
            boards: [],
            docs: [],
            inventory: { results: { files: 0, bytes: 0 }, archives: { files: 0, bytes: 0 }, memories: [], generated: [], warnings: [] },
            warnings: [],
            ok: true
        };
    }
    const boards = BOARDS.map(b => analyzeBoard(projectRoot, b));
    // In observe mode authored documentation stays in the read-only source project while
    // CODEINDEX is generated in PLUT_OS's sidecar. Measure each where it actually lives;
    // using the sidecar as a fake git repository would silently erase real doc-drift data.
    const docs = TRACKED_DOCS.map(d => analyzeDoc(d.name === 'CODEINDEX.md' ? indexRoot : sourceRoot, d));
    const inventory = analyzeInventory(projectRoot);
    const warnings = [
        ...boards.flatMap(b => b.warnings.map(w => ({ ...w, source: b.name, board: b.key }))),
        ...docs.flatMap(d => d.warnings.map(w => ({ ...w, source: d.name }))),
        ...inventory.warnings
    ];
    return {
        project: path.basename(sourceRoot || projectRoot),
        boards,
        docs,
        inventory,
        warnings,
        ok: warnings.every(w => w.level === 'info')
    };
}

// Root-level .md (non-recursive) + everything under docs/ — exactly the set the Document Hub
// drift-checks. Centralized here so the dashboard, the session brief, and session_end all
// agree on which documents count as "the project's docs".
export function collectDocPaths(projectRoot) {
    const out = [];
    const add = (dir, recurse) => {
        if (!fs.existsSync(dir)) return;
        for (const name of fs.readdirSync(dir)) {
            const full = path.join(dir, name);
            let stat;
            try { stat = fs.statSync(full); } catch (e) { continue; }
            if (stat.isDirectory()) {
                if (recurse && name !== 'node_modules' && name !== '.git') add(full, true);
            } else if (name.endsWith('.md')) {
                out.push(path.relative(projectRoot, full).split(path.sep).join('/'));
            }
        }
    };
    add(projectRoot, false);
    add(path.join(projectRoot, 'docs'), true);
    return out;
}

// The single "what needs tidying" view, read-only, shared by the session brief (shown at
// START) and session_end (shown before the agent COMMITS). This is the trigger the project
// lacked: the stale-doc signal now rides the two calls every session already makes, instead
// of waiting for someone to open the Document Hub tab. Combines four signals:
//   - board bloat / DONE entries to archive     (hygieneReport)
//   - tracked maps that are commits-behind       (hygieneReport)
//   - results/ MEMORY.md generated-index budgets (hygieneReport inventory)
//   - prose docs whose named files moved         (docDrift, snapshots excluded)
// → { lines: [short actionable strings] }
const DRIFT_LISTED = 2;

export function housekeeping(projectRoot) {
    const lines = [];
    if (!projectRoot || !fs.existsSync(projectRoot)) return { lines };

    for (const w of hygieneReport(projectRoot).warnings) {
        if (w.level === 'info') continue; // "no map yet" etc. — the brief handles that separately
        lines.push(`${w.source}: ${w.message}`);
    }

    // A final message that kept a claim git or the disk did not show, after the claim check sent
    // it back once (lib/claim-check.mjs). A week is long enough for the next sessions to see it.
    const failed = claimLog(projectRoot).filter(e => e.phase === 'failed' && Date.now() - Date.parse(e.at) < 7 * 24 * 3600e3);
    if (failed.length) {
        lines.push(`claim check: ${failed.length} session stop(s) in the last 7 days kept a claim git or the disk did not show. Latest: ${failed.at(-1).findings[0]?.detail.slice(0, 200)}`);
    }

    // Drift is one finding repeated per document, and it used to be printed that way: the
    // same ~87 characters of instruction ("N referenced file(s) changed since it was last
    // committed … update it, or mark it a snapshot") once per drifted doc. In this project
    // that is 16 copies of it, inside a brief every AI reads at the start of every session.
    // So the instruction is stated once and each document contributes only what is actually
    // its own — its name and the files that moved under it. Past DRIFT_LISTED documents the rest
    // are a count (2026-10-27): sixteen documents took over 2,000 characters at the end of the
    // brief, where Claude Code's 10,000-character hook limit cut it, along with the session_end
    // line after it. The Document Hub tab lists every one.
    const drifted = Object.entries(docDrift(projectRoot, collectDocPaths(projectRoot)))
        .filter(([, d]) => d && d.drifted);
    if (drifted.length) {
        lines.push([
            'Referenced files changed since these were last committed — update each, or mark it a snapshot:',
            ...drifted.slice(0, DRIFT_LISTED).map(([rel, d]) => {
                const shown = d.staleRefs.slice(0, 2).join(', ');
                const rest = d.staleRefs.length - 2;
                return `  - ${rel} — ${shown}${rest > 0 ? `, …+${rest} more` : ''}`;
            }),
            ...(drifted.length > DRIFT_LISTED ? [`  - …and ${drifted.length - DRIFT_LISTED} more documents (the Document Hub tab lists them all)`] : [])
        ].join('\n'));
    }
    return { lines };
}

function archivePathFor(projectRoot) {
    const stamp = new Date().toISOString().slice(0, 7); // YYYY-MM: archives partition themselves
    return path.join(projectRoot, 'docs', 'handoff', 'archive', `BOARD-${stamp}.md`);
}

// Moves every DONE entry off a board into docs/handoff/archive/BOARD-<YYYY-MM>.md.
// Append-to-archive happens BEFORE removal on purpose: if the second step fails, the worst
// case is a duplicate archive entry, never a lost one. The removal re-finds blocks by
// (agent, title) inside the atomic mutate, so a DONE entry written by another agent in the
// meantime is left alone rather than deleted unarchived.
// → { archived, titles, archivePath }
export function archiveDoneEntries(projectRoot, boardKey = 'board') {
    const board = BOARDS.find(b => b.key === boardKey);
    if (!board) throw new Error(`Unknown board: ${boardKey}`);
    const full = boardFile(projectRoot, board);
    if (!fs.existsSync(full)) throw new Error(`${board.name} not found in this project.`);

    const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
    const doneBlocks = findBlocks(lines).filter(b => b.status.startsWith('DONE'));
    if (!doneBlocks.length) return { archived: 0, titles: [], archivePath: '' };

    const archivePath = archivePathFor(projectRoot);
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    const header = fs.existsSync(archivePath)
        ? ''
        : `# Board archive — ${path.basename(archivePath, '.md').replace('BOARD-', '')}\n\nDONE entries moved off ${board.name} to keep it a live workbench (AGENTS.md board hygiene).\n`;
    const body = doneBlocks
        .map(b => `\n${lines.slice(b.start, b.end).join('\n')}\n- **Archived:** ${new Date().toISOString()} (from ${board.name})\n`)
        .join('');
    fs.appendFileSync(archivePath, header + body, 'utf8');

    const identities = new Set(doneBlocks.map(b => `${b.agent.toLowerCase()}\u0001${b.title.toLowerCase()}`));
    const removed = updateFileAtomically(full, (content) => {
        const cur = content.split(/\r?\n/);
        const drop = findBlocks(cur).filter(b =>
            b.status.startsWith('DONE') && identities.has(`${b.agent.toLowerCase()}\u0001${b.title.toLowerCase()}`));
        // Splice from the bottom up so earlier ranges stay valid.
        for (const block of [...drop].sort((a, b) => b.start - a.start)) {
            let end = block.end;
            while (end < cur.length && cur[end].trim() === '') end++; // swallow the separating blank line
            cur.splice(block.start, end - block.start);
        }
        return { content: joinLines(cur, content), result: drop.map(b => b.title) };
    });

    return { archived: removed.length, titles: removed, archivePath: path.relative(projectRoot, archivePath).replace(/\\/g, '/') };
}

// Mechanical live-board guarantee: when DONE entries sit past the budget, move them off
// without waiting for a human to click Archive. Called from session_start/session_end so
// the next brief cannot be a finished-work pile. Failures leave the live file untouched.
export function tidyLiveBoards(projectRoot) {
    const out = { archived: 0, boards: [] };
    if (!projectRoot || !fs.existsSync(projectRoot)) return out;
    for (const board of BOARDS) {
        const info = analyzeBoard(projectRoot, board);
        if (info.done <= BUDGETS.doneEntries) continue;
        try {
            const r = archiveDoneEntries(projectRoot, board.key);
            out.archived += r.archived;
            if (r.archived) out.boards.push({ board: board.key, archived: r.archived, archivePath: r.archivePath });
        } catch (e) { /* next session retries; do not fail the briefing */ }
    }
    return out;
}
