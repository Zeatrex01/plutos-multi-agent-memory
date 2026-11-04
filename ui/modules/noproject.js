// The "no project selected" state.
//
// It did not used to exist, because the dashboard could never be in it: with nothing selected
// the backend fell back to its own install directory, so PLUT_OS silently presented ITSELF as
// the open project — its board, its commits, its ideas. The backend now refuses that
// (lib/route-policy.mjs) and answers `needsProject`, which leaves the frontend needing an
// honest screen for a state that is perfectly normal: a fresh install, or the last project
// removed.
//
// The screen is the Projects page, because picking a project is the only useful thing to do
// here, and a separate landing page would be a second door into the same room. This module
// only lands there and keeps the project-dependent tabs from firing.

let noProject = false;

// Read once at boot, and only used to decide that first render: every route that changes the
// open project (add, switch, close) reloads the page, so this answer is never consulted after
// it could have gone stale. It used to be cached and re-read on switch, which is precisely how
// a dashboard ended up showing one project's data under another project's name.
export async function checkActiveProject(hub) {
    try {
        hub ??= await fetch('/api/workspaces').then(r => r.json());
        noProject = !hub.activeWorkspace;
    } catch (e) {
        noProject = false;   // offline is the activity strip's story to tell, not this one
    }
    return !noProject;
}


// With no project open, PLUT_OS lands on the Projects page. That page shows the first step itself:
// its empty card on a first run, or the list to open a project from.
export function renderNoProjectHome() {
    const hub = document.getElementById('hub-view');
    if (!hub) return;

    // Land on the Hub rather than an Overview that has nothing to overview.
    document.querySelectorAll('.view-section').forEach(sec => sec.classList.remove('active'));
    hub.classList.add('active');
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    const hubTab = document.querySelector('.tab-btn[onclick*="hub-view"]');
    if (hubTab) hubTab.classList.add('active');

    const title = document.getElementById('project-title');
    if (title) title.textContent = 'PLUT_OS';

    if (window.lucide) lucide.createIcons();
}
