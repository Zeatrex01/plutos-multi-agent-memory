// Opt-in Claude Code lifecycle capture.
//
// The hook is project-private (`.claude/settings.local.json`) and calls the PLUT_OS MCP
// already connected to that exact project. It only enqueues a sidecar job; SessionEnd has a
// tight time budget and must never wait for a model call. Existing settings and unrelated
// hooks are preserved byte-for-byte semantically through a narrow JSON merge.
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { updateFileAtomically } from './atomic.mjs';
import { joinLines } from './lines.mjs';

export const CONTEXT_AUTOMATION_EVENTS = Object.freeze(['PreCompact', 'SessionEnd']);
export const CONTEXT_AUTOMATION_NOTICE =
    'Automatic capture runs `claude -p` with Haiku after compaction/session end. It consumes the Claude CLI\'s configured subscription or API usage; provider plan rules can change.';

function handlerFor(event) {
    const eventExtra = event === 'SessionEnd'
        ? { reason: '${reason}' }
        : { trigger: '${trigger}' };
    return {
        type: 'mcp_tool',
        server: 'plutos',
        tool: 'plutos_capture_session',
        input: {
            session_id: '${session_id}',
            transcript_path: '${transcript_path}',
            cwd: '${cwd}',
            event: '${hook_event_name}',
            ...eventExtra
        },
        timeout: 10,
        statusMessage: 'PLUT_OS is preserving session context…'
    };
}

function isOurs(handler) {
    return handler && handler.type === 'mcp_tool'
        && handler.server === 'plutos'
        && handler.tool === 'plutos_capture_session';
}

