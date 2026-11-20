#!/usr/bin/env node
// The Hooks panel's six hooks: the safety guard refuses exactly the owner's forbidden commands,
// switching a hook on and off touches only its own entry, and the session brief reaches a hook
// inside Claude Code's 10,000-character limit with the rules whole. Scratch folders only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { guardRefusal } from '../lib/guard.mjs';
import { nativePath } from '../lib/shell-segments.mjs';
import { HOOK_TEXT_CAP, hookBrief, projectHooksStatus, setProjectHook, setCodexClaimCheck, hooksTurnedOff, enableDefaultHooks, healDefaultHooks } from '../lib/project-hooks.mjs';
import { SUBAGENT_MAP, subagentHookOutput } from '../lib/subagent-hook.mjs';
import { wireClient } from '../lib/connect.mjs';
import { recordPass } from '../lib/push-gate.mjs';
import { sessionBriefParts } from '../lib/session-brief.mjs';
import { SESSION_END_LINE } from '../lib/continuity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-hooks-')));
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log(`  ok  ${name}`); };
const checkAsync = async (name, fn) => { await fn(); checks++; console.log(`  ok  ${name}`); };

try {
    check('the guard refuses force pushes, hard resets, forced cleans and non-literal recursive deletes', () => {
        for (const c of ['git push --force origin main', 'git push -f', 'git push origin +main', 'git -C x reset --hard',
            'git clean -fd', 'rm -rf build', 'rm -rf $TMP/x', 'rm -rf ~/old', 'rm -rf /', 'cd a && rm -r ../b',
            'Remove-Item -Recurse .\\x']) assert.ok(guardRefusal(c), c);
    });
    check('the guard lets ordinary work through', () => {
        for (const c of ['git push -u origin main', 'git push --force-with-lease', 'git reset --soft HEAD~1', 'git clean -n',
            'rm -f a.txt', `rm -rf ${path.join(scratch, 'build')}`, 'rm -rf C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\x\\build', `rm -rf ${path.join(scratch, 'old')} 2>/dev/null`, 'npm test', 'ls -la']) assert.equal(guardRefusal(c), '', c);
    });
    check('the guard refuses discarding the whole tree, and lets file-by-file work through', () => {
        for (const c of ['git checkout -- .', 'git checkout .', 'git checkout HEAD -- :/', 'git checkout -f main', 'git restore .',
            'git restore --worktree --staged .', 'git switch --discard-changes main', 'git switch -f main', 'git stash drop',
            'git stash clear', 'rmdir $env:USERPROFILE -Recurse', 'rd -Recurse x', 'del -Recurse .\\x', 'ri -r build']) assert.ok(guardRefusal(c), c);
        for (const c of ['git checkout main', 'git checkout -b topic', 'git checkout -- src/a.js', 'git restore src/a.js',
            'git restore --staged .', 'git switch main', 'git stash', 'git stash pop', 'rmdir empty-dir']) assert.equal(guardRefusal(c), '', c);
    });
    check('the guard refuses a request to the dashboard approvals route, and lets a mere mention through', () => {
        for (const c of ['curl -X POST http://127.0.0.1:3040/api/approvals -d "{}"', 'curl -s localhost:3040/api/approvals/', 'Invoke-RestMethod -Method Post http://localhost:3040/api/approvals',
            'node -e "fetch(\'http://127.0.0.1:3040/api/approvals\',{method:\'POST\'})"']) assert.ok(guardRefusal(c), c);
        for (const c of ['grep -rn api/approvals lib', 'git commit -m "gate /api/approvals with a token"']) assert.equal(guardRefusal(c), '', c);
    });
    check('Git Bash drive paths are read as Windows paths', () => {
        assert.equal(nativePath('/c/Users/pc', 'win32'), 'C:\\Users\\pc');
        assert.equal(nativePath('/c', 'win32'), 'C:\\');
        assert.equal(nativePath('/c/Users/pc', 'linux'), '/c/Users/pc');
        assert.equal(nativePath('/usr/local', 'win32'), '/usr/local');
    });
    check('a commit message with an AI co-author or an AI session link is refused; a model named as a subject passes', () => {
        assert.equal(guardRefusal('git commit -m "Bench: the smallest model with skills beat the largest without, 27.7 vs 22.0"'), '');
        assert.ok(guardRefusal("git commit -q -F - <<'EOF'\nFix the gate\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF"));
        assert.ok(guardRefusal("git commit -q -F - <<'EOF'\nFix the gate\n\nClaude-Session: https://claude.ai/code/session_0123\nEOF"));
        assert.equal(guardRefusal("git commit -q -F - <<'EOF'\nFix the gate\n\nCo-Authored-By: Jane Doe <jane@example.org>\nEOF"), '');
        assert.equal(guardRefusal('git commit -m "Haiku capture runs after compaction"'), '');
    });
    check('as a hook the guard exits 2 with its reason, and 0 otherwise', () => {
        const run = command => spawnSync(process.execPath, [path.join(root, 'lib', 'guard.mjs')],
            { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8' });
        const refused = run('git reset --hard');
        assert.equal(refused.status, 2);
        assert.match(refused.stderr, /PLUT_OS guard/);
        assert.equal(run('git status').status, 0);
    });

    const project = path.join(scratch, 'project');
    fs.mkdirSync(path.join(project, '.git'), { recursive: true });
    const settings = path.join(project, '.claude', 'settings.local.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    const theirs = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo theirs' }] };
    fs.writeFileSync(settings, JSON.stringify({ model: 'x', hooks: { PreToolUse: [theirs] } }));

    check('the brief refuses without the project launcher, naming it and Repair, and writes nothing', () => {
        assert.throws(() => setProjectHook(project, 'brief', true), /no PLUT_OS launcher \(\.plutos\/plutos-launch\.mjs\)[\s\S]*repair/i);
        assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), { model: 'x', hooks: { PreToolUse: [theirs] } });
        assert.equal(projectHooksStatus(project).hooks.find(h => h.id === 'brief').on, false);
        assert.match(projectHooksStatus(project).hooks.find(h => h.id === 'brief').problem, /launcher/);
    });
    const stub = path.join(project, '.plutos', 'plutos-launch.mjs');
    fs.mkdirSync(path.dirname(stub), { recursive: true });
    fs.writeFileSync(stub, '// launcher stub\n');

    check('switching all six on keeps the project\'s own hooks and settings', () => {
        for (const id of ['brief', 'guard', 'push-gate', 'claim-check', 'session-close', 'subagent']) assert.equal(setProjectHook(project, id, true).on, true);
        setProjectHook(project, 'guard', true);   // twice is still once
        const now = JSON.parse(fs.readFileSync(settings, 'utf8'));
        assert.equal(now.model, 'x');
        assert.deepEqual(now.hooks.PreToolUse[0], theirs);
        assert.equal(now.hooks.PreToolUse.length, 3);
        assert.equal(now.hooks.SessionStart.length, 1);
        assert.deepEqual(now.hooks.SessionStart[0].hooks[0].args, [path.join(project, '.plutos', 'plutos-launch.mjs'), '--brief']);
        assert.equal(now.hooks.Stop.length, 1);
        assert.equal('matcher' in now.hooks.Stop[0], false);   // Stop takes none
        assert.match(now.hooks.Stop[0].hooks[0].args[0], /claim-check\.mjs$/);
        assert.equal(now.hooks.SessionEnd.length, 1);
        assert.match(now.hooks.SessionEnd[0].hooks[0].args[0], /session-close\.mjs$/);
        assert.equal(now.hooks.SubagentStart.length, 1);
        assert.equal('matcher' in now.hooks.SubagentStart[0], false);   // every agent type
        assert.match(now.hooks.SubagentStart[0].hooks[0].args[0], /subagent-hook\.mjs$/);
        assert.match(fs.readFileSync(path.join(project, '.gitignore'), 'utf8'), /\.claude\/settings\.local\.json/);
    });
    check('the status says which are on, and that the brief needs the project launcher', () => {
        const s = projectHooksStatus(project);
        assert.deepEqual(s.hooks.map(h => h.on), [true, true, true, true, true, true]);
        assert.equal(s.hooks.find(h => h.id === 'brief').problem, null);
        fs.rmSync(stub);
        assert.match(projectHooksStatus(project).hooks.find(h => h.id === 'brief').problem, /launcher/);
        fs.writeFileSync(stub, '// launcher stub\n');
    });
    check('switching one off removes only that one', () => {
        setProjectHook(project, 'guard', false);
        const now = JSON.parse(fs.readFileSync(settings, 'utf8'));
        assert.equal(now.hooks.PreToolUse.length, 2);
        assert.deepEqual(projectHooksStatus(project).hooks.map(h => h.on), [true, false, true, true, true, true]);
        for (const id of ['brief', 'push-gate', 'claim-check', 'session-close', 'subagent']) setProjectHook(project, id, false);
        assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), { model: 'x', hooks: { PreToolUse: [theirs] } });
    });
    check('a settings file that is not JSON is left untouched and reported', () => {
        fs.writeFileSync(settings, '{ not json');
        assert.throws(() => setProjectHook(project, 'guard', true));
        assert.equal(fs.readFileSync(settings, 'utf8'), '{ not json');
        assert.ok(projectHooksStatus(project).error);
    });
    check('the push gate on with no passing run recorded says it refuses every push, and names the recorder', () => {
        const gated = path.join(scratch, 'gated');
        fs.mkdirSync(gated);
        execFileSync('git', ['init', '-q'], { cwd: gated });
        const gate = () => projectHooksStatus(gated).hooks.find(h => h.id === 'push-gate');
        assert.equal(gate().problem, null, 'off, it holds nothing');
        const on = setProjectHook(gated, 'push-gate', true);
        assert.match(on.problem, /no passing test run is recorded[\s\S]*refuses every git push/i);
        assert.ok(on.problem.endsWith(`node "${path.join(root, 'lib', 'push-gate.mjs')}" run <test command>`), on.problem);
        recordPass(gated, 'tree');
        assert.equal(gate().problem, null, 'a recorded pass clears it');
    });

    check('wiring Claude Code turns on the brief, session close and subagent map, not the claim check, and says how to turn them off', () => {
        const wired = path.join(scratch, 'wired');
        fs.mkdirSync(path.join(wired, '.plutos'), { recursive: true });
        execFileSync('git', ['init', '-q'], { cwd: wired });
        fs.writeFileSync(path.join(wired, '.plutos', 'plutos-launch.mjs'), '// launcher stub\n');
        fs.writeFileSync(path.join(wired, '.plutos', 'local.json'), JSON.stringify({ plutosRoot: '/x' }));
        const on = () => projectHooksStatus(wired).hooks.filter(h => h.on).map(h => h.id);
        const first = wireClient('claude-code', wired);
        assert.deepEqual(first.hooks, { on: ['brief', 'session-close', 'subagent'], keptOff: [], error: null });
        assert.match(first.hooksNotice, /brief, session-close and subagent tool-map hooks are on[\s\S]*node cli\.mjs hooks off brief/);
        assert.doesNotMatch(first.hooksNotice, /dashboard/, 'the notice names the CLI command, not the dashboard');
        assert.deepEqual(on(), ['brief', 'session-close', 'subagent']);
        wireClient('claude-code', wired);   // twice is still once
        const now = JSON.parse(fs.readFileSync(path.join(wired, '.claude', 'settings.local.json'), 'utf8'));
        assert.equal(now.hooks.SessionStart.length, 1);
        assert.equal(now.hooks.SessionEnd.length, 1);
        assert.equal(now.hooks.SubagentStart.length, 1);
        assert.equal(now.hooks.SubagentStart[0].matcher, undefined, 'no matcher: Explore and Plan get it too');
        assert.equal(wireClient('cursor', wired).hooks, undefined, 'only Claude Code runs these hooks');

        // Wiring again leaves the hooks as the owner set them, by whatever route.
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(wired, '.plutos', 'local.json'), 'utf8')).hooksDefaulted, ['brief', 'session-close', 'subagent']);
        setProjectHook(wired, 'brief', false);
        assert.deepEqual(hooksTurnedOff(wired), ['brief']);
        assert.equal(JSON.parse(fs.readFileSync(path.join(wired, '.plutos', 'local.json'), 'utf8')).plutosRoot, '/x');
        const again = wireClient('claude-code', wired);
        assert.equal(again.hooks.already, true);
        assert.equal(again.hooksNotice, null);
        assert.deepEqual(on(), ['session-close', 'subagent']);
        setProjectHook(wired, 'subagent', false);
        const byHand = JSON.parse(fs.readFileSync(path.join(wired, '.claude', 'settings.local.json'), 'utf8'));
        delete byHand.hooks.SessionEnd;   // removed in Claude's /hooks or by hand: no hooksOff record
        fs.writeFileSync(path.join(wired, '.claude', 'settings.local.json'), JSON.stringify(byHand));
        wireClient('claude-code', wired);
        assert.deepEqual(on(), [], 'a hook removed outside the panel is not switched back on');

        // A project whose once-only record was lost still keeps a panel off.
        const local = JSON.parse(fs.readFileSync(path.join(wired, '.plutos', 'local.json'), 'utf8'));
        delete local.hooksDefaulted;
        fs.writeFileSync(path.join(wired, '.plutos', 'local.json'), JSON.stringify(local));
        const relost = wireClient('claude-code', wired);
        assert.deepEqual(relost.hooks, { on: ['session-close'], keptOff: ['brief', 'subagent'], error: null });
        assert.match(relost.hooksNotice, /switched off brief and subagent, which stays off/);
        assert.deepEqual(on(), ['session-close']);

        // On again in the panel clears the record.
        setProjectHook(wired, 'brief', true);
        setProjectHook(wired, 'subagent', true);
        assert.deepEqual(hooksTurnedOff(wired), []);
    });

    check('a project defaulted before the subagent hook existed gets it once, and keeps an off after', () => {
        const old = path.join(scratch, 'defaulted-before');
        fs.mkdirSync(path.join(old, '.plutos'), { recursive: true });
        fs.writeFileSync(path.join(old, '.plutos', 'plutos-launch.mjs'), '// launcher stub\n');
        fs.writeFileSync(path.join(old, '.plutos', 'local.json'), JSON.stringify({ hooksDefaulted: true }));
        const on = () => projectHooksStatus(old).hooks.filter(h => h.on).map(h => h.id);
        const r = enableDefaultHooks(old);
        assert.deepEqual(r.on, ['subagent'], 'brief and session-close were defaulted already and stay the owner\'s');
        assert.match(r.notice, /subagent tool-map hook is now on[\s\S]*hooks off subagent/);
        assert.deepEqual(on(), ['subagent']);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(old, '.plutos', 'local.json'), 'utf8')).hooksDefaulted, ['brief', 'session-close', 'subagent']);
        const r2 = enableDefaultHooks(old);
        assert.equal(r2.already, true);
        assert.deepEqual(r2.on, []);
        setProjectHook(old, 'subagent', false);
        enableDefaultHooks(old);
        assert.deepEqual(on(), [], 'once defaulted, an off stays off');
    });

    check('a project wired before gets a new default hook where it opens (healDefaultHooks), never one never wired or switched off', () => {
        const old = path.join(scratch, 'healed-on-open');
        fs.mkdirSync(path.join(old, '.plutos'), { recursive: true });
        fs.writeFileSync(path.join(old, '.plutos', 'plutos-launch.mjs'), '// launcher stub\n');
        fs.writeFileSync(path.join(old, '.plutos', 'local.json'), JSON.stringify({ hooksDefaulted: true, hooksOff: ['brief'] }));
        const on = () => projectHooksStatus(old).hooks.filter(h => h.on).map(h => h.id);
        const r = healDefaultHooks(old);
        assert.deepEqual(r.on, ['subagent']);
        assert.deepEqual(on(), ['subagent'], 'brief and session-close stay as the owner left them');
        assert.equal(healDefaultHooks(old), null, 'nothing due the second time');
        const never = path.join(scratch, 'never-wired');
        fs.mkdirSync(path.join(never, '.plutos'), { recursive: true });
        assert.equal(healDefaultHooks(never), null);
        assert.equal(fs.existsSync(path.join(never, '.claude', 'settings.local.json')), false, 'a project never wired to Claude Code gets no hook');
        assert.equal(healDefaultHooks(''), null);
        const indexSrc = fs.readFileSync(path.join(root, 'index.mjs'), 'utf8');
        assert.match(indexSrc, /healDefaultHooks\(PROJECT_ROOT\)/, 'the SessionStart brief heals');
    });

    check('the subagent hook hands a short tool map to a PLUT_OS project and nothing elsewhere, always exiting 0', () => {
        const kit = path.join(scratch, 'subagent-kit');
        fs.mkdirSync(path.join(kit, '.plutos'), { recursive: true });
        fs.writeFileSync(path.join(kit, '.plutos', 'plutos-launch.mjs'), '// launcher stub\n');
        const bare = path.join(scratch, 'subagent-bare');
        fs.mkdirSync(bare);
        const script = path.join(root, 'lib', 'subagent-hook.mjs');
        const run = (input, env = {}) => spawnSync(process.execPath, [script], { input, encoding: 'utf8', timeout: 10_000,
            env: { ...process.env, CLAUDE_PROJECT_DIR: '', HOME: scratch, USERPROFILE: scratch, ...env } });
        const started = Date.now();
        const out = run(JSON.stringify({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore', cwd: kit }));
        assert.ok(Date.now() - started < 3000, 'well under the hook timeout');
        assert.equal(out.status, 0, out.stderr);
        const answer = JSON.parse(out.stdout).hookSpecificOutput;
        assert.equal(answer.hookEventName, 'SubagentStart');
        assert.ok(SUBAGENT_MAP.length < 700, `${SUBAGENT_MAP.length} characters`);
        assert.ok(answer.additionalContext.startsWith(SUBAGENT_MAP));
        for (const t of ['plutos_context_for_task', 'plutos_code_lookup', 'plutos_modules open research', 'judgment', 'parent named tools']) assert.ok(SUBAGENT_MAP.includes(t), t);
        assert.equal(run('', { CLAUDE_PROJECT_DIR: kit }).stdout, out.stdout, 'CLAUDE_PROJECT_DIR is read first');
        for (const [input, env] of [[JSON.stringify({ cwd: bare }), {}], ['not json', { CLAUDE_PROJECT_DIR: path.join(scratch, 'missing') }], ['{}', { CLAUDE_PROJECT_DIR: bare }]]) {
            const r = run(input, env);
            assert.equal(r.status, 0, r.stderr);
            assert.equal(r.stdout, '', 'nothing outside a PLUT_OS project');
        }
    });

    await checkAsync('the subagent hook leaves within its limit when stdin is a pipe that never closes', async () => {
        const script = path.join(root, 'lib', 'subagent-hook.mjs');
        const started = Date.now();
        const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CLAUDE_PROJECT_DIR: '', HOME: scratch, USERPROFILE: scratch } });
        let out = '';
        child.stdout.on('data', d => { out += d; });
        const code = await new Promise(done => { const t = setTimeout(() => { child.kill(); done('timeout'); }, 4000); child.on('exit', c => { clearTimeout(t); done(c); }); });
        child.stdin.destroy();
        assert.equal(code, 0, 'exits 0 on its own');
        assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms`);
        assert.equal(out, '');
    });

    await checkAsync('the subagent map adds one line per active pack MCP server, and skips a lister that fails', async () => {
        const kit = path.join(scratch, 'subagent-kit');
        const context = async listServers => {
            const out = await subagentHookOutput(kit, { listServers });
            return JSON.parse(out).hookSpecificOutput.additionalContext;
        };
        const listed = await context(async () => ['engine-pack', { name: 'modeler', description: 'Modeling\nbridge' }, { nope: 1 }]);
        assert.ok(listed.startsWith(SUBAGENT_MAP));
        assert.deepEqual(listed.slice(SUBAGENT_MAP.length).trim().split('\n'),
            ['Active pack tools:', '- engine-pack (pack MCP server)', '- modeler (pack MCP server): Modeling bridge']);
        assert.equal(await context(() => { throw new Error('boom'); }), SUBAGENT_MAP);
        assert.equal(await context(async () => 'not a list'), SUBAGENT_MAP);
        assert.equal(await subagentHookOutput(path.join(scratch, 'subagent-bare'), { listServers: async () => ['x'] }), '');
    });

    check('plutos connect claude-code-local switches the hooks on and prints Claude\'s own command', () => {
        const local = path.join(scratch, 'wired-local');
        fs.mkdirSync(path.join(local, '.plutos'), { recursive: true });
        fs.writeFileSync(path.join(local, '.plutos', 'plutos-launch.mjs'), '// launcher stub\n');
        const run = spawnSync(process.execPath, [path.join(root, 'cli.mjs'), 'connect', 'claude-code-local', local],
            { encoding: 'utf8', env: { ...process.env, PLUTOS_MODE: '' } });
        assert.equal(run.status, 0, run.stderr + run.stdout);
        assert.match(run.stdout, /brief, session-close and subagent tool-map hooks are on/);
        assert.match(run.stdout, /claude mcp add .*--scope local/);
        assert.deepEqual(projectHooksStatus(local).hooks.filter(h => h.on).map(h => h.id), ['brief', 'session-close', 'subagent']);
        assert.equal(fs.existsSync(path.join(local, '.mcp.json')), false, 'the private route writes no .mcp.json');
    });

    const codexProject = path.join(scratch, 'codex-project');
    const codexFile = path.join(codexProject, '.codex', 'hooks.json');
    fs.mkdirSync(path.dirname(codexFile), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: codexProject });
    const codexTheirs = { hooks: { PreToolUse: [{ matcher: 'shell', hooks: [{ type: 'command', command: 'echo theirs' }] }] } };
    fs.writeFileSync(codexFile, JSON.stringify(codexTheirs));

    check('Codex gets the claim check in .codex/hooks.json, kept out of git, beside its own hooks', () => {
        assert.equal(setCodexClaimCheck(codexProject, true).on, true);
        setCodexClaimCheck(codexProject, true);   // twice is still once
        const now = JSON.parse(fs.readFileSync(codexFile, 'utf8'));
        assert.deepEqual(now.hooks.PreToolUse, codexTheirs.hooks.PreToolUse);
        assert.equal(now.hooks.Stop.length, 1);
        assert.equal('matcher' in now.hooks.Stop[0], false);
        assert.match(now.hooks.Stop[0].hooks[0].command, /^node ".+claim-check\.mjs"$/);
        assert.equal(now.hooks.Stop[0].hooks[0].timeout, 15);
        assert.match(fs.readFileSync(path.join(codexProject, '.gitignore'), 'utf8'), /^\.codex\/hooks\.json$/m);
    });
    check('the command Codex runs answers its Stop input with JSON at exit 0', () => {
        const { command } = JSON.parse(fs.readFileSync(codexFile, 'utf8')).hooks.Stop[0].hooks[0];
        const input = { session_id: 's', turn_id: 't', cwd: codexProject, hook_event_name: 'Stop', model: 'm',
            permission_mode: 'default', stop_hook_active: false, last_assistant_message: 'Done.' };
        const run = spawnSync(command, { shell: true, input: JSON.stringify(input), encoding: 'utf8' });
        assert.equal(run.status, 0, run.stderr);
        assert.equal(typeof JSON.parse(run.stdout), 'object');
    });
    check('switching Codex off removes only ours; a hooks.json the project tracks is left alone', () => {
        assert.equal(setCodexClaimCheck(codexProject, false).on, false);
        assert.deepEqual(JSON.parse(fs.readFileSync(codexFile, 'utf8')), codexTheirs);
        execFileSync('git', ['add', '-f', '.codex/hooks.json'], { cwd: codexProject });
        const before = fs.readFileSync(codexFile, 'utf8');
        assert.throws(() => setCodexClaimCheck(codexProject, true), /tracks \.codex\/hooks\.json/);
        assert.equal(fs.readFileSync(codexFile, 'utf8'), before);
    });
    check('node lib/claim-check.mjs install --codex <dir> switches it on and names the /hooks step', () => {
        const other = path.join(scratch, 'codex-cli');
        fs.mkdirSync(other);
        const run = spawnSync(process.execPath, [path.join(root, 'lib', 'claim-check.mjs'), 'install', '--codex', other], { encoding: 'utf8' });
        assert.equal(run.status, 0, run.stderr);
        assert.match(run.stdout, /claim check on in .*hooks\.json[\s\S]*\/hooks/);
    });

    check('a brief over the hook limit is cut in its context, never in its rules', () => {
        const rules = '\n\nWORKING AGREEMENT\n1. rule';
        const context = Array.from({ length: 400 }, (_, i) => `paragraph ${i} ${'x'.repeat(40)}`).join('\n\n');
        const out = hookBrief({ context, rules });
        assert.ok(out.length <= HOOK_TEXT_CAP, String(out.length));
        assert.ok(out.endsWith(rules));
        assert.match(out, /call session_start for the full brief/);
        assert.equal(hookBrief({ context: 'short', rules }).includes('Cut to fit'), false);
    });
    check('index.mjs --brief prints the brief for a PLUT_OS project, and nothing for any other folder', () => {
        const brief = path.join(scratch, 'brief');
        fs.mkdirSync(path.join(brief, 'docs', 'handoff'), { recursive: true });
        fs.writeFileSync(path.join(brief, 'docs', 'handoff', 'PLUTOS_PROTOCOL.md'), '# protocol\n');
        const run = dir => spawnSync(process.execPath, [path.join(root, 'index.mjs'), '--brief'], { encoding: 'utf8', timeout: 60_000,
            env: { ...process.env, PLUTOS_HOME: path.join(scratch, 'home'), PLUTOS_PROJECT_ROOT: dir } });
        const r = run(brief);
        assert.equal(r.status, 0);
        assert.match(r.stdout, /^PLUT_OS session brief, delivered by the SessionStart hook/);
        assert.match(r.stdout, /SESSION BRIEF/);
        assert.ok(r.stdout.length <= HOOK_TEXT_CAP);
        const plain = path.join(scratch, 'plain');
        fs.mkdirSync(plain);
        assert.equal(run(plain).stdout, '');
    });
    check("PLUT_OS's own brief reaches the hook with its rules and its session_end line", () => {
        // On 2026-10-27 this repository's brief outgrew the hook, which cut its end and the
        // session_end line with it. That line now travels with the rules, which no cut reaches;
        // the context's size moves with every commit, so it is reported, not asserted.
        // 'Claude Code' is the name the hook itself reports for a Claude Code session.
        const parts = sessionBriefParts(root, 'Claude Code', { writes: false });
        const text = hookBrief(parts);
        assert.ok(text.length <= HOOK_TEXT_CAP, String(text.length));
        assert.ok(text.endsWith(SESSION_END_LINE), 'the session_end line closes the brief');
        assert.ok(text.includes('WORKING AGREEMENT'), 'the working agreement reaches the hook');
        console.log(`        (${text.length} of ${HOOK_TEXT_CAP} characters${text.includes('Cut to fit') ? '; the project context was cut' : ''})`);
    });
    check('an over-long brief drops whole sections, least needed first, and keeps the work the session acts on', () => {
        const filler = n => 'x'.repeat(n);
        const context = ['# SESSION BRIEF — test', '## What this is\n' + filler(400), '## Settled decisions (do not silently re-open)\n' + filler(600),
            '## Source-backed shared context\n' + filler(3000), '## Shared context to re-check — source edited\n' + filler(3000),
            '## Landed since that session (40 commits)\n' + filler(2000), '## Assigned to you\n- the task', '## ⚠ Needs attention (housekeeping)\n- drift'].join('\n');
        const text = hookBrief({ context, rules: '\n\nWORKING AGREEMENT\n' + filler(2500) });
        assert.ok(text.length <= HOOK_TEXT_CAP, String(text.length));
        assert.ok(text.includes('## Assigned to you') && text.includes('## ⚠ Needs attention'), 'the work to act on stays');
        assert.ok(!text.includes('## Source-backed shared context'), 'what can be looked up leaves first');
        assert.match(text, /Left out to fit the 10,000-character hook limit: Source-backed shared context/);
        assert.ok(!text.includes('Cut to fit'), 'no mid-section cut when dropping sections is enough');
    });
    console.log(`${checks} hooks checks passed`);
} finally {
    fs.rmSync(scratch, { recursive: true, force: true });
}
