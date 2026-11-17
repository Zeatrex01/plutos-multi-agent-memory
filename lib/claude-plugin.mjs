// PLUT_OS's Claude Code plugin (.claude-plugin/) and Claude Code's own records about a project, read-only
// and with Node built-ins only (the plugin's server entry, lib/plugin-entry.mjs, asks before anything loads):
// - claudePluginStatus: is the plugin installed and on for a project? ~/.claude/plugins/installed_plugins.json
//   lists each install with its scope (a project or local install names its project's path), and the
//   `enabledPlugins` settings, user then project then local, can switch one off.
// - claudeOwnEntry / pluginServerMode: does the project have its own plutos MCP entry that Claude would run,
//   so the plugin's server stands by? (~/.claude.json, the project's .mcp.json and its approval records.)
// - plutosHubDir / stubResolvesInstall: the data folder and the install the project's launcher stub finds.
// CLAUDE_CONFIG_DIR moves ~/.claude and ~/.claude.json, as it does for Claude Code. `plutos status`,
// `plutos connect` and wireClient (lib/connect.mjs pluginGate) say when the plugin already serves a project,
// so the owner does not wire a second PLUT_OS server or brief into it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { looksLikePlutosProject, PLUTOS_STUB } from './project-marker.mjs';
import { defaultPlutosHome } from './home-dir.mjs';

export const PLUGIN_NAME = 'plutos';
// Where the docs and `plutos plugin` install the plugin from: this repository. tools/publish-core.mjs
// REWRITE names the main repository instead in its published copy.
export const PLUGIN_SOURCE = 'Zeatrex01/plutos-multi-agent-memory';
const SERVER = 'plutos';

export const claudeConfigDir = (env = process.env) => env.CLAUDE_CONFIG_DIR || path.join(env.HOME || env.USERPROFILE || os.homedir(), '.claude');

const homeOf = env => env.USERPROFILE || env.HOME || os.homedir() || '';
/** Claude Code's app-state file (MCP servers by scope, per-project approvals): ~/.claude.json, or
 *  $CLAUDE_CONFIG_DIR/.claude.json when that is set, as Claude Code itself reads it. */
export const claudeJsonPath = (env = process.env) => path.join(env.CLAUDE_CONFIG_DIR || homeOf(env), '.claude.json');

const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const same = (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const norm = p => { let r = path.resolve(p); try { r = fs.realpathSync(r); } catch { /* gone */ } return process.platform === 'win32' ? r.toLowerCase() : r; };
    return norm(a) === norm(b);
};

/** The plugin's state for `projectRoot`: { installed, enabled, id, scope, version } (installed: an
 *  install that applies to this project exists; enabled: it is on there), or { installed: false }. */
export function claudePluginStatus(projectRoot, { env = process.env } = {}) {
    const dir = claudeConfigDir(env);
    const plugins = readJson(path.join(dir, 'plugins', 'installed_plugins.json'))?.plugins;
    if (!plugins || typeof plugins !== 'object') return { installed: false };
    const applies = it => it && (it.scope === 'user' || it.scope === 'managed'
        || ((it.scope === 'project' || it.scope === 'local') && same(it.projectPath, projectRoot)));
    let found = null;
    for (const [id, entries] of Object.entries(plugins)) {
        // One entry or a list of them, as lib/skill-inventory.mjs also reads the file.
        const list = Array.isArray(entries) ? entries : [entries];
        if (id.split('@')[0] !== PLUGIN_NAME) continue;
        // The narrowest scope that applies is the one Claude Code uses for this project.
        const order = ['local', 'project', 'user', 'managed'];
        const it = list.filter(applies).sort((a, b) => order.indexOf(a.scope) - order.indexOf(b.scope))[0];
        if (it) { found = { id, scope: it.scope, version: it.version || null }; break; }
    }
    if (!found) return { installed: false };
    // enabledPlugins: the later file wins; an install with no entry anywhere counts as on.
    let enabled = true;
    for (const file of [path.join(dir, 'settings.json'), path.join(projectRoot, '.claude', 'settings.json'), path.join(projectRoot, '.claude', 'settings.local.json')]) {
        const value = readJson(file)?.enabledPlugins?.[found.id];
        if (typeof value === 'boolean') enabled = value;
    }
    return { installed: true, enabled, ...found };
}

