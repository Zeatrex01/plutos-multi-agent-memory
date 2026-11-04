// Session continuity — the project's durable memory across sessions and across AIs.
//
// The problem this closes: every new session (any vendor) starts blind. It re-reads the
// rules, the board, the map, and still doesn't know what the last session actually did or
// why. So it re-derives, and re-derived context is where logic mistakes come from — an
// agent "fixing" something that was deliberately built that way two sessions ago.
//
// PLUT_OS cannot manage a model's context window (it isn't in the inference loop). What it
// CAN do is decide what a session reads: one bounded briefing DERIVED from git plus the tiny
// live working set. Git is the changelog. Markdown is not a second history — digest holds
// decisions git cannot reconstruct; boards name the current work; results appear only when
// a live task cites them. That is the job — not a growing pile of notes.
//
// Two bounded stores, both committed so every AI sees the same state:
//   1. CONTINUITY.md — settled decisions plus the session ledger (did / changed / next).
//   2. CONTEXT.json — session-end claims with source hashes and exact-evidence provenance.
//      Notes without evidence remain unverified; changed/missing/drifted sources quarantine
//      the claim at read time. This is freshness + provenance, not an oracle.
// Older session blocks auto-archive to docs/handoff/archive/SESSIONS-<YYYY-MM>.md, the same
// pattern board archiving uses, so the live file stays readable forever.
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { HEADER_RE, FIELD_RE, fenceTracker, findBlocks, parseBoardEntries, sameAi, byPriority } from './board.mjs';
import { acquireLock, updateFileAtomically } from './atomic.mjs';
import { boardPathFor, agentBoardPathFor } from './roadmap.mjs';
import { detectTier } from './mcps.mjs';
import { plutosNamedAnywhere } from './connect.mjs';
import { housekeeping, listResultMarkdown } from './hygiene.mjs';
import { participants, describeAge } from './presence.mjs';
import { readinessBrief } from './readiness.mjs';
import { scopeBriefLines } from './scope.mjs';
import { skillsBriefLines } from './skills.mjs';
import { joinLines } from './lines.mjs';
import { CONTEXT_LIMITS, normalizeLearned, normalizeDecided, recordContextClaims, recordDecisions, assessContext, ageOutClaims, mintDecisionId } from './context.mjs';
import { contextAutomationStatus } from './context-automation.mjs';

// Whether the code map is HANDED to the session or merely pointed at. Pointing at it is what
// the brief did, and it does not work: this project's own AI read the line saying "open
// docs/ai/codeindex/<folder>.md for the area you are changing", wrote a charter rule saying
// the same thing, then made 35 greps and opened zero shards. An instruction you can ignore
// loses to a map that is already in front of you, and the map is small — 8.1 KB for all five
// shards here against a 32 KB brief budget the brief uses about 14 KB of.
//
// Deliberately no selection heuristic: under the cap the whole map goes in, over it the brief
// falls back to naming the files as before. A rule for picking the "relevant" shard is a rule
// that can pick wrong, and nothing here needs one until a project actually exceeds the cap.
export const CODE_MAP_INLINE_BUDGET = 12 * 1024;

// How long after an arrival a missing session record stops meaning "still working" and starts
// meaning "worked and did not report". Long on purpose: accusing a session that is simply
// taking its time is worse than noticing late.
export const SILENT_SESSION_GRACE_MS = 6 * 60 * 60 * 1000;

// The roster records LAST ACTIVITY, not arrival — every write bumps it, `session_end` included,
// so an AI that reports properly still ends up with its last action a moment AFTER the record it
// just wrote. That ordering slack is seconds, not hours; anything wider silently forgives real
// silence. Used only to decide whether an ending belongs to the last stretch of work.
export const SILENT_ENDING_TOLERANCE_MS = 10 * 60 * 1000;

export const CONTINUITY_BUDGETS = {
    keepSessions: 5,   // sessions kept in the live file; older ones archive automatically
    digestLines: 40,   // settled-decision ceiling — past this it needs merging, not appending
    briefChanges: 6,   // commit lines shown in the brief (git is the full log)
    briefCommitChars: 110, // each commit line is cut here: a subject is a headline, not the change
    briefFiles: 20,    // git paths shown in the brief; git remains the full log
    briefFilesListed: 12, // above this many changed files the brief gives only git's summary line
    readingMapResults: 3,  // live-cited reports only, never an unreferenced folder listing
    completionArchiveFiles: 12, // targeted ending checks only; archive text never enters the brief
    completionArchiveBytes: 512 * 1024
};

export const CONTINUITY_LIMITS = {
    identity: 100,
    headline: 300,
    field: 2000,
    fact: 500,
    story: 1000,
    briefBytes: 32 * 1024
};

// Length taken from the marker itself — hand-counted offsets are what made a bounded writer
// emit more than its own cap (see lib/context.mjs).
const TRUNCATED = ' ...[truncated]';

function flatBounded(value, max) {
    const flat = value.replace(/\s*\r?\n\s*/g, ' ').trim();
    return flat.length > max ? flat.slice(0, max - TRUNCATED.length) + TRUNCATED : flat;
}

function textInput(name, value, max, { required = false } = {}) {
    if (value == null || value === '') {
        if (required) throw new Error(`${name} is required.`);
        return '';
    }
    if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
    const normalized = flatBounded(value, max);
    if (required && !normalized) throw new Error(`${name} is required.`);
    return normalized;
}

function listInput(name, value) {
    if (value == null || value === '') return [];
    const values = Array.isArray(value) ? value : [value];
    return values.map((item, index) =>
        textInput(`${name}[${index}]`, item, CONTINUITY_LIMITS.fact, { required: true }));
}

export function boundedBrief(text) {
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes <= CONTINUITY_LIMITS.briefBytes) return text;
    const suffix = '\n\n_[brief truncated at the hard byte budget - read the referenced source files on demand.]_';
    const room = CONTINUITY_LIMITS.briefBytes - Buffer.byteLength(suffix, 'utf8');
    let prefix = Buffer.from(text, 'utf8').subarray(0, Math.max(0, room)).toString('utf8');
    while (prefix.endsWith('\uFFFD')) prefix = prefix.slice(0, -1);
    return prefix + suffix;
}

