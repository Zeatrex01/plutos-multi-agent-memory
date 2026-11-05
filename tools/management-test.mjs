#!/usr/bin/env node
// Real dashboard regressions for project-bound work and shared MCP status.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-management-'));
const hub = path.join(tmp, 'hub');
// A port that is free right now unless one is named; a fixed default collided with whatever held it.
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const port = Number(process.env.PLUTOS_MANAGEMENT_TEST_PORT) || await freePort();
const base = `http://127.0.0.1:${port}`;
const a = path.join(tmp, 'project A');
const b = path.join(tmp, 'project B');
const user = path.join(tmp, 'user');
for (const dir of [a, b, user]) fs.mkdirSync(dir, { recursive: true });
const env = { ...process.env, PLUTOS_HOME: hub, PLUTOS_PORT: String(port),
    USERPROFILE: user, HOME: user, APPDATA: path.join(user, 'AppData') };
delete env.PLUTOS_PROJECT_ROOT;
delete env.PLUTOS_PROJECT_BOUND_BY_LAUNCHER;
delete env.CLAUDE_PROJECT_DIR;
delete env.PLUTOS_PACKAGED;
const server = spawn(process.execPath, [path.join(root, 'dashboard.mjs')], { env, stdio: 'pipe' });
let serverErrors = '';
server.stderr.on('data', data => { serverErrors += data; });
server.stdout.resume();
const serverClosed = new Promise(resolve => server.once('close', resolve));   // its stderr is complete then
const extraClient = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
let passed = 0;
function check(name, condition) { assert.ok(condition, name); passed++; console.log(`  PASS ${name}`); }
async function api(route, body) {
    const response = await fetch(base + route, { signal: AbortSignal.timeout(8000),
        ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
}
async function post(route, body) {
    const result = await api(route, body);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
}
async function stop(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
}

try {
    // Only the dashboard this test started counts. With its port taken it exits at once while the
    // server holding the port goes on answering, so the wait ends when the child is gone, and a
    // dashboard with another data folder is not taken for it.
    let ready = false;
    for (let i = 0; i < 40; i++) {
        if (server.exitCode !== null || server.signalCode !== null) {
            await Promise.race([serverClosed, new Promise(resolve => setTimeout(resolve, 1000))]);
            throw new Error(`The dashboard this test started exited before it answered on ${base}:\n${serverErrors}`);
        }
        try { ready = path.resolve((await api('/api/app/mode')).data.dataHome || '.') === path.resolve(hub); } catch { /* starting */ }
        if (ready) break;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, serverErrors || `Dashboard did not start on ${base}`);
    await post('/api/workspaces/add', { path: a });
    await post('/api/board', { agent: 'Claude', status: 'TODO', title: 'A-only', task: 'A work' });
    const aBoard = (await api('/api/board')).data;
    check('observe board exposes source project name and identity', aBoard.project === 'project A' && aBoard.projectRoot === fs.realpathSync(a));
    await post('/api/workspaces/add', { path: b });
    await post('/api/board', { agent: 'Claude', status: 'TODO', title: 'B-only', task: 'B work' });
    const scopedUrl = `/api/board?project=${encodeURIComponent(a)}`;
    const scoped = (await api(scopedUrl)).data;
    check('A board stays A while dashboard selects B', scoped.entries.length === 1 && scoped.entries[0].title === 'A-only');
    check('scoped read leaves dashboard selection unchanged', (await api('/api/workspaces')).data.activeWorkspace === b);
    check('unregistered roots are refused', (await api(`/api/board?project=${encodeURIComponent(tmp)}`)).status === 404);
    check('relative roots are refused', (await api('/api/board?project=../project')).status === 400);
    check('empty explicit roots are refused', (await api('/api/board?project=')).status === 400);
    // Import after an explicit temporary Hub is selected; workspaces has startup side effects.
    process.env.PLUTOS_HOME = hub;
    const { watcherScript } = await import('../lib/watcher.mjs');
    const hook = path.join(tmp, 'watcher.cjs');
    fs.writeFileSync(hook, watcherScript('Claude', port, a));
    const runWatcher = () => spawnSync(process.execPath, [hook], {
        cwd: a, env: { ...env, PLUTOS_AGENT: 'Claude', PLUTOS_BOARD_URL: `${base}/api/board` },
        input: JSON.stringify({ cwd: a, stop_hook_active: false }), encoding: 'utf8', timeout: 10000
    });
    const whileB = runWatcher();
    check('real watcher reads only A task while B is selected', whileB.status === 2 && whileB.stderr.includes('A-only') && !whileB.stderr.includes('B-only'));
    await post('/api/workspaces/close', {});
    check('scoped board works with no dashboard project selected', (await api(scopedUrl)).data.projectRoot === fs.realpathSync(a));
    check('unscoped board still reports no project', (await api('/api/board')).data.needsProject === true);
    check('watcher keeps working when the dashboard project is closed', runWatcher().status === 2);
    check('observe registration does not modify either source project', fs.readdirSync(a).length === 0 && fs.readdirSync(b).length === 0);

    await post('/api/workspaces/switch', { path: a });
    const statusFile = path.join(hub, 'mcp_status.json');
    const now = Date.now();
    fs.writeFileSync(statusFile, JSON.stringify({ active: true, lastHeartbeat: now, clients: {
        [process.pid]: { pid: process.pid, project: a, client: 'Seat A', lastActive: now },
        [server.pid]: { pid: server.pid, project: b, client: 'Seat B', lastActive: now },
        [extraClient.pid]: { pid: extraClient.pid, client: 'Legacy seat', lastActive: now }
    }, log: [ { project: a, details: 'A log' }, { project: b, details: 'B log' }, { details: 'Unknown log' } ] }));
    const statusA = (await api('/api/mcp/status')).data;
    check('connection status contains only selected project clients', statusA.active && Object.keys(statusA.clients).join() === String(process.pid));
    check('activity history contains only selected project events', statusA.log.length === 1 && statusA.log[0].details === 'A log');
    check('legacy records are explicit and excluded from selected connections', !!statusA.unknownClients[extraClient.pid] && statusA.unknownLog.length === 1);
    await post('/api/workspaces/switch', { path: b });
    const statusB = (await api('/api/mcp/status')).data;
    check('switching project changes connection attribution', Object.keys(statusB.clients).join() === String(server.pid) && statusB.log[0].details === 'B log');

    // Owner-management features: real HTTP boundaries, source identity and recoverable repair.
    await post('/api/workspaces/switch', { path: a });
    const summaryUrl = `/api/return-summary?project=${encodeURIComponent(a)}`;
    check('return summary requires explicit project identity', (await api('/api/return-summary')).status === 400);
    check('return summary rejects the wrong selected project', (await api(`/api/return-summary?project=${encodeURIComponent(b)}`)).status === 409);
    const firstSummary = (await api(summaryUrl)).data;
    check('return summary carries only this project tasks', firstSummary.projectRoot === fs.realpathSync(a) && firstSummary.entries.every(e => e.title !== 'B-only'));
    await post('/api/project/install', {});
    const proof = path.join(a, 'docs', 'check.log');
    fs.writeFileSync(proof, '<script>proof stays plain text</script>');
    const readTask = async () => (await api('/api/board')).data.entries.find(e => e.title === 'A-only');
    await post('/api/board', { projectRoot: a, agent: 'Claude', title: 'A-only', status: 'DONE' });
    const unverified = await readTask();
    check('DONE alone is explicitly unverified over HTTP', unverified.verification === 'unverified');
    const claim = { projectRoot: a, agent: 'Claude', title: 'A-only', status: 'DONE', verification: 'passed', evidence: 'docs/check.log', expectedRevision: unverified.revision };
    check('verification requires the source project', (await api('/api/board', { ...claim, projectRoot: undefined })).status === 400);
    await post('/api/board', claim);
    const verified = await readTask();
    check('verification records independently from workflow status', verified.status === 'DONE' && verified.verification === 'passed' && verified.evidence === 'docs/check.log');
    const evidenceUrl = `/api/board/evidence?${new URLSearchParams({ project: a, board: 'main', agent: 'Claude', title: 'A-only' })}`;
    const evidence = await fetch(base + evidenceUrl);
    check('stored evidence opens as inert text', evidence.status === 200 && evidence.headers.get('content-type').startsWith('text/plain') && (await evidence.text()).includes('<script>'));
    await post('/api/board', { ...claim, expectedRevision: undefined, evidence: 'docs\\check.log' });
    check('Windows relative evidence paths open', (await fetch(base + evidenceUrl)).status === 200);
    fs.writeFileSync(path.join(a, 'docs', 'large.log'), Buffer.alloc(256 * 1024 + 1));
    await post('/api/board', { ...claim, expectedRevision: undefined, evidence: 'docs/large.log' });
    check('oversized evidence is refused instead of truncated', (await fetch(base + evidenceUrl)).status === 400);
    const outside = path.join(tmp, 'outside-evidence');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'proof.log'), 'outside fixture');
    fs.symlinkSync(outside, path.join(a, 'docs', 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
    await post('/api/board', { ...claim, expectedRevision: undefined, evidence: 'docs/redirect/proof.log' });
    check('evidence junction cannot leave the project', (await fetch(base + evidenceUrl)).status === 400);
    fs.writeFileSync(path.join(a, 'docs', 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHioAAAAASUVORK5CYII=', 'base64'));
    await post('/api/board', { ...claim, expectedRevision: undefined, evidence: 'docs/pixel.png' });
    const image = await fetch(base + evidenceUrl);
    check('image artifacts open with a fixed inert media type', image.status === 200 && image.headers.get('content-type') === 'image/png' && image.headers.get('x-content-type-options') === 'nosniff');
    await post('/api/board', { projectRoot: a, agent: 'Claude', title: 'A-only', status: 'TODO' });
    check('HTTP stale verification cannot re-close an edited task', (await api('/api/board', claim)).status === 409 && (await readTask()).status === 'TODO');
    await post('/api/board', { projectRoot: a, agent: 'Claude', title: 'A-only', status: 'DONE', verification: 'passed', evidence: 'docs/check.log' });

    const { createApproval } = await import('../lib/approvals.mjs');
    const ticket = createApproval(a, { agent: 'Test seat', question: 'Synthetic owner decision?' });
    check('return summary includes pending owner decisions', (await api(summaryUrl)).data.pendingApprovals.some(q => q.id === ticket.id));
    // A/B design pick: the card's images come only from docs/ai/design-picks/ of the open project.
    fs.mkdirSync(path.join(a, 'docs', 'ai', 'design-picks', 'home'), { recursive: true });
    fs.copyFileSync(path.join(a, 'docs', 'pixel.png'), path.join(a, 'docs', 'ai', 'design-picks', 'home', 'A.png'));
    const imageUrl = rel => `${base}/api/approvals/image?project=${encodeURIComponent(a)}&path=${encodeURIComponent(rel)}`;
    const pickImage = await fetch(imageUrl('docs/ai/design-picks/home/A.png'));
    check('a design-pick image is served as an inert image', pickImage.status === 200 && pickImage.headers.get('content-type') === 'image/png' && pickImage.headers.get('x-content-type-options') === 'nosniff');
    check('a file outside design-picks is not served', (await fetch(imageUrl('docs/pixel.png'))).status === 404);
    check('a climbing path is not served', (await fetch(imageUrl('docs/ai/design-picks/../../pixel.png'))).status === 404);
    check('a missing image is a 404', (await fetch(imageUrl('docs/ai/design-picks/home/B.png'))).status === 404);
    await post('/api/workspaces/switch', { path: b });
    await post('/api/project/install', {});
    fs.mkdirSync(path.join(b, '.plutos', 'approvals'), { recursive: true });
    fs.copyFileSync(path.join(a, '.plutos', 'approvals', ticket.id + '.json'), path.join(b, '.plutos', 'approvals', ticket.id + '.json'));
    check('old project verification is rejected after dashboard switch', (await api('/api/board', { ...claim, expectedRevision: undefined })).status === 409);
    check('old project evidence is rejected after dashboard switch', (await fetch(base + evidenceUrl)).status === 409);
    check('scoped approval reads reject another selected project', (await api(`/api/approvals?project=${encodeURIComponent(a)}`)).status === 409);
    check('a design-pick image of another project is not served', (await fetch(imageUrl('docs/ai/design-picks/home/A.png'))).status === 404);
    check('cloned ticket cannot be answered under another project', (await api('/api/approvals', { projectRoot: a, id: ticket.id, decision: 'approved' })).status === 409
        && JSON.parse(fs.readFileSync(path.join(b, '.plutos', 'approvals', ticket.id + '.json'), 'utf8')).status === 'pending');

    const local = path.join(a, '.plutos', 'local.json');
    const staleLocal = JSON.stringify({ plutosRoot: path.join(tmp, 'old-install'), custom: 'preserve me' });
    fs.writeFileSync(local, staleLocal);
    const otherLocal = fs.readFileSync(path.join(b, '.plutos', 'local.json'), 'utf8');
    const previewUrl = `/api/workspaces/repair/preview?project=${encodeURIComponent(a)}`;
    const preview = (await api(previewUrl)).data;
    check('repair preview names target A while B is selected and writes no source', preview.projectRoot === fs.realpathSync(a) && preview.changes.length > 0 && fs.readFileSync(local, 'utf8') === staleLocal);
    check('repair without a preview token is refused', (await api('/api/workspaces/repair', { projectRoot: a })).status === 400);
    const repaired = await post('/api/workspaces/repair', { projectRoot: a, token: preview.token });
    check('repair applies only the previewed project', repaired.success && repaired.backupId && fs.readFileSync(local, 'utf8') !== staleLocal
        && fs.readFileSync(path.join(b, '.plutos', 'local.json'), 'utf8') === otherLocal);
    check('backup remains discoverable in a later preview', (await api(previewUrl)).data.backups.some(item => item.backupId === repaired.backupId));
    await post('/api/workspaces/repair/restore', { projectRoot: a, backupId: repaired.backupId });
    check('restore recovers exact previous bytes', fs.readFileSync(local, 'utf8') === staleLocal);
    const stalePreview = (await api(previewUrl)).data;
    fs.writeFileSync(local, staleLocal + '\n');
    check('changed inputs invalidate the preview before writing', (await api('/api/workspaces/repair', { projectRoot: a, token: stalePreview.token })).status === 409
        && fs.readFileSync(local, 'utf8') === staleLocal + '\n');
    const freshPreview = (await api(previewUrl)).data;
    const secondRepair = await post('/api/workspaces/repair', { projectRoot: a, token: freshPreview.token });
    fs.writeFileSync(local, 'new user edit');
    check('restore refuses to overwrite a later edit', (await api('/api/workspaces/repair/restore', { projectRoot: a, backupId: secondRepair.backupId })).status === 409
        && fs.readFileSync(local, 'utf8') === 'new user edit');
    const realProject = path.join(tmp, 'real project');
    const aliasProject = path.join(tmp, 'project alias');
    fs.mkdirSync(realProject);
    fs.symlinkSync(realProject, aliasProject, process.platform === 'win32' ? 'junction' : 'dir');
    await post('/api/workspaces/add', { path: aliasProject });
    check('workspace exposes canonical request identity while retaining its alias', (await api('/api/workspaces')).data.activeProjectRoot === fs.realpathSync(realProject));
    await post('/api/board', { projectRoot: realProject, agent: 'Codex', title: 'Alias board task', status: 'TODO' });
    const aliasSummary = (await api(`/api/return-summary?project=${encodeURIComponent(realProject)}`)).data;
    check('canonical summary uses the registered alias sidecar', aliasSummary.entries.some(e => e.title === 'Alias board task'));

    // A signalled or hung suite must fail the runner and must not keep later suites from running.
    // Every suite gets a result line, and the end names the failed ones again.
    const runnerRoot = path.join(tmp, 'runner');
    fs.mkdirSync(path.join(runnerRoot, 'tools'), { recursive: true });
    fs.copyFileSync(path.join(root, 'tools', 'run-all-tests.mjs'), path.join(runnerRoot, 'tools', 'run-all-tests.mjs'));
    for (const file of ['tools/smoke-test.mjs', 'tools/mcp-test.mjs', 'tools/build-test.mjs',
        'tools/watcher-test.mjs', 'tools/session-memory-test.mjs', 'tools/management-test.mjs',
        'tools/return-summary-test.mjs', 'tools/verification-test.mjs', 'tools/repair-test.mjs', 'tools/approval-ui-test.mjs']) {
        fs.writeFileSync(path.join(runnerRoot, file), file === 'tools/smoke-test.mjs' ? "process.kill(process.pid, 'SIGTERM');"
            : file === 'tools/mcp-test.mjs' ? 'setInterval(() => {}, 1000);' : `console.log(${JSON.stringify('ran ' + file)});`);
    }
    const runner = spawnSync(process.execPath, [path.join(runnerRoot, 'tools', 'run-all-tests.mjs')],
        { encoding: 'utf8', timeout: 60000, env: { ...process.env, PLUTOS_SUITE_TIMEOUT_MS: '1500' } });
    check('a signalled child fails the complete test command', runner.status !== 0);
    check('the runner still executes later suites', runner.stdout.includes('ran tools/management-test.mjs'));
    check('a suite past its timeout is stopped, and the runner says so', /^✘ tools\/mcp-test\.mjs: timed out after 1\.5 s/m.test(runner.stdout));
    check('every suite gets a result line with its time', /^✔ tools\/management-test\.mjs \(\d+\.\d s\)$/m.test(runner.stdout)
        && /^✘ tools\/smoke-test\.mjs: .+ \(\d+\.\d s\)$/m.test(runner.stdout));
    const summary = runner.stdout.slice(runner.stdout.lastIndexOf('suites failed'));
    check('the end names the failed suites again, and only those', /^ {2}tools\/smoke-test\.mjs: /m.test(summary)
        && /^ {2}tools\/mcp-test\.mjs: timed out/m.test(summary) && !summary.includes('tools/management-test.mjs'));
    console.log(`MANAGEMENT PASS — ${passed} passed, 0 failed`);
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    await stop(extraClient);
    await stop(server);
    fs.rmSync(tmp, { recursive: true, force: true });
}
