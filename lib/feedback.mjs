// The feedback bridge (owner, 2026-11-17): an AI working in a project that uses PLUT_OS says, in one
// line, what PLUT_OS lacked, what forced a workaround, a bug, or what worked. Goals 4 (problems found
// early and routed) and 5 (learn, adapt) in MVP.md. It replaces the hand-written field reports in
// PLUT_OS's private feedback/ folder, whose main lesson was that agents never use a tool nothing
// prompts them to use: so the line is one tool call (plutos_feedback), one session_end field and one
// CLI command, and the task-to-tool map names it.
//
// Where the lines live:
// - in the project: docs/handoff/plutos-feedback.jsonl, tracked, one JSON object per line
//   {time, ai, plutos: {version, commit}, via, kind, what, instead?, cost?, evidence?};
// - collected on the owner's machine: `plutos feedback collect` reads every registered project's
//   file and PLUT_OS's own, and writes the lines it has not seen into PLUT_OS's private
//   feedback/YYYY-MM-DD-collected.md (feedback/ is PRIVATE in tools/publish-core.mjs). The seen
//   ledger is a hash per line in the hub data folder (feedback-seen.txt), never in a repository.
//
// Every free-text field is scrubbed before it is written (lib/release-scan.mjs scrubPersonal: home
// folder paths become ~, e-mail addresses <email>, secret-shaped strings and URL credentials
// <secret>) and capped. The file is written and read only as a regular file inside the project:
// a symlinked file, or a docs/ or docs/handoff/ that resolves outside the project, is refused.
// At the first write the project's .gitattributes gets `<file> merge=union`, so two branches that
// both appended lines merge without a conflict.
//
// Collect is for PLUT_OS's own source checkout (feedbackCollectAvailable): elsewhere APP_ROOT is
// an install folder and its feedback/ means nothing, so collect refuses and Home shows no line.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { APP_ROOT, PLUTOS_HOME_DIR } from './approot.mjs';
import { acquireLock } from './atomic.mjs';
import { isPlutosSource } from './run-mode.mjs';
import { looksLikePlutosProject, getWorkspaces } from './workspaces.mjs';
import { scrubPersonal } from './release-scan.mjs';

export const FEEDBACK_REL = 'docs/handoff/plutos-feedback.jsonl';
export const FEEDBACK_KINDS = ['missing', 'friction', 'bug', 'worked'];
export const FEEDBACK_LIMITS = { what: 300, instead: 500, cost: 120, evidence: 500, ai: 60, perSession: 10 };
export const SEEN_LEDGER = 'feedback-seen.txt';
// A project file past this is read no further (a runaway writer must not stall the dashboard).
// Past it, the last MAX_READ_BYTES are read (the newest lines) and the result says truncated.
export const MAX_READ_BYTES = 2 * 1024 * 1024;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;   // 0 on Windows, where lstat below carries the check

