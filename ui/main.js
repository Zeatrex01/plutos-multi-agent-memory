// Entry point: wires up the page modules and runs the initial render sequence.
// Depends on ui/i18n.js and the vendor global `lucide` (loaded as a classic script before this
// module, so it is a plain window property by the time it runs).
import { applyLanguage, initLanguage } from './i18n.js';
import { fetchWorkspaces } from './modules/workspaces.js';
import { initRefreshRate } from './modules/settings.js';
import { startActivityFeed } from './modules/activity.js';
import { startApprovalWatch } from './modules/approvals.js';
import { checkActiveProject, renderNoProjectHome } from './modules/noproject.js';
import { showRunMode } from './modules/run-mode.js';
import { startBrowserPresence } from './modules/browser-presence.js';

// Side-effect imports: these modules attach their inline-onclick handlers to `window`
// but nothing else imports them directly.
import './modules/fsbrowse.js';
import { viewFromHash } from './modules/router.js';
import { initAppShell } from './modules/updates.js';

lucide.createIcons();
startBrowserPresence();
// The service worker (the offline page).
initAppShell();

initLanguage();
applyLanguage();
showRunMode();

// The Hub loads either way: it is how you get INTO a project, and out of the empty state.
const hub = await fetchWorkspaces();

// With a project open, PLUT_OS opens on Home, or on the page the address names (a reload stays where
// it was). With none, the Projects page is the screen: choosing a project is the one decision left.
if (await checkActiveProject(hub)) {
    const start = viewFromHash() || 'overview';
    window.switchView(start, null, true);
    history.replaceState(null, '', '#' + start);
} else {
    renderNoProjectHome();
    history.replaceState(null, '', '#hub-view');
}

initRefreshRate();

// Runs for the whole session, not per page: the system bar must stay current whichever page is
// open. Pauses itself while the tab is hidden.
startActivityFeed();

// A question an agent is blocked on has to reach the owner on whatever page is open (as a count on
// the Home nav item), so the watcher is global too.
startApprovalWatch();
