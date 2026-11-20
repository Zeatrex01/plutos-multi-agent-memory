// Codex half of the local token ledger (lib/usage.mjs merges it with Claude Code's).
//
// Codex writes one JSONL file per session under
//
//     ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<sessionId>.jsonl
//
// Shapes read here (observed 2026-11-20, Codex CLI 0.167):
//   - first line, type "session_meta": payload.id (session) and payload.cwd (the project path).
//   - type "turn_context": payload.model, the model for the turns that follow. (session_meta
//     itself carries no model.)
//   - type "token_usage_record": payload.usage, one per model response, with response_id.
//   - type "event_msg" whose payload.type is "token_count": payload.info.total_token_usage, the
//     CUMULATIVE total of the thread so far.
// In a measured session the records summed to exactly the last token_count total (883171 input,
// 6494 output), so they are the same tokens counted twice. A response is therefore counted once:
// the records when the file has any, else the last cumulative total. Never both.
//
// Field mapping onto the ledger's columns (see normalize): Codex input_tokens INCLUDES the cached
// part (total_tokens = input + output) and output_tokens INCLUDES reasoning, whereas the ledger
// keeps cache reads in their own column and ranks by output + thinking. So:
//   input      = input_tokens - cached_input_tokens - cache_write_input_tokens
//   cacheRead  = cached_input_tokens          cacheWrite = cache_write_input_tokens
//   thinking   = reasoning_output_tokens      output     = output_tokens - reasoning_output_tokens
// output + thinking therefore equals Codex's own output_tokens: reasoning is not counted twice.
//
// Files are read in chunks, line by line, and the project (cwd) is known from the first line, so
// a session that belongs to another project is dropped after one line instead of being read.
import fs from 'fs';
import os from 'os';
import path from 'path';

export const CODEX_CLIENT = 'codex';
// Files older than this many days (by their YYYY/MM/DD folder) are not read unless asked.
export const CODEX_DEFAULT_DAYS = 90;
const CHUNK_BYTES = 256 * 1024;
const MAX_FIRST_LINE = 4 * 1024 * 1024;

export function codexSessionsDir() {
    return path.join(process.env.USERPROFILE || process.env.HOME || os.homedir() || '', '.codex', 'sessions');
}

// Calls onLine(line) for each line; a truthy return stops the read. Memory stays at one chunk
// plus the current line, however large the file is.
function eachLine(file, onLine) {
    const fd = fs.openSync(file, 'r');
    try {
        const buf = Buffer.allocUnsafe(CHUNK_BYTES);
        let carry = '';
        for (;;) {
            const n = fs.readSync(fd, buf, 0, CHUNK_BYTES, null);
            if (n === 0) break;
            const parts = (carry + buf.toString('utf8', 0, n)).split('\n');
            carry = parts.pop();
            for (const line of parts) if (line && onLine(line)) return;
        }
        if (carry) onLine(carry);
    } finally { fs.closeSync(fd); }
}

// Codex usage block -> the Claude-shaped block that lib/usage.mjs add() reads.
export function normalize(u) {
    const total = Number(u.input_tokens) || 0, cached = Number(u.cached_input_tokens) || 0;
    const write = Number(u.cache_write_input_tokens) || 0, out = Number(u.output_tokens) || 0;
    const reasoning = Math.min(Number(u.reasoning_output_tokens) || 0, out);
    return {
        input_tokens: Math.max(0, total - cached - write),
        cache_creation_input_tokens: write,
        cache_read_input_tokens: cached,
        output_tokens: out - reasoning,
        output_tokens_details: { thinking_tokens: reasoning }
    };
}

// One session file -> { sessionId, cwd, first, last, entries: [{ model, usage, timestamp }] },
// or null when `wantCwd(cwd)` says it is not wanted (or the file is not a Codex session).
// `entries` hold normalized usage; with no token_usage_record the single entry is the last
// cumulative total (one call, however many responses it covered).
export function readCodexSession(file, wantCwd = () => true) {
    let meta = null, model = '', first = '', last = '', skip = false;
    const records = [], seen = new Set();
    let total = null, totalTs = '', totalModel = '';
    eachLine(file, (line) => {
        if (!meta) {
            if (line.length > MAX_FIRST_LINE) { skip = true; return true; }
            let e; try { e = JSON.parse(line); } catch (err) { skip = true; return true; }
            if (!e || e.type !== 'session_meta' || !e.payload) { skip = true; return true; }
            meta = { sessionId: e.payload.id || e.payload.session_id || '', cwd: e.payload.cwd || '' };
            model = e.payload.model || '';
            if (!wantCwd(meta.cwd)) { skip = true; return true; }
            return false;
        }
        const isRecord = line.indexOf('"token_usage_record"') !== -1;
        const isTurn = !isRecord && line.indexOf('"turn_context"') !== -1;
        const isCount = !isRecord && !isTurn && line.indexOf('"token_count"') !== -1;
        if (!isRecord && !isTurn && !isCount) return false;
        let e; try { e = JSON.parse(line); } catch (err) { return false; }
        const p = e && e.payload;
        if (!p) return false;
        const ts = e.timestamp || '';
        if (e.type === 'turn_context') { if (p.model) model = p.model; return false; }
        if (e.type === 'token_usage_record' && p.usage) {
            const id = p.response_id || '';
            if (id) { if (seen.has(id)) return false; seen.add(id); }
            records.push({ model: model || 'unknown', usage: normalize(p.usage), timestamp: ts });
        } else if (p.type === 'token_count' && p.info && p.info.total_token_usage) {
            total = p.info.total_token_usage; totalTs = ts; totalModel = model;
        } else return false;
        if (ts) { if (!first || ts < first) first = ts; if (!last || ts > last) last = ts; }
        return false;
    });
    if (skip || !meta) return null;
    const entries = records.length ? records
        : (total ? [{ model: totalModel || 'unknown', usage: normalize(total), timestamp: totalTs }] : []);
    return { sessionId: meta.sessionId, cwd: meta.cwd, first, last, entries };
}

// Session files under ~/.codex/sessions, newest day first, limited to the last `sinceDays` days
// by their YYYY/MM/DD folder (a UTC date). → [{ file, size, mtimeMs }]
export function codexFiles({ sinceDays = CODEX_DEFAULT_DAYS, now = Date.now(), root = codexSessionsDir() } = {}) {
    const out = [];
    const cutoff = Date.UTC(1970, 0, 1) + Math.floor((now - Math.max(0, sinceDays) * 86400000) / 86400000) * 86400000;
    const dirs = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort().reverse(); } catch (e) { return []; } };
    for (const y of dirs(root)) {
        if (!/^\d{4}$/.test(y)) continue;
        for (const m of dirs(path.join(root, y))) {
            if (!/^\d{2}$/.test(m)) continue;
            for (const d of dirs(path.join(root, y, m))) {
                if (!/^\d{2}$/.test(d)) continue;
                if (Date.UTC(Number(y), Number(m) - 1, Number(d)) < cutoff) continue;
                const dir = path.join(root, y, m, d);
                let names = [];
                try { names = fs.readdirSync(dir).filter(n => n.startsWith('rollout-') && n.endsWith('.jsonl')); } catch (e) { continue; }
                for (const n of names) {
                    const file = path.join(dir, n);
                    try { const st = fs.statSync(file); out.push({ file, size: st.size, mtimeMs: st.mtimeMs }); } catch (e) { /* vanished */ }
                }
            }
        }
    }
    return out;
}
