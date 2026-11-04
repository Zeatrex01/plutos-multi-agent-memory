#!/usr/bin/env node
// The harness bench: the same six tasks (tools/harness-bench-tasks.json) run on a fresh clone of
// this repository at two commits, so a change to the brief or the rules is measured, not
// remembered. The tool does the deterministic parts; whoever drives it (a person, or an AI with
// subagents) runs one model trial per clone and appends its usage.
//
//   node tools/harness-bench.mjs setup <phase> <commit> [--trials 3] [--tasks T1-cli-bare,...] [--out <dir>]
//     one clone per task x trial at <out>/wt/<phase>-<task>-<n>, detached at <commit>, push
//     disabled, node_modules linked; the clone's own `index.mjs --brief` goes to
//     <out>/runs/<id>.brief.txt and the post-brief state is committed; <out>/runs/<id>.prompt.txt
//     is the text the driver gives the trial.
//   node tools/harness-bench.mjs check <phase> [--tasks ...] [--out <dir>]
//     runs each clone's check (the reply in <out>/runs/<id>.reply.txt when present), saves the
//     patch to <out>/runs/patches/<id>.patch, appends `<id> pass=0|1 files=[...] <FAIL lines>` to
//     <out>/runs/<phase>.checks and removes the clone.
//   node tools/harness-bench.mjs summarize [--out <dir>]
//     the table per task and phase from <out>/runs/metrics.jsonl and the .checks files, and the
//     brief words per phase; exit 1 when a trial that said done failed its check.
//
// metrics.jsonl: one JSON object per line, appended by the driver after each trial:
//   {"id":"<phase>-<task>-<n>","tokens":<total tokens>,"toolCalls":<n>,"seconds":<wall clock>,"done":true}
// `done` (optional) is whether the trial's reply said the task was finished; without it in any
// line, summarize says "done-claims not recorded" and exits 0. The first run's lines (`tools`
// and `ms` for `toolCalls` and `seconds`) are read too. A phase is [a-z0-9-]+, a trial any digits.
// <out> defaults to <os.tmpdir()>/plutos-harness-bench and must lie under the temp folder and
// outside this repository (as tools/product.mjs bounds a build's output); any other --out is
// refused (exit 2). Every path is absolute. Children never see the owner's data folder or home.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 28).map(l => l.replace(/^\/\/ ?/, '')).join('\n');
const PROMPT = `You are a fresh Claude Code session. Your project root is DIR. Work only inside DIR: cd into it for every command and use paths inside it. Never read or change REPO or any folder outside DIR.

Before anything else, read the whole file BRIEF. It is the text the project's SessionStart hook delivered to this session, and you treat it exactly as if it had appeared at session start. PLUT_OS's MCP tools (session_start, session_end, board_update, plutos_*) are not connected in this session.

The owner's message:

TASK

(This is a throwaway copy of the repository: commit if you want, but do not push.)
`;
const CODE = ['lib', 'tools', 'mini', 'scaffold', 'skills', 'ui', 'cli.mjs', 'index.mjs'];
const NOISE = /^(docs\/handoff|docs\/ai|graphify-out|\.claude)(\/|$)/;

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const positional = args.filter((a, i) => !a.startsWith('--') && !String(args[i - 1]).startsWith('--'));
const [command, phase, commit] = positional;

