#!/usr/bin/env node
// Push gate — "run the tests, then push" enforced by a hook instead of by the owner's reminders.
//
// Every push spends GitHub Actions minutes, so a push nobody tested is caught before it leaves.
// It lives in lib/ because lib/ ships beside the packaged app and tools/ does not.
//
//   node lib/push-gate.mjs run <command…>     Runs the test command. If it passes, records the
//                                             tree it tested: what a commit of the work would
//                                             carry when the run STARTED (staged files and changes
//                                             to tracked files), so files the tests write and
//                                             untracked files do not count.
//   node lib/push-gate.mjs                    Claude Code PreToolUse hook (stdin is the tool call).
//                                             A `git push` of this project is refused (exit 2)
//                                             unless HEAD's tree is the tree that passed; the
//                                             refusal names the files that differ and the command
//                                             that records a pass. A command line
//                                             that commits and then pushes is refused too, because
//                                             the hook runs before the commit exists.
//   node lib/push-gate.mjs install [dir]      Switches the hook on or off for a project, the same
//   node lib/push-gate.mjs uninstall [dir]    as the dashboard's Hooks panel (lib/project-hooks.mjs).
//   node lib/push-gate.mjs git-install [dir]  The same check as a git pre-push hook, so it holds for
//   node lib/push-gate.mjs git-uninstall [dir] every client and terminal, not only Claude Code.
//                                             Git runs it with `pre-push`; `git push --no-verify`
//                                             skips it. An existing pre-push hook that is not this
//                                             one is never replaced.
//
// The idea is adapted from Claude Code Game Studios (review-receipts.sh hashes the files a piece
// of evidence proves, so evidence older than the code shows as stale). Here the evidence is a
// passing test run and the hash is git's own tree hash, which covers every file the push carries.
//
// Only `run` records a pass. PLUT_OS's own `npm test` runs through it; another project's plain
// `npm test` records nothing, so there the refusal and the Hooks panel name this file's `run`
// with the project's test command.
//
// Only pushes of the project the session was opened in are gated; any other repository passes.
// Anything the gate cannot work out (no git, not a repository) lets the push through: it guards
// against forgetting, it is not a lock. The owner can always push from their own terminal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { commandSegments, commandWords, gitSubcommand, isGit, nativePath } from './shell-segments.mjs';
import { isEntry } from './entry.mjs';

const STAMP = 'plutos-push-gate';   // inside the git dir, so it is never committed
const SELF = fileURLToPath(import.meta.url);   // this install's recorder, as the hook runs it
// Git commands that make a commit. One of them before a push on the same command line means the
// hook, which runs before the line does, would judge the commit before the new one.
const COMMITTING = new Set(['commit', 'merge', 'rebase', 'cherry-pick', 'revert', 'am', 'pull']);

// windowsHide: the dashboard calls this too (the Hooks panel), and its windowed exe has no console.
const git = (dir, args, env) => execFileSync('git', args, { cwd: dir, env: env || process.env, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
const gitPath = (dir, name) => path.resolve(dir, git(dir, ['rev-parse', '--git-path', name]));

/** One spelling per folder: links resolved and, on Windows, case ignored. */
function samePath(a, b) {
    const normal = p => {
        let real;
        try { real = fs.realpathSync.native(p); } catch { real = path.resolve(p); }
        real = real.replace(/[\\/]+$/, '');
        return process.platform === 'win32' ? real.toLowerCase() : real;
    };
    return normal(a) === normal(b);
}

/** The tree a commit of the work would carry: what is staged plus the changes to tracked files, as
 * `git commit -a` takes them. It is worked out in a copy of the index, so nothing is staged.
 * Untracked files do not count. They may be another agent's work in progress or files kept only on
 * this machine, and they must not hold a push that does not carry them. To include a new file,
 * stage it before the test run. */
export function workingTree(dir) {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'push-gate-')), 'index');
    try {
        const index = gitPath(dir, 'index');
        if (fs.existsSync(index)) {
            fs.copyFileSync(index, tmp);   // reuses git's stat cache: fast on big trees
            // The copy keeps the index's own time. Git re-reads an entry written in the same second
            // as the index ("racily clean"); a copy that looks newer hid an edit of the same size
            // made in the second of the commit, and the tree came out without it.
            const { atime, mtime } = fs.statSync(index);
            fs.utimesSync(tmp, atime, mtime);
        }
        const env = { ...process.env, GIT_INDEX_FILE: tmp };
        git(dir, ['add', '-u'], env);
        return git(dir, ['write-tree'], env);
    } finally {
        fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
    }
}

export function recordPass(dir, tree) {
    fs.writeFileSync(gitPath(dir, STAMP), `${tree}\n`);
}

