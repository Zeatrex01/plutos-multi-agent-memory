// Memory verbs and the memory check, over the registry lib/context.mjs keeps (CONTEXT.json) and
// the digest in CONTINUITY.md. One implementation for the CLI (`plutos memory …`, `plutos check
// --memory`) and for the memory cards plutos_context_for_task adds; no model call anywhere here.
//
// Records: a claim (`claims`, id = hash of its wording, status current/review/stale/unverified
// as lib/context.mjs derives it), a decision (`decisions`, minted `d-` id, status reversed /
// verified / valid) or, for `find` only, a session block. The check is a report, not a gate: it
// lists what is broken, doubled, chained, old, near the caps or carrying hidden characters, and
// what ageing would archive, and exits 0. Two 30-day findings: a claim unverified for 30 days, and a
// decision unseen for 30 days, counted from the session blocks' Shown field (ids a session was
// actually handed by session_start, memory find or plutos_context_for_task in one MCP process).
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { updateFileAtomically } from './atomic.mjs';
import { joinLines } from './lines.mjs';
import {
    CONTEXT_LIMITS, DECISION_ID, assessContext, readRegistry, updateRegistry, archiveRecords, snapshotSource,
    recordDecisions, previewAgeOut, hasHiddenUnicode, foldText, mintDecisionId
} from './context.mjs';
import { continuityPathFor, parseContinuity, isDecisionLine, decisionText, digestId, appendDigestLines } from './continuity.mjs';
import { collectRecords, ensureIndex, openIndex, queryIndex, scanRecords, checkIndex, stripMarks, tokenize, termMatches, INDEX_LIMITS } from './memory-index.mjs';
import { STOP, TR_EN } from './task-context.mjs';

export const MEMORY_CHECK = {
    unverifiedDays: 30,     // an unverified claim this old is listed
    unseenDays: 30,         // a standing decision no session block's Shown field named for this long is listed
    nearDuplicate: 0.8,     // trigram Jaccard at or above this is a near-duplicate pair
    capWarnAt: 0.9,         // a cap is reported from this share of it on
    cardChars: 500          // `memory open` and `memory find` show at most this much text
};
// A record id as the brief, a card or a session block names it: a decision (d- and 12 hex) or a claim (24 hex).
export const RECORD_ID = /\bd-[0-9a-f]{12}\b|\b[0-9a-f]{24}\b/g;
export const MEMORY_TYPES = ['claim', 'decision'];
export const MEMORY_STATUSES = ['reversed', 'verified', 'valid', 'review', 'stale', 'unverified'];

// Every record as one shape: { id, type, text, status, reasons, sources, capturedAt, … }.
function records(projectRoot, { now = new Date() } = {}) {
    const context = assessContext(projectRoot, { now });
    if (context.error) return { context, all: [] };
    const claims = [...context.current, ...context.review, ...context.stale, ...context.unverified]
        .map(item => ({ ...item, text: item.claim }));
    const decisions = [...context.decisions.reversed, ...context.decisions.verified, ...context.decisions.valid];
    return { context, all: [...decisions, ...claims] };
}

/** → { error?, records: [...] } filtered by type and status, newest first. */
export function listMemory(projectRoot, { type = '', status = '' } = {}) {
    if (type && !MEMORY_TYPES.includes(type)) throw new Error(`--type is one of ${MEMORY_TYPES.join('|')}.`);
    if (status && !MEMORY_STATUSES.includes(status)) throw new Error(`--status is one of ${MEMORY_STATUSES.join('|')}.`);
    const { context, all } = records(projectRoot);
    if (context.error) return { error: context.error, records: [] };
    const out = all.filter(item => (!type || item.type === type) && (!status || item.status === status))
        .sort((a, b) => String(b.capturedAt || '').localeCompare(String(a.capturedAt || '')) || (b.order || 0) - (a.order || 0));
    return { error: null, records: out };
}

/** The card of one record, or null. */
export function openMemory(projectRoot, id) {
    const { context, all } = records(projectRoot);
    if (context.error) throw new Error(context.error);
    const item = all.find(record => record.id === id);
    if (!item) return null;
    return {
        id: item.id, type: item.type, status: item.status,
        text: item.text.length > MEMORY_CHECK.cardChars ? item.text.slice(0, MEMORY_CHECK.cardChars) : item.text,
        reasons: item.reasons || [],
        sources: (item.sources || []).map(source => ({ path: source.path, evidence: source.evidence || null, sha256: source.sha256 || null })),
        supersedes: item.supersedes || null,
        reversedBy: item.reversedBy || [],
        capturedAt: item.capturedAt || null, capturedBy: item.capturedBy || null, capturedHead: item.capturedHead || null,
        lastSeenAt: item.lastSeenAt || null, origin: item.origin || null
    };
}

