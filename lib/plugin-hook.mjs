#!/usr/bin/env node
// The Claude Code plugin's hooks (.claude-plugin/hooks.json): `node lib/plugin-hook.mjs <id>` for the
// hooks wiring switches on by default (lib/project-hooks.mjs DEFAULT_HOOKS: brief, session-close,
// subagent). A user-scope plugin runs them in every folder Claude Code opens, so each one first asks
// three cheap questions and leaves silently, exit 0, on any no:
//
//   1. Is the folder, or the nearest folder above it up to its git root, a PLUT_OS project?
//      (lib/project-marker.mjs findPlutosProject, built-ins only: nothing loads and nothing is written
//      in any other folder; a session started in a project's subfolder is that project's)
//   2. Does the project run this hook itself? A project wired before the plugin keeps its own hooks in
//      .claude/settings{,.local}.json; the project's own hook wins, so no session gets two briefs. The
//      Hooks panel's predicate decides which handler is PLUT_OS's (lib/project-marker.mjs isPlutosHook).
//   3. Did the owner switch this hook off in the project (`hooksOff` in .plutos/local.json, written by
//      the Hooks panel and `plutos hooks off <id>`)? Then it stays off with the plugin too.
//
// Then it runs the same code the project hook runs: the brief through lib/launch.mjs and index.mjs
// --brief (as the project's launcher does, with the data folder the launcher would use), the others as
// their own scripts. The opt-in hooks (guard, push-gate, claim-check) are not the plugin's: they stay
// switched per project as before.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findPlutosProject, isPlutosHook, looksLikePlutosProject } from './project-marker.mjs';
import { isEntry } from './entry.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..');

// id → the event it answers, as in lib/project-hooks.mjs PROJECT_HOOKS (tools/plugin-test.mjs holds
// the two to each other), and the script it runs.
export const PLUGIN_HOOKS = Object.freeze({
    brief: { event: 'SessionStart' },
    'session-close': { event: 'SessionEnd', script: 'session-close.mjs' },
    subagent: { event: 'SubagentStart', script: 'subagent-hook.mjs' },
});

const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/** Whether the project's own Claude Code settings already run hook `id` (any PLUT_OS copy of it). */
export function projectRunsHook(root, id) {
    const hook = PLUGIN_HOOKS[id];
    if (!hook) return false;
    for (const name of ['settings.local.json', 'settings.json']) {
        const groups = readJson(path.join(root, '.claude', name))?.hooks?.[hook.event];
        if (!Array.isArray(groups)) continue;
        for (const group of groups) {
            for (const handler of Array.isArray(group?.hooks) ? group.hooks : []) if (isPlutosHook(id, handler)) return true;
        }
    }
    return false;
}

/** Whether the owner switched hook `id` off in this project. */
export function hookTurnedOff(root, id) {
    const off = readJson(path.join(root, '.plutos', 'local.json'))?.hooksOff;
    return Array.isArray(off) && off.includes(id);
}

/** Why the plugin's hook `id` does nothing in `root`, or null when it runs. */
export function pluginHookSkip(root, id) {
    if (!PLUGIN_HOOKS[id]) return 'unknown hook';
    if (!root || !looksLikePlutosProject(root)) return 'not a PLUT_OS project';
    if (projectRunsHook(root, id)) return 'the project runs its own copy';
    if (hookTurnedOff(root, id)) return 'switched off in this project';
    return null;
}

/** The project a hook serves: the PLUT_OS project at or above the folder Claude Code opened, or null.
 *  A value Claude did not substitute (it still holds `${`) counts as unset. */
export function hookProjectRoot(env = process.env, cwd = process.cwd()) {
    const dir = env.CLAUDE_PROJECT_DIR && !env.CLAUDE_PROJECT_DIR.includes('${') ? env.CLAUDE_PROJECT_DIR : cwd;
    return findPlutosProject(path.resolve(dir));
}

async function run(id) {
    if (!PLUGIN_HOOKS[id]) return;
    const root = hookProjectRoot();
    if (pluginHookSkip(root, id)) return;
    const env = { ...process.env, PLUTOS_PLUGIN: '1', CLAUDE_PROJECT_DIR: root };
    if (id === 'brief') {
        // The launcher's own hand-over (lib/launch.mjs), with this plugin as the install: it binds
        // the project, then index.mjs --brief prints the brief and exits.
        process.env.PLUTOS_PLUGIN = '1';
        process.env.CLAUDE_PROJECT_DIR = root;
        const { plutosHubDir } = await import('./claude-plugin.mjs');
        const hubDir = plutosHubDir(root);
        const { launch } = await import('./launch.mjs');
        await launch({ projectRoot: root, plutosRoot: pluginRoot, hubDir, installFile: path.join(hubDir, 'install.json'), argv: ['--brief'] });
        return 'launched';
    }
    // stdin (the hook event) passes straight through to the hook's own script, run in the project.
    spawnSync(process.execPath, [path.join(here, PLUGIN_HOOKS[id].script)], { stdio: 'inherit', env, cwd: root, windowsHide: true });
}

if (isEntry(import.meta.url)) {
    const id = process.argv[2];
    // index.mjs --brief reads process.argv for its flag and exits on its own once the brief is out.
    if (id === 'brief') process.argv.push('--brief');
    run(id).then(r => { if (r !== 'launched') process.exit(0); }, () => process.exit(0));
}