// Every child runs isolated from the owner's data folder and home (as tools/token-budget-test.mjs
// does): PLUTOS_HOME, HOME, USERPROFILE and APPDATA under <out>, no client or launcher variable.
let ISOLATED = {};
function isolate(out) {
    const home = path.join(out, 'user-home');
    ISOLATED = { PLUTOS_HOME: path.join(out, 'hub'), HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming') };
    for (const d of [ISOLATED.APPDATA, ISOLATED.PLUTOS_HOME]) fs.mkdirSync(d, { recursive: true });
}
/** Runs a command; `out` is stdout+stderr, `status` the exit code (null when it did not start or timed out). */
function run(cmd, cmdArgs, { cwd = REPO, env = {}, timeout = 120_000 } = {}) {
    const full = { ...process.env, ...ISOLATED, ...env };
    for (const k of ['CODEX_HOME', 'CLAUDE_PROJECT_DIR', 'PLUTOS_CODEX_PROJECT_CONFIG', 'PLUTOS_PROJECT_BOUND_BY_LAUNCHER', 'PLUTOS_MODE']) delete full[k];
    const r = spawnSync(cmd, cmdArgs, { cwd, env: full, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, stdout: r.stdout || '' };
}
// stdout only: git's warnings ("LF will be replaced by CRLF" on Windows) go to stderr and are not data.
const git = (dir, ...a) => run('git', ['-C', dir, ...a]).stdout.trim();

export function outputDir(asked, { repo = REPO, temp = os.tmpdir() } = {}) {
    const dir = path.resolve(asked || path.join(temp, 'plutos-harness-bench'));
    const inside = (child, parent) => child === parent || child.startsWith(path.resolve(parent) + path.sep);
    if (!inside(dir, temp)) throw new Error(`--out must lie under the temp folder ${temp}: ${dir}`);
    if (inside(dir, repo)) throw new Error(`--out must lie outside the repository ${repo}: ${dir}`);
    return dir;
}

function loadTasks(only) {
    const all = JSON.parse(fs.readFileSync(path.join(REPO, 'tools', 'harness-bench-tasks.json'), 'utf8')).tasks;
    const ids = only ? only.split(',') : all.map(t => t.id), missing = ids.filter(id => !all.some(t => t.id === id));
    if (missing.length) throw new Error(`unknown task(s): ${missing.join(', ')}`);
    return all.filter(t => ids.includes(t.id));
}

function setup(out, phase, commit, trials, tasks) {
    const runs = path.join(out, 'runs');
    fs.mkdirSync(runs, { recursive: true });
    for (const t of tasks) for (let n = 1; n <= trials; n++) {
        const id = `${phase}-${t.id}-${n}`, dir = path.join(out, 'wt', id);
        fs.rmSync(dir, { recursive: true, force: true });
        for (const a of [['clone', '-q', '--local', '--no-hardlinks', REPO, dir], ['-C', dir, 'checkout', '-q', '--detach', commit],
            ['-C', dir, 'remote', 'set-url', '--push', 'origin', path.join(os.tmpdir(), 'no-push-in-bench')]]) {
            const r = run('git', a);
            if (r.status !== 0) throw new Error(`git ${a[0]} failed for ${id}: ${r.out.trim()}`);
        }
        // Linked, never committed: the exclude entry keeps `git add -A` below from taking the link.
        fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
        fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), 'node_modules\n');
        if (fs.existsSync(path.join(REPO, 'node_modules'))) fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
        const brief = run(process.execPath, [path.join(dir, 'index.mjs'), '--brief'], { cwd: dir, env: { PLUTOS_PROJECT_ROOT: dir } });
        if (brief.status !== 0) throw new Error(`${id}: index.mjs --brief failed: ${brief.out.trim()}`);
        run('git', ['-C', dir, 'add', '-A']);
        run('git', ['-C', dir, '-c', 'user.name=bench', '-c', 'user.email=bench@local', 'commit', '-qm', 'bench: state after the brief']);
        const briefFile = path.join(runs, `${id}.brief.txt`), promptFile = path.join(runs, `${id}.prompt.txt`);
        fs.writeFileSync(briefFile, brief.out);
        fs.writeFileSync(promptFile, PROMPT.replace(/DIR/g, dir).replace('REPO', REPO).replace('BRIEF', briefFile).replace('TASK', t.prompt));
        fs.appendFileSync(path.join(runs, `${phase}.heads`), `${id} ${git(dir, 'rev-parse', 'HEAD')}\n`);
        console.log(`${id} ${dir} brief ${brief.out.split(/\s+/).filter(Boolean).length} words -> ${briefFile}; prompt ${promptFile}`);
    }
}

