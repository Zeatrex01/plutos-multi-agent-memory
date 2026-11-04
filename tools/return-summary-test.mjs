// Execute the browser module itself with a small DOM/storage harness; no live Hub needed.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../ui/modules/return-summary.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const escaping = fs.readFileSync(new URL('../ui/esc.js', import.meta.url), 'utf8').replace(/^export /gm, '');
let passed = 0;
const check = (name, condition) => { assert.ok(condition, name); passed++; console.log(`PASS ${name}`); };

function harness() {
    const values = new Map();
    const listeners = {};
    const calls = [];
    const storage = {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value)
    };
    const context = vm.createContext({
        t: key => key, localStorage: storage,
        window: {
            addEventListener: (name, fn) => { listeners[name] = fn; },
            focusBoardTask: (...args) => calls.push(['task', ...args]),
            focusApproval: (...args) => calls.push(['approval', ...args])
        }
    });
    vm.runInContext(escaping + '\n' + source + '\nglobalThis.api = { RETURN_SUMMARY_KEY, returnProjectKey, returnTaskKey, compactReturnSnapshot, diffReturnSnapshots, boundedReturnBaselines, renderReturnSummary };', context);
    const box = { innerHTML: '', onclick: null, isConnected: true, contains: () => true };
    const click = (action, index = 0, handler = box.onclick) => {
        const target = { dataset: { returnAction: action, returnIndex: String(index) }, textContent: '' };
        handler({ target: { closest: () => target } });
        return target;
    };
    const stored = () => JSON.parse(values.get(context.api.RETURN_SUMMARY_KEY));
    return { ...context.api, box, values, storage, listeners, calls, click, stored };
}

const task = (status = 'TODO', extras = {}) => ({ board: 'main', agent: 'Owner', status, title: 'Ship feature',
    fields: { Started: '2026-09-08T10:00:00.000Z' }, ...extras });
const snapshot = (entries, minute = 0, projectRoot = 'C:\\Project A', pendingApprovals = []) => ({
    projectRoot, entries, pendingApprovals, capturedAt: `2026-09-08T11:${String(minute).padStart(2, '0')}:00.000Z`
});

{
    const h = harness();
    check('canonical Windows spellings share a browser baseline', h.returnProjectKey('C:\\Project A\\') === h.returnProjectKey('c:/project a'));
    check('drive and UNC roots remain stable storage keys', h.returnProjectKey('C:\\') === 'c:/'
        && h.returnProjectKey(h.returnProjectKey('C:\\')) === 'c:/'
        && h.returnProjectKey('\\\\SERVER\\Share\\') === h.returnProjectKey('//server/share'));
    check('POSIX project paths retain case and root', h.returnProjectKey('/A') !== h.returnProjectKey('/a') && h.returnProjectKey('/') === '/');
    check('relative project identities are rejected', !h.returnProjectKey('project/a'));
    check('missing capture time cannot establish a comparison', h.compactReturnSnapshot({ ...snapshot([]), capturedAt: null }) === null);
    const baseline = h.compactReturnSnapshot(snapshot([task()]));
    const claimed = task('DONE', { agent: 'Claude', fields: { Started: task().fields.Started, 'Opened by': 'Owner' } });
    check('claiming a task preserves its identity', h.returnTaskKey(task()) === h.returnTaskKey(claimed));
    check('claimed completion is observed once', h.diffReturnSnapshots(baseline, snapshot([claimed], 1)).done.length === 1);
    check('already acknowledged completion is not counted again', h.diffReturnSnapshots(h.compactReturnSnapshot(snapshot([claimed], 1)), snapshot([claimed], 2)).done.length === 0);
    check('removal or archival never implies completion', h.diffReturnSnapshots(baseline, snapshot([], 1)).done.length === 0);
    check('newly present DONE and BLOCKED rows are observed', (() => {
        const diff = h.diffReturnSnapshots(baseline, snapshot([task('DONE', { title: 'New completion' }), task('BLOCKED')], 1));
        return diff.done.length === 1 && diff.blocked.length === 1;
    })());
    check('first comparison is unknown, not all existing work newly completed', h.diffReturnSnapshots(null, snapshot([claimed])).done.length === 0);
    check('another project cannot be compared with this baseline', !h.diffReturnSnapshots(baseline, snapshot([claimed], 1, 'C:\\Project B')).hasBaseline);
    check('same title in two boards remains distinct', h.returnTaskKey(task()) !== h.returnTaskKey(task('TODO', { board: 'agents' })));
    check('a reused title with a new Started time is a new task', h.returnTaskKey(task()) !== h.returnTaskKey(task('TODO', { fields: { Started: 'later' } })));
    const duplicates = h.compactReturnSnapshot(snapshot([task(), task('DONE')]));
    check('ambiguous duplicate identities are excluded with an incomplete notice', duplicates.incomplete && duplicates.records.length === 0);
    const limited = h.compactReturnSnapshot(snapshot(Array.from({ length: 1001 }, (_, i) => task('TODO', { title: `Task ${i}` }))));
    check('per-project status records are bounded', limited.incomplete && limited.records.length === 1000);
    check('missing keys in an incomplete baseline cannot invent new completions', h.diffReturnSnapshots(limited, snapshot([task('DONE', { title: 'Task 1000' })], 1)).done.length === 0);
    check('known transitions remain visible with an incomplete baseline', h.diffReturnSnapshots(limited, snapshot([task('DONE', { title: 'Task 0' })], 1)).done.length === 1);
    const projects = Array.from({ length: 25 }, (_, i) => ({ ...baseline, projectRoot: `/project/${i}`, savedAt: i }));
    check('only twenty most recently saved projects are retained', h.boundedReturnBaselines(projects).length === 20
        && h.boundedReturnBaselines(projects)[0].projectRoot === '/project/24');
    check('total stored status records stay within two thousand', h.boundedReturnBaselines(projects.map(p => ({ ...p, records: Array(1000).fill(baseline.records[0]) }))).length === 2);
}

