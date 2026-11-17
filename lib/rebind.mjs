// `plutos rebind`: a project moved to another folder or repo, and PLUT_OS should follow it.
//
// The launcher stub (.plutos/plutos-launch.mjs) is tracked and comes along with a move; the
// binding does not (field report amongrooms G, 2026-11-14). Some client entries name the project
// by an absolute path (lib/connect.mjs: pathStyle 'absolute', 'cwd', needsProjectEnv), so after
// a move they still start PLUT_OS bound to the old folder. This rewires each of those entries
// that names the old folder, moves the hub registry entry, and copies the shared .plutos/ state
// the new folder lacks. Portable entries (.mcp.json, VS Code, Codex) name no folder and are left
// alone. A client PLUT_OS does not write (writable:false, an existing create-only TOML file)
// gets its exact manual step in `notes` instead.
//
// rebindProject(oldPath, newPath, { dryRun }) → { from, to, changed: [], skipped: [], notes: [], refused? }
// Nothing in the old folder is changed or deleted.
import fs from 'fs';
import path from 'path';
import { CLIENTS, STUB_REL, SERVER_NAME, configEntry, configPath, isWired, snippet, wireClient } from './connect.mjs';
import { PROJECT_ROOT_ENV } from './project-binding.mjs';
import { PLUTOS_STATE } from './kit-history.mjs';
import { getWorkspaces, addWorkspace, removeWorkspace, looksLikePlutosProject } from './workspaces.mjs';

