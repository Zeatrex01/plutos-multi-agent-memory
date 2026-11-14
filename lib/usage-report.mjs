// The usage report (owner decision d-604591d0021d): how much PLUT_OS is used, and by which AIs,
// read from the project's local usage log instead of counted by hand in field reports.
//
// Not the token ledger: `plutos_usage` (lib/usage.mjs) answers "how many tokens did each session
// spend"; this answers "which AIs called which PLUT_OS tools and hooks, how often". Two names on
// purpose: `plutos usage` on the command line and GET /api/usage are this report.
//
// Sources, all local and read-only:
//   .plutos/usage.jsonl (and the rotated usage.1.jsonl): one line per tool call or hook run,
//     { t, ai|client, kind: "tool"|"hook", name, ok, ms }. No arguments, outputs or paths are in it,
//     so none can reach this report. The file is git-ignored and written by the MCP server and
//     the hooks; this module never writes it.
//   docs/handoff/CONTINUITY.md and archive/SESSIONS-*.md: the session_end records.
//   git log --since (no network): days with commits; skipped when git or the repository is absent.
//
// What it cannot tell, and says so: a sub-agent's PLUT_OS call reaches the server as its parent's,
// so "which agent made this call" is not in the log. It reports sub-agent starts against tool calls
// as a ratio and nothing more.
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { APP_ROOT } from './approot.mjs';
import { canonicalClientName } from './presence.mjs';
import { USAGE_FILE, USAGE_ROTATED } from './usage-log.mjs';

export const USAGE_REPORT_LIMITS = {
    days: 7,
    maxDays: 365,
    // The writer rotates past 2 MB; anything far above that is not ours to parse on a poll.
    maxLogBytes: 8 * 1024 * 1024,
    maxRecordBytes: 4 * 1024 * 1024,
    topTools: 10,
    gitTimeoutMs: 5000,
    // A session_start this soon after a brief hook of the same AI is that session asking again,
    // not a second session.
    pairMs: 15 * 60 * 1000
};
export const NO_USAGE_NOTE = 'no usage recorded yet; it starts with this version';
export const SUBAGENT_NOTE = 'The log cannot tell which agent made a call: a sub-agent\'s PLUT_OS call reaches the server as its parent\'s. '
    + 'This is a ratio of starts to calls, not calls per sub-agent.';

// The tools an AI sees without opening a drawer. Read from the sources that declare them, so a new
// tool is counted without editing this file; the constant is the fallback for a bundled build.
const LISTED_SOURCES = ['index.mjs', path.join('lib', 'code-tools.mjs'), path.join('lib', 'drawers.mjs')];
const LISTED_FALLBACK = ['plutos_project_info', 'board_read', 'plutos_context_for_task', 'board_update', 'plutos_ask',
    'plutos_create_agent', 'session_start', 'session_end', 'plutos_decide', 'plutos_capture_session',
    'plutos_code_lookup', 'plutos_usage', 'plutos_modules'];