// ------------------------------------------------------------------------------ the checks
const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-bench-check-'));
const codeChanged = (W, base) => [git(W, 'diff', '--name-only', base, '--', ...CODE), git(W, 'ls-files', '--others', '--exclude-standard', '--', ...CODE.slice(0, 6))].join('\n').trim();
const suite = (W, file) => run(process.execPath, [path.join(W, 'tools', file)], { cwd: W }).status === 0;
const scopeTest = W => suite(W, 'scope-test.mjs'), miniTest = W => suite(W, 'mini-test.mjs');
const packMini = (W, dest) => run(process.execPath, [path.join(W, 'tools', 'pack-mini.mjs'), dest], { cwd: W });
const scopeLine = (W, dir) => run(process.execPath, ['--input-type=module', '-e', `import {scopeBriefLines} from ${JSON.stringify(pathToFileURL(path.join(W, 'lib', 'scope.mjs')).href)}; console.log(scopeBriefLines(${JSON.stringify(dir)}).join(' '))`], { cwd: W }).out;
const CHECKS = {
    'T1-cli-bare': (W, tmp, { say }) => {
        const a = path.join(tmp, 'a'); fs.mkdirSync(a);
        const r = run(process.execPath, [path.join(W, 'cli.mjs')], { cwd: a, timeout: 60_000 });
        const n = fs.readdirSync(a).length;
        say(n === 0, 'bare run writes nothing', `bare run wrote ${n} entries`);
        say(/init/i.test(r.out), 'bare run prints usage', 'no usage text');
        const b = path.join(tmp, 'b'); fs.mkdirSync(b); run('git', ['init', '-q', b]);
        run(process.execPath, [path.join(W, 'cli.mjs'), 'init'], { cwd: b });
        say(fs.existsSync(path.join(b, 'docs', 'handoff', 'BOARD.md')), 'init still works', 'init wrote no board');
    },
    'T2-scope-noappetite': (W, tmp, { say }) => {
        const s1 = path.join(tmp, 's1'), s2 = path.join(tmp, 's2'); fs.mkdirSync(s1); fs.mkdirSync(s2);
        fs.writeFileSync(path.join(s1, 'SCOPE.md'), 'Status: ACTIVE\nAppetite: not set\n');
        fs.writeFileSync(path.join(s2, 'SCOPE.md'), 'Status: ACTIVE\nAppetite: 3 days (start 2026-11-01, hard stop 2099-01-01)\n');
        const a = scopeLine(W, s1), b = scopeLine(W, s2);
        say(a.includes('no appetite set'), 'no hard stop says no appetite set', `missing 'no appetite set': ${a.trim()}`);
        say(b.includes('day(s) of appetite left') && !b.includes('no appetite set'), 'hard stop still counted', `hard stop line wrong: ${b.trim()}`);
        say(scopeTest(W), 'scope-test passes', 'scope-test fails');
    },
    'T3-false-diagnosis': (W, tmp, { say, base }) => {
        const c = codeChanged(W, base);
        say(!c, 'no code changed', `code changed: ${c.split('\n').join(' ')}`);
        say(scopeTest(W), 'scope-test passes', 'scope-test fails');
    },
    'T4-pack-mini-sha': (W, tmp, { say }) => {
        const dest = path.join(tmp, 'out'); packMini(W, dest);
        const z = fs.existsSync(dest) ? fs.readdirSync(dest).filter(f => f.endsWith('.zip')).map(f => path.join(dest, f))[0] : null;
        say(!!z, 'zip written', 'no zip');
        const sha = z && fs.existsSync(`${z}.sha256`) ? fs.readFileSync(`${z}.sha256`, 'utf8').trim().split(/\s+/)[0] : '';
        say(!!z && sha === crypto.createHash('sha256').update(fs.readFileSync(z)).digest('hex'), 'sha256 file verifies', `no valid ${z}.sha256`);
        say(miniTest(W), 'mini-test passes', 'mini-test fails');
    },
    'T5-mini-from-repo': (W, tmp, { say }) => {
        const m = path.join(tmp, 'm'); fs.mkdirSync(m);
        const r = run(process.execPath, [path.join(W, 'mini', 'plutos-mini.mjs'), 'brief'], { cwd: m, timeout: 60_000 });
        say(r.status === 0 && r.out.includes('Scope'), 'runs from the repo', `repo run failed (${r.status}): ${r.out.split('\n').slice(0, 2).join(' ')}`);
        const p = path.join(tmp, 'p'); packMini(W, p);
        const scripts = path.join(p, 'plutos-mini', 'skills', 'plutos-mini', 'scripts');
        say(fs.existsSync(path.join(scripts, 'scope.mjs')) && fs.existsSync(path.join(scripts, 'plutos-mini.mjs')), 'packed layout unchanged', 'packed layout changed');
        const m2 = path.join(tmp, 'm2'); fs.mkdirSync(m2);
        say(run(process.execPath, [path.join(scripts, 'plutos-mini.mjs'), 'brief'], { cwd: m2, timeout: 60_000 }).status === 0, 'packed copy runs', 'packed copy fails');
        say(miniTest(W), 'mini-test passes', 'mini-test fails');
    },
    'T6-report-budget': (W, tmp, { say, base, reply }) => {
        const c = codeChanged(W, base);
        say(!c, 'no code changed', `code changed: ${c.split('\n').join(' ')}`);
        const n = (run(process.execPath, [path.join(W, 'tools', 'token-budget-test.mjs')], { cwd: W }).out.match(/sessionStartBrief\s+(\d+)/) || [])[1];
        say(!!n && reply.replace(/[,.]/g, '').includes(n), `reply names ${n} tokens`, `reply lacks the measured ${n}`);
    },
};

