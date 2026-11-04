// The memory index: a git-ignored `.plutos/memory.db` per project (node:sqlite, FTS5) over the
// records the handoff files already hold. The files stay the truth; the index is a cache rebuilt
// in full whenever any source file's hash differs from its manifest (an upsert cannot see a
// deletion). Nothing here calls a model, and nothing is written when the project has no record.
//
// What is indexed (canonical architecture 2026-11-03 §6, research §4 "The index"):
//   - every claim and decision in CONTEXT.json, with its status as lib/context.mjs derives it;
//   - every session block in CONTINUITY.md and docs/handoff/archive/SESSIONS-*.md (type
//     'session', id = the block's timestamp, title = its headline, text = Did + Decided + Next +
//     Not checked);
//   - the records in docs/handoff/archive/CONTEXT-*.jsonl, flagged archived (cold: searched only
//     on request).
// Tables: nodes (the content), an external-content FTS5 table over title/text/excerpt with bm25
// weights 2.0/1.0/0.5, a trigram FTS5 table over ids and source paths (fact keys), terms (each
// folded term's document frequency, for the floor's informative-term rule), a manifest.
// Turkish ı, I and İ are folded in code on the indexed text and on the query (foldText), because
// unicode61 leaves the dotless ı alone. snippet() is clamped in code: asked for 1,000 tokens it
// returned 1,000.
//
// node:sqlite is loaded on demand with process.getBuiltinModule, never at the top of the module,
// so a Node without it (or without FTS5) still runs everything else; `find` then scans the same
// records in JavaScript (scanRecords) and says so.
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { assessContext, contextPathFor, foldText } from './context.mjs';
import { continuityPathFor, parseContinuity } from './continuity.mjs';

export const INDEX_SCHEMA = 2;   // 2: the terms table (2026-11-04); a database at 1 is rebuilt
export const INDEX_LIMITS = {
    cardChars: 500,     // a card's text
    snippetTokens: 24,  // snippet() cap, clamped here because SQLite honours any number asked
    candidates: 60      // rows read from FTS before the floor is applied
};

export function indexPathFor(projectRoot) {
    return path.join(projectRoot, '.plutos', 'memory.db');
}

// --- node:sqlite on demand ------------------------------------------------------------------

let sqlite;   // undefined: not tried; null: unavailable
function loadSqlite() {
    if (sqlite !== undefined) return sqlite;
    // Node prints "SQLite is an experimental feature" once per process on stderr; a CLI that
    // answers a question must not. Only that warning is dropped, and only while loading.
    const original = process.emitWarning;
    process.emitWarning = (warning, ...rest) => {
        const message = typeof warning === 'string' ? warning : warning?.message;
        if (/sqlite/i.test(String(message || ''))) return undefined;
        return original.call(process, warning, ...rest);
    };
    try {
        const mod = typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:sqlite') : null;
        sqlite = mod && typeof mod.DatabaseSync === 'function' ? mod : null;
    } catch { sqlite = null; } finally { process.emitWarning = original; }
    return sqlite;
}

// --- the records ------------------------------------------------------------------------------

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const flat = (value) => String(value || '').replace(/\s+/g, ' ').trim();

function sourceFiles(projectRoot) {
    const files = [];
    const context = contextPathFor(projectRoot);
    const continuity = continuityPathFor(projectRoot);
    if (fs.existsSync(context)) files.push({ kind: 'context', file: context });
    if (fs.existsSync(continuity)) files.push({ kind: 'sessions', file: continuity });
    const archive = path.join(projectRoot, 'docs', 'handoff', 'archive');
    if (fs.existsSync(archive)) {
        for (const name of fs.readdirSync(archive).sort()) {
            if (/^SESSIONS-.*\.md$/.test(name)) files.push({ kind: 'sessions', file: path.join(archive, name) });
            else if (/^CONTEXT-.*\.jsonl$/.test(name)) files.push({ kind: 'archived', file: path.join(archive, name) });
        }
    }
    return files;
}

const rel = (projectRoot, file) => path.relative(projectRoot, file).replace(/\\/g, '/');

