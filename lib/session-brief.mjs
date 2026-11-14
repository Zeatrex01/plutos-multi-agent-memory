// The session_start briefing as one function, so the MCP tool and the SessionStart hook
// (`index.mjs --brief`, lib/project-hooks.mjs) hand a session exactly the same text. Two copies
// would drift; this is the one place it is assembled.
import { buildBrief, boundedBrief, SESSION_END_LINE } from './continuity.mjs';
import { refreshIndexIfStale } from './codeindex.mjs';
import { refreshGraphIfStale } from './graphify.mjs';
import { tidyLiveBoards } from './hygiene.mjs';
import { recordArrival } from './presence.mjs';
import { workingAgreement } from './working-agreement.mjs';
import { selfBriefLine } from './run-mode.mjs';

// Part 1 of the brief stays under this many characters (owner, d-821d5722b32a): a client plugin
// cut a 6 KB session_start reply and the brief was never read. The rest is paged (`part` 2, 3, ...).
export const BRIEF_PART_CHARS = 3500;
// Room kept in part 1 for its last line (paging line + the session_end line).
const FINAL_LINE_ROOM = 160 + SESSION_END_LINE.length;

// Part 1 carries these blocks of the context, in this order, while they fit; everything else is paged.
// What the project is, its readiness (unmapped: Rule 1 first) and its scope come first: a session that
// never asks for part 2 must still not start real work, or a review, in an unmapped project.
const FIRST = [/^## What this is/, /^## Project readiness/, /^## Where the last session left off/, /^New results/,
    /^## Scope/, /^## Settled decisions/, /^## Assigned to you/, /^## Other open board items/, /^Tools:/,
    /^## Who else works on this project/];

// A read-only side session (a second chat that looks, then reports) is told nothing that writes:
// no board, no decision, no session_end, no push, no map or design file. Its report goes to one
// results file or its answer. A line keeps what it says that does not write: only the clause that
// asks for a write leaves (WRITE_CLAUSE_RE); a line with nothing left goes, and so do whole lines
// that are only about writing (WRITE_LINE_RE, and a numbered agreement rule that writes, the board or a push).
const WRITE_CLAUSE_RE = /session_end|plutos_decide|leave it on the board|\bwrite (it|them|docs\/)|\bfill it\b|edit the files above directly|claim a board task|do the above first/i;
const WRITE_LINE_RE = /^Housekeeping:/i;
const RULE_WRITES_RE = /^\d+\..*(\bboard\b|\bpush\b)/i;
export const READ_ONLY_LINE = 'READ-ONLY SIDE SESSION: do not write the board, record decisions or call `session_end`. '
    + 'Leave your findings as one file under `docs/handoff/results/` (YYYY-MM-DD-<topic>.md) if writing that one file is allowed; otherwise put them in your final answer.';

// "1. Play back first: ..." → "1. Play back first"; the full rule text is paged.
// At most `room` characters: an owner's long agreement ends the list with "…" rather than push part 1 past its cap.
export function agreementSummary(rules, room = Infinity) {
    const items = rules.split('\n').map(l => l.match(/^(\d+)\.\s+([^:]+)/)).filter(Boolean)
        .map(([, n, head]) => `${n}. ${head.replace(/\s*\([^)]*\)/g, '').trim().slice(0, 70)}`);
    if (!items.length) return '';
    const lead = 'WORKING AGREEMENT (the owner\'s rules; full text in part 2): ';
    const more = ' · …the rest in part 2.';
    let shown = items.length;
    while (shown > 1 && lead.length + items.slice(0, shown).join(' · ').length + 1 > room) shown--;
    if (shown < items.length) while (shown > 1 && lead.length + items.slice(0, shown).join(' · ').length + more.length > room) shown--;
    return `${lead}${items.slice(0, shown).join(' · ')}${shown < items.length ? more : '.'}`;
}

// Part 1's fixed head (title, read-only line, self line) leaves the agreement summary this much room,
// and the blocks after it at least SUMMARY_KEEP_ROOM.
const SUMMARY_KEEP_ROOM = 1500;

// Splits a line's text into clauses at " — ", "; ", ": ", ", and " and sentence ends, outside
// parentheses and backticks. → [clause, separator after it, clause, ...].
function clauses(text) {
    const out = [];
    let depth = 0, tick = false, from = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '`') tick = !tick;
        else if (!tick && c === '(') depth++;
        else if (!tick && c === ')') depth = Math.max(0, depth - 1);
        if (tick || depth) continue;
        const sep = text.slice(i).match(/^(\s+—\s+|;\s+|:\s+|,\s+and\s+|\.\s+)/);
        if (!sep || i === 0) continue;
        out.push(text.slice(from, i), sep[0]);
        i += sep[0].length - 1;
        from = i + 1;
    }
    out.push(text.slice(from), '');
    return out;
}

