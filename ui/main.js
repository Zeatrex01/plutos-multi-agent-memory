// Entry point: wires up the feature modules and runs the initial render sequence.
// Depends on ui/i18n.js and the vendor globals `lucide`/`vis` (loaded as classic
// scripts before this module, so they're plain window properties by the time it runs).
import { applyLanguage, initLanguage } from './i18n.js';
import { fetchWorkspaces } from './modules/workspaces.js';
import { initRefreshRate, initVisualTheme } from './modules/settings.js';
import { startActivityFeed } from './modules/activity.js';
import { startApprovalWatch } from './modules/approvals.js';
import { applyModuleFlags, renderModuleToggles } from './modules/features.js';
import { checkActiveProject, renderNoProjectHome } from './modules/noproject.js';
import { showRunMode } from './modules/run-mode.js';
import { startBrowserPresence } from './modules/browser-presence.js';

// Side-effect imports: these modules attach their inline-onclick handlers to `window`
// but nothing else imports them directly.
import './modules/fsbrowse.js';
import { viewFromHash } from './modules/router.js';
import { initPageHelp } from './modules/page.js';
import { startOrbits } from './modules/orbit.js';
import { initAppShell } from './modules/updates.js';

lucide.createIcons();
startBrowserPresence();
// The service worker and the install prompt: the prompt can fire before Settings is ever opened.
initAppShell();

// Before anything renders: hide the module tabs that are off, so the first paint is the
// core trio rather than 13 tabs that then blink away.
applyModuleFlags();

initLanguage();
applyLanguage();
renderModuleToggles();
startOrbits();
showRunMode();
initPageHelp();

// The Hub loads either way — it is how you get INTO a project, and out of the empty state.
const hub = await fetchWorkspaces();

// Everything else reads a project, so with none selected there is nothing for it to read.
// Firing them anyway is what used to make the dashboard show its own repo; now they would
// just render empty panes and one of them would trip over a null project name.
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

window.refreshIntervalId = null;
initRefreshRate();
initVisualTheme();

// Runs for the whole session, not per tab: the system-bar LED must stay current whichever
// view is open. Pauses itself while the tab is hidden.
startActivityFeed();

// Same reason, higher stakes: a question an agent is blocked on has to reach the owner on
// whatever tab is open, so the watcher is global too.
startApprovalWatch();
