// A bounded browser-local comparison, not an event ledger. The caller owns fetching and
// must reject responses for a project/request that is no longer current before rendering.
import { t } from '../i18n.js';
import { escHtml } from '../esc.js';

export const RETURN_SUMMARY_KEY = 'plutos-return-summary-v1';
export const RETURN_SUMMARY_LIMITS = { projects: 20, records: 2000, perProject: 1000 };
const STATUSES = new Set(['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE']);
const panels = new Map();
const text = value => typeof value === 'string' ? value.trim() : '';
const field = (entry, name) => text(Object.entries(entry.fields || {}).find(([key]) => key.toLowerCase() === name)?.[1]);

export function returnProjectKey(value) {
    const root = text(value);
    if (!root || root.length > 8192) return '';
    if (/^(?:[a-z]:[\\/]|\\\\|\/\/)/i.test(root)) {
        const normalized = root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        return /^[a-z]:$/.test(normalized) ? normalized + '/' : normalized;
    }
    return root.startsWith('/') ? root.replace(/\/+$/, '') || '/' : '';
}

export function returnTaskKey(entry) {
    if (!entry || !['main', 'agents'].includes(entry.board) || !text(entry.title)) return '';
    const title = text(entry.title).toLowerCase();
    const opener = (field(entry, 'opened by') || text(entry.agent)).toLowerCase();
    const key = JSON.stringify([entry.board, title, field(entry, 'started'), opener]);
    return key.length <= 1024 ? key : '';
}

export function compactReturnSnapshot(snapshot) {
    const projectRoot = returnProjectKey(snapshot?.projectRoot);
    const timestamp = ['string', 'number'].includes(typeof snapshot?.capturedAt) ? new Date(snapshot.capturedAt).getTime() : NaN;
    if (!projectRoot || !Number.isFinite(timestamp) || !Array.isArray(snapshot.entries)) return null;
    const records = new Map();
    const ambiguous = new Set();
    let incomplete = false;
    for (const entry of snapshot.entries) {
        const key = returnTaskKey(entry);
        if (!key || !STATUSES.has(entry?.status)) { incomplete = true; continue; }
        if (records.has(key) || ambiguous.has(key)) {
            records.delete(key); ambiguous.add(key); incomplete = true; continue;
        }
        if (records.size >= RETURN_SUMMARY_LIMITS.perProject) { incomplete = true; continue; }
        records.set(key, entry.status);
    }
    return { projectRoot, capturedAt: new Date(timestamp).toISOString(), incomplete,
        records: [...records].map(([key, status]) => ({ key, status })) };
}

export function diffReturnSnapshots(baseline, snapshot) {
    const current = compactReturnSnapshot(snapshot);
    const comparable = !!current && baseline?.projectRoot === current.projectRoot;
    const outdated = comparable && Date.parse(baseline.capturedAt) > Date.parse(current.capturedAt);
    const result = { hasBaseline: comparable, outdated, incomplete: !!(current?.incomplete || baseline?.incomplete), done: [], blocked: [] };
    if (!comparable || outdated) return result;
    const previous = new Map(baseline.records.map(record => [record.key, record.status]));
    const retained = new Set(current.records.map(record => record.key));
    for (const entry of snapshot.entries) {
        const key = returnTaskKey(entry);
        if (!retained.has(key) || (!previous.has(key) && baseline.incomplete)) continue;
        if (entry.status === 'DONE' && previous.get(key) !== 'DONE') result.done.push(entry);
        if (entry.status === 'BLOCKED' && previous.get(key) !== 'BLOCKED') result.blocked.push(entry);
    }
    // Missing rows can have been archived or removed; absence never means completion.
    return result;
}

export function boundedReturnBaselines(projects) {
    let records = 0;
    return [...projects].sort((a, b) => b.savedAt - a.savedAt).filter((project, index) => {
        if (index >= RETURN_SUMMARY_LIMITS.projects || records + project.records.length > RETURN_SUMMARY_LIMITS.records) return false;
        records += project.records.length;
        return true;
    });
}

