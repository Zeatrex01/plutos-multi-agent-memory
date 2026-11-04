// Cross-feature composition: which view is visible, and what to re-render on tab
// switch. Each feature module owns its own render logic; this module only decides
// *when* those renders run.
import { fetchSetup } from './setup.js';
import { fetchBoard } from './board.js';
import { fetchWatcher } from './watcher.js';
import { fetchHooks } from './hooks.js';
import { fetchCodeIndex } from './codeindex.js';
import { fetchReport } from './report.js';
import { fetchSessionMemory } from './memory.js';
import { fetchWorkspaces } from './workspaces.js';
import { fetchDocHubData } from './dochub.js';
import { fetchOverview } from './overview.js';
import { fetchResearch } from './research.js';
import { fetchConnect } from './connect.js';
import { fetchStorageInfo } from './settings.js';
import { showUpdateStatus } from './updates.js';
import { fetchCouncil } from './council.js';
import { fetchGraphifyStudio } from './graphify.js';
import { fetchSkills } from './skills.js';
import { renderModuleToggles } from './features.js';
import { fetchCodeburn } from './codeburn.js';
import { fetchUsage } from './usage.js';

const viewSection = id => id && (document.getElementById(id) || document.getElementById('view-' + id));

// The page that the address names (#board), if it exists.
export function viewFromHash() {
    let id = '';
    try { id = decodeURIComponent(location.hash.slice(1)); } catch { return null; }
    return viewSection(id) ? id : null;
}

// Takes the clicked button explicitly instead of reading the ambient `event` global —
// the latter only works when called from a raw inline onclick, and throws otherwise
// (e.g. when triggered programmatically). dashboard-ui.html passes `this`.
// The open page is kept in the address, so a reload stays on it and Back returns to the last one;
// fromHistory is set when Back or Forward did the switching, which must not add another entry.
window.switchView = function(viewId, btn, fromHistory) {
    if (!fromHistory && location.hash.slice(1) !== viewId) history.pushState(null, '', '#' + viewId);
    // Sync sidebar tab buttons
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    // Sync mobile bottom nav buttons
    document.querySelectorAll('.mob-tab-btn').forEach(b => b.classList.remove('active'));

    if (btn) {
        btn.classList.add('active');
    }
    // Cross-highlight corresponding buttons in sidebar and mobile bar
    document.querySelectorAll(`.tab-btn[onclick*="'${viewId}'"]`).forEach(b => b.classList.add('active'));
    document.querySelectorAll(`.mob-tab-btn[data-mob-view="${viewId}"]`).forEach(b => b.classList.add('active'));

    document.querySelectorAll('.view-section').forEach(sec => sec.classList.remove('active'));
    // Section ids use two conventions: "hub-view" and "view-board"/"view-council"/...
    const section = viewSection(viewId);
    if (section) section.classList.add('active');
    document.querySelector('.main-container')?.scrollTo?.(0, 0);

    // Auto-close sidebar drawer on mobile after clicking a tab
    document.body.classList.remove('sidebar-open');

    // Opening the board tab records the last-seen time and hides the unread dot
    if (viewId === 'board') {
        localStorage.setItem('plutos_board_last_seen', String(Date.now()));
        document.querySelectorAll('.board-unread-dot').forEach(d => { d.style.display = 'none'; });
    }

    if(viewId === 'overview') fetchOverview();
    if(viewId === 'research') fetchResearch();
    if(viewId === 'setup') fetchSetup();
    if(viewId === 'settings') { renderModuleToggles(); fetchStorageInfo(); showUpdateStatus(); }
    if(viewId === 'council') fetchCouncil();
    if(viewId === 'board') { fetchBoard(); fetchWatcher(); fetchHooks(); }
    if(viewId === 'codeindex') fetchCodeIndex();
    if(viewId === 'report') { fetchReport(); fetchSessionMemory('report-memory'); }
    if(viewId === 'costs') { fetchUsage(); fetchCodeburn(); }
    if(viewId === 'dochub') fetchDocHubData();
    if(viewId === 'graphify') fetchGraphifyStudio();
    // Skill folders are read off disk on every visit: a pack switched on in the terminal shows up.
    if(viewId === 'skills') fetchSkills();
    // Connect rows read config files off disk, so they must be re-read on every visit —
    // the user may have edited one in their editor since the last look.
    if(viewId === 'hub-view') { fetchWorkspaces(); fetchConnect(); }
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

// Dynamic panels build their text via t() at render time, not data-i18n attributes, so
// applyLanguage() alone never touches them — a language switch needs one re-render of
// whatever is on screen. Re-fires the SAME viewId through switchView() so it reuses the
// exact fetch dispatch above rather than a second list to keep in sync.
window.refreshActiveView = function() {
    const btn = document.querySelector('.tab-btn.active') || document.querySelector('.mob-tab-btn.active');
    if (!btn) return;
    const m = (btn.getAttribute('onclick') || '').match(/switchView\('([^']+)'/);
    if (m) window.switchView(m[1], btn);
};
