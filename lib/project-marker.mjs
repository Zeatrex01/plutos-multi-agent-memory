// Is this folder a PLUT_OS project? The one answer the MCP server's write guard, the dashboard and
// the Claude Code plugin's hooks share. Node built-ins only and no load-time work: the plugin's
// hooks (lib/plugin-hook.mjs) ask it in every folder Claude Code opens, so a folder that is not a
// project must cost one short check and leave no trace (lib/workspaces.mjs bootstraps the data
// folder when it loads).
import fs from 'node:fs';
import path from 'node:path';

// The launcher stub every project gets in .plutos/ (lib/workspaces.mjs launcherStub).
export const PLUTOS_STUB = 'plutos-launch.mjs';

// Content markers that distinguish PLUT_OS's AGENTS.md from a generic Cursor/Claude rules file.
//
// The kit marker is an HTML comment because the previous marker was a slice of the H1 title,
// which made the title load-bearing: an owner who renamed "# AGENTS.md — PLUT_OS Shared
// Communication Rules" to something that suited their project stopped being recognised as a
// PLUT_OS project at all — a duplicate PLUTOS_PROTOCOL.md appeared beside their boards, the
// tool pointers redirected to it, and looksLikePlutosProject() started refusing MCP writes
// into their own repo. A title is prose the owner is entitled to edit; an invisible marker is
// not, and it matches how board templates already stamp themselves (plutos:clean-template).
export const PLUTOS_KIT_MARKER = '<!-- plutos:kit -->';
// Legacy marker, kept for every project kitted before the comment existed. Detection accepts
// either; nothing new is written with this one.
export const PLUTOS_PROJECT_MARKER = 'PLUT_OS Shared Communication Rules';
const KIT_MARKERS = [PLUTOS_KIT_MARKER, PLUTOS_PROJECT_MARKER];

function fileContainsMarker(filePath, marker, maxBytes = 8192) {
    if (!fs.existsSync(filePath)) return false;
    try {
        const fd = fs.openSync(filePath, 'r');
        try {
            const buf = Buffer.alloc(maxBytes);
            const n = fs.readSync(fd, buf, 0, maxBytes, 0);
            return buf.toString('utf8', 0, n).includes(marker);
        } finally {
            fs.closeSync(fd);
        }
    } catch (e) {
        return false;
    }
}

// True when the file carries ANY of our kit markers — the current comment or the legacy title.
export function fileIsOurKit(filePath) {
    return KIT_MARKERS.some(m => fileContainsMarker(filePath, m));
}

// Does this directory look like a PLUT_OS project — i.e. somewhere the coordinator may
// WRITE? The MCP server resolves its root from process.cwd(), which is only correct when
// the client launched it from the project (the per-project stub guarantees that; a global
// registration does not). Mutating tools check this marker and fail loudly instead of
// silently scaffolding boards into whatever directory the client happened to start in.
export function looksLikePlutosProject(root) {
    if (!root || typeof root !== 'string' || !fs.existsSync(root)) return false;
    // Wired by Add Project / repair: the per-project launcher stub is PLUT_OS-specific.
    if (fs.existsSync(path.join(root, '.plutos', PLUTOS_STUB))) return true;
    // Foreign AGENTS.md layout: init writes the compact protocol next to the boards.
    if (fs.existsSync(path.join(root, 'docs', 'handoff', 'PLUTOS_PROTOCOL.md'))) return true;
    // Our own rules file — content, not filename. Any other AGENTS.md is not evidence.
    if (fileIsOurKit(path.join(root, 'AGENTS.md'))) return true;
    return false;
}

// The PLUT_OS project a folder belongs to: the folder itself or the nearest one above it where
// looksLikePlutosProject holds, or null. A session opened in a subfolder of a project (Claude Code's
// CLAUDE_PROJECT_DIR is the folder it was started in) is that project's session. The walk stops at
// the first git root, the home folder or the filesystem root, each checked first, so a folder in an
// unrelated repository never binds to a project somewhere above it.
export function findPlutosProject(start, { home = process.env.USERPROFILE || process.env.HOME || '' } = {}) {
    if (!start || typeof start !== 'string') return null;
    let dir = path.resolve(start);
    const homeDir = home ? path.resolve(home) : '';
    for (;;) {
        if (looksLikePlutosProject(dir)) return dir;
        const parent = path.dirname(dir);
        if (parent === dir || dir === homeDir || fs.existsSync(path.join(dir, '.git'))) return null;
        dir = parent;
    }
}

// What identifies PLUT_OS's own copy of each project hook (lib/project-hooks.mjs PROJECT_HOOKS) in a
// Claude Code settings file: the script the command runs, by file name, and for the brief its flag.
// One predicate for both readers: the Hooks panel (on/off, status) and the plugin's hooks
// (lib/plugin-hook.mjs: a project that runs its own copy gets no second one).
export const HOOK_SCRIPTS = Object.freeze({
    brief: { scripts: [PLUTOS_STUB, 'index.mjs'], flag: '--brief' },
    guard: { scripts: ['guard.mjs'] },
    'push-gate': { scripts: ['push-gate.mjs'] },
    'claim-check': { scripts: ['claim-check.mjs'] },
    'session-close': { scripts: ['session-close.mjs'] },
    subagent: { scripts: ['subagent-hook.mjs'] },
});

// A command line split into words the way a shell would for plain quoting ("…", '…', bare words).
function commandWords(command) {
    return [...String(command).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
}

/** The words a command hook runs: exec form (`command` plus `args`), or the string form's command line
 *  split into words. `form` says which. null for anything that is not a command hook. */
export function hookWords(handler) {
    if (handler?.type !== 'command' || typeof handler.command !== 'string') return null;
    if (Array.isArray(handler.args)) return { form: 'exec', words: [handler.command, ...handler.args].filter(w => typeof w === 'string') };
    return { form: 'string', words: commandWords(handler.command) };
}

/** Whether a Claude Code hook handler is PLUT_OS's own hook `id`, written either way: one of its
 *  words is the hook's script (by file name) and, for the brief, another is --brief. */
export function isPlutosHook(id, handler) {
    const mark = HOOK_SCRIPTS[id];
    const parsed = mark && hookWords(handler);
    if (!parsed) return false;
    const base = w => w.split(/[\\/]/).pop();
    return parsed.words.some(w => mark.scripts.includes(base(w))) && (!mark.flag || parsed.words.includes(mark.flag));
}
