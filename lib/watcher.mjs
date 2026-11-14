// Watcher setup — turning a running AI into a seat that keeps working the board.
//
// The owner's complaint this closes: opening PLUT_OS and then wiring each AI's watcher by
// hand, every time, for three different tools. One panel, tick the seats, done.
//
// It is deliberately split by what PLUT_OS can actually KNOW, and the split is the design:
//
//   Claude Code — PLUT_OS writes the hook itself, into <project>/.claude/settings.local.json,
//     with the same narrow atomic merge lib/context-automation.mjs uses, so unrelated hooks
//     survive byte-for-byte. We know this format because Context Mode already writes it.
//
//   Everything else (Antigravity, Codex, Cursor, …) — PLUT_OS does not write their watcher yet.
//     Codex documents a Stop hook in the same shape, and PLUT_OS writes one there for the claim
//     check (lib/project-hooks.mjs), but the others' formats are not confirmed, and guessing would
//     write junk into somebody's config. So it writes a board TODO
//     naming the seats, and the AI working the project sets them up. That is not a fallback:
//     it is the rule lib/mcp-requests.mjs already states — PLUT_OS ships itself and does not
//     install other people's software behind the user's back.
//
// What the hook does: on Stop, read the project's BOARD.md (through lib/board.mjs, no dashboard)
// and check whether anything is assigned to this seat. If yes, exit 2 so the CLI feeds the task
// back as the next instruction; if no, exit 0 and let the session end. Three things make it safe
// to leave running — it honours stop_hook_active so it cannot recurse, it exits 0 when the board
// cannot be read rather than holding the session hostage, and it never writes anything.
//
// What it does NOT do: wake an idle seat. Stop fires when a turn ends, so this keeps a
// working seat working; starting one is the owner's shell loop, and deliberately outside
// PLUT_OS — see the standing decision that this is a coordination plane, not a scheduler.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { updateFileAtomically } from './atomic.mjs';
import { applyBoardUpdate, parseBoardEntries } from './board.mjs';
import { boardPathFor } from './roadmap.mjs';
import { observedWorkspaceRoot } from './workspaces.mjs';
import { keepOutOfGit } from './context-automation.mjs';

export const WATCHER_EVENT = 'Stop';
export const WATCHER_MARK = 'plutos-watcher';   // in the FILENAME: the hook records a path, not a body
// The two files a watcher writes, relative to the project. Both name paths on this machine: the
// hook holds the script's absolute path, the script the project root and the board library.
export const WATCHER_FILES = ['.claude/settings.local.json', `.plutos/${WATCHER_MARK}.cjs`];

// Seats PLUT_OS can wire itself vs. seats it must hand to an AI. Ids match lib/connect.mjs so
// the panel can speak the same language as the Connect tab. The native half needs no accessor:
// the panel reads the flag off each seat, and an unused export is a claim nobody checks.
export const WATCHER_SEATS = [
    { id: 'claude-code-local', name: 'Claude Code', native: true },
    { id: 'antigravity', name: 'Google Antigravity', native: false },
    { id: 'codex', name: 'Codex CLI', native: false },
    { id: 'cursor', name: 'Cursor', native: false },
    { id: 'gemini-cli', name: 'Gemini CLI', native: false }
];

// The board parser the hook imports at run time: one parser, not a copy in the script. A bundled
// dashboard runs from the release root, where the shipped lib/ sits beside it.
const here = path.dirname(fileURLToPath(import.meta.url));
export const BOARD_LIB = [path.join(here, 'board.mjs'), path.join(here, 'lib', 'board.mjs')]
    .find(file => fs.existsSync(file)) || path.join(here, 'board.mjs');

export const delegatedSeats = () => WATCHER_SEATS.filter(s => !s.native);

export function watcherScriptPath(projectRoot) {
    return path.join(projectRoot, '.plutos', `${WATCHER_MARK}.cjs`);
}
export function claudeSettingsPath(projectRoot) {
    return path.join(projectRoot, '.claude', 'settings.local.json');
}

// Which board entry, if any, this seat must not stop on. Exported and embedded into the
// generated script by source, so there is ONE definition rather than a copy in a string: the
// tests below exercise exactly the code the hook runs. The alternative — writing it twice and
// asserting the two agree — is how the two halves drift.
export function selectAssignedTask(board, agent) {
    const me = String(agent == null ? '' : agent).trim().toLowerCase();
    if (!me) return null;
    const mine = (Array.isArray(board?.entries) ? board.entries : []).filter(e => e && e.status === 'TODO'
        && String((e.fields && e.fields.Assignee) || e.agent || '').trim().toLowerCase() === me);
    return mine.length ? { task: mine[0], more: mine.length - 1 } : null;
}