const isWin = () => process.platform === 'win32';
const normal = value => {
    const resolved = path.resolve(value).replace(/[\\/]+$/, '');
    return isWin() ? resolved.toLowerCase() : resolved;
};
const samePath = (a, b) => !!a && !!b && normal(a) === normal(b);
// A path string inside `parent` (or `parent` itself). Literal spelling, no realpath: the old
// folder usually no longer exists.
function within(value, parent) {
    if (typeof value !== 'string' || !value || !path.isAbsolute(value)) return false;
    const child = normal(value), root = normal(parent);
    return child === root || child.startsWith(root + path.sep) || (isWin() && child.startsWith(root + '/'));
}
const quote = value => isWin() ? `"${value}"` : `'${String(value).replace(/'/g, `'\\''`)}'`;

// The plutos entry a client's config holds, raw (JSON object or TOML block text), or null.
function readEntry(client, file, oldPath) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
    if (client.format === 'toml') {
        // Only the plutos tables: another server's paths in the same file are not ours to judge.
        const base = `${client.key}.${SERVER_NAME}`;
        const kept = [];
        let inside = false;
        for (const line of raw.split(/\r?\n/)) {
            const table = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/)?.[1]?.trim();
            if (table !== undefined) inside = table === base || table.startsWith(`${base}.`);
            if (inside) kept.push(line);
        }
        return kept.length ? kept.join('\n') : null;
    }
    let config;
    try { config = JSON.parse(raw); } catch (e) {
        // Zed and VS Code allow comments; read past them, never write such a file here.
        try { config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1')); } catch (e2) { return null; }
    }
    if (client.claudeLocal) {
        const match = Object.entries(config?.projects || {}).find(([root]) => samePath(root, oldPath));
        return match?.[1]?.mcpServers?.[SERVER_NAME] || null;
    }
    return config?.[client.key]?.[SERVER_NAME] || null;
}

// Does this entry name the old folder? JSON: any path value under it. TOML: the old path appears
// in the plutos tables, as written or TOML-escaped.
function namesOld(entry, oldPath) {
    if (typeof entry === 'string') {
        const spellings = [oldPath, JSON.stringify(oldPath).slice(1, -1)];
        return spellings.some(s => entry.includes(s));
    }
    const values = [entry.command, ...(Array.isArray(entry.args) ? entry.args : []), entry.cwd, ...Object.values(entry.env || {})];
    return values.some(value => within(value, oldPath));
}

// The project root an entry names: PLUTOS_PROJECT_ROOT, else cwd, else the folder of an
// absolute launcher arg. Used only to find the old folder when the caller did not name it.
function entryRoot(entry) {
    if (!entry || typeof entry !== 'object') return '';
    if (typeof entry.env?.[PROJECT_ROOT_ENV] === 'string') return entry.env[PROJECT_ROOT_ENV];
    if (typeof entry.cwd === 'string' && path.isAbsolute(entry.cwd)) return entry.cwd;
    const stub = (entry.args || []).find(a => typeof a === 'string' && path.isAbsolute(a) && a.replace(/\\/g, '/').endsWith(STUB_REL));
    return stub ? path.dirname(path.dirname(stub)) : '';
}

// The old folder, read from the project-scoped configs that moved along with the project. Only
// those: a global config can name any other project on this machine.
export function inferOldPath(newPath) {
    const found = new Map();
    for (const client of CLIENTS) {
        if (client.scope !== 'project' || client.format !== 'json') continue;
        const root = entryRoot(readEntry(client, configPath(client, newPath), ''));
        if (root && !samePath(root, newPath)) found.set(normal(root), path.resolve(root));
    }
    return [...found.values()];
}

// A path value under the old folder, moved to the same place under the new one; anything else as is.
function movePaths(value, oldPath, newPath) {
    if (typeof value === 'string') return within(value, oldPath) ? path.join(newPath, path.relative(path.resolve(oldPath), path.resolve(value))) : value;
    if (Array.isArray(value)) return value.map(v => movePaths(v, oldPath, newPath));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, movePaths(v, oldPath, newPath)]));
    return value;
}

// The owner's own keys on a plutos entry (a timeout, an extra env variable, a disabled flag) that
// today's entry does not carry: kept, with any old-folder path moved to the new folder. Extra args
// cannot be placed safely around the launcher arg, so they are named for the owner instead.
// → { entry, carried: [key…], droppedArgs: [arg…] }
export function carryOwnerKeys(oldEntry, fresh, oldPath, newPath) {
    const entry = { ...fresh };
    const carried = [];
    if (!oldEntry || typeof oldEntry !== 'object') return { entry, carried, droppedArgs: [] };
    for (const [key, value] of Object.entries(oldEntry)) {
        if (key === 'env' && value && typeof value === 'object' && !Array.isArray(value)) {
            for (const [name, v] of Object.entries(value)) {
                if (Object.hasOwn(fresh.env || {}, name)) continue;
                entry.env = { ...(entry.env || {}), [name]: movePaths(v, oldPath, newPath) };
                carried.push(`env.${name}`);
            }
        } else if (!Object.hasOwn(fresh, key)) { entry[key] = movePaths(value, oldPath, newPath); carried.push(key); }
    }
    const freshArgs = (fresh.args || []).map(String);
    const droppedArgs = (Array.isArray(oldEntry.args) ? oldEntry.args : [])
        .filter(a => !(typeof a === 'string' && (within(a, oldPath) || a.replace(/\\/g, '/').endsWith(STUB_REL))) && !freshArgs.includes(String(a)));
    return { entry, carried, droppedArgs };
}

// The step for a client PLUT_OS does not write, as exact text.
function manualStep(client, oldPath, newPath, file) {
    if (client.claudeLocal) {
        const add = client.command(configEntry(client, newPath), newPath);
        const remove = fs.existsSync(oldPath) ? ` Then, to drop the stale entry, run from ${oldPath}: claude mcp remove --scope local ${SERVER_NAME}` : '';
        return `${client.name}: PLUT_OS does not edit ~/.claude.json. Run from ${newPath}: ${add}.${remove}`;
    }
    return `${client.name}: ${file} names ${oldPath} and PLUT_OS does not merge TOML. Replace its [${client.key}.${SERVER_NAME}] tables with:\n${snippet(client, newPath)}`;
}

// Copy the shared .plutos/ state (lib/kit-history.mjs PLUTOS_STATE 'shared') the new folder lacks.
// Never overwrites and never deletes: a file the new folder already holds is the newer one.
function copySharedState(oldPath, newPath, dryRun) {
    const copied = [];
    if (!fs.existsSync(path.join(oldPath, '.plutos'))) return copied;
    const machine = PLUTOS_STATE.filter(s => s.share === 'machine').map(s => s.path.replace(/\/$/, ''));
    for (const { path: rel, share } of PLUTOS_STATE) {
        if (share !== 'shared') continue;
        const relPath = rel.replace(/\/$/, '');
        const from = path.join(oldPath, ...relPath.split('/'));
        const to = path.join(newPath, ...relPath.split('/'));
        if (!fs.existsSync(from) || fs.existsSync(to)) continue;
        copied.push(relPath);
        if (dryRun) continue;
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.cpSync(from, to, {
            recursive: true, errorOnExist: false, force: false,
            // A machine path inside a shared folder (research/_cache/) stays behind.
            filter: src => !machine.some(m => within(src, path.join(oldPath, ...m.split('/'))))
        });
    }
    return copied;
}

function moveHubEntry(oldPath, newPath, dryRun) {
    const list = getWorkspaces();
    const oldEntry = list.find(w => samePath(w, oldPath));
    if (!oldEntry) return { skipped: `hub: ${oldPath} is not registered; nothing to move` };
    const newRegistered = list.some(w => samePath(w, newPath));
    if (dryRun) return { changed: `hub: would replace ${oldEntry} with ${newPath}` };
    if (!newRegistered) addWorkspace(newPath);
    removeWorkspace(oldEntry);
    return { changed: `hub: ${oldEntry} replaced with ${newPath}` };
}

export function rebindProject(oldPath, newPath, { dryRun = false } = {}) {
    const to = newPath ? path.resolve(newPath) : '';
    const result = { from: oldPath ? path.resolve(oldPath) : '', to, dryRun: !!dryRun, changed: [], skipped: [], notes: [] };
    const refuse = message => { result.refused = message; result.notes.push(`Refused: ${message}`); return result; };

    if (!to || !fs.existsSync(to) || !fs.statSync(to).isDirectory()) return refuse(`${to || '(no path)'} is not a folder.`);
    if (!fs.existsSync(path.join(to, STUB_REL))) {
        return refuse(looksLikePlutosProject(to)
            ? `${to} has the PLUT_OS kit but no launcher (${STUB_REL}). Run: plutos init ${quote(to)} (it restores the launcher), then rebind again.`
            : `${to} is not a PLUT_OS project. Run: plutos init ${quote(to)} to install the kit there, then rebind again.`);
    }
    if (!result.from) {
        const candidates = inferOldPath(to);
        if (candidates.length !== 1) {
            return refuse(candidates.length
                ? `the project's configs name more than one old folder (${candidates.join(', ')}). Name it: plutos rebind ${quote(to)} --from <old path>`
                : `no client config in ${to} names an old folder. Name it: plutos rebind ${quote(to)} --from <old path>`);
        }
        result.from = candidates[0];
    }
    const from = result.from;
    if (samePath(from, to)) return refuse(`the old and the new path are the same folder (${to}).`);

    for (const client of CLIENTS) {
        const file = configPath(client, to);
        const entry = readEntry(client, file, from);
        if (!entry) continue;
        if (!namesOld(entry, from)) {
            if (client.scope === 'project' && isWired(client, to)) result.skipped.push(`${client.name}: ${file} names no folder; nothing to rewrite`);
            continue;
        }
        const manual = client.writable === false || client.format === 'toml';
        if (manual) { result.notes.push(manualStep(client, from, to, file)); continue; }
        const { entry: merged, carried, droppedArgs } = carryOwnerKeys(entry, configEntry(client, to), from, to);
        const kept = carried.length ? ` (kept your ${carried.join(', ')})` : '';
        const argsNote = droppedArgs.length ? `${client.name}: the plutos entry in ${file} had extra args (${droppedArgs.map(a => JSON.stringify(a)).join(', ')}) that ${dryRun ? 'would be' : 'were'} left out; add them back by hand if you still want them.` : '';
        if (dryRun) { result.changed.push(`${client.name}: would rewrite ${file}${kept}`); if (argsNote) result.notes.push(argsNote); continue; }
        try {
            const wrote = wireClient(client.id, to);
            // PLUT_OS's Claude Code plugin serves the moved project: no entry is rewritten for it.
            if (wrote.plugin) { result.notes.push(`${client.name}: ${file} still names ${from}. ${wrote.pluginNotice}`); continue; }
            if (carried.length) {
                const config = JSON.parse(fs.readFileSync(file, 'utf8'));
                config[client.key][SERVER_NAME] = merged;
                fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', 'utf8');
            }
            result.changed.push(`${client.name}: ${file}${kept}`);
            if (argsNote) result.notes.push(argsNote);
        } catch (e) {
            result.notes.push(`${client.name}: ${e.message} Paste this into ${file} instead:\n${snippet(client, to)}`);
        }
    }

    try {
        const hub = moveHubEntry(from, to, dryRun);
        if (hub.changed) result.changed.push(hub.changed);
        if (hub.skipped) result.skipped.push(hub.skipped);
    } catch (e) {
        result.notes.push(`hub: entry not moved (${e.message}). Add ${to} in the Hub and remove ${from} there.`);
    }

    try {
        const copied = copySharedState(from, to, dryRun);
        if (copied.length) result.changed.push(`${dryRun ? 'would copy' : 'copied'} shared state from ${from}: ${copied.join(', ')}`);
    } catch (e) {
        result.notes.push(`shared state: not copied (${e.message}). Copy the shared files under ${path.join(from, '.plutos')} by hand.`);
    }

    if (result.changed.length && !dryRun) result.notes.push('Restart each AI client (or reload its window) so it starts PLUT_OS from the new folder.');
    if (dryRun) result.notes.push('Dry run: nothing was written.');
    return result;
}
