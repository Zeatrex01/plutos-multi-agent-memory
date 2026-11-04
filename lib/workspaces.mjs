// Workspace (hub) state + target-project bootstrap. Single owner of hub_config.json.
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { renderInterview } from './interview.mjs';
import { APP_ROOT, PLUTOS_HOME_DIR } from './approot.mjs';
import { ensureAppData, setAsideUnreadable, writeFileAtomic } from './app-data.mjs';
import { PLUTOS_STUB } from './mcps.mjs';
import { configEntry, findClient } from './connect.mjs';
import { scanProject } from './recommend.mjs';
import { refreshIndexIfStale, runCodeScan } from './codeindex.mjs';
import { PROJECT_ROOT_ENV, LAUNCHER_BOUND_ENV } from './project-binding.mjs';
import { isDevMode, devProjectAllowed, devProjectRefusal, devSandboxDir } from './run-mode.mjs';

export const ROOT = APP_ROOT;
export const HANDOFF_TEMPLATES_DIR = path.join(ROOT, 'scaffold', 'docs', 'handoff');
export const HANDOFF_TEMPLATE_FILES = ['BOARD.md', 'AGENT_BOARD.md', 'ROSTER.md'];
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
// SHA-256 (LF line ends) of every AGENTS.md this repository ever shipped as the kit's rules. A
// project still holding one of them byte for byte never edited it, so repair may replace it with
// the current rules; any other content is the owner's and stays. Add the old hash whenever
// AGENTS.md changes (tools/repair-test.mjs fails until it is added).
export const PAST_KIT_RULES = [
    'a61dd719c395ca1cdc5d88e14ae127147f882d22d23f19edd2e266376edec8f7',
    '85dfbf3c501be4643fcf9a487adca6315492123b07ca521842c038b7e16a0c2b', 'dc10cd5bbc3abc493ed00fe392f7e2c1f9f485f69e40b35429a7db1d00530abf',
    'a91641a248bca12e5a5ef65cc1f6b2ee895f33efdf609ea8600f0aadb58587cf', 'f102a4aa595239aeb6aae73bf810faafce8ecadff5bfd74262e9c926e4b21c54',
    '2609afdf0d0772a078dba150b9ec89b8c4925c77b393b19637101cf199f99597', 'c6b36309a69e69b828e0faf9c0935bffb6a134c7f1143b3f86f28a889dd99dce',
    '3ed2e50da6b5908a2b14c802256d35917fb985c73255656b05dbd7c51b8bb8a9', 'b983247d2978c0d032035b9218a22e6a3de4fdf97e3631248b303efb8cb975a2',
    'aab59b0b3c40a18fef32b88f733bc0e695a7efb1d39ca31983fff7fb4284fefc', '7d8db922608ec205970e84c6264ab78ad1cea86018da3f1fcd111d5f3346a0d3',
    '5ba208a5a7bd10a3d0248e73586c6981284e47091e518795a900ba60f560d312',
    'f0d04187d223f44c63169023f7d6f533157554c577faa68998c561142a16672c',
    'ee71c948f8cc58392e2b089e8c5ca0861c09cdb228387dbab2802d0a271b23e8'
];

// Validate every template needed by THIS target before writing anything. Existing project
// files never need a template and remain usable if a portable install is incomplete; a new
// project must fail before registration rather than being listed with half a coordination kit.
export function assertHandoffTemplatesAvailable(targetPath, templateDir = HANDOFF_TEMPLATES_DIR) {
    const targetDir = path.join(targetPath, 'docs', 'handoff');
    const missing = HANDOFF_TEMPLATE_FILES.filter(name =>
        !fs.existsSync(path.join(targetDir, name))
        && !fs.existsSync(path.join(templateDir, name)));
    if (missing.length) {
        throw new Error(`PLUT_OS install is missing clean handoff template(s): ${missing.join(', ')}. Repair or reinstall PLUT_OS before adding this project.`);
    }
}

// PLUTOS_HOME override keeps test runs away from the real hub config. Bootstrap is copy-only:
// legacy portable data is imported before hub_config.json is read, never moved or deleted.
ensureAppData();
export const HUB_CONFIG_DIR = PLUTOS_HOME_DIR;
const HUB_CONFIG_FILE = path.join(HUB_CONFIG_DIR, 'hub_config.json');

const state = {
    workspaces: [],
    // Nothing is open until the owner opens it. The hub file still REMEMBERS the last project
    // (below, as lastWorkspace) so the Hub can offer it as one click — but remembering is not
    // the same as opening. Launching straight into whatever was open last time skipped the one
    // decision the owner wanted the Hub to ask, and on a machine with nine registered projects
    // that is a real chance of typing into the wrong one.
    lastWorkspace: '',
    activeWorkspace: '',
    // Empty, NOT process.cwd(). The cwd of the dashboard is the PLUT_OS install itself, so the
    // old fallback made "no project selected" silently mean "the product's own repo is the
    // project" — it displayed PLUT_OS's board and commits as the owner's, and unguarded write
    // routes would have installed into the checkout. An empty root now produces a relative
    // path that fails loudly, and the dispatcher refuses those routes outright
    // (lib/route-policy.mjs) so it never gets that far.
    currentProjectRoot: ''
};

if (!fs.existsSync(HUB_CONFIG_DIR)) {
    fs.mkdirSync(HUB_CONFIG_DIR, { recursive: true });
}
// Set when hub_config.json could be neither read nor moved aside: saving the empty in-memory
// list over it would erase every registered project, so save() refuses until a restart.
let hubConfigUnsaved = '';
if (fs.existsSync(HUB_CONFIG_FILE)) {
    try {
        const data = JSON.parse(fs.readFileSync(HUB_CONFIG_FILE, 'utf8'));
        state.workspaces = data.workspaces || [];
        // Read as "last opened", not "currently open" — see the state comment above.
        state.lastWorkspace = data.activeWorkspace || '';
    } catch (e) {
        // A torn or hand-broken registry used to load as zero projects, and the next save then
        // overwrote it with that empty list. Starting empty is fine; losing the only copy is not.
        if (!setAsideUnreadable(HUB_CONFIG_FILE, e.message) && fs.existsSync(HUB_CONFIG_FILE)) {
            hubConfigUnsaved = `${HUB_CONFIG_FILE} could not be read or moved aside; restart PLUT_OS before changing projects.`;
        }
    }
}