/** The tree the tests last passed on, or '' when none is recorded (lib/claim-check.mjs reads it too). */
export function passedTree(dir) {
    try { return fs.readFileSync(gitPath(dir, STAMP), 'utf8').trim(); } catch { return ''; }
}

/** The command that records a passing run in the repository at `top`: `npm test` alone where the
 *  test script already runs through `push-gate.mjs run` (PLUT_OS's own does, Complete Game
 *  Studio's by way of `npm run check`), else the tests wrapped in `script`'s `run`. The path is
 *  double-quoted, which bash, cmd and PowerShell all read as one word. */
export function recorder(top, script = SELF) {
    let scripts = {};
    try { scripts = JSON.parse(fs.readFileSync(path.join(top, 'package.json'), 'utf8')).scripts || {}; } catch { /* no package.json */ }
    if (typeof scripts.test !== 'string') return `node "${script}" run <test command>`;
    // The test script, and every script it reaches with `npm run <name>`.
    for (const queue = ['test'], seen = new Set(); queue.length;) {
        const name = queue.shift();
        if (seen.has(name) || typeof scripts[name] !== 'string') continue;
        seen.add(name);
        if (/push-gate\.mjs["']?\s+run\b/.test(scripts[name])) return 'npm test';
        for (const m of scripts[name].matchAll(/\bnpm\s+run(?:-script)?(?:\s+-[\w-]+)*\s+([^\s&|;"'<>]+)/g)) queue.push(m[1]);
    }
    return `node "${script}" run npm test`;
}

/** For the Hooks panel: while no pass is recorded in `project`, the gate refuses every push of
 *  it, and this is the command that records one; '' once one is recorded, or where the gate holds
 *  nothing because `project` is not the top of a git repository. */
export function missingPass(project, script = SELF) {
    const top = gatedTop(project, project);
    return top && !passedTree(top) ? recorder(top, script) : '';
}

/** Every directory a `git push` in this shell command runs in (`cd x && git push`, `git -C x push`). */
export function pushTargets(command, cwd) {
    return pushes(command, cwd).map(p => p.dir);
}

/** The pushes of a command line in order: where each runs, and whether a commit came before it. */
function pushes(command, cwd) {
    const out = [];
    let dir = path.resolve(cwd), committed = false;
    for (const segment of commandSegments(command)) {
        const words = commandWords(segment);
        if (/^(cd|Set-Location)$/i.test(words[0] || '') && words[1]) { dir = path.resolve(dir, nativePath(words[1])); continue; }
        if (!isGit(words[0])) continue;
        const { sub, dir: at } = gitSubcommand(words);
        if (COMMITTING.has(sub)) committed = true;
        if (sub === 'push') out.push({ dir: at ? path.resolve(dir, nativePath(at)) : dir, afterCommit: committed });
    }
    return out;
}

/** The top folder of `dir`'s repository when that repository is the gated project, else ''. */
function gatedTop(dir, project) {
    let top;
    try { top = git(dir, ['rev-parse', '--show-toplevel']); } catch { return ''; }
    return samePath(top, project) ? top : '';
}

/** Why a push from `dir` would be refused, or '' when it may go. `commit` is what is pushed
 *  (HEAD for the Claude Code hook; each pushed ref's commit for the git hook). */
export function refusal(dir, project, commit = 'HEAD') {
    const top = gatedTop(dir, project);
    if (!top) return '';
    const pushing = git(top, ['rev-parse', `${commit}^{tree}`]);
    const passed = passedTree(top);
    if (passed === pushing) return '';
    if (!passed) return `push-gate: no passing test run is recorded for ${top}. ${rerun(top)}`;
    let changed = [];
    try { changed = git(top, ['diff', '--name-status', passed, pushing]).split('\n').filter(Boolean).map(line => line.split('\t')); } catch { /* tree gone */ }
    const list = changed.slice(0, 8).map(([, file]) => `  ${file}`).join('\n') + (changed.length > 8 ? `\n  … and ${changed.length - 8} more` : '');
    const added = changed.some(([status]) => status === 'A');
    return `push-gate: the tests passed on a different tree than the one being pushed.\n`
        + (list ? `Changed since the passing run:\n${list}\n` : '')
        + (added ? 'Stage new files before the test run, so it covers them; untracked files are not tested.\n' : '')
        + rerun(top, ' on the committed work');
}

/** The refusal's last words: how to record a pass, `what` saying on what. A command other than
 *  npm test goes last, on a line of its own, so no full stop reads as part of it. */
function rerun(top, what = '') {
    const command = recorder(top);
    return command === 'npm test' ? `Run npm test${what}, then push.`
        : `Only a test run through the push gate records a pass. Run the tests${what} this way, then push:\n  ${command}`;
}

function hook() {
    let input;
    try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return 0; }
    const command = input?.tool_input?.command;
    if (typeof command !== 'string' || !/\bgit\b/.test(command) || !/\bpush\b/.test(command)) return 0;
    const cwd = input.cwd || process.cwd();
    const project = process.env.CLAUDE_PROJECT_DIR || cwd;
    for (const { dir, afterCommit } of pushes(command, cwd)) {
        let why = '';
        try {
            why = afterCommit && gatedTop(dir, project)
                ? 'push-gate: this command line commits and then pushes, so the gate cannot see what it would push. Commit first, then push in a command of its own.'
                : refusal(dir, project);
        } catch { why = ''; }
        if (why) { process.stderr.write(`${why}\n`); return 2; }
    }
    return 0;
}

function run(args) {
    if (!args.length) { console.error('usage: push-gate.mjs run <command…>'); return 2; }
    const dir = process.cwd();
    let tree = '';
    try { tree = workingTree(dir); } catch { /* not a git checkout: nothing to record */ }
    const result = spawnSync(args.join(' '), { stdio: 'inherit', shell: true });
    const status = result.status ?? 1;
    if (status === 0 && tree) recordPass(dir, tree);
    return status;
}

// Git's pre-push hook: stdin holds one "<local ref> <local sha> <remote ref> <remote sha>" line
// per ref. A deletion (all-zero local sha) and a tag push carry no new work and pass.
function prePush() {
    let input = '';
    try { input = fs.readFileSync(0, 'utf8'); } catch { return 0; }
    const dir = process.cwd();
    for (const line of input.split('\n')) {
        const [localRef, localSha] = line.trim().split(/\s+/);
        if (!localSha || /^0+$/.test(localSha) || localRef.startsWith('refs/tags/')) continue;
        let why = '';
        try { why = refusal(dir, dir, localSha); } catch { why = ''; }
        if (why) { process.stderr.write(`${why}\n(git push --no-verify skips this check.)\n`); return 1; }
    }
    return 0;
}

const GIT_HOOK_MARK = '# plutos-push-gate';

/** The pre-push hook file of the repository at `dir` (core.hooksPath respected). */
export function gitHookPath(dir) { return gitPath(dir, 'hooks/pre-push'); }

/** Whether this gate is the repository's pre-push hook; null outside a git repository. */
export function gitHookOn(dir) {
    let file;
    try { file = gitHookPath(dir); } catch { return null; }
    try { return fs.readFileSync(file, 'utf8').includes(GIT_HOOK_MARK); } catch { return false; }
}

/** Writes or removes the git pre-push hook; never touches a pre-push hook that is not this one. */
export function setGitHook(dir, enabled, script = SELF) {
    const file = gitHookPath(dir);
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const ours = current.includes(GIT_HOOK_MARK);
    if (current && !ours) return { on: false, file, problem: `${file} already exists and is not PLUT_OS's: left as it is.` };
    if (!enabled) { if (ours) fs.rmSync(file); return { on: false, file }; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Forward slashes: Git for Windows runs hooks with its own sh, and node accepts them.
    fs.writeFileSync(file, `#!/bin/sh\n${GIT_HOOK_MARK}: refuses a push whose tree is not the one the tests passed on.\nexec node "${script.replace(/\\/g, '/')}" pre-push "$@"\n`, { mode: 0o755 });
    return { on: true, file };
}

async function install(dir, enabled) {
    const { setProjectHook } = await import('./project-hooks.mjs');
    const status = setProjectHook(dir, 'push-gate', enabled);
    console.log(`push gate ${status.on ? 'on' : 'off'} in ${status.settingsPath}`);
    if (status.problem) console.log(status.problem);
    return 0;
}

if (isEntry(import.meta.url)) {
    const [mode, arg] = process.argv.slice(2);
    // No top-level await: the dashboard bundle is CommonJS (build.mjs), and this file is in it.
    if (mode === 'git-install' || mode === 'git-uninstall') {
        const status = setGitHook(arg || process.cwd(), mode === 'git-install');
        console.log(status.problem || `git pre-push gate ${status.on ? 'on' : 'off'}: ${status.file}`);
        process.exitCode = status.problem ? 1 : 0;
    } else if (mode === 'pre-push') process.exit(prePush());
    else if (mode === 'install' || mode === 'uninstall') install(arg || process.cwd(), mode === 'install').then(code => { process.exitCode = code; });
    else process.exit(mode === 'run' ? run(process.argv.slice(3)) : hook());
}