// The PLUT_OS data folder a project's launcher stub uses (lib/workspaces.mjs launcherStub): PLUTOS_HOME,
// then .plutos/local.json plutosHome, then the per-user default. Absolute values only.
export function plutosHubDir(projectRoot, env = process.env) {
    const local = (projectRoot && readJson(path.join(projectRoot, '.plutos', 'local.json'))) || {};
    const configured = env.PLUTOS_HOME || local.plutosHome;
    return typeof configured === 'string' && path.isAbsolute(configured) ? configured : defaultPlutosHome({ env, dev: false });
}

// Whether the project's launcher stub finds a PLUT_OS install, as the stub itself looks: install.json's
// appRoot in the data folder, then local.json's plutosRoot, either holding lib/launch.mjs. Read-only.
export function stubResolvesInstall(projectRoot, env = process.env) {
    if (!fs.existsSync(path.join(projectRoot, '.plutos', PLUTOS_STUB))) return false;
    const local = readJson(path.join(projectRoot, '.plutos', 'local.json')) || {};
    const installed = readJson(path.join(plutosHubDir(projectRoot, env), 'install.json')) || {};
    return [installed.appRoot, local.plutosRoot].some(c => typeof c === 'string' && path.isAbsolute(c) && fs.existsSync(path.join(c, 'lib', 'launch.mjs')));
}

// Whether a .mcp.json entry can start: one that runs the project's stub needs the stub to find an
// install; one that runs a file by absolute path needs that file.
function entryResolves(entry, projectRoot, env) {
    const words = [entry?.command, ...(Array.isArray(entry?.args) ? entry.args : [])].filter(w => typeof w === 'string');
    if (words.some(w => w.includes(PLUTOS_STUB))) return stubResolvesInstall(projectRoot, env);
    return words.some(w => path.isAbsolute(w) && /\.m?js$/.test(w) && fs.existsSync(w));
}

// A user-scope entry runs in every project, but one that names a project (its PLUTOS_PROJECT_ROOT, or
// an absolute path to a project's stub) serves only that one. → the other folder, or null.
function boundElsewhere(entry, projectRoot) {
    const named = entry?.env?.PLUTOS_PROJECT_ROOT;
    if (typeof named === 'string' && path.isAbsolute(named) && !same(named, projectRoot)) return named;
    const stub = (Array.isArray(entry?.args) ? entry.args : []).find(a => typeof a === 'string' && path.isAbsolute(a) && a.endsWith(PLUTOS_STUB));
    const project = stub && path.dirname(path.dirname(stub));
    return project && !same(project, projectRoot) ? project : null;
}

/** The project's own Claude Code plutos entry, and whether Claude Code would run it this session:
 *  { id, usable, reason } or null when there is none.
 *  - 'claude-code-local': ~/.claude.json projects[root].mcpServers.plutos (Claude's local scope);
 *  - 'claude-code-user': ~/.claude.json mcpServers.plutos (user scope: Claude runs it in every project);
 *  - 'claude-code': the project's .mcp.json, which Claude runs only once approved (enabledMcpjsonServers
 *    or enableAllProjectMcpServers, in ~/.claude.json's project record or a settings file) and not
 *    rejected (disabledMcpjsonServers), and only if its launcher finds an install.
 *  A local or user entry switched off for the project (projects[root].disabledMcpServers) is not usable.
 *  The plugin's server stands by only beside a usable entry (lib/plugin-entry.mjs). */