// Development mode keeps a registry of PLUT_OS itself and its sandbox only (lib/run-mode.mjs).
// The data folder is already separate; this also drops anything that reached it some other way,
// such as legacy data copied in from the checkout's own .plutos, before any route can open it.
const DEV_MODE = isDevMode();
const devAllowed = p => devProjectAllowed(p, { home: HUB_CONFIG_DIR, appRoot: APP_ROOT });
if (DEV_MODE) {
    state.workspaces = state.workspaces.filter(devAllowed);
    if (state.lastWorkspace && !devAllowed(state.lastWorkspace)) state.lastWorkspace = '';
    fs.mkdirSync(devSandboxDir(HUB_CONFIG_DIR), { recursive: true });
}

// The file's `activeWorkspace` key keeps its name and shape — it is what a previous version
// wrote and what a downgrade would read — but it now means "the last project opened". While
// nothing is open, the remembered one is preserved rather than erased, so closing the app does
// not cost the owner the shortcut back in.
function save() {
    if (hubConfigUnsaved) throw new Error(hubConfigUnsaved);
    writeFileAtomic(HUB_CONFIG_FILE, JSON.stringify({
        workspaces: state.workspaces,
        activeWorkspace: state.activeWorkspace || state.lastWorkspace
    }, null, 2));
}

export function getWorkspaces() { return state.workspaces; }
export function getActiveWorkspace() { return state.activeWorkspace; }
// The project the owner had open last time. Offered by the Hub as a one-click resume; it is
// never treated as open on its own.
export function getLastWorkspace() { return state.lastWorkspace; }
export function getProjectRoot() { return state.currentProjectRoot; }

// A registered project and PLUT_OS's own working data are not the same location. Until the
// owner explicitly installs the project kit, the source tree is read-only and every task,
// interview answer and generated index lives in the hub's private workspace store.
// Hashing the canonical path keeps arbitrary drive/path characters out of folder names while
// observed.json retains the human-readable source for diagnostics.
export function observedWorkspaceRoot(targetPath = state.currentProjectRoot) {
    if (!targetPath) return '';
    const id = createHash('sha256').update(comparablePath(targetPath)).digest('hex').slice(0, 20);
    return path.join(HUB_CONFIG_DIR, 'workspaces', id);
}

export function isWorkspaceInstalled(targetPath = state.currentProjectRoot) {
    return looksLikePlutosProject(targetPath);
}

// Shared/live coordination belongs in the project only after installation. Generated maps
// follow the same rule once installed; observe mode keeps both under PLUTOS_HOME.
export function getCoordinationRoot(targetPath = state.currentProjectRoot) {
    if (!targetPath) return '';
    return isWorkspaceInstalled(targetPath) ? targetPath : observedWorkspaceRoot(targetPath);
}

export function getIndexRoot(targetPath = state.currentProjectRoot) {
    return getCoordinationRoot(targetPath);
}

export function workspaceDetails(targetPath) {
    const registered = findRegistered(targetPath) || targetPath;
    const installed = isWorkspaceInstalled(registered);
    return {
        path: registered,
        mode: installed ? 'installed' : 'observed',
        installed,
        coordinationRoot: installed ? registered : observedWorkspaceRoot(registered)
    };
}

// Registered workspaces are compared as plain strings, so `C:\Users\me\app` and
// `C:/Users/me/app` used to register as two separate projects — same folder installed twice,
// listed twice, and switching between them looked like switching projects. Everything that
// takes a path resolves it against the registry through these two helpers instead.
// STORED form: resolve only. Native separators are deliberately preserved — a registered path
// is shown to the user, handed back over the API, and compared by callers against their own
// path.join output, so rewriting `\` to `/` on Windows changed the hub's public contract.
function canonicalPath(p) {
    return path.resolve(p);
}

