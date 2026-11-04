// Explicit, previewed repair of one installed project. Private snapshots stay in the Hub;
// callers receive only paths/reasons and opaque ids, never config contents or credentials.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { acquireLock, updateFileAtomically } from './atomic.mjs';
import { HUB_CONFIG_DIR, getWorkspaces, isWorkspaceInstalled, planInstalledProjectRepair } from './workspaces.mjs';
import { sameProjectPath } from './project-binding.mjs';
import { WATCHER_FILES, watcherStatus, watcherScript, watcherScriptPath, planWatcherSettings } from './watcher.mjs';
import { withIgnoreLines, trackedWarning } from './context-automation.mjs';

const FILES = ['.plutos/local.json', '.plutos/plutos-launch.mjs', 'PLUT_OS.bat', 'PLUT_OS.sh',
    '.gitignore', '.mcp.json', '.claude/settings.local.json', '.plutos/plutos-watcher.cjs', '.plutos/plutos-watcher.sh'];
// The kit's rules files are read only when the plan refreshes one (an unedited older copy): a
// project's own CLAUDE.md may be a link or large, and must not make the whole repair refuse.
const KIT_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.cursor/rules/plutos.mdc'];
const REPAIRABLE = [...FILES, ...KIT_FILES];
const FILE_LIMIT = 512 * 1024;
const SNAPSHOT_LIMIT = 2 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const modeFor = mode => process.platform === 'win32' ? (mode & 0o200 ? 0o666 : 0o444) : mode;

function projectFor(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('Select an explicit absolute project path.');
    const root = fs.realpathSync(value);
    if (!getWorkspaces().some(registered => sameProjectPath(registered, root))) throw new Error('Registered workspace not found.');
    if (!isWorkspaceInstalled(root)) throw new Error('This project is observe-only. Install its Project Kit before repairing links.');
    return root;
}

// Reject links and junctions at every level, including a link introduced after preview.
function safePath(root, relative) {
    const realRoot = fs.realpathSync(root);
    const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
    if (fs.lstatSync(root).isSymbolicLink() || key(realRoot) !== key(path.resolve(root))) throw new Error('Repair root was replaced or redirected.');
    const parts = relative.split('/');
    if (!relative || parts.some(part => !part || part === '.' || part === '..' || part.includes('\\')) || path.isAbsolute(relative)) {
        throw new Error('Invalid repair path.');
    }
    let current = root;
    for (const [index, part] of parts.entries()) {
        current = path.join(current, part);
        let stat;
        try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (stat.isSymbolicLink()) throw new Error(`Repair refuses a symbolic link or junction: ${relative}`);
        const resolved = fs.realpathSync(current);
        const within = path.relative(root, resolved);
        if (within.startsWith('..') || path.isAbsolute(within)) throw new Error(`Repair path escapes its root: ${relative}`);
        if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`Repair path has a non-directory parent: ${relative}`);
    }
    return current;
}

function readBounded(file, limit) {
    const fd = fs.openSync(file, 'r');
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > limit) throw new Error(`Repair requires a regular file within its size budget: ${path.basename(file)}`);
        const buffer = Buffer.alloc(stat.size + 1);
        const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
        if (length !== stat.size || fs.fstatSync(fd).size !== stat.size) throw new Error('Repair input changed while reading; try again.');
        return { bytes: buffer.subarray(0, length), stat };
    } finally { fs.closeSync(fd); }
}
function snapshot(root, relative) {
    const file = safePath(root, relative);
    let bytes, stat;
    try { ({ bytes, stat } = readBounded(file, FILE_LIMIT)); }
    catch (error) { if (error.code === 'ENOENT') return { exists: false }; throw error; }
    return { exists: true, data: bytes.toString('base64'), hash: hash(bytes), mode: stat.mode & 0o777 };
}
function sameSnapshot(a, b) { return a.exists === b.exists && (!a.exists || (a.hash === b.hash && a.mode === b.mode)); }
function gitPresence(root) {
    const file = safePath(root, '.git');
    if (!fs.existsSync(file)) return 'missing';
    return fs.statSync(file).isDirectory() ? 'directory' : 'file';
}
function inspect(root, list = FILES) {
    const files = Object.fromEntries(list.map(relative => [relative, snapshot(root, relative)]));
    if (Object.values(files).reduce((sum, item) => sum + (item.data?.length || 0), 0) > SNAPSHOT_LIMIT * 4 / 3) {
        throw new Error('Repair input exceeds the 2 MiB snapshot budget.');
    }
    return { files, git: gitPresence(root) };
}
function verifyInputs(root, expected) {
    const list = Object.keys(expected.files);
    const current = inspect(root, list);
    if (current.git !== expected.git || list.some(relative => !sameSnapshot(current.files[relative], expected.files[relative]))) {
        throw new Error('Repair preview is stale: project configuration changed. Preview again.');
    }
}
function desired(content, mode = 0o666) {
    if (content === null) return { exists: false };
    const bytes = Buffer.from(content, 'utf8');
    return { exists: true, data: bytes.toString('base64'), hash: hash(bytes), mode: modeFor(mode) };
}

