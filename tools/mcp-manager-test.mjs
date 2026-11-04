#!/usr/bin/env node
// The MCP list (lib/mcps.mjs, read by the setup tier and the recommendations) and the code drawer,
// against temp folders only: a temp HOME
// stands in for ~/.claude.json, Claude Desktop and the clients Connect an AI writes. What Claude
// Code itself does with these files was checked with its CLI on 2026-10-28:
// its per-project switch is
// projects[<path>].disabledMcpServers, a list of names, and it ignores a disabledMcpServers key in
// .mcp.json.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-mcpman-')));
const HOME = path.join(scratch, 'home'), PROJECT = path.join(scratch, 'demo');
fs.mkdirSync(HOME, { recursive: true }); fs.mkdirSync(PROJECT, { recursive: true });
process.env.HOME = HOME; delete process.env.USERPROFILE; delete process.env.APPDATA;
process.env.PLUTOS_HOME = path.join(scratch, 'hub');
const { listMcps, detectTier, RECOMMENDED_MCPS } = await import('../lib/mcps.mjs');
const { listClientMcps, wireClient } = await import('../lib/connect.mjs');
const { codeLookup, usageSummary, CODE_TOOLS } = await import('../lib/code-tools.mjs');
const { DRAWERS, isDrawerOpen } = await import('../lib/drawers.mjs');
const { encodeProjectDir } = await import('../lib/usage.mjs');

let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log(`  ok  ${name}`); };
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2)); };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const find = (name, client) => listMcps(PROJECT).find(m => m.name === name && (!client || m.client === client));

