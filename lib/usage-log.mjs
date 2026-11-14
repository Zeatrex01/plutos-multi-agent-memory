// The usage log (owner, d-604591d0021d): how much PLUT_OS is used and by which AIs, written as it
// happens, so nobody counts by hand in a field report. One JSON line per event in the project's
// .plutos/usage.jsonl, local only and kept out of git:
//
//   {"t":"<ISO>","ai":"Claude Code","kind":"tool"|"hook","name":"board_read","ok":true,"ms":12}
//
// A hook line may add "agent" (the sub-agent type); a session_start line may add "readOnly": true
// (a side session that only reports, not a session start). Nothing else is ever written: no arguments,
// no outputs, no paths, no content. Every field is whitelisted and clipped here, whatever the
// caller passes.
//
// It never throws and never slows a call: one appendFileSync in a try/catch, a size check that
// rotates the file to usage.1.jsonl past MAX_BYTES (so at most two files), and nothing at all
// outside a PLUT_OS project. Rotation runs under a non-blocking lock and re-checks the size inside
// it, so two servers on one project never rotate twice (the second would rename the first's fresh
// file over the rotated history). A rotation that keeps failing (Windows EPERM/EBUSY) stops the
// appends past 2x the cap instead of growing a file the report would skip.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { looksLikePlutosProject } from './workspaces.mjs';
import { withIgnoreLines } from './context-automation.mjs';
import { clientFromEnv, canonicalClientName } from './presence.mjs';

export const USAGE_FILE = '.plutos/usage.jsonl';
export const USAGE_ROTATED = '.plutos/usage.1.jsonl';
export const MAX_BYTES = 2 * 1024 * 1024;
export const USAGE_IGNORE = '.plutos/.gitignore';
const ROTATE_LOCK = '.plutos/usage.rotate.lock';
const STALE_LOCK_MS = 10_000;
const KINDS = new Set(['tool', 'hook']);
const clip = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, n) : null);

// A server records every tool call of its project: the project check is cached per root.
const projectCache = new Map();
function isProject(root) {
    if (!projectCache.has(root)) projectCache.set(root, looksLikePlutosProject(root));
    return projectCache.get(root);
}

// The first write in a project keeps both files out of git. A project that already ignores them
// (this repository ignores .plutos/) gets no edit. Otherwise the ignore lines go in
// .plutos/.gitignore, next to the files: git honours it wherever the repository root is, so a
// project in a subfolder of a repository (repo/app/, .git only in repo/) is covered too, and the
// project's own .gitignore is never touched.
function ensureIgnored(root) {
    try {
        // Not -q: git refuses --quiet with two paths (exit 128), which read as "not ignored".
        const out = execFileSync('git', ['-C', root, 'check-ignore', USAGE_FILE, USAGE_ROTATED],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 2000 });
        const listed = out.split(/\r?\n/).map(l => l.trim().replace(/\\/g, '/'));
        if (listed.includes(USAGE_FILE) && listed.includes(USAGE_ROTATED)) return; // both ignored already
    } catch { /* not ignored, not a repository, or no git */ }
    try {
        const file = path.join(root, USAGE_IGNORE);
        let content = '';
        try { content = fs.readFileSync(file, 'utf8'); } catch { /* none yet */ }
        const next = withIgnoreLines(content, ['usage.jsonl', 'usage.1.jsonl']);
        if (next !== null) fs.writeFileSync(file, next);
    } catch { /* best effort */ }
}

// Rotates <root>/.plutos/usage.jsonl when it is still at or above the cap. Non-blocking: a lock
// another process holds means it is rotating now, so this call appends and moves on. → false only
// when the file could not be rotated and is past twice the cap (the append is then skipped).
function rotate(root, maxBytes) {
    const file = path.join(root, USAGE_FILE);
    const lock = path.join(root, ROTATE_LOCK);
    try { fs.mkdirSync(lock); } catch (e) {
        if (e.code === 'EEXIST') {
            try { if (Date.now() - fs.statSync(lock).mtimeMs > STALE_LOCK_MS) fs.rmSync(lock, { recursive: true, force: true }); } catch { /* gone */ }
        }
        return sizeOf(file) < 2 * maxBytes;
    }
    try {
        // Re-checked under the lock: another process may have rotated since this one looked.
        if (sizeOf(file) >= maxBytes) {
            try { fs.renameSync(file, path.join(root, USAGE_ROTATED)); } catch { /* EPERM/EBUSY: checked below */ }
        }
    } finally { try { fs.rmdirSync(lock); } catch { /* released by a stale-lock sweep */ } }
    return sizeOf(file) < 2 * maxBytes;
}
const sizeOf = (file) => { try { return fs.statSync(file).size; } catch { return -1; } };

/** The line written for an entry, or null when it is not a usage event. Pure. */
export function usageLine(entry, { now = new Date(), env = process.env } = {}) {
    if (!entry || typeof entry !== 'object' || !KINDS.has(entry.kind)) return null;
    const name = clip(entry.name, 80);
    if (!name) return null;
    const ai = clip(canonicalClientName(entry.ai) || entry.ai, 60) || clientFromEnv(env) || 'unknown';
    const ms = Number.isFinite(entry.ms) ? Math.max(0, Math.round(entry.ms)) : 0;
    const line = { t: now.toISOString(), ai, kind: entry.kind, name, ok: entry.ok === true, ms };
    const agent = entry.kind === 'hook' ? clip(entry.agent, 60) : null;
    if (agent) line.agent = agent;
    if (entry.kind === 'tool' && name === 'session_start' && entry.readOnly === true) line.readOnly = true;
    return JSON.stringify(line);
}

/** Appends one usage event to <root>/.plutos/usage.jsonl. → true when written. Never throws. */
export function recordUsage(root, entry, opts = {}) {
    try {
        if (typeof root !== 'string' || !root || !isProject(root)) return false;
        const line = usageLine(entry, opts);
        if (!line) return false;
        const file = path.join(root, USAGE_FILE);
        const maxBytes = opts.maxBytes ?? MAX_BYTES;
        const size = sizeOf(file);
        if (size >= maxBytes) {
            if (!rotate(root, maxBytes)) return false;
        } else if (size < 0) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            ensureIgnored(root);
        }
        fs.appendFileSync(file, line + '\n');
        return true;
    } catch { return false; }
}
