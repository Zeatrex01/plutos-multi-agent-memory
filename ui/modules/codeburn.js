// CodeBurn tab: what the AI work is costing.
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
    <div style="background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:12px; padding:1.1rem 1.3rem;">
        <div style="color:var(--text-muted); font-size:0.78rem; margin-bottom:0.35rem;">${escHtml(label)}</div>
        <div style="font-family:var(--font-mono); font-weight:700; font-size:1.6rem; color:var(--text-title);">${escHtml(value)}</div>
        <div style="color:var(--text-muted); font-size:0.78rem; margin-top:0.2rem;">${escHtml(sub)}</div>
    </div>`;

function rangeControls(spend) {
    const btn = (id, label, active) => `
        <button onclick="setCodeburnRange('${id}')" style="
            padding:0.35rem 0.75rem; border-radius:999px; cursor:pointer; font-size:0.8rem;
            border:1px solid ${active ? 'var(--brand-primary)' : 'var(--border-subtle)'};
            background:${active ? 'var(--brand-primary)' : 'var(--bg-surface)'};
            color:${active ? '#fff' : 'var(--text-muted)'};">${escHtml(label)}</button>`;
    const active = (id) => !currentFrom && currentRange === id;
    const oldest = spend && spend.historyFrom ? spend.historyFrom : '';
    return `
        <div style="display:flex; flex-wrap:wrap; align-items:center; gap:0.5rem; margin-bottom:1.1rem;">
            <span style="color:var(--text-muted); font-size:0.78rem; margin-right:0.2rem;">${t('codeburn_range')}</span>
            ${RANGES.map(r => btn(r.id, t(r.labelKey), active(r.id))).join('')}
            <span style="width:1px; height:20px; background:var(--border-subtle); margin:0 0.3rem;"></span>
            <label style="color:var(--text-muted); font-size:0.78rem;">${t('codeburn_r_custom')}</label>
            <input type="date" value="${escHtml(currentFrom)}" ${oldest ? `min="${escHtml(oldest)}"` : ''}
                onchange="setCodeburnFrom(this.value)" style="
                padding:0.3rem 0.5rem; border-radius:8px; font-size:0.8rem;
                border:1px solid ${currentFrom ? 'var(--brand-primary)' : 'var(--border-subtle)'};
                background:var(--bg-surface); color:var(--text-title);">
        </div>`;
}

function dailyTable(spend) {
    if (!spend.daily || spend.daily.length === 0) {
        return `<p style="color:var(--text-muted); font-size:0.84rem;">${t('codeburn_no_days')}</p>`;
    }
    const rows = spend.daily.map(d => `
        <tr>
            <td style="padding:0.4rem 0.6rem; font-family:var(--font-mono); font-size:0.8rem; color:var(--text-title);">${escHtml(d.date)}</td>
            <td style="padding:0.4rem 0.6rem; text-align:right; font-family:var(--font-mono); font-size:0.8rem; color:var(--text-title);">${escHtml(d.costFormatted)}</td>
            <td style="padding:0.4rem 0.6rem; text-align:right; font-family:var(--font-mono); font-size:0.8rem; color:var(--text-muted);">${escHtml(String(d.calls))}</td>
        </tr>`).join('');
    const th = (label, align) => `<th style="padding:0.4rem 0.6rem; text-align:${align}; font-size:0.75rem; color:var(--text-muted); font-weight:600; border-bottom:1px solid var(--border-subtle);">${escHtml(label)}</th>`;
    return `
        <div style="background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:10px; overflow:hidden;">
            <div style="max-height:22rem; overflow-y:auto;">
                <table style="width:100%; border-collapse:collapse;">
                    <thead><tr>${th(t('codeburn_col_date'), 'left')}${th(t('codeburn_col_cost'), 'right')}${th(t('codeburn_col_calls'), 'right')}</tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>`;
}

// Opening the page reads CodeBurn's last answer and runs nothing; the button (run: true) asks
// CodeBurn now. Its figures are the whole machine's, which the card says.
export async function fetchCodeburn(background = false, run = false) {
    const generation = ++requestGeneration;
    if (refreshTimer !== null) { clearTimeout(refreshTimer); refreshTimer = null; }
    const box = document.getElementById('codeburn-container');
    if (!box) return;
    if (!background) box.innerHTML = `<p style="color:var(--text-muted); font-size:0.85rem;">${t('loading')}</p>`;

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
            box.innerHTML = `<p style="color:var(--text-muted);">${t('conn_error')}</p>`;
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
        <div style="display:flex; justify-content:space-between; align-items:center; gap:1rem; flex-wrap:wrap; margin-bottom:0.9rem;">
            <p style="color:var(--text-muted); font-size:0.84rem; margin:0; max-width:46rem;">${t('codeburn_machine_note')}</p>
            <button class="btn-secondary" onclick="runCodeburn()" ${spend?.pending ? 'disabled' : ''}><span>${t('codeburn_run')}</span></button>
        </div>
        ${rangeControls(spend)}
        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:1rem; margin-bottom:1.3rem;">
            ${stat(t('codeburn_selected'), standby ? '—' : spend.rangeCostFormatted, standby ? '' : spend.rangeCallsFormatted)}
            ${stat(t('codeburn_today'), standby ? '—' : spend.todayCostFormatted, standby ? '' : spend.todayCallsFormatted)}
            ${stat(t('codeburn_month'), standby ? '—' : spend.monthCostFormatted, standby ? '' : spend.monthCallsFormatted)}
        </div>
        ${notice || noticeDetail ? `
        <div style="background:var(--bg-surface); border:1px solid var(--border-subtle); border-left:3px solid var(--brand-primary);
                    border-radius:10px; padding:1rem 1.2rem; margin-bottom:1.3rem;">
            ${notice ? `<div style="color:var(--text-title); font-weight:600; font-size:0.9rem; margin-bottom:0.3rem;">${escHtml(notice)}</div>` : ''}
            ${noticeDetail ? `<p style="color:var(--text-muted); font-size:0.84rem; margin:0; line-height:1.55;">${escHtml(noticeDetail)}</p>` : ''}
        </div>` : ''}
        ${standby ? '' : `
        <div style="margin-bottom:0.6rem; display:flex; justify-content:space-between; align-items:baseline; gap:1rem; flex-wrap:wrap;">
            <span style="color:var(--text-title); font-weight:600; font-size:0.88rem;">${t('codeburn_daily')}</span>
            <span style="color:var(--text-muted); font-size:0.76rem; font-family:var(--font-mono);">${escHtml(windowLabel)}</span>
        </div>
        ${dailyTable(spend)}
        <p style="color:var(--text-muted); font-size:0.76rem; margin:0.9rem 0 0; line-height:1.5;">${t('codeburn_scope_note')}</p>
        <p style="color:var(--text-muted); font-size:0.76rem; margin:0.3rem 0 0; font-family:var(--font-mono);">
            ${t('codeburn_tracked')} ${escHtml(String(spend.historyDays || 0))} ${t('codeburn_days')}: ${escHtml(spend.historyFrom || '—')} → ${escHtml(spend.historyTo || '—')}
        </p>`}
        <p style="color:var(--text-muted); font-size:0.76rem; margin:0.6rem 0 0;">${t('codeburn_updated')}: ${escHtml(updated)}</p>`;
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
