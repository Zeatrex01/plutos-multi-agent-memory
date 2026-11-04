// Stable per-user PLUT_OS data: workspace registrations, observed-project sidecars,
// authentication settings, capture jobs, logs, and the current install
// pointer. Application assets remain under APP_ROOT; installed-project knowledge remains in
// that project. Legacy migration is copy-only and touches a strict allowlist.
import fs from 'fs';
import path from 'path';
import {
    APP_ROOT,
    LEGACY_PLUTOS_HOME_DIR,
    PLUTOS_HOME_DIR,
    PLUTOS_HOME_IS_EXPLICIT
} from './approot.mjs';

export const INSTALL_REGISTRY_FILE = 'install.json';
export const STORAGE_SCHEMA_VERSION = 1;
export const APP_DATA_LIMITS = Object.freeze({ files: 10_000, bytes: 256 * 1024 * 1024, workspaces: 500 });

const MIGRATABLE_DIRS = ['workspaces'];
let bootstrap = null;

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

// Same bounded patience as renameIntoPlace in lib/atomic.mjs: on Windows a rename onto a file a
// reader holds open fails for a few milliseconds with EPERM/EBUSY/EACCES, and giving up there
// would turn an ordinary read into a failed save.
const RENAME_TRIES = 50;
const RENAME_WAIT_MS = 15;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Hub settings (hub_config.json, install.json) are written to a temp file in the same folder and
// renamed into place, so a crash mid-write leaves either the old file or the new one, never torn
// JSON. This module has no import-time side effects.
export function writeFileAtomic(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
        fs.writeFileSync(temp, text, 'utf8');
        for (let i = 0; ; i++) {
            try { fs.renameSync(temp, file); return; }
            catch (e) {
                if (process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(e.code) && i < RENAME_TRIES) { sleep(RENAME_WAIT_MS); continue; }
                throw e;
            }
        }
    } catch (e) {
        try { fs.rmSync(temp, { force: true }); } catch (e2) { /* the original error is the one that matters */ }
        throw e;
    }
}

function writeJsonAtomic(file, value) {
    writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

// An unreadable settings file is moved aside, never left in place: the caller then starts from
// empty, and its next save would otherwise overwrite the only copy of what the owner had.
// Returns where the file went, or '' if it could not be moved.
export function setAsideUnreadable(file, reason) {
    const aside = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
        fs.renameSync(file, aside);
        console.error(`[PLUT_OS] ${path.basename(file)} could not be read (${reason}); kept it as ${aside} and started empty.`);
        return aside;
    } catch (e) {
        // Several MCP processes start together and can all find the same broken file; the first
        // one moves it and has already said so.
        if (e.code === 'ENOENT') return '';
        console.error(`[PLUT_OS] ${path.basename(file)} could not be read (${reason}) and could not be moved aside (${e.message}).`);
        return '';
    }
}

function comparable(p, platform = process.platform) {
    const resolved = path.resolve(String(p || '')).replace(/\\/g, '/').replace(/\/+$/, '');
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function mergeHubConfig(legacyFile, destinationFile, result) {
    try {
        const stat = fs.lstatSync(legacyFile);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > APP_DATA_LIMITS.bytes) return;
    } catch (e) { return; }
    const legacy = readJson(legacyFile);
    if (!legacy || !Array.isArray(legacy.workspaces)) return;
    // Merging over a torn registry would replace it; keep it, as lib/workspaces.mjs does.
    if (fs.existsSync(destinationFile) && readJson(destinationFile) === null) setAsideUnreadable(destinationFile, 'not valid JSON');
    const current = readJson(destinationFile) || {};
    const workspaces = [];
    const seen = new Set();
    for (const item of [...(Array.isArray(current.workspaces) ? current.workspaces : []), ...legacy.workspaces]) {
        if (typeof item !== 'string' || !path.isAbsolute(item) || workspaces.length >= APP_DATA_LIMITS.workspaces) continue;
        let key;
        try { key = comparable(item); } catch (e) { continue; }
        if (seen.has(key)) continue;
        seen.add(key);
        workspaces.push(path.resolve(item));
    }
    const activeWorkspace = typeof current.activeWorkspace === 'string' && path.isAbsolute(current.activeWorkspace)
        ? current.activeWorkspace
        : (typeof legacy.activeWorkspace === 'string' && path.isAbsolute(legacy.activeWorkspace) ? legacy.activeWorkspace : '');
    const next = { workspaces, activeWorkspace };
    if (JSON.stringify(current) !== JSON.stringify(next)) {
        writeJsonAtomic(destinationFile, next);
        result.items.push('hub_config.json');
    }
}