try {
    write(path.join(PROJECT, '.mcp.json'), { mcpServers: { plutos: { command: 'node', args: ['x'] }, team: { command: 'echo' } }, disabledMcpServers: { aside: { command: 'echo' } } });
    write(path.join(HOME, '.claude.json'), {
        mcpServers: { userwide: { command: 'echo' } },
        disabledMcpServers: { stashed: { command: 'npx', args: ['-y', 'stashed'] } },
        projects: { [PROJECT]: { mcpServers: { mine: { command: 'echo' } }, disabledMcpServers: ['team', 'userwide'], enabledMcpjsonServers: ['team'] } }
    });
    const claudeBefore = fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8');

    check('Claude Code\'s per-project switch decides the state', () => {
        assert.equal(find('team').status, 'disabled');
        assert.equal(find('userwide').status, 'disabled');
        assert.equal(find('mine').status, 'active');
    });
    check('a repo server nobody approved yet says so', () => {
        assert.equal(find('plutos').approval, 'pending');
        assert.equal(find('team').approval, undefined);
    });
    check('a Claude Code server says it is switched in Claude Code, and the files stay as they were', () => {
        for (const name of ['mine', 'userwide', 'plutos']) {
            assert.equal(find(name).toggle, 'client');
            assert.match(find(name).hint, /\/mcp/);
        }
        assert.equal(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'), claudeBefore);
        assert.ok(read(path.join(PROJECT, '.mcp.json')).mcpServers.plutos);
    });
    check('what an older PLUT_OS stashed machine-wide comes with the command that restores it', () => {
        const m = find('stashed');
        assert.equal(m.status, 'disabled');
        assert.match(m.hint, /claude mcp add-json -s user stashed '\{"command":"npx","args":\["-y","stashed"\]\}'/);
    });
    check('what an older PLUT_OS moved aside in .mcp.json is listed as off', () => {
        assert.equal(find('aside').status, 'disabled');
        assert.equal(find('aside').legacy, true);
    });
    check('Claude Desktop is found on this platform', () => {
        const desktop = process.platform === 'darwin'
            ? path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
            : path.join(HOME, '.config', 'Claude', 'claude_desktop_config.json');
        if (process.platform === 'win32') return;
        write(desktop, { mcpServers: { chat: { command: 'echo' } } });
        assert.equal(find('chat', 'claude-desktop').status, 'active');
        write(desktop, { mcpServers: {}, disabledMcpServers: { chat: { command: 'echo' } } });
        assert.equal(find('chat', 'claude-desktop').status, 'disabled');
    });
    check('the native tier still counts the Coordinator', () => assert.equal(detectTier(PROJECT).tier, 'full'));
    check('the external Graphify is not recommended', () => assert.ok(!RECOMMENDED_MCPS.some(m => m.id === 'graphify')));

    check('the other clients\' servers are listed, read-only', () => {
        write(path.join(PROJECT, '.cursor', 'mcp.json'), { mcpServers: { plutos: { command: 'node' }, cursorOnly: { command: 'echo' } } });
        write(path.join(PROJECT, '.codex', 'config.toml'), '[mcp_servers.plutos]\ncommand = "node"\n\n[mcp_servers.plutos.env]\nX = "1"\n\n[mcp_servers."two words"]\ncommand = "echo"\n');
        write(path.join(PROJECT, '.vscode', 'mcp.json'), '{\n  // comment\n  "servers": { "vs": { "type": "stdio", "command": "echo" }, },\n}\n');
        const listed = listClientMcps(PROJECT).map(m => `${m.client}:${m.name}:${m.toggle}`).sort();
        assert.deepEqual(listed, ['codex:plutos:client', 'codex:two words:client', 'cursor:cursorOnly:client', 'cursor:plutos:client', 'vscode:vs:client']);
        assert.match(listClientMcps(PROJECT)[0].hint, /own settings/);
    });
    check('Connect keeps a config that names this machine\'s paths out of git, and reports one git already tracks', () => {
        const repo = path.join(scratch, 'wired');
        write(path.join(repo, '.plutos', 'plutos-launch.mjs'), '// launcher\n');
        const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        git('init', '-q');
        const ignoreLines = () => fs.readFileSync(path.join(repo, '.gitignore'), 'utf8').split(/\r?\n/);
        for (const [id, file] of [['cursor', '.cursor/mcp.json'], ['antigravity', '.agents/mcp_config.json']]) {
            const result = wireClient(id, repo);
            assert.equal(result.ignored, true, id);
            assert.equal(result.warning, null, id);
            assert.equal(ignoreLines().filter(line => line === file).length, 1, file);
        }
        assert.equal(wireClient('cursor', repo).ignored, false);
        assert.ok(!ignoreLines().includes('.agents/'), 'an exact path, never the folder');
        for (const id of ['vscode', 'claude-code']) assert.equal(wireClient(id, repo).ignored, false, `${id} writes a portable entry`);
        assert.ok(!ignoreLines().some(line => line === '.vscode/mcp.json' || line === '.mcp.json'));
        write(path.join(repo, '.gemini', 'settings.json'), { theme: 'team' });
        git('add', '.gemini/settings.json');
        const gemini = wireClient('gemini-cli', repo);
        assert.match(gemini.warning || '', /git rm --cached \.gemini\/settings\.json/);
        assert.equal(git('ls-files', '.gemini/settings.json').trim(), '.gemini/settings.json', 'left tracked');
        assert.equal(read(path.join(repo, '.gemini', 'settings.json')).theme, 'team');
        assert.ok(ignoreLines().includes('.gemini/settings.json'));
    });

    // The code drawer.
    const CODE = path.join(scratch, 'code');
    write(path.join(CODE, 'lib', 'store.mjs'), "export function saveThing() {}\n");
    write(path.join(CODE, 'lib', 'store-extra.mjs'), "export const extra = 1;\n");
    write(path.join(CODE, 'app.mjs'), "import { saveThing } from './lib/store.mjs';\nexport function main() { saveThing(); }\n");
    check('code lookup finds a declared symbol, what its file uses and what uses it', () => {
        const r = codeLookup(CODE, 'savething');
        assert.equal(r.matches[0].file, 'lib/store.mjs');
        assert.deepEqual(r.matches[0].usedBy, ['app.mjs']);
        assert.deepEqual(codeLookup(CODE, 'main').matches[0].uses, ['lib/store.mjs']);
    });
    check('a path query puts the file itself first', () => assert.equal(codeLookup(CODE, 'lib/store').matches[0].file, 'lib/store.mjs'));
    check('usage counts this project\'s transcripts only', () => {
        const usageLine = tokens => JSON.stringify({ type: 'assistant', message: { model: 'm', usage: { input_tokens: 1, output_tokens: tokens } } });
        write(path.join(HOME, '.claude', 'projects', encodeProjectDir(PROJECT), 's1.jsonl'), usageLine(1200) + '\n');
        write(path.join(HOME, '.claude', 'projects', 'someone-else', 's2.jsonl'), usageLine(900000) + '\n');
        const text = usageSummary(PROJECT);
        assert.match(text, /1K output\+thinking/);
        assert.doesNotMatch(text, /900K/);
        assert.match(usageSummary(path.join(scratch, 'nowhere')), /No Claude Code session for this project/);
    });
    check('the code drawer holds both tools and starts closed', () => {
        const drawer = DRAWERS.find(d => d.id === 'code');
        assert.deepEqual(drawer.tools.map(t => t.name), CODE_TOOLS.map(t => t.name));
        assert.match(CODE_TOOLS.find(t => t.name === 'plutos_usage').description, /Claude Code only/);
        assert.equal(isDrawerOpen(PROJECT, 'code'), false);
    });
    console.log(`${checks} MCP manager checks passed.`);
} finally {
    fs.rmSync(scratch, { recursive: true, force: true });
}
