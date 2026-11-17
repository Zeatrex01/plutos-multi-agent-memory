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
//
// The one exception (owner decision d-9ca58ad53503, 2026-11-14): a pack may declare MCP servers in
// its skills.json, and `pack on` adds them to the PROJECT's .mcp.json (never ~/.claude.json or any
// other home config), because a pack whose skills call a server was otherwise half-installed and
// each owner hand-wrote the entries. It adds, it never switches or overwrites: an entry of the same
// name stays as it is and is reported as a conflict, and `pack off` removes only the entries the
// activation record (.plutos/packs.json) says it added and that still hash the same; an entry the
// owner edited stays, with a note (applyPackMcp, removePackMcp below; lib/skills.mjs calls them).
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { writeFileAtomic } from './app-data.mjs';

// The launcher stub every project gets in .plutos/ — resolves this machine's PLUT_OS install
// from .plutos/local.json, so the COMMITTED files (.mcp.json, PLUT_OS.bat) reference it by
// relative path and never leak an absolute local path into the project's repo.
export { PLUTOS_STUB } from './project-marker.mjs';

// Canonical third-party server configs, the single source for the store and the repair pass.
// Package names were duplicated across two modules before, which is how projects ended up
// wired to npm packages that don't exist. The two packs in packs/ declare the same commands in
// their skills.json (tools/skills-test.mjs holds them equal); `pack` on a RECOMMENDED_MCPS entry
// names that pack, which also places a skill saying when to use the server. The plutos entry itself is built in one place,
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
        desc: "PLUT_OS's own server: the shared board, session memory and owner questions for the AIs on this project. Wire it per AI tool with node cli.mjs connect <client>.",
        // No docs link and no config: the card links to Connect, where lib/connect.mjs writes the
        // entry for the chosen client.
        link: null
    },
    {
        name: "Codebase Memory",
        id: "codebase-memory-mcp",
        desc: "Optional external AST/code graph view for codebases. Works in tandem with Graphify for symbol and call-tree analysis. Ships as a PLUT_OS pack with a skill saying when to use it: plutos pack add codebase-memory, then plutos pack on codebase-memory.",
        link: "https://github.com/DeusData/codebase-memory-mcp",
        pack: 'codebase-memory',
        config: MCP_CONFIGS['codebase-memory-mcp']
    },
    {
        name: "Context Mode",
        id: "context-mode",
        desc: "Optional external token-optimization layer. PLUT_OS shared sessions and verified context work without it. Ships as a PLUT_OS pack with a skill saying when to use it: plutos pack add context-mode, then plutos pack on context-mode.",
        link: "https://github.com/mksglu/context-mode",
        pack: 'context-mode',
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
    return path.join(process.env.CLAUDE_CONFIG_DIR || process.env.USERPROFILE || process.env.HOME || '', '.claude.json');
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

// --- Pack-declared servers (the one exception in the header) ---------------------------------------
//
// In a pack's skills.json: "mcpServers": { <name>: { command, args?, env?, purpose?, os?: { win32|darwin|linux:
// { command?, args?, env? } } } }. `os` replaces those keys on that platform (python on Windows,
// python3 elsewhere); the entry written is resolved for the machine that runs `pack on`. `purpose`
// is one line for the brief and the subagent hook (lib/skills.mjs activePackMcpServers); it is never
// written to .mcp.json.

export const MCP_SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const PACK_MCP_OS = Object.freeze(['win32', 'darwin', 'linux']);
const MAX_PACK_SERVERS = 20;

function stringList(value, what) {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > 100 || !value.every(v => typeof v === 'string' && v.length <= 1000)) throw new Error(`${what} must be a list of strings.`);
    return [...value];
}
function stringMap(value, what) {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${what} must be an object of strings.`);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(k) || typeof v !== 'string' || v.length > 1000) throw new Error(`${what}.${k} must be a string under a variable name.`);
        out[k] = v;
    }
    return out;
}
function launchKeys(value, what, needCommand) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${what} must be an object.`);
    const out = {};
    if (value.command !== undefined || needCommand) {
        if (typeof value.command !== 'string' || !value.command.trim() || value.command.length > 500) throw new Error(`${what}.command must be a non-empty string.`);
        out.command = value.command;
    }
    const args = stringList(value.args, `${what}.args`); if (args) out.args = args;
    const env = stringMap(value.env, `${what}.env`); if (env) out.env = env;
    return out;
}

