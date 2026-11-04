// Fast, fail-closed intake for automatic Claude session capture.
//
// Hook calls happen inside Claude Code's lifecycle budget. This module validates that the
// transcript belongs to Claude's own config tree and that the hook cwd belongs to the MCP's
// bound project, then writes one tiny sidecar job and detaches a worker. Raw transcript bytes
// are never copied into PLUT_OS or the project.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { APP_ROOT, PLUTOS_HOME_DIR } from './approot.mjs';

export const CAPTURE_EVENTS = Object.freeze(['PreCompact', 'SessionEnd']);
const TRUNCATED = ' …[truncated]';

export const CAPTURE_LIMITS = Object.freeze({
    identityChars: 200,
    pathChars: 4096,
    transcriptBytes: 64 * 1024 * 1024,
    extractBytes: 4 * 1024 * 1024,
    extractChars: 160_000,
    messageChars: 24_000,
    outcomesPerProject: 40,
    queuedStaleMs: 10 * 60 * 1000
});

// Keep the detached worker as a real source file beside the application. In the portable MCP
// bundle import.meta.url points at dist/index.mjs, not lib/context-capture.mjs; APP_ROOT keeps
// the worker path correct in both source and bundled layouts.
const WORKER_FILE = path.join(APP_ROOT, 'lib', 'context-worker.mjs');

function hash(value) {
    return createHash('sha256').update(String(value)).digest('hex');
}

function boundedString(name, value, max, { required = true } = {}) {
    if (value == null || value === '') {
        if (required) throw new Error(`${name} is required.`);
        return '';
    }
    if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
    const out = value.trim();
    if (!out && required) throw new Error(`${name} is required.`);
    if (out.length > max) throw new Error(`${name} exceeds the ${max}-character limit.`);
    return out;
}

