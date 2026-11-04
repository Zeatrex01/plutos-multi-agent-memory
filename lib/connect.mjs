// Which AI tools this project is wired to, and how to wire the ones it is not.
//
// PLUT_OS used to write exactly one file — the project's `.mcp.json` — and call the job done.
// That is Claude Code's convention, and only Claude Code's: Cursor reads `.cursor/mcp.json`,
// VS Code reads `.vscode/mcp.json` under a different top-level key, and Codex reads TOML. So
// "I added the project and Cursor cannot find it" was not a bug in Cursor. It
// was PLUT_OS never having written anything Cursor reads.
//
// Every client is described by data, not by a branch, so supporting another editor is adding
// a row.
//
// ── On paths, which is where this gets subtle ────────────────────────────────
// A relative path in `args` only works if the client happens to spawn the server with the
// project as its working directory. **Almost no vendor documents that.** VS Code is the only
// one that states it outright. So each client below declares how it wants to be told where
// the project is, and we use the strongest mechanism that tool actually supports:
//
//   'token'    — the client documents ${workspaceFolder} interpolation (VS Code)
//   'cwd'      — the config has a real cwd field; set it explicitly (Gemini CLI)
//   'absolute' — no project concept at all; the path must be absolute (Windsurf, Desktop, …)
//   'relative' — project-scoped configs whose launcher lives in the repo (Claude Code, Codex)
//
// Getting this wrong means a server that silently never starts, which is indistinguishable
// from "PLUT_OS is broken".
import fs from 'fs';
import path from 'path';
import os from 'os';
import { PLUTOS_STUB } from './mcps.mjs';
import { CODEX_PROJECT_SCOPE_ENV } from './project-binding.mjs';
import { keepOutOfGit } from './context-automation.mjs';

export const STUB_REL = `.plutos/${PLUTOS_STUB}`;
export const SERVER_NAME = 'plutos';

function home() {
    return process.env.USERPROFILE || process.env.HOME || os.homedir() || '';
}

function appData() {
    return process.env.APPDATA || path.join(home(), 'AppData', 'Roaming');
}

