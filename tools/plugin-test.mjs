#!/usr/bin/env node
// PLUT_OS as a Claude Code plugin (.claude-plugin/): the manifests and the paths they name, Claude
// Code's own validator, the hooks doing nothing in a folder that is not a PLUT_OS project and the
// brief in one that is, the MCP server started exactly as plugin.json says (its variables
// substituted here) in a project, outside one and beside a project's own entry, no second brief where
// the project runs its own hook, and the plugin status `plutos plugin` and `plutos connect` report.
// Scratch folders only; Claude's records are read from a scratch CLAUDE_CONFIG_DIR.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-plugin-')));
const hub = path.join(scratch, 'hub');
const claudeDir = path.join(scratch, 'claude-config');
process.env.PLUTOS_HOME = hub;
process.env.HOME = process.env.USERPROFILE = path.join(scratch, 'user-home');
process.env.APPDATA = path.join(scratch, 'user-home', 'AppData', 'Roaming');
process.env.CLAUDE_CONFIG_DIR = claudeDir;
fs.mkdirSync(process.env.APPDATA, { recursive: true });
for (const k of ['CLAUDE_PROJECT_DIR', 'PLUTOS_PROJECT_ROOT', 'PLUTOS_PROJECT_BOUND_BY_LAUNCHER', 'PLUTOS_PLUGIN', 'CODEX_HOME', 'PLUTOS_CODEX_PROJECT_CONFIG', 'PLUTOS_MODE']) delete process.env[k];

const { initTargetProject, looksLikePlutosProject: kitCheck } = await import('../lib/workspaces.mjs');
const { looksLikePlutosProject } = await import('../lib/project-marker.mjs');
const { wireClient } = await import('../lib/connect.mjs');
const { PROJECT_HOOKS, DEFAULT_HOOKS, setProjectHook, removeProjectHooks, hooksTurnedOff, projectHooksStatus, isOurs } = await import('../lib/project-hooks.mjs');
const { PLUGIN_HOOKS, pluginHookSkip, projectRunsHook } = await import('../lib/plugin-hook.mjs');
const { claudePluginStatus, claudeOwnEntry, pluginServerMode } = await import('../lib/claude-plugin.mjs');
const { rebindProject } = await import('../lib/rebind.mjs');

let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log(`  ok  ${name}`); };
const checkAsync = async (name, fn) => { await fn(); checks++; console.log(`  ok  ${name}`); };
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const listTree = dir => fs.readdirSync(dir, { recursive: true }).sort();
const pluginJson = readJson(path.join(root, '.claude-plugin', 'plugin.json'));
const marketplace = readJson(path.join(root, '.claude-plugin', 'marketplace.json'));
const pkg = readJson(path.join(root, 'package.json'));
const hookFile = path.join(root, pluginJson.hooks || '');
const hooksJson = readJson(hookFile);

// A hook as Claude Code runs it: its command line with ${CLAUDE_PLUGIN_ROOT} filled in, the event on stdin.
function runHook(id, projectDir, event = {}) {
    return spawnSync(process.execPath, [path.join(root, 'lib', 'plugin-hook.mjs'), id], {
        cwd: projectDir, input: JSON.stringify({ cwd: projectDir, ...event }), encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, CLAUDE_PLUGIN_ROOT: root }
    });
}

// The MCP server exactly as plugin.json declares it, from a working directory that is not the project.
function startServer(projectDir, extraEnv = {}) {
    const spec = pluginJson.mcpServers.plutos;
    const fill = v => v.replaceAll('${CLAUDE_PLUGIN_ROOT}', root).replaceAll('${CLAUDE_PROJECT_DIR}', projectDir);
    const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir, CLAUDE_PLUGIN_ROOT: root };
    for (const [k, v] of Object.entries(spec.env || {})) env[k] = fill(v);
    Object.assign(env, extraEnv);
    const command = spec.command === 'node' ? process.execPath : spec.command;
    const srv = spawn(command, spec.args.map(fill), { cwd: scratch, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '', nextId = 1;
    const pending = new Map();
    srv.stdout.on('data', d => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            try {
                const m = JSON.parse(line);
                // A client with the roots capability, as Claude Code is: it names the folder it was opened in.
                if (m.method === 'roots/list') srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { roots: (extraEnv.ROOTS || []).map(r => ({ uri: pathToFileURL(r).href })) } }) + '\n');
                else if (m.id != null) pending.get(m.id)?.(m);
            } catch { /* not JSON-RPC */ }
        }
    });
    const rpc = (method, params) => new Promise((resolve, reject) => {
        const id = nextId++;
        const t = setTimeout(() => reject(new Error(`${method} timed out`)), 15000);
        pending.set(id, m => { clearTimeout(t); resolve(m); });
        srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    const open = async () => {
        const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: extraEnv.ROOTS ? { roots: {} } : {}, clientInfo: { name: 'claude-code', version: '1' } });
        srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        return init;
    };
    const call = async (name, args = {}) => {
        const r = await rpc('tools/call', { name, arguments: args });
        return { text: (r.result?.content || []).map(c => c.text || '').join(''), isError: !!r.result?.isError };
    };
    return { srv, rpc, open, call, close: () => srv.kill() };
}