function within(root, candidate) {
    const rel = path.relative(root, candidate);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function realDirectory(dir) {
    try { return fs.realpathSync(dir); } catch (e) { return path.resolve(dir); }
}

function existingDirectory(name, dir) {
    let real;
    try { real = fs.realpathSync(dir); }
    catch (e) { throw new Error(`${name} is missing or unreadable.`); }
    if (!fs.statSync(real).isDirectory()) throw new Error(`${name} is not a directory.`);
    return real;
}

export function claudeConfigRoots(env = process.env) {
    const roots = [];
    if (env.CLAUDE_CONFIG_DIR) roots.push(path.resolve(env.CLAUDE_CONFIG_DIR));
    const profile = env.USERPROFILE || env.HOME || os.homedir();
    if (profile) roots.push(path.resolve(profile, '.claude'));
    return [...new Set(roots.map(realDirectory))];
}

export function validateCaptureRequest(projectRoot, input = {}, { env = process.env } = {}) {
    const root = existingDirectory('project root', projectRoot);
    const sessionId = boundedString('session_id', input.session_id || input.sessionId, CAPTURE_LIMITS.identityChars);
    const event = boundedString('event', input.event, 40);
    if (!CAPTURE_EVENTS.includes(event)) throw new Error(`event must be ${CAPTURE_EVENTS.join(' or ')}.`);

    const requestedCwd = boundedString('cwd', input.cwd, CAPTURE_LIMITS.pathChars);
    if (!path.isAbsolute(requestedCwd)) throw new Error('cwd must be an absolute path.');
    const cwd = existingDirectory('cwd', requestedCwd);
    if (!within(root, cwd)) throw new Error('Hook cwd is outside this PLUT_OS project; capture refused.');

    const requestedTranscript = boundedString('transcript_path', input.transcript_path || input.transcriptPath, CAPTURE_LIMITS.pathChars);
    if (!path.isAbsolute(requestedTranscript) || path.extname(requestedTranscript).toLowerCase() !== '.jsonl') {
        throw new Error('transcript_path must be an absolute Claude JSONL path.');
    }
    let transcriptPath;
    let stat;
    try {
        transcriptPath = fs.realpathSync(requestedTranscript);
        stat = fs.statSync(transcriptPath);
    } catch (e) {
        throw new Error('Claude transcript is missing or unreadable.');
    }
    if (!stat.isFile()) throw new Error('Claude transcript is not a file.');
    if (stat.size > CAPTURE_LIMITS.transcriptBytes) {
        throw new Error(`Claude transcript exceeds the ${Math.round(CAPTURE_LIMITS.transcriptBytes / 1024 / 1024)} MB capture limit.`);
    }
    const allowedRoots = claudeConfigRoots(env);
    if (!allowedRoots.some(configRoot => within(configRoot, transcriptPath))) {
        throw new Error('transcript_path is outside Claude\'s config directory; capture refused.');
    }

    return {
        projectRoot: root,
        sessionId,
        event,
        cwd,
        transcriptPath,
        reason: boundedString('reason', input.reason, 80, { required: false }),
        trigger: boundedString('trigger', input.trigger, 80, { required: false }),
        transcriptBytes: stat.size,
        transcriptMtimeMs: Math.trunc(stat.mtimeMs)
    };
}

export function captureJobsDir(projectRoot, homeDir = PLUTOS_HOME_DIR) {
    return path.join(homeDir, 'context-jobs', hash(realDirectory(projectRoot)).slice(0, 24));
}

function pruneOutcomes(jobsDir) {
    const outcomes = fs.readdirSync(jobsDir)
        .filter(name => /^[a-f0-9]{32}\.(?:done|failed)\.json$/i.test(name))
        .map(name => {
            const file = path.join(jobsDir, name);
            try { return { file, mtime: fs.statSync(file).mtimeMs }; } catch (e) { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime);
    for (const old of outcomes.slice(CAPTURE_LIMITS.outcomesPerProject)) {
        try { fs.rmSync(old.file); } catch (e) { /* retention cleanup is best-effort */ }
    }
}

function expireStaleQueues(jobsDir) {
    for (const name of fs.readdirSync(jobsDir).filter(item => /^[a-f0-9]{32}\.queued\.json$/i.test(item))) {
        const queued = path.join(jobsDir, name);
        let stat;
        try { stat = fs.statSync(queued); } catch (e) { continue; }
        if (Date.now() - stat.mtimeMs <= CAPTURE_LIMITS.queuedStaleMs) continue;
        const id = name.slice(0, 32);
        let event = 'unknown';
        try {
            if (stat.size <= 64 * 1024) {
                const payload = JSON.parse(fs.readFileSync(queued, 'utf8'));
                if (CAPTURE_EVENTS.includes(payload?.event)) event = payload.event;
            }
        } catch (e) { /* generic expiry outcome is enough */ }
        const failed = path.join(jobsDir, `${id}.failed.json`);
        try {
            if (fs.existsSync(failed) || fs.existsSync(path.join(jobsDir, `${id}.done.json`))) {
                fs.rmSync(queued);
                continue;
            }
            fs.writeFileSync(failed, JSON.stringify({
                version: 1, id, event, finishedAt: new Date().toISOString(),
                error: 'Capture worker did not finish within the retry window.'
            }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
            fs.rmSync(queued);
        } catch (e) { /* another process may be completing or expiring the same job */ }
    }
}

function statusText(value, max = 700) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function statusCount(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(1000, Math.max(0, Math.trunc(number))) : 0;
}

// A privacy-safe dashboard view of the sidecar queue. Queued jobs contain the absolute
// transcript path so the detached worker can re-open it; that path (and the project path)
// must never cross the API boundary. Only bounded state, event, timestamps and diagnostics
// are returned here.
export function contextCaptureStatus(projectRoot, homeDir = PLUTOS_HOME_DIR) {
    const jobsDir = captureJobsDir(projectRoot, homeDir);
    const empty = { queued: 0, staleQueued: 0, last: null };
    if (!fs.existsSync(jobsDir)) return empty;

    let names;
    try { names = fs.readdirSync(jobsDir); } catch (e) { return empty; }
    const candidates = [];
    let queued = 0;
    let staleQueued = 0;
    for (const name of names) {
        const match = /^([a-f0-9]{32})\.(queued|done|failed)\.json$/i.exec(name);
        if (!match) continue;
        const file = path.join(jobsDir, name);
        let stat;
        try { stat = fs.statSync(file); } catch (e) { continue; }
        if (!stat.isFile()) continue;
        const stale = match[2] === 'queued' && Date.now() - stat.mtimeMs > CAPTURE_LIMITS.queuedStaleMs;
        if (match[2] === 'queued') {
            queued++;
            if (stale) staleQueued++;
        }
        candidates.push({ id: match[1], state: match[2], file, mtimeMs: stat.mtimeMs, bytes: stat.size, stale });
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (!candidates.length) return { queued, staleQueued, last: null };

    const latest = candidates[0];
    let payload = {};
    try {
        // Outcome files are tiny by contract. Refuse a tampered oversized sidecar instead of
        // parsing arbitrary Hub content into a dashboard response.
        if (latest.bytes <= 64 * 1024) {
            const parsed = JSON.parse(fs.readFileSync(latest.file, 'utf8'));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed;
        }
    } catch (e) { /* expose a bounded generic diagnostic below */ }
    const event = CAPTURE_EVENTS.includes(payload.event) ? payload.event : '';
    const at = statusText(payload.finishedAt || payload.createdAt || new Date(latest.mtimeMs).toISOString(), 80);
    const last = {
        id: latest.id,
        state: latest.state,
        event,
        at,
        stale: latest.stale
    };
    if (latest.state === 'done') {
        last.skipped = payload.skipped === true;
        last.reason = statusText(payload.reason, 120);
        last.duplicate = payload.duplicate === true;
        if (payload.context && typeof payload.context === 'object') {
            last.context = {
                sourceBacked: statusCount(payload.context.sourceBacked),
                unverified: statusCount(payload.context.unverified)
            };
        }
    } else if (latest.state === 'failed') {
        last.error = statusText(payload.error || 'Capture outcome could not be read.');
    }
    return { queued, staleQueued, last };
}

export function enqueueContextCapture(projectRoot, input = {}, options = {}) {
    const validated = validateCaptureRequest(projectRoot, input, options);
    const jobsDir = captureJobsDir(validated.projectRoot, options.homeDir || PLUTOS_HOME_DIR);
    fs.mkdirSync(jobsDir, { recursive: true });
    expireStaleQueues(jobsDir);
    const id = hash([
        validated.projectRoot,
        validated.sessionId,
        validated.event,
        validated.transcriptBytes,
        validated.transcriptMtimeMs
    ].join('\u0001')).slice(0, 32);
    const queued = path.join(jobsDir, `${id}.queued.json`);
    const done = path.join(jobsDir, `${id}.done.json`);
    const failed = path.join(jobsDir, `${id}.failed.json`);
    pruneOutcomes(jobsDir);
    if (fs.existsSync(queued)) return { queued: false, duplicate: true, id, event: validated.event };
    if (fs.existsSync(done)) {
        return { queued: false, duplicate: true, id, event: validated.event };
    }

    const job = {
        version: 1,
        id,
        createdAt: new Date().toISOString(),
        ...validated
    };
    try {
        fs.writeFileSync(queued, JSON.stringify(job, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    } catch (e) {
        if (e.code === 'EEXIST') return { queued: false, duplicate: true, id, event: validated.event };
        throw e;
    }
    // A same-fingerprint failure may be retried explicitly: the old diagnostic is retained
    // until the retry is accepted, then replaced by the next worker outcome.
    try { if (fs.existsSync(failed)) fs.rmSync(failed); } catch (e) { /* diagnostic cleanup is best-effort */ }

    if (options.spawnWorker !== false) {
        try {
            const child = spawn(process.execPath, [WORKER_FILE, queued], {
                cwd: jobsDir,
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
                env: { ...process.env, PLUTOS_CONTEXT_WORKER: '1' }
            });
            // process.execPath normally cannot fail, but an error event without a listener
            // would crash the long-lived MCP server. Persist a path-free diagnostic; if that
            // write itself fails, keep the queued job so stale-job recovery can surface it.
            child.once('error', () => {
                let persisted = false;
                try {
                    fs.writeFileSync(failed, JSON.stringify({
                        version: 1, id, event: validated.event, finishedAt: new Date().toISOString(),
                        error: 'Capture worker could not start.'
                    }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
                    persisted = true;
                } catch (e) { if (e.code === 'EEXIST') persisted = true; }
                if (persisted) {
                    try { fs.rmSync(queued); } catch (e) { /* worker may already own it */ }
                }
            });
            child.unref();
        } catch (e) {
            try { fs.rmSync(queued); } catch (e2) { /* leave no job that cannot run */ }
            throw new Error(`Could not start the context capture worker: ${e.message}`);
        }
    }
    return { queued: true, duplicate: false, id, event: validated.event };
}

function textFromContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .filter(block => block && block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('\n');
}

function redact(text) {
    return text
        .replace(/\b(?:sk-ant|sk-proj|ghp|github_pat)[-_][A-Za-z0-9_-]{12,}\b/g, '[REDACTED_TOKEN]')
        .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_AWS_KEY]')
        .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s"']+/ig, '$1[REDACTED]');
}

function tailUtf8(file, maxBytes) {
    const stat = fs.statSync(file);
    const length = Math.min(stat.size, maxBytes);
    const fd = fs.openSync(file, 'r');
    try {
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, stat.size - length);
        let text = buffer.toString('utf8');
        if (stat.size > length) text = text.slice(Math.max(0, text.indexOf('\n') + 1));
        return text;
    } finally {
        fs.closeSync(fd);
    }
}

export function extractTranscriptText(transcriptPath) {
    const raw = tailUtf8(transcriptPath, CAPTURE_LIMITS.extractBytes);
    const messages = [];
    for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); } catch (e) { continue; }
        if (row.isSidechain || row.parent_tool_use_id) continue;
        const role = row.type === 'assistant' || row.message?.role === 'assistant'
            ? 'assistant'
            : row.type === 'user' || row.message?.role === 'user' ? 'user' : '';
        if (!role) continue;
        let body = textFromContent(row.message?.content ?? row.content);
        if (!body || /^\s*<(?:system-reminder|local-command)/i.test(body)) continue;
        body = redact(body.trim());
        if (body.length > CAPTURE_LIMITS.messageChars) body = body.slice(0, CAPTURE_LIMITS.messageChars - TRUNCATED.length) + TRUNCATED;
        messages.push(`${role.toUpperCase()}: ${body}`);
    }
    let text = messages.join('\n\n');
    if (text.length > CAPTURE_LIMITS.extractChars) text = text.slice(-CAPTURE_LIMITS.extractChars);
    return text;
}

function containsManualEnd(value) {
    if (!value || typeof value !== 'object') return false;
    if (value.type === 'tool_use' && /(?:^|__)session_end$/i.test(String(value.name || ''))) return true;
    if (Array.isArray(value)) return value.some(containsManualEnd);
    return Object.values(value).some(containsManualEnd);
}

export function transcriptHasManualSessionEnd(transcriptPath) {
    const raw = tailUtf8(transcriptPath, CAPTURE_LIMITS.extractBytes);
    for (const line of raw.split(/\r?\n/).reverse()) {
        if (!line.includes('session_end')) continue;
        try { if (containsManualEnd(JSON.parse(line))) return true; } catch (e) { /* malformed tail line */ }
    }
    return false;
}