/** One brief line as a read-only session gets it: the clauses that ask for a write removed,
 *  '' when nothing is left. */
export function readOnlyLine(line) {
    if (WRITE_LINE_RE.test(line) || RULE_WRITES_RE.test(line)) return '';
    if (!WRITE_CLAUSE_RE.test(line)) return line;
    // A numbered agreement rule is one instruction: one that writes leaves whole.
    if (/^\d+\.\s/.test(line)) return '';
    const [, head, body] = line.match(/^(\s*(?:[-*]\s+)?(?:\*\*[^*]+\*\*\s*)?)(.*)$/);
    const bits = clauses(body);
    let kept = '';
    let sep = '';
    for (let i = 0; i < bits.length; i += 2) {
        const clause = bits[i];
        if (WRITE_CLAUSE_RE.test(clause) || !clause.trim()) continue;
        kept += (kept ? sep : '') + clause;
        sep = bits[i + 1];
    }
    kept = kept.replace(/[\s,;:—]+$/, '');
    if (!kept || !/[\w`)]/.test(kept)) return '';
    return `${head}${kept}${/[.!?]$/.test(kept) ? '' : '.'}`;
}

// Blocks over the cap are split at line ends (a single over-long line is sliced).
function pages(blocks, cap) {
    const out = [];
    let page = '';
    const put = text => {
        if (page && page.length + 2 + text.length > cap) { out.push(page); page = ''; }
        page = page ? `${page}\n\n${text}` : text;
    };
    for (const block of blocks) {
        if (block.length <= cap) { put(block); continue; }
        let chunk = '';
        for (const raw of block.split('\n')) {
            for (let i = 0; i < Math.max(1, raw.length); i += cap) {
                const line = raw.slice(i, i + cap);
                if (chunk && chunk.length + 1 + line.length > cap) { put(chunk); chunk = ''; }
                chunk = chunk ? `${chunk}\n${line}` : line;
            }
        }
        if (chunk) put(chunk);
    }
    if (page) out.push(page);
    return out;
}

/** The brief, paged. `part` 1 (the default) is at most about `cap` characters and carries what a
 *  session acts on first: the working agreement summary, what the project is, its readiness and scope,
 *  Next and what is newer, settled decisions,
 *  the open board items and the tool map; its last line says how to get the rest. Returns
 *  { context, rules, part, parts }: `context` is the page, `rules` its closing line (the session_end
 *  line on part 1), so `context + rules` is the whole reply and the hook (lib/project-hooks.mjs)
 *  can still put the rules last. `writes: false` builds the same text without the upkeep below,
 *  which writes into the project: a test can then measure a repository's brief without changing its
 *  files. `mcp: true` is the brief served over MCP (session_start), which skips the files-only setup
 *  line: it arrived through the MCP. `readOnly` is a side session's brief: it writes nothing and is
 *  told nothing that writes. */
export function sessionBriefParts(projectRoot, ai, { writes = true, mcp = false, part = 1, readOnly = false, cap = BRIEF_PART_CHARS } = {}) {
    const n = Math.max(1, Math.floor(Number(part)) || 1);
    // The upkeep runs once, for part 1: a later part is the same brief read on, and tidying the
    // board between two reads could move a block from one page to another.
    if (writes && !readOnly && n === 1) {
        // Mechanically refresh the generated code index before briefing, so the map the agent
        // reads reflects the current tree — no Rescan click, no stale index. Safe/lossless and
        // never throws; the authored PROJECT_MAP is only flagged (in the brief), never rewritten.
        refreshIndexIfStale(projectRoot);
        // Same idea, same moment, for the knowledge graph — but only for a project that asked
        // for it (Graphify Studio → "keep it current"), and only for a graph that already
        // exists. Never throws; a stale map must not cost a briefing.
        refreshGraphIfStale(projectRoot);
        // DONE entries past budget leave the live board before the brief is built, so the
        // next session cannot be handed a finished-work pile. Failures are ignored; the
        // brief still returns.
        try { tidyLiveBoards(projectRoot); } catch (e) { /* briefing outranks cleanup */ }
        // Write down the arrival before briefing, so this AI shows up in its own brief's
        // participant list and — more to the point — in everyone else's from now on.
        // recordArrival never throws; a failed presence write must not cost a briefing.
        recordArrival(projectRoot, ai);
    }
    // A dropped line goes without a trace, so it never splits its block in two.
    const keep = text => readOnly ? text.split('\n').flatMap(l => { if (!l.trim()) return [l]; const r = readOnlyLine(l); return r ? [r] : []; }).join('\n') : text;
    const blocks = keep(boundedBrief(buildBrief(projectRoot, { ai, mcp }))).split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
    const rules = keep(workingAgreement(undefined, undefined, projectRoot)).trim();
    // The self line (this project is PLUT_OS itself: never point the dev copy at real projects) is a
    // safety rule a session needs before acting, so it stays in part 1 rather than with the agreement.
    const self = keep(selfBriefLine(projectRoot)).trim();

    const title = blocks[0]?.startsWith('# ') ? blocks.shift() : '';
    const head = [title, readOnly ? READ_ONLY_LINE : '', self].filter(Boolean);
    const summaryRoom = cap - FINAL_LINE_ROOM - SUMMARY_KEEP_ROOM - head.join('\n\n').length - 2 * head.length;
    const first = [title, readOnly ? READ_ONLY_LINE : '', agreementSummary(rules, Math.max(200, summaryRoom)), self].filter(Boolean);
    let used = first.join('\n\n').length + FINAL_LINE_ROOM;
    const chosen = new Set();
    for (const re of FIRST) {
        for (const block of blocks.filter(b => re.test(b))) {
            if (used + 2 + block.length > cap) continue;
            first.push(block); chosen.add(block); used += 2 + block.length;
        }
    }
    const rest = pages([rules, ...blocks.filter(b => !chosen.has(b))].filter(Boolean), cap);
    const parts = 1 + rest.length;
    if (n > parts) return { context: `The brief has ${parts} part(s); there is no part ${n}.`, rules: '', part: n, parts };
    const more = n < parts ? `Brief part ${n} of ${parts}; the rest: \`session_start\` with {"part": ${n + 1}${readOnly ? ', "readOnly": true' : ''}}.` : '';
    if (n === 1) {
        // One last line: how to get the rest, then the session_end line (never for a read-only session).
        const last = [more, readOnly ? '' : SESSION_END_LINE].filter(Boolean).join(' ');
        return { context: first.join('\n\n'), rules: last ? `\n\n${last}` : '', part: 1, parts };
    }
    return { context: rest[n - 2], rules: more ? `\n\n${more}` : '', part: n, parts };
}

// The session_start tool: served over MCP, so the brief never says the project has files only.
export function sessionBrief(projectRoot, ai, { part = 1, readOnly = false } = {}) {
    const { context, rules } = sessionBriefParts(projectRoot, ai, { mcp: true, part, readOnly });
    return context + rules;
}
