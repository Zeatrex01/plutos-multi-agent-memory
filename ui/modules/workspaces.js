// Projects page: registered workspace list, add/switch/remove, active-workspace header.
import { t } from '../i18n.js';
import { showToast } from './toast.js';
// Folder names and paths are user data: a quote or an angle bracket in a path used to break
// out of the inline onclick / attribute it was pasted into (the backslash-only escaping never
// covered quotes), leaving the Switch and Remove buttons dead on that project. The helpers this
// module used to define privately now live in ../esc.js, shared with every other renderer.
import { escHtml, jsArg } from '../esc.js';
import { workspaceName, renderWorkspaceTree, renderWorkspaceBinding, renderWorkspaceEmpty } from './workspace-tree.js';

// The search box earns its place only once the list is longer than a glance.
const SEARCH_FROM = 6;

let hubData = null;
const expandedFolders = new Map();
function renderProjects() {
    if (!hubData) return;
    const query = document.getElementById('hub-project-search')?.value || '';
    const host = document.getElementById('hub-projects-container');
    if (host) host.innerHTML = renderWorkspaceTree(hubData, query, expandedFolders);
    lucide.createIcons();
}
document.addEventListener('input', event => { if (event.target.id === 'hub-project-search') renderProjects(); });
document.addEventListener('toggle', event => {
    if (event.target.isConnected && event.target.matches?.('[data-hub-folder]') && !document.getElementById('hub-project-search')?.value.trim())
        expandedFolders.set(event.target.dataset.hubFolder, event.target.open);
}, true);

export async function fetchWorkspaces() {
    try {
        const res = await fetch('/api/workspaces');
        if (!res.ok) throw new Error('Workspace list unavailable.');
        const data = await res.json();
        hubData = data;
        const activePath = data.activeWorkspace;
        // Remembered, not opened. PLUT_OS no longer launches into whatever was open last time
        // (lib/workspaces.mjs explains why); the card for this one carries a "last opened"
        // hint instead, so resuming is one click and choosing another is equally one click.
        window.activeWorkspacePath = data.activeProjectRoot || activePath;
        const details = new Map((data.workspaceDetails || []).map(item => [item.path, item]));

        const nameLabel = activePath ? workspaceName(activePath) : t('hub_no_project');
        const nameElement = document.getElementById('active-workspace-name');
        nameElement.innerText = nameLabel;
        if (activePath) nameElement.removeAttribute('data-i18n');
        else nameElement.setAttribute('data-i18n', 'hub_no_project');

        // One card for the open project, one for the list, or one empty card when there is nothing yet.
        const current = document.getElementById('hub-current');
        if (current) current.hidden = !activePath;
        const list = document.getElementById('hub-list');
        if (list) list.hidden = !data.workspaces.length;
        const empty = document.getElementById('hub-empty-host');
        if (empty) empty.innerHTML = data.workspaces.length ? '' : renderWorkspaceEmpty();
        const count = document.getElementById('hub-project-count');
        if (count) count.textContent = data.workspaces.length ? String(data.workspaces.length) : '';
        const search = document.getElementById('hub-project-search');
        if (search) search.hidden = data.workspaces.length < SEARCH_FROM;

        const listEl = document.getElementById('workspace-list');
        const binding = document.getElementById('hub-project-binding');
        if (binding) binding.innerHTML = renderWorkspaceBinding(data);
        listEl.innerHTML = '';

        data.workspaces.forEach(ws => {
            const wsName = workspaceName(ws);
            const isAct = ws === activePath;

            // Dropdown Item
            listEl.innerHTML += `
                <button type="button" class="hub-workspace-option" onclick="switchWorkspace(${jsArg(ws)})"${isAct ? ' aria-current="true"' : ''}>
                    <span style="font-size: 0.9rem; font-weight: ${isAct ? 'bold' : 'normal'}; color: ${isAct ? 'var(--brand-primary)' : 'var(--text-title)'};">${escHtml(wsName)}</span>
                    ${isAct ? '<i data-lucide="check" style="width:14px; height:14px; color:var(--brand-primary);"></i>' : ''}
                </button>
            `;

        });
        renderProjects();
        return data;
    } catch(e) { console.error(e); showToast(t('hub_load_error'), true); }
}

window.copyProjectPath = async function(pathStr) {
    try { await navigator.clipboard.writeText(pathStr); showToast(t('connect_copied')); }
    catch { showToast(pathStr); }   // clipboard blocked: show the path so it can be taken by hand
};

window.removeWorkspace = async function(pathStr) {
    if (!confirm(t('confirm_remove_proj'))) return;
    try {
        const res = await fetch('/api/workspaces/remove', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({path: pathStr})
        });
        const data = await res.json();
        if (data.success) {
            if (hubData?.activeWorkspace && !data.activeWorkspace) { window.location.reload(); return; }
            showToast(t('msg_proj_removed'));
            fetchWorkspaces();
        } else {
            showToast(t('error') + ': ' + data.message, true);
        }
    } catch(e) {
        showToast(t('conn_error'), true);
    }
};

// Reloads rather than re-rendering: going from open to closed invalidates every
// project-dependent module at once, and main.js already builds the no-project screen
// correctly from a cold start. This is the mirror of the reload switchWorkspace does when
// opening the first project of a session.
window.closeWorkspace = async function() {
    try {
        const res = await fetch('/api/workspaces/close', { method: 'POST' });
        const data = await res.json();
        if (data.success) location.reload();
    } catch (e) { showToast(t('conn_error'), true); }
};

window.switchWorkspace = async function(pathStr) {
    if (pathStr === hubData?.activeWorkspace) return;
    try {
        const res = await fetch('/api/workspaces/switch', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({path: pathStr})
        });
        const data = await res.json();
        if(data.success) {
            // Every project-dependent module is now showing the wrong project, so this reloads
            // for the same reason closeWorkspace does: main.js already opens a project
            // correctly from a cold start, and re-running it is the only refresh that cannot
            // fall behind — a view added to main.js is picked up here for free. Hand-refreshing
            // instead is what caused this bug: the branch that used to stand here restarted
            // three modules and left Overview, MCPs, Logs, Graphify, the board,
            // roster, deck, report and code index all displaying the PREVIOUS project.
            location.reload();
        }
    } catch(e) { console.error(e); }
};

// Close workspace dropdown when clicking outside it
document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('workspace-dropdown');
    const profile = document.querySelector('.user-profile');
    if (dropdown && profile && !profile.contains(e.target) && dropdown.style.display === 'block') {
        dropdown.style.display = 'none';
    }
});
