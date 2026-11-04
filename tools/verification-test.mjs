#!/usr/bin/env node
// Recorded verification is independent of DONE and applies to the reviewed entry revision.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-verification-'));
process.env.PLUTOS_HOME = path.join(temp, 'hub');
process.env.USERPROFILE = process.env.HOME = path.join(temp, 'user');
process.env.APPDATA = path.join(temp, 'user', 'AppData');
const { applyBoardUpdate, parseBoardEntries } = await import('../lib/board.mjs');
const { writeBoardEntry } = await import('../lib/board-store.mjs');
let passed = 0;
const check = (name, condition) => { assert.ok(condition, name); passed++; console.log(`  PASS ${name}`); };
const change = (content, patch = {}) => applyBoardUpdate(content, { agent: 'worker', status: 'DONE', title: 'Review me', ...patch }).content;
const entry = content => parseBoardEntries(content)[0];

try {
    const legacy = '# Board\r\n\r\n### worker · DONE · Review me\r\n- **Task:** Original work\r\n- **Result / Output:** Original result\r\n- **Custom:** Keep me\r\n- [ ] untouched checklist\r\n';
    check('legacy DONE is unverified with no invented evidence', entry(legacy).verification === 'unverified' && entry(legacy).evidence === '');
    check('revision is a stable normalized content hash', /^[a-f0-9]{64}$/.test(entry(legacy).revision)
        && entry(legacy).revision === entry(legacy.replaceAll('\r\n', '\n')).revision);
    const verified = change(legacy, { verification: 'passed', evidence: 'docs/results/check.md' });
    check('passed verification and evidence round-trip', entry(verified).verification === 'passed' && entry(verified).evidence === 'docs/results/check.md');
    check('unknown fields, checklists and CRLF survive verification recording', verified.includes('- **Custom:** Keep me\r\n') && verified.includes('- [ ] untouched checklist\r\n') && !/(?<!\r)\n/.test(verified));
    const early = change('', { status: 'IN_PROGRESS', verification: 'passed', evidence: 'https://example.com/run/1' });
    check('verification may be recorded before DONE', entry(early).status === 'IN_PROGRESS' && entry(early).verification === 'passed');
    check('moving to DONE preserves a recorded pass', entry(change(early)).verification === 'passed');
    const failed = change(legacy, { verification: 'failed', evidence: 'docs/results/failure.log' });
    check('failed verification is independent of DONE', entry(failed).status === 'DONE' && entry(failed).verification === 'failed');
    check('notes and identical work preserve passed verification', entry(change(verified, { task: 'Original work', result: 'Original result', note: 'A separate note' })).verification === 'passed');
    for (const patch of [{ status: 'TODO' }, { status: 'IN_PROGRESS' }, { task: 'Changed work' }, { result: 'Changed result' }]) {
        const invalidated = entry(change(verified, patch));
        check(`changed work invalidates old pass: ${Object.keys(patch)[0]}=${Object.values(patch)[0]}`, invalidated.verification === 'unverified' && invalidated.evidence === '');
    }
    check('an explicit fresh pass with evidence can accompany a work change', entry(change(verified, { task: 'Changed work', verification: 'passed', evidence: 'docs/results/new.md' })).verification === 'passed');
    for (const evidence of [undefined, '', '   ']) {
        assert.throws(() => change(legacy, { verification: 'passed', evidence }), /requires/);
        passed++;
    }
    for (const evidence of ['../outside.md', '/outside.md', 'C:\\private.md', 'javascript:alert(1)', 'file:///private', 'docs/a\n### forgery', 'x'.repeat(2001), 'https://']) {
        assert.throws(() => change(legacy, { verification: 'passed', evidence }), /evidence/);
        passed++;
    }
    assert.throws(() => change(legacy, { verification: 'approved' }), /verification must/); passed++;
    assert.throws(() => change(legacy, { evidence: {} }), /must be a string/); passed++;
    check('malformed old pass without evidence reads as unverified', entry(legacy + '- **Verification:** passed\r\n').verification === 'unverified');
    check('unrelated edits preserve malformed legacy metadata without blocking work', change(legacy + '- **Verification:** passed\r\n', { note: 'Keep working' }).includes('Keep working'));
    const duplicates = verified + '- **verification:** passed\r\n- **evidence:** docs/results/older.md\r\n';
    check('duplicate hand-edited metadata cannot preserve an invalidated pass', entry(change(duplicates, { result: 'Changed result' })).verification === 'unverified');

    const project = path.join(temp, 'project');
    fs.mkdirSync(project, { recursive: true });
    const first = writeBoardEntry(project, { agent: 'worker', status: 'DONE', title: 'Review me', task: 'Original work' });
    const snapshot = entry(fs.readFileSync(first.path, 'utf8'));
    writeBoardEntry(project, { agent: 'worker', status: 'DONE', title: 'Review me', task: 'Concurrent same-status change' });
    const beforeConflict = fs.readFileSync(first.path, 'utf8');
    assert.throws(() => writeBoardEntry(project, { agent: 'worker', status: 'DONE', title: 'Review me', verification: 'passed', evidence: 'docs/check.md', expectedRevision: snapshot.revision }), error => error.code === 'BOARD_CONFLICT');
    check('stale verification is rejected under the store lock without modifying the board', fs.readFileSync(first.path, 'utf8') === beforeConflict);
    assert.throws(() => change('', { expectedRevision: snapshot.revision }), error => error.code === 'BOARD_CONFLICT');
    check('CAS cannot recreate a deleted entry', true);
    const latest = entry(beforeConflict);
    writeBoardEntry(project, { agent: 'worker', status: 'DONE', title: 'Review me', verification: 'passed', evidence: 'docs/check.md', expectedRevision: latest.revision });
    check('current revision can record verification atomically', entry(fs.readFileSync(first.path, 'utf8')).verification === 'passed');

    // Exercise the real MCP schema/handler too, in the same isolated Hub and synthetic project.
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    fs.writeFileSync(path.join(project, 'AGENTS.md'), '# PLUT_OS Shared Communication Rules\n');
    const env = { ...process.env, PLUTOS_PROJECT_ROOT: project };
    for (const key of ['CODEX_HOME', 'CLAUDE_PROJECT_DIR', 'PLUTOS_CODEX_PROJECT_CONFIG', 'PLUTOS_PROJECT_BOUND_BY_LAUNCHER']) delete env[key];
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'index.mjs')], env, stderr: 'pipe' });
    const client = new Client({ name: 'verification-test', version: '1' });
    try {
        await client.connect(transport);
        const tools = await client.listTools();
        const schema = tools.tools.find(tool => tool.name === 'board_update').inputSchema.properties;
        check('MCP advertises outcome, evidence and revision fields', schema.verification.enum.includes('passed') && schema.evidence && schema.expectedRevision);
        const noEvidence = await client.callTool({ name: 'board_update', arguments: { agent: 'worker', status: 'DONE', title: 'Review me', verification: 'passed' } });
        check('real MCP rejects passed claims without evidence', noEvidence.isError && /requires/.test(noEvidence.content[0].text));
        const read = await client.callTool({ name: 'board_read', arguments: {} });
        const current = JSON.parse(read.content[0].text).entries.find(item => item.title === 'Review me');
        const reopened = await client.callTool({ name: 'board_update', arguments: { agent: 'worker', status: 'TODO', title: 'Review me', expectedRevision: current.revision } });
        check('real MCP reopening invalidates prior evidence', !reopened.isError && entry(fs.readFileSync(first.path, 'utf8')).verification === 'unverified');
        const stale = await client.callTool({ name: 'board_update', arguments: { agent: 'worker', status: 'DONE', title: 'Review me', verification: 'passed', evidence: 'docs/check.md', expectedRevision: current.revision } });
        check('real MCP rejects a stale verification after reopen', stale.isError && /changed since/.test(stale.content[0].text));
    } finally { await client.close(); }

    const escSource = fs.readFileSync(path.join(root, 'ui', 'esc.js'), 'utf8').replace(/^export /gm, '');
    const uiSource = fs.readFileSync(path.join(root, 'ui', 'modules', 'verification.js'), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
    const posted = [], toasts = [], events = [];
    const context = vm.createContext({ window: {}, URL, URLSearchParams, t: key => key, showToast: message => toasts.push(message),
        CustomEvent: class { constructor(type) { this.type = type; } }, document: { dispatchEvent: event => events.push(event.type) },
        fetch: async (url, options) => { posted.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ success: true }) }; } });
    vm.runInContext(escSource + '\n' + uiSource, context);
    const uiEntry = { ...entry(verified), title: 'Quoted " task <test>' };
    const badge = context.verificationBadge(uiEntry, 'main', project);
    check('evidence opens through a scoped stored-entry lookup', badge.includes('/api/board/evidence?project=') && badge.includes('target="_blank"') && !badge.includes('<test>'));
    check('DONE without a claim displays unverified', context.verificationBadge(entry(legacy), 'main', project).includes('verification_unverified'));
    const formHtml = context.verificationForm(uiEntry, 'main', project);
    check('form names recorded verification and carries the captured revision', formHtml.includes('verification_recorded_note') && formHtml.includes(uiEntry.revision) && !formHtml.includes('<test>'));
    const values = { verification: { value: 'passed' }, evidence: { value: '' } };
    const button = { disabled: false };
    const form = { dataset: { projectRoot: project, board: 'main', agent: 'worker', status: 'IN_PROGRESS', title: 'Review me', revision: latest.revision }, elements: { namedItem: name => values[name] }, querySelector: () => button };
    const event = { preventDefault() {}, stopPropagation() {} };
    await context.window.recordTaskVerification(event, form);
    check('UI prevents a passed record with empty evidence', posted.length === 0 && toasts.at(-1) === 'verification_need_evidence');
    values.evidence.value = 'docs/check.md';
    await context.window.recordTaskVerification(event, form);
    check('UI preserves workflow status and sends source identity plus revision', posted[0].status === 'IN_PROGRESS' && posted[0].projectRoot === project && posted[0].expectedRevision === latest.revision);
    check('successful recording refreshes the board and releases the submit control', events[0] === 'plutos-board-updated' && !button.disabled);
    const boardSource = fs.readFileSync(path.join(root, 'ui', 'modules', 'board.js'), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
    let focused = false, opened = false, wrongFocused = false, view;
    const focusedEntry = { ...uiEntry, fields: { ...uiEntry.fields, Assignee: 'Reviewer' }, notes: [] };
    const exactKey = ['main', 'Reviewer', focusedEntry.title].join('::');
    const attributes = { 'data-key': exactKey, 'data-agent': focusedEntry.agent, 'data-title': focusedEntry.title };
    const card = { getAttribute: name => attributes[name], classList: { add: () => { opened = true; } }, scrollIntoView: () => { focused = true; } };
    const sameOwnerCard = { getAttribute: name => name === 'data-agent' ? 'another-author' : attributes[name], scrollIntoView: () => { wrongFocused = true; } };
    const container = { innerHTML: '', querySelectorAll: selector => selector === '.kanban-card[data-key]' ? [card] : [] };
    const meta = { textContent: '' };
    context.document.getElementById = id => id === 'board-container' ? container : id === 'board-meta' ? meta : null;
    context.document.querySelectorAll = selector => {
        assert.equal(selector, '.kanban-card[data-key]');
        return [sameOwnerCard, card];
    };
    context.document.addEventListener = () => {};
    context.lucide = { createIcons() {} };
    context.window.switchView = name => { view = name; };
    context.window.activeWorkspacePath = project;
    const returnSource = fs.readFileSync(path.join(root, 'ui', 'modules', 'return-summary.js'), 'utf8');
    vm.runInContext(`{ ${returnSource.match(/^const text = .*$/m)[0]} ${returnSource.match(/export function returnProjectKey\(value\) \{[\s\S]*?\n\}/)[0].replace('export ', '')} globalThis.returnProjectKey = returnProjectKey; }`, context);
    const fixtures = {
        '/api/board': { exists: true, project: 'project', projectRoot: project, updatedAt: new Date().toISOString(), entries: [focusedEntry] },
        '/api/board?board=agents': { exists: true, projectRoot: project, entries: [] },
        '/api/roster': { agents: [] }, '/api/hygiene': null, '/api/ideas': null
    };
    context.fetch = async url => ({ json: async () => fixtures[url] });
    context.knownClientColor = () => null;   // ui/modules/orbit.js, imported by board.js
    vm.runInContext(boardSource, context);
    await context.window.focusBoardTask('main', focusedEntry.agent, focusedEntry.title, project);
    check('focus helper opens and scrolls the exact quoted task through the actual router name', view === 'board' && opened && focused);
    check('focus helper distinguishes same-title tasks assigned to the same owner', !wrongFocused);
    focused = false;
    context.window.activeWorkspacePath = path.join(temp, 'another-project');
    await context.window.focusBoardTask('main', focusedEntry.agent, focusedEntry.title, project);
    check('focus helper refuses an old summary after the selected project changes', !focused && toasts.at(-1) === 'return_summary_outdated');
    context.window.activeWorkspacePath = project;
    const normalFetch = context.fetch;
    context.fetch = async url => {
        context.window.activeWorkspacePath = path.join(temp, 'another-project');
        return normalFetch(url);
    };
    await context.window.focusBoardTask('main', focusedEntry.agent, focusedEntry.title, project);
    check('focus helper rechecks the selected project after its asynchronous refresh', !focused && toasts.at(-1) === 'return_summary_outdated');
    context.fetch = normalFetch;
    context.window.activeWorkspacePath = project;
    if (process.platform === 'win32') {
        await context.window.focusBoardTask('main', focusedEntry.agent, focusedEntry.title, project.toUpperCase().replaceAll('\\', '/') + '/');
        check('focus helper accepts equivalent Windows project spelling', focused);
    }
    const control = (id, value, revision) => ({ id, value, closest: () => ({ dataset: { revision } }) });
    let draftFields = [control('verification-state', 'passed', focusedEntry.revision), control('verification-evidence', 'docs/old-review.md', focusedEntry.revision)];
    const newFields = [control('verification-state', 'unverified', 'changed-revision'), control('verification-evidence', '', 'changed-revision')];
    container.querySelectorAll = selector => selector === 'input[id], textarea[id], select[id]' ? draftFields : [];
    Object.defineProperty(container, 'innerHTML', { set() { draftFields = newFields; }, get() { return ''; } });
    fixtures['/api/board'].entries = [{ ...focusedEntry, verification: 'unverified', evidence: '', revision: 'changed-revision', fields: { Task: 'Changed while the owner was reviewing' } }];
    await context.fetchBoard();
    check('polling cannot carry old verification drafts onto a newer entry revision', draftFields[0].value === 'unverified' && draftFields[1].value === '');
    {
        // Priority is a field, so changing it keeps the entry's identity; an older "P1 - " title still ranks.
        const { byPriority } = await import('../lib/board.mjs');
        let board = applyBoardUpdate('# Board\n', { agent: 'owner', status: 'TODO', title: 'Tune the first card', priority: 'p2' }).content;
        board = applyBoardUpdate(board, { agent: 'owner', status: 'TODO', title: 'Tune the first card', priority: 'P1' }).content;
        const tuned = parseBoardEntries(board);
        check('a priority is set and changed in place, without a second entry', tuned.length === 1 && tuned[0].priority === 'P1' && board.includes('- **Priority:** P1'));
        board += '\n### owner · TODO · P3 - An old-style title\n- **Task:** x\n\n### owner · TODO · No rank\n- **Task:** y\n\n### owner · TODO · Second\n- **Task:** z\n- **Priority:** P2\n';
        check('an old "P3 - " title reads as P3, and entries sort P1, P2, P3, then the rest in board order',
            parseBoardEntries(board).sort(byPriority).map(e => e.title).join(' | ') === 'Tune the first card | Second | P3 - An old-style title | No rank');
        let refused = false;
        try { applyBoardUpdate(board, { agent: 'owner', status: 'TODO', title: 'x', priority: 'urgent' }); } catch (e) { refused = /priority must be one of/.test(e.message); }
        check('an unknown priority is refused', refused);
    }
    {
        // Done when: written at the claim, checked at DONE.
        const refuses = fn => { try { fn(); return false; } catch (e) { return /done when: npm test passes/.test(e.message); } };
        const claimed = change('', { status: 'IN_PROGRESS', doneWhen: 'npm test passes' });
        check('a claim keeps what will show it is done', claimed.includes('- **Done when:** npm test passes'));
        check('DONE without a verification against it is refused', refuses(() => change(claimed, { result: 'shipped' })));
        check('a new entry straight to DONE with a criterion and no verification is refused',
            refuses(() => change('', { doneWhen: 'npm test passes' })));
        const done = change(claimed, { result: 'shipped', verification: 'passed', evidence: 'docs/results/run.log' });
        check('DONE with a passed check and evidence goes through', entry(done).status === 'DONE' && entry(done).verification === 'passed');
        check('an honest unverified DONE goes through too', entry(change(claimed, { verification: 'unverified' })).verification === 'unverified');
        check('an entry without a criterion still closes as before', entry(change('', { status: 'DONE' })).status === 'DONE');
    }
    console.log(`VERIFICATION PASS — ${passed} passed, 0 failed`);
} finally {
    fs.rmSync(temp, { recursive: true, force: true });
}