{
    const h = harness();
    const initial = snapshot([task('DONE')]);
    h.renderReturnSummary(h.box, initial);
    check('first successful view saves a starting point without a changed count', h.box.innerHTML.includes('return_summary_first')
        && !h.box.innerHTML.includes('return_summary_done (') && h.stored().projects.length === 1);
    const saved = h.values.get(h.RETURN_SUMMARY_KEY);
    const later = snapshot([task('DONE'), task('BLOCKED', { title: 'Needs help' })], 1, initial.projectRoot,
        [{ id: 'q1', agent: 'Claude', question: 'Pick an option?' }]);
    h.renderReturnSummary(h.box, later);
    check('polling does not advance the saved baseline', h.values.get(h.RETURN_SUMMARY_KEY) === saved);
    check('current pending owner decisions are shown independently', h.box.innerHTML.includes('return_summary_approvals (1)'));
    h.click('task'); h.click('approval');
    check('task and approval buttons call the parent focus contracts', JSON.stringify(h.calls)
        === JSON.stringify([['task', 'main', 'Owner', 'Needs help', 'c:/project a'], ['approval', 'q1', 'c:/project a']]));
    later.entries[1].status = 'DONE';
    h.click('seen');
    check('Mark seen saves only the displayed immutable snapshot', h.stored().projects[0].records.some(row => row.status === 'BLOCKED')
        && h.stored().projects[0].capturedAt === later.capturedAt);
    check('acknowledged changes disappear while pending decisions remain', h.box.innerHTML.includes('return_summary_blocked (0)')
        && h.box.innerHTML.includes('return_summary_approvals (1)'));
    h.renderReturnSummary(h.box, snapshot([task('TODO')], 0));
    check('a late older poll cannot replace the rendered snapshot', h.box.innerHTML.includes('return_summary_approvals (1)'));
    const other = { innerHTML: '', onclick: null, isConnected: true, contains: () => true };
    h.renderReturnSummary(other, snapshot([], 2, 'C:\\Project B'));
    check('baselines are separated by canonical project', h.stored().projects.length === 2
        && h.stored().projects.some(project => project.projectRoot === 'c:/project a'));
    const fresh = h.compactReturnSnapshot(snapshot([], 3));
    h.values.set(h.RETURN_SUMMARY_KEY, JSON.stringify({ version: 1, projects: [{ ...fresh, savedAt: Date.now() }] }));
    h.listeners.storage({ key: h.RETURN_SUMMARY_KEY });
    check('cross-tab newer acknowledgment refreshes the visible comparison honestly', h.box.innerHTML.includes('return_summary_outdated')
        && !h.box.innerHTML.includes('return_summary_done ('));
    h.click('seen');
    check('an old tab cannot roll back a newer acknowledgment', h.stored().projects.find(project => project.projectRoot === 'c:/project a').capturedAt === fresh.capturedAt);
}

{
    const h = harness();
    h.values.set(h.RETURN_SUMMARY_KEY, '{bad json');
    h.renderReturnSummary(h.box, snapshot([task('DONE')]));
    check('corrupt storage is reset without fabricated changed counts', h.box.innerHTML.includes('return_summary_reset')
        && h.box.innerHTML.includes('return_summary_first') && !h.box.innerHTML.includes('return_summary_done ('));
    h.storage.setItem = () => { throw new Error('quota exceeded'); };
    h.renderReturnSummary(h.box, snapshot([task('DONE')], 1, 'C:\\No quota'));
    check('quota failure is visible and does not claim a saved comparison', h.box.innerHTML.includes('return_summary_unavailable')
        && !h.stored().projects.some(project => project.projectRoot === 'c:/no quota'));
    h.storage.getItem = () => { throw new Error('storage blocked'); };
    h.renderReturnSummary(h.box, snapshot([], 2, 'C:\\Blocked storage'));
    check('blocked browser storage keeps comparison unknown', h.box.innerHTML.includes('return_summary_unavailable') && !h.box.innerHTML.includes('return_summary_done ('));
}

{
    const h = harness();
    h.renderReturnSummary(h.box, snapshot([]));
    const dangerous = `<img src=x onerror='alert(1)'>`;
    h.renderReturnSummary(h.box, snapshot([task('DONE', { title: dangerous, agent: dangerous })], 1, 'C:\\Project A',
        [{ id: dangerous, agent: dangerous, question: dangerous }]));
    check('agent text cannot introduce HTML or inline script', !h.box.innerHTML.includes('<img')
        && !h.box.innerHTML.includes('onclick=') && h.box.innerHTML.includes('&lt;img'));
    h.click('task'); h.click('approval');
    check('focus callbacks receive original text without executing it', h.calls[0][3] === dangerous && h.calls[1][1] === dangerous);
    const oldHandler = h.box.onclick;
    h.renderReturnSummary(h.box, snapshot([], 2));
    const before = h.values.get(h.RETURN_SUMMARY_KEY);
    h.click('seen', 0, oldHandler);
    check('detached render handlers cannot acknowledge obsolete snapshots', h.values.get(h.RETURN_SUMMARY_KEY) === before);
}

console.log(`\n${passed} passed, 0 failed`);