// COMPARISON form: separators unified and case folded on Windows, so `C:\app`, `C:/app/` and
// `c:\app` all resolve to the same registered workspace without changing what gets stored.
function comparablePath(p) {
    const unified = path.resolve(p).split(path.sep).join('/');
    const trimmed = unified.length > 1 ? unified.replace(/\/+$/, '') : unified;
    return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

function samePath(a, b) {
    try {
        return comparablePath(a) === comparablePath(b);
    } catch (e) {
        return false;
    }
}

// The registered entry that points at this folder, whatever spelling the caller used.
function findRegistered(targetPath) {
    if (!targetPath || typeof targetPath !== 'string') return null;
    return state.workspaces.find(w => w === targetPath)
        || state.workspaces.find(w => samePath(w, targetPath))
        || null;
}

function copyTemplateIfMissing(storeRoot, name) {
    const dest = path.join(storeRoot, 'docs', 'handoff', name);
    if (fs.existsSync(dest)) return;
    const src = path.join(HANDOFF_TEMPLATES_DIR, name);
    if (!fs.existsSync(src)) throw new Error(`PLUT_OS install is missing clean handoff template: ${name}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
}

// Prepare the hub-private sidecar for an uninstalled project. Every write target below is
// rooted under PLUTOS_HOME; targetPath is only ever read by scanProject/runCodeScan.
function inspectWorkspace(targetPath, config = {}) {
    const signals = scanProject(targetPath);

    // An already-installed project is merely registered. Add Project remains read-only even
    // here: repairing or regenerating its files belongs to an explicit action/session.
    if (looksLikePlutosProject(targetPath)) {
        return {
            mode: 'installed', installed: true, ignores: null, mcpWired: false,
            maps: { rescanned: false },
            detected: {
                stack: signals.stack,
                frameworks: signals.frameworks || [],
                codeIndex: fs.existsSync(path.join(targetPath, 'docs', 'ai', 'CODEINDEX.md')),
                docs: fs.existsSync(path.join(targetPath, 'docs', 'handoff', 'BOARD.md'))
            }
        };
    }

    const storeRoot = observedWorkspaceRoot(targetPath);
    for (const name of HANDOFF_TEMPLATE_FILES) copyTemplateIfMissing(storeRoot, name);
    fs.mkdirSync(path.join(storeRoot, 'docs', 'handoff', 'results'), { recursive: true });

    if (config.withInterview) {
        const interview = path.join(storeRoot, 'docs', 'handoff', 'PROJECT_INTERVIEW.md');
        if (!fs.existsSync(interview)) fs.writeFileSync(interview, renderInterview({}), 'utf8');
    }

    const metaDir = path.join(storeRoot, '.plutos');
    fs.mkdirSync(metaDir, { recursive: true });
    fs.writeFileSync(path.join(metaDir, 'observed.json'), JSON.stringify({
        sourceRoot: targetPath,
        mode: 'observed',
        lastScannedAt: new Date().toISOString()
    }, null, 2) + '\n', 'utf8');
    // The detected stack is written down, not just shown once in the wizard. It was computed
    // here and thrown away, so every later AI re-derived "what language is this" from files —
    // or learned nothing until someone ran a full project-intake pass. buildBrief reads it.
    fs.writeFileSync(path.join(metaDir, 'plutos.config.json'), JSON.stringify({
        stack: signals.stack, frameworks: signals.frameworks || []
    }, null, 2) + '\n', 'utf8');
    const maps = runCodeScan(targetPath, { outputRoot: storeRoot });

    return {
        mode: 'observed', installed: false, storageRoot: storeRoot,
        ignores: null, mcpWired: false, maps,
        detected: {
            stack: signals.stack,
            frameworks: signals.frameworks || [],
            codeIndex: fs.existsSync(path.join(storeRoot, 'docs', 'ai', 'CODEINDEX.md')),
            docs: fs.existsSync(path.join(storeRoot, 'docs', 'handoff', 'BOARD.md'))
        }
    };
}

const MIGRATABLE_FILES = [
    ['docs', 'handoff', 'BOARD.md'],
    ['docs', 'handoff', 'AGENT_BOARD.md'],
    ['docs', 'handoff', 'ROSTER.md'],
    ['docs', 'handoff', 'PROJECT_INTERVIEW.md'],
    ['docs', 'handoff', 'CONTINUITY.md'],
    ['IDEAS.md']
];

function copyTreeMissing(sourceDir, targetDir, copied, reportRoot = targetDir) {
    if (!fs.existsSync(sourceDir)) return;
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        const src = path.join(sourceDir, entry.name);
        const dest = path.join(targetDir, entry.name);
        if (entry.isDirectory()) {
            copyTreeMissing(src, dest, copied, reportRoot);
        } else if (entry.isFile() && !fs.existsSync(dest)) {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(src, dest);
            copied.push(path.relative(reportRoot, dest).replace(/\\/g, '/'));
        }
    }
}

// Explicitly install the project kit. Client MCP files are still a separate opt-in: this
// creates the launcher/protocol/boards, then the owner chooses Claude/Codex/Cursor/etc.
export function installWorkspace(targetPath = state.currentProjectRoot, config = {}) {
    const registered = findRegistered(targetPath);
    if (!registered) throw new Error('Registered workspace not found. Add it to the hub first.');
    if (looksLikePlutosProject(registered)) {
        return { installed: true, alreadyInstalled: true, migrated: [], ...workspaceDetails(registered) };
    }

    const storeRoot = observedWorkspaceRoot(registered);
    const existed = new Map(MIGRATABLE_FILES.map(rel => [rel.join('/'), fs.existsSync(path.join(registered, ...rel))]));
    const cachedInterview = fs.existsSync(path.join(storeRoot, 'docs', 'handoff', 'PROJECT_INTERVIEW.md'));
    const result = initTargetProject(registered, {
        ...config,
        // Core install and client connection are independent decisions. Never resurrect the
        // old behaviour where installing/registering silently created Claude's .mcp.json.
        withInterview: config.withInterview === true && !cachedInterview
    });

    const migrated = [];
    for (const rel of MIGRATABLE_FILES) {
        const key = rel.join('/');
        const src = path.join(storeRoot, ...rel);
        const dest = path.join(registered, ...rel);
        if (existed.get(key) || !fs.existsSync(src)) continue;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        migrated.push(key);
    }
    // Preserve locally produced reports without overwriting anything the project already owned.
    // These are cold files, so create-missing is enough. (SYSTEM.md and system-roles/ are no longer
    // carried over: the system roles left on 2026-11-04, lib/kit-history.mjs.)
    copyTreeMissing(path.join(storeRoot, 'docs', 'handoff', 'results'), path.join(registered, 'docs', 'handoff', 'results'), migrated, registered);
    return {
        ...result,
        installed: true,
        alreadyInstalled: false,
        mode: 'installed',
        mcpWired: false,
        migrated
    };
}

export function addWorkspace(targetPath, config = {}) {
    if (!targetPath || typeof targetPath !== 'string'
        || !fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
        throw new Error("Folder not found.");
    }
    if (DEV_MODE && !devAllowed(targetPath)) throw new Error(devProjectRefusal(targetPath, HUB_CONFIG_DIR));
    const canonical = findRegistered(targetPath) || canonicalPath(targetPath);
    // Add means REGISTER + OBSERVE. It must never be a disguised installer: no AGENTS.md,
    // .plutos/, .mcp.json, editor config, launcher or .gitignore is written to the source.
    // The local store is prepared first so a failed scan cannot leave a half-usable registry
    // entry; failure is still harmless to the user's project because all writes are in hub.
    const result = inspectWorkspace(canonical, config);
    if (!state.workspaces.includes(canonical)) state.workspaces.push(canonical);
    state.activeWorkspace = canonical;
    state.lastWorkspace = canonical;
    state.currentProjectRoot = canonical;
    save();
    return result;
}

// Development mode opens on PLUT_OS itself: registering an installed project only records it
// (inspectWorkspace writes nothing into it), so this is safe on the checkout being edited.
export function openDevSelfProject() {
    if (!DEV_MODE) return '';
    if (findRegistered(APP_ROOT)) switchWorkspace(APP_ROOT);
    else addWorkspace(APP_ROOT);
    return state.activeWorkspace;
}

export function switchWorkspace(targetPath) {
    const registered = findRegistered(targetPath);
    if (!registered) throw new Error("Registered workspace not found.");
    state.activeWorkspace = registered;
    state.lastWorkspace = registered;
    state.currentProjectRoot = registered;
    save();
    healLauncherStub(registered);
}

// A project's PLUT_OS.bat runs .plutos/plutos-launch.mjs, which binds the coordinator to the
// project that OWNS the launcher before any PLUT_OS code loads (see writeLauncherStub below).
// index.mjs has always honoured that binding; the dashboard never read it, so opening a
// project through its own launcher still landed on whatever hub_config remembered — the
// "I open the project I want and nothing happens" report. Launching-with-intent is the one
// case where the Hub does NOT need to ask which project, because the owner already answered
// by choosing which launcher to run.
//
// Only the two variables the stub sets are consulted. resolveProjectRoot() is deliberately not
// reused here: its cwd fallback is the PLUT_OS install itself, and silently opening PLUT_OS's
// own repo as the project is exactly what the empty activeWorkspace above exists to prevent.
// A plain launch sets neither variable, returns '' here, and still opens the no-project Hub.
export function openLauncherBoundWorkspace(env = process.env) {
    if (env[LAUNCHER_BOUND_ENV] !== '1') return '';
    const bound = env[PROJECT_ROOT_ENV];
    // A hand-set variable can point anywhere; a real stub cannot, since it lives inside the
    // folder it names. A missing folder is not worth failing a launch over — fall through to
    // the Hub, which lists the projects that do exist.
    if (!bound || !fs.existsSync(bound)) return '';
    // Registered is the common case and the cheap one: switchWorkspace only moves the pointer.
    // Unregistered is a real state — a hub reset, or a project wired on another machine, still
    // carries a working stub — and refusing it because the hub forgot the project would
    // reproduce the bug this exists to fix. addWorkspace is the same register-and-open call the
    // Add Project route makes, and is observe-only: it writes nothing into the source tree.
    if (findRegistered(bound)) switchWorkspace(bound);
    else { addWorkspace(bound); healLauncherStub(state.activeWorkspace); }
    return state.activeWorkspace;
}

// Leave the open project without unregistering it. Until this existed, removeWorkspace was the
// only code path that cleared activeWorkspace — so the only way back to the no-project screen
// was to delete the project from the hub, which is a different intention entirely and loses the
// entry. Nothing else changes: lastWorkspace is deliberately kept, because closing is not
// forgetting, and save() already persists it as the one-click way back in. This is the same
// state every launch starts in (nothing open, a shortcut offered), reachable mid-session.
export function closeWorkspace() {
    state.activeWorkspace = '';
    state.currentProjectRoot = '';
    save();
}

// Unregisters from the hub only — never touches files on disk.
export function removeWorkspace(targetPath) {
    const registered = findRegistered(targetPath);
    if (!registered) throw new Error("Registered workspace not found.");
    state.workspaces = state.workspaces.filter(w => w !== registered);
    if (state.activeWorkspace === registered) {
        state.activeWorkspace = '';
        state.currentProjectRoot = '';
    }
    if (state.lastWorkspace === registered) state.lastWorkspace = '';
    save();
}

// Backward-compatible/custom-home fallback for this machine's PLUT_OS install. It carries
// absolute paths and is therefore kept out of git (see writeMachineIgnores). New launchers
// consult the stable per-user install registry first; this file lets older/custom deployments
// keep working without baking machine paths into committed .mcp.json or launch scripts.
export const LOCAL_CONFIG_FILE = 'local.json';

function persistWiring(file, content, plan, mode) {
    if (plan) { plan.push({ path: file, content, ...(mode ? { mode } : {}) }); return; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    if (mode) try { fs.chmodSync(file, mode); } catch { /* bash can still run the launcher */ }
}

function writeLocalConfig(targetPath, plan) {
    const file = path.join(targetPath, '.plutos', LOCAL_CONFIG_FILE);
    let local = {};
    if (fs.existsSync(file)) {
        try { local = JSON.parse(fs.readFileSync(file, 'utf8')); }
        catch (e) {
            if (plan) throw new Error('.plutos/local.json is not valid JSON; repair left it untouched.');
            local = {};
        }
    }
    if (plan && (!local || typeof local !== 'object' || Array.isArray(local))) throw new Error('.plutos/local.json must be a JSON object.');
    const cleanHarness = process.env.PLUTOS_CLEAN_HARNESS === '1';
    if (local.plutosRoot === ROOT && local.plutosHome === PLUTOS_HOME_DIR && local.cleanHarness === cleanHarness) return false;
    local.plutosRoot = ROOT;
    local.plutosHome = PLUTOS_HOME_DIR;
    local.cleanHarness = cleanHarness;
    persistWiring(file, JSON.stringify(local, null, 2), plan);
    return true;
}

// The stub both .mcp.json and PLUT_OS.bat point at, by RELATIVE path. It resolves the current
// app through stable per-user install.json, with local.json only as a custom-home/legacy
// fallback, so the committed files stay identical on every machine. It holds only what finding
// the install takes; everything after that is the install's lib/launch.mjs, so a change to how
// PLUT_OS starts needs no new stub. Regenerated on wiring, and an older generated stub is
// replaced when its project is opened (healLauncherStub).
const STUB_MARK = '// Generated by PLUT_OS';

export function launcherStub() {
    return `${STUB_MARK} — do not edit. Launcher 2: it finds this machine's PLUT_OS install from
// stable user data, then .plutos/${LOCAL_CONFIG_FILE}, and hands over to that install's lib/launch.mjs,
// so committed files carry no local path and a change in PLUT_OS needs no new copy of this file.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const localFile = path.join(here, '${LOCAL_CONFIG_FILE}');
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return {}; } };
const local = read(localFile);

function defaultHubDir() {
    if (process.platform === 'win32') {
        return path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Local'), 'PLUT_OS');
    }
    if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'PLUT_OS');
    return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'plut-os');
}