// A pack's declared servers, checked: { <name>: { command, args?, env?, os? } }; {} when absent.
// Throws on anything malformed, so `pack add` refuses the pack instead of writing half an entry.
export function parsePackMcpServers(value, where = 'mcpServers') {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where} must be an object of server entries.`);
    const names = Object.keys(value);
    if (names.length > MAX_PACK_SERVERS) throw new Error(`${where} declares ${names.length} servers; at most ${MAX_PACK_SERVERS}.`);
    const out = {};
    for (const name of names) {
        if (!MCP_SERVER_NAME_RE.test(name)) throw new Error(`${where}: "${name}" is not a server name (${MCP_SERVER_NAME_RE}).`);
        const decl = value[name];
        const entry = launchKeys(decl, `${where}.${name}`, true);
        if (decl.purpose !== undefined) {
            if (typeof decl.purpose !== 'string' || decl.purpose.length > 200) throw new Error(`${where}.${name}.purpose must be a string of at most 200 characters.`);
            entry.purpose = decl.purpose.trim();
        }
        if (decl.os !== undefined) {
            if (!decl.os || typeof decl.os !== 'object' || Array.isArray(decl.os)) throw new Error(`${where}.${name}.os must be an object keyed by ${PACK_MCP_OS.join(', ')}.`);
            entry.os = {};
            for (const [platform, override] of Object.entries(decl.os)) {
                if (!PACK_MCP_OS.includes(platform)) throw new Error(`${where}.${name}.os: "${platform}" is not one of ${PACK_MCP_OS.join(', ')}.`);
                entry.os[platform] = launchKeys(override, `${where}.${name}.os.${platform}`, false);
            }
        }
        out[name] = entry;
    }
    return out;
}

// The .mcp.json entry for one declared server on `platform`: its `os` keys replace the defaults;
// `purpose` stays out.
export function resolvePackMcpEntry(decl, platform = process.platform) {
    const { os: perOs, purpose, ...base } = decl;
    return { ...base, ...(perOs && perOs[platform] ? perOs[platform] : {}) };
}

// sha256 of the entry with its keys sorted, so a reformatted .mcp.json still matches.
export function mcpEntryHash(entry) {
    const sorted = v => Array.isArray(v) ? v.map(sorted)
        : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])])) : v;
    return createHash('sha256').update(JSON.stringify(sorted(entry))).digest('hex');
}

// The project's .mcp.json, read for a write: { file, config, exists }. A link or a file that is not
// JSON is refused, so nothing is written over what PLUT_OS cannot read.
function readProjectMcpForWrite(projectRoot) {
    const file = localMcpPath(projectRoot);
    let st = null;
    try { st = fs.lstatSync(file); } catch (e) { st = null; }
    if (!st) return { file, config: { mcpServers: {} }, exists: false };
    if (st.isSymbolicLink() || !st.isFile()) throw new Error('.mcp.json is a link or not a file; nothing was changed.');
    let config;
    try { config = readJson(file); } catch (e) { throw new Error(`.mcp.json is not valid JSON (${e.message}); nothing was changed.`); }
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('.mcp.json is not a JSON object; nothing was changed.');
    if (config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers))) {
        throw new Error('.mcp.json "mcpServers" is not an object; nothing was changed.');
    }
    return { file, config, exists: true };
}

// The activation record's MCP part, checked: { servers: { <name>: { sha256 } }, created }.
export function packMcpRecord(value) {
    const servers = {};
    const raw = value && typeof value === 'object' && value.servers && typeof value.servers === 'object' ? value.servers : {};
    for (const [name, entry] of Object.entries(raw)) {
        if (MCP_SERVER_NAME_RE.test(name) && entry && typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.sha256)) servers[name] = { sha256: entry.sha256 };
    }
    return { servers, created: !!(value && value.created === true) };
}

// What `pack on` would do to .mcp.json, checked before anything is written. `recorded` is the
// activation's MCP record from an earlier `pack on` (packMcpRecord). → { commit(), added,
// conflicts, notes }; commit() writes the file (only when something is added) and returns the new
// record.
export function planPackMcp(projectRoot, servers, recorded, { platform = process.platform, packId = '' } = {}) {
    const names = Object.keys(servers || {});
    const prior = packMcpRecord(recorded);
    const record = { servers: { ...prior.servers }, created: prior.created };
    if (!names.length && !Object.keys(record.servers).length) return { added: [], conflicts: [], notes: [], commit: () => record };
    const { file, config, exists } = readProjectMcpForWrite(projectRoot);
    const current = config.mcpServers || {};
    const legacy = config.disabledMcpServers && typeof config.disabledMcpServers === 'object' ? config.disabledMcpServers : {};
    const added = [], conflicts = [], notes = [];
    const next = { ...current };
    const ownerRemoved = [];
    for (const name of names) {
        if (Object.hasOwn(current, name) || Object.hasOwn(legacy, name)) {
            if (!record.servers[name]) conflicts.push(name);
            continue;   // ours from an earlier run, or somebody else's: left as it is either way
        }
        // Added by an earlier `pack on` and gone from the file since: the owner removed it. Never put
        // back; forgotten, so `pack off` and `pack on` again is the way to have it back.
        if (record.servers[name]) { delete record.servers[name]; ownerRemoved.push(name); continue; }
        const entry = resolvePackMcpEntry(servers[name], platform);
        next[name] = entry;
        record.servers[name] = { sha256: mcpEntryHash(entry) };
        added.push(name);
        if (servers[name].os) notes.push(`.mcp.json mcpServers.${name} holds the ${platform} command; a teammate on another system gets this machine's entry from git.`);
    }
    // A recorded entry the pack no longer declares stays recorded while it is in the file, so
    // `pack off` still removes it; one already gone is forgotten.
    for (const name of Object.keys(record.servers)) if (!names.includes(name) && !Object.hasOwn(current, name)) delete record.servers[name];
    if (ownerRemoved.length) notes.push(`.mcp.json no longer has ${ownerRemoved.join(', ')}, which the pack${packId ? ` "${packId}"` : ''} added earlier; taken as removed on purpose and not added again (pack off, then pack on, to have it back).`);
    if (conflicts.length) notes.push(`.mcp.json already has ${conflicts.join(', ')}, not added by the pack${packId ? ` "${packId}"` : ''}; left as it is, the pack's own entry was not written.`);
    if (added.length) notes.push(`Added to .mcp.json: ${added.join(', ')}. Claude Code asks each person once before it starts a server from this file.`);
    return {
        added, conflicts, notes,
        commit: () => {
            if (added.length) {
                writeFileAtomic(file, JSON.stringify({ ...config, mcpServers: next }, null, 2) + '\n');
                if (!exists) record.created = true;
            }
            return record;
        }
    };
}

