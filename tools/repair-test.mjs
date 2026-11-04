// Preview/apply/restore only synthetic registered projects in an isolated Hub.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-repair-'));
process.env.PLUTOS_HOME = path.join(tmp, 'hub');
process.env.HOME = process.env.USERPROFILE = path.join(tmp, 'user');
process.env.APPDATA = path.join(tmp, 'user', 'AppData');
const workspaces = await import('../lib/workspaces.mjs');
const repair = await import('../lib/repair.mjs');
const watcher = await import('../lib/watcher.mjs');
const { configEntry, findClient } = await import('../lib/connect.mjs');
let passed = 0, failed = 0;
const KIT = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];
const foreign = { command: 'foreign-client', env: { PRIVATE_KEY: 'private-fixture-value' }, args: ['keep', 'exactly'] };
function write(root, relative, content) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
}
function project(name, { installed = true, git = true } = {}) {
    const root = path.join(tmp, name);
    fs.mkdirSync(root);
    if (installed) write(root, 'AGENTS.md', '<!-- plutos:kit -->\n');
    if (git) fs.mkdirSync(path.join(root, '.git'));
    workspaces.addWorkspace(root);
    return root;
}
function tree(root) {
    const out = {};
    const visit = relative => {
        for (const item of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
            const next = path.join(relative, item.name);
            if (item.isDirectory()) { out[next + '/'] = true; visit(next); }
            else out[next] = fs.readFileSync(path.join(root, next)).toString('base64');
        }
    };
    visit('');
    return out;
}
function legacy(root) {
    write(root, '.plutos/local.json', { plutosRoot: 'old-install', keepLocal: 'preserved' });
    write(root, '.mcp.json', { mcpServers: { plutos: { command: 'old-plutos' }, foreign }, disabledMcpServers: { other: foreign }, extra: 'preserve' });
    write(root, '.gitignore', 'my-output/\n');
}
async function test(name, run) {
    try { await run(); passed++; console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack}`); }
}

try {
    const a = project('A'), b = project('B');
    legacy(a);
    let preview, applied;
    const before = tree(a);
    await test('preview is source-read-only and exposes no private config content', () => {
        preview = repair.previewProjectRepair(a);
        assert.deepEqual(tree(a), before);
        assert.equal(preview.projectRoot, fs.realpathSync(a));
        assert(preview.changes.length > 0);
        assert(preview.changes.every(change => change.path && change.action && change.reason));
        assert(!JSON.stringify(preview).includes('private-fixture-value'));
    });
    await test('apply targets the previewed project despite a dashboard switch and preserves foreign settings', () => {
        workspaces.switchWorkspace(b);
        const bBefore = tree(b);
        applied = repair.applyProjectRepair({ projectRoot: a, token: preview.token });
        assert.equal(applied.success, true, JSON.stringify(applied));
        assert.equal(applied.restoreAvailable, true);
        assert.deepEqual(tree(b), bBefore);
        assert.equal(workspaces.getActiveWorkspace(), b);
        const config = JSON.parse(fs.readFileSync(path.join(a, '.mcp.json'), 'utf8'));
        assert.deepEqual(config.mcpServers.foreign, foreign);
        assert.deepEqual(config.disabledMcpServers.other, foreign);
        assert.deepEqual(config.mcpServers.plutos, configEntry(findClient('claude-code'), a));
        assert.equal(JSON.parse(fs.readFileSync(path.join(a, '.plutos/local.json'), 'utf8')).keepLocal, 'preserved');
        assert.throws(() => repair.applyProjectRepair({ projectRoot: b, token: preview.token }));
    });
    await test('a repaired project previews as a no-op and does not create another backup', () => {
        const next = repair.previewProjectRepair(a);
        assert.equal(next.noOp, true);
        assert.equal(next.backups[0].backupId, applied.backupId);
        const result = repair.applyProjectRepair({ projectRoot: a, token: next.token });
        assert.equal(result.success, true);
        assert.equal(result.backupId, null);
        assert.equal(result.restoreAvailable, false);
    });
    await test('backup discovery survives a fresh process', () => {
        const source = `const api = await import(${JSON.stringify(new URL('../lib/repair.mjs', import.meta.url).href)});
            console.log(JSON.stringify(api.previewProjectRepair(${JSON.stringify(a)}).backups));`;
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 10000, windowsHide: true });
        assert.equal(child.status, 0, child.stderr);
        assert.equal(JSON.parse(child.stdout)[0].backupId, applied.backupId);
    });
    await test('restore recovers original bytes and removes only repair-created files', () => {
        const result = repair.restoreProjectRepair({ projectRoot: a, backupId: applied.backupId });
        assert.equal(result.success, true, JSON.stringify(result));
        const after = tree(a);
        for (const [file, value] of Object.entries(before)) assert.equal(after[file], value, file);
        assert(!fs.existsSync(path.join(a, 'PLUT_OS.bat')));
        assert(!fs.existsSync(path.join(a, '.plutos/plutos-launch.mjs')));
        assert.equal(repair.previewProjectRepair(a).backups.length, 0);
    });
    await test('configuration edits after preview reject the entire plan before writes', () => {
        const root = project('stale'); legacy(root);
        const plan = repair.previewProjectRepair(root);
        write(root, '.mcp.json', { mcpServers: { foreign } });
        const edited = tree(root);
        assert.throws(() => repair.applyProjectRepair({ projectRoot: root, token: plan.token }), /stale/);
        assert.deepEqual(tree(root), edited);
    });
    for (const addition of ['.mcp.json', '.git']) {
        await test(`negative ${addition} existence is part of the preview token`, () => {
            const root = project(`negative-${addition.slice(1)}`, { git: false });
            const plan = repair.previewProjectRepair(root);
            if (addition === '.git') fs.mkdirSync(path.join(root, addition)); else write(root, addition, '{}');
            const edited = tree(root);
            assert.throws(() => repair.applyProjectRepair({ projectRoot: root, token: plan.token }), /stale/);
            assert.deepEqual(tree(root), edited);
        });
    }
    await test('restore refuses newer edits before restoring any file', () => {
        const root = project('external-edit'); legacy(root);
        const plan = repair.previewProjectRepair(root);
        const result = repair.applyProjectRepair({ projectRoot: root, token: plan.token });
        write(root, '.mcp.json', { importantNewSetting: true });
        const edited = tree(root);
        assert.throws(() => repair.restoreProjectRepair({ projectRoot: root, backupId: result.backupId }), /changed after repair/);
        assert.deepEqual(tree(root), edited);
    });
    await test('partial write failure is not success and leaves a usable backup', () => {
        const root = project('failure'); legacy(root);
        const original = tree(root), plan = repair.previewProjectRepair(root);
        const rename = fs.renameSync;
        let result;
        fs.renameSync = (source, target) => {
            if (target === path.join(root, 'PLUT_OS.bat')) throw new Error('Synthetic write failure');
            return rename(source, target);
        };
        try { result = repair.applyProjectRepair({ projectRoot: root, token: plan.token }); }
        finally { fs.renameSync = rename; }
        assert.equal(result.success, false);
        assert(result.errors[0].message.includes('Synthetic write failure'));
        assert.equal(result.restoreAvailable, true);
        assert.equal(repair.restoreProjectRepair({ projectRoot: root, backupId: result.backupId }).success, true);
        const restored = tree(root);
        for (const [file, value] of Object.entries(original)) assert.equal(restored[file], value, file);
    });
    await test('apply receipt failure preserves structured recovery details after project writes', () => {
        const root = project('apply-receipt-failure'); legacy(root);
        const plan = repair.previewProjectRepair(root), rename = fs.renameSync;
        let receipts = 0, result;
        fs.renameSync = (source, target) => {
            if (path.basename(target) === 'receipt.json' && path.basename(path.dirname(target)) === plan.token && ++receipts === 2) {
                throw new Error('Synthetic final apply receipt failure');
            }
            return rename(source, target);
        };
        try { result = repair.applyProjectRepair({ projectRoot: root, token: plan.token }); }
        finally { fs.renameSync = rename; }
        assert.equal(result.success, false);
        assert.equal(result.backupId, plan.token);
        assert.equal(result.restoreAvailable, true);
        assert(result.errors.some(error => error.message.includes('Synthetic final apply receipt failure')));
        assert(fs.existsSync(path.join(root, 'PLUT_OS.bat')));
        assert(repair.previewProjectRepair(root).backups.some(backup => backup.backupId === plan.token));
        assert.equal(repair.restoreProjectRepair({ projectRoot: root, backupId: plan.token }).success, true);
    });
    await test('restore receipt failure preserves structured recovery details and backup discovery', () => {
        const root = project('restore-receipt-failure'); legacy(root);
        const original = tree(root), plan = repair.previewProjectRepair(root);
        repair.applyProjectRepair({ projectRoot: root, token: plan.token });
        const rename = fs.renameSync;
        let result;
        fs.renameSync = (source, target) => {
            if (path.basename(target) === 'receipt.json' && path.basename(path.dirname(target)) === plan.token) {
                throw new Error('Synthetic final restore receipt failure');
            }
            return rename(source, target);
        };
        try { result = repair.restoreProjectRepair({ projectRoot: root, backupId: plan.token }); }
        finally { fs.renameSync = rename; }
        assert.equal(result.success, false);
        assert.equal(result.backupId, plan.token);
        assert.equal(result.restoreAvailable, true);
        assert(result.errors.some(error => error.message.includes('Synthetic final restore receipt failure')));
        const restored = tree(root);
        for (const [file, value] of Object.entries(original)) assert.equal(restored[file], value, file);
        assert(repair.previewProjectRepair(root).backups.some(backup => backup.backupId === plan.token));
        assert.equal(repair.restoreProjectRepair({ projectRoot: root, backupId: plan.token }).success, true);
    });
    await test('restore post-check catches a later edit to an earlier restored file without overwriting it', () => {
        const root = project('restore-drift'); legacy(root);
        const plan = repair.previewProjectRepair(root);
        repair.applyProjectRepair({ projectRoot: root, token: plan.token });
        const localFile = path.join(root, '.plutos/local.json'), rename = fs.renameSync;
        const newer = JSON.stringify({ plutosRoot: 'newer-agent-edit', keepLocal: 'preserved' });
        let localRestored = false, injected = false, result;
        fs.renameSync = (source, target) => {
            const value = rename(source, target);
            if (target === localFile) localRestored = true;
            else if (localRestored && !injected && target.startsWith(root + path.sep)) {
                fs.writeFileSync(localFile, newer);
                injected = true;
            }
            return value;
        };
        try { result = repair.restoreProjectRepair({ projectRoot: root, backupId: plan.token }); }
        finally { fs.renameSync = rename; }
        assert.equal(injected, true);
        assert.equal(result.success, false);
        assert.equal(result.restoreAvailable, true);
        assert(result.errors.some(error => error.message.includes('.plutos/local.json')));
        assert.equal(fs.readFileSync(localFile, 'utf8'), newer);
        assert(repair.previewProjectRepair(root).backups.some(backup => backup.backupId === plan.token));
    });
    await test('a receipt error after rename cannot hide the backup as successfully restored', () => {
        const root = project('restore-receipt-mode-failure'); legacy(root);
        const plan = repair.previewProjectRepair(root);
        repair.applyProjectRepair({ projectRoot: root, token: plan.token });
        const chmod = fs.chmodSync;
        let result;
        fs.chmodSync = (file, mode) => {
            if (path.basename(file) === 'receipt.json' && path.basename(path.dirname(file)) === plan.token) {
                throw new Error('Synthetic receipt permissions failure');
            }
            return chmod(file, mode);
        };
        try { result = repair.restoreProjectRepair({ projectRoot: root, backupId: plan.token }); }
        finally { fs.chmodSync = chmod; }
        assert.equal(result.success, false);
        assert.equal(result.restoreAvailable, true);
        assert.equal(result.backupId, plan.token);
        assert(result.errors.some(error => error.message.includes('Synthetic receipt permissions failure')));
        assert(repair.previewProjectRepair(root).backups.some(backup => backup.backupId === plan.token));
    });
    await test('only existing watchers upgrade, preserving recovered seat/port and foreign hooks', () => {
        const root = project('watcher'); legacy(root);
        watcher.setWatcher(root, true, { agent: 'Custom seat', port: 3456 });
        const file = watcher.watcherScriptPath(root);
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace("if (watcherProjectKey(board?.projectRoot) !== PROJECT_KEY) process.exit(0);", ''));
        const settingsFile = path.join(root, '.claude/settings.local.json');
        const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        settings.hooks.Stop[0].hooks.push({ type: 'command', command: 'foreign-hook' });
        write(root, '.claude/settings.local.json', settings);
        const plan = repair.previewProjectRepair(root);
        assert(plan.changes.some(change => change.path === '.plutos/plutos-watcher.cjs'));
        assert.equal(repair.applyProjectRepair({ projectRoot: root, token: plan.token }).success, true);
        assert.equal(watcher.watcherStatus(root).installed, true);
        const body = fs.readFileSync(file, 'utf8');
        assert(body.includes('Custom seat') && body.includes('3456'));
        assert(fs.readFileSync(settingsFile, 'utf8').includes('foreign-hook'));
        assert(!repair.previewProjectRepair(b).changes.some(change => change.path.includes('watcher') || change.path.includes('.claude')));
    });
    await test('a watcher installed before its script was ignored gets the line; a tracked script is reported, not untracked', () => {
        const root = project('watcher-ignore', { git: false });
        const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
        assert.equal(git('init', '-q').status, 0);
        watcher.setWatcher(root, true, { agent: 'Claude', port: 3040 });
        write(root, '.gitignore', '.claude/settings.local.json\n');   // all an older PLUT_OS ignored
        const plan = repair.previewProjectRepair(root);
        assert(!plan.changes.some(change => change.path.includes('watcher')), 'a healthy watcher is not rewritten');
        assert.equal(repair.applyProjectRepair({ projectRoot: root, token: plan.token }).success, true);
        assert(fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/).includes('.plutos/plutos-watcher.cjs'));
        assert.equal(repair.previewProjectRepair(root).noOp, true);
        assert.equal(git('add', '-f', '.plutos/plutos-watcher.cjs').status, 0);
        const tracked = repair.previewProjectRepair(root);
        assert(tracked.noOp && tracked.warnings.some(warning => warning.includes('git rm --cached .plutos/plutos-watcher.cjs')), JSON.stringify(tracked.warnings));
        assert.equal(git('ls-files', '.plutos/plutos-watcher.cjs').stdout.trim(), '.plutos/plutos-watcher.cjs');
    });
    await test('unknown legacy watcher options warn and remain untouched', () => {
        const root = project('legacy-watcher');
        write(root, '.plutos/plutos-watcher.sh', 'custom legacy body');
        write(root, '.claude/settings.local.json', { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'bash .plutos/plutos-watcher.sh' }] }] } });
        const plan = repair.previewProjectRepair(root);
        assert(plan.warnings.some(warning => warning.includes('could not be recovered')));
        assert(!plan.changes.some(change => change.path.includes('watcher') || change.path.includes('.claude')));
    });
    await test('malformed foreign configuration, observe-only roots and relative paths are refused', () => {
        const root = project('malformed'); write(root, '.mcp.json', '{broken');
        const before = tree(root);
        assert.throws(() => repair.previewProjectRepair(root), /valid JSON/);
        assert.deepEqual(tree(root), before);
        assert.throws(() => repair.previewProjectRepair(project('observed', { installed: false })), /observe-only/);
        assert.throws(() => repair.previewProjectRepair('.'), /absolute/);
    });
    await test('a source junction cannot redirect repair outside its project', () => {
        const root = project('redirected'), outside = path.join(tmp, 'outside');
        fs.mkdirSync(outside);
        fs.symlinkSync(outside, path.join(root, '.plutos'), process.platform === 'win32' ? 'junction' : 'dir');
        assert.throws(() => repair.previewProjectRepair(root), /link|junction|redirect/);
        assert.equal(fs.readdirSync(outside).length, 0);
    });
    await test('a junction introduced after preview cannot redirect apply', () => {
        const root = project('redirected-after-preview'), outside = path.join(tmp, 'outside-after-preview');
        const plan = repair.previewProjectRepair(root);
        fs.mkdirSync(outside);
        fs.symlinkSync(outside, path.join(root, '.plutos'), process.platform === 'win32' ? 'junction' : 'dir');
        assert.throws(() => repair.applyProjectRepair({ projectRoot: root, token: plan.token }), /link|junction|redirect/);
        assert.equal(fs.readdirSync(outside).length, 0);
    });
    await test('a redirected private token directory cannot receive backup writes', () => {
        const root = project('redirected-token'), outside = path.join(tmp, 'outside-token');
        const plan = repair.previewProjectRepair(root);
        const stores = path.join(process.env.PLUTOS_HOME, 'repairs');
        const store = fs.readdirSync(stores).map(name => path.join(stores, name)).find(dir => fs.existsSync(path.join(dir, plan.token)));
        const dir = path.join(store, plan.token);
        fs.renameSync(dir, dir + '-saved');
        fs.mkdirSync(outside);
        fs.symlinkSync(outside, dir, process.platform === 'win32' ? 'junction' : 'dir');
        assert.throws(() => repair.applyProjectRepair({ projectRoot: root, token: plan.token }), /link|junction|redirect/);
        assert.equal(fs.readdirSync(outside).length, 0);
    });
    await test('oversized config inputs refuse preview without source writes', () => {
        const root = project('oversized');
        write(root, '.mcp.json', 'x'.repeat(512 * 1024 + 1));
        const before = tree(root);
        assert.throws(() => repair.previewProjectRepair(root), /size budget/);
        assert.deepEqual(tree(root), before);
    });
    // --- The kit's rules: unedited old copies are refreshed, everything else is the owner's ---
    const sha = text => createHash('sha256').update(text).digest('hex');
    const oldPointer = target => '# AI Agent Guide\n\n'
        + `This project is coordinated through **${target}** — read it for how AI\n`
        + `agents work here (shared board, roster, coordination rules). **Read \`${target}\` first.**\n`;
    const rules = fs.readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');
    await test('the committed kit rules are the current ones, or a past version repair replaces', () => {
        const head = spawnSync('git', ['show', 'HEAD:AGENTS.md'], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' });
        if (head.status !== 0) return console.log('  (no git checkout: skipped)');
        const text = head.stdout.replace(/\r\n/g, '\n');
        assert.ok(text === rules.replace(/\r\n/g, '\n') || workspaces.PAST_KIT_RULES.includes(sha(text)), 'add the sha256 of HEAD:AGENTS.md to PAST_KIT_RULES');
    });
    await test('a past kit AGENTS.md and an old pointer are planned for refresh; an edited pointer is not', () => {
        const root = project('old-kit');
        const old = '<!-- plutos:kit -->\nold rules\n';
        write(root, 'AGENTS.md', old.replace(/\n/g, '\r\n'));
        write(root, 'CLAUDE.md', oldPointer('AGENTS.md'));
        write(root, 'GEMINI.md', oldPointer('AGENTS.md') + 'my own line\n');
        const changes = workspaces.planKitRefresh(root, { pastRules: [sha(old)] });
        const by = name => changes.find(change => path.basename(change.path) === name);
        assert.equal(by('AGENTS.md')?.content, rules);
        assert.match(by('CLAUDE.md')?.content || '', /^@AGENTS\.md$/m);
        assert.equal(by('GEMINI.md'), undefined);
        assert.deepEqual(workspaces.planKitRefresh(root), changes.filter(change => path.basename(change.path) !== 'AGENTS.md'));
    });
    await test('repair previews, applies and restores a pointer refresh, and refuses one edited after preview', () => {
        const root = project('old-pointer');
        write(root, 'CLAUDE.md', oldPointer('AGENTS.md'));
        write(root, 'GEMINI.md', oldPointer('AGENTS.md'));
        let plan = repair.previewProjectRepair(root);
        const kit = plan.changes.filter(change => /^(CLAUDE|GEMINI)\.md$/.test(change.path));
        assert.deepEqual(kit.map(change => [change.path, change.action, change.reason]),
            [['CLAUDE.md', 'update', 'Replace an unedited copy of older PLUT_OS rules'], ['GEMINI.md', 'update', 'Replace an unedited copy of older PLUT_OS rules']]);
        fs.appendFileSync(path.join(root, 'CLAUDE.md'), 'an edit\n');
        assert.throws(() => repair.applyProjectRepair({ projectRoot: root, token: plan.token }), /stale/);
        write(root, 'CLAUDE.md', oldPointer('AGENTS.md'));
        plan = repair.previewProjectRepair(root);
        const applied = repair.applyProjectRepair({ projectRoot: root, token: plan.token });
        assert.equal(applied.success, true);
        assert.match(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), /^@AGENTS\.md$/m);
        assert.match(fs.readFileSync(path.join(root, 'GEMINI.md'), 'utf8'), /^@\.\/AGENTS\.md$/m);
        assert.equal(repair.restoreProjectRepair({ projectRoot: root, backupId: applied.backupId }).success, true);
        assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), oldPointer('AGENTS.md'));
    });
    await test('a project with its own AGENTS.md gets both imports, so CLAUDE.md does not hide its rules', () => {
        const root = project('own-rules');
        write(root, 'AGENTS.md', '# Our rules\n');
        write(root, 'CLAUDE.md', oldPointer('docs/handoff/PLUTOS_PROTOCOL.md'));
        const [change] = workspaces.planKitRefresh(root);
        assert.equal(change?.content, '# AI Agent Guide\n\nHow AI agents work in this project (shared board, roster, coordination rules):\n\n@AGENTS.md\n@docs/handoff/PLUTOS_PROTOCOL.md\n');
    });
    await test('a linked or large CLAUDE.md is left alone and does not stop the repair', () => {
        const root = project('linked-rules');
        // A file link needs developer mode on Windows; without it the large file is the case.
        try { fs.symlinkSync(path.join(root, 'AGENTS.md'), path.join(root, 'CLAUDE.md')); } catch (error) { if (error.code !== 'EPERM') throw error; }
        write(root, 'GEMINI.md', 'x'.repeat(512 * 1024 + 1));
        assert.deepEqual(workspaces.planKitRefresh(root), []);
        const plan = repair.previewProjectRepair(root);
        assert.ok(!plan.changes.some(change => KIT.includes(change.path)));
    });
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log(`\nProject repair: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
