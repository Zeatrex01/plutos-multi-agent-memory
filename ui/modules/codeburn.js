// The Costs page's second half: what the AI work is costing, machine-wide, from CodeBurn.
//
// The numbers come from the CodeBurn CLI, not the CodeBurn MCP: lib/spend.mjs shells out to
// `npx --no codeburn status` (only when CodeBurn is installed) and parses it. That distinction is worth stating on the page,
// because "CodeBurn is not installed" reads as a broken tab otherwise — the MCP is the
// optional wiring the AGENTS get, and this view needs none of it.
//
// This used to be one of five panels stacked in the Overview's right column, which is what
// pushed that screen past the length of a glance. Overview keeps the compact spend tile;
// the detail lives here, where it has room.
//
// It also used to show exactly two figures, today and the calendar month to date, which on
// the 1st of a month are the same number — the tab looked like it had lost its history when
// the history was never being asked for. The range selector below is that fix: the CLI hands
// back its whole daily series on every call, so every window here is a filter over data we
// already have, not another trip to the CLI.
import { t } from '../i18n.js';
import { escHtml } from '../esc.js';

// The parser reports this exact string when the CLI could not be reached, and it is the one
// state that needs an explanation rather than a number.
const STANDBY = 'CodeBurn standby';

const RANGE_KEY = 'plutos-codeburn-range';
const RANGES = [
    { id: 'today', labelKey: 'codeburn_r_today' },
    { id: '7d', labelKey: 'codeburn_r_7d' },
    { id: '30d', labelKey: 'codeburn_r_30d' },
    { id: 'month', labelKey: 'codeburn_r_month' },
    { id: 'all', labelKey: 'codeburn_r_all' }
];

// Persisted so the tab reopens on the window the owner actually works in — the whole point
// of the selector is lost if it snaps back to one month every time.
let currentRange = 'month';
let currentFrom = '';
let requestGeneration = 0;
let refreshTimer = null;
let lastSpend = null;
const isVisible = () => document.getElementById('view-costs')?.classList.contains('active');
try {
    const saved = localStorage.getItem(RANGE_KEY);
    if (saved && (RANGES.some(r => r.id === saved) || /^\d{4}-\d{2}-\d{2}$/.test(saved))) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(saved)) currentFrom = saved; else currentRange = saved;
    }
} catch (e) { /* storage blocked */ }

function persist(value) {
    try { localStorage.setItem(RANGE_KEY, value); } catch (e) { /* storage blocked */ }
}

const stat = (label, value, sub) => `
    <div class="cost-stat">
        <div class="cost-stat-label">${escHtml(label)}</div>
        <div class="cost-stat-value">${escHtml(value)}</div>
        <div class="cost-stat-label">${escHtml(sub)}</div>
    </div>`;

function rangeControls(spend) {
    const btn = (id, label, active) => `
        <button type="button" class="btn-secondary btn-sm" aria-pressed="${active ? 'true' : 'false'}" onclick="setCodeburnRange('${id}')">${escHtml(label)}</button>`;
    const active = (id) => !currentFrom && currentRange === id;
    const oldest = spend && spend.historyFrom ? spend.historyFrom : '';
    return `
        <div class="field-row cost-ranges">
            <span class="page-status">${t('codeburn_range')}</span>
            ${RANGES.map(r => btn(r.id, t(r.labelKey), active(r.id))).join('')}
            <label class="page-status" for="codeburn-from">${t('codeburn_r_custom')}</label>
            <input type="date" id="codeburn-from" class="field-input field-sm" value="${escHtml(currentFrom)}" ${oldest ? `min="${escHtml(oldest)}"` : ''}
                onchange="setCodeburnFrom(this.value)">
        </div>`;
}

