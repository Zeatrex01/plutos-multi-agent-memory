// Projects page renderers: the open project's header and the list of registered projects.
// Folder ancestry is only a way to group a long list; it never grants shared project access.
import { escHtml as esc, jsArg } from '../esc.js';
import { t } from '../i18n.js';
import { emptyState } from './page.js';

// Grouping by parent folder helps once the list is long; below this it is only noise.
const GROUP_FROM = 8;

export function workspaceName(value) {
    const path = value.replace(/\\/g, '/').replace(/\/+$/, '');
    return path.split('/').at(-1) || '/';
}

// The last two folders above the project are what tells two projects apart; the full path stays
// in the tooltip and on the copy button.
export function shortPath(value) {
    const parts = value.replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean);
    return parts.length <= 3 ? value : '…/' + parts.slice(-3).join('/');
}

export function workspaceFolders(paths, query = '') {
    const roots = new Map();
    for (const path of paths) {
        if (!path.toLowerCase().includes(query.trim().toLowerCase())) continue;
        const normalized = path.replace(/\\/g, '/');
        const parts = normalized.split('/').filter(Boolean);
        const windows = /^[a-z]:/i.test(normalized) || normalized.startsWith('//');
        const root = normalized.startsWith('//') ? '//' + parts.splice(0, 2).join('/')
            : /^[a-z]:/i.test(normalized) ? parts.shift() + '/' : '/';
        let children = roots, key = '', node;
        for (const name of [root, ...parts]) {
            key += '/' + (windows ? name.toLowerCase() : name);
            if (!children.has(key)) children.set(key, { key, name, paths: [], projects: [], children: new Map() });
            node = children.get(key); node.paths.push(path); children = node.children;
        }
        node.projects.push(path);
    }
    const compress = node => {
        while (!node.projects.length && node.children.size === 1 && ![...node.children.values()][0].projects.length) {
            const child = [...node.children.values()][0];
            node = { ...child, name: node.name.replace(/\/$/, '') + '/' + child.name };
        }
        return { ...node, children: [...node.children.values()].map(compress) };
    };
    return [...roots.values()].map(compress);
}

function projectRow(data, details, path) {
    const active = path === data.activeWorkspace, last = !data.activeWorkspace && path === data.lastWorkspace;
    const installed = details.get(path)?.mode === 'installed';
    const name = workspaceName(path);
    const action = active
        ? `<span class="hub-row-open">${esc(t('btn_active_proj'))}</span>`
        : `<button type="button" class="btn-secondary btn-sm" onclick="switchWorkspace(${jsArg(path)})">${esc(t(last ? 'btn_resume_proj' : 'btn_open_proj'))}</button>`;
    return `<li class="hub-project-row${active ? ' is-active' : ''}" data-workspace-path="${esc(path)}">
        <i data-lucide="folder" class="hub-row-icon" aria-hidden="true"></i>
        <div class="hub-project-label"><strong>${esc(name)}</strong>
            <code title="${esc(path)}">${esc(shortPath(path))}</code></div>
        <span class="pill ${installed ? 'pill-done' : 'pill-quiet'}">${esc(t(installed ? 'hub_installed' : 'hub_observed'))}</span>
        ${last ? `<span class="hub-row-hint">${esc(t('hub_last_opened'))}</span>` : ''}
        <div class="hub-project-actions">${action}
            <button type="button" class="btn-icon" aria-label="${esc(t('btn_remove_proj') + ': ' + name)}" title="${esc(t('btn_remove_proj'))}" onclick="removeWorkspace(${jsArg(path)})"><i data-lucide="trash-2" aria-hidden="true"></i></button></div>
    </li>`;
}