// What the AI is told when work is assigned to it: by the Stop hook (fed back as the next
// instruction) and by `plutos wait` (printed for the owner's loop to hand to the AI). Embedded
// into the hook by source, like selectAssignedTask, so both say the same thing.
export function assignedTaskPrompt(agent, picked) {
    const first = picked.task;
    return 'The shared board has work assigned to you (' + agent + '). Do not stop.\n\n'
        + '  ' + first.title + '\n'
        + ((first.fields && first.fields.Task) ? '  ' + first.fields.Task + '\n' : '')
        + (picked.more ? '  (+' + picked.more + ' more waiting)\n' : '')
        + '\nClaim it with board_update status IN_PROGRESS before starting, and close it with DONE\n'
        + 'plus a result when you finish. If you need a decision that is not yours to make, ask\n'
        + 'with plutos_ask rather than guessing. Analysis work writes findings to the board,\n'
        + 'never to source.\n';
}

// Embedded into the standalone hook too. Missing or relative identities are never evidence
// of a match; realpath also prevents a moved symlink from silently changing its project.
function watcherProjectKey(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) return '';
    try {
        const root = fs.realpathSync(value);
        return process.platform === 'win32' ? root.toLowerCase() : root;
    } catch (e) { return ''; }
}

// A script on disk rather than an inline command, and node rather than shell: the first version
// was bash + curl wrapping node, and curl's proxy handling made it silently watch nothing.
//
// It reads BOARD.md itself. It used to ask the dashboard's /api/board and exited 0 whenever no
// dashboard answered, so a seat without the dashboard open was a watcher that watched nothing.
export function watcherScript(agent, projectRoot) {
    if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
        throw new Error('A watcher requires its absolute project root.');
    }
    const root = fs.realpathSync(projectRoot);
    // Where the board can be: the project once the kit is installed, else the observed project's
    // folder under PLUTOS_HOME (lib/workspaces.mjs getCoordinationRoot). The first that holds a
    // board wins at run time, so installing the kit later moves the watcher with it.
    const boardRoots = [...new Set([root, observedWorkspaceRoot(root), observedWorkspaceRoot(path.resolve(projectRoot))])];
    const defaults = JSON.stringify({ agent, projectRoot: root, boardRoots, boardLib: BOARD_LIB }, null, 4);
    return `#!/usr/bin/env node
// PLUT_OS watcher hook (${WATCHER_MARK}) — generated, safe to delete.
//
// Fires when this AI finishes a turn. If the project's board has work assigned to it, exit 2 and
// the CLI feeds the text below back as the next instruction; otherwise exit 0 and let the
// session end. Reads only, writes nothing, and every failure path exits 0 — a watcher must
// never be the reason a session cannot end.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
${watcherProjectKey.toString()}
${boardPathFor.toString()}
${selectAssignedTask.toString()}
${assignedTaskPrompt.toString()}

const DEFAULTS = ${defaults};
const AGENT = process.env.PLUTOS_AGENT || DEFAULTS.agent;
const PROJECT_KEY = watcherProjectKey(DEFAULTS.projectRoot);

const read = () => new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
});

(async () => {
    // Without this the hook re-fires on the turn it just caused. Parsed, not pattern-matched:
    // the flag is a boolean at a known key, and a substring search over JSON is a guess.
    let payload = {};
    try { payload = JSON.parse(await read()); } catch (e) { process.exit(0); }
    if (!PROJECT_KEY || !payload || typeof payload !== 'object' || Array.isArray(payload)) process.exit(0);
    if (payload.stop_hook_active === true) process.exit(0);
    if (payload.cwd != null && watcherProjectKey(payload.cwd) !== PROJECT_KEY) process.exit(0);

    let board;
    try {
        const { parseBoardEntries } = await import(pathToFileURL(DEFAULTS.boardLib).href);
        const roots = Array.isArray(DEFAULTS.boardRoots) ? DEFAULTS.boardRoots : [DEFAULTS.projectRoot];
        const file = roots.map(boardPathFor).find(candidate => fs.existsSync(candidate)) || boardPathFor(DEFAULTS.projectRoot);
        board = { entries: parseBoardEntries(fs.readFileSync(file, 'utf8')) };
    } catch (e) {
        // No board, a moved PLUT_OS, an unreadable file — none of them are this session's problem.
        process.exit(0);
    }

    const picked = selectAssignedTask(board, AGENT);
    if (!picked) process.exit(0);
    process.stderr.write(assignedTaskPrompt(AGENT, picked));
    process.exit(2);
})();
`;
}

