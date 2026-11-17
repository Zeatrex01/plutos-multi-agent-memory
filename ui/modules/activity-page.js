// Activity: usage and work on a page of their own (owner, 2026-11-15: "a separate page", not Home).
// Layout is the owner's draft B (decision d-872338fa9556, 2026-11-17): three large numbers, a per-AI
// table with inline bars beside the most used and never-called tools (#activity-usage, from
// /api/usage), then the board as a four-column strip and the last sessions as a table
// (#activity-work, from /api/report). One accent, only for what needs attention. Nothing is stored.
import { t, currentLang } from '../i18n.js';
import { escHtml } from '../esc.js';
import { emptyState } from './page.js';

let activityRequest = 0;
let activityDays = 7;
const DAY_CHOICES = [7, 30];

const json = url => fetch(url).then(r => { if (!r.ok) throw new Error(url); return r.json(); });
const num = v => Number.isFinite(Number(v)) ? Number(v) : 0;
const fill = (key, vars) => Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), t(key));

// Dates follow the dashboard's language; the vm test has no i18n binding and gets English.
const locale = () => (typeof currentLang !== 'undefined' && currentLang === 'tr') ? 'tr-TR' : 'en-GB';
const validDate = v => { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

// → { day: "Today" | "Yesterday" | "15 Nov", time: "14:20" }, or null for an unreadable time.
function when(value, now = new Date()) {
    const d = validDate(value);
    if (!d) return null;
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    const day = sameDay(d, now) ? t('act_today') : sameDay(d, yesterday) ? t('act_yesterday')
        : d.toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
    return { day, time: d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) };
}

function rangeText(usage) {
    const a = validDate(usage?.since), b = validDate(usage?.until);
    if (!a || !b) return '';
    const f = new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'long' });
    return typeof f.formatRange === 'function' ? f.formatRange(a, b) : `${f.format(a)} – ${f.format(b)}`;
}

// "Usage" (owner, 2026-11-15; draft B 2026-11-17): from /api/usage (lib/usage-report.mjs
// buildUsageReport). AI names and tool names come from the log, which any client writes: every one
// is escaped. "Left open" is sessions started minus sessions ended (session_end) in the window.
const kpi = (n, label, detail, alert) => `<div class="act-kpi${alert ? ' act-alert' : ''}"><div class="act-kpi-n">${num(n)}</div>`
    + `<div class="act-kpi-l">${escHtml(label)}</div>${detail ? `<div class="act-kpi-d">${escHtml(detail)}</div>` : ''}</div>`;

