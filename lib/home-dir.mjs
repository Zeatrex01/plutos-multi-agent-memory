// The per-user data folder, as a pure function with no load-time state. lib/approot.mjs fixes
// PLUTOS_HOME_DIR once when it loads; a module that tests import before setting PLUTOS_HOME
// (lib/approvals.mjs) resolves the folder through this at call time instead.
import path from 'path';
import os from 'os';
import { isDevMode } from './run-mode.mjs';

// Machine data must outlive the folder containing the portable executable. Keeping the
// workspace registry beside the app made every rebuild (`dist/` is replaced) look like a
// fresh install and made a moved portable folder lose its project list. Use the operating
// system's per-user application-data location by default; PLUTOS_HOME remains the explicit
// override and the test-isolation seam. Development mode (lib/run-mode.mjs) defaults to a sibling
// folder with a -dev suffix, so the copy being worked on never shares the owner's data.
export function defaultPlutosHome({
    env = process.env,
    platform = process.platform,
    homeDir = os.homedir(),
    dev = isDevMode(env)
} = {}) {
    const suffix = dev ? '-dev' : '';
    if (platform === 'win32') {
        const base = env.LOCALAPPDATA
            || (env.USERPROFILE ? path.join(env.USERPROFILE, 'AppData', 'Local') : path.join(homeDir, 'AppData', 'Local'));
        return path.join(base, 'PLUT_OS' + suffix);
    }
    if (platform === 'darwin') {
        return path.join(homeDir, 'Library', 'Application Support', 'PLUT_OS' + suffix);
    }
    const base = env.XDG_DATA_HOME || path.join(homeDir, '.local', 'share');
    return path.join(base, 'plut-os' + suffix);
}

// Development mode must never run on the owner's data, even when PLUTOS_HOME was set by hand or
// left over in a shell. → an error message, or '' when the pairing is safe.
export function devHomeConflict(home, env = process.env) {
    if (!isDevMode(env)) return '';
    const production = path.resolve(defaultPlutosHome({ env, dev: false }));
    const same = process.platform === 'win32'
        ? path.resolve(home).toLowerCase() === production.toLowerCase()
        : path.resolve(home) === production;
    return same
        ? `Development mode refuses the normal PLUT_OS data folder (${production}). Unset PLUTOS_HOME or point it at a separate folder.`
        : '';
}

export function currentPlutosHome(env = process.env) {
    return path.resolve(typeof env.PLUTOS_HOME === 'string' && env.PLUTOS_HOME.trim() ? env.PLUTOS_HOME : defaultPlutosHome({ env }));
}
