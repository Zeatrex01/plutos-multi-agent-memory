// Home: the page a project opens on (owner decision d-51e97352b22e, 2026-11-14). One focal block,
// the questions waiting for the owner (#home-waiting, painted by approvals.js), then a short status
// list (#home-status): project, open board items, last session's Next, hooks, AI link, usage.
// Composed from views that already exist (/api/workspaces, /api/report, /api/hooks,
// /api/mcp/status, /api/usage); nothing here is stored.
import { t } from '../i18n.js';
import { escHtml } from '../esc.js';
import { emptyState } from './page.js';
import { refreshApprovals } from './approvals.js';
import { aiLinkWord } from './activity.js';

let overviewRequest = 0;

const json = url => fetch(url).then(r => { if (!r.ok) throw new Error(url); return r.json(); });

const row = (label, value) => `<div class="home-status-row"><dt>${escHtml(label)}</dt><dd>${value}</dd></div>`;

// The counts come from report.stats, which counts every entry; report.board's lists are cut at
// REPORT_LIMITS.boardItems (8) for display and would undercount a busy board.
// One line from /api/usage (lib/usage-report.mjs); no row when it did not load.
export function usageLine(usage) {
    if (!usage || usage.needsProject) return '';
    if (!usage.recorded) return `<span class="home-status-muted">${escHtml(t('home_usage_none'))}</span>`;
    const n = usage.totals || {};
    return `<span>${escHtml(t('home_usage_line').replace('{ais}', n.ais || 0).replace('{calls}', n.toolCalls || 0)
        .replace('{sessions}', n.sessionsStarted || 0))}</span>`;
}

export function statusHtml({ project, report, hooks, mcp, usage }) {
    const stats = report?.stats || {};
    const open = (stats.todo || 0) + (stats.inProgress || 0) + (stats.blocked || 0);
    const blocked = stats.blocked || 0;
    const next = report?.sessions?.[0]?.next;
    const own = Array.isArray(hooks?.hooks) ? hooks.hooks : [];
    const on = own.filter(h => h.on).length;
    const connected = mcp?.state === 'connected';

    const rows = [
        row(t('sys_project'), `<span class="home-status-value">${escHtml(project)}</span>`),
        row(t('home_open_items'), report
            ? `<button type="button" class="card-link home-status-value" onclick="switchView('board')">${open}</button>`
                + (blocked ? ` <span class="pill pill-blocked">${blocked} ${escHtml(t('overview_blocked_pill'))}</span>` : '')
            : `<span class="home-status-muted">${escHtml(t('conn_error'))}</span>`),
        row(t('home_last_next'), next
            ? `<span>${escHtml(next)}</span>` : `<span class="home-status-muted">${escHtml(t('home_none'))}</span>`),
        row(t('home_hooks'), hooks
            ? `<span>${escHtml(t('home_hooks_count').replace('{on}', on).replace('{total}', own.length))}</span>`
            : `<span class="home-status-muted">${escHtml(t('conn_error'))}</span>`),
        row(t('sys_ai'), `<span>${escHtml(mcp ? aiLinkWord(mcp) : t('activity_offline'))}</span>`
            + (mcp && !connected ? ` <button type="button" class="btn-secondary btn-sm" onclick="openConnect()">${escHtml(t('home_connect_ai'))}</button>` : ''))
    ];
    const used = usageLine(usage);
    if (used) rows.push(row(t('home_usage').replace('{days}', usage.days || 7), used));
    return `<dl class="home-status">${rows.join('')}</dl>`;
}

export async function fetchOverview() {
    const status = document.getElementById('home-status');
    if (!status) return;
    const request = ++overviewRequest;
    refreshApprovals();
    const [ws, report, hooks, mcp, usage] = (await Promise.allSettled([
        json('/api/workspaces'), json('/api/report'), json('/api/hooks'), json('/api/mcp/status'), json('/api/usage?days=7')
    ])).map(r => r.status === 'fulfilled' ? r.value : null);
    if (request !== overviewRequest) return;

    if (ws && !ws.activeWorkspace) {
        status.innerHTML = emptyState({ icon: 'folder-open', title: t('home_no_project_title'), text: t('home_no_project_text'),
            action: { label: t('home_go_projects'), onclick: "switchView('hub-view')" } });
        lucide.createIcons();
        return;
    }
    if (!ws && !report) {
        status.innerHTML = emptyState({ icon: 'wifi-off', title: t('conn_error'), text: t('home_load_error') });
        lucide.createIcons();
        return;
    }
    const project = report?.project || (ws?.activeWorkspace || '').split(/[\\/]/).pop() || '—';
    status.innerHTML = statusHtml({ project, report: report && report.board ? report : null, hooks, mcp, usage });
}