export function claudeOwnEntry(projectRoot, { env = process.env, openedIn = projectRoot } = {}) {
    const app = readJson(claudeJsonPath(env)) || {};
    // Claude keys its project record by the folder it was opened in, which can be a subfolder.
    const recordOf = dir => Object.entries(app.projects || {}).find(([p]) => same(p, dir))?.[1];
    const record = recordOf(openedIn) || recordOf(projectRoot) || {};
    const off = Array.isArray(record.disabledMcpServers) && record.disabledMcpServers.includes(SERVER);
    if (record.mcpServers?.[SERVER]) return { id: 'claude-code-local', usable: !off, reason: off ? 'switched off in Claude for this project' : null };
    if (app.mcpServers?.[SERVER]) {
        const other = boundElsewhere(app.mcpServers[SERVER], projectRoot);
        if (other) return { id: 'claude-code-user', usable: false, reason: `bound to another folder (${other})` };
        return { id: 'claude-code-user', usable: !off, reason: off ? 'switched off in Claude for this project' : null };
    }
    const entry = readJson(path.join(projectRoot, '.mcp.json'))?.mcpServers?.[SERVER];
    if (!entry) return null;
    // Approval, as Claude Code records it: the project's record in .claude.json, and the same keys in
    // the user, project and local settings files.
    const sources = [record, readJson(path.join(claudeConfigDir(env), 'settings.json')),
        readJson(path.join(projectRoot, '.claude', 'settings.json')), readJson(path.join(projectRoot, '.claude', 'settings.local.json'))].filter(Boolean);
    const listed = key => sources.some(s => Array.isArray(s[key]) && s[key].includes(SERVER));
    if (listed('disabledMcpjsonServers')) return { id: 'claude-code', usable: false, reason: 'declined in Claude' };
    if (!listed('enabledMcpjsonServers') && !sources.some(s => s.enableAllProjectMcpServers === true)) return { id: 'claude-code', usable: false, reason: 'not yet approved in Claude' };
    if (!entryResolves(entry, projectRoot, env)) return { id: 'claude-code', usable: false, reason: 'its launcher finds no PLUT_OS install on this machine' };
    return { id: 'claude-code', usable: true, reason: null };
}

/** What the plugin's MCP server does for a project root: 'outside' (not a PLUT_OS project), 'standby'
 *  (the project's own entry serves it) or 'active'. */
export function pluginServerMode(projectRoot, { env = process.env, openedIn = projectRoot } = {}) {
    if (!looksLikePlutosProject(projectRoot)) return 'outside';
    return claudeOwnEntry(projectRoot, { env, openedIn })?.usable ? 'standby' : 'active';
}

/** One line for the owner, or null when the plugin is not installed for this project. `ownEntry` is
 *  claudeOwnEntry's answer for the project. */
export function claudePluginLine(projectRoot, { env = process.env, ownEntry = null } = {}) {
    const st = claudePluginStatus(projectRoot, { env });
    if (!st.installed) return null;
    const head = `Claude Code plugin installed (${st.id}, ${st.scope} scope${st.version ? `, v${st.version}` : ''}${st.enabled ? '' : ', disabled here'})`;
    if (!st.enabled) return `${head}.`;
    if (ownEntry && !ownEntry.usable) return `${head}: it serves this project; the project's own plutos entry (${ownEntry.id}) is ${ownEntry.reason}, so the plugin's server is the one that runs`
        + (ownEntry.reason === 'not yet approved in Claude' ? '. Once you approve that entry in Claude, it serves the project and the plugin\'s server stands by.' : '.');
    return ownEntry
        ? `${head}; this project also has its own plutos entry (${ownEntry.id}), which serves it while it exists: the plugin's server stands by and its hooks step aside for the project's own. To rely on the plugin alone, remove that entry and the project's hooks: node cli.mjs plugin --tidy.`
        : `${head}: it serves this project's MCP server and default hooks; no project entry is needed.`;
}
