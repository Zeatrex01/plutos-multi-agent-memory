// Development mode: PLUT_OS working on itself, kept apart from the PLUT_OS the owner uses.
//
// The same checkout used to be both. Starting the dashboard from source shared the owner's data
// folder, so an experiment could touch the real project list and approval seal key, and the
// copy that started last registered itself as the current install, which is the pointer every
// project's MCP launcher follows: running the checkout once silently moved every project's AI
// coordinator onto unreleased code.
//
// Development mode (DEV_PLUT_OS.bat, `npm run dev`, PLUTOS_MODE=dev or --dev) gets its own data
// folder, its own default port, and a project list that holds only PLUT_OS itself and folders in
// its own sandbox. It cannot reach the owner's projects by any path: they are not in its
// registry, and adding one outside the sandbox is refused.
import fs from 'fs';
import path from 'path';

export const DEV_PORT = 3041;

export function isDevMode(env = process.env, argv = process.argv) {
    return env.PLUTOS_MODE === 'dev' || argv.includes('--dev');
}

export const devSandboxDir = home => path.join(home, 'sandbox');

const comparable = p => {
    let resolved = path.resolve(p);
    try { resolved = fs.realpathSync(resolved); } catch (e) { /* not on disk yet */ }
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

// Strictly below: the sandbox folder itself is not a project, the folders in it are.
const below = (child, parent) => {
    const c = comparable(child), p = comparable(parent);
    return c !== p && c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
};

// In development mode a project is either PLUT_OS's own checkout or something in the sandbox.
export function devProjectAllowed(target, { home, appRoot }) {
    return comparable(target) === comparable(appRoot) || below(target, devSandboxDir(home));
}

export function devProjectRefusal(target, home) {
    return `Development mode does not touch real projects: ${target} is outside ${devSandboxDir(home)}. `
        + 'Copy a sample project into the sandbox, or open it from the normal PLUT_OS.';
}

// Is this folder PLUT_OS's own source? Decided by content, not by comparing it with the running
// install: the recommended setup coordinates a development checkout from a separate, stable
// PLUT_OS, and then the two paths differ.
export function isPlutosSource(root) {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        return pkg.name === 'plut-os'
            && fs.existsSync(path.join(root, 'index.mjs'))
            && fs.existsSync(path.join(root, 'lib', 'drawers.mjs'));
    } catch (e) {
        return false;
    }
}

// One line for the session brief when an AI is working on PLUT_OS itself.
export function selfBriefLine(root) {
    if (!isPlutosSource(root)) return '';
    return '\n\nTHIS PROJECT IS PLUT_OS ITSELF. Changes must pass npm test, including the token budget. '
        + 'Run the development copy with DEV_PLUT_OS.bat or `npm run dev` (own data folder, port 3041); never point it at real projects.'
        // The goals live in the owner's working records, which the main repository does not carry.
        + (fs.existsSync(path.join(root, 'MVP.md'))
            ? ' Scope: put every new idea through the five-goal filter (CLAUDE.md, or MVP.md lines 3-19): do now, defer to IDEAS.md, or drop.' : '');
}