function parseSettings(content, file) {
    if (!content || !content.trim()) return {};
    let parsed;
    try { parsed = JSON.parse(content); }
    catch (e) { throw new Error(`${file} is not valid JSON; PLUT_OS left it untouched.`); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${file} is not a JSON object; PLUT_OS left it untouched.`);
    }
    if (parsed.hooks != null && (typeof parsed.hooks !== 'object' || Array.isArray(parsed.hooks))) {
        throw new Error(`${file} has a non-object "hooks" value; PLUT_OS left it untouched.`);
    }
    if (parsed.hooks?.[WATCHER_EVENT] != null && !Array.isArray(parsed.hooks[WATCHER_EVENT])) {
        throw new Error(`${file} has a non-array hooks.${WATCHER_EVENT}; PLUT_OS left it untouched.`);
    }
    return parsed;
}

const isWatcherPath = value => typeof value === 'string'
    && /(?:^|[\\/])plutos-watcher\.(?:sh|cjs)(?=["'\s]|$)/.test(value);
const isOurs = handler => handler?.type === 'command'
    && (isWatcherPath(handler.command) || (Array.isArray(handler.args) && handler.args.some(isWatcherPath)));
const handlerFor = script => ({ type: 'command', command: 'node', args: [script] });

// One pure settings merge for installation and repair previews. Unrelated handlers and
// their group metadata survive; the caller decides when and where these bytes are written.
export function planWatcherSettings(content, script, enabled) {
    const settings = parseSettings(content, 'Claude local settings');
    const hooks = { ...(settings.hooks || {}) };
    const groups = (hooks[WATCHER_EVENT] || []).flatMap(group => {
        if (!Array.isArray(group?.hooks) || !group.hooks.some(isOurs)) return [group];
        const remaining = group.hooks.filter(handler => !isOurs(handler));
        return remaining.length ? [{ ...group, hooks: remaining }] : [];
    });
    if (enabled) groups.push({ matcher: '', hooks: [handlerFor(script)] });
    if (groups.length) hooks[WATCHER_EVENT] = groups; else delete hooks[WATCHER_EVENT];
    const next = { ...settings };
    if (Object.keys(hooks).length) next.hooks = hooks; else delete next.hooks;
    return { content: JSON.stringify(next, null, 2) + '\n', changed: JSON.stringify(settings) !== JSON.stringify(next) };
}

function currentWatcherScript(script, projectRoot) {
    let fd;
    try {
        // Inspect bounded text, never execute an installed script to establish its health.
        fd = fs.openSync(script, 'r');
        const buffer = Buffer.alloc(64 * 1024 + 1);
        const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
        if (length === buffer.length) return false;
        const body = buffer.toString('utf8', 0, length);
        const match = /^const DEFAULTS = (\{[\s\S]*?^\});$/m.exec(body);
        if (!match) return false;
        const defaults = JSON.parse(match[1]);
        if (watcherProjectKey(defaults.projectRoot) !== watcherProjectKey(projectRoot)) return false;
        // Regeneration checks the complete current behavior, not a marker that an obsolete
        // or edited body can retain. The configured seat remains a user choice.
        return body === watcherScript(defaults.agent, projectRoot);
    } catch (e) { return false; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function watcherStatus(projectRoot) {
    try { projectRoot = fs.realpathSync(projectRoot); }
    catch (e) { projectRoot = path.resolve(projectRoot); }
    const file = claudeSettingsPath(projectRoot);
    const script = watcherScriptPath(projectRoot);
    const out = { installed: false, needsUpgrade: false, scriptPath: script, settingsPath: file, error: null };
    if (!fs.existsSync(file)) return out;
    try {
        const settings = parseSettings(fs.readFileSync(file, 'utf8'), file);
        const groups = settings.hooks?.[WATCHER_EVENT];
        const handlers = (groups || []).flatMap(group => Array.isArray(group?.hooks) ? group.hooks : []).filter(isOurs);
        const expected = handlerFor(script);
        out.installed = handlers.length === 1 && handlers[0].command === expected.command
            && JSON.stringify(handlers[0].args) === JSON.stringify(expected.args)
            && currentWatcherScript(script, projectRoot);
        out.needsUpgrade = handlers.length > 0 && !out.installed;
    } catch (e) { out.error = e.message; }
    return out;
}

// `agent` is the roster name this seat answers to — the board is filtered by it, so a wrong
// name here means a watcher that politely does nothing forever.
export function setWatcher(projectRoot, enabled, { agent = 'Claude' } = {}) {
    projectRoot = enabled ? fs.realpathSync(projectRoot) : path.resolve(projectRoot);
    const file = claudeSettingsPath(projectRoot);
    const script = watcherScriptPath(projectRoot);
    const legacyScript = path.join(projectRoot, '.plutos', `${WATCHER_MARK}.sh`);
    const body = enabled ? watcherScript(agent, projectRoot) : '';

    if (!enabled && !fs.existsSync(file)) {
        const changed = fs.existsSync(script) || fs.existsSync(legacyScript);
        fs.rmSync(script, { force: true });
        fs.rmSync(legacyScript, { force: true });
        return { changed, ...watcherStatus(projectRoot) };
    }

    fs.mkdirSync(path.dirname(file), { recursive: true });
    let scriptChanged = false;
    const result = updateFileAtomically(file, (content) => {
        const next = planWatcherSettings(content, script, enabled);
        if (enabled) {
            scriptChanged = !fs.existsSync(script) || fs.readFileSync(script, 'utf8') !== body;
            fs.mkdirSync(path.dirname(script), { recursive: true });
            fs.writeFileSync(script, body, { mode: 0o755 });
            // Node exec form keeps spaces and shell metacharacters literal on every platform.
            // PATH node is deliberate: process.execPath can be the packaged dashboard exe.
        }
        return {
            content: next.content,
            result: { changed: next.changed }
        };
    }, { seed: '{}\n' });
    scriptChanged ||= fs.existsSync(legacyScript) || (!enabled && fs.existsSync(script));
    if (!enabled) fs.rmSync(script, { force: true });
    fs.rmSync(legacyScript, { force: true });

    // Committing either file would hand every collaborator a broken hook pointing at a directory
    // they do not have. The ignore line is not a change to the watcher: a repeat install reports none.
    const { ignored, warning } = enabled ? keepOutOfGit(projectRoot, WATCHER_FILES) : { ignored: false, warning: null };
    return { ...result, changed: result.changed || scriptChanged, ignored, warning, ...watcherStatus(projectRoot) };
}

// The delegated half. PLUT_OS writes the watcher only in Claude Code's hook format so far and will not guess
// the others, so it states the requirement on the board and the AI working the project — which can
// read those tools' docs and adapt — performs the setup. Same rule, same shape, as
// lib/mcp-requests.mjs uses for third-party MCP installs.
//
// One entry for all the requested seats rather than one each: it is a single sitting of work,
// and four near-identical entries is how a board stops being read.
export function requestDelegatedWatchers(projectRoot, ids = [], { agentNames = {} } = {}) {
    const wanted = delegatedSeats().filter(s => ids.includes(s.id));
    if (!wanted.length) return { requested: [], skipped: ids.slice() };

    const file = boardPathFor(projectRoot);
    if (!fs.existsSync(file)) return { requested: [], skipped: ids.slice() };

    const title = 'Set up board watchers for the non-Claude seats';
    const existing = new Set(parseBoardEntries(fs.readFileSync(file, 'utf8')).map(e => e.title.toLowerCase()));
    if (existing.has(title.toLowerCase())) return { requested: [], skipped: ids.slice(), alreadyOnBoard: true };

    const seats = wanted.map(s => `${s.name} (board name: ${agentNames[s.id] || s.name})`).join(', ');
    updateFileAtomically(file, (content) => ({
        content: applyBoardUpdate(content, {
            agent: 'PLUT_OS',
            status: 'TODO',
            title,
            task: `The owner asked for these seats to watch the board: ${seats}. PLUT_OS wired the Claude `
                + `Code seat itself and stopped there, because it writes the watcher only in Claude Code's hook format so far and `
                + `will not guess one into somebody's config. Read \`.plutos/${WATCHER_MARK}.cjs\` — that is the `
                + `working reference: on turn end it reads the project's docs/handoff/BOARD.md for a TODO assigned to that `
                + `seat, exits 2 with the task text if so and 0 otherwise, honours stop_hook_active, and exits `
                + `0 when the board cannot be read or the hook runs in another project. Port these `
                + `behaviours to each tool's own mechanism; where a tool has none, \`plutos wait --seat <board name>\` `
                + `blocks until the board assigns that seat work and prints it, so a shell loop around it and the tool's CLI `
                + `is the equivalent. ASK THE OWNER before writing into any config you did not create. `
                + `Set this entry DONE with what you wired and where.`,
            assignee: 'main AI'
        }).content,
        result: null
    }));
    return { requested: wanted.map(s => s.id), skipped: ids.filter(id => !wanted.some(s => s.id === id)) };
}