export function renderCard(card) {
    const lines = [
        `${card.id} · ${card.type} · ${card.status}`,
        card.text,
        `captured ${card.capturedAt || 'unknown date'} by ${card.capturedBy || 'unknown'}${card.capturedHead ? ` at ${String(card.capturedHead).slice(0, 12)}` : ''}${card.origin ? ` (${card.origin})` : ''}`
    ];
    if (card.lastSeenAt) lines.push(`last verified ${card.lastSeenAt}`);
    if (card.supersedes) lines.push(`supersedes ${card.supersedes}`);
    if (card.reversedBy.length) lines.push(`reversed by ${card.reversedBy.join(', ')}`);
    if (card.sources.length) {
        lines.push('sources:');
        for (const source of card.sources) lines.push(`  ${source.path}${source.evidence ? ` — "${source.evidence.replace(/\s+/g, ' ').slice(0, 120)}"` : ' — no excerpt captured'}`);
    } else lines.push('sources: none');
    for (const reason of card.reasons) lines.push(`  ! ${reason}`);
    return lines.join('\n');
}

// Re-snapshots a record's sources when every stored excerpt is still in its file verbatim; any
// excerpt that is not is named and nothing changes. → { verified, failed: [reason], sources }
export function verifyMemory(projectRoot, id, { by = 'plutos memory' } = {}) {
    const { registry, error } = readRegistry(projectRoot);
    if (error) throw new Error(error);
    const record = registry.decisions.find(item => item.id === id) || registry.claims.find(item => item.id === id);
    if (!record) throw new Error(`No record ${id} (plutos memory list shows the ids).`);
    const sources = Array.isArray(record.sources) ? record.sources : [];
    if (!sources.length) return { verified: false, failed: ['the record cites no source; nothing to verify'], sources: 0 };
    const failed = [];
    const fresh = [];
    for (const source of sources) {
        if (!source.evidence) { failed.push(`${source.path}: no excerpt was captured, so it cannot be re-verified`); continue; }
        const snap = snapshotSource(projectRoot, { path: source.path, evidence: source.evidence });
        if (snap.issue) { failed.push(snap.issue); continue; }
        if (snap.issues?.length) { failed.push(...snap.issues); continue; }
        fresh.push(snap.source);
    }
    if (failed.length) return { verified: false, failed, sources: sources.length };
    const now = new Date().toISOString();
    updateRegistry(projectRoot, (current) => {
        const refresh = item => item.id === id
            ? { ...item, sources: fresh, issues: [], ...(item.claim != null ? { strength: 'source-backed' } : {}), lastSeenAt: now, lastSeenBy: by }
            : item;
        return { registry: { claims: current.claims.map(refresh), decisions: current.decisions.map(refresh) }, result: null };
    });
    return { verified: true, failed: [], sources: fresh.length, at: now };
}

// A new decision that reverses `oldId`; the digest gets its line like a session's decision would.
// → { id, oldId }
export function supersedeMemory(projectRoot, oldId, text, { by = 'plutos memory', sources = [] } = {}) {
    if (!DECISION_ID.test(oldId || '')) throw new Error(`${oldId || '(none)'} is not a decision id (d-…).`);
    const clean = String(text || '').replace(/\s*\r?\n\s*/g, ' ').trim();
    if (!clean) throw new Error('The new decision text is required.');
    if (clean.length > CONTEXT_LIMITS.claimChars) throw new Error(`A decision is at most ${CONTEXT_LIMITS.claimChars} characters.`);
    if (hasHiddenUnicode(clean)) throw new Error('The text carries a hidden character (zero-width or bidirectional control); remove it.');
    const { registry, error } = readRegistry(projectRoot);
    if (error) throw new Error(error);
    const old = registry.decisions.find(item => item.id === oldId);
    if (!old) throw new Error(`No decision ${oldId} (plutos memory list --type decision shows them).`);
    if (registry.decisions.some(item => item.supersedes === oldId)) throw new Error(`${oldId} is already reversed; supersede its successor instead.`);
    const twin = registry.decisions.find(item => foldText(item.text) === foldText(clean));
    if (twin) throw new Error(`That text is already recorded as ${twin.id}; a superseding decision needs its own wording.`);
    const id = mintDecisionId();
    const result = recordDecisions(projectRoot, [{ id, text: clean, supersedes: oldId, sources }], { ai: by, origin: 'memory-cli' });
    if (!result.added) throw new Error('The decision was not recorded.');
    appendDigestLines(projectRoot, [`DECISION: ${clean} (${id})`]);
    return { id, oldId };
}

