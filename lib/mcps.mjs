// MCP discovery for Claude Code (the project's .mcp.json and ~/.claude.json), Claude Desktop and
// the Antigravity CLI folder; other clients are read by lib/connect.mjs (listClientMcps). The
// setup tier (detectTier) and the recommendations read it; no MCP tool or route switches a server.
//
// PLUT_OS switches nothing itself:
// Claude Code's own switch is a per-project list of names, projects[<path>].disabledMcpServers in
// ~/.claude.json, and PLUT_OS does not edit that mixed app-state file (lib/connect.mjs,
// claude-code-local). Moving an entry out of mcpServers instead turned a user-scope server off in
// every project, and in .mcp.json changed a committed file for every teammate. So a Claude Code
// server is read with its real state, and each entry says where it is switched (hint); PLUT_OS
// itself has no switch for a server.
import fs from 'fs';
import path from 'path';

// The launcher stub every project gets in .plutos/ — resolves this machine's PLUT_OS install
// from .plutos/local.json, so the COMMITTED files (.mcp.json, PLUT_OS.bat) reference it by
// relative path and never leak an absolute local path into the project's repo.
export const PLUTOS_STUB = 'plutos-launch.mjs';

// Canonical third-party server configs, the single source for the store and the repair pass.
// Package names were duplicated across two modules before, which is how projects ended up
// wired to npm packages that don't exist. The plutos entry itself is built in one place,
// lib/connect.mjs configEntry, per client; this module cannot import it (connect imports this).
export const MCP_CONFIGS = {
    'codebase-memory-mcp': { command: 'npx', args: ['-y', 'codebase-memory-mcp'] },
    'context-mode': { command: 'npx', args: ['-y', 'context-mode'] },
    'codeburn': { command: 'npx', args: ['-y', 'codeburn', 'mcp'] }
};

// Docs links shown on installed-MCP cards. Only the MCPs we actually vouch for —
// do NOT grow this into a catalog; the store is RECOMMENDED_MCPS below and stays
// limited to the Coordinator + Codebase Memory + Context Mode + CodeBurn on purpose. The external
// Graphify left on 2026-10-28: PLUT_OS's own code graph (lib/graphify.mjs) does its job locally,
// and the external one needs Python and can send code to an LLM provider.
const MCP_LINKS = {
    "codebase-memory-mcp": "https://github.com/DeusData/codebase-memory-mcp",
    "context-mode": "https://github.com/mksglu/context-mode",
    "codeburn": "https://github.com/getagentseal/codeburn"
};

export const RECOMMENDED_MCPS = [
    {
        name: "PLUT_OS Coordinator",
        id: "plutos",
        desc: "PLUT_OS's own server: the shared board, session memory and owner questions for the AIs on this project. Wire it per AI tool on the Connect panel.",
        // No docs link and no config: the card links to Connect, where lib/connect.mjs writes the
        // entry for the chosen client.
        link: null
    },
    {
        name: "Codebase Memory",
        id: "codebase-memory-mcp",
        desc: "Optional external AST/code graph view for codebases. Works in tandem with Graphify for symbol and call-tree analysis.",
        link: "https://github.com/DeusData/codebase-memory-mcp",
        config: MCP_CONFIGS['codebase-memory-mcp']
    },
    {
        name: "Context Mode",
        id: "context-mode",
        desc: "Optional external token-optimization layer. PLUT_OS shared sessions and verified context work without it.",
        link: "https://github.com/mksglu/context-mode",
        config: MCP_CONFIGS['context-mode']
    },
    {
        name: "CodeBurn Cost & Token Tracker",
        id: "codeburn",
        desc: "Local-first token and cost analytics across Claude Code, Antigravity, Cursor, and Codex sessions.",
        link: "https://github.com/getagentseal/codeburn",
        config: MCP_CONFIGS['codeburn']
    }
];

function localMcpPath(workspacePath) {
    return workspacePath ? path.join(workspacePath, '.mcp.json') : '';
}
function claudeDesktopConfigPath() {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    if (process.platform === 'win32') return process.env.APPDATA ? path.join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json') : '';
    if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    return home ? path.join(home, '.config', 'Claude', 'claude_desktop_config.json') : '';
}
// Claude Code keeps its OWN config, separate from Claude Desktop's: user-scope servers at
// the root, project-scope ones under projects[<absolute path>], plus the approval lists for
// the repo's .mcp.json. Not reading it is what made the tier check report servers as missing
// while the session was actively calling them.
// "Claude Code" here means the agent, not one way of launching it — terminal, the desktop
// app's Code surface and the IDE extensions all read THIS file, while Claude Desktop's chat
// reads claude_desktop_config.json above. Both are checked, so it does not matter which one
// the team uses.
function claudeCodeConfigPath() {
    return path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude.json');
}
function agyMcpDir() {
    return path.join(process.env.USERPROFILE || process.env.HOME || '', '.gemini', 'antigravity-cli', 'mcp');
}

