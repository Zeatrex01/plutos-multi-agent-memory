// Home — the page a project opens on. It answers, in this order: what needs the owner, the next
// setup step while there is one, what is happening now, and what happened recently (owner,
// 2026-10-28: the panels did not explain themselves, and the old Overview led with git counters).
// Everything is composed from views that already exist (/api/report, /api/hygiene, /api/activity,
// /api/mcp/status, /api/workspaces); nothing here is stored. Not /api/deck:
// it reads every session archive, and Home is the page PLUT_OS opens on.
// The technical view (files being edited, last commit, durable context, map health) is folded under
// Project details at the bottom of the page.
import { t } from '../i18n.js';
import { showToast } from './toast.js';
import { escHtml } from '../esc.js';
import { renderReturnSummary, returnProjectKey } from './return-summary.js';
import { emptyState, askLine, commandLine } from './page.js';

let overviewDays = 7;
let overviewRequest = 0;
let summaryRequest = 0;
let summaryInFlight = false;
let summaryFlightHost;

export async function refreshReturnSummary() {
    const container = document.getElementById('return-summary');
    if (!container || (summaryInFlight && summaryFlightHost === container)) return;
    const request = ++summaryRequest;
    const project = window.activeWorkspacePath;
    if (!project) { container.innerHTML = `<p>${t('return_summary_unavailable')}</p>`; return; }
    summaryInFlight = true;
    summaryFlightHost = container;
    try {
        const response = await fetch(`/api/return-summary?project=${encodeURIComponent(project)}`);
        if (!response.ok) throw new Error('Summary unavailable');
        const snapshot = await response.json();
        if (request !== summaryRequest || project !== window.activeWorkspacePath || !container.isConnected) return;
        if (returnProjectKey(snapshot.projectRoot) !== returnProjectKey(project) || !Array.isArray(snapshot.entries)) throw new Error('Wrong project snapshot');
        renderReturnSummary(container, snapshot);
    } catch {
        if (request === summaryRequest && container.isConnected) container.innerHTML = `<p>${t('return_summary_unavailable')}</p>`;
    } finally { if (request === summaryRequest) summaryInFlight = false; }
}

// `sub` is one line saying what the card holds, so the panel explains itself (blind eval, 2026-10-28).
const card = (title, icon, bodyHtml, right = '', sub = '') => `
    <section class="card">
        <div class="card-head"><h3 class="card-title"><i data-lucide="${icon}"></i> ${title}</h3>${right}</div>
        ${sub ? `<p class="card-sub">${sub}</p>` : ''}
        ${bodyHtml}
    </section>`;

// The setup path, derived from what is on disk and what the servers report, never from a stored
// flag: a step is done when its evidence exists. The first step that is not done is the one the
// owner is shown how to take; the later ones are named so the whole path is visible.
function setupSteps({ ws, mcp, act, report }) {
    const tools = (mcp?.wiredClients || []).join(', ');
    const link = mcp?.state;
    const boardEntries = (act?.readiness?.has?.boardEntries || 0)
        + ['inProgress', 'todo', 'blocked', 'done'].reduce((n, key) => n + (report?.board?.[key]?.length || 0), 0);
    const connect = link === 'waiting'
        ? { title: t('home_step_open'), text: t('home_step_open_text').replace('{tools}', tools || 'Your AI tool') }
        : link === 'no-sdk'
            ? { title: t('home_step_sdk'), text: t('home_step_sdk_text'), command: 'npm install' }
            : { title: t('home_step_connect'), text: t('home_step_connect_text'), action: { label: t('home_step_connect_btn'), onclick: 'openConnect()' } };
    return [
        { done: !!ws?.activeWorkspace, title: t('home_step_project'), text: t('home_step_project_text'),
            action: { label: t('home_step_project_btn'), onclick: "switchView('hub-view')" } },
        { done: !!ws?.activeDetails?.installed, title: t('home_step_kit'), text: t('home_step_kit_text'),
            action: { label: t('home_step_kit_btn'), onclick: "switchView('hub-view')" } },
        { done: link === 'connected', ...connect },
        { done: !!act?.readiness?.has?.map, title: t('home_step_read'), text: t('home_step_read_text'), ask: t('home_step_read_ask') },
        { done: boardEntries > 0, title: t('home_step_task'), text: t('home_step_task_text'),
            action: { label: t('home_step_task_btn'), onclick: 'openAssignTask()' } }
    ];
}