const configuredHome = process.env.PLUTOS_HOME || local.plutosHome;
const hubDir = configuredHome && path.isAbsolute(configuredHome) ? configuredHome : defaultHubDir();
const installFile = path.join(hubDir, 'install.json');
// The stable registry first; local.plutosRoot is the fallback for a custom home or an older wiring.
const plutosRoot = [read(installFile).appRoot, local.plutosRoot].find(candidate => typeof candidate === 'string'
    && path.isAbsolute(candidate) && fs.existsSync(path.join(candidate, 'lib', 'launch.mjs')));
if (!plutosRoot) {
    console.error('[PLUT_OS] No usable PLUT_OS install is registered. Launch PLUT_OS once so it records where it is: ' + installFile);
    process.exit(1);
}
const { launch } = await import(pathToFileURL(path.join(plutosRoot, 'lib', 'launch.mjs')).href);
await launch({ projectRoot: path.dirname(here), plutosRoot, hubDir, installFile, local, localFile });
`;
}

function writeLauncherStub(targetPath, plan) {
    const stub = launcherStub();
    const file = path.join(targetPath, '.plutos', PLUTOS_STUB);
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === stub) return false;
    persistWiring(file, stub, plan);
    return true;
}

// Opening a project brings an older generated stub up to date, so a change in PLUT_OS reaches the
// project without a Repair. It is the one file PLUT_OS writes on opening a project, only in a
// project it already wired, and never a stub without the generated mark: that one is the owner's.
// Not a sweep at start-up (see the note above planInstalledProjectRepair): only the project opened.
export function healLauncherStub(targetPath) {
    const file = path.join(targetPath, '.plutos', PLUTOS_STUB);
    let text;
    try {
        if (!fs.lstatSync(file).isFile()) return false;
        text = fs.readFileSync(file, 'utf8');
    } catch { return false; }
    const stub = launcherStub();
    if (!text.startsWith(STUB_MARK) || text === stub) return false;
    try { fs.writeFileSync(file, stub, 'utf8'); } catch { return false; }
    return true;
}

// Keep project-local machine hints (and the signal config) out of git. Append-only, and never
// create a .gitignore for a non-git folder. local.json carries absolute paths; committed, it
// points teammates at directories that do not exist on their machines — the exact breakage
// the relative launcher plus stable per-user registry exist to avoid.
export const MACHINE_IGNORES = [
    `.plutos/${LOCAL_CONFIG_FILE}`, '.plutos/plutos.config.json',
    // Writer artifacts on the coordination files: the mutex dir (BOARD.md.lock/) and the
    // pre-rename temp file. Both are transient, but a process killed mid-write leaves
    // them behind until the next write cleans up — they must never show up as untracked
    // noise in the user's repo.
    'docs/handoff/*.lock/', 'docs/handoff/*.tmp',
    // A reclaimed stale lock becomes a permanent tombstone beside whatever file was locked,
    // and that is not only docs/handoff/ (IDEAS.md, .gitignore itself, .claude/settings.json).
    // Unlike the two above it never goes away on the next write, so match it anywhere.
    '*.lock.stale.*/',
    // Generated knowledge graphs (lib/graphify.mjs). Regenerated on demand from the code and
    // docs already in the repo, so committing them stores a second copy that goes stale — and
    // PLUT_OS ignores its own (.gitignore), which is no help to the user whose repo it writes
    // into. One click on Build used to leave up to six untracked files at their project root.
    'graphify-out/',
    // Generated indexes (lib/codeindex.mjs), rebuilt from the code on each machine. A committed
    // index goes stale in git, as PLUT_OS's own did (.gitignore); and Obsidian shards written
    // before their links went relative name every file by its absolute path until the next scan.
    'docs/ai/CODEINDEX.md', 'docs/ai/codeindex/', 'docs/ai/OBSIDIAN_INDEX.md', 'docs/ai/obsidian/',
    // The memory index (lib/memory-index.mjs): a cache rebuilt from the handoff files whenever they
    // change, with SQLite's -wal, -shm and -journal companions. Committed, it would be a stale copy.
    '.plutos/memory.db*'
];

// → { state: 'added'|'already'|'not-a-repo', entries: [...] }
// Reports instead of staying silent: the caller surfaces it, because a user who is never told
// cannot act on the one case PLUT_OS deliberately does not handle. Still never creates a
// .gitignore for a non-git folder — that would be littering someone's plain directory — but
// the repair pass re-runs this, so a project that becomes a repo LATER gets its entries then
// instead of quietly committing a machine path on its first push.
function writeMachineIgnores(targetPath, plan) {
    if (!fs.existsSync(path.join(targetPath, '.git'))) {
        return { state: 'not-a-repo', entries: MACHINE_IGNORES };
    }
    const file = path.join(targetPath, '.gitignore');
    let current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const missing = MACHINE_IGNORES.filter(e => !current.split(/\r?\n/).some(line => line.trim() === e));
    if (!missing.length) return { state: 'already', entries: [] };
    const block = (current && !current.endsWith('\n') ? '\n' : '')
        + '\n# PLUT_OS — machine-specific, never commit\n' + missing.join('\n') + '\n';
    persistWiring(file, current + block, plan);
    return { state: 'added', entries: missing };
}

// One wording for every surface that reports the ignore outcome (Add Project, Repair, CLI),
// so the owner reads the same sentence wherever it reaches them. Returns null when there is
// nothing worth saying — an already-ignored project is not news.
export function describeIgnores(ignores) {
    if (!ignores) return null;
    if (ignores.state === 'added') {
        return `Added to .gitignore (machine-specific, never commit): ${ignores.entries.join(', ')}`;
    }
    if (ignores.state === 'not-a-repo') {
        return 'This folder is not a git repository, so nothing was written to .gitignore. '
            + `If you run "git init" here later, add these lines yourself: ${ignores.entries.join(', ')} `
            + '— .plutos/local.json holds an absolute path to this machine and would break every other clone.';
    }
    return null;
}

// "Double-click to launch PLUT_OS targeting this project". Points at the stub via %~dp0, so
// the file is identical in every project on every machine.
function writeLauncherBat(targetPath, plan) {
    const stubRef = `%~dp0.plutos\\${PLUTOS_STUB}`;
    const batContent = [
        '@echo off',
        `if not exist "${stubRef}" (`,
        '    echo Error: .plutos\\' + PLUTOS_STUB + ' is missing.',
        '    echo Open PLUT_OS and select this project again to regenerate it.',
        '    pause',
        '    exit /b 1',
        ')',
        // No `start http://...` here any more: the dashboard opens the browser itself, once
        // the port is actually bound. Opening it from the launcher raced the server and, with
        // the packaged app (which also opens one), produced two tabs.
        `node "${stubRef}" --dashboard --open`,
        ''
    ].join('\r\n');
    const file = path.join(targetPath, 'PLUT_OS.bat');
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === batContent) return false;
    persistWiring(file, batContent, plan);
    return true;
}

