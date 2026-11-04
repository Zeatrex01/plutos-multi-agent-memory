// Project hooks — the Claude Code hooks PLUT_OS can switch on per project, from one place
// (the dashboard's Hooks panel, beside the board watchers). Each is a `command` hook in
// <project>/.claude/settings.local.json, written with the same narrow merge as lib/watcher.mjs:
// the project's own hooks and settings stay as they were, and the file stays out of git because
// it names paths on this machine.
//
//   brief      SessionStart. Hands the session_start brief to Claude as the session opens and
//              again after /clear or a compaction, so no session depends on remembering to call
//              session_start. It runs the project's own launcher with --brief, the same code path
//              as the MCP tool (lib/session-brief.mjs). A command hook, not an mcp_tool one:
//              Claude Code skips mcp_tool hooks at launch, before MCP servers are up.
//   guard      PreToolUse. The owner's standing rules on destructive commands (lib/guard.mjs).
//   push-gate  PreToolUse. "Test, then push" (lib/push-gate.mjs). While it is on and no passing
//              run is recorded, the status says it refuses every push and names the recorder.
//   claim-check  Stop. Holds the final message's claims against git and the disk, and sends a
//              false "done" back once (lib/claim-check.mjs), an unrecorded one included.
//   session-close  SessionEnd. A session that ends with work in git and no session record gets one,
//              written from git, so the close no longer depends on the AI (lib/session-close.mjs).
//
// Codex: only the claim check, whose Stop input and answer are the same in both clients. It goes
// in <project>/.codex/hooks.json (`node lib/claim-check.mjs install --codex`), which Codex runs once
// the owner trusts the project's .codex/ layer and the hook itself in /hooks
// (https://learn.chatgpt.com/docs/hooks). Not from the panel: it shows the Claude Code hooks.
//
// The watcher and the shared-context capture keep their own switches (lib/watcher.mjs on the
// Board tab, lib/context-automation.mjs on Connect); the panel shows their state beside these.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { updateFileAtomically } from './atomic.mjs';
import { ensureLocalSettingsIgnored } from './context-automation.mjs';
import { STUB_REL } from './connect.mjs';
import { missingPass, setGitHook, gitHookOn } from './push-gate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_HOOKS = Object.freeze([
    { id: 'brief', event: 'SessionStart', matcher: 'startup|clear|compact', timeout: 30,
        args: root => [path.join(root, STUB_REL), '--brief'], mark: '--brief' },
    { id: 'guard', event: 'PreToolUse', matcher: 'Bash|PowerShell', timeout: 10,
        args: () => [path.join(here, 'guard.mjs')], mark: 'guard.mjs' },
    { id: 'push-gate', event: 'PreToolUse', matcher: 'Bash|PowerShell', timeout: 15,
        args: () => [path.join(here, 'push-gate.mjs')], mark: 'push-gate.mjs' },
    // Stop takes no matcher: Claude Code ignores one, so none is written.
    { id: 'claim-check', event: 'Stop', timeout: 15,
        args: () => [path.join(here, 'claim-check.mjs')], mark: 'claim-check.mjs' },
    // SessionEnd takes no matcher that matters here: every way a session ends should be closed.
    { id: 'session-close', event: 'SessionEnd', timeout: 15,
        args: () => [path.join(here, 'session-close.mjs')], mark: 'session-close.mjs' },
]);

// Claude Code's own cap on hook text put into context. Past it the text goes to a file and Claude
// sees a 2,000-character preview it is not asked to follow, so the brief is fitted inside instead.
export const HOOK_TEXT_CAP = 10_000;

/** The brief as the SessionStart hook hands it over: inside the cap, with the rules always whole.
 *  When it must be cut, the project context is cut at a paragraph and says so. */
// When the brief is over the cap, whole sections leave in this order, least needed first: what a
// session can look up (current claims, commits git holds, claims to re-check) goes before what it must
// act on (its assigned work, where the last session left off, what is quarantined), which never leaves
// this way. A plain cut from the end used to drop exactly those.
export const HOOK_DROP_ORDER = ['## Source-backed shared context', '## Read on demand', '## Landed since that session',
    '## Shared context to re-check', '## Unverified notes', '## Automatic capture is', '## Setup tier', '## Settled decisions'];