function nextStepHtml(steps, project) {
    const current = steps.findIndex(step => !step.done);
    if (current < 0) return '';
    const row = (step, i) => {
        const state = step.done ? 'done' : i === current ? 'current' : 'later';
        const icon = step.done ? 'check-circle-2' : i === current ? 'circle-dot' : 'circle';
        const body = state === 'current' ? `<div class="home-step-body">
                <p>${escHtml(step.text)}</p>
                ${step.action ? `<button type="button" class="btn-primary" onclick="${escHtml(step.action.onclick)}">${escHtml(step.action.label)}</button>` : ''}
                ${step.ask ? askLine(step.ask) : ''}
                ${step.command ? commandLine(step.command) : ''}
            </div>` : '';
        return `<li class="home-step ${state}"><i data-lucide="${icon}" aria-hidden="true"></i>
            <div><span class="home-step-title">${escHtml(step.title)}</span>${step.done ? ` <span class="pill pill-done">${t('home_step_done')}</span>` : ''}${body}</div></li>`;
    };
    return `<section class="card card-accent home-setup">
        <div class="card-head"><h3 class="card-title"><i data-lucide="list-checks"></i> ${escHtml(t('home_setup_title').replace('{project}', project))}</h3>
            <span class="card-note">${escHtml(t('home_setup_progress').replace('{n}', current + 1).replace('{total}', steps.length))}</span></div>
        <ol class="home-steps">${steps.map(row).join('')}</ol>
    </section>`;
}

// Sessions + commits, one feed, newest first. Both carry ISO dates.
function recentHtml(report) {
    const events = [
        ...report.sessions.map(s => ({ date: s.time, kind: 'session', s })),
        ...(report.commitsDetailed || []).map(c => ({ date: c.date, kind: 'commit', c }))
    ].filter(e => e.date).sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 8);

    if (!events.length) return emptyState({ icon: 'history', title: t('home_recent_empty_title'), text: t('home_recent_empty_text') });
    const when = (d) => { try { return new Date(d).toLocaleString(); } catch (e) { return d; } };
    return `<ol class="home-feed">${events.map(e => e.kind === 'session'
        ? `<li class="home-feed-row"><span class="home-feed-icon session"><i data-lucide="bot"></i></span><div class="home-feed-text">
               <div class="home-feed-meta"><b>${escHtml(e.s.ai)}</b> <span class="pill pill-quiet">${t('overview_session')}</span><time>${escHtml(when(e.date))}</time></div>
               <div class="home-feed-title">${escHtml(e.s.headline)}</div>
               ${e.s.next ? `<div class="home-feed-sub">${t('overview_next')}: ${escHtml(e.s.next)}</div>` : ''}</div></li>`
        : `<li class="home-feed-row"><span class="home-feed-icon"><i data-lucide="git-commit-horizontal"></i></span><div class="home-feed-text">
               <div class="home-feed-meta"><code translate="no">${escHtml(e.c.hash)}</code> <span class="pill pill-quiet">commit</span><time>${escHtml(when(e.date))}</time></div>
               <div class="home-feed-sub">${escHtml(e.c.subject)}</div></div></li>`).join('')}</ol>`;
}