function sessionText(fields) {
    return ['Did', 'Decided', 'Next', 'Not checked'].map(key => fields[key] ? `${key}: ${fields[key]}` : '').filter(Boolean).join(' ');
}

/** Every record the index holds, from the files, and the manifest of those files.
 *  → { records: [{ id, type, status, title, text, excerpt, paths, archived, capturedAt, evidence }], manifest: { schema, files: { rel: sha256 } } } */
export function collectRecords(projectRoot) {
    const files = sourceFiles(projectRoot);
    const manifest = { schema: INDEX_SCHEMA, files: {} };
    for (const { file } of files) manifest.files[rel(projectRoot, file)] = sha256(fs.readFileSync(file));
    const records = [];
    const add = (record) => records.push({ title: '', excerpt: '', paths: '', archived: 0, evidence: null, ...record, text: flat(record.text) });
    const fromSources = (sources) => {
        const list = Array.isArray(sources) ? sources : [];
        return {
            excerpt: flat(list.map(source => source.evidence || '').filter(Boolean).join(' ')),
            paths: list.map(source => source.path).filter(Boolean).join(' '),
            evidence: list.find(source => source.path) ? { path: list.find(source => source.path).path, excerpt: list.find(source => source.path).evidence || '' } : null
        };
    };
    if (files.some(f => f.kind === 'context')) {
        const context = assessContext(projectRoot);
        if (!context.error) {
            for (const item of [...context.current, ...context.review, ...context.stale, ...context.unverified]) {
                add({ id: item.id, type: 'claim', status: item.status, text: item.claim, capturedAt: item.capturedAt || null, ...fromSources(item.sources) });
            }
            for (const item of [...context.decisions.valid, ...context.decisions.verified, ...context.decisions.reversed]) {
                add({ id: item.id, type: 'decision', status: item.status, text: item.text, capturedAt: item.capturedAt || null, ...fromSources(item.sources) });
            }
        }
    }
    for (const { kind, file } of files) {
        if (kind === 'sessions') {
            let parsed;
            try { parsed = parseContinuity(fs.readFileSync(file, 'utf8')); } catch { continue; }
            for (const session of parsed.sessions) {
                add({
                    id: session.time, type: 'session', status: 'recorded', title: flat(session.headline), text: sessionText(session.fields),
                    capturedAt: session.time, evidence: { path: rel(projectRoot, file), line: session.start + 1 }
                });
            }
        } else if (kind === 'archived') {
            for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
                if (!line.trim()) continue;
                let item;
                try { item = JSON.parse(line); } catch { continue; }
                if (!item || typeof item !== 'object' || typeof item.id !== 'string') continue;
                const type = typeof item.claim === 'string' ? 'claim' : typeof item.text === 'string' ? 'decision' : null;
                if (!type) continue;
                add({
                    id: item.id, type, status: 'archived', archived: 1, text: type === 'claim' ? item.claim : item.text,
                    capturedAt: item.capturedAt || null, reason: flat(item.reason), ...fromSources(item.sources)
                });
            }
        }
    }
    records.sort((a, b) => a.id.localeCompare(b.id) || a.archived - b.archived);
    return { records, manifest };
}

// --- the database -------------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE nodes(rowid INTEGER PRIMARY KEY, id TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', excerpt TEXT NOT NULL DEFAULT '', paths TEXT NOT NULL DEFAULT '',
    raw_title TEXT NOT NULL DEFAULT '', raw_text TEXT NOT NULL DEFAULT '', captured_at TEXT, evidence TEXT);