export function hookBrief({ context, rules }) {
    const head = 'PLUT_OS session brief, delivered by the SessionStart hook: you do not need to call session_start for it.\n\n';
    const cut = '\n\n[Cut to fit the 10,000-character hook limit: call session_start for the full brief.]';
    if (head.length + context.length + rules.length <= HOOK_TEXT_CAP) return head + context + rules;
    // Drop whole sections first and name them, so what the session acts on stays.
    let sections = context.split(/\n(?=## )/);
    const dropped = [];
    const size = () => head.length + sections.join('\n').length + rules.length + 200;
    for (const prefix of HOOK_DROP_ORDER) {
        if (size() <= HOOK_TEXT_CAP) break;
        const i = sections.findIndex(sec => sec.startsWith(prefix));
        if (i > 0) { dropped.push(sections[i].split('\n')[0].replace(/^## /, '').replace(/\s*\(.*$/, '').replace(/ —.*$/, '')); sections.splice(i, 1); }
    }
    if (dropped.length) {
        context = sections.join('\n') + `\n\n[Left out to fit the 10,000-character hook limit: ${dropped.join('; ')}. Call session_start for the full brief.]`;
        if (head.length + context.length + rules.length <= HOOK_TEXT_CAP) return head + context + rules;
    }
    const room = Math.max(0, HOOK_TEXT_CAP - head.length - cut.length - rules.length);
    const at = context.lastIndexOf('\n\n', room);
    return head + context.slice(0, at > room / 2 ? at : room) + cut + rules;
}

const settingsPath = root => path.join(root, '.claude', 'settings.local.json');

function hookOf(id) {
    const hook = PROJECT_HOOKS.find(h => h.id === id);
    if (!hook) throw new Error(`Unknown hook "${id}".`);
    return hook;
}

const isOurs = (hook, handler) => handler?.type === 'command' && Array.isArray(handler.args)
    && handler.args.some(a => typeof a === 'string' && (a === hook.mark || a.endsWith(hook.mark)))
    && (hook.id !== 'brief' || handler.args.includes('--brief'));

function parse(content, name = 'settings.local.json') {
    const settings = content && content.trim() ? JSON.parse(content) : {};
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error(`${name} is not a JSON object; PLUT_OS left it untouched.`);
    if (settings.hooks != null && (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) throw new Error(`${name} has a non-object "hooks"; PLUT_OS left it untouched.`);
    return settings;
}

/** The settings with one of our hooks added or removed; everything else is left as it was. */
export function planProjectHook(content, root, id, enabled) {
    const hook = hookOf(id);
    const settings = parse(content);
    const hooks = { ...(settings.hooks || {}) };
    const groups = (Array.isArray(hooks[hook.event]) ? hooks[hook.event] : []).flatMap(group => {
        if (!Array.isArray(group?.hooks) || !group.hooks.some(h => isOurs(hook, h))) return [group];
        const rest = group.hooks.filter(h => !isOurs(hook, h));
        return rest.length ? [{ ...group, hooks: rest }] : [];
    });
    // Exec form with PATH node: spaces in a path stay literal on every platform (as lib/watcher.mjs).
    if (enabled) groups.push({ matcher: hook.matcher, hooks: [{ type: 'command', command: 'node', args: hook.args(root), timeout: hook.timeout }] });
    if (groups.length) hooks[hook.event] = groups; else delete hooks[hook.event];
    const next = { ...settings };
    if (Object.keys(hooks).length) next.hooks = hooks; else delete next.hooks;
    return JSON.stringify(next, null, 2) + '\n';
}

/** The push gate's problem while no passing run is recorded in the project, or null. The recorder
 *  named is the one this install's hook runs. */
function unrecordedPass(root, script) {
    const command = missingPass(root, script);
    if (!command) return null;
    return 'No passing test run is recorded for this project yet, so the push gate refuses every git push of it from the AI tools that run it. '
        + (command === 'npm test' ? 'Running npm test records one.' : `Only a test run through the gate records one: ${command}`);
}

/** Each of our hooks: whether it is on in this project, and anything stopping it from working. */
export function projectHooksStatus(root) {
    const file = settingsPath(root);
    let settings = {};
    let error = null;
    try { if (fs.existsSync(file)) settings = parse(fs.readFileSync(file, 'utf8')); } catch (e) { error = e.message; }
    const hooks = PROJECT_HOOKS.map(hook => {
        const handlers = (settings.hooks?.[hook.event] || []).flatMap(g => Array.isArray(g?.hooks) ? g.hooks : []).filter(h => isOurs(hook, h));
        const on = handlers.length > 0;
        const current = on && JSON.stringify(handlers[0].args) === JSON.stringify(hook.args(root));
        const missing = hook.id === 'brief' && !fs.existsSync(path.join(root, STUB_REL))
            ? 'This project has no PLUT_OS launcher yet; connect it first.'
            : hook.id === 'push-gate' && on ? unrecordedPass(root, hook.args(root)[0]) : null;
        // The push gate's git pre-push half (every client and the terminal): a gate switched on
        // before that half existed reads as needing an update, which installs it.
        const gitHook = hook.id === 'push-gate' ? gitHookOn(root) : undefined;
        return { id: hook.id, event: hook.event, on, needsUpgrade: on && (!current || gitHook === false), problem: missing,
            ...(gitHook !== undefined ? { gitHook } : {}) };
    });
    return { settingsPath: file, error, hooks };
}

const codexHooksPath = root => path.join(root, '.codex', 'hooks.json');
const isOurCodexStop = handler => handler?.type === 'command' && typeof handler.command === 'string' && handler.command.includes('claim-check.mjs');

/** Codex's hooks.json with the claim check added to Stop or removed; everything else is kept.
 *  Codex takes `command` as one string, so the script path is quoted. */
export function planCodexClaimCheck(content, enabled, script = path.join(here, 'claim-check.mjs')) {
    if (script.includes('"')) throw new Error('The PLUT_OS path holds a double quote, which a Codex command cannot quote.');
    const file = parse(content, 'hooks.json');
    const hooks = { ...(file.hooks || {}) };
    const groups = (Array.isArray(hooks.Stop) ? hooks.Stop : []).flatMap(group => {
        if (!Array.isArray(group?.hooks) || !group.hooks.some(isOurCodexStop)) return [group];
        const rest = group.hooks.filter(h => !isOurCodexStop(h));
        return rest.length ? [{ ...group, hooks: rest }] : [];
    });
    // No matcher: Codex does not use one for Stop.
    if (enabled) groups.push({ hooks: [{ type: 'command', command: `node "${script}"`, timeout: 15 }] });
    if (groups.length) hooks.Stop = groups; else delete hooks.Stop;
    const next = { ...file };
    if (Object.keys(hooks).length) next.hooks = hooks; else delete next.hooks;
    return JSON.stringify(next, null, 2) + '\n';
}

/** Whether Codex runs the claim check in this project: read-only, for the Hooks panel. Codex runs a
 *  project hook only once the owner trusts it in /hooks, which PLUT_OS cannot see, so the note says so. */
export function codexClaimCheckStatus(root) {
    const file = codexHooksPath(root);
    let on = false;
    try { on = (parse(fs.readFileSync(file, 'utf8'), 'hooks.json').hooks?.Stop || []).some(g => Array.isArray(g?.hooks) && g.hooks.some(isOurCodexStop)); } catch { /* no file */ }
    return { id: 'claim-check', client: 'codex', on, settingsPath: file, note: 'Codex runs it once you trust it in /hooks.' };
}

/** Switches the claim check on or off for Codex in this project. The file names a path on this
 *  machine, so it is kept out of git; a project that already tracks its own hooks.json is left
 *  alone, because the path would be committed with it. */
export function setCodexClaimCheck(root, enabled) {
    if (typeof enabled !== 'boolean') throw new Error('enabled must be true or false.');
    root = fs.realpathSync(root);
    const file = codexHooksPath(root);
    let tracked = '';
    try {
        tracked = execFileSync('git', ['-C', root, 'ls-files', '--', '.codex/hooks.json'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
    } catch { /* not a git repository */ }
    if (tracked) throw new Error('This project tracks .codex/hooks.json, so PLUT_OS left it untouched: a machine path would be committed. Add the hook by hand.');
    if (enabled || fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        updateFileAtomically(file, content => ({ content: planCodexClaimCheck(content, enabled), result: true }), { seed: '{}\n' });
    }
    if (enabled) ensureLocalSettingsIgnored(root, '.codex/hooks.json');
    return codexClaimCheckStatus(root);
}

export function setProjectHook(root, id, enabled) {
    if (typeof enabled !== 'boolean') throw new Error('enabled must be true or false.');
    root = fs.realpathSync(root);
    // The brief hook runs the project's launcher; without one it would be written and fail at
    // every session start. Refused before any write, with the way to get the launcher.
    if (id === 'brief' && enabled && !fs.existsSync(path.join(root, STUB_REL))) {
        throw new Error(`This project has no PLUT_OS launcher (${STUB_REL}), so the session brief hook was not switched on. Repair the project on the Projects page, which writes the launcher, then switch it on.`);
    }
    const file = settingsPath(root);
    if (enabled || fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        updateFileAtomically(file, content => ({ content: planProjectHook(content, root, id, enabled), result: true }), { seed: '{}\n' });
    }
    if (enabled) ensureLocalSettingsIgnored(root);
    // The push gate also goes in as a git pre-push hook, so a push from any client or terminal
    // meets the same check; outside a git repository there is nothing to install.
    let gitHook = null;
    if (id === 'push-gate') { try { gitHook = setGitHook(root, enabled); } catch { gitHook = null; } }
    const status = projectHooksStatus(root);
    return { ...status.hooks.find(h => h.id === id), settingsPath: status.settingsPath, gitHook };
}
