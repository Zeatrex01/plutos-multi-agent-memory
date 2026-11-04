// Local token ledger — what each project, model and session actually spent.
//
// Claude Code only (cleanup plan P2-3: the CodeBurn costs page and its spend module are gone; this
// stays as the start of a per-job token log, read by plutos_usage). It reads a source that is
// already on disk: the Claude CLI writes one JSONL transcript per session under
//
//     ~/.claude/projects/<encoded project path>/<sessionId>.jsonl
//
// and every assistant entry in it carries a `usage` block plus the model that produced it. So
// per-project, per-model and per-session attribution falls out of files the machine already
// has — no network, no npx, no key, and no dependency, which is the rest of this project's
// posture anyway.
//
// SUBAGENTS live one level down, in <sessionId>/subagents/agent-<id>.jsonl, and the first
// version of this module missed them entirely — which mattered, because "which agent burned
// what" is the question the ledger was built to answer. They are disjoint from the parent
// transcript rather than a copy of it: a sidechain entry in the parent carries no usage block
// at all (measured: 0 of 1371), so counting both is addition, not double counting.
//
// The one trap, and the reason `output + thinking` is what everything here ranks by: cache
// reads dwarf every other counter (measured 484M read against 1.3M output in a single
// session). A combined "total tokens" figure therefore ranks by cache reuse rather than by
// work done — the longest conversation wins regardless of what it produced. Cache reads are
// reported, in their own column, and never folded into the ranking.
import fs from 'fs';
import os from 'os';
import path from 'path';

// A transcript grows for as long as its session does. Reading one whole file at a time is
// fine; reading an unbounded pile of them on a dashboard poll is not, so both the per-file
// size and the total scanned are capped. Skipped files are counted and reported rather than
// silently dropped, so a truncated ledger never reads as a complete one.
export const USAGE_LIMITS = {
    maxFileBytes: 64 * 1024 * 1024,
    maxTotalBytes: 512 * 1024 * 1024,
    sessions: 25,
    agents: 25
};

// The bucket every non-subagent turn lands in, so the agent table's proportions are honest
// rather than showing only the small half.
export const MAIN_THREAD = 'main';

const CACHE_TTL_MS = 30 * 1000;
let cache = null;
let cachedAt = 0;

export function claudeProjectsDir() {
    return path.join(process.env.USERPROFILE || process.env.HOME || os.homedir() || '', '.claude', 'projects');
}

// The CLI flattens a project path into one directory name. Every separator it could have used
// collapses to a dash, so rather than trying to invert that (it is lossy — a real dash and a
// slash arrive identically), the active project is encoded the same way and compared.
export function encodeProjectDir(projectRoot) {
    return String(projectRoot || '').replace(/[^a-zA-Z0-9]/g, '-');
}

const zero = () => ({ calls: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0 });

// A subagent file names its agent only by id. The opening of its first message says what the
// agent was actually asked to be ("You are the Ponytail agent…"), which beats a hex string on
// a table the owner reads to decide who to hand work to. Taken from a JSON field rather than
// scraped out of harness prose, so it does not rot when that prose changes.
const LABEL_CHARS = 80;
function firstMessageLabel(text) {
    const line = text.slice(0, text.indexOf('\n') + 1 || undefined);
    try {
        const entry = JSON.parse(line);
        const content = entry && entry.message && entry.message.content;
        const raw = typeof content === 'string'
            ? content
            : (Array.isArray(content) ? ((content.find(b => b && b.type === 'text') || {}).text || '') : '');
        const flat = String(raw).replace(/\s+/g, ' ').trim();
        return flat ? flat.slice(0, LABEL_CHARS) : '';
    } catch (e) { return ''; }
}

// Every transcript under one project directory: the session files at the top, plus each
// session's subagent files one level down.
function transcriptsIn(projectDir) {
    const out = [];
    let entries = [];
    try { entries = fs.readdirSync(projectDir, { withFileTypes: true }); } catch (e) { return out; }
    for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.jsonl')) {
            out.push({ file: path.join(projectDir, e.name), session: e.name.slice(0, -6), agent: null });
            continue;
        }
        if (!e.isDirectory()) continue;
        const dir = path.join(projectDir, e.name, 'subagents');
        let subs = [];
        try { subs = fs.readdirSync(dir).filter(n => n.endsWith('.jsonl')); } catch (err) { continue; }
        for (const name of subs) {
            out.push({
                file: path.join(dir, name),
                session: e.name,
                agent: name.replace(/^agent-/, '').slice(0, -6)
            });
        }
    }
    return out;
}