function storeFor(root) {
    fs.mkdirSync(HUB_CONFIG_DIR, { recursive: true });
    const hub = fs.realpathSync(HUB_CONFIG_DIR);
    const key = hash(process.platform === 'win32' ? root.toLowerCase() : root).slice(0, 24);
    const store = safePath(hub, `repairs/${key}`);
    fs.mkdirSync(store, { recursive: true, mode: 0o700 });
    return store;
}
function tokenDir(store, token) {
    if (typeof token !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(token)) throw new Error('Invalid repair token.');
    return safePath(store, token);
}
function writeRecord(dir, name, record) {
    const file = safePath(dir, name);
    updateFileAtomically(file, () => ({ content: JSON.stringify(record), result: null }));
    fs.chmodSync(file, 0o600);
}
function readRecord(dir, name, max = 8 * 1024 * 1024) {
    const file = safePath(dir, name);
    return JSON.parse(readBounded(file, max).bytes.toString('utf8'));
}
function backupList(root, store) {
    const records = [];
    for (const name of fs.readdirSync(store)) {
        if (!/^[\da-f-]{36}$/.test(name)) continue;
        try {
            const dir = tokenDir(store, name);
            const receipt = readRecord(dir, 'receipt.json', 32 * 1024);
            if (receipt.projectRoot === root && receipt.phase !== 'restored') records.push(receipt);
        } catch { /* absent/incomplete records cannot be offered as a usable backup */ }
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5)
        .map(({ backupId, createdAt, changed }) => ({ backupId, createdAt, changed }));
}

// An existing watcher's upgrade, planned from the seat and port its old script records.
// → false when those cannot be recovered; the watcher is then left as it is.
function planWatcherUpgrade(root, inputs, planned, warnings) {
    let defaults;
    for (const relative of ['.plutos/plutos-watcher.cjs', '.plutos/plutos-watcher.sh']) {
        try {
            const body = Buffer.from(inputs.files[relative].data || '', 'base64').toString('utf8');
            const match = /^const DEFAULTS = (\{[\s\S]*?\});/m.exec(body);
            const candidate = JSON.parse(match?.[1] || 'null');
            const board = new URL(candidate?.board);
            const port = Number(board.port || (board.protocol === 'http:' ? 80 : 0));
            if (typeof candidate.agent === 'string' && candidate.agent.trim() && candidate.agent.length <= 100
                && board.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(board.hostname)
                && board.pathname === '/api/board' && port > 0 && port <= 65535) {
                defaults = { agent: candidate.agent, port }; break;
            }
        } catch { /* An old or custom script is data, never something to execute. */ }
    }
    if (!defaults) { warnings.push('Watcher seat/port could not be recovered; watcher repair skipped. Use Board → Update watcher.'); return false; }
    const settings = Buffer.from(inputs.files['.claude/settings.local.json'].data, 'base64').toString('utf8');
    planned.set('.claude/settings.local.json', { content: planWatcherSettings(settings, watcherScriptPath(root), true).content });
    planned.set('.plutos/plutos-watcher.cjs', { content: watcherScript(defaults.agent, defaults.port, root), mode: 0o755 });
    if (inputs.files['.plutos/plutos-watcher.sh'].exists) planned.set('.plutos/plutos-watcher.sh', { content: null });
    return true;
}