CREATE INDEX nodes_id ON nodes(id);
CREATE VIRTUAL TABLE fts USING fts5(title, text, excerpt, content='nodes', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE keys USING fts5(id, paths, tokenize='trigram');
CREATE TABLE terms(term TEXT PRIMARY KEY, df INTEGER NOT NULL);
CREATE TABLE manifest(key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

// --- term frequencies -----------------------------------------------------------------------------
// How a query term matches an indexed token, the one rule both engines and the FTS MATCH follow: a
// term of five or more characters is a prefix (`"term"*`), a shorter one must be the whole token.
export const termMatches = (token, term) => term.length >= 5 ? token.startsWith(term) : token === term;
export const stripMarks = (text) => foldText(text).normalize('NFD').replace(/\p{M}/gu, '');
export const tokenize = (text) => stripMarks(text).match(/[\p{L}\p{N}]+/gu) || [];

// The keys a token answers to under termMatches: itself when shorter than five characters, else
// each of its prefixes of five or more characters (`sessions` → sessi, sessio, session, sessions).
function termKeys(token) {
    if (token.length < 5) return [token];
    const out = [];
    for (let n = 5; n <= token.length; n++) out.push(token.slice(0, n));
    return out;
}

/** Document frequency per term over every record (archived included): the number of records holding
 *  a token the term matches under termMatches, so a query term's df is one exact lookup. → Map(term → df).
 *  With `terms`, only those terms are counted (the scan engine's lookup). */
export function termFrequencies(records, terms = null, tokenizer = tokenize) {
    const df = new Map();
    const wanted = terms ? [...new Set(terms.map(term => stripMarks(term)))] : null;
    if (wanted) for (const term of wanted) df.set(term, 0);
    for (const record of records) {
        const tokens = tokenizer(`${record.title} ${record.text} ${record.excerpt}`);
        if (wanted) {
            for (const term of wanted) if (tokens.some(tok => termMatches(tok, term))) df.set(term, df.get(term) + 1);
            continue;
        }
        const keys = new Set();
        for (const tok of tokens) for (const key of termKeys(tok)) keys.add(key);
        for (const key of keys) df.set(key, (df.get(key) || 0) + 1);
    }
    return df;
}

function readManifest(db) {
    try {
        const rows = db.prepare('SELECT key, value FROM manifest').all();
        const out = { schema: null, files: {} };
        for (const row of rows) {
            if (row.key === 'schema') out.schema = Number(row.value);
            else if (row.key.startsWith('file:')) out.files[row.key.slice(5)] = row.value;
        }
        return out;
    } catch { return null; }
}

function sameManifest(a, b) {
    if (!a || !b || a.schema !== b.schema) return false;
    const ka = Object.keys(a.files).sort(), kb = Object.keys(b.files).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a.files[k] === b.files[k]);
}

function buildDatabase(sqliteModule, file, records, manifest) {
    const tmp = `${file}.tmp-${process.pid}`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { fs.rmSync(tmp, { force: true }); } catch { /* none */ }
    const db = new sqliteModule.DatabaseSync(tmp);
    try {
        db.exec(SCHEMA_SQL);
        db.exec('BEGIN');
        const node = db.prepare('INSERT INTO nodes(rowid, id, type, status, archived, title, text, excerpt, paths, raw_title, raw_text, captured_at, evidence) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
        const key = db.prepare('INSERT INTO keys(rowid, id, paths) VALUES(?,?,?)');
        records.forEach((record, i) => {
            const rowid = i + 1;
            node.run(rowid, record.id, record.type, record.status, record.archived ? 1 : 0, foldText(record.title), foldText(record.text), foldText(record.excerpt),
                record.paths, record.title, record.text, record.capturedAt || null, record.evidence ? JSON.stringify(record.evidence) : null);
            key.run(rowid, record.id, record.paths);
        });
        db.exec("INSERT INTO fts(fts) VALUES('rebuild')");
        const term = db.prepare('INSERT INTO terms(term, df) VALUES(?,?)');
        for (const [key, df] of termFrequencies(records)) term.run(key, df);
        const put = db.prepare('INSERT INTO manifest(key, value) VALUES(?,?)');
        put.run('schema', String(manifest.schema));
        put.run('builtAt', new Date().toISOString());
        for (const [relPath, hash] of Object.entries(manifest.files)) put.run(`file:${relPath}`, hash);
        db.exec('COMMIT');
    } finally { db.close(); }
    for (const suffix of ['', '-wal', '-shm', '-journal']) { try { fs.rmSync(file + suffix, { force: true }); } catch { /* none */ } }
    fs.renameSync(tmp, file);
}

/** Opens the index read-only-by-convention, or null when node:sqlite is missing, the file is
 *  absent or its FTS5 tables do not answer. The caller closes it. */
export function openIndex(projectRoot) {
    const mod = loadSqlite();
    const file = indexPathFor(projectRoot);
    if (!mod || !fs.existsSync(file)) return null;
    let db;
    try {
        db = new mod.DatabaseSync(file);
        db.prepare("SELECT count(*) AS n FROM fts WHERE fts MATCH '\"plutos\"'").get();
        return db;
    } catch { try { db?.close(); } catch { /* already closed */ } return null; }
}

/** Builds or rebuilds `.plutos/memory.db` when a source file changed; writes nothing for a project
 *  without a record. → { built, nodes, ms, engine: 'fts5'|'scan', reason? } */
export function ensureIndex(projectRoot, { collected = null } = {}) {
    const started = Date.now();
    const { records, manifest } = collected || collectRecords(projectRoot);
    if (!records.length) return { built: false, nodes: 0, ms: Date.now() - started, engine: 'scan', reason: 'no records' };
    const mod = loadSqlite();
    if (!mod) return { built: false, nodes: records.length, ms: Date.now() - started, engine: 'scan', reason: 'node:sqlite unavailable' };
    const file = indexPathFor(projectRoot);
    try {
        if (fs.existsSync(file)) {
            const db = new mod.DatabaseSync(file);
            let fresh = false;
            try { fresh = sameManifest(readManifest(db), manifest); } finally { db.close(); }
            if (fresh) return { built: false, nodes: records.length, ms: Date.now() - started, engine: 'fts5' };
        }
        buildDatabase(mod, file, records, manifest);
        return { built: true, nodes: records.length, ms: Date.now() - started, engine: 'fts5' };
    } catch (e) {
        return { built: false, nodes: records.length, ms: Date.now() - started, engine: 'scan', reason: `index unavailable: ${e.message}` };
    }
}

/** The FTS5 integrity check in its rank-1 form, which also compares the content table (the plain
 *  form passed a stale index). → { exists, ok, error?, stale } */
export function checkIndex(projectRoot) {
    const file = indexPathFor(projectRoot);
    if (!fs.existsSync(file)) return { exists: false, ok: true, stale: false };
    const mod = loadSqlite();
    if (!mod) return { exists: true, ok: true, stale: false, error: 'node:sqlite unavailable: not checked' };
    let db;
    try {
        db = new mod.DatabaseSync(file);
        db.prepare("INSERT INTO fts(fts, rank) VALUES('integrity-check', 1)").run();
        const stale = !sameManifest(readManifest(db), collectRecords(projectRoot).manifest);
        return { exists: true, ok: true, stale };
    } catch (e) {
        return { exists: true, ok: false, stale: true, error: e.message };
    } finally { try { db?.close(); } catch { /* closed */ } }
}

// --- querying ----------------------------------------------------------------------------------
// Both engines answer the same shape: { rows: [{ rowid?, id, type, status, archived, title, text,
// excerpt, paths, evidence, score }], keyHits: Set(row), df: Map(term → document frequency), total:
// the number of records df counts over } with score higher = better (the FTS engine negates bm25).

const quote = (term) => `"${String(term).replace(/"/g, '""')}"`;

/** The FTS5 MATCH string: every term quoted, a prefix for terms of five or more characters, OR
 *  between them. Ids and paths never go here (they go to the trigram table). */
export function matchExpression(terms) {
    return terms.filter(Boolean).map(term => term.length >= 5 ? `${quote(term)}*` : quote(term)).join(' OR ');
}

function rowToRecord(row) {
    return {
        rowid: row.rowid, id: row.id, type: row.type, status: row.status, archived: !!row.archived, title: row.raw_title, text: row.raw_text,
        excerpt: row.excerpt, paths: row.paths, capturedAt: row.captured_at, evidence: row.evidence ? JSON.parse(row.evidence) : null, score: 0
    };
}

/** Candidates from the index for folded terms and fact keys, with each term's df. → { rows, keyHits: Set(row), df, total } */
export function queryIndex(db, { terms, keys, archived = false }) {
    const where = archived ? '' : ' AND n.archived = 0';
    const rows = new Map();
    const expression = matchExpression(terms);
    if (expression) {
        const snippetCap = Math.min(INDEX_LIMITS.snippetTokens, 24);
        const found = db.prepare(
            `SELECT n.*, -bm25(fts, 2.0, 1.0, 0.5) AS score, snippet(fts, 1, '', '', '…', ${snippetCap}) AS snippet
             FROM fts JOIN nodes n ON n.rowid = fts.rowid WHERE fts MATCH ?${where} ORDER BY score DESC LIMIT ${INDEX_LIMITS.candidates}`
        ).all(expression);
        for (const row of found) rows.set(row.rowid, { ...rowToRecord(row), score: row.score, snippet: row.snippet });
    }
    const keyRows = new Set();
    for (const key of keys) {
        if (key.length < 3) continue;   // the trigram tokenizer needs three characters
        const found = db.prepare(`SELECT n.* FROM keys JOIN nodes n ON n.rowid = keys.rowid WHERE keys MATCH ?${where} LIMIT ${INDEX_LIMITS.candidates}`).all(quote(key));
        for (const row of found) {
            if (!rows.has(row.rowid)) rows.set(row.rowid, rowToRecord(row));
            keyRows.add(rows.get(row.rowid));
        }
    }
    const df = new Map();
    const lookup = db.prepare('SELECT df FROM terms WHERE term = ?');
    for (const term of terms) { const t = stripMarks(term); df.set(t, lookup.get(t)?.df || 0); }
    const total = db.prepare('SELECT count(*) AS n FROM nodes').get().n;
    return { rows: [...rows.values()], keyHits: keyRows, df, total };
}

// The scan: the same records, a BM25 in JavaScript (k1 1.2, b 0.75, the FTS5 idf) over the same
// three fields and weights, and the same df per term, so one floor serves both engines; a key hit
// is a substring of the id or the paths, as the trigram table would find it.
export function scanRecords(records, { terms, keys, archived = false }) {
    const pool = records.filter(record => archived || !record.archived);
    const fields = [['title', 2.0], ['text', 1.0], ['excerpt', 0.5]];
    const docs = pool.map(record => ({ record, tokens: Object.fromEntries(fields.map(([f]) => [f, tokenize(record[f])])) }));
    const avg = Object.fromEntries(fields.map(([f]) => [f, docs.reduce((n, d) => n + d.tokens[f].length, 0) / Math.max(1, docs.length)]));
    const N = docs.length;
    const matches = termMatches;
    const rows = new Map();
    const keyHits = new Set();
    for (const term of terms) {
        const t = stripMarks(term);
        const hits = docs.map(d => ({ d, tf: Object.fromEntries(fields.map(([f]) => [f, d.tokens[f].filter(tok => matches(tok, t)).length])) }))
            .filter(h => fields.some(([f]) => h.tf[f] > 0));
        if (!hits.length) continue;
        const idf = Math.log((N - hits.length + 0.5) / (hits.length + 0.5));
        for (const { d, tf } of hits) {
            let score = 0;
            for (const [f, weight] of fields) {
                if (!tf[f]) continue;
                const dl = d.tokens[f].length;
                score += weight * idf * (tf[f] * 2.2) / (tf[f] + 1.2 * (1 - 0.75 + 0.75 * dl / Math.max(1e-9, avg[f])));
            }
            const row = rows.get(d.record) || { ...d.record, archived: !!d.record.archived, score: 0 };
            row.score += score;
            rows.set(d.record, row);
        }
    }
    for (const key of keys) {
        const k = String(key).toLowerCase();
        if (k.length < 3) continue;
        for (const record of pool) {
            if (record.id.toLowerCase().includes(k) || record.paths.toLowerCase().includes(k)) {
                if (!rows.has(record)) rows.set(record, { ...record, archived: !!record.archived, score: 0 });
                keyHits.add(rows.get(record));
            }
        }
    }
    const out = [...rows.values()].sort((a, b) => b.score - a.score).slice(0, INDEX_LIMITS.candidates);
    return { rows: out, keyHits: new Set(out.filter(row => keyHits.has(row))), df: termFrequencies(records, terms), total: records.length };
}
