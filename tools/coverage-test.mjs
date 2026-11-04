#!/usr/bin/env node
// Coverage that has to exist before the architecture's P2 cuts (cleanup plan P1-12): the assignee rule every board
// view uses, the command lines of the two council seats PLUT_OS does not control, and `plutos connect`
// run as the owner runs it, with every home folder isolated so the test cannot touch a real config.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sameAi } from '../lib/board.mjs';
import { codexArgs, agyArgs } from '../lib/council-seats.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-coverage-'));
try {
    check('sameAi: one identity, case-insensitive, a qualifier after a space only', () => {
        for (const [a, b] of [['claude', 'Claude Code'], ['Claude Code', 'claude'], ['Codex', 'codex'], ['gemini', 'Gemini CLI']]) assert.equal(sameAi(a, b), true, `${a} ~ ${b}`);
        for (const [a, b] of [['codex', 'codex-reviewer'], ['claude', 'claudette'], ['', 'claude'], [null, undefined], ['claude', 'gemini']]) assert.equal(sameAi(a, b), false, `${a} !~ ${b}`);
    });
    check('the Codex seat: a new turn names its folder, a resumed one its session; the prompt comes on stdin', () => {
        const seat = { model: 'm1' };
        assert.deepEqual(codexArgs(seat, { dir: '/seat', outFile: '/seat/.codex-last.txt' }),
            ['exec', '-C', '/seat', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"', '-o', '/seat/.codex-last.txt', '-m', 'm1', '-']);
        assert.deepEqual(codexArgs({}, { dir: '/seat', session: 'abc', outFile: '/o' }).slice(0, 3), ['exec', 'resume', 'abc']);
        assert.ok(!codexArgs({}, { dir: '/seat', outFile: '/o' }).includes('-m'), 'no model flag without a model');
    });
    check('the Antigravity seat: JSON out, the timeout in seconds, the prompt as one --print argument', () => {
        const argv = agyArgs({ model: 'g1', timeoutMs: 90_000 }, { print: 'say "hi" & exit' });
        assert.deepEqual(argv, ['--model', 'g1', '--mode', 'accept-edits', '--output-format', 'json', '--print-timeout', '90s', '--print=say "hi" & exit']);
        assert.deepEqual(agyArgs({ model: 'g1', timeoutMs: 1000 }, { session: 'c9', print: 'x' }).slice(-3), ['--conversation', 'c9', '--print=x']);
    });
    // `plutos connect`, isolated: every folder a client or PLUT_OS could write to points into the temp folder.
    const home = path.join(tmp, 'home'), hub = path.join(tmp, 'hub'), project = path.join(tmp, 'project');
    for (const dir of [home, hub, project]) fs.mkdirSync(dir, { recursive: true });
    const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData'), PLUTOS_HOME: hub };
    const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), ...args], { env, cwd: project, encoding: 'utf8' });
    spawnSync('git', ['init', '-q'], { cwd: project });
    check('connect before the kit is installed is refused', () => {
        const r = cli('connect', 'cursor', project);
        assert.notEqual(r.status, 0);
        assert.match(r.stdout + r.stderr, /Install the PLUT_OS project kit first/);
    });
    check('connect wires the client inside the project and keeps a machine path out of git', () => {
        assert.equal(cli('init', project).status, 0);
        const r = cli('connect', 'cursor', project);
        assert.equal(r.status, 0, r.stdout + r.stderr);
        const config = JSON.parse(fs.readFileSync(path.join(project, '.cursor', 'mcp.json'), 'utf8'));
        assert.ok(config.mcpServers?.plutos, 'the plutos server entry');
        assert.match(fs.readFileSync(path.join(project, '.gitignore'), 'utf8'), /^\.cursor\/mcp\.json$/m);
        assert.equal(cli('connect', 'claude-code', project).status, 0);
        assert.ok(JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8')).mcpServers?.plutos);
    });
    check('connect writes nothing into the home folder', () => assert.deepEqual(fs.readdirSync(home), []));
    check('connect without an id lists the clients and fails; an unknown id says how to list them', () => {
        const none = cli('connect');
        assert.equal(none.status, 1);
        assert.match(none.stdout, /cursor/);
        assert.match(cli('connect', 'nosuch', project).stdout + cli('connect', 'nosuch', project).stderr, /Unknown client "nosuch"/);
    });
} finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`Coverage: ${passed} passed, 0 failed`);