// A field an AI sent as an object or array is kept as JSON, never "[object Object]".
const asText = value => {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object') { try { return JSON.stringify(value); } catch { return ''; } }
    return String(value);
};
const clip = (value, max) => {
    const s = scrubPersonal(asText(value)).replace(/\s+/g, ' ').trim();
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

let plutosVersion = null;
/** PLUT_OS's version and, in a checkout, its short commit: read once per process, never throws. */
export function plutosStamp() {
    if (plutosVersion) return plutosVersion;
    let version = '', commit = '';
    try { version = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version || ''; } catch { /* packaged */ }
    try {
        commit = execFileSync('git', ['-C', APP_ROOT, 'rev-parse', '--short=12', 'HEAD'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 2000 }).trim();
    } catch { /* not a checkout */ }
    plutosVersion = { ...(version ? { version } : {}), ...(commit ? { commit } : {}) };
    return plutosVersion;
}

/** One validated, scrubbed and capped line object. Throws on a missing `what` or an unknown kind. */
export function feedbackLine(input = {}, { ai = '', via = 'mcp', now = new Date() } = {}) {
    const kind = String(input.kind ?? '').trim().toLowerCase();
    if (!FEEDBACK_KINDS.includes(kind)) throw new Error(`kind must be one of ${FEEDBACK_KINDS.join(', ')}.`);
    const what = clip(input.what, FEEDBACK_LIMITS.what);
    if (!what) throw new Error('what is required: one line, what PLUT_OS lacked, forced or did.');
    const line = { time: now.toISOString(), ai: clip(ai || 'unknown', FEEDBACK_LIMITS.ai), plutos: plutosStamp(), via, kind, what };
    for (const key of ['instead', 'cost', 'evidence']) {
        const v = clip(input[key], FEEDBACK_LIMITS[key]);
        if (v) line[key] = v;
    }
    return line;
}

const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
const lstatOrNull = p => { try { return fs.lstatSync(p); } catch { return null; } };

/** The feedback file's path when every folder on the way resolves inside the project, else throws.
 *  With `create`, the missing folders are made (each checked before the next). */
function safeFeedbackPath(projectRoot, { create = false } = {}) {
    const realRoot = fs.realpathSync(projectRoot);
    let dir = realRoot;
    for (const part of path.dirname(FEEDBACK_REL).split('/')) {
        dir = path.join(dir, part);
        if (!lstatOrNull(dir)) {
            if (!create) return null;
            fs.mkdirSync(dir);
        }
        const real = fs.realpathSync(dir);
        if (!inside(real, realRoot)) throw new Error(`${path.relative(realRoot, dir)} leads outside the project; feedback is not written through a link.`);
        if (!fs.statSync(real).isDirectory()) throw new Error(`${path.relative(realRoot, dir)} is not a folder.`);
    }
    return path.join(realRoot, FEEDBACK_REL);
}

const UNION_LINE = `${FEEDBACK_REL} merge=union`;
/** Adds `<file> merge=union` to the project's .gitattributes unless a line already names the file.
 *  Appends only; creates the file when missing; leaves a symlinked .gitattributes alone. */
export function ensureUnionMerge(projectRoot) {
    const file = path.join(fs.realpathSync(projectRoot), '.gitattributes');
    const st = lstatOrNull(file);
    if (st && !st.isFile()) return false;
    const text = st ? fs.readFileSync(file, 'utf8') : '';
    if (text.split(/\r?\n/).some(l => l.trim().split(/\s+/)[0] === FEEDBACK_REL)) return false;
    const nl = text.includes('\r\n') ? '\r\n' : '\n';
    const lead = text && !text.endsWith('\n') ? nl : '';
    fs.appendFileSync(file, `${lead}# PLUT_OS feedback lines: both sides' appends survive a merge.${nl}${UNION_LINE}${nl}`, 'utf8');
    return true;
}

/** Appends feedback lines to the project's docs/handoff/plutos-feedback.jsonl. Refuses a folder that
 *  is not a PLUT_OS project, and a file or folder that is a link leading elsewhere. Returns
 *  { file, written, lines }. */
export function recordFeedback(projectRoot, items, opts = {}) {
    if (!projectRoot || !looksLikePlutosProject(projectRoot)) {
        throw new Error(`${projectRoot || '(no folder)'} is not a PLUT_OS project; feedback is written only into a project with the kit.`);
    }
    const list = (Array.isArray(items) ? items : [items]).map(item => feedbackLine(item, opts));
    if (!list.length) return { file: path.join(projectRoot, FEEDBACK_REL), written: 0, lines: [] };
    const file = safeFeedbackPath(projectRoot, { create: true });
    const st = lstatOrNull(file);
    if (st && !st.isFile()) throw new Error(`${FEEDBACK_REL} is not a regular file (a link or a folder); feedback is not written through it.`);
    if (!st) { try { ensureUnionMerge(projectRoot); } catch { /* the line still counts more than the merge rule */ } }
    // One append of whole lines: two writers interleave lines, never halves of one. O_NOFOLLOW: a
    // link swapped in after the check above fails the open instead of being followed.
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | NOFOLLOW, 0o644);
    try { fs.writeSync(fd, list.map(l => JSON.stringify(l)).join('\n') + '\n', null, 'utf8'); }
    finally { fs.closeSync(fd); }
    return { file, written: list.length, lines: list };
}

/** session_end's optional `plutos_feedback`: a string, or an array of strings or { kind?, what, … }.
 *  A string may start with its kind (`missing: …`); without one it is friction. An object's unknown
 *  kind is friction too, and the item carries `askedKind` so the reply can say so. Only the known
 *  fields are kept. At most FEEDBACK_LIMITS.perSession items. Returns the items for recordFeedback;
 *  never throws. */
export function sessionFeedbackItems(value) {
    if (value === undefined || value === null || value === '') return [];
    const list = Array.isArray(value) ? value : [value];
    return list.slice(0, FEEDBACK_LIMITS.perSession).flatMap(item => {
        if (typeof item === 'string') {
            const m = item.match(/^\s*(missing|friction|bug|worked)\s*[:\-–]\s*(.*)$/i);
            const what = (m ? m[2] : item).trim();
            return what ? [{ kind: m ? m[1].toLowerCase() : 'friction', what }] : [];
        }
        if (item && typeof item === 'object' && typeof item.what === 'string' && item.what.trim()) {
            const asked = String(item.kind ?? '').trim().toLowerCase();
            const known = FEEDBACK_KINDS.includes(asked);
            const out = { kind: known ? asked : 'friction', what: item.what };
            for (const key of ['instead', 'cost', 'evidence']) if (item[key] !== undefined && item[key] !== null) out[key] = item[key];
            if (!known && asked) out.askedKind = asked.slice(0, 40);
            return [out];
        }
        return [];
    });
}

