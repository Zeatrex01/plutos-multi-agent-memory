// Status Report tab — the third map. PROJECT_MAP = what the project is, CODEINDEX = where
// the code lives, this = WHERE WE ARE: what happened, what changed, what's next. Rendered
// as presentation cards so the owner glances instead of reading documents; assembled fresh
// per request from git + CONTINUITY + boards + hygiene, so it can never go stale.
import { t } from '../i18n.js';
import { escHtml } from '../esc.js';

import { emptyState } from './page.js';

// The same card, tiles and rows as Home: one set of shapes on every page.
const card = (title, icon, body) => `
    <section class="card">
        <div class="card-head"><h3 class="card-title"><i data-lucide="${icon}"></i> ${title}</h3></div>
        ${body}
    </section>`;

const stat = (value, label, sub = '') => `
    <div class="stat-tile"><span class="stat-label">${label}</span><span class="stat-value">${value}</span>${sub ? `<span class="stat-sub">${sub}</span>` : ''}</div>`;

const li = (html) => `<li>${html}</li>`;
const list = (items, mono = false) => `<ul class="plain-list${mono ? ' mono' : ''}">${items}</ul>`;
const nothing = (icon, title) => emptyState({ icon, title });

export async function fetchReport(days) {
    const container = document.getElementById('report-container');
    const meta = document.getElementById('report-meta');
    try {
        const r = await fetch(`/api/report${days ? `?days=${days}` : ''}`).then(x => x.json());
        meta.textContent = `${r.project} · ${new Date(r.generatedAt).toLocaleString('en-US')} · ${t('report_window')} ${r.days} ${t('report_days')}`;

        const stats = `<div class="stat-tiles" style="margin-bottom:0;">
            ${r.isGitRepo ? stat(r.stats.commits, t('report_commits')) + stat(`+${r.stats.insertions}`, t('report_lines'), `−${r.stats.deletions}`) : ''}
            ${stat(r.stats.inProgress, t('report_inprogress'))}${stat(r.stats.todo, 'TODO')}${stat(r.stats.blocked, t('report_blocked'))}${stat(r.stats.sessions, t('report_sessions'))}
        </div>${r.isGitRepo && r.stats.contributors.length ? `<p class="page-status" style="margin-top:0.8rem;">${r.stats.contributors.map(escHtml).join(' · ')}</p>` : ''}`;

        const sessions = r.sessions.length
            ? list(r.sessions.map(s => li(`<b>${escHtml(s.headline)}</b> <span class="page-status" style="display:inline; margin:0;">— ${escHtml(s.ai)}, ${escHtml(s.time.slice(0, 10))}</span>${s.did ? `<br><span class="page-status" style="display:inline; margin:0;">${escHtml(s.did)}</span>` : ''}`)).join(''))
            : nothing('history', t('report_no_sessions'));

        const commits = r.commits.length
            ? list(r.commits.map(c => li(escHtml(c))).join('') + (r.commitsOverflow ? li(`<span class="page-status" style="display:inline; margin:0;">…+${r.commitsOverflow}</span>`) : ''), true)
            : nothing('git-commit-horizontal', r.isGitRepo ? t('report_no_commits') : t('report_no_git'));

        const flight = (r.board.inProgress.length || r.board.blocked.length)
            ? list(r.board.inProgress.map(e => li(`<span class="dot dot-progress"></span><b>${escHtml(e.agent)}</b> — ${escHtml(e.title)}`)).join('')
              + r.board.blocked.map(e => li(`<span class="dot dot-error"></span><span class="pill pill-blocked">BLOCKED</span> <b>${escHtml(e.agent)}</b> — ${escHtml(e.title)}`)).join(''))
            : nothing('loader', t('report_nothing_inflight'));

        const next = r.nextSteps.length
            ? list(r.nextSteps.map(n => li(`${escHtml(n.text)} <span class="page-status" style="display:inline; margin:0;">(${escHtml(n.source)})</span>`)).join(''))
            : nothing('arrow-right-circle', t('report_no_next'));

        const watch = r.watchouts.length
            ? card(t('report_watchouts'), 'alert-triangle', list(r.watchouts.map(w => li(`<span class="dot dot-todo"></span>${escHtml(w)}`)).join('')))
            : '';

        container.innerHTML =
            card(t('report_glance'), 'gauge', stats) +
            `<div class="card-grid">
                ${card(t('report_happened'), 'history', sessions)}
                ${card(t('report_landed'), 'git-commit-horizontal', commits)}
                ${card(t('report_inflight'), 'loader', flight)}
                ${card(t('report_next'), 'arrow-right-circle', next)}
            </div>` + watch;
        lucide.createIcons();
    } catch (e) {
        container.innerHTML = `<p class="page-status">${t('conn_error')}</p>`;
    }
}

// The window buttons are a segmented control (the same one as Home's counters): the pressed one is .active.
window.setReportDays = function(days, btn) {
    document.querySelectorAll('.report-days-btn').forEach(b => b.classList.toggle('active', b === btn));
    fetchReport(days);
};