function readBaselines() {
    let raw;
    try { raw = localStorage.getItem(RETURN_SUMMARY_KEY); }
    catch { return { projects: [], problem: 'return_summary_unavailable' }; }
    if (!raw) return { projects: [], problem: '' };
    try {
        if (raw.length > 3 * 1024 * 1024) throw new Error('Oversized comparison');
        const parsed = JSON.parse(raw);
        if (parsed.version !== 1 || !Array.isArray(parsed.projects) || parsed.projects.length > RETURN_SUMMARY_LIMITS.projects) throw new Error('Unknown comparison');
        const roots = new Set();
        for (const project of parsed.projects) {
            if (!project || !project.projectRoot || project.projectRoot !== returnProjectKey(project.projectRoot) || roots.has(project.projectRoot)
                || !Number.isFinite(Date.parse(project.capturedAt)) || !Number.isFinite(project.savedAt)
                || typeof project.incomplete !== 'boolean' || !Array.isArray(project.records)
                || project.records.length > RETURN_SUMMARY_LIMITS.perProject) throw new Error('Invalid comparison');
            roots.add(project.projectRoot);
            const keys = new Set();
            for (const record of project.records) {
                if (!record || typeof record.key !== 'string' || !record.key || record.key.length > 1024
                    || keys.has(record.key) || !STATUSES.has(record.status)) throw new Error('Invalid task');
                keys.add(record.key);
            }
        }
        return { projects: boundedReturnBaselines(parsed.projects), problem: '' };
    } catch { return { projects: [], problem: 'return_summary_reset' }; }
}

function saveBaseline(projects, current) {
    const next = boundedReturnBaselines([
        { ...current, savedAt: Date.now() },
        ...projects.filter(project => project.projectRoot !== current.projectRoot)
    ]);
    try { localStorage.setItem(RETURN_SUMMARY_KEY, JSON.stringify({ version: 1, projects: next })); return true; }
    catch { return false; }
}

function copySnapshot(snapshot) {
    return {
        projectRoot: snapshot.projectRoot, capturedAt: snapshot.capturedAt,
        entries: snapshot.entries.map(entry => ({ board: entry?.board, agent: text(entry?.agent), status: entry?.status,
            title: text(entry?.title), fields: { Started: field(entry || {}, 'started'), 'Opened by': field(entry || {}, 'opened by') } })),
        pendingApprovals: (Array.isArray(snapshot.pendingApprovals) ? snapshot.pendingApprovals : [])
            .filter(question => typeof question?.id === 'string' && question.id)
            .map(question => ({ id: question.id, agent: text(question.agent), question: text(question.question) }))
    };
}

