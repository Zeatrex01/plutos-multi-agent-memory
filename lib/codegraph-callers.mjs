// Function-level callers for one script, read from the function graph an engine pack prepared, when
// the project has one. The core recognises an engine, it does not know the engine (owner, 2026-11-17):
// which suffixes have callers, where the database sits, how it names a file and the command the pack
// documents for building it all come from the engines table (lib/engines.mjs `callers`). This file
// names no engine.
//
// The database is `<engine root>/.codegraph/graph.db` with the tables `symbols` (id, res_path, name,
// kind, scope, line), `calls` (source_symbol_id, target_symbol_id, line), `unresolved_calls`
// (source_res_path, source_function, receiver, called_name, line, reason) and `files` (res_path,
// parse_error), `res_path` being the row's `pathPrefix` plus the path from the engine root. This
// reads those tables, read-only, with Node's own node:sqlite: no dependency, no Python.
//
// PLUT_OS never builds or installs that graph, and never runs the pack's tool as a fallback either: it
// may rebuild a stale graph and install its package on first use, which is exactly what this must not
// do. With no graph, or no node:sqlite (Node before 22.13), the answer says so and nothing runs.
//
// Everything a caller gets back (file and function names) comes from the project: the UI escapes it.
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { ENGINES } from './engines.mjs';

export const CODEGRAPH_LIMITS = { functions: 400, callersPerFunction: 100 };
// The engines whose pack can prepare a function graph. Only a row's `hint` (a command) travels to the
// page: the sentence around it is the page's own (i18n depgraph_page_calls_absent), in the owner's language.
const WITH_CALLERS = ENGINES.filter(e => e.callers);
// The suffixes a function graph can answer for, for the page's click handler.
export const CALLER_EXTS = [...new Set(WITH_CALLERS.flatMap(e => e.callers.exts))];

// node:sqlite on demand, its one "experimental" warning dropped (the same pattern as lib/memory-index.mjs).
let sqlite;
function loadSqlite() {
    if (sqlite !== undefined) return sqlite;
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

// Open the graph so that nothing is written beside it. A plain `readOnly` open of a WAL database
// still creates graph.db-shm and graph.db-wal in the project; SQLite's `immutable=1` URI parameter
// tells it the file cannot change, so it takes no lock and opens no sidecar. The cost: a WAL a
// writer has not checkpointed yet is not seen. who_calls.py builds the graph and closes it, which
// checkpoints, so a finished build is read whole. A Node whose DatabaseSync takes no URI (it would
// read `file:…` as a file name, which does not exist) falls back to a plain read-only open, but only
// for a database not in WAL mode, the one case that writes no sidecar.
function openReadOnly(lib, db) {
    try {
        return new lib.DatabaseSync(pathToFileURL(db).href + '?mode=ro&immutable=1', { readOnly: true });
    } catch (e) {
        if (isWal(db)) throw e;
        return new lib.DatabaseSync(db, { readOnly: true });
    }
}
// SQLite header bytes 18 and 19 are 2 for a WAL database.
function isWal(db) {
    let fd;
    try {
        fd = fs.openSync(db, 'r');
        const head = Buffer.alloc(20);
        return fs.readSync(fd, head, 0, 20, 0) === 20 && (head[18] === 2 || head[19] === 2);
    } catch (e) { return true; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (e) { /* closed */ } }
}

const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const toPosix = p => p.split(path.sep).join('/');
const CHUNK = 500;   // bound parameters per query; SQLite's limit is 32766 (999 before 3.32)
const chunks = list => { const out = []; for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK)); return out; };

// Whether `dir` is the root of an engine project: its marker file (or, for `*.ext`, any file with
// that suffix) and its marker folders are there.
export function isEngineRoot(dir, engine) {
    const parts = engine.marker.file.split('/');
    const last = parts.pop();
    const where = path.join(dir, ...parts);
    let found;
    if (last.startsWith('*')) {
        try { found = fs.readdirSync(where, { withFileTypes: true }).some(e => e.isFile() && e.name.endsWith(last.slice(1))); } catch (e) { found = false; }
    } else {
        try { found = fs.statSync(path.join(where, last)).isFile(); } catch (e) { found = false; }
    }
    return found && (engine.marker.dirs || []).every(d => { try { return fs.statSync(path.join(dir, d)).isDirectory(); } catch (e) { return false; } });
}

// The nearest folder at or above `dir` that is an `engine` project root, not leaving `stop`.
function engineRootFor(dir, stop, engine) {
    for (let d = dir; inside(stop, d); d = path.dirname(d)) {
        if (isEngineRoot(d, engine)) return d;
        if (d === stop) break;
    }
    return null;
}

/**
 * The functions one script declares and, per function, its resolved callers from the function graph
 * its engine's pack prepared. `file` is relative to the project root and must stay inside it, with a
 * suffix some engine row's `callers.exts` lists. Returns { available, reason?, hint?, file, functions?,
 * stale?, parseError?, <rootField>? }; reason is one of bad-file, not-<engine id> (the file is not
 * inside such an engine project), absent, no-sqlite, unreadable.
 */
