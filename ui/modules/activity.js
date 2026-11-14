// The system bar: the open project, its branch with the count of changed files, and whether an AI
// tool can reach the project. Every byte comes from a GET; nothing here runs anything.
// It also lights the Board's unread dot when a board file changed since the Board was last open.
import { t } from '../i18n.js';
import { escHtml } from '../esc.js';

const POLL_MS = 5000;
let timer = null;
let lastFingerprint = null;

function render(a) {
    const sys = document.getElementById('sys-activity');
    if (!sys) return;
    sys.innerHTML = !a.hasProject
        ? `<span class="sys-led"></span> ${t('activity_no_project_short')}`
        : a.isGitRepo
            ? `<span class="sys-led ${a.dirtyCount ? 'busy' : 'ok'}"></span> ${escHtml(a.branch || '?')}${a.dirtyCount ? ` <span class="sys-dirty">±${a.dirtyCount}</span>` : ''}`
            : `<span class="sys-led"></span> ${t('activity_no_git_short')}`;
}

// The Board's unread dot. `hidden` rather than inline styles, so the look stays in styles.css.
export function showBoardUnread(on) {
    document.querySelectorAll('.board-unread-dot').forEach(dot => { dot.hidden = !on; });
}

function checkBoardDelta(coordination) {
    if (!Array.isArray(coordination)) return;
    const boardEntries = coordination.filter(c => c.name === 'BOARD.md' || c.name === 'AGENT_BOARD.md');
    if (!boardEntries.length) return;

    let newestMtime = 0;
    for (const b of boardEntries) {
        const time = new Date(b.mtime).getTime();
        if (time > newestMtime) newestMtime = time;
    }

    const lastSeen = Number(localStorage.getItem('plutos_board_last_seen') || '0');
    const isBoardActive = document.getElementById('view-board')?.classList.contains('active');

    if (isBoardActive) {
        localStorage.setItem('plutos_board_last_seen', String(newestMtime || Date.now()));
        showBoardUnread(false);
    } else if (newestMtime > lastSeen) {
        showBoardUnread(true);
    }
}

async function tick() {
    // A backgrounded tab must not keep polling: nobody is reading it.
    if (document.hidden) return;
    try {
        const a = await fetch('/api/activity').then(r => r.json());
        checkBoardDelta(a.coordination);
        if (a.fingerprint === lastFingerprint) return;
        lastFingerprint = a.fingerprint;
        render(a);
    } catch (e) {
        const sys = document.getElementById('sys-activity');
        if (sys) sys.innerHTML = `<span class="sys-led"></span> ${t('activity_offline')}`;
    }
}

// The AI link: whether an AI tool can reach this project, in words, with one click to where it is
// fixed (Projects, Connect an AI). Red only for a fault (the bridge cannot start on this computer).
const LINK_LED = { connected: 'on', waiting: 'idle', 'no-project': 'idle', 'not-wired': 'idle', 'no-sdk': 'off' };
const LINK_KEY = { connected: 'connected', waiting: 'waiting', 'no-project': 'no_project', 'not-wired': 'not_wired', 'no-sdk': 'no_sdk' };

// The connected tool names in a /api/mcp/status reply (a bare PID is no name).
function linkNames(st) {
    const clients = Object.values(st?.clients || {});
    const names = [...new Set(clients.map(c => c.client).filter(c => c && !c.startsWith('AI Client (PID:')))];
    return { names, count: names.length || clients.length };
}

// One word for the AI link state, shared by the system bar and Home's status list.
export function aiLinkWord(st) {
    const state = st?.state in LINK_LED ? st.state : 'no-project';
    const { count } = linkNames(st);
    return state === 'connected' && count > 1
        ? t('sys_ai_connected_n').replace('{n}', count) : t('sys_ai_' + LINK_KEY[state]);
}

async function refreshAiLink() {
    if (document.hidden) return;
    const led = document.getElementById('sys-mcp-led'), label = document.getElementById('sys-mcp-label'), button = document.getElementById('sys-mcp');
    if (!led || !label || !button) return;
    try {
        const st = await fetch('/api/mcp/status').then(r => r.json());
        const { names, count } = linkNames(st);
        const state = st.state in LINK_LED ? st.state : 'no-project';
        led.className = 'sys-led ' + LINK_LED[state];
        label.textContent = `${t('sys_ai')}: ${aiLinkWord(st)}`;
        button.title = t('sys_ai_title_' + LINK_KEY[state])
            .replace('{n}', count).replace('{names}', state === 'waiting' ? (st.wiredClients || []).join(', ') : names.join(', ') || 'AI');
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
    } catch (e) { /* the branch item reports a dashboard that is offline */ }
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
