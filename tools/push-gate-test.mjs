#!/usr/bin/env node
// The push gate lets a push through only when the tree being pushed is the tree the tests passed
// on. Real repositories in a scratch folder; the hook is driven through its stdin like Claude Code.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pushTargets, recorder, workingTree } from '../lib/push-gate.mjs';

const gate = fileURLToPath(new URL('../lib/push-gate.mjs', import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-push-gate-'));
const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const commit = (cwd, file, text) => { fs.writeFileSync(path.join(cwd, file), text); sh(cwd, 'add', '-A'); sh(cwd, 'commit', '-q', '-m', file); };
const runTests = (cwd, command) => spawnSync(process.execPath, [gate, 'run', command], { cwd, env, encoding: 'utf8' }).status;
const hook = (project, command, cwd = project) => {
    const r = spawnSync(process.execPath, [gate], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }),
        env: { ...env, CLAUDE_PROJECT_DIR: project }, encoding: 'utf8' });
    return { status: r.status, why: r.stderr };
};
const pass = `"${process.execPath}" -e "process.exit(0)"`;
const fail = `"${process.execPath}" -e "process.exit(1)"`;
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log(`  ok  ${name}`); };

try {
    const repo = path.join(scratch, 'repo');
    fs.mkdirSync(repo);
    sh(repo, 'init', '-q', '-b', 'main');
    commit(repo, 'a.txt', 'one');

    check('with no passing run recorded, a push is refused and says to run the tests', () => {
        const r = hook(repo, 'git push -u origin main');
        assert.equal(r.status, 2);
        assert.match(r.why, /no passing test run/);
    });
    check('the refusal names this install\'s recorder, and that command, run as written, lets the push go', () => {
        // Only `run` records a pass, so a project's own test command records nothing (finding B3).
        const fresh = path.join(scratch, 'fresh');
        fs.mkdirSync(fresh);
        sh(fresh, 'init', '-q', '-b', 'main');
        commit(fresh, 'f.txt', 'f');
        const r = hook(fresh, 'git push');
        assert.equal(r.status, 2);
        const command = r.why.trim().split('\n').pop().trim();
        assert.equal(command, `node "${gate}" run <test command>`);
        const home = path.join(scratch, 'home');
        const ran = spawnSync(command.replace('<test command>', 'node -e 0'), { cwd: fresh, shell: true, encoding: 'utf8',
            env: { ...env, HOME: home, USERPROFILE: home, APPDATA: home, PLUTOS_HOME: home } });
        assert.equal(ran.status, 0, ran.stderr);
        assert.equal(hook(fresh, 'git push').status, 0);
    });
    check('npm test alone is named only where the test script already runs through the recorder', () => {
        const proj = path.join(scratch, 'scripts');
        fs.mkdirSync(proj);
        sh(proj, 'init', '-q', '-b', 'main');
        commit(proj, 'p.txt', 'p');
        const scripts = s => fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ scripts: s }));
        scripts({ test: 'npm run check', check: 'node plutos/lib/push-gate.mjs run "node a.mjs"' });   // a pack running PLUT_OS as a submodule
        const why = hook(proj, 'git push').why;
        assert.match(why, /no passing test run[\s\S]*Run npm test, then push\./);
        assert.doesNotMatch(why, /push-gate\.mjs" run/);
        scripts({ test: 'node --test' });
        assert.ok(hook(proj, 'git push').why.includes(`Run the tests this way, then push:\n  node "${gate}" run npm test`));
        const named = s => { scripts(s); return recorder(proj, '/x/push-gate.mjs'); };
        assert.equal(named({ test: 'node lib/push-gate.mjs run node tools/run-all-tests.mjs' }), 'npm test');   // PLUT_OS's own
        assert.equal(named({ test: 'npm run -s unit', unit: 'node "/opt/p/lib/push-gate.mjs" run node --test' }), 'npm test');
        assert.equal(named({ test: 'node --test', check: 'node lib/push-gate.mjs run node --test' }), 'node "/x/push-gate.mjs" run npm test');
        assert.equal(named({ test: 'npm run test' }), 'node "/x/push-gate.mjs" run npm test');
        assert.equal(named({ lint: 'eslint .' }), 'node "/x/push-gate.mjs" run <test command>');
        fs.writeFileSync(path.join(proj, 'package.json'), '{ not json');
        assert.equal(recorder(proj, '/x/push-gate.mjs'), 'node "/x/push-gate.mjs" run <test command>');
    });
    check('commands that are not a push are never held', () => {
        assert.equal(hook(repo, 'git status').status, 0);
        assert.equal(hook(repo, 'npm test').status, 0);
    });
    check('a failed test run records nothing', () => {
        assert.equal(runTests(repo, fail), 1);
        assert.equal(hook(repo, 'git push').status, 2);
    });
    check('staged, tested, then committed: the push goes', () => {
        fs.writeFileSync(path.join(repo, 'b.txt'), 'two');
        sh(repo, 'add', 'b.txt');
        assert.equal(runTests(repo, pass), 0);
        sh(repo, 'commit', '-q', '-m', 'b');
        assert.equal(hook(repo, 'git push -u origin main').status, 0);
    });
    check('a file written by the test run itself does not count against it', () => {
        commit(repo, 'c.txt', 'three');
        const writes = `"${process.execPath}" -e "require('fs').writeFileSync('out.log','x')"`;
        assert.equal(runTests(repo, writes), 0);
        fs.rmSync(path.join(repo, 'out.log'));
        assert.equal(hook(repo, 'git push').status, 0);
    });
    check('a change committed after the passing run is refused, and the refusal names the file', () => {
        commit(repo, 'late.txt', 'untested');
        const r = hook(repo, 'git push origin main');
        assert.equal(r.status, 2);
        assert.match(r.why, /late\.txt/);
    });
    check('committing and pushing on one command line is refused, because the hook runs before the commit', () => {
        commit(repo, 'tested.txt', 'ok');
        assert.equal(runTests(repo, pass), 0);
        assert.equal(hook(repo, 'git push').status, 0);
        fs.writeFileSync(path.join(repo, 'untested.txt'), 'new');
        const r = hook(repo, 'git add -A && git commit -m x && git push origin main');
        assert.equal(r.status, 2);
        assert.match(r.why, /commits and then pushes/);
        assert.equal(hook(repo, 'git commit -m x; git push').status, 2);
        assert.equal(hook(repo, 'git pull && git push').status, 2);
        fs.rmSync(path.join(repo, 'untested.txt'));
    });
    check('untracked files do not hold a push, and a new file counts once it is staged before the run', () => {
        fs.writeFileSync(path.join(repo, 'someone-elses-art.png'), 'not mine');
        fs.writeFileSync(path.join(repo, 'mine.txt'), 'mine');
        sh(repo, 'add', 'mine.txt');
        assert.equal(runTests(repo, pass), 0);
        sh(repo, 'commit', '-q', '-m', 'mine');
        assert.equal(hook(repo, 'git push').status, 0, 'the untracked file is not part of the push');
        fs.writeFileSync(path.join(repo, 'unstaged-new.txt'), 'new');
        assert.equal(runTests(repo, pass), 0);
        sh(repo, 'add', 'unstaged-new.txt');
        sh(repo, 'commit', '-q', '-m', 'late add');
        const r = hook(repo, 'git push');
        assert.equal(r.status, 2, 'a file staged after the run was not tested');
        assert.match(r.why, /unstaged-new\.txt/);
        assert.match(r.why, /Stage new files before the test run/);
        assert.doesNotMatch(r.why, /someone-elses-art/);
        assert.equal(runTests(repo, pass), 0);
        assert.equal(hook(repo, 'git push').status, 0);
        fs.rmSync(path.join(repo, 'someone-elses-art.png'));
    });
    check('the project opened through a link is still this project\'s gate', () => {
        const link = path.join(scratch, 'repo-link');
        fs.symlinkSync(repo, link, 'dir');
        commit(repo, 'after-link.txt', 'untested');
        assert.equal(hook(link, 'git push', link).status, 2);
        assert.equal(hook(repo, `cd "${link}" && git push`, scratch).status, 2);
    });
    check('cd and git -C reach the repository being pushed', () => {
        assert.equal(hook(repo, `cd "${repo}" && git push`, scratch).status, 2);
        assert.equal(hook(repo, `git -C "${repo}" push`, scratch).status, 2);
        assert.deepEqual(pushTargets('FOO=1 git -c a=b push && git log', '/x'), [path.resolve('/x')]);
    });
    check('a push of some other repository is not this project\'s gate', () => {
        const other = path.join(scratch, 'other');
        fs.mkdirSync(other);
        sh(other, 'init', '-q', '-b', 'main');
        commit(other, 'z.txt', 'z');
        assert.equal(hook(repo, `cd "${other}" && git push`).status, 0);
    });
    check('outside any repository the gate stays out of the way', () => {
        assert.equal(hook(scratch, 'git push').status, 0);
    });
    check('install adds the hook beside the project\'s own hooks, once, and uninstall takes only ours', () => {
        const settings = path.join(repo, '.claude', 'settings.local.json');
        fs.mkdirSync(path.dirname(settings), { recursive: true });
        const theirs = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo theirs' }] };
        fs.writeFileSync(settings, JSON.stringify({ model: 'x', hooks: { PreToolUse: [theirs] } }));
        const cli = mode => execFileSync(process.execPath, [gate, mode, repo], { env, encoding: 'utf8' });
        cli('install');
        cli('install');
        let now = JSON.parse(fs.readFileSync(settings, 'utf8'));
        assert.equal(now.model, 'x');
        assert.equal(now.hooks.PreToolUse.length, 2);
        assert.deepEqual(now.hooks.PreToolUse[0], theirs);
        assert.equal(now.hooks.PreToolUse[1].hooks[0].args[0], gate);
        assert.match(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8'), /\.claude\/settings\.local\.json/);
        cli('uninstall');
        now = JSON.parse(fs.readFileSync(settings, 'utf8'));
        assert.deepEqual(now.hooks.PreToolUse, [theirs]);
    });
    check('a same-size edit in the second the index was written is in the tested tree', () => {
        // Git re-reads an entry written in the same second as its index ("racily clean"). Made
        // deterministic: no ctime trust, and one fixed time for the file, its edit and the index.
        const race = path.join(scratch, 'race');
        fs.mkdirSync(race);
        sh(race, 'init', '-q', '-b', 'main');
        sh(race, 'config', 'core.trustctime', 'false');
        const file = path.join(race, 'r.txt'), at = new Date(Math.floor(Date.now() / 1000) * 1000 - 5000);
        fs.writeFileSync(file, 'aaaa');
        fs.utimesSync(file, at, at);
        sh(race, 'add', '-A'); sh(race, 'commit', '-q', '-m', 'r');
        fs.utimesSync(path.join(race, '.git', 'index'), at, at);
        fs.writeFileSync(file, 'bbbb');
        fs.utimesSync(file, at, at);
        assert.notEqual(workingTree(race), sh(race, 'rev-parse', 'HEAD^{tree}'));
        assert.match(sh(race, 'status', '--porcelain'), /r\.txt/);
    });
    check('as a git pre-push hook it holds for any client: an untested push fails, a tested one goes', () => {
        const work = path.join(scratch, 'git-hook');
        const remote = path.join(scratch, 'git-hook-remote.git');
        fs.mkdirSync(work);
        sh(scratch, 'init', '-q', '--bare', remote);
        sh(work, 'init', '-q', '-b', 'main');
        sh(work, 'remote', 'add', 'origin', remote);
        commit(work, 'g.txt', 'g');
        const install = spawnSync(process.execPath, [gate, 'git-install', work], { env, encoding: 'utf8' });
        assert.equal(install.status, 0, install.stdout);
        const push = () => spawnSync('git', ['push', '-q', 'origin', 'main'], { cwd: work, env, encoding: 'utf8' });
        const refused = push();
        assert.notEqual(refused.status, 0);
        assert.match(refused.stderr, /no passing test run/);
        assert.equal(runTests(work, pass), 0);
        assert.equal(push().status, 0);
        commit(work, 'h.txt', 'h');
        assert.match(push().stderr, /different tree/);
        // A foreign pre-push hook is never replaced, and uninstall removes only ours.
        assert.equal(spawnSync(process.execPath, [gate, 'git-uninstall', work], { env }).status, 0);
        const hookFile = path.join(work, '.git', 'hooks', 'pre-push');
        assert.ok(!fs.existsSync(hookFile));
        fs.writeFileSync(hookFile, '#!/bin/sh\nexit 0\n');
        assert.equal(spawnSync(process.execPath, [gate, 'git-install', work], { env }).status, 1);
        assert.equal(fs.readFileSync(hookFile, 'utf8'), '#!/bin/sh\nexit 0\n');
    });
    console.log(`${checks} push-gate checks passed`);
} finally {
    fs.rmSync(scratch, { recursive: true, force: true });
}