function copyMissingTree(source, destination, result, label) {
    if (!fs.existsSync(source)) return;
    const walk = (src, dest) => {
        if (result.files >= APP_DATA_LIMITS.files || result.bytes >= APP_DATA_LIMITS.bytes) {
            throw new Error('legacy app-data migration exceeded its safety budget');
        }
        const stat = fs.lstatSync(src);
        if (stat.isSymbolicLink()) return;
        if (stat.isDirectory()) {
            fs.mkdirSync(dest, { recursive: true });
            for (const entry of fs.readdirSync(src)) walk(path.join(src, entry), path.join(dest, entry));
            return;
        }
        if (!stat.isFile() || fs.existsSync(dest)) return;
        if (result.bytes + stat.size > APP_DATA_LIMITS.bytes) {
            throw new Error('legacy app-data migration exceeded its byte budget');
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        try {
            fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
        } catch (e) {
            if (e.code === 'EEXIST') return;
            throw e;
        }
        result.files += 1;
        result.bytes += stat.size;
    };
    const before = result.files;
    walk(source, destination);
    if (result.files > before) result.items.push(label);
}

export function migrateLegacyAppData({
    appRoot = APP_ROOT,
    dataRoot = PLUTOS_HOME_DIR,
    legacyRoot = LEGACY_PLUTOS_HOME_DIR,
    explicitHome = PLUTOS_HOME_IS_EXPLICIT
} = {}) {
    const result = {
        attempted: false,
        from: legacyRoot,
        to: dataRoot,
        items: [],
        files: 0,
        bytes: 0,
        errors: []
    };
    fs.mkdirSync(dataRoot, { recursive: true });
    // A caller choosing PLUTOS_HOME owns that location and normally uses it for isolation.
    // Never pull unrelated real data into an explicit/test directory.
    if (explicitHome || comparable(legacyRoot) === comparable(dataRoot) || !fs.existsSync(legacyRoot)) return result;
    result.attempted = true;
    try {
        mergeHubConfig(path.join(legacyRoot, 'hub_config.json'), path.join(dataRoot, 'hub_config.json'), result);
        for (const name of MIGRATABLE_DIRS) {
            copyMissingTree(path.join(legacyRoot, name), path.join(dataRoot, name), result, `${name}/`);
        }
        if (result.items.length) {
            writeJsonAtomic(path.join(dataRoot, 'migration.json'), {
                schemaVersion: STORAGE_SCHEMA_VERSION,
                migratedAt: new Date().toISOString(),
                from: legacyRoot,
                items: result.items,
                files: result.files,
                bytes: result.bytes
            });
        }
    } catch (e) {
        result.errors.push(e.message);
    }
    return result;
}

export function ensureAppData(options = {}) {
    if (!Object.keys(options).length && bootstrap) return bootstrap;
    const result = migrateLegacyAppData(options);
    if (!Object.keys(options).length) bootstrap = result;
    return result;
}

export function installRegistryPath(dataRoot = PLUTOS_HOME_DIR) {
    return path.join(dataRoot, INSTALL_REGISTRY_FILE);
}

export function readCurrentInstall(dataRoot = PLUTOS_HOME_DIR) {
    const value = readJson(installRegistryPath(dataRoot));
    if (!value || typeof value.appRoot !== 'string' || !path.isAbsolute(value.appRoot)) return null;
    return value;
}

// Called by the dashboard, not by every MCP process. Whichever app copy the owner launches
// becomes current; project launchers consult this stable pointer, so moving the portable
// folder no longer requires rewriting every registered project.
export function registerCurrentInstall({
    appRoot = APP_ROOT,
    dataRoot = PLUTOS_HOME_DIR,
    packaged = process.env.PLUTOS_PACKAGED === '1',
    now = () => new Date().toISOString()
} = {}) {
    ensureAppData({ appRoot, dataRoot, legacyRoot: path.join(appRoot, '.plutos'), explicitHome: PLUTOS_HOME_IS_EXPLICIT });
    const resolvedRoot = path.resolve(appRoot);
    const previous = readCurrentInstall(dataRoot);
    const next = {
        schemaVersion: STORAGE_SCHEMA_VERSION,
        appRoot: resolvedRoot,
        packaged: !!packaged,
        updatedAt: now()
    };
    writeJsonAtomic(installRegistryPath(dataRoot), next);
    return { changed: !previous || comparable(previous.appRoot) !== comparable(resolvedRoot), previous, current: next };
}

export function storageInfo({ activeProject = '', projectDataRoot = '', installed = false } = {}) {
    const migration = bootstrap || ensureAppData();
    return {
        schemaVersion: STORAGE_SCHEMA_VERSION,
        appRoot: APP_ROOT,
        dataRoot: PLUTOS_HOME_DIR,
        explicitHome: PLUTOS_HOME_IS_EXPLICIT,
        installRegistry: installRegistryPath(),
        currentInstall: readCurrentInstall(),
        legacyRoot: LEGACY_PLUTOS_HOME_DIR,
        migration,
        project: activeProject ? {
            sourceRoot: activeProject,
            dataRoot: projectDataRoot,
            mode: installed ? 'project-owned' : 'hub-sidecar'
        } : null,
        boundaries: {
            installedProjectKnowledge: 'project',
            observedProjectKnowledge: 'stable-user-data',
            rawClaudeTranscriptCopied: false
        }
    };
}