export function listedTools(appRoot = APP_ROOT) {
    const names = new Set();
    for (const rel of LISTED_SOURCES) {
        try {
            const text = fs.readFileSync(path.join(appRoot, rel), 'utf8');
            for (const m of text.matchAll(/^\s*name:\s*["']([a-z][a-z0-9_]*)["'],?\s*$/gm)) names.add(m[1]);
        } catch { /* a bundled build: fall back below */ }
    }
    return names.size ? [...names] : [...LISTED_FALLBACK];
}

const aiName = raw => {
    const s = String(raw || '').trim();
    return s ? (canonicalClientName(s) || s) : 'unknown';
};

// Hook ids, by what they mean here. The hook names are whatever the writer records; these match
// the ids `plutos hooks` uses (brief, subagent, session-close) and their longer spellings. The brief
// hook also fires on /clear and on a compact: the writer records those as brief:clear and
// brief:compact, which are hook runs but not session starts. "brief" alone (and brief:startup)
// is a start; a log from before the source was recorded counts every brief.
const isBriefHook = name => /^(brief|session[-_ ]?start)/i.test(name);
const isBriefStart = name => isBriefHook(name) && !/:/.test(name) || /:startup$/i.test(name);
const isSubagentHook = name => /subagent/i.test(name) && !/stop/i.test(name);

function readLines(file) {
    try {
        const stat = fs.statSync(file);
        if (!stat.isFile()) return { lines: [], skipped: false };
        if (stat.size > USAGE_REPORT_LIMITS.maxLogBytes) return { lines: [], skipped: true };
        return { lines: fs.readFileSync(file, 'utf8').split(/\r?\n/), skipped: false };
    } catch { return { lines: [], skipped: false }; }
}

/** The usage events in [since, until), oldest first. → { recorded, events, malformed, skippedFiles } */
export function readUsageEvents(root, { since = 0, until = Infinity } = {}) {
    const files = [USAGE_ROTATED, USAGE_FILE].map(rel => path.join(root, rel));
    const recorded = files.some(f => fs.existsSync(f));
    const events = [];
    let malformed = 0, skippedFiles = 0;
    for (const file of files) {
        const { lines, skipped } = readLines(file);
        if (skipped) skippedFiles++;
        for (const line of lines) {
            if (!line.trim()) continue;
            let e;
            try { e = JSON.parse(line); } catch { malformed++; continue; }
            const t = Date.parse(e?.t);
            if (!e || typeof e.name !== 'string' || !e.name || Number.isNaN(t) || (e.kind !== 'tool' && e.kind !== 'hook')) { malformed++; continue; }
            if (t < since || t >= until) continue;
            events.push({ t, ai: aiName(e.ai ?? e.client), kind: e.kind, name: e.name.slice(0, 80), ok: e.ok !== false, ms: Number.isFinite(e.ms) ? e.ms : null,
                readOnly: e.readOnly === true });
        }
    }
    events.sort((a, b) => a.t - b.t);
    return { recorded, events, malformed, skippedFiles };
}

// The session_end records: "### <ISO time> · <ai> · <headline>" blocks.
function sessionRecords(root, since, until) {
    const handoff = path.join(root, 'docs', 'handoff');
    const files = [path.join(handoff, 'CONTINUITY.md')];
    const sinceMonth = new Date(since).toISOString().slice(0, 7);
    try {
        for (const f of fs.readdirSync(path.join(handoff, 'archive'))) {
            const m = f.match(/^SESSIONS-(\d{4}-\d{2})\.md$/);
            if (m && m[1] >= sinceMonth) files.push(path.join(handoff, 'archive', f));
        }
    } catch { /* no archive */ }
    const records = [];
    const seen = new Set();
    for (const file of files) {
        let text;
        try {
            if (fs.statSync(file).size > USAGE_REPORT_LIMITS.maxRecordBytes) continue;
            text = fs.readFileSync(file, 'utf8');
        } catch { continue; }
        for (const m of text.matchAll(/^### (\d{4}-\d{2}-\d{2}T[^\s·]+)\s+·\s+([^·\n]+?)\s+·/gm)) {
            const t = Date.parse(m[1]);
            if (Number.isNaN(t) || t < since || t >= until) continue;
            const key = `${m[1]}|${m[2]}`;
            if (seen.has(key)) continue;   // a block moved to the archive and still in CONTINUITY
            seen.add(key);
            records.push({ t, ai: aiName(m[2]) });
        }
    }
    return records;
}

const day = t => new Date(t).toISOString().slice(0, 10);

/** Commit counts per UTC day since `since`, or null when git or the repository is absent. */
export function gitCommitDays(root, since) {
    let out;
    try {
        out = execFileSync('git', ['-C', root, 'log', `--since=${new Date(since).toISOString()}`, '--format=%cI'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: USAGE_REPORT_LIMITS.gitTimeoutMs });
    } catch { return null; }
    const days = new Map();
    for (const line of out.split(/\r?\n/)) {
        const t = Date.parse(line.trim());
        if (!Number.isNaN(t)) days.set(day(t), (days.get(day(t)) || 0) + 1);
    }
    return days;
}

/** The usage report for a project root over the last `days` days. Read-only; never throws on a
 *  missing or damaged log. `now`, `tools` and `commitDays` stand in for the clock, the listed
 *  tools and git in tests. */
export function buildUsageReport(root, { days = USAGE_REPORT_LIMITS.days, now = new Date(), tools, commitDays } = {}) {
    const n = Math.max(1, Math.min(USAGE_REPORT_LIMITS.maxDays, Math.floor(Number(days)) || USAGE_REPORT_LIMITS.days));
    const until = now.getTime() + 1;
    const since = now.getTime() - n * 86400000;
    const log = readUsageEvents(root, { since, until });
    const records = sessionRecords(root, since, until);

    const perAi = new Map();
    const ai = name => {
        if (!perAi.has(name)) perAi.set(name, { ai: name, toolCalls: 0, failedCalls: 0, sessionsStarted: 0, viaSessionStart: 0,
            viaBriefHook: 0, afterBrief: 0, readOnlyStarts: 0, sessionsEnded: 0, sessionRecords: 0, subagentStarts: 0, lastSeen: null });
        return perAi.get(name);
    };
    const toolStats = new Map();
    const hookStats = new Map();
    const sessionDays = new Set();
    let subagentStarts = 0, toolCalls = 0;
    // The last brief start per AI not yet paired with a session_start.
    const openBrief = new Map();

    for (const e of log.events) {
        const row = ai(e.ai);
        row.lastSeen = new Date(e.t).toISOString();
        if (e.kind === 'tool') {
            toolCalls++;
            row.toolCalls++;
            if (!e.ok) row.failedCalls++;
            const s = toolStats.get(e.name) || { name: e.name, calls: 0, failed: 0, msTotal: 0, msCount: 0 };
            s.calls++;
            if (!e.ok) s.failed++;
            if (e.ms !== null) { s.msTotal += e.ms; s.msCount++; }
            toolStats.set(e.name, s);
            if (e.name === 'session_start') {
                sessionDays.add(day(e.t));
                const brief = openBrief.get(e.ai);
                if (e.readOnly) row.readOnlyStarts++;
                else if (brief !== undefined && e.t - brief <= USAGE_REPORT_LIMITS.pairMs) { row.afterBrief++; openBrief.delete(e.ai); }
                else { row.sessionsStarted++; row.viaSessionStart++; }
            }
            if (e.name === 'session_end') { row.sessionsEnded++; sessionDays.add(day(e.t)); }
        } else {
            const h = hookStats.get(e.name) || { name: e.name, runs: 0, failed: 0 };
            h.runs++;
            if (!e.ok) h.failed++;
            hookStats.set(e.name, h);
            if (isBriefHook(e.name)) {
                if (isBriefStart(e.name)) { row.sessionsStarted++; row.viaBriefHook++; openBrief.set(e.ai, e.t); sessionDays.add(day(e.t)); }
            }
            else if (isSubagentHook(e.name)) { row.subagentStarts++; subagentStarts++; }
        }
    }
    for (const r of records) { ai(r.ai).sessionRecords++; sessionDays.add(day(r.t)); }

    const top = [...toolStats.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))
        .slice(0, USAGE_REPORT_LIMITS.topTools)
        .map(({ name, calls, failed, msTotal, msCount }) => ({ name, calls, failed, avgMs: msCount ? Math.round(msTotal / msCount) : null }));
    const listed = Array.isArray(tools) ? tools : listedTools();
    const neverCalled = listed.filter(name => !toolStats.has(name)).sort();

    const commits = commitDays === undefined ? gitCommitDays(root, since) : commitDays;
    const commitsWithoutSession = commits
        ? [...commits.entries()].filter(([d]) => !sessionDays.has(d)).sort(([a], [b]) => a.localeCompare(b)).map(([d, c]) => ({ day: d, commits: c }))
        : null;

    const ais = [...perAi.values()].sort((a, b) => b.toolCalls - a.toolCalls || b.sessionsStarted - a.sessionsStarted || a.ai.localeCompare(b.ai));
    const sum = key => ais.reduce((s, r) => s + r[key], 0);
    // An AI with only a session_end record from before the log existed still counts as present.
    const activeAis = ais.filter(r => r.toolCalls || r.sessionsStarted || r.sessionsEnded || r.sessionRecords || r.subagentStarts).length;
    return {
        project: path.basename(path.resolve(root)),
        days: n,
        since: new Date(since).toISOString(),
        until: now.toISOString(),
        recorded: log.recorded,
        note: log.recorded ? null : NO_USAGE_NOTE,
        malformedLines: log.malformed,
        skippedFiles: log.skippedFiles,
        totals: {
            ais: activeAis,
            toolCalls,
            failedCalls: sum('failedCalls'),
            hookRuns: [...hookStats.values()].reduce((s, h) => s + h.runs, 0),
            sessionsStarted: sum('sessionsStarted'),
            sessionsEnded: sum('sessionsEnded'),
            sessionRecords: records.length
        },
        ais,
        tools: { top, neverCalled, listedCount: listed.length },
        hooks: [...hookStats.values()].sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name)),
        subagents: {
            starts: subagentStarts,
            toolCalls,
            callsPerStart: subagentStarts ? Math.round((toolCalls / subagentStarts) * 10) / 10 : null,
            note: SUBAGENT_NOTE
        },
        commitsWithoutSession,
        gitAvailable: commits !== null
    };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Plain text for a terminal. */
export function renderUsageText(r) {
    const out = [`PLUT_OS usage in ${r.project}, last ${plural(r.days, 'day')} (${r.since.slice(0, 10)} to ${r.until.slice(0, 10)})`,
        '(tool and hook calls; token use per session is the plutos_usage MCP tool)', ''];
    if (!r.recorded) out.push(`The usage log: ${r.note}.`, '');
    if (r.skippedFiles) out.push(`[!] ${plural(r.skippedFiles, 'log file')} over ${USAGE_REPORT_LIMITS.maxLogBytes / 1048576} MB skipped.`, '');
    if (r.malformedLines) out.push(`[i] ${plural(r.malformedLines, 'unreadable log line')} skipped.`, '');

    const t = r.totals;
    out.push(`Totals: ${plural(t.ais, 'AI')}, ${plural(t.toolCalls, 'tool call')} (${t.failedCalls} failed), ${plural(t.hookRuns, 'hook run')}, `
        + `${plural(t.sessionsStarted, 'session')} started, ${t.sessionsEnded} ended, ${plural(t.sessionRecords, 'session record')}`);
    out.push('', 'By AI');
    if (!r.ais.length) out.push('  none in this window');
    for (const a of r.ais) {
        out.push(`  ${a.ai}: ${plural(a.toolCalls, 'tool call')}${a.failedCalls ? ` (${a.failedCalls} failed)` : ''}, `
            + `${a.sessionsStarted} started (session_start ${a.viaSessionStart}, brief hook ${a.viaBriefHook}`
            + `${a.afterBrief ? `; ${a.afterBrief} session_start after a brief not counted again` : ''}`
            + `${a.readOnlyStarts ? `; ${a.readOnlyStarts} read-only session_start not counted` : ''}), `
            + `${a.sessionsEnded} ended (session_end), ${plural(a.sessionRecords, 'session record')}`
            + (a.subagentStarts ? `, ${plural(a.subagentStarts, 'sub-agent start')}` : ''));
    }
    out.push('', 'Tools used most');
    if (!r.tools.top.length) out.push('  none');
    for (const s of r.tools.top) out.push(`  ${s.name}: ${s.calls}${s.failed ? ` (${s.failed} failed)` : ''}${s.avgMs !== null ? `, avg ${s.avgMs} ms` : ''}`);
    out.push('', `Listed tools never called (${r.tools.neverCalled.length} of ${r.tools.listedCount}): ${r.tools.neverCalled.join(', ') || 'none'}`);
    const sa = r.subagents;
    out.push('', `Sub-agents: ${plural(sa.starts, 'start')} given the tool map, against ${plural(sa.toolCalls, 'PLUT_OS tool call')}`
        + (sa.callsPerStart !== null ? ` (${sa.callsPerStart} calls per start)` : '') + '.', `  ${sa.note}`);
    out.push('', 'Days with git commits but no session record');
    if (!r.gitAvailable) out.push('  skipped: no git, or not a repository');
    else if (!r.commitsWithoutSession.length) out.push('  none');
    else for (const d of r.commitsWithoutSession) out.push(`  ${d.day}: ${plural(d.commits, 'commit')}`);
    return out.join('\n');
}