// Moves one record (claim or decision) to the month's archive with the reason. → { id, type }
export function retireMemory(projectRoot, id, reason, { by = 'plutos memory' } = {}) {
    const why = String(reason || '').replace(/\s+/g, ' ').trim();
    if (!why) throw new Error('A reason is required: plutos memory retire <id> "<reason>".');
    if (hasHiddenUnicode(why)) throw new Error('The reason carries a hidden character; remove it.');
    const result = updateRegistry(projectRoot, (registry) => {
        const type = registry.decisions.some(item => item.id === id) ? 'decision' : registry.claims.some(item => item.id === id) ? 'claim' : null;
        if (!type) throw new Error(`No record ${id} (plutos memory list shows the ids).`);
        const list = type === 'decision' ? registry.decisions : registry.claims;
        const gone = list.find(item => item.id === id);
        archiveRecords(projectRoot, [{ ...gone, archivedAt: new Date().toISOString(), reason: `retired: ${why}`, retiredBy: by }]);
        return { registry: { [type === 'decision' ? 'decisions' : 'claims']: list.filter(item => item.id !== id) }, result: { id, type } };
    });
    return result;
}

// --- find ---------------------------------------------------------------------------------------
// `memory find <query>`: the query's content words, folded (ı, I, İ → i), minus the stop words,
// Turkish words mapped through the task dictionary, matched over the index (lib/memory-index.mjs)
// or, without node:sqlite, over the same records in a scan. At most `budget` cards come back, each
// with the terms it matched and where its evidence is, and a line for what the floor hid.

// The floor (critique ruling 8, 2026-11-04; floor 2 the same day): a card stands when it matches at
// least `terms` distinct query terms, at least one of them informative (`keyTerms` matched terms and
// no informative term needed when an exact id or path matched in the trigram table), and its score
// is at least `ratio` of the top score for that query. A term is informative when its document
// frequency over all the records (archived included; the index's terms table, or the scan's count)
// is at most `informativeShare` of them, rounded up, never under 1: a word in more than a tenth of
// the records (board, session, owner, check) says which records are about the subject only in
// company, so two such words in a query about something that was never recorded still find two
// records that happen to share them, which is how the held-out false premises got through floor 1
// (on the held-out set, 8.3% refused). The share is a tenth
// because this repository's 229 records have 2,406 distinct folded terms, of which 103 stand in more
// than 23 records, and nearly all of those are the project's own furniture (owner, check, session,
// record, board, dashboard, brief, claim); it was read off the corpus, not tuned on a probe set.
// `ratio` was calibrated on tools/memory-probes.json (86 probes): the top card always passes the
// ratio, so refusals come from the term rules alone and the ratio only decides how many lower cards
// follow the top one. Recall@5 was 82.1% at 0.3, 80.4% at 0.5 and 78.7% at 0.6; 0.5 is the largest
// ratio within the 2 points allowed.
export const FIND_FLOOR = { terms: 2, keyTerms: 1, ratio: 0.5, informativeShare: 0.1 };
/** The largest document frequency an informative term may have among `total` records. */
export const informativeLimit = (total) => Math.max(1, Math.ceil((Number(total) || 0) * FIND_FLOOR.informativeShare));
export const FIND_BUDGET = { min: 1, max: 3, default: 3 };

// Built on first use, not at load: lib/task-context.mjs and this module import each other, and
// either may be the one still evaluating when the other loads.
let STOP_FOLDED, TR_FOLDED;
function dictionaries() {
    if (!STOP_FOLDED) {
        STOP_FOLDED = new Set([...STOP].map(stripMarks));
        TR_FOLDED = Object.keys(TR_EN).map(key => [stripMarks(key), TR_EN[key], key.length]).sort((a, b) => b[0].length - a[0].length);
    }
    return { STOP_FOLDED, TR_FOLDED };
}
const PATH_LIKE = /^(?:[\w.\-]+\/)+[\w.\-]*$|^[\w\-]+\.(?:mjs|cjs|js|ts|json|md|html|css|py|txt|yml|yaml|toml|bat|sh|gd|cs)$/i;
const ID_LIKE = /^d-[0-9a-f]{12}$|^[0-9a-f]{24}$/;
const stem = word => word.length > 4 && /[^su]s$/.test(word) && !/(is|us)$/.test(word) ? word.slice(0, -1) : word;