const hashLine = raw => createHash('sha256').update(raw).digest('hex').slice(0, 32);
const ledgerFile = home => path.join(home, SEEN_LEDGER);
function readSeen(home) {
    try { return new Set(fs.readFileSync(ledgerFile(home), 'utf8').split(/\r?\n/).filter(Boolean)); } catch { return new Set(); }
}

/** The projects collect reads: every registered workspace and PLUT_OS's own checkout, each once. */
export function feedbackRoots({ appRoot = APP_ROOT, registered = getWorkspaces() } = {}) {
    const out = [], keys = new Set();
    for (const root of [appRoot, ...(registered || [])]) {
        if (typeof root !== 'string' || !root) continue;
        let key = path.resolve(root);
        try { key = fs.realpathSync(key); } catch { /* missing folder: read nothing below */ }
        if (process.platform === 'win32') key = key.toLowerCase();
        if (keys.has(key)) continue;
        keys.add(key);
        out.push(root);
    }
    return out;
}

/** The file's lstat when it is a regular file inside the project, else null (never throws). */
function feedbackFileStat(projectRoot) {
    try {
        const file = safeFeedbackPath(projectRoot);
        const st = file && lstatOrNull(file);
        return st && st.isFile() ? { file, st } : null;
    } catch { return null; }
}

/** Every line in one project's file: { lines: [{ hash, entry }], malformed, truncated }. A missing
 *  file, a link or a file outside the project is empty. Past MAX_READ_BYTES only the last
 *  MAX_READ_BYTES are read, without the partial line they start in. */
export function readProjectFeedback(projectRoot) {
    let text = '', truncated = false;
    try {
        const found = feedbackFileStat(projectRoot);
        if (!found) return { lines: [], malformed: 0, truncated };
        const { file, st } = found;
        const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
        try {
            truncated = st.size > MAX_READ_BYTES;
            // One byte before the window too: when it is a newline, the window starts on a whole line.
            const start = truncated ? st.size - MAX_READ_BYTES - 1 : 0;
            const buf = Buffer.alloc(st.size - start);
            const got = fs.readSync(fd, buf, 0, buf.length, start);
            let bytes = buf.subarray(0, got);
            if (truncated) bytes = bytes.subarray(bytes.indexOf(0x0a) + 1);
            text = bytes.toString('utf8');
        } finally { fs.closeSync(fd); }
    } catch { return { lines: [], malformed: 0, truncated: false }; }
    const lines = [];
    let malformed = 0;
    for (const raw of text.split(/\r?\n/)) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        let entry = null;
        try { entry = JSON.parse(trimmed); } catch { /* counted below */ }
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.what !== 'string' || !entry.what.trim()) { malformed++; continue; }
        lines.push({ hash: hashLine(trimmed), entry });
    }
    return { lines, malformed, truncated };
}

// GET /api/workspaces asks on every poll: the count is kept until the ledger or a project file
// changes (path, size, mtime), so an unchanged machine costs one lstat per file, not a parse and a hash.
const pendingCache = new Map();
const statKey = p => { const st = lstatOrNull(p); return st ? `${st.size}:${st.mtimeMs}` : '-'; };

/** How many lines across `roots` the ledger has not seen (the Home page's quiet line). Memoized. */
export function pendingFeedbackCount(roots, { home = PLUTOS_HOME_DIR } = {}) {
    const parts = [statKey(ledgerFile(home))];
    for (const root of roots) {
        const found = feedbackFileStat(root);
        parts.push(found ? `${found.file}:${found.st.size}:${found.st.mtimeMs}` : '-');
    }
    const key = parts.join('|');
    const cached = pendingCache.get(home);
    if (cached && cached.key === key) return cached.value;
    pendingFeedbackCount.computed++;
    const seen = readSeen(home);
    let pending = 0;
    for (const root of roots) for (const { hash } of readProjectFeedback(root).lines) if (!seen.has(hash)) { seen.add(hash); pending++; }
    pendingCache.set(home, { key, value: pending });
    return pending;
}
/** How many times the count was computed rather than taken from the cache (the test reads it). */
pendingFeedbackCount.computed = 0;