function samePath(a, b) {
    if (!a || !b) return false;
    const normalize = (value) => {
        const resolved = path.resolve(value).replace(/[\\/]+$/, '');
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    try { return normalize(a) === normalize(b); } catch (e) { return false; }
}

// The launcher path as this particular client needs to see it.
function serverArg(client, projectRoot) {
    switch (client.pathStyle) {
        case 'token': return `\${workspaceFolder}/${STUB_REL}`;
        case 'claude-project': return `\${CLAUDE_PROJECT_DIR:-.}/${STUB_REL}`;
        case 'absolute': return path.join(projectRoot, STUB_REL);
        default: return STUB_REL;          // 'cwd' and 'relative' both pass the bare path
    }
}

// The config entry for one client: the one builder that init (lib/workspaces.mjs), repair, the
// MCP page and the Connect panel share, so no second copy of the plutos entry can drift.
export function configEntry(client, projectRoot) {
    // Cursor's entry is already machine-specific (absolute project path, no portable
    // workspace token — see the note on its CLIENTS row), so pointing at this machine's
    // node.exe costs nothing extra. It does remove one real source of "connects sometimes,
    // not others": a GUI-launched app's PATH is captured at process start, so a bare "node"
    // command can go stale relative to a Node install/PATH change until the app itself
    // restarts, while an absolute path always resolves.
    const command = client.id === 'cursor' ? process.execPath : 'node';
    const entry = { command, args: [serverArg(client, projectRoot)] };
    // 'cwd' clients pass a relative arg, so the cwd field is what makes it resolve at all.
    if (client.pathStyle === 'cwd') entry.cwd = projectRoot;
    if (client.needsType) entry.type = 'stdio';
    if (client.needsProjectEnv) entry.env = { PLUTOS_PROJECT_ROOT: projectRoot };
    if (client.codexProjectScoped) entry.env = { ...(entry.env || {}), [CODEX_PROJECT_SCOPE_ENV]: '1' };
    return entry;
}

export const CLIENTS = [
    {
        id: 'claude-code-local',
        name: 'Claude Code (private)',
        // Official "local" MCP scope is private to this one project but stored under that
        // project's path in ~/.claude.json. PLUT_OS does not edit Claude's mixed app-state
        // file; the official CLI owns the merge and backups.
        file: () => path.join(home(), '.claude.json'),
        scope: 'local',
        format: 'json',
        key: 'mcpServers',
        pathStyle: 'absolute',
        needsProjectEnv: true,
        claudeLocal: true,
        writable: false,
        command: (entry, projectRoot) =>
            `claude mcp add --transport stdio --scope local --env ${JSON.stringify(`PLUTOS_PROJECT_ROOT=${projectRoot}`)} ${SERVER_NAME} -- node ${JSON.stringify(entry.args[0])}`,
        note: 'Recommended for one person: private to this project, stored by Claude in ~/.claude.json, and leaves no Claude MCP file in the repository.'
    },
    {
        id: 'claude-code',
        name: 'Claude Code (team-shared)',
        file: () => '.mcp.json',
        scope: 'project',
        format: 'json',
        key: 'mcpServers',
        // Claude documents CLAUDE_PROJECT_DIR for stdio servers and ${VAR:-default}
        // expansion in .mcp.json. A bare relative arg instead resolves from wherever Claude
        // was launched, which is not necessarily the repository root.
        pathStyle: 'claude-project',
        note: 'Creates the repository .mcp.json so teammates receive the server too. Claude asks each user to approve project servers.'
    },
    {
        id: 'cursor',
        name: 'Cursor',
        file: () => path.join('.cursor', 'mcp.json'),
        scope: 'project',
        format: 'json',
        key: 'mcpServers',
        // Cursor documents project/global config locations and command/args/env, but its
        // current MCP page does not promise cwd or ${workspaceFolder} expansion. An absolute
        // launcher plus the binding env is the only documented-field combination that does
        // not depend on an unspecified working directory.
        pathStyle: 'absolute',
        needsProjectEnv: true,
        command: () => 'cursor-agent mcp enable plutos',
        deeplink: (entry) =>
            'cursor://anysphere.cursor-deeplink/mcp/install?name=' + encodeURIComponent(SERVER_NAME)
            + '&config=' + encodeURIComponent(Buffer.from(JSON.stringify(entry)).toString('base64')),
        note: 'Cursor uses .cursor/mcp.json. For cursor-agent CLI, run "cursor-agent mcp enable plutos" to approve. In Cursor IDE, reload the window.'
    },
    {
        id: 'vscode',
        name: 'VS Code (Copilot)',
        file: () => path.join('.vscode', 'mcp.json'),
        scope: 'project',
        format: 'json',
        key: 'servers',
        needsType: true,
        pathStyle: 'token',
        command: (entry) => `code --add-mcp "${JSON.stringify({ name: SERVER_NAME, ...entry }).replace(/"/g, '\\"')}"`,
        deeplink: (entry) => 'vscode:mcp/install?' + encodeURIComponent(JSON.stringify({ name: SERVER_NAME, ...entry })),
        note: 'Needs Copilot agent mode. The top-level key is "servers" here, not "mcpServers".'
    },
    {
        id: 'gemini-cli',
        name: 'Gemini CLI',
        file: () => path.join('.gemini', 'settings.json'),
        scope: 'project',
        format: 'json',
        key: 'mcpServers',
        pathStyle: 'cwd',
        command: () => `gemini mcp add ${SERVER_NAME} node ${STUB_REL}`
    },
    {
        id: 'antigravity',
        name: 'Google Antigravity',
        // Antigravity is not Gemini CLI: its documented workspace profile is a dedicated
        // .agents/mcp_config.json file. It supports cwd for stdio servers explicitly.
        file: () => path.join('.agents', 'mcp_config.json'),
        scope: 'project',
        format: 'json',
        key: 'mcpServers',
        pathStyle: 'cwd',
        note: 'Antigravity discovers workspace servers from .agents/mcp_config.json and documents cwd for stdio processes.'
    },
    {
        id: 'codex',
        name: 'Codex CLI',
        // Codex supports trusted-project overrides. Using the user-level file here was the
        // cross-project bug: one global `plutos` entry stayed pinned to whichever repository
        // was connected last and appeared in every other Codex workspace.
        file: () => path.join('.codex', 'config.toml'),
        legacyGlobalFile: () => path.join(home(), '.codex', 'config.toml'),
        scope: 'project',
        format: 'toml',
        key: 'mcp_servers',
        pathStyle: 'relative',
        codexProjectScoped: true,
        // Creating a missing TOML file is safe. Merging an existing one without a TOML parser
        // is not, so wireClient is deliberately create-only for this client.
        writable: 'create-only',
        note: 'Codex is connected per trusted project. A legacy global plutos entry is unsafe; the local entry overrides it only inside this repository.'
    },
    {
        id: 'windsurf',
        name: 'Windsurf',
        file: () => path.join(home(), '.codeium', 'windsurf', 'mcp_config.json'),
        scope: 'global',
        format: 'json',
        key: 'mcpServers',
        // No project-scoped config at all, so every workspace shares this file — a relative
        // path would point at whatever folder Windsurf happens to be in.
        pathStyle: 'absolute',
        note: 'Windsurf has no per-project MCP config, so the path is absolute and names this specific project.'
    },
    {
        id: 'zed',
        name: 'Zed',
        file: () => process.platform === 'win32'
            ? path.join(appData(), 'Zed', 'settings.json')
            : path.join(home(), '.config', 'zed', 'settings.json'),
        scope: 'global',
        format: 'json',
        key: 'context_servers',
        pathStyle: 'absolute',
        note: 'Zed calls them context servers. Its project-level settings file is not documented for this, so PLUT_OS targets the user settings.'
    },
    {
        id: 'claude-desktop',
        name: 'Claude Desktop (chat)',
        file: () => process.platform === 'win32'
            ? path.join(appData(), 'Claude', 'claude_desktop_config.json')
            : process.platform === 'darwin'
                ? path.join(home(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
                : path.join(home(), '.config', 'Claude', 'claude_desktop_config.json'),
        scope: 'global',
        format: 'json',
        key: 'mcpServers',
        pathStyle: 'absolute',
        // Desktop chat never opens a project folder, so the server cannot infer which project
        // it belongs to from anything except this.
        needsProjectEnv: true,
        note: 'Desktop chat never opens a project folder, so it needs PLUTOS_PROJECT_ROOT. The Code surface inside the same app does not.'
    }
];

export function findClient(id) {
    return CLIENTS.find(c => c.id === id) || null;
}

export function configPath(client, projectRoot) {
    const file = client.file();
    return path.isAbsolute(file) ? file : path.join(projectRoot, file);
}

// MCP servers set up in the clients other than Claude Code and Claude Desktop, which lib/mcps.mjs
// reads (and Antigravity's CLI folder). Read-only: each client owns its own switch, so every entry
// says where to change it. Codex's TOML is read for its [mcp_servers.<name>] tables only.
const LISTED_ELSEWHERE = new Set(['claude-code-local', 'claude-code', 'claude-desktop']);
export function listClientMcps(projectRoot) {
    const out = [];
    const seen = new Set();
    const push = (client, name, details, file) => {
        const key = `${client.id}\u0001${name}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ name, status: 'active', scope: client.scope === 'global' ? 'global' : 'local', client: client.id, clientName: client.name,
            details: details && typeof details === 'object' ? { command: details.command || '', args: details.args || [] } : {},
            configPath: file, toggle: 'client', hint: `Switch it in ${client.name}'s own settings.` });
    };
    for (const client of CLIENTS) {
        if (LISTED_ELSEWHERE.has(client.id)) continue;
        const files = [configPath(client, projectRoot || ''), ...(client.legacyGlobalFile ? [client.legacyGlobalFile()] : [])];
        for (const file of files) {
            if (!projectRoot && !path.isAbsolute(client.file())) continue;
            let text;
            try { text = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
            if (client.format === 'toml') {
                for (const m of text.matchAll(/^\s*\[\s*mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*\]/gm)) push(client, m[1] || m[2], {}, file);
                continue;
            }
            let data = null;
            try { data = JSON.parse(text); } catch (e) {
                // Zed and VS Code allow comments in their settings files.
                try { data = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1')); } catch (e2) { continue; }
            }
            for (const [name, details] of Object.entries((data && data[client.key]) || {})) push(client, name, details, file);
        }
    }
    return out;
}

// PLUT_OS may write a config only when it is confident the file belongs to a tool that is
// actually here. Creating ~/.codeium/windsurf/ on a machine with no Windsurf is litter, and
// worse, it makes the panel claim a connection that no tool will ever read.
export function canWrite(client, projectRoot) {
    if (client.writable === false) return false;
    if (client.writable === 'create-only') {
        const file = configPath(client, projectRoot);
        return !fs.existsSync(file) || canRepairCodexBinding(client, file);
    }
    if (client.scope === 'project') return true;
    const file = configPath(client, projectRoot);
    return fs.existsSync(file) || fs.existsSync(path.dirname(file));
}

function tomlServerBlock(raw, client) {
    const base = `${client.key}.${SERVER_NAME}`;
    const lines = String(raw || '').split(/\r?\n/);
    let collecting = false;
    const kept = [];
    for (const line of lines) {
        const match = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
        if (match) {
            const table = match[1].trim();
            if (table === base) collecting = true;
            else if (collecting && !table.startsWith(`${base}.`)) break;
        }
        if (collecting) kept.push(line);
    }
    return kept.join('\n');
}

function configuredEntry(client, file, projectRoot) {
    if (!fs.existsSync(file)) return null;
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
    if (client.claudeLocal) {
        try {
            const config = JSON.parse(raw);
            const match = Object.entries(config.projects || {}).find(([root]) => samePath(root, projectRoot));
            return match?.[1]?.mcpServers?.[SERVER_NAME] || null;
        } catch (e) {
            return null;
        }
    }
    if (client.format === 'toml') {
        const block = tomlServerBlock(raw, client);
        if (!block) return null;
        if (client.codexProjectScoped) {
            if (!new RegExp(`^\\s*${CODEX_PROJECT_SCOPE_ENV}\\s*=\\s*["']1["']\\s*(?:#.*)?$`, 'm').test(block)) return null;
            const cwd = block.match(/^\s*cwd\s*=\s*["']([^"']+)["']/m)?.[1];
            if (cwd && !samePath(cwd, projectRoot)) return null;
        }
        return block;
    }
    try {
        const config = JSON.parse(raw);
        return config && config[client.key] && config[client.key][SERVER_NAME] || null;
    } catch (e) {
        return null;
    }
}

function jsonEntryMatches(actual, expected) {
    if (!actual || typeof actual !== 'object') return false;
    if (actual.command !== expected.command) return false;
    if (JSON.stringify(actual.args || []) !== JSON.stringify(expected.args || [])) return false;
    if (expected.cwd && !samePath(actual.cwd, expected.cwd)) return false;
    for (const [key, value] of Object.entries(expected.env || {})) {
        if (actual.env?.[key] !== value) return false;
    }
    return true;
}

// Does this config already point at PLUT_OS? Read-only and never throws: a config the user is
// midway through hand-editing must not break the panel.
export function isWired(client, projectRoot) {
    const actual = configuredEntry(client, configPath(client, projectRoot), projectRoot);
    if (!actual) return false;
    return client.format === 'toml' || jsonEntryMatches(actual, configEntry(client, projectRoot));
}

// Whether any client's config names a plutos server for this project, however it was written.
// The setup tier reads this (lib/continuity.mjs): lib/mcps.mjs sees Claude's configs only and
// cannot import this module. Loose on purpose, unlike isWired: a stale entry still means the
// owner wired a client, so the brief must not tell that session it has files only.
export function plutosNamedAnywhere(projectRoot) {
    return CLIENTS.some(c => { try { return !!configuredEntry(c, configPath(c, projectRoot), projectRoot); } catch (e) { return false; } });
}

// The exact text to paste when doing it by hand. Rendered from the same entry the writer uses,
// so the manual route cannot drift from what the button produces.
export function snippet(client, projectRoot) {
    const entry = configEntry(client, projectRoot);
    if (client.format === 'toml') {
        const lines = [`[${client.key}.${SERVER_NAME}]`, `command = "${entry.command}"`,
            `args = [${entry.args.map(a => JSON.stringify(a)).join(', ')}]`];
        if (entry.cwd) lines.push(`cwd = ${JSON.stringify(entry.cwd)}`);
        if (entry.env && Object.keys(entry.env).length) {
            lines.push('', `[${client.key}.${SERVER_NAME}.env]`);
            for (const [key, value] of Object.entries(entry.env)) lines.push(`${key} = ${JSON.stringify(value)}`);
        }
        return lines.join('\n');
    }
    return JSON.stringify({ [client.key]: { [SERVER_NAME]: entry } }, null, 2);
}

// A plain-language instruction to paste into the AI's own chat, so it wires itself. This is
// the route that works for tools PLUT_OS may not write to — and for tools not listed here at
// all. The agent already has file access to the project; the path and the exact entry are all
// it needs. Written as an instruction rather than a shell command because the command differs
// per OS and the file edit does not.
export function setupPrompt(client, projectRoot) {
    if (client.claudeLocal) {
        return [
            `Open ${projectRoot} in Claude Code and run this command from that project root:`,
            '',
            client.command(configEntry(client, projectRoot), projectRoot),
            '',
            'This uses Claude Code local MCP scope: private to this project, stored in ~/.claude.json, with no repository MCP file.',
            'Then restart/reload Claude Code and verify the plutos server in /mcp.'
        ].join('\n');
    }
    const file = client.file();
    const where = path.isAbsolute(file)
        ? `${file} (on this machine — create it if it does not exist)`
        : `${file}, relative to this project's root (create the folder and file if they do not exist)`;
    return [
        'Please connect this project to its PLUT_OS coordinator MCP server.',
        '',
        `Edit ${where}.`,
        'Merge the entry below into that file — keep every server already configured there, '
            + 'and change nothing else:',
        '',
        snippet(client, projectRoot),
        '',
        `Then tell me to restart ${client.name} so it picks the server up.`
    ].join('\n');
}

// Existing PLUT_OS versions created a correct project-local Codex block before the
// fail-closed scope marker existed. That exact legacy shape can be upgraded safely without
// parsing or rewriting the rest of the user's TOML: append the missing env subtable. Inline
// env objects remain manual because merging those without a TOML parser would be reckless.
function canRepairCodexBinding(client, file) {
    if (!client.codexProjectScoped || !fs.existsSync(file)) return false;
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return false; }
    const block = tomlServerBlock(raw, client);
    if (!block || new RegExp(`^\\s*${CODEX_PROJECT_SCOPE_ENV}\\s*=`, 'm').test(block)) return false;
    return !/^\s*env\s*=/m.test(block);
}

function repairCodexBinding(client, file) {
    if (!canRepairCodexBinding(client, file)) return false;
    const raw = fs.readFileSync(file, 'utf8');
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const header = `[${client.key}.${SERVER_NAME}.env]`;
    const headerAt = raw.indexOf(header);
    let updated;
    if (headerAt >= 0) {
        const lineEnd = raw.indexOf('\n', headerAt);
        const insertAt = lineEnd < 0 ? raw.length : lineEnd + 1;
        const prefix = lineEnd < 0 ? eol : '';
        updated = raw.slice(0, insertAt) + prefix
            + `${CODEX_PROJECT_SCOPE_ENV} = "1"${eol}` + raw.slice(insertAt);
    } else {
        updated = raw + (raw.endsWith('\n') ? '' : eol) + eol
            + `${header}${eol}${CODEX_PROJECT_SCOPE_ENV} = "1"${eol}`;
    }
    fs.writeFileSync(file, updated, 'utf8');
    return true;
}

function legacyGlobalWarning(client, projectRoot) {
    if (!client.legacyGlobalFile) return null;
    const file = client.legacyGlobalFile();
    if (!file || path.resolve(file) === path.resolve(configPath(client, projectRoot)) || !fs.existsSync(file)) return null;
    try {
        const raw = fs.readFileSync(file, 'utf8');
        if (!tomlServerBlock(raw, client)) return null;
        return `Legacy global PLUT_OS entry detected at ${file}. It can point Codex at the wrong repository outside this project. ` +
            `PLUT_OS will not change it automatically; migrate this project first, then remove or disable the global entry yourself.`;
    } catch (e) {
        return null;
    }
}

// What the Connect panel renders. Everything derived, nothing stored — a config the user edits
// by hand outside PLUT_OS shows up correctly on the next read.
export function connectionPlan(projectRoot, { installed = fs.existsSync(path.join(projectRoot, STUB_REL)) } = {}) {
    return CLIENTS.map(client => {
        const entry = configEntry(client, projectRoot);
        const file = configPath(client, projectRoot);
        const observeWarning = 'Observe-only mode: install the PLUT_OS project kit before connecting an AI. No client config has been changed.';
        return {
            id: client.id,
            name: client.name,
            scope: client.scope,
            format: client.format,
            path: file,
            exists: fs.existsSync(file),
            wired: installed && isWired(client, projectRoot),
            canWrite: installed && canWrite(client, projectRoot),
            snippet: snippet(client, projectRoot),
            // Snippets remain visible as a preview of the exact future config, but every
            // actionable route is withheld until the launcher it references exists.
            prompt: installed ? setupPrompt(client, projectRoot) : observeWarning,
            command: installed && client.command ? client.command(entry, projectRoot) : null,
            deeplink: installed && client.deeplink ? client.deeplink(entry) : null,
            note: client.note || null,
            warning: !installed
                ? observeWarning
                : legacyGlobalWarning(client, projectRoot)
        };
    });
}

// A project config whose entry names this machine's paths (Cursor's node and launcher, the cwd
// of Gemini CLI and Antigravity) would hand every clone a path it does not have, so that exact
// file is kept out of git and a copy git already tracks is reported, not untracked. A portable
// entry (.mcp.json, VS Code, Codex) leaves its file committable.
function keepMachineConfigOutOfGit(client, projectRoot, entry) {
    const values = [entry.command, ...(entry.args || []), entry.cwd, ...Object.values(entry.env || {})];
    if (client.scope !== 'project' || !values.some(value => typeof value === 'string' && path.isAbsolute(value))) {
        return { ignored: false, warning: null };
    }
    return keepOutOfGit(projectRoot, [client.file().split(path.sep).join('/')]);
}

// Write the plutos entry into one client's config, preserving everything else in it.
// → { written: true, path, scope, ignored?, warning? } or throws with a reason the user can act on.
export function wireClient(clientId, projectRoot) {
    const client = findClient(clientId);
    if (!client) throw new Error(`Unknown client: ${clientId}`);
    if (!projectRoot || !fs.existsSync(projectRoot)) throw new Error('Select a project first.');
    if (!fs.existsSync(path.join(projectRoot, STUB_REL))) {
        throw new Error('Install the PLUT_OS project kit first; the project launcher does not exist yet.');
    }
    if (client.writable === false) {
        throw new Error(`PLUT_OS does not write ${client.name}'s config — use the command or the prompt instead.`);
    }
    const file = configPath(client, projectRoot);
    if (client.writable === 'create-only' && fs.existsSync(file)) {
        if (isWired(client, projectRoot)) return { written: false, path: file, scope: client.scope };
        if (repairCodexBinding(client, file)) {
            return { written: true, repaired: true, path: file, scope: client.scope };
        }
        throw new Error(`${file} already exists. PLUT_OS will not merge TOML without a full parser; use the shown prompt/snippet so the existing config is preserved.`);
    }
    if (!canWrite(client, projectRoot)) {
        throw new Error(`${client.name} does not look installed on this machine (${path.dirname(configPath(client, projectRoot))} is missing). Use the prompt instead, or create that folder first.`);
    }

    if (client.format === 'toml') {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, snippet(client, projectRoot) + '\n', 'utf8');
        return { written: true, path: file, scope: client.scope };
    }

    let existing = null;
    if (fs.existsSync(file)) {
        // A config that is not valid JSON must never be silently replaced — that would wipe
        // every other MCP server the user has configured in their editor.
        try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); }
        catch (e) { throw new Error(`${file} is not valid JSON — fix or remove it first, then try again.`); }
    }
    const config = existing && typeof existing === 'object' ? existing : {};
    if (!config[client.key] || typeof config[client.key] !== 'object') config[client.key] = {};
    const entry = config[client.key][SERVER_NAME] = configEntry(client, projectRoot);

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', 'utf8');
    return { written: true, path: file, scope: client.scope, ...keepMachineConfigOutOfGit(client, projectRoot, entry) };
}