export function renderReturnSummary(container, snapshot) {
    if (!container) return;
    const current = compactReturnSnapshot(snapshot);
    if (!current) {
        panels.delete(container);
        container.innerHTML = `<p>${escHtml(t('return_summary_unavailable'))}</p>`;
        container.onclick = null;
        return;
    }
    const previousPanel = panels.get(container);
    if (previousPanel?.current.projectRoot === current.projectRoot
        && Date.parse(previousPanel.current.capturedAt) > Date.parse(current.capturedAt)) return;
    // Snapshot primitives are copied so a later poll cannot change what Mark seen saves.
    const view = { current, snapshot: copySnapshot(snapshot) };
    for (const [panel] of panels) if (!panel.isConnected) panels.delete(panel);
    panels.set(container, view);
    const stored = readBaselines();
    let baseline = stored.projects.find(project => project.projectRoot === current.projectRoot);
    let problem = stored.problem;
    const first = !baseline;
    if (first && problem !== 'return_summary_unavailable' && !saveBaseline(stored.projects, current)) problem = 'return_summary_unavailable';
    const changes = diffReturnSnapshots(baseline, view.snapshot);
    const tasks = [...changes.done, ...changes.blocked];
    const approvals = view.snapshot.pendingApprovals;
    const button = (action, index, label) => `<button type="button" class="btn-secondary btn-sm" data-return-action="${action}" data-return-index="${index}"
        style="text-align:left;display:block;max-width:100%;white-space:normal;margin-top:0.4rem;">${escHtml(label)}</button>`;
    const taskList = (entries, offset) => entries.map((entry, index) => button('task', offset + index, `${entry.agent} · ${entry.title}`)).join('');
    const list = (title, content) => `<div><p class="empty-title">${escHtml(title)}</p><div style="max-height:10rem;overflow:auto;">${content}</div></div>`;
    const notices = [problem, first ? 'return_summary_first' : '', changes.incomplete ? 'return_summary_incomplete' : '', changes.outdated ? 'return_summary_outdated' : ''].filter(Boolean);
    const comparable = changes.hasBaseline && !changes.outdated;
    container.innerHTML = `<section class="card">
        <div class="card-head">
            <h3 class="card-title"><i data-lucide="bell"></i> ${escHtml(t('return_summary_title'))}</h3>
            <button type="button" class="btn-secondary btn-sm" style="margin-left:auto;" data-return-action="seen" ${changes.outdated ? 'disabled' : ''}>${escHtml(t('return_summary_mark_seen'))}</button>
        </div>
        <p class="card-sub">${escHtml(t('return_summary_scope'))}</p>
        ${baseline ? `<p class="page-status">${escHtml(t('return_summary_since'))}: ${escHtml(new Date(baseline.capturedAt).toLocaleString())}</p>` : ''}
        ${notices.map(key => `<p class="page-status">${escHtml(t(key))}</p>`).join('')}
        <div class="kv-grid" style="margin-top:0.75rem;">
            ${comparable ? list(`${t('return_summary_done')} (${changes.done.length})`, taskList(changes.done, 0))
                + list(`${t('return_summary_blocked')} (${changes.blocked.length})`, taskList(changes.blocked, changes.done.length)) : ''}
            ${list(`${t('return_summary_approvals')} (${approvals.length})`, approvals.length
                ? approvals.map((question, index) => button('approval', index, `${question.agent} · ${question.question}`)).join('')
                : `<p class="page-status">${escHtml(t('return_summary_no_decisions'))}</p>`)}
        </div>
        ${comparable && !tasks.length && !changes.incomplete ? `<p class="page-status">${escHtml(t('return_summary_none'))}</p>` : ''}
    </section>`;
    globalThis.lucide?.createIcons?.();
    container.onclick = event => {
        const target = event.target.closest?.('[data-return-action]');
        if (!target || !container.contains(target) || panels.get(container) !== view) return;
        const index = Number(target.dataset.returnIndex);
        if (target.dataset.returnAction === 'task' && tasks[index]) {
            const task = tasks[index];
            window.focusBoardTask?.(task.board, task.agent, task.title, current.projectRoot);
        } else if (target.dataset.returnAction === 'approval' && approvals[index]) {
            window.focusApproval?.(approvals[index].id, current.projectRoot);
        } else if (target.dataset.returnAction === 'seen') {
            // Re-read immediately: another tab may already have acknowledged newer data.
            const latest = readBaselines();
            if (latest.problem === 'return_summary_unavailable') {
                target.textContent = t('return_summary_unavailable'); return;
            }
            baseline = latest.projects.find(project => project.projectRoot === current.projectRoot);
            if (baseline && Date.parse(baseline.capturedAt) > Date.parse(current.capturedAt)) {
                renderReturnSummary(container, view.snapshot); return;
            }
            if (!saveBaseline(latest.projects, current)) {
                target.textContent = t('return_summary_unavailable'); return;
            }
            renderReturnSummary(container, view.snapshot);
        }
    };
}

window.addEventListener('storage', event => {
    if (event.key !== null && event.key !== RETURN_SUMMARY_KEY) return;
    for (const [container, view] of [...panels]) {
        if (!container.isConnected) panels.delete(container);
        else renderReturnSummary(container, view.snapshot);
    }
});