/** Collect and the Home line only make sense in PLUT_OS's own source checkout: not a packaged or
 *  bundled build (APP_ROOT is the install folder there), and a checkout that carries the private
 *  feedback/ folder (a public clone does not; its owner is not PLUT_OS's maker). */
export function feedbackCollectAvailable({ appRoot = APP_ROOT, env = process.env } = {}) {
    if (env.PLUTOS_PACKAGED === '1' || env.PLUTOS_BUNDLED_MCP === '1') return false;
    return isPlutosSource(appRoot) && fs.existsSync(path.join(appRoot, 'feedback'));
}
export const COLLECT_ELSEWHERE = 'plutos feedback collect is for PLUT_OS\'s own source checkout; here the lines stay in each project\'s ' + FEEDBACK_REL + '.';

const projectLabel = root => path.basename(path.resolve(root)) || root;
const mdText = s => String(s ?? '').replace(/\s+/g, ' ').replace(/[<>]/g, c => (c === '<' ? '&lt;' : '&gt;')).trim();

/** The markdown for newly collected lines, grouped by project, then kind. */
export function collectedMarkdown(groups, { now = new Date() } = {}) {
    const out = [`## Collected ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`, ''];
    for (const { project, lines } of groups) {
        out.push(`### ${mdText(project)}`, '');
        for (const kind of [...FEEDBACK_KINDS, 'other']) {
            const own = lines.filter(({ entry }) => (FEEDBACK_KINDS.includes(entry.kind) ? entry.kind : 'other') === kind);
            if (!own.length) continue;
            out.push(`**${kind}**`, '');
            for (const { entry } of own) {
                const stamp = [String(entry.time || '').slice(0, 10), entry.ai, entry.plutos?.commit || entry.plutos?.version].filter(Boolean).map(mdText).join(', ');
                out.push(`- ${mdText(entry.what)}${stamp ? ` (${stamp})` : ''}`);
                if (entry.instead) out.push(`  - instead: ${mdText(entry.instead)}`);
                if (entry.cost) out.push(`  - cost: ${mdText(entry.cost)}`);
                out.push(`  - evidence: ${entry.evidence ? mdText(entry.evidence) : 'none given'}`);
            }
            out.push('');
        }
    }
    return out.join('\n');
}

/** Reads every root's feedback file, writes the unseen lines into `outDir`/YYYY-MM-DD-collected.md
 *  (appending a section when that file exists) and adds their hashes to the hub's ledger, under the
 *  ledger's lock (two collects never write a line twice). Returns { projects, read, fresh,
 *  duplicate, malformed, truncated: [project labels read from their last MAX_READ_BYTES], file }. */
export function collectFeedback(roots, { home = PLUTOS_HOME_DIR, ...opts } = {}) {
    fs.mkdirSync(home, { recursive: true });
    const unlock = acquireLock(ledgerFile(home));
    try { return collectUnlocked(roots, { home, ...opts }); } finally { unlock(); }
}

function collectUnlocked(roots, { home, outDir = path.join(APP_ROOT, 'feedback'), now = new Date() }) {
    const seen = readSeen(home);
    const groups = [];
    const counts = { projects: 0, read: 0, fresh: 0, duplicate: 0, malformed: 0, truncated: [], file: null };
    for (const root of roots) {
        const { lines, malformed, truncated } = readProjectFeedback(root);
        counts.malformed += malformed;
        if (truncated) counts.truncated.push(projectLabel(root));
        if (!lines.length && !malformed) continue;
        counts.projects++;
        counts.read += lines.length;
        const fresh = [];
        for (const line of lines) {
            if (seen.has(line.hash)) { counts.duplicate++; continue; }
            seen.add(line.hash);
            fresh.push(line);
        }
        if (fresh.length) groups.push({ project: projectLabel(root), lines: fresh });
        counts.fresh += fresh.length;
    }
    if (!counts.fresh) return counts;
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `${now.toISOString().slice(0, 10)}-collected.md`);
    const head = fs.existsSync(file) ? '\n' : `# PLUT_OS feedback collected from projects (${now.toISOString().slice(0, 10)})\n\nWritten by \`plutos feedback collect\` from each project's \`${FEEDBACK_REL}\`. Private: names projects.\n\n`;
    fs.appendFileSync(file, head + collectedMarkdown(groups, { now }), 'utf8');
    // The ledger after the report: a crash between the two collects a line twice, never zero times.
    fs.appendFileSync(ledgerFile(home), groups.flatMap(g => g.lines.map(l => l.hash)).join('\n') + '\n', 'utf8');
    counts.file = file;
    return counts;
}