// The POSIX twin of PLUT_OS.bat: same relative stub, same machine-independence. Marked
// executable so ./PLUT_OS.sh works from a terminal (and double-click where the DE allows).
function writeLauncherSh(targetPath, plan) {
    const shContent = [
        '#!/usr/bin/env bash',
        '# Generated by PLUT_OS — launches the dashboard targeting this project (Linux/macOS).',
        'DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
        `STUB="$DIR/.plutos/${PLUTOS_STUB}"`,
        'if [ ! -f "$STUB" ]; then',
        `    echo "Error: .plutos/${PLUTOS_STUB} is missing."`,
        '    echo "Open PLUT_OS and select this project again to regenerate it."',
        '    exit 1',
        'fi',
        // The dashboard opens the browser itself once it is actually listening — see the
        // matching note in writeLauncherBat.
        'exec node "$STUB" --dashboard --open',
        ''
    ].join('\n');
    const file = path.join(targetPath, 'PLUT_OS.sh');
    const changed = !fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== shContent;
    if (!changed) return false;
    persistWiring(file, shContent, plan, 0o755);
    return true;
}

// Everything a project needs to reach this install without recording where it is.
function writeMachineWiring(targetPath, plan) {
    const stubChanged = writeLauncherStub(targetPath, plan);
    const rootChanged = writeLocalConfig(targetPath, plan);
    const ignores = writeMachineIgnores(targetPath, plan);
    const batChanged = writeLauncherBat(targetPath, plan);
    const shChanged = writeLauncherSh(targetPath, plan);
    return { rootChanged, wiringChanged: stubChanged || batChanged || shChanged, ignores };
}

