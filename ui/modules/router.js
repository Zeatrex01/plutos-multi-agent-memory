// Which page is visible, and what to re-render on a page switch. Each page module owns its own
// render logic; this module only decides *when* those renders run. Seven pages: Home (overview),
// Board, Activity, Code map (codeindex), Costs, Projects (hub-view) and Settings.
import { fetchBoard } from './board.js';
import { fetchWatcher } from './watcher.js';
import { fetchHooks } from './hooks.js';
import { fetchWorkspaces } from './workspaces.js';
import { fetchOverview } from './overview.js';
import { fetchActivityPage } from './activity-page.js';
import { fetchCodeIndex } from './codeindex.js';
import { fetchGraphifyStudio } from './graphify.js';
import { fetchUsage } from './usage.js';
import { fetchCodeburn } from './codeburn.js';
import { fetchConnect } from './connect.js';
import { fetchStorageInfo } from './settings.js';
import { showUpdateStatus } from './updates.js';
import { showBoardUnread } from './activity.js';

const viewSection = id => id && (document.getElementById(id) || document.getElementById('view-' + id));

// The page that the address names (#board), if it exists.
export function viewFromHash() {
    let id = '';
    try { id = decodeURIComponent(location.hash.slice(1)); } catch { return null; }
    return viewSection(id) ? id : null;
}

// Takes the clicked button explicitly instead of reading the ambient `event` global, which only
// works from a raw inline onclick. The open page is kept in the address, so a reload stays on it and
// Back returns to the last one; fromHistory is set when Back or Forward did the switching.
window.switchView = function(viewId, btn, fromHistory) {
    if (!fromHistory && location.hash.slice(1) !== viewId) history.pushState(null, '', '#' + viewId);
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.mob-tab-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    // Highlight the matching buttons in the sidebar and the phone bar.
    document.querySelectorAll(`.tab-btn[onclick*="'${viewId}'"]`).forEach(b => b.classList.add('active'));
    document.querySelectorAll(`.mob-tab-btn[data-mob-view="${viewId}"]`).forEach(b => b.classList.add('active'));

    document.querySelectorAll('.view-section').forEach(sec => sec.classList.remove('active'));
    // Section ids use two conventions: "hub-view" and "view-board"/"view-settings".
    const section = viewSection(viewId);
    if (section) section.classList.add('active');
    document.querySelector('.main-container')?.scrollTo?.(0, 0);

    // On a phone the sidebar is a drawer: close it after a choice.
    document.body.classList.remove('sidebar-open');

    if (viewId === 'overview') fetchOverview();
    if (viewId === 'board') {
        // Opening the board records the last-seen time and hides the unread dot.
        localStorage.setItem('plutos_board_last_seen', String(Date.now()));
        showBoardUnread(false);
        fetchBoard(); fetchWatcher(); fetchHooks();
    }
    if (viewId === 'activity') fetchActivityPage();
    // The Code map page: the dependency graph and the folder map. Nothing here is fetched until
    // the page is opened (vis-network itself loads on first use, codeindex.js loadVis).
    if (viewId === 'codeindex') { fetchGraphifyStudio(); fetchCodeIndex(); }
    // Costs: the project's ledger, then CodeBurn's last answer (it runs only from its button).
    if (viewId === 'costs') { fetchUsage(); fetchCodeburn(); }
    // Connect rows read config files off disk, so they are re-read on every visit.
    if (viewId === 'hub-view') { fetchWorkspaces(); fetchConnect(); }
    if (viewId === 'settings') { fetchStorageInfo(); showUpdateStatus(); }
    lucide.createIcons();
};

// Back and Forward move between pages: the address already names the page to show.
window.addEventListener('popstate', () => {
    const id = viewFromHash();
    if (id) window.switchView(id, null, true);
});

window.toggleSidebarMenu = function() {
    document.body.classList.toggle('sidebar-open');
};

// Dynamic panels build their text via t() at render time, so a language switch needs one re-render
// of whatever is on screen. Re-fires the SAME viewId through switchView() so the dispatch above is
// the only list.
window.refreshActiveView = function() {
    const btn = document.querySelector('.tab-btn.active') || document.querySelector('.mob-tab-btn.active');
    if (!btn) return;
    const m = (btn.getAttribute('onclick') || '').match(/switchView\('([^']+)'/);
    if (m) window.switchView(m[1], btn);
};