// Project keys in ~/.claude.json are absolute paths with escaped backslashes — match on the
// resolved path, case-insensitively on Windows, never on the raw string.
function samePath(a, b) {
    if (!a || !b) return false;
    const norm = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
    return norm(a) === norm(b);
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// → [{ name, status: 'active'|'disabled', scope: 'local'|'global', client, details, configPath,
//      toggle: 'file'|'client', hint, approval? }]
// configPath is the file the entry was DISCOVERED in. toggle 'file' means the entry sits in a file
// PLUT_OS may write; 'client' means the client owns the switch, and hint says where.
// First writer per client wins: project file > Claude Code project scope > user scope, so the
// nearest definition is the one reported.
export function listMcps(workspacePath) {
    const mcps = [];
    const add = (entry) => {
        if (mcps.find(m => m.name === entry.name && m.client === entry.client)) return;
        mcps.push({ ...entry, details: { ...entry.details, link: MCP_LINKS[entry.name] || '' } });
    };
    const inClaudeCode = name => `Switch it in Claude Code: type /mcp, pick ${name} and choose enable or disable. Claude Code keeps that choice per project.`;

    // Claude Code's config decides what is live: its per-project disabledMcpServers list turns a
    // server of any scope off in this project, and disabledMcpjsonServers holds the repo servers
    // the owner declined at approval.
    let ccConfig = null, ccProject = null;
    const ccPath = claudeCodeConfigPath();
    if (ccPath && fs.existsSync(ccPath)) {
        try {
            ccConfig = readJson(ccPath);
            ccProject = Object.entries(ccConfig.projects || {}).find(([key]) => samePath(key, workspacePath))?.[1] || null;
        } catch (e) { console.error("Claude Code MCP JSON Error", e); }
    }
    const ccOff = new Set([...(Array.isArray(ccProject?.disabledMcpServers) ? ccProject.disabledMcpServers : []),
        ...(ccProject?.disabledMcpjsonServers || [])]);
    const approved = new Set(ccProject?.enabledMcpjsonServers || []);
    const claudeCode = (name, scope, details, configPath, extra = {}) => add({
        name, status: ccOff.has(name) ? 'disabled' : 'active', scope, client: 'claude-code', details, configPath,
        toggle: 'client', hint: inClaudeCode(name), ...extra
    });

    const localPath = localMcpPath(workspacePath);
    if (localPath && fs.existsSync(localPath)) {
        try {
            const config = readJson(localPath);
            for (const [name, details] of Object.entries(config.mcpServers || {})) {
                // Claude Code asks once per person before it starts a server from the repo's file.
                const pending = !ccOff.has(name) && !approved.has(name) && !ccProject?.enableAllProjectMcpServers;
                claudeCode(name, 'local', details, localPath, pending ? { approval: 'pending' } : {});
            }
            // Moved aside by an older PLUT_OS: Claude Code ignores this key, so the server is off
            // for everyone who pulls the file. Repair puts the plutos entry back (lib/repair.mjs).
            for (const [name, details] of Object.entries(config.disabledMcpServers || {})) {
                add({ name, status: 'disabled', scope: 'local', client: 'claude-code', details, configPath: localPath, toggle: 'file', legacy: true });
            }
        } catch (e) { console.error("Local MCP JSON Error", e); }
    }

    if (ccConfig) {
        for (const [name, details] of Object.entries(ccProject?.mcpServers || {})) claudeCode(name, 'local', details, ccPath);
        for (const [name, details] of Object.entries(ccConfig.mcpServers || {})) claudeCode(name, 'global', details, ccPath);
        // Stashed here by an older PLUT_OS, which removed the server from every project. PLUT_OS
        // does not write this file, so the hint is the command that brings it back.
        for (const [name, details] of Object.entries(ccConfig.disabledMcpServers && !Array.isArray(ccConfig.disabledMcpServers) ? ccConfig.disabledMcpServers : {})) {
            add({ name, status: 'disabled', scope: 'global', client: 'claude-code', details, configPath: ccPath, toggle: 'client', legacy: true,
                hint: `An older PLUT_OS turned this off for every project. To bring it back, run: claude mcp add-json -s user ${name} '${JSON.stringify(details)}'` });
        }
    }

    const globalPath = claudeDesktopConfigPath();
    if (globalPath && fs.existsSync(globalPath)) {
        try {
            const globalConfig = readJson(globalPath);
            for (const [name, details] of Object.entries(globalConfig.mcpServers || {})) add({ name, status: 'active', scope: 'global', client: 'claude-desktop', details, configPath: globalPath, toggle: 'file' });
            for (const [name, details] of Object.entries(globalConfig.disabledMcpServers || {})) add({ name, status: 'disabled', scope: 'global', client: 'claude-desktop', details, configPath: globalPath, toggle: 'file' });
        } catch (e) { console.error("Global MCP JSON Error", e); }
    }

    const agyDir = agyMcpDir();
    if (fs.existsSync(agyDir)) {
        try {
            for (const name of fs.readdirSync(agyDir)) {
                // An Antigravity-native server is a directory, not a config entry.
                if (fs.statSync(path.join(agyDir, name)).isDirectory()) {
                    add({ name, status: 'active', scope: 'global', client: 'antigravity', details: { command: "AGY Native MCP" }, configPath: '', toggle: 'client', hint: 'Switch it in Antigravity.' });
                }
            }
        } catch (e) { console.error("AGY MCP Error", e); }
    }

    return mcps;
}

// Recommended MCPs the user hasn't installed anywhere yet. Reads the same source as the MCP
// list so the store and the list can never disagree about what is already installed.
export function recommendedMcps(workspacePath) {
    const installedKeys = new Set(listMcps(workspacePath).map(m => m.name));
    return RECOMMENDED_MCPS.filter(m => !installedKeys.has(m.id));
}

// Server names wired into THIS project's .mcp.json. Distinct from recommendedMcps(), which
// also counts machine-global installs: a server present in Claude Desktop is still missing
// from the project file every other tool and teammate reads.
export function projectMcpKeys(workspacePath) {
    const keys = new Set();
    const localPath = localMcpPath(workspacePath);
    if (!localPath || !fs.existsSync(localPath)) return keys;
    try {
        const c = readJson(localPath);
        Object.keys(c.mcpServers || {}).forEach(k => keys.add(k));
        Object.keys(c.disabledMcpServers || {}).forEach(k => keys.add(k));
    } catch (e) {}
    return keys;
}

// Native PLUT_OS is complete with its own coordinator: board/session sharing, verified
// context, and the generated Codebase Index. Third-party MCPs are extensions, never a hidden
// requirement for the "full" tier. Keeping them out of the core capability check also means
// an npm outage or client-specific plugin choice cannot downgrade PLUT_OS itself.
export const SETUP_TIERS = {
    full: { id: 'full', name: 'PLUT_OS native', mcps: ['plutos'] }
};
export const OPTIONAL_MCP_IDS = ['codebase-memory-mcp', 'context-mode', 'codeburn'];

// → { tier: 'full'|'none', active, disabled, missing, optional }
// Consumes listMcps() rather than re-reading the project .mcp.json: reading only that file
// made every global-scope install invisible, so a full setup was reported as BOARD and every
// session was told to degrade capability it actually had.
export function detectTier(workspacePath) {
    const all = listMcps(workspacePath);
    const active = all.filter(m => m.status === 'active').map(m => m.name);
    const disabled = all.filter(m => m.status === 'disabled').map(m => m.name);
    const missing = SETUP_TIERS.full.mcps.filter(m => !active.includes(m));
    const optional = OPTIONAL_MCP_IDS.filter(m => !active.includes(m));
    const tier = missing.length === 0 ? 'full' : 'none';
    return { tier, active, disabled, missing, optional };
}

export function installRecommendedMcp(workspacePath, id, config) {
    if (!workspacePath) throw new Error("Please select a Workspace (Project) first.");
    const mcpPath = localMcpPath(workspacePath);
    let configObj = { mcpServers: {}, disabledMcpServers: {} };
    if (fs.existsSync(mcpPath)) {
        configObj = readJson(mcpPath);
        configObj.mcpServers = configObj.mcpServers || {};
        configObj.disabledMcpServers = configObj.disabledMcpServers || {};
    }
    configObj.mcpServers[id] = config;
    fs.writeFileSync(mcpPath, JSON.stringify(configObj, null, 2));
}