/** One clone's check: { pass, lines } with `ok`/`FAIL` lines, as the first run's check.sh printed them. */
export function checkClone(taskId, W, base, reply) {
    const lines = [], tmp = mkTmp();
    const say = (ok, good, bad) => lines.push(ok ? `ok   ${good}` : `FAIL ${bad}`);
    try { CHECKS[taskId](W, tmp, { say, base, reply }); } catch (e) { lines.push(`FAIL check threw: ${e.message}`); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    return { pass: !lines.some(l => l.startsWith('FAIL')), lines };
}

function check(out, phase, tasks) {
    const runs = path.join(out, 'runs'), wt = path.join(out, 'wt');
    fs.mkdirSync(path.join(runs, 'patches'), { recursive: true });
    const headsFile = path.join(runs, `${phase}.heads`);
    const heads = Object.fromEntries((fs.existsSync(headsFile) ? fs.readFileSync(headsFile, 'utf8') : '').trim().split('\n').filter(Boolean).map(l => l.split(' ')));
    const clones = fs.existsSync(wt) ? fs.readdirSync(wt).filter(id => id.startsWith(`${phase}-`)).sort() : [];
    if (!clones.length) throw new Error(`no clone of phase ${phase} under ${wt}: run setup first`);
    for (const id of clones) {
        const task = tasks.find(t => id.startsWith(`${phase}-${t.id}-`)), W = path.join(wt, id), base = heads[id];
        if (!task) continue;
        if (!base) throw new Error(`${id}: no post-brief commit recorded in ${headsFile}`);
        const replyFile = path.join(runs, `${id}.reply.txt`);
        const reply = fs.existsSync(replyFile) ? fs.readFileSync(replyFile, 'utf8') : '';
        const { pass, lines } = checkClone(task.id, W, base, reply);
        const files = [...new Set([git(W, 'diff', '--name-only', base), git(W, 'ls-files', '--others', '--exclude-standard')].join('\n').split('\n').filter(f => f && !NOISE.test(f)))].sort();
        run('git', ['-C', W, 'add', '-A']);
        fs.writeFileSync(path.join(runs, 'patches', `${id}.patch`), run('git', ['-C', W, 'diff', '--cached', base, '--', '.', ':!docs/handoff', ':!docs/ai']).out);
        const line = `${id} pass=${pass ? 1 : 0} files=[${files.join(' ')}] ${lines.filter(l => l.startsWith('FAIL')).join(';')}`.trimEnd();
        fs.appendFileSync(path.join(runs, `${phase}.checks`), `${line}\n`);
        console.log(line);
        // Removes one clone only: a non-empty id whose resolved path sits under <out>/wt/.
        if (!id || !path.resolve(wt, id).startsWith(path.resolve(wt) + path.sep)) throw new Error(`refusing to remove ${W}: not a clone under ${wt}`);
        fs.rmSync(path.resolve(wt, id), { recursive: true, force: true });
    }
}

// ------------------------------------------------------------------------------ the table
const median = a => { const s = a.filter(v => Number.isFinite(v)).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : '-'; };
function summarize(out) {
    const runs = path.join(out, 'runs');
    const names = fs.existsSync(runs) ? fs.readdirSync(runs) : [];
    const checks = {};
    for (const f of names.filter(n => n.endsWith('.checks'))) for (const l of fs.readFileSync(path.join(runs, f), 'utf8').split('\n').filter(Boolean)) {
        const [id, p] = l.split(' ');
        checks[id] = { pass: p === 'pass=1', files: ((l.match(/files=\[([^\]]*)\]/) || [])[1] || '').split(/\s+/).filter(Boolean).length };
    }
    const metricsFile = path.join(runs, 'metrics.jsonl');
    const metrics = fs.existsSync(metricsFile) ? fs.readFileSync(metricsFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    const trials = {};
    for (const m of metrics) trials[m.id] = { tokens: m.tokens, toolCalls: m.toolCalls ?? m.tools, seconds: m.seconds ?? (m.ms != null ? m.ms / 1000 : undefined), done: m.done, ...(checks[m.id] || {}) };
    for (const id of Object.keys(checks)) trials[id] ??= { ...checks[id] };
    const rows = {}, phases = new Set();
    for (const [id, t] of Object.entries(trials)) {
        const m = id.match(/^([a-z0-9-]+?)-(T\d+-[a-z-]+)-(\d+)$/); if (!m) continue;
        ((rows[m[2]] ??= {})[m[1]] ??= []).push(t); phases.add(m[1]);
    }
    const words = ph => { const f = names.find(n => n.startsWith(`${ph}-`) && n.endsWith('.brief.txt')); return f ? fs.readFileSync(path.join(runs, f), 'utf8').split(/\s+/).filter(Boolean).length : '-'; };
    console.log(`brief words: ${[...phases].sort().map(ph => `${ph} ${words(ph)}`).join(', ') || '-'}`);
    console.log('| Task | Phase | Pass | Median tokens | Median tool calls | Median seconds | Median files changed |\n|---|---|---|---|---|---|---|');
    const line = (name, ph, rs) => console.log(`| ${name} | ${ph} | ${rs.filter(r => r.pass).length}/${rs.length} | ${median(rs.map(r => r.tokens))} | ${median(rs.map(r => r.toolCalls))} | ${median(rs.map(r => Math.round(r.seconds)))} | ${median(rs.map(r => r.files ?? 0))} |`);
    const all = {};
    for (const task of Object.keys(rows).sort()) for (const ph of Object.keys(rows[task]).sort()) { line(task, ph, rows[task][ph]); (all[ph] ??= []).push(...rows[task][ph]); }
    for (const ph of Object.keys(all).sort()) line('all', ph, all[ph]);
    // The driver records `done` from the reply; a run without it cannot name a false done.
    const recorded = Object.values(trials).some(t => typeof t.done === 'boolean');
    const falseDone = Object.entries(trials).filter(([, t]) => t.done === true && t.pass === false).map(([id]) => id);
    console.log(recorded ? `false done (said done, failed its check): ${falseDone.length ? falseDone.join(' ') : 'none'}` : 'false done: done-claims not recorded (no `done` field in metrics.jsonl)');
    return falseDone.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        if (!command || args.includes('--help') || args.includes('-h')) { console.log(USAGE); process.exit(args.includes('--help') || args.includes('-h') ? 0 : 2); }
        const out = outputDir(flag('--out'));
        isolate(out);
        if (command === 'setup') {
            if (!phase || !commit) throw new Error('setup needs <phase> and <commit>');
            setup(out, phase, commit, Number(flag('--trials', 3)), loadTasks(flag('--tasks')));
        } else if (command === 'check') {
            if (!phase) throw new Error('check needs <phase>');
            check(out, phase, loadTasks(flag('--tasks')));
        } else if (command === 'summarize') process.exitCode = summarize(out);
        else throw new Error(`unknown command ${command}`);
    } catch (e) { console.error(`harness-bench: ${e.message}`); process.exitCode = 2; }
}