export function readCallers(projectRoot, file) {
    const out = { available: false, file: String(file || '') };
    const lower = typeof file === 'string' ? file.toLowerCase() : '';
    const engines = WITH_CALLERS.filter(e => e.callers.exts.some(x => lower.endsWith(x)));
    if (!projectRoot || typeof file !== 'string' || !file || file.includes('\0') || path.isAbsolute(file)
        || !engines.length) return { ...out, reason: 'bad-file' };
    let rootReal, abs;
    try {
        rootReal = fs.realpathSync(projectRoot);
        abs = fs.realpathSync(path.resolve(rootReal, file));
    } catch (e) { return { ...out, reason: 'bad-file' }; }
    if (!inside(rootReal, abs) || abs === rootReal || !fs.statSync(abs).isFile()) return { ...out, reason: 'bad-file' };
    // The nearest root of an engine that answers for this suffix (the first row wins a tie).
    let engine = null, gRoot = null;
    for (const e of engines) {
        const r = engineRootFor(path.dirname(abs), rootReal, e);
        if (r && (!gRoot || r.length > gRoot.length)) { engine = e; gRoot = r; }
    }
    if (!gRoot) return { ...out, reason: 'not-' + engines[0].id };
    const { callers } = engine;
    const db = path.join(gRoot, ...callers.db.split('/'));
    let dbStat;
    try { dbStat = fs.statSync(db); } catch (e) { dbStat = null; }
    if (!dbStat || !dbStat.isFile() || !inside(rootReal, fs.realpathSync(db))) return { ...out, reason: 'absent', hint: callers.hint };
    const lib = loadSqlite();
    if (!lib) return { ...out, reason: 'no-sqlite', hint: 'Reading .codegraph/ needs node:sqlite (Node 22.13 or newer).' };

    const rootRel = toPosix(path.relative(rootReal, gRoot));
    const toProject = res => {
        let r = String(res || '');
        if (r.startsWith(callers.pathPrefix)) r = r.slice(callers.pathPrefix.length);
        return rootRel ? rootRel + '/' + r : r;
    };
    const resPath = callers.pathPrefix + toPosix(path.relative(gRoot, abs));
    let conn;
    try {
        conn = openReadOnly(lib, db);
        const fns = conn.prepare(`select id, name, scope, line from symbols
            where res_path = ? and kind = 'function' order by line limit ?`).all(resPath, CODEGRAPH_LIMITS.functions);
        // Three grouped queries for the whole file, not three per function: the callers (at most
        // callersPerFunction each, by a window rank), their counts, and the untyped calls per name.
        // Ids and names go in as parameters, in chunks well under SQLite's variable limit.
        const ids = fns.map(f => f.id);
        const names = [...new Set(fns.map(f => String(f.name)))];
        const callersOf = new Map(), countOf = new Map(), unresolvedOf = new Map();
        for (const chunk of chunks(ids)) {
            const marks = chunk.map(() => '?').join(',');
            for (const c of conn.prepare(`select target, res_path, line, name, scope from (
                    select cl.target_symbol_id as target, s.res_path as res_path, cl.line as line, s.name as name, s.scope as scope,
                        row_number() over (partition by cl.target_symbol_id order by s.res_path, cl.line) as rn
                    from calls cl join symbols s on s.id = cl.source_symbol_id
                    where cl.target_symbol_id in (${marks}))
                where rn <= ? order by target, rn`).all(...chunk, CODEGRAPH_LIMITS.callersPerFunction)) {
                if (!callersOf.has(c.target)) callersOf.set(c.target, []);
                callersOf.get(c.target).push(c);
            }
            for (const r of conn.prepare(`select target_symbol_id as target, count(*) as n from calls
                    where target_symbol_id in (${marks}) group by target_symbol_id`).all(...chunk)) countOf.set(r.target, Number(r.n));
        }
        let hasUnresolved = true;
        try {
            for (const chunk of chunks(names)) {
                const marks = chunk.map(() => '?').join(',');
                for (const r of conn.prepare(`select called_name as name, count(*) as n from unresolved_calls
                        where called_name in (${marks}) and reason = 'unknown_receiver' group by called_name`).all(...chunk)) {
                    unresolvedOf.set(String(r.name), Number(r.n));
                }
            }
        } catch (e) { hasUnresolved = false; }
        let parseError = null;
        try { parseError = conn.prepare('select parse_error from files where res_path = ?').get(resPath)?.parse_error || null; } catch (e) { parseError = null; }
        const functions = fns.map(f => ({
            name: String(f.name),
            scope: f.scope ? String(f.scope) : null,
            line: Number(f.line),
            callerCount: countOf.get(f.id) || 0,
            callers: (callersOf.get(f.id) || []).map(c => ({
                file: toProject(c.res_path), line: Number(c.line), function: String(c.name), scope: c.scope ? String(c.scope) : null
            })),
            unresolved: hasUnresolved ? (unresolvedOf.get(String(f.name)) || 0) : null
        }));
        let stale = false;
        try { stale = fs.statSync(abs).mtimeMs > dbStat.mtimeMs; } catch (e) { stale = false; }
        return { available: true, file: toPosix(path.relative(rootReal, abs)), [callers.rootField]: rootRel, functions, stale,
            parseError: parseError ? String(parseError).slice(0, 300) : null, builtAt: dbStat.mtime.toISOString() };
    } catch (e) {
        // The raw SQLite error only: the page words it in the owner's language (depgraph_page_calls_unreadable).
        return { ...out, reason: 'unreadable', hint: String(e && e.message || e).slice(0, 200) };
    } finally {
        try { conn && conn.close(); } catch (e) { /* already closed */ }
    }
}