function dailyTable(spend) {
    if (!spend.daily || spend.daily.length === 0) {
        return `<p class="page-status">${t('codeburn_no_days')}</p>`;
    }
    const rows = spend.daily.map(d => `
        <tr>
            <td>${escHtml(d.date)}</td>
            <td class="num strong">${escHtml(d.costFormatted)}</td>
            <td class="num">${escHtml(String(d.calls))}</td>
        </tr>`).join('');
    return `
        <div class="usage-scroll cost-days">
            <table class="usage-table">
                <thead><tr><th>${escHtml(t('codeburn_col_date'))}</th><th class="num">${escHtml(t('codeburn_col_cost'))}</th><th class="num">${escHtml(t('codeburn_col_calls'))}</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
}

// Opening the page reads CodeBurn's last answer and runs nothing; the button (run: true) asks
// CodeBurn now. Its figures are the whole machine's, which the card says.
export async function fetchCodeburn(background = false, run = false) {
    const generation = ++requestGeneration;
    if (refreshTimer !== null) { clearTimeout(refreshTimer); refreshTimer = null; }
    const box = document.getElementById('codeburn-container');
    if (!box) return;
    if (!background) box.innerHTML = `<p class="page-status">${t('loading')}</p>`;

    const query = currentFrom ? `from=${encodeURIComponent(currentFrom)}` : `range=${encodeURIComponent(currentRange)}`;
    let spend;
    try {
        const response = run ? await fetch(`/api/spend/run?${query}`, { method: 'POST' }) : await fetch(`/api/spend?${query}`);
        if (!response.ok) throw new Error('Spend request failed');
        spend = await response.json();
        if (generation === requestGeneration) lastSpend = spend;
    } catch (e) {
        if (generation !== requestGeneration) return;
        if (background && lastSpend) {
            spend = { ...lastSpend, pending: false, error: t('codeburn_unavailable'), stale: !lastSpend.standby };
        } else {
            box.innerHTML = `<p class="page-status">${t('conn_error')}</p>`;
            return;
        }
    }
    if (generation !== requestGeneration) return;

    const standby = !spend || (typeof spend.standby === 'boolean' ? spend.standby : spend.rawSummary === STANDBY);
    const notice = spend?.pending ? t('codeburn_loading')
        : spend?.error ? t('codeburn_unavailable') : standby ? t('codeburn_standby_title') : '';
    const noticeDetail = spend?.stale && !standby ? t('codeburn_stale')
        : standby && !spend?.pending ? t('codeburn_standby') : '';
    const updated = spend && spend.updatedAt ? new Date(spend.updatedAt).toLocaleString() : '—';
    const windowLabel = spend && spend.rangeFrom
        ? `${spend.rangeFrom} → ${spend.rangeTo} · ${spend.rangeDays} ${t('codeburn_days')}`
        : '';

    box.innerHTML = `
        <div class="cost-head">
            <p class="page-status">${t('codeburn_machine_note')}</p>
            <button type="button" class="btn-secondary btn-sm" onclick="runCodeburn()" ${spend?.pending ? 'disabled' : ''}><span>${t('codeburn_run')}</span></button>
        </div>
        ${rangeControls(spend)}
        <div class="cost-stats">
            ${stat(t('codeburn_selected'), standby ? '—' : spend.rangeCostFormatted, standby ? '' : spend.rangeCallsFormatted)}
            ${stat(t('codeburn_today'), standby ? '—' : spend.todayCostFormatted, standby ? '' : spend.todayCallsFormatted)}
            ${stat(t('codeburn_month'), standby ? '—' : spend.monthCostFormatted, standby ? '' : spend.monthCallsFormatted)}
        </div>
        ${notice || noticeDetail ? `
        <div class="panel cost-notice">
            ${notice ? `<b>${escHtml(notice)}</b>` : ''}
            ${noticeDetail ? `<p class="page-status">${escHtml(noticeDetail)}</p>` : ''}
        </div>` : ''}
        ${standby ? '' : `
        <div class="cost-daily-head">
            <b>${t('codeburn_daily')}</b>
            <span class="page-status">${escHtml(windowLabel)}</span>
        </div>
        ${dailyTable(spend)}
        <p class="page-status">${t('codeburn_scope_note')}</p>
        <p class="page-status">
            ${t('codeburn_tracked')} ${escHtml(String(spend.historyDays || 0))} ${t('codeburn_days')}: ${escHtml(spend.historyFrom || '—')} → ${escHtml(spend.historyTo || '—')}
        </p>`}
        <p class="page-status">${t('codeburn_updated')}: ${escHtml(updated)}</p>`;
    if (spend?.pending && isVisible()) {
        refreshTimer = setTimeout(() => {
            refreshTimer = null;
            if (generation === requestGeneration && isVisible()) void fetchCodeburn(true);
        }, 2000);
    }
}

// Both return the render promise. Nothing in the browser waits on it — onclick discards it —
// but it is the only handle a test has on when the re-render has actually finished.
window.setCodeburnRange = function(id) {
    currentRange = id;
    currentFrom = '';
    persist(id);
    return fetchCodeburn();
};

window.setCodeburnFrom = function(value) {
    // Clearing the date input falls back to the last named range rather than to an empty
    // view, which is what an empty date would otherwise ask the server for.
    currentFrom = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
    persist(currentFrom || currentRange);
    return fetchCodeburn();
};

window.refreshCodeburn = () => fetchCodeburn();
window.runCodeburn = () => fetchCodeburn(false, true);