export function usageHtml(usage) {
    if (!usage || usage.needsProject) return `<p class="act-muted">${escHtml(t('conn_error'))}</p>`;
    if (!usage.recorded) return `<p class="act-note">${escHtml(t('home_usage_none'))}</p>`;
    const n = usage.totals || {};
    const ais = Array.isArray(usage.ais) ? usage.ais : [];
    const openOf = a => Math.max(0, num(a.sessionsStarted) - num(a.sessionsEnded));
    // Per AI, so one AI's extra session_end (a record from before the log) cannot hide another's open session.
    const leftOpen = ais.reduce((sum, a) => sum + openOf(a), 0);
    const openBy = ais.filter(a => openOf(a) > 0).map(a => `${a.ai} ${openOf(a)}`).join(', ');
    const out = [`<div class="act-kpis">`
        + kpi(n.toolCalls, t('home_usage_calls'), fill('act_from_ais', { n: num(n.ais) }))
        + kpi(n.sessionsStarted, t('act_opened_label'), fill('act_closed_detail', { n: num(n.sessionsEnded) }))
        + kpi(leftOpen, t('act_left_open_label'), leftOpen ? openBy : t('act_all_closed'), leftOpen > 0)
        + '</div>'];

    let table;
    if (ais.length) {
        const max = Math.max(1, ...ais.map(a => num(a.toolCalls)));
        table = `<div class="act-scroll"><table class="act-table act-ais"><thead><tr><th scope="col">${escHtml(t('home_usage_ai'))}</th>`
            + `<th scope="col" class="act-bar-col">${escHtml(t('act_col_calls'))}</th><th scope="col" class="act-num">${escHtml(t('act_col_opened'))}</th>`
            + `<th scope="col" class="act-num">${escHtml(t('act_col_closed'))}</th><th scope="col" class="act-hide-m">${escHtml(t('act_col_last_seen'))}</th></tr></thead><tbody>`
            + ais.map(a => {
                const seen = when(a.lastSeen);
                const short = openOf(a) > 0;
                return `<tr><th scope="row">${escHtml(a.ai)}</th>`
                    + `<td><div class="act-callbar"><b>${num(a.toolCalls)}</b><span><i style="width:${(num(a.toolCalls) / max * 100).toFixed(1)}%"></i></span></div></td>`
                    + `<td class="act-num">${num(a.sessionsStarted)}</td>`
                    + `<td class="act-num">${short ? `<span class="act-warn">${num(a.sessionsEnded)}</span>` : num(a.sessionsEnded)}</td>`
                    + `<td class="act-hide-m act-muted">${seen ? escHtml(`${seen.day} ${seen.time}`) : '—'}</td></tr>`;
            }).join('') + '</tbody></table></div>';
    } else {
        table = `<p class="act-note">${escHtml(t('home_usage_quiet'))}</p>`;
    }

    const top = (Array.isArray(usage.tools?.top) ? usage.tools.top : []).slice(0, 5);
    const never = Array.isArray(usage.tools?.neverCalled) ? usage.tools.neverCalled : [];
    const tools = `<h4 class="act-h3">${escHtml(t('act_most_called'))}</h4>` + (top.length
        ? `<ol class="act-top">${top.map(s => `<li><code>${escHtml(s.name)}</code><b>${num(s.calls)}</b></li>`).join('')}</ol>`
        : `<p class="act-muted">${escHtml(t('home_none'))}</p>`)
        + `<div class="act-never"><h4 class="act-h3">${escHtml(t('act_never_called'))} `
        + `<span class="${never.length ? 'act-accent' : ''}">${never.length}</span> <span class="act-muted act-light">/ ${num(usage.tools?.listedCount)}</span></h4>`
        + (never.length ? `<p class="act-never-list">${never.map(name => `<code>${escHtml(name)}</code>`).join(' · ')}</p>` : '')
        + '</div>';

    out.push(`<div class="act-usage"><div class="act-usage-main"><h3 class="act-h2">${escHtml(t('act_per_ai'))}</h3>${table}</div>`
        + `<div class="act-tools"><h3 class="act-h2">${escHtml(t('act_tools'))}</h3>${tools}</div></div>`);
    return out.join('');
}

// "Work" (owner, 2026-11-15; draft B 2026-11-17): the board strip and the last sessions, from
// /api/report (lib/report.mjs). Every headline, Did, Not checked, Next, title and reason is
// AI-written text and escaped.
function boardColumn(kind, label, count, items) {
    const list = Array.isArray(items) ? items : [];
    const more = num(count) - list.length;
    const rows = list.map(e => {
        const why = kind === 'blocked' && (e.needs || e.result);
        return `<li>${escHtml(e.title)}${why ? `<small class="act-why">${escHtml(fill('act_waits_on', { text: e.needs || e.result }))}</small>` : ''}`
            + (!why && e.agent ? `<small>${escHtml(e.agent)}</small>` : '') + '</li>';
    }).join('');
    return `<div class="act-col act-col-${kind}"><div class="act-col-h"><em>${escHtml(label)}</em><span>${num(count)}</span></div>`
        + (rows ? `<ul>${rows}</ul>` : `<p class="act-col-empty">—</p>`)
        + (more > 0 ? `<p class="act-col-more">${escHtml(fill('home_work_more', { n: more }))}</p>` : '') + '</div>';
}

const cell = (label, value, cls = '') => value
    // Session text can run long; it shows three lines and opens in full on click (owner pick B has short rows).
    ? `<td class="${cls}" data-l="${escHtml(label)}"><span class="act-clamp" tabindex="0" onclick="this.classList.toggle('open')" title="${escHtml(value)}">${escHtml(value)}</span></td>`
    : `<td class="act-muted act-empty ${cls}" data-l="${escHtml(label)}">—</td>`;

