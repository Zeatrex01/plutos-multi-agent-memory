#!/usr/bin/env node
// The Claude Code plugin's MCP server entry (.claude-plugin/plugin.json). A user-scope plugin starts it
// in every folder Claude Code opens, so it decides first, with Node built-ins only and before anything
// else loads, what this folder gets:
//
//   active   a PLUT_OS project (the folder Claude opened, or the nearest one above it up to its git
//            root: lib/project-marker.mjs findPlutosProject) with no usable plutos entry of its own:
//            the environment is set the way the project's launcher stub sets it (project root, data
//            folder: PLUTOS_HOME, then .plutos/local.json plutosHome, then the default) and the full
//            server (index.mjs) loads through lib/launch.mjs.
//   outside  not a PLUT_OS project: one diagnostic tool, plutos_project_info, which says so; no
//            server instructions, so the folder's sessions carry no PLUT_OS text.
//   standby  the project's own plutos entry is usable (lib/claude-plugin.mjs claudeOwnEntry: Claude's
//            local or user scope, or an approved .mcp.json entry whose launcher finds an install):
//            that entry serves it, so this copy offers no tools and no instructions.
//
// outside and standby answer the MCP handshake here (newline-delimited JSON-RPC over stdio), load no
// PLUT_OS module beyond the checks and create no data folder: tools/plugin-test.mjs measures both.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPlutosProject } from './project-marker.mjs';
import { pluginServerMode, plutosHubDir, claudeOwnEntry } from './claude-plugin.mjs';
import { isEntry } from './entry.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..');

// A plugin variable Claude Code left unsubstituted still reads `${…}`: treated as unset.
const given = value => typeof value === 'string' && value.trim() && !value.includes('${') ? value : '';

/** Where the plugin's server is started from, the project it serves (or null) and what it does there. */
export function pluginEntryPlan(env = process.env, cwd = process.cwd()) {
    const start = path.resolve(given(env.PLUTOS_PROJECT_ROOT) || given(env.CLAUDE_PROJECT_DIR) || cwd);
    const root = findPlutosProject(start);
    return { start, root, mode: root ? pluginServerMode(root, { env, openedIn: start }) : 'outside' };
}

const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];
const version = () => { try { return JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8')).version; } catch { return '0.0.0'; } };

const INFO_TOOL = {
    name: 'plutos_project_info',
    description: 'PLUT_OS (Claude Code plugin): this folder is not a PLUT_OS project, so PLUT_OS is off here. Call only if asked about PLUT_OS in this folder.',
    inputSchema: { type: 'object', properties: {}, required: [] },
};

// The handshake for a folder the plugin does not serve: initialize, ping, tools/list and tools/call,
// newline-delimited JSON-RPC as MCP's stdio transport defines it. Notifications get no answer.
function idleServer({ mode, start, root }) {
    const tools = mode === 'outside' ? [INFO_TOOL] : [];
    const info = () => {
        if (mode === 'outside') return { projectRoot: start, safe: false, plugin: 'outside',
            error: `${start} is not a PLUT_OS project (nor is any folder above it up to its git root), so PLUT_OS's project tools are off here.`,
            fix: 'Set the project up from the PLUT_OS dashboard (Projects → Add project) or with node cli.mjs init <folder> in your PLUT_OS folder, then start a new session.' };
        const own = claudeOwnEntry(root, { openedIn: start });
        return { projectRoot: root, safe: true, plugin: 'standby', ownEntry: own?.id || null,
            note: 'This project\'s own plutos MCP entry serves it; the plugin\'s copy stands by.' };
    };
    const answer = msg => {
        const { method, params } = msg;
        if (method === 'initialize') {
            const asked = params?.protocolVersion;
            return { protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
                capabilities: tools.length ? { tools: {} } : {}, serverInfo: { name: 'plutos', version: version() } };
        }
        if (method === 'ping') return {};
        if (method === 'tools/list') return { tools };
        if (method === 'tools/call') {
            const name = params?.name;
            if (name === 'plutos_project_info' && mode === 'outside') return { content: [{ type: 'text', text: JSON.stringify(info(), null, 2) }] };
            const why = mode === 'outside'
                ? `ERROR: ${start} is not a PLUT_OS project, so ${name} is off here.`
                : `ERROR: this project's own plutos MCP entry serves it; the plugin's copy stands by. Call ${name} on that server.`;
            return { content: [{ type: 'text', text: why }], isError: true };
        }
        const err = new Error(`Method not found: ${method}`); err.code = -32601; throw err;
    };
    let buf = '';
    const send = obj => process.stdout.write(JSON.stringify(obj) + '\n');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line) continue;
            let msg;
            try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
            if (msg?.id === undefined || msg.id === null || typeof msg.method !== 'string') continue;
            try { send({ jsonrpc: '2.0', id: msg.id, result: answer(msg) }); }
            catch (e) { send({ jsonrpc: '2.0', id: msg.id, error: { code: e.code || -32603, message: e.message } }); }
        }
    });
    process.stdin.on('end', () => process.exit(0));
}

if (isEntry(import.meta.url)) {
    const plan = pluginEntryPlan();
    if (plan.mode !== 'active') idleServer(plan);
    else {
        // As the launcher stub does (lib/workspaces.mjs launcherStub), with this plugin as the install.
        process.env.PLUTOS_PLUGIN = '1';
        // The project this entry found at or above the folder Claude opened (never a guess: it stops at
        // the git root): Claude's own identity check (lib/project-binding.mjs) compares against it.
        process.env.CLAUDE_PROJECT_DIR = plan.root;
        const hubDir = plutosHubDir(plan.root);
        let local = {};
        try { local = JSON.parse(fs.readFileSync(path.join(plan.root, '.plutos', 'local.json'), 'utf8')) || {}; } catch { /* none */ }
        const { launch } = await import('./launch.mjs');
        await launch({ projectRoot: plan.root, plutosRoot: pluginRoot, hubDir, installFile: path.join(hubDir, 'install.json'), local, argv: [] });
    }
}