// Shared generators for a reviewable repair. Planning never writes to the project; callers
// must keep these private contents out of API responses and verify source snapshots at apply.
// The kit's rules files that PLUT_OS wrote and nobody edited since: an AGENTS.md that is a past
// kit version, and a CLAUDE.md or GEMINI.md that is the old text-only pointer. Each change carries
// the hash of the bytes it judged, so an edit made before the repair runs is never overwritten.
export function planKitRefresh(targetPath, { pastRules = PAST_KIT_RULES } = {}) {
    const read = relative => {
        const file = path.join(targetPath, relative);
        try {
            const stat = fs.lstatSync(file);
            if (!stat.isFile() || stat.size > 512 * 1024) return null;
            const bytes = fs.readFileSync(file);
            return { file, text: bytes.toString('utf8').replace(/\r\n/g, '\n'), basedOn: createHash('sha256').update(bytes).digest('hex') };
        } catch { return null; }
    };
    const changes = [];
    const agents = read('AGENTS.md');
    const current = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
    const past = agents && pastRules.includes(createHash('sha256').update(agents.text).digest('hex'));
    if (past && agents.text !== current.replace(/\r\n/g, '\n')) changes.push({ path: agents.file, content: current, basedOn: agents.basedOn });
    const ours = past || fileIsOurKit(path.join(targetPath, 'AGENTS.md'));
    for (const relative of ['CLAUDE.md', 'GEMINI.md', '.cursor/rules/plutos.mdc']) {
        const pointer = read(relative);
        if (pointer && pastPointers(relative, ours).includes(pointer.text)) {
            changes.push({ path: pointer.file, content: kitPointer(relative, ours), basedOn: pointer.basedOn });
        }
    }
    return changes;
}

export function planInstalledProjectRepair(targetPath) {
    const changes = planKitRefresh(targetPath);
    const result = writeMachineWiring(targetPath, changes);
    const file = path.join(targetPath, '.mcp.json');
    if (fs.existsSync(file)) {
        let config;
        try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
        catch { throw new Error('.mcp.json is not valid JSON; repair left it untouched.'); }
        if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('.mcp.json must be a JSON object.');
        const existing = config.mcpServers?.plutos;
        const current = configEntry(findClient('claude-code'), targetPath);
        if (existing && JSON.stringify(existing) !== JSON.stringify(current)) {
            config.mcpServers.plutos = current;
            changes.push({ path: file, content: JSON.stringify(config, null, 2) });
        }
    }
    return { ...result, changes };
}

// Explicit repair for installed projects. New launcher stubs resolve the current app through
// stable per-user install.json, so moving PLUT_OS no longer needs a startup write across every
// registered repository. This still migrates the PLUT_OS entry wired by older builds: legacy
// absolute-path "plutos" entries become the relative stub entry. Optional third-party MCPs
// are owner-managed extensions and are left byte-for-byte as configured.
// It runs only for an explicitly selected target; opening the dashboard never edits projects,
// and opening a project replaces only its generated launcher stub (healLauncherStub).
// Does this directory look like a PLUT_OS project — i.e. somewhere the coordinator may
// WRITE? The MCP server resolves its root from process.cwd(), which is only correct when
// the client launched it from the project (the per-project stub guarantees that; a global
// registration does not). Mutating tools check this marker and fail loudly instead of
// silently scaffolding boards into whatever directory the client happened to start in.
// True when the file carries ANY of our kit markers — the current comment or the legacy title.
export function fileIsOurKit(filePath) {
    return KIT_MARKERS.some(m => fileContainsMarker(filePath, m));
}

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

// Thin pointer files that make a tool load the rules itself. Claude Code reads AGENTS.md on its
// own only in a folder without a CLAUDE.md, and Gemini CLI only when its settings list it; both
// expand an `@file` line of their own file at session start. A pointer that said "read AGENTS.md
// first" loaded only itself. In a project that keeps its own
// AGENTS.md the pointer imports that file as well as the board protocol, so writing CLAUDE.md does
// not hide the project's own rules from Claude Code.
const IMPORT_PREFIX = { claude: '@', gemini: '@./' };
const kitTargets = agentsIsOurs => agentsIsOurs ? ['AGENTS.md'] : ['AGENTS.md', 'docs/handoff/PLUTOS_PROTOCOL.md'];
function pointerMarkdown(targets, tool) {
    return '# AI Agent Guide\n\nHow AI agents work in this project (shared board, roster, coordination rules):\n\n'
        + targets.map(target => `${IMPORT_PREFIX[tool]}${target}\n`).join('');
}
// The text-only pointer every kit wrote before imports: repair replaces it where it is unedited.
const legacyPointer = target => "# AI Agent Guide\n\n" +
    `This project is coordinated through **${target}** — read it for how AI\n` +
    `agents work here (shared board, roster, coordination rules). **Read \`${target}\` first.**\n`;
function pointerCursorRule(target = 'AGENTS.md') {
    return "---\ndescription: PLUT_OS coordination convention\nalwaysApply: true\n---\n\n" +
        `This project is coordinated through ${target} — the source of truth for AI agent\n` +
        `coordination (shared board, roster, rules). Read ${target} before acting.\n`;
}
// The first pointers (2026-07-22 to 2026-07-27, 94fe391 and c0d4d74) named AGENTS.md only and
// called it "the single source of truth"; nothing recognised them as the kit's until these lines.
const FIRST_POINTER = "# AI Agent Guide\n\n" +
    "This project is coordinated through **AGENTS.md** — the single source of truth for how AI\n" +
    "agents work here (shared board, roster, coordination rules). **Read `AGENTS.md` first.**\n";
