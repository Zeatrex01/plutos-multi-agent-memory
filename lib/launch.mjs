// What a project's launcher stub (.plutos/plutos-launch.mjs) does once it has found this install.
// The stub keeps only what finding PLUT_OS takes and hands over here, so a change to how PLUT_OS
// starts reaches every project on its next launch without rewriting a file in any of them (owner,
// 2026-09-01: "am I going to repair every project every time? it is supposed to be a central system").
//
// Node built-ins only: the environment below must be set before any other PLUT_OS module loads,
// because those read it when they are imported. tools/launcher-stub-test.mjs holds the variable
// names to lib/project-binding.mjs's.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

export async function launch({ projectRoot, plutosRoot, hubDir, installFile, local = {}, localFile, argv = process.argv.slice(2) }) {
    // Bind to the project that owns the launcher; never inherit a stale cwd or project root.
    process.env.PLUTOS_PROJECT_ROOT = projectRoot;
    process.env.PLUTOS_PROJECT_BOUND_BY_LAUNCHER = '1';
    // Subscription clients must use the store that resolved this install.
    process.env.PLUTOS_HOME = hubDir;
    if (process.env.PLUTOS_CLEAN_HARNESS === undefined && local.cleanHarness === true) process.env.PLUTOS_CLEAN_HARNESS = '1';
    const fail = message => {
        console.error('[PLUT_OS] ' + message);
        console.error('[PLUT_OS] Launch PLUT_OS once so its stable install registry is refreshed: ' + installFile);
        if (localFile) console.error('[PLUT_OS] Project-local fallback: ' + localFile);
        process.exit(1);
    };
    if (argv.includes('--dashboard')) {
        // A checkout runs dashboard.mjs in this process, so its console output stays visible.
        const script = path.join(plutosRoot, 'dashboard.mjs');
        if (fs.existsSync(script)) return import(pathToFileURL(script).href);
        // A lite install (build.mjs --lite) bundles the dashboard as PLUT_OS.cjs for this machine's Node:
        // import it here too. Spawned like the exe, it would fail after this process exits, unseen.
        const lite = path.join(plutosRoot, 'PLUT_OS.cjs');
        if (fs.existsSync(lite)) return import(pathToFileURL(lite).href);
        // The packaged app is a copy of the build machine's node binary: an .exe only on Windows.
        const app = ['PLUT_OS.exe', 'PLUT_OS'].map(name => path.join(plutosRoot, name)).find(file => fs.existsSync(file));
        if (!app) fail('No dashboard.mjs, PLUT_OS.cjs or PLUT_OS app under ' + plutosRoot + '.');
        // Detached, not attached: PLUT_OS.bat's console lives exactly as long as this process, and
        // staying attached kept a dead terminal on screen beside a windowless app.
        spawn(app, { detached: true, stdio: 'ignore' }).unref();
        process.exit(0);
    }
    const server = path.join(plutosRoot, 'index.mjs');
    if (!fs.existsSync(server)) fail('index.mjs not found under ' + plutosRoot + '.');
    return import(pathToFileURL(server).href);
}