export function renderWorkspaceTree(data, query, expanded) {
    const details = new Map((data.workspaceDetails || []).map(item => [item.path, item]));
    const row = path => projectRow(data, details, path);
    const q = query.trim().toLowerCase();
    const matching = data.workspaces.filter(path => path.toLowerCase().includes(q));
    if (!data.workspaces.length) return '';
    if (!matching.length) return `<p class="page-status" role="status">${esc(t('hub_search_empty'))}</p>`;
    if (data.workspaces.length < GROUP_FROM) {
        // The open project first, then by name: the list reads the same every time.
        const sorted = [...matching].sort((a, b) => (b === data.activeWorkspace) - (a === data.activeWorkspace)
            || workspaceName(a).localeCompare(workspaceName(b)));
        return `<ul class="hub-project-list">${sorted.map(row).join('')}</ul>`;
    }
    const draw = node => {
        if (!node.children.length) return node.projects.map(row).join('');
        const open = q || (expanded.has(node.key) ? expanded.get(node.key) : node.paths.includes(data.activeWorkspace) || node.paths.includes(data.lastWorkspace));
        return `<li><details class="hub-folder" data-hub-folder="${esc(node.key)}"${open ? ' open' : ''}>
            <summary><span title="${esc(node.name)}">${esc(shortPath(node.name))}</span><small>${node.paths.length} ${esc(t(node.paths.length === 1 ? 'hub_project_count_one' : 'hub_project_count'))}</small></summary>
            <ul class="hub-project-list">${node.projects.map(row).join('')}${node.children.map(draw).join('')}</ul></details></li>`;
    };
    return `<ul class="hub-project-list">${workspaceFolders(data.workspaces, query).map(draw).join('')}</ul>`;
}

// The empty page: one card, one sentence, one button. It replaces the banner, the empty list and
// the connect section that used to say the same thing three times.
export function renderWorkspaceEmpty() {
    return emptyState({ icon: 'folder-plus', title: t('hub_empty_title'), text: t('hub_empty_note'),
        action: { label: t('btn_add_project'), onclick: 'addNewWorkspace()' } });
}

// The open project's header. The steps under it (kit, AI connections) are rendered by connect.js.
export function renderWorkspaceBinding(data) {
    if (!data.activeWorkspace) return '';
    const details = data.activeDetails;
    const installed = details?.mode === 'installed';
    return `<div class="hub-current-head">
            <span class="hub-current-icon"><i data-lucide="folder-open" aria-hidden="true"></i></span>
            <div class="hub-current-title">
                <span class="hub-eyebrow">${esc(t('hub_binding_title'))}</span>
                <h3 id="hub-current-title">${esc(workspaceName(data.activeWorkspace))}</h3>
                <code title="${esc(data.activeWorkspace)}">${esc(shortPath(data.activeWorkspace))}</code>
            </div>
            <span class="pill ${installed ? 'pill-done' : 'pill-quiet'}">${esc(t(installed ? 'hub_installed' : 'hub_observed'))}</span>
            <div class="hub-current-actions">
                <button type="button" class="btn-icon" title="${esc(t('hub_copy_path'))}" aria-label="${esc(t('hub_copy_path'))}" onclick="copyProjectPath(${jsArg(data.activeWorkspace)})"><i data-lucide="copy" aria-hidden="true"></i></button>
                <button id="hub-close-project" type="button" class="btn-secondary btn-sm" onclick="closeWorkspace()"><i data-lucide="log-out" aria-hidden="true"></i> ${esc(t('btn_close_project'))}</button>
            </div>
        </div>
        <details class="hub-current-details"><summary>${esc(t('hub_details'))}</summary>
            <dl><dt>${esc(t('hub_source_folder'))}</dt><dd><code>${esc(data.activeWorkspace)}</code></dd>
                <dt>${esc(t('hub_records_folder'))}</dt><dd><code>${esc(details?.coordinationRoot || '')}</code></dd></dl>
            <p>${esc(t(installed ? 'hub_binding_installed' : 'hub_binding_observed'))} ${esc(t('hub_scope_note'))}</p>
        </details>`;
}