export function continuityPathFor(projectRoot) {
    return path.join(projectRoot, 'docs', 'handoff', 'CONTINUITY.md');
}

const SEED = `# CONTINUITY — session memory

Maintained by PLUT_OS (\`session_start\` / \`session_end\` MCP tools). Boards hold live work;
this holds how the project got here, so a new session (any AI) starts informed instead of
re-deriving — and stops making decisions that contradict earlier ones.

## Digest — settled decisions
<!-- DECISION lines are project case law. Legacy plain lines are retained for compatibility,
     but session_start labels them unverified. New learned claims live in CONTEXT.json. -->

## Sessions

(no sessions recorded yet)
`;

// A digest line written since 2026-11-04 ends with its record's id, ` (d-xxxxxxxxxxxx)`; the
// registry (CONTEXT.json) is the truth for a decision's status, the digest the human view. Every
// reader strips the id before comparing, clipping or testing the text.
const DIGEST_ID = /\s*\((d-[0-9a-f]{12})\)\s*$/;
export function digestText(line) {
    return String(line || '').replace(DIGEST_ID, '');
}
export function digestId(line) {
    return (String(line || '').match(DIGEST_ID) || [])[1] || null;
}
export function isDecisionLine(line) {
    return /^DECISION:/i.test(String(line || ''));
}
export function decisionText(line) {
    return digestText(line).replace(/^DECISION:\s*/i, '');
}