const FIRST_CURSOR_RULE = "---\ndescription: PLUT_OS coordination convention\nalwaysApply: true\n---\n\n" +
    "This project is coordinated through AGENTS.md — the single source of truth for AI agent\n" +
    "coordination (shared board, roster, rules). Read AGENTS.md before acting.\n";

/** What today's kit writes at one of its pointer paths (CLAUDE.md, GEMINI.md, .cursor/rules/plutos.mdc). */
export function kitPointer(relative, agentsIsOurs) {
    const targets = kitTargets(agentsIsOurs);
    if (relative === '.cursor/rules/plutos.mdc') return pointerCursorRule(targets.at(-1));
    return pointerMarkdown(targets, relative === 'GEMINI.md' ? 'gemini' : 'claude');
}
/** Every text an older kit wrote at that pointer path and nobody edited since (LF line ends). */
export function pastPointers(relative, agentsIsOurs) {
    if (relative === '.cursor/rules/plutos.mdc') return [FIRST_CURSOR_RULE];
    return [FIRST_POINTER, legacyPointer(agentsIsOurs ? 'AGENTS.md' : 'docs/handoff/PLUTOS_PROTOCOL.md')];
}
function writePointerIfAbsent(filePath, body) {
    if (fs.existsSync(filePath)) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, body, 'utf8');
}

// The minimal, layout-agnostic protocol — everything an agent needs to join the board flow,
// in ~30 lines, sitting in the same folder as the boards it describes. Written only when the
// project keeps its own AGENTS.md (ours already contains all of this and more).
function writeProtocolFile(targetPath) {
    const dest = path.join(targetPath, 'docs', 'handoff', 'PLUTOS_PROTOCOL.md');
    if (fs.existsSync(dest)) return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, kitProtocolText(), 'utf8');
}

/** The board protocol today's kit writes to docs/handoff/PLUTOS_PROTOCOL.md. */
export function kitProtocolText() {
    const B = '`';
    return [
        '# PLUT_OS Board Protocol (minimal)',
        '',
        "This project keeps its own agent rules — this file adds ONLY the shared-board convention,",
        'so any AI working here can coordinate with the others. It assumes nothing about the',
        "project's structure; everything lives in this folder.",
        '',
        '## The files (all next to this one)',
        `- ${B}BOARD.md${B} — main board, boss tier: task assignment (TODO + **Assignee**), status, result refs.`,
        `- ${B}AGENT_BOARD.md${B} — worker tier: subagent findings, notes, ${B}❓ NOTE:${B} discussion.`,
        `- ${B}ROSTER.md${B} — every spawned agent registered (owner AI, role, memory path). You only task YOUR OWN agents.`,
        `- ${B}results/${B} — produced documents; board entries carry the path, never the content.`,
        `- ${B}CONTINUITY.md${B} — session memory (if the PLUT_OS MCP is wired, use ${B}session_start${B}/${B}session_end${B}).`,
        `- ${B}CONTEXT.json${B} — learned claims with source hashes. No evidence means unverified; changed/missing/drifted sources mean quarantined.`,
        '',
        '## The rules',
        '1. **Before working:** read BOARD.md — is a TODO assigned to you? Is someone already on it?',
        '2. **Starting:** upsert your entry, status IN_PROGRESS.',
        '3. **Finishing:** status DONE + one-line result + output path.',
        `4. **Conflict/dependency:** add ${B}❓ NOTE:${B} under the entry instead of proceeding blindly.`,
        '5. **Channel = git:** commit board updates so agents running later see them.',
        `6. **Claims are not facts by repetition:** in ${B}session_end.learned${B}, prefer ${B}{claim,sources:[{path,evidence}]}${B}; plain strings stay unverified.`,
        '',
        '## Entry format & budgets',
        B + B + B,
        '### <agent-name> · <TODO|IN_PROGRESS|DONE|BLOCKED> · <short title>',
        '- **Task:** <one line>',
        '- **Result / Output:** <one line when DONE>',
        B + B + B,
        '≤ 8 lines per entry · ≤ 10 active entries — detail goes to results/, not the board.',
        'Live files stay bounded. results/ and archive/ may grow on disk; they are not the next session\'s reading list.',
        ''
    ].join('\n');
}

// Explicit project-kit installer used by the CLI, init_roadmap, and the dashboard's
// separate Install Project Kit action. It copies the shared communication files, writes the
// launchers, optionally wires the Coordinator, detects map layout, and generates indexes.
// Dashboard Add Project never calls this function. Existing project files are preserved.
// Every file the kit may create, project-relative, so init can say which ones this run wrote.
export const KIT_FILES = ['AGENTS.md', 'docs/handoff/PLUTOS_PROTOCOL.md', 'CLAUDE.md', 'GEMINI.md', '.cursor/rules/plutos.mdc',
    '.claude/rules/plutos.md', 'docs/handoff/BOARD.md', 'docs/handoff/AGENT_BOARD.md', 'docs/handoff/ROSTER.md',
    'docs/handoff/PROJECT_INTERVIEW.md', 'docs/handoff/results/', '.plutos/plutos-launch.mjs', `.plutos/${LOCAL_CONFIG_FILE}`,
    '.plutos/plutos.config.json', 'PLUT_OS.bat', 'PLUT_OS.sh', 'docs/ai/CODEINDEX.md', 'docs/ai/codeindex/'];

// The first line of .claude/rules/plutos.md, which carries the protocol below it.
export const CLAUDE_RULE_HEADER = '<!-- Written by the PLUT_OS project kit because this project keeps its own CLAUDE.md. -->\n';