const kit = path.join(scratch, 'kit');
const plain = path.join(scratch, 'plain');
const wired = path.join(scratch, 'wired');
for (const dir of [kit, plain, wired]) fs.mkdirSync(dir, { recursive: true });
initTargetProject(kit);
initTargetProject(wired);
fs.writeFileSync(path.join(plain, 'README.md'), '# not a PLUT_OS project\n');

try {
    check('plugin.json: named plutos, versioned like package.json, its paths start with ./ and exist', () => {
        assert.equal(pluginJson.name, 'plutos');
        assert.equal(pluginJson.version, pkg.version, 'plugin.json version must follow package.json');
        assert.match(pluginJson.hooks, /^\.\//);
        assert.ok(fs.existsSync(hookFile), pluginJson.hooks);
        const spec = pluginJson.mcpServers?.plutos;
        assert.equal(spec.command, 'node');
        assert.deepEqual(spec.args, ['${CLAUDE_PLUGIN_ROOT}/lib/plugin-entry.mjs']);
        assert.ok(fs.existsSync(path.join(root, 'lib', 'plugin-entry.mjs')));
        assert.deepEqual(spec.env, { PLUTOS_PROJECT_ROOT: '${CLAUDE_PROJECT_DIR}', PLUTOS_PLUGIN: '1' });
        assert.ok(!fs.existsSync(path.join(root, '.mcp.json')), 'no repository .mcp.json: the plugin declares its server inline');
    });
    check('marketplace.json: one plugin, plutos, at the repository root, versioned only in plugin.json', () => {
        assert.equal(marketplace.name, 'plutos');
        assert.equal(typeof marketplace.owner?.name, 'string');
        assert.equal(marketplace.plugins.length, 1);
        assert.equal(marketplace.plugins[0].name, 'plutos');
        assert.equal(marketplace.plugins[0].source, './');
        assert.equal(marketplace.plugins[0].version, undefined);
    });
    check('the plugin\'s hooks are the default-on project hooks, on the same events, matchers and timeouts', () => {
        const ids = [];
        for (const [event, groups] of Object.entries(hooksJson.hooks)) {
            for (const group of groups) for (const h of group.hooks) {
                const m = h.command.match(/^node "\$\{CLAUDE_PLUGIN_ROOT\}\/lib\/plugin-hook\.mjs" ([a-z-]+)$/);
                assert.ok(m, h.command);
                const project = PROJECT_HOOKS.find(p => p.id === m[1]);
                assert.equal(event, project.event, m[1]);
                assert.equal(group.matcher, project.matcher, m[1]);
                assert.equal(h.timeout, project.timeout, m[1]);
                assert.equal(PLUGIN_HOOKS[m[1]].event, project.event);
                ids.push(m[1]);
            }
        }
        assert.deepEqual(ids.sort(), [...DEFAULT_HOOKS].sort());
        assert.deepEqual(Object.keys(PLUGIN_HOOKS).sort(), [...DEFAULT_HOOKS].sort());
    });
    check('the light project check is the one lib/workspaces.mjs exports', () => {
        assert.equal(kitCheck, looksLikePlutosProject);
        assert.equal(looksLikePlutosProject(kit), true);
        assert.equal(looksLikePlutosProject(plain), false);
    });

    const claude = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 20_000 });
    if (claude.status !== 0) console.log('  --  claude plugin validate skipped: the claude CLI is not on PATH');
    else check('claude plugin validate passes; its one warning is the repository\'s own CLAUDE.md at the plugin root', () => {
        const r = spawnSync('claude', ['plugin', 'validate', root, '--json'], { encoding: 'utf8', timeout: 60_000 });
        assert.equal(r.status, 0, r.stdout + r.stderr);
        const report = JSON.parse(r.stdout);
        assert.equal(report.success, true);
        const warnings = [report.manifest, ...(report.contents || [])].flatMap(c => c?.warnings || []).map(w => w.message);
        assert.ok(warnings.every(w => /CLAUDE\.md at the plugin root/.test(w)), warnings.join('\n'));
        assert.equal(report.provides.mcpServers.map(s => s.name).join(), 'plutos');
        assert.deepEqual(report.provides.hooks.map(h => h.event).sort(), ['SessionEnd', 'SessionStart', 'SubagentStart']);
    });

    check('every plugin hook exits 0 silently in a folder that is not a PLUT_OS project, and writes nothing', () => {
        const before = listTree(plain);
        for (const id of [...DEFAULT_HOOKS, 'no-such-hook']) {
            const r = runHook(id, plain, { source: 'startup' });
            assert.equal(r.status, 0, `${id}: ${r.stderr}`);
            assert.equal(r.stdout, '', id);
            assert.equal(r.stderr, '', id);
        }
        assert.deepEqual(listTree(plain), before);
        assert.equal(pluginHookSkip(plain, 'brief'), 'not a PLUT_OS project');
    });

    check('in a PLUT_OS project the plugin\'s SessionStart hook prints the brief and writes no hook settings', () => {
        const r = runHook('brief', kit, { source: 'startup' });
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /^PLUT_OS session brief, delivered by the SessionStart hook/);
        assert.match(r.stdout, /WORKING AGREEMENT/);
        assert.doesNotMatch(r.stdout, /Setup tier: files only/, 'the plugin brings the server: the brief must not say no MCP is wired');
        assert.ok(!fs.existsSync(path.join(kit, '.claude', 'settings.local.json')), 'the plugin writes no hook settings into the project');
    });
    check('the plugin\'s SubagentStart hook hands over the tool map', () => {
        const r = runHook('subagent', kit, { agent_type: 'Explore' });
        assert.equal(r.status, 0, r.stderr);
        assert.equal(JSON.parse(r.stdout).hookSpecificOutput.hookEventName, 'SubagentStart');
    });
    check('no second brief: the project\'s own brief hook wins, an owner\'s off holds, a tidy is not an off', () => {
        setProjectHook(kit, 'brief', true);
        assert.equal(pluginHookSkip(kit, 'brief'), 'the project runs its own copy');
        assert.equal(runHook('brief', kit).stdout, '', 'the project runs its own brief: the plugin prints none');
        assert.deepEqual(removeProjectHooks(kit, ['brief', 'subagent']), { removed: ['brief'], kept: [] });
        assert.ok(!hooksTurnedOff(kit).includes('brief'), 'taking the project copy out records no off');
        assert.match(runHook('brief', kit).stdout, /^PLUT_OS session brief/);
        setProjectHook(kit, 'brief', false);
        assert.equal(pluginHookSkip(kit, 'brief'), 'switched off in this project');
        assert.equal(runHook('brief', kit).stdout, '');
        setProjectHook(kit, 'brief', true);
        removeProjectHooks(kit, ['brief']);
        assert.match(runHook('brief', kit).stdout, /^PLUT_OS session brief/, 'switched on again, then tidied: the plugin brief is back');
    });

    const localSettings = dir => path.join(dir, '.claude', 'settings.local.json');
    const writeLocalHooks = (dir, hooks) => { fs.mkdirSync(path.join(dir, '.claude'), { recursive: true }); fs.writeFileSync(localSettings(dir), JSON.stringify({ hooks }, null, 2)); };
    check('one predicate for "the project runs this hook": an unrelated --brief command is not ours, a string-form PLUT_OS brief is, in both readers', () => {
        const brief = PROJECT_HOOKS.find(h => h.id === 'brief');
        for (const handler of [{ type: 'command', command: 'mytool --brief' }, { type: 'command', command: 'mytool', args: ['--brief'] }, { type: 'command', command: 'node', args: ['tools/other.mjs', '--brief'] }]) {
            writeLocalHooks(kit, { SessionStart: [{ hooks: [handler] }] });
            assert.equal(isOurs(brief, handler), false, JSON.stringify(handler));
            assert.equal(projectRunsHook(kit, 'brief'), false, JSON.stringify(handler));
            assert.equal(projectHooksStatus(kit).hooks.find(h => h.id === 'brief').on, false);
            assert.match(runHook('brief', kit).stdout, /^PLUT_OS session brief/, `${JSON.stringify(handler)} must not suppress the plugin brief`);
        }
        const stringForm = { type: 'command', command: `node "${path.join(kit, '.plutos', 'plutos-launch.mjs')}" --brief` };
        writeLocalHooks(kit, { SessionStart: [{ matcher: 'startup', hooks: [stringForm] }] });
        assert.equal(isOurs(brief, stringForm), true);
        assert.equal(projectRunsHook(kit, 'brief'), true);
        assert.equal(projectHooksStatus(kit).hooks.find(h => h.id === 'brief').on, true, 'the Hooks panel sees it too');
        assert.equal(runHook('brief', kit).stdout, '');
        fs.rmSync(localSettings(kit));
    });

    check('a session opened in a project\'s subfolder is that project\'s; the walk stops at a git root', () => {
        const sub = path.join(kit, 'src', 'deep');
        fs.mkdirSync(sub, { recursive: true });
        assert.match(runHook('brief', sub, { source: 'startup' }).stdout, /^PLUT_OS session brief/);
        const nested = path.join(kit, 'vendor', 'other-repo');
        fs.mkdirSync(path.join(nested, '.git'), { recursive: true });
        fs.mkdirSync(path.join(nested, 'pkg'));
        assert.equal(runHook('brief', path.join(nested, 'pkg')).stdout, '', 'a folder in another repository inside the project is not the project');
        const unsubstituted = spawnSync(process.execPath, [path.join(root, 'lib', 'plugin-hook.mjs'), 'brief'], { cwd: sub, input: '{}', encoding: 'utf8', timeout: 30_000,
            env: { ...process.env, CLAUDE_PROJECT_DIR: '${CLAUDE_PROJECT_DIR}', CLAUDE_PLUGIN_ROOT: root } });
        assert.match(unsubstituted.stdout, /^PLUT_OS session brief/, 'an unsubstituted variable falls back to the working folder');
    });

    await checkAsync('the plugin\'s MCP server serves a PLUT_OS project: initialize, tools/list and its binding, from a subfolder too', async () => {
        for (const dir of [kit, path.join(kit, 'src', 'deep')]) {
            const s = startServer(dir, { ROOTS: [dir] });
            try {
                const init = await s.open();
                assert.equal(init.result.serverInfo.name, 'plutos');
                assert.match(init.result.instructions, /^PLUT_OS coordinates the AIs on this project/);
                const tools = (await s.rpc('tools/list', {})).result.tools.map(t => t.name);
                for (const name of ['session_start', 'board_read', 'board_update', 'plutos_project_info']) assert.ok(tools.includes(name), name);
                const info = JSON.parse((await s.call('plutos_project_info')).text);
                assert.equal(info.projectRoot, kit, dir);
                assert.equal(info.safe, true, JSON.stringify(info));
                assert.equal(info.plugin, 'active');
                const board = await s.call('board_read');
                assert.equal(board.isError, false, board.text);
            } finally { s.close(); }
        }
    });
    await checkAsync('a client root in a subfolder is the plugin\'s project only while no nearer project sits between them', async () => {
        const inner = path.join(kit, 'nested-project');
        fs.mkdirSync(inner, { recursive: true });
        initTargetProject(inner);
        const s = startServer(path.join(kit, 'src', 'deep'), { ROOTS: [inner] });
        try {
            await s.open();
            const info = JSON.parse((await s.call('plutos_project_info')).text);
            assert.equal(info.projectRoot, kit);
            assert.equal(info.safe, false, 'a root inside another project is that project\'s, not this one\'s');
        } finally { s.close(); fs.rmSync(inner, { recursive: true, force: true }); }
    });
    await checkAsync('outside a PLUT_OS project: one diagnostic tool and no instructions, cheap, writes nothing and makes no data folder', async () => {
        const before = listTree(plain);
        const freshHub = path.join(scratch, 'never-made-hub');
        const started = performance.now();
        const s = startServer(plain, { PLUTOS_HOME: freshHub });
        try {
            const init = await s.open();
            const ms = performance.now() - started;
            assert.equal(init.result.instructions, undefined, 'no PLUT_OS text in a folder it does not serve');
            const tools = (await s.rpc('tools/list', {})).result.tools;
            assert.deepEqual(tools.map(t => t.name), ['plutos_project_info']);
            assert.ok(JSON.stringify(tools).length < 400, 'the one tool stays short');
            for (const name of ['board_update', 'board_read', 'session_start', 'init_roadmap']) {
                const r = await s.call(name, { agent: 'T', status: 'TODO', title: 'x' });
                assert.equal(r.isError, true, name);
                assert.match(r.text, /is not a PLUT_OS project/, name);
            }
            const info = JSON.parse((await s.call('plutos_project_info')).text);
            assert.equal(info.plugin, 'outside');
            assert.match(info.error, /not a PLUT_OS project/);
            // No PLUT_OS server or SDK loaded: well under what index.mjs takes (about 80 MB, 150 ms here).
            const rss = Number(fs.readFileSync(`/proc/${s.srv.pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)?.[1] || 0) / 1024;
            if (process.platform === 'linux') assert.ok(rss < 65, `RSS ${Math.round(rss)} MB`);
            console.log(`        (outside: initialize answered in ${Math.round(ms)} ms, RSS ${Math.round(rss)} MB)`);
        } finally { s.close(); }
        assert.deepEqual(listTree(plain), before);
        assert.ok(!fs.existsSync(freshHub), 'no data folder for a folder it does not serve');
    });

    // The project's own .mcp.json entry is Claude's to run: only once approved, not declined, and only if
    // its launcher finds an install. Until then the plugin's server serves the project.
    const claudeJson = path.join(claudeDir, '.claude.json');
    const setClaudeJson = data => { fs.mkdirSync(claudeDir, { recursive: true }); fs.writeFileSync(claudeJson, JSON.stringify(data, null, 2)); };
    const modeOf = async dir => {
        const s = startServer(dir, { PLUTOS_HOME: hub });
        try {
            const init = await s.open();
            const tools = (await s.rpc('tools/list', {})).result.tools;
            return { init: init.result, tools };
        } finally { s.close(); }
    };
    await checkAsync('beside a .mcp.json plutos entry: pending, declined or unresolvable keeps the plugin active; approved makes it stand by', async () => {
        wireClient('claude-code', wired);
        assert.ok(fs.existsSync(path.join(wired, '.mcp.json')));
        setClaudeJson({});
        assert.deepEqual(claudeOwnEntry(wired), { id: 'claude-code', usable: false, reason: 'not yet approved in Claude' });
        let r = await modeOf(wired);
        assert.ok(r.tools.length > 5, 'pending approval: the plugin serves the project');
        setClaudeJson({ projects: { [wired]: { enabledMcpjsonServers: ['plutos'], disabledMcpjsonServers: ['plutos'] } } });
        assert.equal(claudeOwnEntry(wired).reason, 'declined in Claude');
        assert.equal(pluginServerMode(wired), 'active');
        setClaudeJson({ projects: { [wired]: { enabledMcpjsonServers: ['plutos'] } } });
        assert.equal(claudeOwnEntry(wired, { env: { ...process.env, PLUTOS_HOME: path.join(scratch, 'no-hub') } }).usable, true, 'local.json plutosRoot resolves the install');
        const localFile = path.join(wired, '.plutos', 'local.json');
        const local = readJson(localFile);
        fs.writeFileSync(localFile, JSON.stringify({ ...local, plutosRoot: path.join(scratch, 'gone') }));
        assert.equal(claudeOwnEntry(wired, { env: { ...process.env, PLUTOS_HOME: path.join(scratch, 'no-hub') } }).reason, 'its launcher finds no PLUT_OS install on this machine');
        r = await modeOf(wired);
        if (!fs.existsSync(path.join(hub, 'install.json'))) assert.ok(r.tools.length > 5, 'unresolvable stub: the plugin serves the project');
        fs.writeFileSync(localFile, JSON.stringify(local));
        r = await modeOf(wired);
        assert.deepEqual(r.tools, [], 'approved and resolvable: the project\'s own entry serves it');
        assert.equal(r.init.instructions, undefined);
        const s = startServer(wired);
        try {
            await s.open();
            const call = await s.call('board_read');
            assert.equal(call.isError, true);
            assert.match(call.text, /stands by/);
        } finally { s.close(); }
        setClaudeJson({ projects: { [wired]: { enableAllProjectMcpServers: true } } });
        assert.equal(pluginServerMode(wired), 'standby', 'enableAllProjectMcpServers approves it too');
        setClaudeJson({});
        fs.mkdirSync(path.join(wired, '.claude'), { recursive: true });
        fs.writeFileSync(path.join(wired, '.claude', 'settings.local.json'), JSON.stringify({ enabledMcpjsonServers: ['plutos'], ...readJson(localSettings(wired)) }));
        assert.equal(pluginServerMode(wired), 'standby', 'an approval in the project\'s settings counts');
        fs.writeFileSync(path.join(wired, '.claude', 'settings.local.json'), JSON.stringify({ ...readJson(localSettings(wired)), enabledMcpjsonServers: undefined }));
    });
    check('$CLAUDE_CONFIG_DIR/.claude.json: a local-scope entry and a user-scope plutos entry are the project\'s own; one bound elsewhere or switched off is not', () => {
        const bare = path.join(scratch, 'bare');
        fs.mkdirSync(bare);
        initTargetProject(bare);
        setClaudeJson({ projects: { [bare]: { mcpServers: { plutos: { command: 'node', args: ['x'] } } } } });
        assert.deepEqual(claudeOwnEntry(bare), { id: 'claude-code-local', usable: true, reason: null });
        assert.equal(spawnSync(process.execPath, [path.join(root, 'cli.mjs'), 'status', bare], { encoding: 'utf8', env: process.env }).status, 0);
        setClaudeJson({ projects: { [bare]: { mcpServers: { plutos: {} }, disabledMcpServers: ['plutos'] } } });
        assert.equal(pluginServerMode(bare), 'active', 'switched off in Claude: the plugin serves');
        setClaudeJson({ mcpServers: { plutos: { command: 'node', args: ['/anywhere/plutos.mjs'] } } });
        assert.deepEqual(claudeOwnEntry(bare), { id: 'claude-code-user', usable: true, reason: null });
        assert.equal(pluginServerMode(bare), 'standby');
        setClaudeJson({ mcpServers: { plutos: { command: 'node', args: [path.join(kit, '.plutos', 'plutos-launch.mjs')] } } });
        assert.equal(claudeOwnEntry(bare).usable, false, 'a user-scope entry bound to another project does not serve this one');
        assert.equal(pluginServerMode(bare), 'active');
        setClaudeJson({});
    });

    check('the plugin status reads Claude\'s install records: user scope, another project\'s local scope, switched off', () => {
        const records = plugins => {
            fs.mkdirSync(path.join(claudeDir, 'plugins'), { recursive: true });
            fs.writeFileSync(path.join(claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }));
        };
        assert.equal(claudePluginStatus(kit).installed, false);
        records({ 'plutos@plutos': [{ scope: 'local', version: pkg.version, projectPath: plain }] });
        assert.equal(claudePluginStatus(kit).installed, false, 'a local install in another project does not apply');
        records({ 'plutos@plutos': [{ scope: 'local', version: pkg.version, projectPath: kit }] });
        assert.deepEqual(claudePluginStatus(kit), { installed: true, enabled: true, id: 'plutos@plutos', scope: 'local', version: pkg.version });
        records({ 'plutos@plutos': [{ scope: 'user', version: pkg.version }] });
        assert.equal(claudePluginStatus(wired).scope, 'user');
        fs.mkdirSync(path.join(wired, '.claude'), { recursive: true });
        fs.writeFileSync(path.join(wired, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'plutos@plutos': false } }));
        assert.equal(claudePluginStatus(wired).enabled, false);
        fs.rmSync(path.join(wired, '.claude', 'settings.json'));
    });
    const cli = (...args) => spawnSync(process.execPath, [path.join(root, 'cli.mjs'), ...args], { encoding: 'utf8', env: process.env, timeout: 60_000 });
    check('with the plugin on, every Claude Code wiring path writes nothing unless forced: the CLI, the Connect panel and MCP store (wireClient), rebind', () => {
        const fresh = path.join(scratch, 'fresh');
        fs.mkdirSync(fresh);
        initTargetProject(fresh);
        const c = cli('connect', 'claude-code', fresh);
        assert.equal(c.status, 0, c.stderr);
        assert.match(c.stdout, /Claude Code plugin installed \(plutos@plutos, user scope/);
        assert.match(c.stdout, /Nothing written/);
        assert.match(cli('connect', 'claude-code-local', fresh).stdout, /Nothing written/);
        // The dashboard's POST /api/connect and the recommended-MCP store call wireClient.
        for (const id of ['claude-code', 'claude-code-local']) {
            const r = wireClient(id, fresh);
            assert.equal(r.written, false, id);
            assert.equal(r.plugin, true, id);
            assert.match(r.pluginNotice, /Nothing written/, id);
        }
        assert.ok(!fs.existsSync(path.join(fresh, '.mcp.json')));
        assert.ok(!fs.existsSync(localSettings(fresh)));
        const forced = wireClient('claude-code', fresh, { force: true });
        assert.equal(forced.written, true);
        assert.match(forced.pluginNotice, /not yet approved in Claude.*Once you approve that entry in Claude, it serves the project and the plugin's server stands by/);
        assert.ok(fs.existsSync(path.join(fresh, '.mcp.json')));
        assert.ok(wireClient('cursor', fresh).written, 'other clients are not gated');
        // Rebind: a moved project whose .mcp.json names the old folder is not rewritten while the plugin serves it.
        const moved = path.join(scratch, 'moved');
        fs.cpSync(fresh, moved, { recursive: true });
        const mcp = path.join(moved, '.mcp.json');
        const named = { mcpServers: { plutos: { command: 'node', args: [path.join(fresh, '.plutos', 'plutos-launch.mjs')], env: { PLUTOS_PROJECT_ROOT: fresh } } } };
        fs.writeFileSync(mcp, JSON.stringify(named));
        const rb = rebindProject(fresh, moved);
        assert.deepEqual(JSON.parse(fs.readFileSync(mcp, 'utf8')), named, 'rebind wrote nothing into .mcp.json');
        assert.ok(rb.notes.some(n => /Nothing written/.test(n)), rb.notes.join('\n'));
    });
    check('plutos plugin --tidy takes out only PLUT_OS\'s default copies; customised and string-form ones stay and are listed', () => {
        const st = cli('status', wired);
        assert.match(st.stdout, /Plugin: {4}Claude Code plugin installed .*the project's own plutos entry \(claude-code\) is not yet approved in Claude, so the plugin's server is the one that runs/);
        const settings = readJson(localSettings(wired));
        const sub = settings.hooks.SubagentStart[0].hooks[0];
        sub.timeout = 9;
        settings.hooks.SessionEnd[0].hooks[0] = { type: 'command', command: `node "${path.join(root, 'lib', 'session-close.mjs')}"`, timeout: 15 };
        fs.writeFileSync(localSettings(wired), JSON.stringify(settings, null, 2));
        const t = cli('plugin', wired, '--tidy');
        assert.equal(t.status, 0, t.stderr);
        assert.match(t.stdout, /Took the project's own brief hook out/);
        assert.match(t.stdout, /Left the project's own session-close hook in \.claude\/settings\.local\.json \(written as one command string/);
        assert.match(t.stdout, /Left the project's own subagent hook in \.claude\/settings\.local\.json \(its matcher or timeout was changed/);
        assert.match(t.stdout, /\.mcp\.json names plutos/);
        assert.match(runHook('brief', wired).stdout, /^PLUT_OS session brief/, 'the .mcp.json entry stays the owner\'s; the brief is the plugin\'s now');
        assert.equal(pluginHookSkip(wired, 'brief'), null);
        assert.equal(pluginHookSkip(wired, 'session-close'), 'the project runs its own copy');
        assert.equal(pluginHookSkip(wired, 'subagent'), 'the project runs its own copy');
        assert.deepEqual(hooksTurnedOff(wired), []);
    });
} catch (e) {
    console.error(`FAIL: ${e.stack || e.message}`);
    process.exitCode = 1;
} finally {
    fs.rmSync(scratch, { recursive: true, force: true });
}
if (!process.exitCode) console.log(`plugin-test: ${checks} checks passed`);