/** The query's content: folded terms (dictionary applied) and the fact keys (ids, paths). */
export function queryTerms(query) {
    const text = String(query || '').slice(0, 2000);
    const keys = new Set();
    for (const raw of text.match(/[^\s"'`(),;:]+/g) || []) {
        const tok = raw.replace(/^[.\/]+|[.,;:)]+$/g, '');
        if (ID_LIKE.test(tok) || (PATH_LIKE.test(tok) && /[a-z]/i.test(tok) && tok.length >= 3)) keys.add(tok);
    }
    const { STOP_FOLDED, TR_FOLDED } = dictionaries();
    const terms = new Set();
    // A path or id is a fact key, not words: `lib/push-gate.mjs` must not add `lib` and `mjs`. A bare
    // file name (`AGENTS.md`) is both: a key for the trigram table and its stem as a plain word.
    const words = [...keys].reduce((t, key) => t.split(key).join(key.includes('/') || ID_LIKE.test(key) ? ' ' : ` ${key.replace(/\.[a-z]+$/i, '')} `), text);
    for (const raw of tokenize(words)) {
        if (raw.length < 2 || /^\d+$/.test(raw) || STOP_FOLDED.has(raw)) continue;
        // A Turkish word keeps its own form beside the English it maps to: a record written in
        // Turkish matches the word, one written in English matches the mapping.
        const entry = TR_FOLDED.find(([key, , len]) => raw === key || (len >= 4 && raw.startsWith(key)));
        if (entry) for (const en of entry[1]) terms.add(en);
        terms.add(stem(raw));
    }
    return { terms: [...terms].slice(0, 16), keys: [...keys].slice(0, 6) };
}

function matchedTerms(row, terms) {
    const tokens = new Set(tokenize(`${row.title} ${row.text} ${row.excerpt}`));
    return terms.filter(term => { const t = stripMarks(term); for (const tok of tokens) if (termMatches(tok, t)) return true; return false; });
}

function evidenceLine(projectRoot, row) {
    const ev = row.evidence;
    if (!ev || !ev.path) return null;
    if (ev.line) return `${ev.path}:${ev.line}`;
    const first = String(ev.excerpt || '').split('\n')[0].trim();
    if (!first) return ev.path;
    try {
        const full = path.join(projectRoot, ev.path);
        if (!fs.existsSync(full) || fs.statSync(full).size > CONTEXT_LIMITS.sourceBytes) return ev.path;
        const content = fs.readFileSync(full, 'utf8');
        const at = content.indexOf(first);
        return at < 0 ? ev.path : `${ev.path}:${content.slice(0, at).split('\n').length}`;
    } catch { return ev.path; }
}

function toCard(projectRoot, row) {
    const text = row.text.length > MEMORY_CHECK.cardChars ? row.text.slice(0, MEMORY_CHECK.cardChars) : row.text;
    const evidence = evidenceLine(projectRoot, row);
    return {
        id: row.id, type: row.type, status: row.status, archived: !!row.archived, title: row.title || '', text,
        score: Math.round(row.score * 100) / 100, why: row.why, ...(evidence ? { evidence } : {}), ...(row.reason ? { reason: row.reason } : {})
    };
}

/** → { engine: 'fts5'|'scan', terms, keys, informative, cards, omitted, belowFloor, floor, line, index? }. Never
 *  throws on the index: any error there means the scan answers. A project without a record answers no cards.
 *  `informative` is the query terms the floor lets carry a hit (df at most a tenth of the records). */
export function findMemory(projectRoot, query, { budget = FIND_BUDGET.default, archived = false, candidates = null } = {}) {
    const take = Math.min(Math.max(Math.trunc(Number(budget) || FIND_BUDGET.default), FIND_BUDGET.min), 10);
    const parsed = queryTerms(query);
    const empty = (engine, extra = {}) => ({ engine, ...parsed, informative: [], cards: [], omitted: 0, belowFloor: 0, floor: FIND_FLOOR, line: 'No record matches above the floor.', ...extra });
    if (!parsed.terms.length && !parsed.keys.length) return empty('none', { line: 'The query has no content word; name a thing, a file or an id.' });
    const collected = collectRecords(projectRoot);
    if (!collected.records.length) return empty('none', { line: 'This project has no memory record yet.' });
    let engine = 'scan', found = null, index = null;
    try {
        index = ensureIndex(projectRoot, { collected });
        if (index.engine === 'fts5') {
            const db = openIndex(projectRoot);
            if (db) {
                try { found = queryIndex(db, { ...parsed, archived }); engine = 'fts5'; } finally { db.close(); }
            }
        }
    } catch (e) { index = { ...(index || {}), engine: 'scan', reason: `index unavailable: ${e.message}` }; found = null; }
    if (!found) { found = scanRecords(collected.records, { ...parsed, archived }); engine = 'scan'; }

    const rows = found.rows.map(row => ({ ...row, why: matchedTerms(row, parsed.terms), keyHit: found.keyHits.has(row) }));
    const topScore = rows.reduce((top, row) => Math.max(top, row.score), 0);
    for (const row of rows) {
        if (row.keyHit) {
            row.score += topScore + 1;   // an exact id or path outranks any wording
            row.why = [...row.why, ...parsed.keys.filter(k => row.id.toLowerCase().includes(k.toLowerCase()) || row.paths.toLowerCase().includes(k.toLowerCase())).map(k => ID_LIKE.test(k) ? `id:${k}` : `path:${k}`)];
        }
    }
    // The informative terms: a query word in at most a tenth of the records. Without a key hit, a
    // card needs one of them among its matched terms; common words alone cannot carry a hit.
    const limit = informativeLimit(found.total);
    const informative = parsed.terms.filter(term => (found.df.get(stripMarks(term)) || 0) <= limit);
    const carried = new Set(informative);
    const enough = rows.filter(row => row.keyHit
        ? row.why.length >= FIND_FLOOR.keyTerms
        : row.why.length >= FIND_FLOOR.terms && row.why.some(term => carried.has(term)));
    const best = enough.reduce((top, row) => Math.max(top, row.score), 0);
    const standing = enough.filter(row => row.score >= FIND_FLOOR.ratio * best).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const cards = standing.slice(0, candidates || take).map(row => toCard(projectRoot, row));
    const omitted = Math.max(0, standing.length - cards.length);
    const belowFloor = rows.length - standing.length;
    const common = parsed.terms.filter(term => !carried.has(term));
    const line = !cards.length
        ? `No record matches above the floor.${parsed.terms.length && !informative.length && !parsed.keys.length ? ` Every query word is common in the records (${common.join(', ')}); add a specific word: an id, a path, a name.` : ''}`
        : [omitted ? `${omitted} more above the floor (raise --budget, at most ${FIND_BUDGET.max})` : '', belowFloor ? `${belowFloor} more below the floor` : ''].filter(Boolean).join('; ');
    return { engine, ...parsed, informative, cards, omitted, belowFloor, floor: FIND_FLOOR, line, index };
}

export function renderFind(result) {
    const lines = [];
    for (const card of result.cards) {
        lines.push(`${card.id} · ${card.type} · ${card.status}${card.archived ? ' (archived: history, not current)' : ''} · ${card.score}`);
        if (card.title) lines.push(`  ${card.title}`);
        lines.push(`  ${card.text}`);
        const tail = [card.why.length ? `why: ${card.why.join(', ')}` : '', card.evidence ? `evidence: ${card.evidence}` : '', card.reason ? `archived: ${card.reason}` : ''].filter(Boolean);
        if (tail.length) lines.push(`  ${tail.join(' · ')}`);
    }
    if (result.line) lines.push(result.line);
    if (result.engine === 'scan') lines.push(`engine: scan (${result.index?.reason || 'node:sqlite unavailable'}); plutos memory open <id> shows a card.`);
    return lines.join('\n');
}

/** The record ids a delivered text names (decision and claim ids), for the session's Shown field. */
export function idsShownIn(text) {
    return [...new Set(String(text || '').match(RECORD_ID) || [])];
}

// --- The check --------------------------------------------------------------------------------

function trigrams(text) {
    const normalized = ` ${foldText(text).replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim()} `;
    const out = new Set();
    for (let i = 0; i + 3 <= normalized.length; i++) out.add(normalized.slice(i, i + 3));
    return out;
}
function jaccard(a, b) {
    if (!a.size && !b.size) return 1;
    let shared = 0;
    for (const gram of a) if (b.has(gram)) shared++;
    return shared / (a.size + b.size - shared);
}

/** Pairs of records whose texts are near-duplicates: [{ a, b, score }]. */
export function nearDuplicates(items, threshold = MEMORY_CHECK.nearDuplicate) {
    const prepared = items.filter(item => item.text && item.text.trim().length >= 10).map(item => ({ ...item, grams: trigrams(item.text) }));
    const pairs = [];
    for (let i = 0; i < prepared.length; i++) {
        for (let j = i + 1; j < prepared.length; j++) {
            if (prepared[i].id === prepared[j].id) continue;
            const score = jaccard(prepared[i].grams, prepared[j].grams);
            if (score >= threshold) pairs.push({ a: prepared[i].id, b: prepared[j].id, score: Math.round(score * 100) / 100 });
        }
    }
    return pairs;
}

const short = text => { const flat = String(text || '').replace(/\s+/g, ' ').trim(); return flat.length > 70 ? `${flat.slice(0, 67)}…` : flat; };

/** → { findings: [{ kind, text }], counts, summary } over CONTEXT.json and CONTINUITY.md; never throws on content. */
export function memoryCheck(projectRoot, { now = new Date() } = {}) {
    const findings = [];
    const add = (kind, text) => findings.push({ kind, text });
    const { registry, error, file, exists } = readRegistry(projectRoot);
    const context = assessContext(projectRoot, { now });
    const counts = { claims: registry.claims.length, decisions: registry.decisions.length, reversed: context.decisions?.reversed.length || 0, bytes: exists ? fs.statSync(file).size : 0 };
    if (error) add('registry', `CONTEXT.json cannot be read: ${error}`);

    // Broken anchors: a claim whose evidence moved or is missing, a decision whose excerpt is gone.
    for (const item of [...context.stale, ...context.review]) add('anchor', `${item.id} claim (${item.status}): ${item.reasons.join('; ')}`);
    for (const item of context.unverified) if ((item.sources || []).length || item.reasons.length) add('anchor', `${item.id} claim (unverified): ${item.reasons.join('; ') || 'sources cited without a matching excerpt'}`);
    for (const item of context.decisions?.valid || []) if (item.reasons.length) add('anchor', `${item.id} decision: ${item.reasons.join('; ')}`);

    // Ids and texts.
    const seen = new Map();
    for (const item of [...registry.claims, ...registry.decisions]) seen.set(item.id, (seen.get(item.id) || 0) + 1);
    for (const [id, n] of seen) if (n > 1) add('duplicate-id', `${id} appears ${n} times in the registry`);
    const texts = [...registry.decisions.map(item => ({ id: item.id, text: item.text })), ...registry.claims.map(item => ({ id: item.id, text: item.claim }))];
    for (const pair of nearDuplicates(texts)) {
        const a = texts.find(t => t.id === pair.a), b = texts.find(t => t.id === pair.b);
        add('near-duplicate', `${pair.a} ~ ${pair.b} (${pair.score}): "${short(a.text)}" / "${short(b.text)}"`);
    }

    // Supersede chains: a decision reversed by one that was itself reversed.
    const byId = new Map(registry.decisions.map(item => [item.id, item]));
    const reversedIds = new Set(registry.decisions.map(item => item.supersedes).filter(Boolean));
    for (const tip of registry.decisions.filter(item => item.supersedes && !reversedIds.has(item.id))) {
        const chain = [tip.id];
        let cursor = tip;
        const guard = new Set([tip.id]);
        while (cursor.supersedes && byId.has(cursor.supersedes) && !guard.has(cursor.supersedes)) {
            cursor = byId.get(cursor.supersedes);
            guard.add(cursor.id);
            chain.unshift(cursor.id);
        }
        if (chain.length > 2) add('chain', `${chain.join(' → ')} (${chain.length} records; retire the ones that no longer matter)`);
    }
    for (const item of registry.decisions) if (item.supersedes && !byId.has(item.supersedes)) add('chain', `${item.id} supersedes ${item.supersedes}, which is not in the registry`);

    // Unverified for 30 days: a claim without matching evidence that nobody re-captured.
    for (const item of context.unverified) {
        const seenAt = Date.parse(item.lastSeenAt || item.capturedAt || '');
        const days = Number.isFinite(seenAt) ? Math.floor((now - seenAt) / 864e5) : null;
        if (days !== null && days > MEMORY_CHECK.unverifiedDays) add('unverified-30d', `${item.id} claim unverified for ${days} days: "${short(item.claim)}"`);
    }

    // Unseen for 30 days: a standing decision no session's Shown field named. Counted only from the
    // first session block that carries the field, since before it nothing was tracked.
    const shownTracking = shownHistory(projectRoot);
    if (shownTracking.since) {
        for (const item of [...(context.decisions?.valid || []), ...(context.decisions?.verified || [])]) {
            const lastShown = shownTracking.lastShown.get(item.id) || null;
            const from = [lastShown, shownTracking.since, item.capturedAt].filter(Boolean).map(Date.parse).filter(Number.isFinite);
            if (!from.length) continue;
            const days = Math.floor((now - Math.max(...from)) / 864e5);
            if (days > MEMORY_CHECK.unseenDays) add('unseen-30d', `${item.id} decision unseen for ${days} days (${lastShown ? `last shown ${lastShown.slice(0, 10)}` : `never in a Shown field since tracking began ${shownTracking.since.slice(0, 10)}`}): "${short(item.text)}"`);
        }
    }

    // The index: the FTS5 integrity check in its rank-1 form (the plain form passed a stale index).
    const index = checkIndex(projectRoot);
    if (index.exists && !index.ok) add('index', `.plutos/memory.db fails its integrity check (${index.error}); memory find rebuilds it`);

    // What ageing would do at the next session end.
    const ageing = previewAgeOut(projectRoot, { now });
    for (const item of ageing.wouldArchive) add('ageing', `${item.id} would be archived (quarantined since ${item.since}): ${item.reason}`);

    // Caps and hidden characters.
    const capLine = (what, n, cap) => { if (n >= Math.ceil(cap * MEMORY_CHECK.capWarnAt)) add('cap', `${what}: ${n} of ${cap}${n >= cap ? ' (full: the next write is refused)' : ''}`); };
    capLine('claims', counts.claims, CONTEXT_LIMITS.claims);
    capLine('decisions', counts.decisions, CONTEXT_LIMITS.decisions);
    capLine('registry bytes', counts.bytes, CONTEXT_LIMITS.registryBytes);
    const hidden = (id, what, text) => { if (hasHiddenUnicode(text)) add('hidden-unicode', `${id}: ${what} carries a zero-width or bidirectional character`); };
    for (const item of registry.claims) { hidden(item.id, 'claim text', item.claim); for (const s of item.sources || []) { hidden(item.id, 'source path', s.path); hidden(item.id, 'evidence', s.evidence); } }
    for (const item of registry.decisions) { hidden(item.id, 'decision text', item.text); for (const s of item.sources || []) { hidden(item.id, 'source path', s.path); hidden(item.id, 'evidence', s.evidence); } }

    // The digest against the registry.
    const continuity = continuityPathFor(projectRoot);
    const digest = fs.existsSync(continuity) ? parseContinuity(fs.readFileSync(continuity, 'utf8')).digest : [];
    const decisionLines = digest.filter(isDecisionLine);
    const unmigrated = decisionLines.filter(line => !digestId(line)).length;
    if (unmigrated) add('digest', `${unmigrated} DECISION line(s) in CONTINUITY.md have no record id: plutos check --memory --apply gives each a record`);
    for (const line of decisionLines) {
        const id = digestId(line);
        if (id && !byId.has(id)) add('digest', `${id} is named in the digest but is not in the registry: "${short(decisionText(line))}"`);
    }
    digest.forEach((line, i) => { if (hasHiddenUnicode(line)) add('hidden-unicode', `digest line ${i + 1} carries a zero-width or bidirectional character`); });
    const digestDupes = nearDuplicates(decisionLines.map((line, i) => ({ id: `digest#${i + 1}`, text: decisionText(line) })));
    for (const pair of digestDupes) add('near-duplicate', `${pair.a} ~ ${pair.b} (${pair.score}) in CONTINUITY.md`);

    const kinds = {};
    for (const f of findings) kinds[f.kind] = (kinds[f.kind] || 0) + 1;
    const tracking = shownTracking.since ? `shown-id tracking since ${shownTracking.since.slice(0, 10)} (${shownTracking.blocks} session block(s))` : 'shown-id tracking starts at the next session_end';
    const indexState = !index.exists ? 'no index yet (memory find builds it)' : !index.ok ? 'index broken' : index.stale ? 'index stale (rebuilt at the next find)' : 'index fresh';
    const summary = `${findings.length} finding(s)${findings.length ? ` (${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ')})` : ''}; `
        + `${counts.claims} claim(s) of ${CONTEXT_LIMITS.claims}, ${counts.decisions} decision(s) of ${CONTEXT_LIMITS.decisions} (${counts.reversed} reversed), `
        + `${Math.round(counts.bytes / 1024)} KB of ${Math.round(CONTEXT_LIMITS.registryBytes / 1024)} KB; ${ageing.wouldArchive.length} would be archived at the next session end; ${tracking}; ${indexState}. A report, not a gate.`;
    return { findings, counts, kinds, summary, tracking: shownTracking, index };
}

/** What the session blocks' Shown fields say: → { since (first block with the field), blocks, lastShown: Map(id → time) } */
export function shownHistory(projectRoot) {
    const out = { since: null, blocks: 0, lastShown: new Map() };
    for (const session of sessionsEverywhere(projectRoot)) {
        const field = session.fields.Shown;
        if (field == null) continue;
        out.blocks++;
        if (!out.since || session.time < out.since) out.since = session.time;
        for (const id of idsShownIn(field)) if (!out.lastShown.has(id) || out.lastShown.get(id) < session.time) out.lastShown.set(id, session.time);
    }
    return out;
}

export function renderMemoryCheck(report) {
    return [...report.findings.map(f => `${f.kind}: ${f.text}`), `Summary: ${report.summary}`].join('\n');
}

// --- The one-time migration ------------------------------------------------------------------
// Every DECISION digest line without an id becomes a decision record (origin 'digest') and gets
// the id appended. The date comes from the session block whose Decided field holds the text,
// else from the first commit that added the line to CONTINUITY.md, else stays null. Running it
// again migrates nothing: every line already carries its id.
function sessionsEverywhere(projectRoot) {
    const files = [continuityPathFor(projectRoot)];
    const archive = path.join(projectRoot, 'docs', 'handoff', 'archive');
    if (fs.existsSync(archive)) for (const name of fs.readdirSync(archive)) if (/^SESSIONS-.*\.md$/.test(name)) files.push(path.join(archive, name));
    const sessions = [];
    for (const file of files) {
        try { sessions.push(...parseContinuity(fs.readFileSync(file, 'utf8')).sessions); } catch { /* unreadable archive */ }
    }
    return sessions.sort((a, b) => a.time.localeCompare(b.time));
}

function firstCommitDate(projectRoot, text) {
    try {
        const out = execFileSync('git', ['log', '--format=%cI', `-S${text}`, '--', 'docs/handoff/CONTINUITY.md'],
            { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, maxBuffer: 8 * 1024 * 1024 }).trim().split('\n').filter(Boolean);
        return out.at(-1) ? new Date(Date.parse(out.at(-1))).toISOString() : null;
    } catch { return null; }
}

/** → { migrated, annotated, dated: { session, git, none } } */
export function migrateDigestDecisions(projectRoot) {
    const continuity = continuityPathFor(projectRoot);
    const result = { migrated: 0, annotated: 0, dated: { session: 0, git: 0, none: 0 } };
    if (!fs.existsSync(continuity)) return result;
    const { digest } = parseContinuity(fs.readFileSync(continuity, 'utf8'));
    const pending = digest.map((line, index) => ({ line, index })).filter(({ line }) => isDecisionLine(line) && !digestId(line));
    if (!pending.length) return result;
    const { registry, error } = readRegistry(projectRoot);
    if (error) throw new Error(error);
    const known = new Map(registry.decisions.map(item => [foldText(item.text), item.id]));
    const sessions = sessionsEverywhere(projectRoot);
    const items = [];
    const annotate = new Map();   // digest line → id
    for (const { line, index } of pending) {
        const text = decisionText(line);
        if (hasHiddenUnicode(text)) throw new Error(`Digest line ${index + 1} carries a hidden character; clean it before migrating.`);
        const existing = known.get(foldText(text));
        if (existing) { annotate.set(line, existing); result.annotated++; continue; }
        const id = mintDecisionId();
        const session = sessions.find(s => (s.fields.Decided || '').toLowerCase().includes(text.toLowerCase()));
        let capturedAt = null, capturedBy = 'unknown', capturedHead = '';
        if (session) { capturedAt = session.time; capturedBy = session.ai; capturedHead = session.fields.HEAD || ''; result.dated.session++; }
        else {
            const date = firstCommitDate(projectRoot, text);
            if (date) { capturedAt = date; result.dated.git++; } else result.dated.none++;
        }
        items.push({ id, text, sources: [], capturedAt, capturedBy, capturedHead, origin: 'digest', digestIndex: index });
        annotate.set(line, id);
        known.set(foldText(text), id);
    }
    if (items.length) {
        const recorded = recordDecisions(projectRoot, items, { ai: 'migration', head: '' });
        result.migrated = recorded.added;
    }
    updateFileAtomically(continuity, (content) => {
        const lines = content.split(/\r?\n/);
        let inDigest = false;
        for (let i = 0; i < lines.length; i++) {
            if (/^##\s+Digest/i.test(lines[i])) { inDigest = true; continue; }
            if (inDigest && /^##\s+/.test(lines[i])) break;
            if (!inDigest || !lines[i].trim().startsWith('- ')) continue;
            const id = annotate.get(lines[i].trim().slice(2).trim());
            if (id) lines[i] = `${lines[i].replace(/\s+$/, '')} (${id})`;
        }
        const out = joinLines(lines, content);
        return { content: out.endsWith('\n') ? out : out + '\n', result: null };
    });
    return result;
}

