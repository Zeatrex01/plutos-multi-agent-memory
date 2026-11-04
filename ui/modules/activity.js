// Live activity strip — the "something is happening right now" layer.
//
// What it deliberately is NOT: an embedded terminal. Claude Code, Cursor and the rest are
// separate processes in their own windows; no dashboard can attach to their terminals, and
// a shell rendered here would be PLUT_OS running commands, not the AI's work. What it shows
// instead is the evidence those tools leave on disk while they work — the files currently
// being edited, new commits, and writes to the coordination files. That is real, it is
// honest, and it opens no execution surface: every byte here comes from a GET.
import { t } from '../i18n.js';
import { escHtml } from '../esc.js';

const POLL_MS = 5000;
let timer = null;
let lastFingerprint = null;

const KIND_COLOR = {
    modified: 'var(--status-progress)',
    added: 'var(--status-done)',
    untracked: 'var(--text-muted)',
    deleted: 'var(--status-error)',
    renamed: 'var(--status-progress)',
    changed: 'var(--text-body)'
};

// "3m ago" — the point of the strip is recency, and an absolute timestamp makes the reader
// do the subtraction. Falls back to the raw value if the date is unparseable.
function ago(iso) {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const s = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (s < 45) return t('activity_just_now');
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 86400)}d`;
}

function fileRow(f) {
    return `<div style="display:flex; align-items:center; gap:0.55rem; font-size:0.83rem; padding:0.22rem 0;">
        <span style="font-family:var(--font-mono); font-size:0.62rem; text-transform:uppercase; letter-spacing:0.05em;
              color:${KIND_COLOR[f.kind] || 'var(--text-body)'}; min-width:66px;">${escHtml(f.kind)}</span>
        <span style="font-family:var(--font-mono); color:var(--text-title); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escHtml(f.path)}</span>
        <span style="margin-left:auto; font-family:var(--font-mono); font-size:0.72rem; color:var(--text-muted); flex-shrink:0;">${escHtml(ago(f.mtime))}</span>
    </div>`;
}

function panelHtml(a) {
    if (!a.hasProject) {
        return `<p class="page-status" style="margin:0;">${t('activity_no_project')}</p>`;
    }
    if (!a.isGitRepo) {
        return `<p class="page-status" style="margin:0;">${t('activity_no_git')}</p>`;
    }

    const working = a.dirty.length
        ? a.dirty.map(fileRow).join('') +
          (a.dirtyCount > a.dirty.length
              ? `<div style="font-size:0.75rem; color:var(--text-muted); font-family:var(--font-mono); padding-top:0.3rem;">+${a.dirtyCount - a.dirty.length} ${t('activity_more')}</div>`
              : '')
        : `<p class="page-status" style="margin:0;">${t('activity_clean')}</p>`;

    const coord = (a.coordination || []).map(c =>
        `<div style="display:flex; align-items:center; gap:0.5rem; font-size:0.8rem; padding:0.18rem 0;">
            <span style="font-family:var(--font-mono); color:var(--text-body);">${escHtml(c.name)}</span>
            <span style="margin-left:auto; font-family:var(--font-mono); font-size:0.72rem; color:var(--text-muted);">${escHtml(ago(c.mtime))}</span>
        </div>`).join('');

    const head = a.head
        ? `<div style="display:flex; align-items:center; gap:0.5rem; font-size:0.8rem;">
               <span style="font-family:var(--font-mono); color:var(--text-body);">${escHtml(a.head.hash)}</span>
               <span style="color:var(--text-title); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escHtml(a.head.subject)}</span>
               <span style="margin-left:auto; font-family:var(--font-mono); font-size:0.72rem; color:var(--text-muted); flex-shrink:0;">${escHtml(ago(a.head.date))}</span>
           </div>`
        : `<p class="page-status" style="margin:0;">${t('activity_no_commits')}</p>`;

    const col = (label, body) => `<div style="min-width:0;">
        <div style="font-size:0.68rem; text-transform:uppercase; letter-spacing:0.07em; color:var(--text-muted); font-family:var(--font-mono); margin-bottom:0.45rem;">${label}</div>
        ${body}</div>`;

    // Where the project stands. A first session's strip is legitimately near-empty — no map,
    // no history — and without this that reads as "the product does nothing" rather than
    // "you are at the beginning". Named stage + the one next step; silent once informed,
    // because a ready project should not be told so on every visit.
    const r = a.readiness;
    const stageLine = r && r.next
        ? `<div class="panel card-accent" style="margin-top:1rem;">
               <div style="font-size:0.72rem; text-transform:uppercase; letter-spacing:0.06em; font-family:var(--font-mono); color:var(--brand-primary); margin-bottom:0.3rem;">
                   ${t('activity_stage')}: ${escHtml(r.stage)}
               </div>
               <div style="font-size:0.85rem; color:var(--text-title);">${escHtml(r.next.action)}</div>
               <div style="font-size:0.78rem; color:var(--text-muted); margin-top:0.2rem;">${escHtml(r.next.why)}</div>
           </div>`
        : '';

    return `<div style="display:grid; grid-template-columns: 1.6fr 1fr 1fr; gap:1.3rem;" class="activity-cols">
        ${col(`${t('activity_working_tree')} <span style="color:var(--text-body);">(${a.dirtyCount})</span>`, working)}
        ${col(t('activity_last_commit'), head)}
        ${col(t('activity_coordination'), coord || `<p class="page-status" style="margin:0;">${t('activity_no_coordination')}</p>`)}
    </div>${stageLine}`;
}

function render(a) {
    // System bar: always visible, whichever tab is open.
    const sys = document.getElementById('sys-activity');
    if (sys) {
        sys.innerHTML = !a.hasProject
            ? `<span class="sys-led"></span> ${t('activity_no_project_short')}`
            : a.isGitRepo
                ? `<span class="sys-led ${a.dirtyCount ? 'busy' : 'ok'}"></span> ${escHtml(a.branch || '?')}${a.dirtyCount ? ` <span style="color:var(--status-progress);">±${a.dirtyCount}</span>` : ''}`
                : `<span class="sys-led"></span> ${t('activity_no_git_short')}`;
    }

    const panel = document.getElementById('activity-body');
    if (panel) panel.innerHTML = panelHtml(a);

    // Who else is on this project. The AIs could already see each other in their briefings;
    // the owner could not see anyone — which is odd for the one screen whose job is showing
    // the shared space.
    const who = document.getElementById('sys-participants');
    if (who) {
        // Roster membership never expires (nothing flips an AI back to "not here"), so this
        // strip used to list every AI that ever registered — a wall of names none of which
        // were actually connected. `fresh` (< 30m since last activity) is the only signal
        // this data has for "connected right now"; show just that, not the full roster.
        const list = (a.participants || []).filter(p => p.fresh);
        who.innerHTML = list.length
            ? list.slice(0, 3).map(p =>
                `<span class="sys-peer" title="${escHtml(p.name)} — last active ${escHtml(p.age)}"><span class="sys-led ok"></span>${escHtml(p.name)}</span>`).join('')
              + (list.length > 3 ? `<span class="sys-peer">+${list.length - 3}</span>` : '')
            : `<span class="sys-peer" style="color:var(--text-muted);">${t('activity_no_peers')}</span>`;
    }

    const stamp = document.getElementById('activity-stamp');
    if (stamp) stamp.textContent = `${t('activity_updated')} ${ago(a.at) || t('activity_just_now')}`;
    checkBoardDelta(a.coordination);
}

function checkBoardDelta(coordination) {
    if (!Array.isArray(coordination)) return;
    const boardEntries = coordination.filter(c => c.name === 'BOARD.md' || c.name === 'AGENT_BOARD.md');
    if (!boardEntries.length) return;

    let newestMtime = 0;
    for (const b of boardEntries) {
        const t = new Date(b.mtime).getTime();
        if (t > newestMtime) newestMtime = t;
    }

    const lastSeen = Number(localStorage.getItem('plutos_board_last_seen') || '0');
    const isBoardActive = document.getElementById('view-board')?.classList.contains('active');

    if (isBoardActive) {
        localStorage.setItem('plutos_board_last_seen', String(newestMtime || Date.now()));
        document.querySelectorAll('.board-unread-dot').forEach(d => { d.style.display = 'none'; });
    } else if (newestMtime > lastSeen) {
        document.querySelectorAll('.board-unread-dot').forEach(d => { d.style.display = 'inline-block'; });
    }
}

async function tick() {
    // A backgrounded tab must not keep polling: nobody is reading it and the request is
    // pure waste on a laptop battery.
    if (document.hidden) return;
    try {
        const a = await fetch('/api/activity').then(r => r.json());
        checkBoardDelta(a.coordination);
        // Re-render only on real change. Without this the panel rebuilds every 5s and any
        // text the user is selecting gets ripped out from under them.
        if (a.fingerprint === lastFingerprint) {
            const stamp = document.getElementById('activity-stamp');
            if (stamp) stamp.textContent = `${t('activity_updated')} ${ago(a.at) || t('activity_just_now')}`;
            return;
        }
        lastFingerprint = a.fingerprint;
        render(a);
    } catch (e) {
        const sys = document.getElementById('sys-activity');
        if (sys) sys.innerHTML = `<span class="sys-led"></span> ${t('activity_offline')}`;
    }
}

// The system bar's AI link: whether an AI tool can reach this project, in words, with one click
// to where it is fixed (Projects → Connect an AI). Red only for a fault (the
// bridge cannot start on this computer): no AI tool set up yet is a setup step, which Home shows.
const LINK_LED = { connected: 'on', waiting: 'idle', 'no-project': 'idle', 'not-wired': 'idle', 'no-sdk': 'off' };
const LINK_KEY = { connected: 'connected', waiting: 'waiting', 'no-project': 'no_project', 'not-wired': 'not_wired', 'no-sdk': 'no_sdk' };
let linkState = 'no-project';

async function refreshAiLink() {
    if (document.hidden) return;
    const led = document.getElementById('sys-mcp-led'), label = document.getElementById('sys-mcp-label'), button = document.getElementById('sys-mcp');
    if (!led || !label || !button) return;
    try {
        const st = await fetch('/api/mcp/status').then(r => r.json());
        const clients = Object.values(st.clients || {});
        const names = [...new Set(clients.map(c => c.client).filter(c => c && !c.startsWith('AI Client (PID:')))];
        const count = names.length || clients.length;
        linkState = st.state in LINK_LED ? st.state : 'no-project';
        led.className = 'sys-led ' + LINK_LED[linkState];
        const word = linkState === 'connected' && count > 1
            ? t('sys_ai_connected_n').replace('{n}', count) : t('sys_ai_' + LINK_KEY[linkState]);
        label.textContent = `${t('sys_ai')}: ${word}`;
        button.title = t('sys_ai_title_' + LINK_KEY[linkState])
            .replace('{n}', count).replace('{names}', linkState === 'waiting' ? (st.wiredClients || []).join(', ') : names.join(', ') || 'AI');
    } catch (e) {
        led.className = 'sys-led off';
        label.textContent = `${t('sys_ai')}: ${t('activity_offline')}`;
    }
}

window.openConnect = function() {
    window.switchView('hub-view');
    document.getElementById('connect-section')?.scrollIntoView({ block: 'start' });
};

window.openAiLink = function() { window.openConnect(); };

// The open project only changes with a page reload (every add, switch and close reloads), so its
// name is read once.
async function showProjectName() {
    const el = document.getElementById('sys-project');
    if (!el) return;
    try {
        const ws = await fetch('/api/workspaces').then(r => r.json());
        el.textContent = (ws.activeWorkspace || '').split(/[\\/]/).pop() || '—';
    } catch (e) { /* the activity strip reports a dashboard that is offline */ }
}

export function startActivityFeed() {
    if (timer) return;
    tick();
    timer = setInterval(tick, POLL_MS);
    showProjectName();
    refreshAiLink();
    setInterval(refreshAiLink, 10000);
    // Coming back to the tab should show current state immediately, not up to 5s stale.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); refreshAiLink(); } });
}