// `pack off`: removes each recorded entry whose hash still matches; an edited one stays with a note.
// The file goes too when this pack created it and nothing else is left in it.
export function removePackMcp(projectRoot, recorded) {
    const record = packMcpRecord(recorded);
    const names = Object.keys(record.servers);
    const removed = [], kept = [], notes = [];
    if (!names.length) return { removed, kept, notes };
    let read;
    try { read = readProjectMcpForWrite(projectRoot); } catch (e) {
        notes.push(`${e.message.replace(/; nothing was changed\.$/, '')}: its pack entries (${names.join(', ')}) were left in place.`);
        return { removed, kept: names, notes, unreadable: true };
    }
    const { file, config, exists } = read;
    if (!exists) return { removed, kept, notes };
    const servers = { ...(config.mcpServers || {}) };
    for (const name of names) {
        if (!Object.hasOwn(servers, name)) continue;
        if (mcpEntryHash(servers[name]) === record.servers[name].sha256) { delete servers[name]; removed.push(name); }
        else kept.push(name);
    }
    if (kept.length) notes.push(`.mcp.json ${kept.join(', ')} changed since pack on and stayed; remove by hand if no longer wanted.`);
    if (removed.length) {
        const rest = { ...config, mcpServers: servers };
        if (record.created && !Object.keys(servers).length && Object.keys(rest).length === 1) fs.unlinkSync(file);
        else writeFileAtomic(file, JSON.stringify(rest, null, 2) + '\n');
        notes.push(`Removed from .mcp.json: ${removed.join(', ')}.`);
    }
    return { removed, kept, notes };
}