function addWatcher(root, inputs, planned, warnings) {
    const status = watcherStatus(root);
    if (status.error) { warnings.push('Watcher settings could not be read; watcher repair skipped. Use Board → Update watcher.'); return; }
    if (!status.installed && !status.needsUpgrade) return;
    if (status.needsUpgrade && !planWatcherUpgrade(root, inputs, planned, warnings)) return;
    // The same lines setWatcher adds, so a watcher installed before its script was ignored gets
    // them here too, healthy or not.
    if (inputs.git !== 'missing') {
        const current = planned.get('.gitignore')?.content ?? Buffer.from(inputs.files['.gitignore'].data || '', 'base64').toString('utf8');
        const next = withIgnoreLines(current, WATCHER_FILES);
        if (next !== null) planned.set('.gitignore', { content: next });
    }
    const tracked = trackedWarning(root, WATCHER_FILES);
    if (tracked) warnings.push(tracked);
}

export function previewProjectRepair(targetPath) {
    const projectRoot = projectFor(targetPath);
    const inputs = inspect(projectRoot);
    const plan = planInstalledProjectRepair(projectRoot);
    const planned = new Map(plan.changes.map(change => [path.relative(projectRoot, change.path).split(path.sep).join('/'), change]));
    for (const [relative, change] of planned) {
        if (!KIT_FILES.includes(relative)) continue;
        inputs.files[relative] = snapshot(projectRoot, relative);
        if (inputs.files[relative].hash !== change.basedOn) throw new Error('Repair preview is stale: project configuration changed. Preview again.');
    }
    const warnings = [];
    addWatcher(projectRoot, inputs, planned, warnings);
    const changes = [];
    for (const [relative, change] of planned) {
        if (!REPAIRABLE.includes(relative) || !inputs.files[relative]) throw new Error('Repair generator produced an unsupported path.');
        const before = inputs.files[relative];
        const after = desired(change.content, change.mode || before.mode || 0o666);
        if (sameSnapshot(before, after)) continue;
        const action = !after.exists ? 'delete' : before.exists ? 'update' : 'create';
        const reason = relative.includes('watcher') || relative.includes('settings.local') ? 'Upgrade the existing project watcher'
            : relative === '.mcp.json' ? 'Refresh the existing PLUT_OS MCP link'
                : relative === '.gitignore' ? 'Ignore machine-specific PLUT_OS files'
                    : KIT_FILES.includes(relative) ? 'Replace an unedited copy of older PLUT_OS rules'
                        : 'Refresh the PLUT_OS launcher or machine-local link';
        changes.push({ path: relative, action, reason, after });
    }
    verifyInputs(projectRoot, inputs);
    const token = randomUUID();
    const store = storeFor(projectRoot);
    const dir = tokenDir(store, token);
    fs.mkdirSync(dir, { mode: 0o700 });
    const createdAt = new Date().toISOString();
    writeRecord(dir, 'plan.json', { projectRoot, token, createdAt, inputs, changes, warnings });
    return { projectRoot, token, createdAt, changes: changes.map(({ after, ...change }) => change), warnings,
        noOp: !changes.length, backups: backupList(projectRoot, store) };
}