function parseSettings(content, file) {
    if (!String(content || '').trim()) return {};
    let parsed;
    try { parsed = JSON.parse(content); }
    catch (e) { throw new Error(`${file} contains invalid JSON; PLUT_OS left it untouched (${e.message}).`); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${file} must contain a JSON object; PLUT_OS left it untouched.`);
    }
    if (parsed.hooks != null && (!parsed.hooks || typeof parsed.hooks !== 'object' || Array.isArray(parsed.hooks))) {
        throw new Error(`${file} has a non-object "hooks" value; PLUT_OS left it untouched.`);
    }
    for (const event of CONTEXT_AUTOMATION_EVENTS) {
        if (parsed.hooks?.[event] != null && !Array.isArray(parsed.hooks[event])) {
            throw new Error(`${file} has a non-array hooks.${event}; PLUT_OS left it untouched.`);
        }
    }
    return parsed;
}

function withoutOurHandlers(groups) {
    const out = [];
    for (const raw of groups || []) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.hooks)) {
            out.push(raw);
            continue;
        }
        const hooks = raw.hooks.filter(handler => !isOurs(handler));
        if (hooks.length) out.push({ ...raw, hooks });
    }
    return out;
}

function hasHandler(settings, event) {
    const expected = handlerFor(event);
    return (settings.hooks?.[event] || []).some(group =>
        Array.isArray(group?.hooks) && group.hooks.some(handler => {
            if (!isOurs(handler) || handler.timeout !== expected.timeout
                || !handler.input || typeof handler.input !== 'object' || Array.isArray(handler.input)) return false;
            const keys = Object.keys(expected.input);
            return Object.keys(handler.input).length === keys.length
                && keys.every(key => handler.input[key] === expected.input[key]);
        }));
}

export function contextAutomationSettingsPath(projectRoot) {
    return path.join(projectRoot, '.claude', 'settings.local.json');
}

export function contextAutomationStatus(projectRoot) {
    const file = contextAutomationSettingsPath(projectRoot);
    if (!fs.existsSync(file)) {
        return { enabled: false, complete: false, path: file, error: null, events: {} };
    }
    try {
        const settings = parseSettings(fs.readFileSync(file, 'utf8'), file);
        const events = Object.fromEntries(CONTEXT_AUTOMATION_EVENTS.map(event => [event, hasHandler(settings, event)]));
        return {
            enabled: CONTEXT_AUTOMATION_EVENTS.every(event => events[event]),
            complete: CONTEXT_AUTOMATION_EVENTS.every(event => events[event]),
            path: file,
            error: null,
            events
        };
    } catch (e) {
        return { enabled: false, complete: false, path: file, error: e.message, events: {} };
    }
}

// Every writer that puts paths on this machine into a project file keeps that file out of git
// here: this hook file, the watcher's hook and script (lib/watcher.mjs, and Repair), the Codex
// claim check, and the Cursor, Gemini CLI and Antigravity MCP configs (lib/connect.mjs). A file
// is ignored by its exact path, never a folder pattern: `.agents/` and `.gemini/` also hold files
// a team commits.

/** `.gitignore` text with each entry on a line of its own, or null when all are there already.
 *  Pure, so a Repair preview plans the same edit the writers make. */
export function withIgnoreLines(content, entries) {
    const lines = content ? content.split(/\r?\n/) : [];
    const missing = entries.filter(entry => !lines.some(line => line.trim() === entry));
    if (!missing.length) return null;
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push(...missing, '');
    return joinLines(lines, content);
}

// `entry` is one project-relative path or a list of them.
export function ensureLocalSettingsIgnored(projectRoot, entry = '.claude/settings.local.json') {
    if (!fs.existsSync(path.join(projectRoot, '.git'))) return false;
    const file = path.join(projectRoot, '.gitignore');
    return updateFileAtomically(file, (content) => {
        const next = withIgnoreLines(content, [].concat(entry));
        return next === null ? { content, result: false } : { content: next, result: true };
    }, { seed: '' });
}

/** An ignore line does not untrack a file git already has, and untracking is the owner's call:
 *  once committed, it deletes the file from every teammate's checkout on their next pull. So a
 *  tracked file is reported, never untracked. → the warning, or null (nothing tracked, no repo). */
export function trackedWarning(projectRoot, entries) {
    let listed;
    try {
        listed = execFileSync('git', ['-C', projectRoot, 'ls-files', '-z', '--', ...entries],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).split('\0');
    } catch { return null; /* not a git repository, or no git */ }
    const tracked = entries.filter(entry => listed.includes(entry));
    if (!tracked.length) return null;
    const it = tracked.length > 1 ? 'them' : 'it';
    return `Git already tracks ${tracked.join(' and ')}, so this machine's paths in ${it} would be committed. `
        + `PLUT_OS left ${it} tracked: "git rm --cached ${tracked.join(' ')}" untracks ${it}, which also deletes ${it} for teammates when they pull.`;
}

/** The one call a writer makes after putting this machine's paths into project files.
 *  → { ignored: whether a line was added, warning: string|null } */
export function keepOutOfGit(projectRoot, entries) {
    return { ignored: ensureLocalSettingsIgnored(projectRoot, entries), warning: trackedWarning(projectRoot, entries) };
}

export function setContextAutomation(projectRoot, enabled) {
    if (typeof enabled !== 'boolean') throw new Error('enabled must be true or false.');
    const file = contextAutomationSettingsPath(projectRoot);
    if (!enabled && !fs.existsSync(file)) {
        return { changed: false, ...contextAutomationStatus(projectRoot), ignored: false, notice: CONTEXT_AUTOMATION_NOTICE };
    }
    const result = updateFileAtomically(file, (content) => {
        const settings = parseSettings(content, file);
        const hooks = { ...(settings.hooks || {}) };
        for (const event of CONTEXT_AUTOMATION_EVENTS) {
            const groups = withoutOurHandlers(hooks[event]);
            if (enabled) groups.push({ hooks: [handlerFor(event)] });
            if (groups.length) hooks[event] = groups;
            else delete hooks[event];
        }
        const next = { ...settings };
        if (Object.keys(hooks).length) next.hooks = hooks;
        else delete next.hooks;
        return {
            content: JSON.stringify(next, null, 2) + '\n',
            result: { changed: JSON.stringify(settings) !== JSON.stringify(next) }
        };
    }, { seed: '{}\n' });

    const ignored = enabled ? ensureLocalSettingsIgnored(projectRoot) : false;
    return {
        ...result,
        ...contextAutomationStatus(projectRoot),
        ignored,
        notice: CONTEXT_AUTOMATION_NOTICE
    };
}