function add(into, u) {
    into.calls += 1;
    into.input += u.input_tokens || 0;
    into.cacheWrite += u.cache_creation_input_tokens || 0;
    into.cacheRead += u.cache_read_input_tokens || 0;
    into.output += u.output_tokens || 0;
    into.thinking += (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0;
}

// What a seat actually produced. The ranking key everywhere in this module — see the header.
export const workDone = (t) => (t.output || 0) + (t.thinking || 0);

function bucket(map, key) {
    if (!map.has(key)) map.set(key, { ...zero() });
    return map.get(key);
}

function scanFile(file, onEntry) {
    // One transcript is one string here. Each is released before the next is read, so peak
    // memory is the largest file rather than the whole pile.
    const text = fs.readFileSync(file, 'utf8');
    const label = firstMessageLabel(text);
    for (const line of text.split('\n')) {
        // Most lines carry no usage at all (queue operations, user turns, tool results). The
        // substring test is what keeps this cheap enough to run on a dashboard poll.
        if (!line || line.indexOf('"usage"') === -1) continue;
        let entry;
        try { entry = JSON.parse(line); } catch (e) { continue; }
        const usage = entry && entry.message && entry.message.usage;
        if (!usage) continue;
        onEntry(usage, entry);
    }
    return label;
}

// onlyProject reads just this project's transcript folder: enough for its own totals
// (plutos_usage), and a full scan of every project can take tens of seconds (B37).
export function readTokenUsage(projectRoot = '', { force = false, onlyProject = false } = {}) {
    const key = encodeProjectDir(projectRoot), slot = (onlyProject ? 'p:' : 'a:') + key;
    // Both readings are held for CACHE_TTL_MS, apart, so switching tabs does not re-read a long
    // project's transcripts each time (they can run to hundreds of MB); force reads again.
    if (!force && cache && cache.key === slot && Date.now() - cachedAt < CACHE_TTL_MS) return cache.value;
    const value = scanUsage(projectRoot, key, onlyProject);
    cache = { key: slot, value };
    cachedAt = Date.now();
    return value;
}

function scanUsage(projectRoot, key, onlyProject) {

    const root = claudeProjectsDir();
    const value = {
        available: false, dir: root,
        scannedFiles: 0, skippedFiles: 0, scannedBytes: 0, truncated: false,
        totals: zero(), projects: [], models: [], sessions: [], agents: [],
        currentProject: key || null, limits: USAGE_LIMITS
    };

    let dirs = [];
    try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && (!onlyProject || d.name === key)); }
    catch (e) { return value; }
    value.available = true;

    const byProject = new Map(), byModel = new Map(), bySession = new Map(), byAgent = new Map();
    const sessionMeta = new Map(), agentMeta = new Map();

    for (const d of dirs) {
        const transcripts = transcriptsIn(path.join(root, d.name));

        for (const { file, session: sessionId, agent } of transcripts) {
            let size = 0;
            try { size = fs.statSync(file).size; } catch (e) { continue; }
            if (size > USAGE_LIMITS.maxFileBytes
                || value.scannedBytes + size > USAGE_LIMITS.maxTotalBytes) {
                value.skippedFiles += 1;
                value.truncated = true;
                continue;
            }
            let seen = false;
            try {
                // A subagent's spend belongs to its parent session and project as well as to
                // itself — it is work done for them, not somewhere else.
                const agentKey = agent || MAIN_THREAD;
                const label = scanFile(file, (usage, entry) => {
                    seen = true;
                    add(value.totals, usage);
                    add(bucket(byProject, d.name), usage);
                    add(bucket(byModel, (entry.message && entry.message.model) || 'unknown'), usage);
                    add(bucket(bySession, sessionId), usage);
                    add(bucket(byAgent, agentKey), usage);
                    const meta = sessionMeta.get(sessionId) || { project: d.name, first: '', last: '' };
                    const ts = entry.timestamp || '';
                    if (ts) {
                        if (!meta.first || ts < meta.first) meta.first = ts;
                        if (!meta.last || ts > meta.last) meta.last = ts;
                    }
                    sessionMeta.set(sessionId, meta);
                });
                if (agent && !agentMeta.has(agent)) agentMeta.set(agent, { session: sessionId, label });
            } catch (e) { value.skippedFiles += 1; value.truncated = true; continue; }
            value.scannedBytes += size;
            if (seen) value.scannedFiles += 1;
        }
    }

    const rank = (a, b) => workDone(b) - workDone(a);
    value.projects = [...byProject.entries()]
        .map(([name, t]) => ({ name, current: name === key, ...t })).sort(rank);
    value.models = [...byModel.entries()].map(([name, t]) => ({ name, ...t })).sort(rank);
    // Subagents first — this table exists to answer "who burned what", and the main thread is
    // context for that rather than the answer. It is still shown, or the proportions lie.
    value.agents = [...byAgent.entries()]
        .map(([id, t]) => ({
            id,
            main: id === MAIN_THREAD,
            label: (agentMeta.get(id) || {}).label || '',
            session: (agentMeta.get(id) || {}).session || '',
            ...t
        }))
        .sort((a, b) => (a.main === b.main) ? rank(a, b) : (a.main ? 1 : -1))
        .slice(0, USAGE_LIMITS.agents);

    value.sessions = [...bySession.entries()]
        .map(([id, t]) => ({
            id,
            project: (sessionMeta.get(id) || {}).project || '',
            started: (sessionMeta.get(id) || {}).first || '',
            ended: (sessionMeta.get(id) || {}).last || '',
            ...t
        }))
        .sort(rank)
        .slice(0, USAGE_LIMITS.sessions);

    return value;
}