function writeSnapshot(root, relative, expected, next) {
    const file = safePath(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const unlock = acquireLock(file);
    let temp;
    try {
        if (!sameSnapshot(snapshot(root, relative), expected)) throw new Error(`Configuration changed while repairing ${relative}.`);
        if (!next.exists) fs.unlinkSync(file);
        else {
            temp = safePath(root, `${relative}.repair-${randomUUID()}.tmp`);
            fs.writeFileSync(temp, Buffer.from(next.data, 'base64'), { mode: next.mode });
            if (!sameSnapshot(snapshot(root, relative), expected)) throw new Error(`Configuration changed while repairing ${relative}.`);
            safePath(root, relative);
            fs.renameSync(temp, file);
            temp = null;
            fs.chmodSync(file, next.mode);
        }
        if (!sameSnapshot(snapshot(root, relative), next)) throw new Error(`Repair verification failed for ${relative}.`);
    } finally {
        if (temp) try { fs.unlinkSync(temp); } catch { /* preserve the original failure */ }
        unlock();
    }
}
function receipt(plan, backupId, phase) {
    return { projectRoot: plan.projectRoot, backupId, createdAt: plan.backupCreatedAt || plan.createdAt, changed: plan.changes.map(change => change.path), phase };
}
function finalizeReceipt(dir, value, errors) {
    try { writeRecord(dir, 'receipt.json', value); }
    catch (error) {
        errors.push({ message: `Repair receipt could not be finalized: ${error.message}` });
        // chmod can fail after the rename succeeded. Keep that incomplete finalization
        // discoverable instead of hiding its backup behind an already-written "restored".
        if (value.phase === 'restored') {
            try { writeRecord(dir, 'receipt.json', { ...value, phase: 'restore-failed' }); }
            catch { /* The structured result still carries the durable backup id. */ }
        }
    }
}
function loadBoundPlan(root, store, id, filename) {
    const dir = tokenDir(store, id);
    const plan = readRecord(dir, filename);
    if (plan.projectRoot !== root || plan.token !== id || !Array.isArray(plan.changes)
        || plan.changes.some(change => !REPAIRABLE.includes(change.path))) throw new Error('Repair token belongs to another project or is invalid.');
    return { dir, plan };
}

export function applyProjectRepair({ projectRoot, token } = {}) {
    const root = projectFor(projectRoot), store = storeFor(root);
    const unlock = acquireLock(path.join(store, 'project'));
    try {
        const { dir, plan } = loadBoundPlan(root, store, token, 'plan.json');
        if (fs.existsSync(safePath(dir, 'backup.json'))) throw new Error('This repair preview was already applied. Preview again.');
        verifyInputs(root, plan.inputs);
        if (!plan.changes.length) return { success: true, projectRoot: root, backupId: null, changed: [], errors: [], warnings: plan.warnings, restoreAvailable: false, noOp: true };
        const backup = { ...plan, backupCreatedAt: new Date().toISOString() };
        writeRecord(dir, 'backup.json', backup); // Durable backup before the first project write.
        writeRecord(dir, 'receipt.json', receipt(backup, token, 'applying'));
        const changed = [], errors = [];
        try {
            for (const change of plan.changes) {
                writeSnapshot(root, change.path, plan.inputs.files[change.path], change.after);
                changed.push(change.path);
            }
            const expected = { ...plan.inputs, files: { ...plan.inputs.files } };
            for (const change of plan.changes) expected.files[change.path] = change.after;
            verifyInputs(root, expected);
        } catch (error) { errors.push({ message: error.message }); }
        finalizeReceipt(dir, receipt(backup, token, errors.length ? 'failed' : 'applied'), errors);
        return { success: !errors.length, projectRoot: root, backupId: token, changed, errors, warnings: plan.warnings, restoreAvailable: true, noOp: false };
    } finally { unlock(); }
}

export function restoreProjectRepair({ projectRoot, backupId } = {}) {
    const root = projectFor(projectRoot), store = storeFor(root);
    const unlock = acquireLock(path.join(store, 'project'));
    try {
        const { dir, plan } = loadBoundPlan(root, store, backupId, 'backup.json');
        const restore = [];
        for (const change of plan.changes) {
            const current = snapshot(root, change.path), before = plan.inputs.files[change.path];
            if (sameSnapshot(current, before)) continue; // Already restored, or never applied.
            if (!sameSnapshot(current, change.after)) throw new Error(`Restore refused: ${change.path} changed after repair. Keep the newer edit; restore it manually if needed.`);
            restore.push({ path: change.path, current, before });
        }
        const restored = [], errors = [];
        try {
            for (const item of restore) {
                writeSnapshot(root, item.path, item.current, item.before);
                restored.push(item.path);
            }
            for (const change of plan.changes) {
                if (!sameSnapshot(snapshot(root, change.path), plan.inputs.files[change.path])) {
                    throw new Error(`Restore verification failed for ${change.path}; a later edit was preserved.`);
                }
            }
        } catch (error) { errors.push({ message: error.message }); }
        finalizeReceipt(dir, receipt(plan, backupId, errors.length ? 'restore-failed' : 'restored'), errors);
        return { success: !errors.length, projectRoot: root, backupId, restored, changed: restored, errors,
            warnings: plan.warnings, restoreAvailable: !!errors.length };
    } finally { unlock(); }
}