export function initTargetProject(targetPath, config = {}) {
    if (!targetPath) return;
    assertHandoffTemplatesAvailable(targetPath);
    const existedBefore = new Set(KIT_FILES.filter(f => fs.existsSync(path.join(targetPath, f))));
    const plutosDir = path.join(targetPath, '.plutos');
    if (!fs.existsSync(plutosDir)) {
        fs.mkdirSync(plutosDir, { recursive: true });
    }

    const targetAgentsPath = path.join(targetPath, 'AGENTS.md');
    if (!fs.existsSync(targetAgentsPath) && fs.existsSync(path.join(ROOT, 'AGENTS.md'))) {
        fs.copyFileSync(path.join(ROOT, 'AGENTS.md'), targetAgentsPath);
    }

    // THE UNIVERSAL GUARANTEE: the board layer must reach every project, whatever its
    // layout or stack. When the project has its OWN AGENTS.md we never touch it — but that
    // used to mean the board convention was never communicated to its agents at all
    // ("connected but protocol missing": boards on disk, nobody told to read them). Now a
    // compact protocol file lands NEXT TO the boards instead — additive, create-if-absent,
    // zero opinion about the project's folder structure. Detection is by content marker,
    // not existence: our own copied AGENTS.md doesn't need the duplicate.
    const agentsIsOurs = fileIsOurKit(targetAgentsPath);
    if (!agentsIsOurs) {
        writeProtocolFile(targetPath);
    }

    // Multi-format rule sync (Ruler-style): AGENTS.md is the source of truth, but not every AI
    // tool reads it — Claude Code reads CLAUDE.md, Gemini CLI reads GEMINI.md, Cursor reads
    // .cursor/rules/*.mdc. Drop a thin pointer for each so any of those tools discovers the
    // convention on its own. Create-if-absent ONLY: a project's own CLAUDE.md (user instructions)
    // is never touched — same "never overwrite existing" rule as every other file here.
    if (fs.existsSync(targetAgentsPath)) {
        const targets = kitTargets(agentsIsOurs);
        writePointerIfAbsent(path.join(targetPath, 'CLAUDE.md'), pointerMarkdown(targets, 'claude'));
        writePointerIfAbsent(path.join(targetPath, 'GEMINI.md'), pointerMarkdown(targets, 'gemini'));
        writePointerIfAbsent(path.join(targetPath, '.cursor', 'rules', 'plutos.mdc'), pointerCursorRule(targets.at(-1)));
    }
    // A project that keeps its own CLAUDE.md gets no pointer, and Claude Code then loads neither
    // AGENTS.md nor the board protocol (found in a test install, 2026-11-03). Its CLAUDE.md stays
    // untouched: the protocol goes in as a project rule instead, which Claude Code loads in every
    // session on its own (.claude/rules/, no import needed). Create-if-absent, like every file here.
    const ownClaude = path.join(targetPath, 'CLAUDE.md');
    if (fs.existsSync(ownClaude) && !/AGENTS\.md|PLUTOS_PROTOCOL/.test(fs.readFileSync(ownClaude, 'utf8'))) {
        writeProtocolFile(targetPath);
        const protocol = path.join(targetPath, 'docs', 'handoff', 'PLUTOS_PROTOCOL.md');
        if (fs.existsSync(protocol)) writePointerIfAbsent(path.join(targetPath, '.claude', 'rules', 'plutos.md'),
            CLAUDE_RULE_HEADER + fs.readFileSync(protocol, 'utf8'));
    }
    const targetHandoffDir = path.join(targetPath, 'docs', 'handoff');
    // results/ must exist regardless of whether BOARD.md is being copied — it used to be
    // created only alongside a fresh BOARD.md, so projects that already had a board never
    // got the results/ folder agents are told to write documents into.
    fs.mkdirSync(path.join(targetHandoffDir, 'results'), { recursive: true });
    const targetBoardPath = path.join(targetHandoffDir, 'BOARD.md');
    if (!fs.existsSync(targetBoardPath)) {
        const sourceBoardPath = path.join(HANDOFF_TEMPLATES_DIR, 'BOARD.md');
        if (fs.existsSync(sourceBoardPath)) {
            fs.copyFileSync(sourceBoardPath, targetBoardPath);
        }
    }

    // Council tier: agent board (subagent coordination) + roster (who exists, owned by whom)
    for (const councilFile of HANDOFF_TEMPLATE_FILES.slice(1)) {
        const dest = path.join(targetHandoffDir, councilFile);
        const src = path.join(HANDOFF_TEMPLATES_DIR, councilFile);
        if (!fs.existsSync(dest) && fs.existsSync(src)) {
            fs.mkdirSync(targetHandoffDir, { recursive: true });
            fs.copyFileSync(src, dest);
        }
    }

    // Project interview is OPT-IN: only dropped when the owner chose an interview-guided
    // setup. Existing/already-configured projects must not get interrogated by their AIs —
    // no file means AGENTS.md Rule 0 is skipped entirely. The dashboard Setup tab can
    // still start an interview later at the owner's initiative.
    if (config.withInterview) {
        const targetInterviewPath = path.join(targetHandoffDir, 'PROJECT_INTERVIEW.md');
        if (!fs.existsSync(targetInterviewPath)) {
            fs.mkdirSync(targetHandoffDir, { recursive: true });
            fs.writeFileSync(targetInterviewPath, renderInterview({}), 'utf8');
        }
    }

    const { ignores } = writeMachineWiring(targetPath);

    const structureOnly = config.structureOnly === true;
    // No client is wired here: choosing one is a second, visible decision (`plutos init --client
    // <id>`, `plutos connect`, the Connect panel), and lib/connect.mjs writes that client's
    // entry. The old Web vs General dropdown is gone — files determine the stack.

    const signals = scanProject(targetPath);
    const cfgPath = path.join(plutosDir, 'plutos.config.json');
    let existingCfg = {};
    if (fs.existsSync(cfgPath)) {
        try { existingCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) { existingCfg = {}; }
    }
    // Comparing content (rather than an "only if unset" guard) is what lets an already-configured
    // project gain the detected stack it never recorded; every other key is kept.
    const nextCfg = { ...existingCfg, stack: signals.stack, frameworks: signals.frameworks || [] };
    if (JSON.stringify(existingCfg) !== JSON.stringify(nextCfg)) {
        fs.writeFileSync(cfgPath, JSON.stringify(nextCfg, null, 2));
    }

    let maps = { rescanned: false };
    if (!config.skipGeneratedMaps) {
        maps = refreshIndexIfStale(targetPath);
    }

    // Reported, not just done: the caller turns this into something the owner can read.
    // The 'not-a-repo' case is the one that matters — PLUT_OS deliberately writes no
    // .gitignore there, so the entries are the owner's job if they run `git init` later.
    // `written` names what this run created; a file that was already there is left out, because
    // every write above is create-if-absent.
    const written = KIT_FILES.filter(f => !existedBefore.has(f) && fs.existsSync(path.join(targetPath, f)));
    return {
        ignores,
        maps,
        written,
        detected: {
            stack: signals.stack,
            frameworks: signals.frameworks || [],
            codeIndex: fs.existsSync(path.join(targetPath, 'docs', 'ai', 'CODEINDEX.md')),
            docs: fs.existsSync(path.join(targetPath, 'docs', 'handoff', 'BOARD.md'))
        }
    };
}