function nowHtml(report) {
    const row = (e, pill, cls) => `<li class="home-now-row"><span class="pill ${cls}">${pill}</span>
        <span class="home-now-who">${escHtml(e.agent)}</span><span class="home-now-title">${escHtml(e.title)}</span></li>`;
    const rows = [
        ...report.board.blocked.map(e => row(e, t('overview_blocked_pill'), 'pill-blocked')),
        ...report.board.inProgress.map(e => row(e, t('overview_progress_pill'), 'pill-progress'))
    ];
    return rows.length ? `<ul class="home-now">${rows.join('')}</ul>`
        : emptyState({ icon: 'coffee', title: t('home_now_empty_title'), text: t('home_now_empty_text') });
}

function storiesHtml(report) {
    // The plain-language layer: the one-sentence story each recent session left (newest first),
    // headlines only if no session left a story.
    const sessions = report.sessions || [];
    const told = sessions.filter(s => s.story);
    const stories = (told.length ? told.map(s => s.story) : sessions.map(s => s.headline)).slice(0, 3);
    if (!stories.length) return `<p class="page-status">${t('overview_no_stories')}</p>`;
    return `<ul class="home-stories">${stories.map(text => `<li><i data-lucide="check" aria-hidden="true"></i><span>${escHtml(text)}</span></li>`).join('')}</ul>`;
}

function contextHtml(report) {
    const context = report.context || {};
    const decisions = (report.digest || []).filter(item => /^DECISION:/i.test(item)).slice(-3).reverse()
        .map(item => ({ text: item.replace(/^DECISION:\s*/i, '').replace(/\s*\(d-[0-9a-f]{12}\)\s*$/, ''), color: 'var(--brand-primary)', label: t('continuity_digest') }));
    const current = (context.current || []).slice(0, 5)
        .map(item => ({ text: item.claim, color: 'var(--status-done)', label: t('continuity_current'), detail: (item.sources || []).map(source => source.path).join(', ') }));
    const review = (context.review || []).slice(0, 3)
        .map(item => ({ text: item.claim, color: 'var(--status-progress)', label: t('overview_recheck'), detail: (item.reasons || []).join('; ') }));
    const stale = (context.stale || []).slice(0, 3)
        .map(item => ({ text: item.claim, color: 'var(--status-error)', label: t('continuity_stale'), detail: (item.reasons || []).join('; ') }));
    const unverified = (context.unverified || []).slice(0, 3)
        .map(item => ({ text: item.claim, color: 'var(--text-muted)', label: t('continuity_unverified') }));
    const items = [...decisions, ...current, ...review, ...stale, ...unverified];
    if (!items.length) return `<p class="page-status">${t('overview_no_digest')}</p>`;
    return `<ul class="known-list">${items.map(item => `<li style="border-left-color:${item.color};">
            <span class="known-label" style="color:${item.color};">${escHtml(item.label)}</span>
            <div>${escHtml(item.text)}</div>
            ${item.detail ? `<div class="known-detail">${escHtml(item.detail)}</div>` : ''}
        </li>`).join('')}</ul>`;
}

// Map health: the generated CODEINDEX + authored PROJECT_MAP freshness, with the two
// actions that matter — rescan (mechanical) and open the full Code map page.
function mapsHtml(hygiene) {
    const docs = (hygiene && hygiene.docs) || [];
    const row = (d) => {
        const state = !d.exists ? t('overview_map_missing')
            : d.commitsBehind === null ? t('overview_map_unmeasured')
            : `${d.commitsBehind} ${t('hygiene_commits_behind')}`;
        const ok = d.exists && (d.commitsBehind === null || d.commitsBehind <= 30);
        return `<li><span class="pill ${ok ? 'pill-done' : 'pill-todo'}">${escHtml(ok ? t('overview_map_ok') : t('overview_map_old'))}</span>
            <code translate="no">${escHtml(d.name)}</code><span class="card-note">${escHtml(String(state))}</span></li>`;
    };
    return `<ul class="home-maps">${docs.map(row).join('')}</ul>
        <div class="page-actions" style="margin-top:0.8rem;">
            <button type="button" class="btn-secondary" onclick="overviewRescan()">${t('overview_rescan')}</button>
            <button type="button" class="btn-secondary" onclick="switchView('codeindex')">${t('overview_open_map')}</button>
        </div>`;
}

