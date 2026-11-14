// The usage report (lib/usage-report.mjs): counts from a fixture .plutos/usage.jsonl, the missing-log
// note, malformed lines, rotation, CONTINUITY records, commit days without a session, the honest
// sub-agent ratio, the CLI's text and --json, and the Home line. Temp folders only; no network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { buildUsageReport, renderUsageText, listedTools, NO_USAGE_NOTE } from '../lib/usage-report.mjs';
import { USAGE_FILE as USAGE_LOG_REL, USAGE_ROTATED as USAGE_LOG_ROTATED_REL } from '../lib/usage-log.mjs';

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let passed = 0;
const check = (name, condition) => { assert.ok(condition, name); passed++; console.log(`PASS ${name}`); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-usage-'));
const now = new Date('2026-11-14T12:00:00.000Z');
const tools = ['session_start', 'session_end', 'board_read', 'plutos_context_for_task', 'plutos_code_lookup'];
try {
    // 1. No log: readable, with the note, and no throw.
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty);
    const r0 = buildUsageReport(empty, { now, tools, commitDays: null });
    check('a missing log reads as not recorded, with the note', r0.recorded === false && r0.note === NO_USAGE_NOTE);
    check('the text says no usage recorded yet', renderUsageText(r0).includes(NO_USAGE_NOTE));
    check('git absent is reported as skipped', r0.gitAvailable === false && renderUsageText(r0).includes('skipped'));

    // 2. A log with two AIs, hooks, a failed call, an old event, a malformed line, a rotated file.
    const proj = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(proj, '.plutos'), { recursive: true });
    const ev = (t, ai, kind, name, ok = true, ms = 10) => JSON.stringify({ t, ai, kind, name, ok, ms });
    fs.writeFileSync(path.join(proj, USAGE_LOG_ROTATED_REL), [
        ev('2026-11-10T09:00:00.000Z', 'claude-code', 'hook', 'brief'),
        ev('2026-10-01T09:00:00.000Z', 'Claude Code', 'tool', 'board_read')   // outside 7 days
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(proj, USAGE_LOG_REL), [
        ev('2026-11-10T09:01:00.000Z', 'Claude Code', 'tool', 'plutos_context_for_task', true, 20),
        ev('2026-11-10T09:02:00.000Z', 'Claude Code', 'tool', 'plutos_context_for_task', true, 40),
        ev('2026-11-10T09:03:00.000Z', 'Claude Code', 'hook', 'subagent'),
        ev('2026-11-10T09:04:00.000Z', 'Claude Code', 'hook', 'subagent'),
        ev('2026-11-10T09:05:00.000Z', 'Claude Code', 'tool', 'board_read', false),
        JSON.stringify({ t: '2026-11-12T10:00:00.000Z', client: 'cursor', kind: 'tool', name: 'session_start', ok: true, ms: 5 }),
        ev('2026-11-12T11:00:00.000Z', 'Cursor', 'tool', 'session_end'),
        'not json',
        JSON.stringify({ t: 'bad', kind: 'tool', name: 'x' })
    ].join('\n') + '\n');
    fs.mkdirSync(path.join(proj, 'docs', 'handoff'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'docs', 'handoff', 'CONTINUITY.md'),
        '# CONTINUITY\n\n### 2026-11-12T11:00:00.000Z · cursor · Did a thing\n- **Did:** x\n\n### 2026-09-01T00:00:00.000Z · codex · Old\n');
    const commitDays = new Map([['2026-11-10', 2], ['2026-11-11', 3], ['2026-11-12', 1]]);
    const r = buildUsageReport(proj, { now, tools, commitDays });
    const claude = r.ais.find(a => a.ai === 'Claude Code');
    const cursor = r.ais.find(a => a.ai === 'Cursor');
    check('the log is recorded and both AIs are named canonically', r.recorded && claude && cursor && r.totals.ais === 2);
    check('tool calls per AI exclude the event outside the window', claude.toolCalls === 3 && cursor.toolCalls === 2 && r.totals.toolCalls === 5);
    check('a failed call is counted', claude.failedCalls === 1 && r.totals.failedCalls === 1);
    check('a brief hook in the rotated file counts as a session start', claude.sessionsStarted === 1 && claude.viaBriefHook === 1);
    check('session_start and session_end are counted for the client field', cursor.viaSessionStart === 1 && cursor.sessionsEnded === 1);
    check('CONTINUITY records in the window are counted per AI', cursor.sessionRecords === 1 && r.totals.sessionRecords === 1);
    check('malformed lines are skipped and counted', r.malformedLines === 2);
    check('the most used tool comes first with its average time',
        r.tools.top[0].name === 'plutos_context_for_task' && r.tools.top[0].calls === 2 && r.tools.top[0].avgMs === 30);
    check('listed tools never called are listed', JSON.stringify(r.tools.neverCalled) === JSON.stringify(['plutos_code_lookup']));
    check('sub-agent starts against tool calls, with the caveat',
        r.subagents.starts === 2 && r.subagents.toolCalls === 5 && r.subagents.callsPerStart === 2.5 && /cannot tell which agent/.test(r.subagents.note));
    check('commit days with no session record: only the 11th',
        JSON.stringify(r.commitsWithoutSession) === JSON.stringify([{ day: '2026-11-11', commits: 3 }]));
    const text = renderUsageText(r);
    check('the text names the AIs, the tools and the plutos_usage distinction',
        text.includes('Claude Code: 3 tool calls (1 failed)') && text.includes('2026-11-11: 3 commits') && text.includes('plutos_usage MCP tool'));
    check('no argument or path ever reaches the report', !JSON.stringify(r).includes(proj));
    check('the report wrote nothing', fs.readdirSync(path.join(proj, '.plutos')).sort().join() === ['usage.1.jsonl', 'usage.jsonl'].join());

    // 2b. Session starts: a /clear or compact brief is not a session; a session_start right after a
    // brief of the same AI is that session asking again; a read-only session_start is no session.
    const sp = path.join(tmp, 'starts');
    fs.mkdirSync(path.join(sp, '.plutos'), { recursive: true });
    fs.writeFileSync(path.join(sp, USAGE_LOG_REL), [
        ev('2026-11-13T09:00:00.000Z', 'Claude Code', 'hook', 'brief'),
        ev('2026-11-13T09:00:30.000Z', 'claude-code', 'tool', 'session_start'),
        ev('2026-11-13T09:40:00.000Z', 'Claude Code', 'hook', 'brief:clear'),
        ev('2026-11-13T10:10:00.000Z', 'Claude Code', 'hook', 'brief:compact'),
        ev('2026-11-13T10:11:00.000Z', 'Claude Code', 'tool', 'session_start'),
        JSON.stringify({ t: '2026-11-13T11:00:00.000Z', ai: 'Codex', kind: 'tool', name: 'session_start', ok: true, ms: 3, readOnly: true }),
        ev('2026-11-13T11:05:00.000Z', 'Codex', 'tool', 'session_start'),
        ev('2026-11-13T12:00:00.000Z', 'Claude Code', 'hook', 'brief:startup')
    ].join('\n') + '\n');
    const rs = buildUsageReport(sp, { now, tools, commitDays: null });
    const cc = rs.ais.find(a => a.ai === 'Claude Code');
    const cx = rs.ais.find(a => a.ai === 'Codex');
    check('clear and compact briefs are hook runs, not session starts', cc.viaBriefHook === 2 && rs.totals.hookRuns === 4);
    check('a session_start right after a brief is not a second session', cc.afterBrief === 1 && cc.viaSessionStart === 1 && cc.sessionsStarted === 3);
    check('a read-only session_start is not a session start', cx.readOnlyStarts === 1 && cx.sessionsStarted === 1);
    check('sessions started in total', rs.totals.sessionsStarted === 4);
    check('the text says what was not counted', renderUsageText(rs).includes('1 session_start after a brief not counted again')
        && renderUsageText(rs).includes('1 read-only session_start not counted'));

    // 3. The listed tools are read from the sources.
    const listed = listedTools();
    check('the listed tools come from the tool sources', listed.includes('session_start') && listed.includes('plutos_modules') && !listed.includes('research_topic'));

    // 4. Real git, when present: a commit today with no session record.
    let hasGit = true;
    try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { hasGit = false; }
    if (hasGit) {
        const repo = path.join(tmp, 'repo');
        fs.mkdirSync(repo);
        const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore', env: { ...process.env,
            GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } });
        g('init', '-q'); fs.writeFileSync(path.join(repo, 'a.txt'), 'a'); g('add', '.'); g('commit', '-q', '-m', 'a');
        const rg = buildUsageReport(repo, { tools });
        check('git log finds today\'s commit with no session record', rg.gitAvailable && rg.commitsWithoutSession.length === 1);
    }

    // 5. The CLI: text by default, --json for tools.
    const cliText = execFileSync(process.execPath, [path.join(APP, 'cli.mjs'), 'usage', empty, '--days', '3'], { encoding: 'utf8' });
    check('plutos usage prints the text with the window', cliText.includes('last 3 days') && cliText.includes(NO_USAGE_NOTE));
    const cliJson = JSON.parse(execFileSync(process.execPath, [path.join(APP, 'cli.mjs'), 'usage', proj, '--json'], { encoding: 'utf8' }));
    check('plutos usage --json is the report', cliJson.recorded === true && Array.isArray(cliJson.ais));
    const help = execFileSync(process.execPath, [path.join(APP, 'cli.mjs'), '--help'], { encoding: 'utf8' });
    check('the help keeps usage and plutos_usage apart', /usage \[path\] \[--days N\] \[--json\]/.test(help) && /Not the plutos_usage MCP tool/.test(help));

    // 6. The Home line (ui/modules/overview.js), run as browser code in a vm.
    const source = fs.readFileSync(path.join(APP, 'ui', 'modules', 'overview.js'), 'utf8')
        .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
    const context = { t: key => key, escHtml: v => String(v ?? ''), emptyState: () => '', refreshApprovals() {}, aiLinkWord: () => 'x',
        fetch: () => Promise.reject(new Error('offline')), document: { getElementById: () => null } };
    vm.createContext(context);
    vm.runInContext(`${source}\nthis.statusHtml = statusHtml;`, context);
    const home = context.statusHtml({ project: 'p', report: null, hooks: null, mcp: null, usage: r });
    check('Home shows the usage row', home.includes('home_usage') && home.includes('home_usage_line'));
    check('Home shows the none note for a missing log', context.statusHtml({ project: 'p', report: null, hooks: null, mcp: null, usage: r0 }).includes('home_usage_none'));
    check('Home has no usage row when it did not load', !context.statusHtml({ project: 'p', report: null, hooks: null, mcp: null }).includes('home_usage'));

    // 7. The i18n keys exist in both languages.
    const i18n = fs.readFileSync(path.join(APP, 'ui', 'i18n.js'), 'utf8');
    check('home_usage keys are in en and tr', ['home_usage:', 'home_usage_line:', 'home_usage_none:'].every(k => i18n.split(k).length - 1 === 2));

    // 8. GET /api/usage on a real dashboard: nothing without a project, the report with one, days clamped.
    const freePort = () => new Promise(resolve => { const sv = net.createServer(); sv.listen(0, '127.0.0.1', () => { const p = sv.address().port; sv.close(() => resolve(p)); }); });
    const port = await freePort();
    const userHome = path.join(tmp, 'user-home');
    fs.mkdirSync(userHome, { recursive: true });
    const dash = spawn(process.execPath, [path.join(APP, 'dashboard.mjs')], {
        env: { ...process.env, PLUTOS_PORT: String(port), PLUTOS_HOME: path.join(tmp, 'hub'), PLUTOS_NO_OS_OPEN: '1', HOME: userHome, USERPROFILE: userHome },
        stdio: ['ignore', 'ignore', 'ignore']
    });
    try {
        const base = `http://127.0.0.1:${port}`;
        let up = false;
        for (let i = 0; i < 100 && !up; i++) {
            try { up = (await fetch(base + '/api/workspaces')).ok; } catch { await new Promise(r => setTimeout(r, 100)); }
        }
        check('the dashboard starts', up);
        const none = await (await fetch(base + '/api/usage')).json();
        check('GET /api/usage without a project says it needs one', none.needsProject === true);
        // A PLUT_OS project (AGENTS.md + board), so the dashboard reads the project itself.
        fs.mkdirSync(path.join(sp, 'docs', 'handoff'), { recursive: true });
        fs.writeFileSync(path.join(sp, 'AGENTS.md'), '# AGENTS.md — PLUT_OS Shared Communication Rules\n');
        fs.writeFileSync(path.join(sp, 'docs', 'handoff', 'BOARD.md'), '# BOARD\n');
        const added = await fetch(base + '/api/workspaces/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: sp }) });
        check('the fixture project is added', added.ok);
        const wide = await (await fetch(base + '/api/usage?days=9999')).json();
        check('GET /api/usage clamps days to 90 and reads the log', wide.days === 90 && wide.recorded === true && wide.totals.toolCalls >= 3);
        const junk = await (await fetch(base + '/api/usage?days=abc')).json();
        check('GET /api/usage falls back to 7 days', junk.days === 7);
    } finally { dash.kill(); }
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${passed} passed, 0 failed`);