export function workHtml(report) {
    if (!report || !report.board) return `<p class="act-muted">${escHtml(t('conn_error'))}</p>`;
    const stats = report.stats || {};
    const total = num(stats.blocked) + num(stats.inProgress) + num(stats.todo) + num(stats.done);
    const out = [`<div class="act-work-h"><h3 class="act-h2">${escHtml(t('home_work_board'))}</h3>`
        + `<span class="act-muted">${escHtml(fill('act_board_count', { n: total }))}</span></div>`
        + '<div class="act-strip">'
        + boardColumn('blocked', t('act_blocked'), stats.blocked, report.board.blocked)
        + boardColumn('progress', t('act_in_progress'), stats.inProgress, report.board.inProgress)
        + boardColumn('todo', t('act_todo'), stats.todo, report.board.todo)
        + boardColumn('done', t('act_done'), stats.done, report.board.done) + '</div>'];

    const sessions = Array.isArray(report.sessions) ? report.sessions.slice(0, 5) : [];
    out.push(`<h3 class="act-h2">${escHtml(t('home_work_sessions'))}</h3>`);
    if (!sessions.length) {
        out.push(`<p class="act-note">${escHtml(t('home_work_no_sessions'))}</p>`);
        return out.join('');
    }
    const [did, nc, next] = [t('act_col_did'), t('act_col_not_checked'), t('act_col_next')];
    out.push('<table class="act-table act-sessions"><colgroup><col class="act-c1"><col class="act-c2"><col><col><col></colgroup>'
        + `<thead><tr><th scope="col">${escHtml(t('act_col_when'))}</th><th scope="col">${escHtml(t('act_col_session'))}</th>`
        + `<th scope="col">${escHtml(did)}</th><th scope="col" class="act-accent">${escHtml(nc)}</th><th scope="col">${escHtml(next)}</th></tr></thead><tbody>`
        + sessions.map(s => {
            const w = when(s.time);
            return '<tr>'
                + `<td class="act-when">${w ? `<b>${escHtml(w.day)}</b>${escHtml(w.time)}` : '—'}</td>`
                + `<td class="act-head"><strong>${escHtml(s.headline || '—')}</strong><span>${escHtml(s.ai)}</span></td>`
                + cell(did, s.did) + cell(nc, s.notChecked, 'act-nc') + cell(next, s.next) + '</tr>';
        }).join('') + '</tbody></table>');
    return out.join('');
}

const SECTIONS = ['activity-usage', 'activity-work'];

function showSections(htmlById) {
    for (const id of SECTIONS) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = htmlById ? htmlById[id] : '';
        const section = document.getElementById(`${id}-section`);
        if (section) section.hidden = !htmlById;
    }
}

function setRange(text) {
    const el = document.getElementById('activity-range');
    if (el) el.textContent = text;
    const select = document.getElementById('activity-days');
    if (select) { select.value = String(activityDays); select.setAttribute('aria-label', t('act_period')); }
}

export async function fetchActivityPage() {
    const empty = document.getElementById('activity-empty');
    if (!empty) return;
    const request = ++activityRequest;
    const [ws, report, usage] = (await Promise.allSettled([
        json('/api/workspaces'), json('/api/report'), json(`/api/usage?days=${activityDays}`)
    ])).map(r => r.status === 'fulfilled' ? r.value : null);
    if (request !== activityRequest) return;

    // With no project or no server, the sections say nothing rather than stale data.
    if (ws && !ws.activeWorkspace) {
        showSections(null);
        setRange('');
        empty.innerHTML = emptyState({ icon: 'folder-open', title: t('home_no_project_title'), text: t('home_no_project_text'),
            action: { label: t('home_go_projects'), onclick: "switchView('hub-view')" } });
        lucide.createIcons();
        return;
    }
    if (!ws && !report) {
        showSections(null);
        setRange('');
        empty.innerHTML = emptyState({ icon: 'wifi-off', title: t('conn_error'), text: t('home_load_error') });
        lucide.createIcons();
        return;
    }
    empty.innerHTML = '';
    setRange(rangeText(usage));
    showSections({ 'activity-usage': usageHtml(usage), 'activity-work': workHtml(report) });
}

// The period picker in the page head (draft B's "Last 7 days"): re-reads /api/usage for that window.
export function setActivityDays(value) {
    const n = Number(value);
    activityDays = DAY_CHOICES.includes(n) ? n : 7;
    return fetchActivityPage();
}
if (typeof window !== 'undefined') window.setActivityDays = setActivityDays;