// Merges digest lines into the file's lines in place, skipping case-insensitive repeats of a
// line already there (ids stripped on both sides). → the lines actually added.
export function mergeDigest(lines, adds) {
    if (!adds.length) return [];
    let digestEnd = lines.findIndex(l => /^##\s+Digest/i.test(l));
    if (digestEnd < 0) {
        lines.push('', '## Digest — settled decisions', '');
        digestEnd = lines.length - 2;
    }
    let insertAt = digestEnd + 1;
    const existing = new Set();
    for (let i = digestEnd + 1; i < lines.length; i++) {
        if (/^##\s+/.test(lines[i])) break;
        if (lines[i].trim().startsWith('- ')) existing.add(digestText(lines[i].trim().slice(2).trim()).toLowerCase());
        insertAt = i + 1;
    }
    const fresh = adds.filter(l => !existing.has(digestText(l).toLowerCase())).map(l => `- ${l}`);
    if (fresh.length) {
        while (insertAt > digestEnd + 1 && lines[insertAt - 1].trim() === '') insertAt--;
        lines.splice(insertAt, 0, ...fresh);
    }
    return fresh;
}

// Appends digest lines outside a session (plutos memory supersede). → { added }
export function appendDigestLines(projectRoot, adds) {
    return updateFileAtomically(continuityPathFor(projectRoot), (content) => {
        const lines = content.split(/\r?\n/);
        const fresh = mergeDigest(lines, adds);
        if (!fresh.length) return { content, result: { added: 0 } };
        const out = joinLines(lines, content);
        return { content: out.endsWith('\n') ? out : out + '\n', result: { added: fresh.length } };
    }, { seed: SEED });
}

// → { digest: [lines], sessions: [{ time, ai, headline, fields, start, end }] }
export function parseContinuity(content) {
    const lines = content.split(/\r?\n/);
    const digest = [];
    let inDigest = false;
    for (const line of lines) {
        if (/^##\s+Digest/i.test(line)) { inDigest = true; continue; }
        if (inDigest && /^##\s+/.test(line)) break;
        if (!inDigest) continue;
        const trimmed = line.trim();
        if (trimmed.startsWith('- ')) digest.push(trimmed.slice(2).trim());
    }

    // Session headers share the boards' "a · b · c" shape on purpose — one parser family.
    const sessions = [];
    for (const block of findBlocks(lines)) {
        const m = lines[block.start].match(HEADER_RE);
        if (!m) continue;
        const fields = {};
        for (const line of lines.slice(block.start + 1, block.end)) {
            const f = line.match(FIELD_RE);
            if (f) fields[f[1].replace(/:$/, '').trim()] = f[2].trim();
        }
        sessions.push({ time: m[1].trim(), ai: m[2].trim(), headline: m[3].trim(), fields, start: block.start, end: block.end });
    }
    return { digest, sessions };
}

function git(projectRoot, args) {
    return execFileSync('git', args, { cwd: projectRoot, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
function gitHead(projectRoot) {
    try { return git(projectRoot, ['rev-parse', 'HEAD']); } catch (e) { return ''; }
}

function archivePathFor(projectRoot) {
    return path.join(projectRoot, 'docs', 'handoff', 'archive', `SESSIONS-${new Date().toISOString().slice(0, 7)}.md`);
}

function line(label, value) {
    return value ? [`- **${label}:** ${flatBounded(value, CONTINUITY_LIMITS.field)}`] : [];
}

// `- **Shown:** d-…, …`: record ids only (a decision's d- id or a claim's 24-hex id), unique, at
// most SHOWN_CHARS so the field stays a line; anything else in the list is dropped, not written.
export const SHOWN_CHARS = 400;
const SHOWN_ID = /^(?:d-[0-9a-f]{12}|[0-9a-f]{24})$/;
export function shownField(value) {
    if (!Array.isArray(value)) return '';
    const ids = [...new Set(value.filter(id => typeof id === 'string' && SHOWN_ID.test(id)))];
    while (ids.length && ids.join(', ').length > SHOWN_CHARS) ids.pop();
    return ids.join(', ');
}

function fingerprintOf({ ai, headline, did, changed, next, notChecked, story, decidedPlain }) {
    return [ai, headline, did, changed, next, notChecked, story, decidedPlain.join('; ')].join('\u0001');
}

function fingerprintFromSession(session) {
    return [
        session.ai,
        session.headline,
        session.fields.Did || '',
        session.fields.Changed || '',
        session.fields.Next || '',
        session.fields['Not checked'] || '',
        session.fields.Story || '',
        session.fields.Decided || ''
    ].join('\u0001');
}

function resultFromParsed(parsed, head, extra = {}) {
    return {
        sessionCount: parsed.sessions.length,
        digestLines: parsed.digest.length,
        archived: 0,
        digestOverBudget: parsed.digest.length > CONTINUITY_BUDGETS.digestLines,
        head,
        duplicate: false,
        ...extra
    };
}

// Records one session, then rotates only after the archive write succeeds. The transaction
// lock spans live append -> archive persist -> live removal; each individual file still uses
// updateFileAtomically so readers see old-or-new bytes, never a partial markdown document.
// If archive persistence fails, the overflow stays in CONTINUITY.md and remains recoverable.
// Repeating the same session_end (same operationId, or the same payload as the newest session)
// is a no-op so a retry after a client timeout cannot mint a second ledger row.
// → { sessionCount, archived, digestLines, digestOverBudget, head, duplicate }
export function recordSession(projectRoot, input = {}) {
    const ai = textInput('ai', input.ai, CONTINUITY_LIMITS.identity, { required: true });
    const headline = textInput('headline', input.headline, CONTINUITY_LIMITS.headline, { required: true });
    const did = textInput('did', input.did, CONTINUITY_LIMITS.field);
    const changed = textInput('changed', input.changed, CONTINUITY_LIMITS.field);
    const next = textInput('next', input.next, CONTINUITY_LIMITS.field);
    const notChecked = textInput('not_checked', input.notChecked ?? input.not_checked, CONTINUITY_LIMITS.field);
    const story = textInput('story', input.story, CONTINUITY_LIMITS.story);
    const learnedList = normalizeLearned(input.learned);
    // A decision is a string or { decision, supersedes?, sources? }; its text goes through the
    // same bounds as every other field, and its record is minted here so the digest line and the
    // registry carry the same id.
    const decidedItems = normalizeDecided(input.decided).map(item => ({ ...item, id: mintDecisionId() }));
    const decidedPlain = listInput('decided', decidedItems.map(item => item.text));
    const operationId = textInput('operationId', input.operationId || input.operation_id, CONTINUITY_LIMITS.identity);
    // The record ids this session was actually handed (session_start, memory find or
    // plutos_context_for_task in one MCP process): ids only, bounded, never part of the fingerprint,
    // so a block written before 2026-11-04 (no Shown field) and one with it parse the same way.
    const shown = shownField(input.shown);
    const file = continuityPathFor(projectRoot);
    const head = gitHead(projectRoot);
    const stamp = new Date().toISOString();
    const fp = fingerprintOf({ ai, headline, did, changed, next, notChecked, story, decidedPlain });
    // Decisions are durable knowledge with teeth: the project's "case law". Claims are kept
    // out of this markdown digest: CONTEXT.json is where provenance and freshness can be
    // checked instead of silently turning an AI-authored sentence into shared truth.
    const digestAdds = decidedItems.map(item => `DECISION: ${item.text} (${item.id})`);
    const attachContext = (result) => {
        try {
            const meta = { ai, head, origin: input.origin || 'session-end' };
            const claims = recordContextClaims(projectRoot, learnedList, meta);
            const decisions = recordDecisions(projectRoot, decidedItems, meta);
            const aged = ageOutClaims(projectRoot);
            return {
                ...result,
                context: {
                    ...claims, archived: (claims.archived || 0) + (aged.archived || 0),
                    decisions: decisions.added, decisionsRepeated: decisions.repeated, reversed: decisions.reversed,
                    ...(decisions.supersedeMissed ? { supersedeMissed: decisions.supersedeMissed } : {})
                },
                contextError: null
            };
        } catch (e) {
            // The session ledger may already be durable. Never turn that success into an
            // apparent failure that invites a duplicate retry; report the context failure.
            return { ...result, context: null, contextError: e.message };
        }
    };

    const unlockTransaction = acquireLock(`${file}.session`);
    try {
        if (fs.existsSync(file)) {
            const parsed = parseContinuity(fs.readFileSync(file, 'utf8'));
            const last = parsed.sessions[parsed.sessions.length - 1];
            const replay = (operationId && parsed.sessions.some(s => s.fields.Op === operationId))
                || (last && fingerprintFromSession(last) === fp);
            if (replay) return attachContext(resultFromParsed(parsed, head, { duplicate: true }));
        }
        updateFileAtomically(file, (content) => {
            const lines = content.split(/\r?\n/);

            // 1. Merge intentional decisions into the digest (skip exact case-insensitive repeats).
            mergeDigest(lines, digestAdds);

            // 2. Append the session before attempting rotation. This is the recoverable copy.
            const block = [
                `### ${stamp} · ${ai} · ${headline}`,
                ...line('Did', did),
                ...line('Decided', decidedPlain.join('; ')),
                ...line('Changed', changed),
                ...line('Next', next),
                ...line('Not checked', notChecked),
                ...line('Story', story),
                ...line('Shown', shown),
                ...line('Op', operationId),
                ...(head ? [`- **HEAD:** ${head}`] : [])
            ];
            const placeholder = lines.findIndex(l => l.includes('(no sessions recorded'));
            if (placeholder >= 0) lines.splice(placeholder, 1, ...block);
            else {
                if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
                lines.push(...block);
            }

            const out = joinLines(lines, content);
            return { content: out.endsWith('\n') ? out : out + '\n', result: null };
        }, { seed: SEED });

        // 3. Persist overflow to the archive FIRST. Failure leaves every block in the live file.
        const committedLines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
        const committedBlocks = findBlocks(committedLines).filter(b => /^\d{4}-\d{2}-\d{2}T/.test(b.agent));
        const overflow = Math.max(0, committedBlocks.length - CONTINUITY_BUDGETS.keepSessions);
        const selected = committedBlocks.slice(0, overflow);
        const toArchive = selected.map(b => committedLines.slice(b.start, b.end).join('\n'));

        if (toArchive.length) {
            const archive = archivePathFor(projectRoot);
            fs.mkdirSync(path.dirname(archive), { recursive: true });
            const archiveSeed = `# Session archive\n\nSessions rotated off CONTINUITY.md to keep it readable. Settled decisions remain in that file's Digest; learned claims live in CONTEXT.json.\n`;
            updateFileAtomically(archive, (content) => {
                const base = content.trimEnd();
                return { content: `${base}\n\n${toArchive.join('\n\n')}\n`, result: null };
            }, { seed: archiveSeed });

            // Archive is durable; now remove only the exact headers that were archived.
            const archivedHeaders = new Set(selected.map(b => committedLines[b.start]));
            updateFileAtomically(file, (content) => {
                const lines = content.split(/\r?\n/);
                const blocks = findBlocks(lines).filter(b => archivedHeaders.has(lines[b.start]));
                for (const b of blocks.reverse()) {
                    let end = b.end;
                    while (end < lines.length && lines[end].trim() === '') end++;
                    lines.splice(b.start, end - b.start);
                }
                const out = joinLines(lines, content);
                return { content: out.endsWith('\n') ? out : out + '\n', result: null };
            });
        }

        const parsed = parseContinuity(fs.readFileSync(file, 'utf8'));
        return attachContext({
            sessionCount: parsed.sessions.length,
            digestLines: parsed.digest.length,
            archived: toArchive.length,
            digestOverBudget: parsed.digest.length > CONTINUITY_BUDGETS.digestLines,
            head,
            duplicate: false
        });
    } finally {
        unlockTransaction();
    }
}

function readIfExists(file) {
    try { return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; }
}

// Rotation must not turn a valid ending into an accusation. Check only old participants
// without a matching live ending, newest archives first, and stop as soon as they match.
// An incomplete history can establish a match, but cannot establish a missing ending.
function completionWarnings(projectRoot, others, sessions) {
    const unresolved = new Map();
    for (const p of others) {
        const active = Date.parse(p.lastActive);
        if (!Number.isNaN(active) && Date.now() - active >= SILENT_SESSION_GRACE_MS) {
            unresolved.set(p.name.trim().toLowerCase(), active - SILENT_ENDING_TOLERANCE_MS);
        }
    }
    const accept = (entries) => {
        for (const session of entries) {
            const key = String(session.ai || '').trim().toLowerCase();
            if (Date.parse(session.time) >= unresolved.get(key)) unresolved.delete(key);
        }
    };
    accept(sessions);
    if (!unresolved.size) return new Map();

    let complete = true;
    let names = [];
    const dir = path.join(projectRoot, 'docs', 'handoff', 'archive');
    try { names = fs.readdirSync(dir).filter(name => /^SESSIONS-\d{4}-\d{2}\.md$/.test(name)).sort().reverse(); }
    catch (error) { if (error.code !== 'ENOENT') complete = false; }
    if (names.length > CONTINUITY_BUDGETS.completionArchiveFiles) complete = false;
    let remaining = CONTINUITY_BUDGETS.completionArchiveBytes;
    for (const name of names.slice(0, CONTINUITY_BUDGETS.completionArchiveFiles)) {
        if (!unresolved.size) break;
        try {
            // Read from one open file, so an atomic archive replacement cannot defeat the
            // byte cap between stat and read. Partial/direct edits leave the check uncertain.
            const fd = fs.openSync(path.join(dir, name), 'r');
            let content;
            try {
                const size = fs.fstatSync(fd).size;
                if (size > remaining) { complete = false; break; }
                const buffer = Buffer.alloc(size);
                const read = fs.readSync(fd, buffer, 0, size, 0);
                remaining -= read;
                if (read !== size || fs.fstatSync(fd).size !== size) { complete = false; continue; }
                content = buffer.toString('utf8');
            } finally { fs.closeSync(fd); }
            const archived = parseContinuity(content).sessions;
            const inFence = fenceTracker();
            const headers = content.split(/\r?\n/).filter(line => !inFence(line) && /^###\s/.test(line));
            if (!archived.length || archived.length !== headers.length
                || archived.some(session => Number.isNaN(Date.parse(session.time)))) complete = false;
            accept(archived);
        } catch (error) { complete = false; }
    }
    const message = complete
        ? ' — ⚠ no ending recorded for its last activity, so that work may not be written down'
        : ' — ⚠ ending for its last activity could not be verified from archived history (unreadable, malformed, or over the check budget)';
    return new Map([...unresolved.keys()].map(key => [key, message]));
}

// The stack Add Project detected, as recorded in .plutos/plutos.config.json — read directly
// rather than through workspaces.mjs, whose import also bootstraps/migrates the Hub.
// → "node (react, express)" | ""
function detectedStack(projectRoot) {
    try {
        const cfg = JSON.parse(readIfExists(path.join(projectRoot, '.plutos', 'plutos.config.json')) || '{}');
        const stack = typeof cfg.stack === 'string' ? cfg.stack.trim() : '';
        if (!stack || stack === 'unknown') return '';
        const frameworks = (Array.isArray(cfg.frameworks) ? cfg.frameworks : [])
            .filter(f => typeof f === 'string' && f.trim()).slice(0, 6);
        return frameworks.length ? `${stack} (${frameworks.join(', ')})` : stack;
    } catch (e) {
        return '';
    }
}

// What landed in the repo since the last recorded session. Git is the changelog; this is
// a bounded VIEW of it so the next session does not re-derive, and does not copy the log
// into another markdown file. Generated indexes and rotated archives are not "the work".
const DERIVED_NOISE = /^(docs\/ai\/(CODEINDEX|OBSIDIAN_INDEX)\.md|docs\/handoff\/(CONTINUITY\.md|CONTEXT\.json))$/;

function isDerivedNoise(rel) {
    return String(rel).split(' -> ').every((side) => {
        const n = side.replace(/\\/g, '/').trim();
        return DERIVED_NOISE.test(n)
            || n.startsWith('docs/handoff/archive/')
            || n.startsWith('docs/ai/codeindex/')
            || n.startsWith('docs/ai/obsidian/');
    });
}

function parseNameStatusLine(line) {
    const parts = line.split('\t');
    if (parts.length < 2) return null;
    const status = ((parts[0] || '').trim()[0] || 'M');
    if (parts.length >= 3) return { status, path: `${parts[1]} -> ${parts[2]}` };
    return { status, path: parts[1] };
}

function changesSince(projectRoot, head) {
    if (!head) return null;
    try {
        const log = git(projectRoot, ['log', '--oneline', `${head}..HEAD`]).split('\n').filter(Boolean);
        if (!log.length) return { commits: [], files: '', paths: [], moreFiles: 0, total: 0 };
        let files = '';
        try { files = git(projectRoot, ['diff', '--stat', `${head}..HEAD`]).split('\n').slice(-1)[0] || ''; } catch (e) { /* stat is optional */ }
        let paths = [];
        try {
            paths = git(projectRoot, ['diff', '--name-status', `${head}..HEAD`])
                .split('\n').filter(Boolean)
                .map(parseNameStatusLine)
                .filter(p => p && !isDerivedNoise(p.path));
        } catch (e) { /* name-status is optional; commits still land */ }
        const cap = CONTINUITY_BUDGETS.briefFiles;
        return {
            commits: log.slice(0, CONTINUITY_BUDGETS.briefChanges)
                .map(line => line.length > CONTINUITY_BUDGETS.briefCommitChars ? line.slice(0, CONTINUITY_BUDGETS.briefCommitChars - 1).trimEnd() + '…' : line),
            total: log.length,
            files,
            paths: paths.slice(0, cap),
            moreFiles: Math.max(0, paths.length - cap)
        };
    } catch (e) {
        return null; // rewritten history or not a repo — silence beats a wrong claim
    }
}

function liveCitedResultNames(projectRoot) {
    const names = new Set();
    const re = /(?:docs\/handoff\/)?results\/([^\s)`\]'"]+\.md)/gi;
    for (const file of [boardPathFor(projectRoot), agentBoardPathFor(projectRoot)]) {
        if (!fs.existsSync(file)) continue;
        for (const e of parseBoardEntries(readIfExists(file))) {
            if (e.status === 'DONE') continue;
            const blob = [e.title, e.fields.Task, e.fields['Result / Output'], e.fields.Result, ...(e.notes || [])].join('\n');
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(blob))) names.add(path.basename(m[1]));
        }
    }
    return names;
}

// The reading map: live working set + reports a LIVE task actually names. Unreferenced
// files in results/ stay on disk; they are not the next session's reading list.
// Reads docs/ai/codeindex/*.md and returns them inline when they fit, or nothing when they do
// not — in which case readingMap's existing pointer line remains the honest answer.
function inlineCodeMap(projectRoot) {
    const dir = path.join(projectRoot, 'docs', 'ai', 'codeindex');
    let names = [];
    try { names = fs.readdirSync(dir).filter(n => n.endsWith('.md')).sort(); }
    catch (e) { return []; }
    if (!names.length) return [];

    const shards = [];
    let total = 0;
    for (const name of names) {
        let body = '';
        try { body = fs.readFileSync(path.join(dir, name), 'utf8').trim(); } catch (e) { continue; }
        // A shard with only its `#` header lines maps nothing (a fresh project has one); it would
        // cost a session about 80 tokens to learn that.
        if (!body || body.split('\n').every(line => !line.trim() || line.startsWith('#'))) continue;
        total += Buffer.byteLength(body, 'utf8');
        if (total > CODE_MAP_INLINE_BUDGET) return [];
        shards.push({ name, body });
    }
    if (!shards.length) return [];

    const out = ['## The code map, in full (do not grep for what is already here)',
        '_Generated from the tree and refreshed by this call. Where a file lives is answered below;'
        + ' reach for search only when the answer is not._'];
    for (const shard of shards) {
        out.push('', `### docs/ai/codeindex/${shard.name}`, shard.body);
    }
    return out;
}

function readingMap(projectRoot) {
    const candidates = [
        ['AGENTS.md', 'the rules every agent here follows'],
        ['docs/ai/PROJECT_MAP.md', 'what this project is, stack, key modules'],
        ['docs/ai/CODEINDEX.md', 'code map catalog — open docs/ai/codeindex/<folder>.md for the area you are changing'],
        ['docs/handoff/BOARD.md', 'live tasks (boss tier)'],
        ['docs/handoff/AGENT_BOARD.md', 'subagent findings'],
        ['docs/handoff/ROSTER.md', 'which agents exist and who owns them'],
        ['docs/handoff/CONTEXT.json', 'source-backed shared claims and their capture provenance']
    ];
    const rows = [];
    for (const [rel, why] of candidates) {
        const full = path.join(projectRoot, rel);
        if (!fs.existsSync(full)) continue;
        const kb = Math.max(1, Math.round(fs.statSync(full).size / 1024));
        rows.push(`- \`${rel}\` (~${kb} KB) — ${why}`);
    }
    const results = listResultMarkdown(projectRoot);
    const cited = liveCitedResultNames(projectRoot);
    const shown = results.filter(d => cited.has(d.name)).slice(0, CONTINUITY_BUDGETS.readingMapResults);
    for (const d of shown) {
        const kb = Math.max(1, Math.round(d.bytes / 1024));
        rows.push(`- \`docs/handoff/results/${d.name}\` (~${kb} KB) — named by live board work`);
    }
    const cold = results.length - shown.length;
    if (cold > 0) {
        rows.push(`- _${cold} report${cold === 1 ? '' : 's'} in docs/handoff/results/ stay cold (open only a path a live board entry names)._`);
    }
    return rows;
}

// The session entry point: everything a starting agent needs, bounded, in one read.
// Assembled fresh every call — it is a view of the sources, never a source itself, so it
// cannot go stale the way a hand-maintained briefing file would.
const PARTICIPANT_RECENT_MINUTES = 14 * 24 * 60;

// A brief field longer than `max` characters ends at a word, and says where the rest is. The
// brief is a view of the records, so the full text stays one read away instead of in every session.
const clip = (text, max, where) => text.length <= max ? text : `${text.slice(0, max).replace(/\s+\S*$/, '')} … (full: ${where})`;

const BRIEF_DECISIONS = 12;
// The session brief is short (a short, project-specific context speeds an agent up, a long one costs more without more success): the newest
// decisions, clipped, and one line where the full brief has a section. `full` is the handover export's form
// (lib/snapshot.mjs), which carries everything because its reader may have no checkout.
const SHORT_DECISIONS = 3;
const SHORT_DECISION_CHARS = 160;

// The brief's last instruction. It travels with the rules (lib/session-brief.mjs), which no cap cuts:
// at the end of the project context it was the first thing the hook's 10,000-character limit cut.
export const SESSION_END_LINE = 'End the session with `session_end` (rule 8), so the next session starts informed.';

// No PLUT_OS MCP reaches this project: lib/mcps.mjs reads Claude's configs, and any other client's
// config that names plutos counts as wired too. A brief served over MCP never asks: it arrived through one.
const filesOnly = (projectRoot) => detectTier(projectRoot).tier === 'none' && !plutosNamedAnywhere(projectRoot);

export function buildBrief(projectRoot, { ai = '', full = false, mcp = false } = {}) {
    // Stable lines first, the volatile timestamp last: a model weighs early lines more, and a
    // client that caches a prefix keeps more of it when the first lines do not change.
    const out = [`# SESSION BRIEF — ${path.basename(projectRoot)}`, ''];

    // What the project is: the intake map's own summary section, not a re-derivation.
    const map = readIfExists(path.join(projectRoot, 'docs', 'ai', 'PROJECT_MAP.md'));
    if (map) {
        const what = map.split(/^##\s+/m).find(s => /^What this is/i.test(s));
        const body = what && what.replace(/^What this is\s*/i, '').trim();
        if (what) out.push('## What this is', full ? clip(body.split('\n').slice(0, 6).join('\n'), 500, '`docs/ai/PROJECT_MAP.md`')
            : clip(body.split('\n\n')[0], 200, '`docs/ai/PROJECT_MAP.md`'), '');
    } else {
        // Without the map the brief used to say only "go run project-intake", while PLUT_OS
        // already knew the stack from Add Project and never passed it on. It is a marker-file
        // guess, not an understanding — labelled as such so nobody mistakes it for the map.
        const detected = detectedStack(projectRoot);
        out.push('## What this is',
            'No `docs/ai/PROJECT_MAP.md` yet — read the project and write it first (AGENTS.md Rule 1).'
            + (detected ? `\nPLUT_OS detected **${detected}** from the project's marker files when it was added. That is a guess from file layout, not an understanding of the code — confirm it as part of the intake.` : ''),
            '');
    }

    // Where this project stands, and therefore what can honestly be done in it. Sits right
    // after "what this is" because it answers the same question one level up: not what the
    // project is, but whether anyone here knows yet. Silent once the project is informed.
    out.push(...readinessBrief(projectRoot));
    // The project's scope page (lib/scope.mjs, the project-scissors skill): planned, appetite left, ideas parked.
    out.push(...scopeBriefLines(projectRoot));
    const { digest, sessions } = parseContinuity(readIfExists(continuityPathFor(projectRoot)) || SEED);
    // Every call re-hashes cited files and re-checks markdown-to-code drift. The status below
    // is a derived view; CONTEXT.json never stores a self-asserted "current" flag.
    const context = assessContext(projectRoot);
    // The decisions that stand, newest first, from the registry; a reversed one is not shown. A
    // project whose registry holds no decision yet reads the digest, oldest first, as before.
    const standing = [...context.decisions.valid, ...context.decisions.verified].sort((a, b) => (b.capturedAt || '').localeCompare(a.capturedAt || '') || b.order - a.order);
    const reversedCount = context.decisions.reversed.length;
    const decisions = standing.length || reversedCount
        ? standing.map(item => ({ text: item.text, id: item.id }))
        : digest.filter(isDecisionLine).map(d => ({ text: decisionText(d), id: digestId(d) })).reverse();
    if (decisions.length) {
        // The newest BRIEF_DECISIONS: the digest may hold 40, and each session adds a few, so the
        // whole list would outgrow the hook's 10,000 characters within a few sessions.
        const keptDecisions = decisions.slice(0, full ? BRIEF_DECISIONS : SHORT_DECISIONS).reverse();
        const dropped = decisions.length - keptDecisions.length;
        out.push('## Settled decisions (do not silently re-open)');
        out.push(...keptDecisions.map(d => full ? `- ⚖️ **Decided:** ${d.text}${d.id ? ` (${d.id})` : ''}`
            : `- ⚖️ ${clip(d.text, SHORT_DECISION_CHARS, '`docs/handoff/CONTINUITY.md`')}${d.id ? ` (${d.id})` : ''}`));
        if (dropped > 0) out.push(`- _…and ${dropped} older one(s) in the Digest of \`docs/handoff/CONTINUITY.md\`._`);
        out.push('');
    }

    if (context.error) {
        out.push('## ⚠ Shared context registry needs repair',
            `- \`docs/handoff/CONTEXT.json\` could not be read: ${context.error}`,
            '- Treat every learned claim as unverified until the registry is repaired.', '');
    }
    if (!full) {
        // One line of counts; the claims are read on demand in CONTEXT.json, where provenance and freshness can be checked.
        const legacy = digest.filter(d => !isDecisionLine(d)).length;
        const counts = [[context.current.length, 'source-backed'], [context.review.length, 'to re-check (source edited)'],
            [context.stale.length, 'quarantined (evidence lost)'], [context.unverified.length + legacy, 'unverified']]
            .filter(([n]) => n > 0).map(([n, what]) => `${n} ${what}`);
        const decisionsTotal = standing.length + reversedCount;
        const decisionsNote = decisionsTotal ? `; ${decisionsTotal} decision(s)${reversedCount ? ` (${reversedCount} reversed)` : ''}, \`plutos memory list\`` : '';
        if (counts.length) out.push(`Shared context: ${counts.join(' · ')} claim(s) in \`docs/handoff/CONTEXT.json\`${decisionsNote}; read the one your task needs and check it there.`, '');
        else if (decisionsNote) out.push(`Shared context: ${decisionsTotal} decision(s)${reversedCount ? ` (${reversedCount} reversed)` : ''} in \`docs/handoff/CONTEXT.json\`, \`plutos memory list\`.`, '');
    } else {
        if (context.current.length) {
            out.push('## Source-backed shared context',
                '_Exact evidence existed at capture and every cited source is unchanged. This is provenance + freshness, not proof that an interpretation is infallible._',
                ...context.current.slice(0, CONTEXT_LIMITS.briefCurrent).map(item =>
                    `- ✅ ${item.claim} — ${item.sources.map(source => `\`${source.path}\``).join(', ')}`),
                ...(context.current.length > CONTEXT_LIMITS.briefCurrent
                    ? [`- _…and ${context.current.length - CONTEXT_LIMITS.briefCurrent} more current claims in \`docs/handoff/CONTEXT.json\`._`]
                    : []), '');
        }
        if (context.review.length) {
            out.push('## Shared context to re-check — source edited, evidence still present',
                '_The cited file changed after capture, but the exact excerpt is still in it. Re-read it before relying on the claim._',
                ...context.review.slice(0, CONTEXT_LIMITS.briefNeedsReview).map(item =>
                    `- 🔎 ${item.claim} — ${item.reasons.join('; ')}`),
                ...(context.review.length > CONTEXT_LIMITS.briefNeedsReview
                    ? [`- _…and ${context.review.length - CONTEXT_LIMITS.briefNeedsReview} more claims to re-check in \`docs/handoff/CONTEXT.json\`._`]
                    : []), '');
        }
        // A quarantined claim has lost its evidence, so its text is a distraction more than a help;
        // the brief says how many there are and where, and an AI that needs one reads it there.
        if (context.stale.length) {
            const n = context.stale.length;
            out.push('## ⚠ Quarantined shared context — verify before use',
                `- ⏳ ${n} claim${n === 1 ? '' : 's'} in \`docs/handoff/CONTEXT.json\` lost ${n === 1 ? 'its' : 'their'} evidence: a cited source changed or went missing after capture. Check one there before relying on it.`, '');
        }

        // Old CONTINUITY digests mixed claims and decisions. Preserve those lines, but stop
        // granting them authority: there is no source snapshot from which to prove freshness.
        const legacyFacts = digest.filter(d => !isDecisionLine(d)).map(claim => ({ claim, reasons: ['legacy note: no source provenance'] }));
        const unverified = [...context.unverified, ...legacyFacts];
        if (unverified.length) {
            const seen = new Set();
            const unique = unverified.filter(item => {
                const key = item.claim.toLocaleLowerCase('en-US');
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
            out.push('## Unverified notes — do not assume these are true or current',
                ...unique.slice(0, CONTEXT_LIMITS.briefNeedsReview).map(item =>
                    `- ❔ ${item.claim}${item.reasons?.length ? ` — ${item.reasons.join('; ')}` : ''}`),
                ...(unique.length > CONTEXT_LIMITS.briefNeedsReview
                    ? [`- _…and ${unique.length - CONTEXT_LIMITS.briefNeedsReview} more unverified notes in the shared memory files._`]
                    : []), '');
        }
    }

    // Who else works here. Before this, an AI could only see where the ONE most recent
    // session left off — it had no way to know a second or third AI was on the project at
    // all, which is the first thing a participant in a shared space should know.
    // An AI not seen for two weeks is not working here now; it is a count, not a line each.
    const everyone = participants(projectRoot).filter(p => !ai || !sameAi(p.name, ai));
    const others = everyone.filter(p => p.minutesAgo !== null && p.minutesAgo <= PARTICIPANT_RECENT_MINUTES);
    if (others.length) {
        const warnings = completionWarnings(projectRoot, others, sessions);
        const idle = everyone.length - others.length;
        out.push('## Who else works on this project',
            ...others.map(p => `- **${p.name}** — last active ${describeAge(p.minutesAgo)}`
                + (warnings.get(p.name.trim().toLowerCase()) || '')),
            ...(idle ? [`- _…and ${idle} more not seen for over 14 days._`] : []),
            '_You never task another AI directly. To ask one for something, leave it on the board as a suggestion._',
            '');
    }

    const last = sessions[sessions.length - 1];
    if (last) {
        out.push(`## Where the last session left off (${last.ai}, ${last.time})`, `**${last.headline}**`);
        for (const [key, max] of full ? [['Did', 400], ['Next', 600], ['Not checked', 300]] : [['Next', 300], ['Not checked', 200]]) {
            if (last.fields[key]) out.push(`- **${key}:** ${clip(last.fields[key], max, '`docs/handoff/CONTINUITY.md`')}`);
        }
        if (/-auto$/i.test(last.ai)) {
            out.push('- _This handoff was model-extracted from a transcript. Verify work state against git/board; only the separately listed source-backed claims passed freshness checks._');
        }
        out.push('');
        const changes = changesSince(projectRoot, last.fields.HEAD);
        if (changes && changes.commits.length && !full) out.push(`${changes.total} commit(s) landed since that session: \`git log\`.`, '');
        else if (changes && changes.commits.length) {
            out.push(`## Landed since that session (${changes.total} commit${changes.total === 1 ? '' : 's'} — git is the log)`);
            out.push(...changes.commits.map(c => `- ${c}`));
            if (changes.total > changes.commits.length) out.push(`- _…and ${changes.total - changes.commits.length} older commits._`);
            // A short list of files says what moved; a long one is git's job, so only its size is shown.
            const fileCount = (changes.paths || []).length + (changes.moreFiles || 0);
            if (fileCount <= CONTINUITY_BUDGETS.briefFilesListed) for (const p of changes.paths || []) out.push(`- ${p.status} \`${p.path}\``);
            if (changes.files) out.push(`- _${changes.files.trim()}_`);
            out.push('');
        }
    }

    // Board items: only what concerns this AI, plus anything unassigned and open.
    const boardFile = boardPathFor(projectRoot);
    if (fs.existsSync(boardFile)) {
        const entries = parseBoardEntries(readIfExists(boardFile)).filter(e => e.status !== 'DONE').sort(byPriority);
        // An assigned entry belongs to its assignee, not to the AI that opened it.
        const holder = e => e.fields.Assignee || e.agent;
        const mine = ai ? entries.filter(e => sameAi(holder(e), ai)) : [];
        const open = entries.filter(e => !mine.includes(e));
        // An assignment arrives complete: what, as what, and with what. Role and Needs let the
        // assignee configure itself (build the agent) instead of coming back to the user for
        // the rest. Your own TODO backlog is titles: you wrote the rest.
        const detailed = e => e.fields.Assignee || e.status !== 'TODO';
        const more = (list, shown) => list.length > shown ? [`- … ${list.length - shown} more: \`board_read\``] : [];
        // The priority field, shown unless the title already carries it the old way ("P1 - …").
        const ranked = e => e.priority && !e.title.startsWith(e.priority) ? `${e.priority} · ` : '';
        if (mine.length) {
            out.push('## Assigned to you');
            const order = [...mine.filter(detailed), ...mine.filter(e => !detailed(e))];
            for (const e of order.slice(0, full ? 8 : 5)) {
                if (!detailed(e)) { out.push(`- **${e.status}** ${ranked(e)}${e.title}`); continue; }
                out.push(`- **${e.status}** ${ranked(e)}${e.title}${e.fields.Task ? ` — ${clip(e.fields.Task, full ? 240 : 160, 'the board')}` : ''}`);
                if (e.fields.Role) out.push(`  - **Work as:** ${e.fields.Role}`);
                if (e.fields.Needs) out.push(`  - **Needs:** ${e.fields.Needs} — \`plutos_create_agent\` if this deserves its own agent.`);
            }
            out.push(...more(order, full ? 8 : 5), '');
        }
        const others = full ? 8 : 3;
        if (open.length) out.push('## Other open board items', ...open.slice(0, others).map(e => `- **${e.status}** ${holder(e)}: ${ranked(e)}${e.title}`), ...more(open, others), '');
    }

    if (!full) {
        // The Agent Skills the project's clients read (lib/skills.mjs): folder names only, and no line
        // at all in a project without one, so a fresh project's brief does not grow.
        out.push(...skillsBriefLines(projectRoot));
        // What the short brief leaves out is one file away; it names the files instead of carrying them.
        out.push('On demand: `docs/handoff/CONTINUITY.md` (every decision, past sessions), `docs/handoff/CONTEXT.json` (shared claims), `docs/handoff/BOARD.md`, `docs/ai/CODEINDEX.md` (code map).', '');
        if (!mcp && filesOnly(projectRoot)) out.push('Setup: files only, no PLUT_OS MCP here: edit the files above directly.', '');
        const tidy = housekeeping(projectRoot);
        if (tidy.lines.length) out.push(`Housekeeping: ${tidy.lines.length} item(s) drifting (\`plutos check\` lists them); fix one as part of your task or leave it.`, '');
        out.push(`_Generated ${new Date().toISOString()}; a view, not a file to edit._`);
        return boundedBrief(out.join('\n'));
    }

    const rows = readingMap(projectRoot);
    if (rows.length) out.push('## Read on demand (not all of it, only what your task needs)', ...rows, '');

    // Which setup this project runs, and what that costs — so the session works within its
    // real capabilities instead of answering as if the missing servers were there.
    // The map itself, not its address — see CODE_MAP_INLINE_BUDGET.
    const mapLines = inlineCodeMap(projectRoot);
    if (mapLines.length) out.push(...mapLines, '');

    if (!mcp && filesOnly(projectRoot)) {
        out.push('## Setup tier: files only', '- No PLUT_OS MCP wired into this project — coordination happens by editing the files above directly.', '');
    }

    // Whether this session's ending will be captured for the next one — which until now the
    // brief never said, so an AI could not tell an unrecorded session from a recorded one and
    // had no reason to compensate. Deliberately a statement of fact, not a nag: capture spends
    // the machine owner's own Claude subscription (see CONTEXT_AUTOMATION_NOTICE), so it is
    // theirs to switch on, and the hook that feeds it is wired per client — an AI without it
    // reads this as "the handoff is yours to write", which it is.
    if (!contextAutomationStatus(projectRoot).enabled) {
        out.push('## Automatic capture is OFF for this project',
            '- Nothing records this session unless you call `session_end` yourself. (Capture is the owner\'s'
            + ' switch on the Connect tab, run on their own AI subscription.)', '');
    }

    // Stale-doc / bloated-board signal, surfaced where the session actually starts instead of
    // only in the Document Hub tab nobody opens. Read-only — the brief stays a view.
    const tidy = housekeeping(projectRoot);
    if (tidy.lines.length) {
        out.push('## ⚠ Needs attention (housekeeping)',
            'These are drifting — fix as part of your task, or leave a note why not:',
            ...tidy.lines.map(l => `- ${l}`), '');
    }

    out.push(`_Generated ${new Date().toISOString()}; a view, not a file to edit._`);
    return boundedBrief(out.join('\n'));
}