// The counter tiles (commits, lines, files, sessions, in flight) left on 2026-11-04 (owner, O9):
// the Report page shows the same numbers. The window control stays: it also sets the days the
// Recent and Now cards are read for (/api/report?days=).
function detailsHtml(report, hygiene) {
    const winBtn = (d) => `<button type="button" onclick="setOverviewDays(${d})" class="${overviewDays === d ? 'active' : ''}">${d}d</button>`;
    return `<div class="card-head" style="margin-top:1.1rem;"><h3 class="card-title"><i data-lucide="gauge"></i> ${t('home_window')}</h3>
            <div class="seg-control home-window">${winBtn(7)}${winBtn(30)}${winBtn(90)}</div></div>
        <div class="home-grid">
            <div><div class="card-head"><h3 class="card-title"><i data-lucide="shield-check"></i> ${t('overview_durable')}</h3></div>${contextHtml(report)}</div>
            <div><div class="card-head"><h3 class="card-title"><i data-lucide="map"></i> ${t('overview_maps')}</h3></div>${mapsHtml(hygiene)}</div>
        </div>`;
}

window.overviewRescan = async function() {
    try {
        const res = await fetch('/api/codeindex/scan', { method: 'POST' });
        const data = await res.json();
        showToast(data.success ? t('overview_rescanned') : (data.message || t('error')), !data.success);
        if (data.success) fetchOverview();
    } catch (e) { showToast(t('conn_error'), true); }
};

window.setOverviewDays = function(days) {
    overviewDays = days;
    fetchOverview();
};

const json = url => fetch(url).then(r => { if (!r.ok) throw new Error(url); return r.json(); });

export async function fetchOverview() {
    const container = document.getElementById('overview-container');
    if (!container) return;
    const request = ++overviewRequest;
    const [ws, report, hygiene, act, mcp] = (await Promise.allSettled([
        json('/api/workspaces'), json(`/api/report?days=${overviewDays}`),
        json('/api/hygiene'), json('/api/activity'), json('/api/mcp/status')
    ])).map(r => r.status === 'fulfilled' ? r.value : null);
    if (request !== overviewRequest) return;

    if (ws && !ws.activeWorkspace) {
        container.innerHTML = emptyState({ icon: 'folder-open', title: t('home_no_project_title'), text: t('home_no_project_text'),
            action: { label: t('home_step_project_btn'), onclick: "switchView('hub-view')" } });
        document.getElementById('home-details').hidden = true;
        lucide.createIcons();
        return;
    }
    if (!report || !Array.isArray(report.sessions)) {
        container.innerHTML = emptyState({ icon: 'wifi-off', title: t('conn_error'), text: t('home_load_error') });
        lucide.createIcons();
        return;
    }
    document.getElementById('home-details').hidden = false;
    const project = report.project || (ws?.activeWorkspace || '').split(/[\\/]/).pop();
    const setup = nextStepHtml(setupSteps({ ws, mcp, act, report }), project);
    const needs = '<section id="return-summary" class="home-needs"></section>';

    container.innerHTML = `
        ${setup}${needs}
        <div class="home-grid">
            <div>${card(t('home_recent'), 'history', recentHtml(report),
                `<button type="button" class="card-link" onclick="switchView('report')">${t('home_full_report')} →</button>`, t('home_recent_sub'))}</div>
            <div>
                ${card(t('overview_now'), 'clock', nowHtml(report), '', t('home_now_sub'))}
                ${card(t('overview_working'), 'check-circle-2', storiesHtml(report), '', t('home_working_sub'))}
            </div>
        </div>`;
    document.getElementById('home-details-extra').innerHTML = detailsHtml(report, hygiene);
    lucide.createIcons();
    refreshReturnSummary();
}
