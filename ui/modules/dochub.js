// Documents page (dochub): the project's Markdown documents by folder, the links between them and
// which ones may be out of date, with the latest commits beside the map. It draws with the code
// map's helpers (codeindex.js), so both maps read the same way in both themes.
import { t, currentLang } from '../i18n.js';
import { escHtml, jsArg } from '../esc.js';
import { showToast } from './toast.js';
import { emptyState } from './page.js';
import { tf, countLabel, mapTheme, textOn, withAlpha, packBlocks, fitLabel, wrapPath, onThemeChange, zoomToNodes, keepHubsReadable, animation, mapLocale, LABEL_MIN_PX } from './codeindex.js';

let dochubNetwork = null;
let dochubNodes = null;
let dochubEdges = null;
let dochubRawDocs = [];
let dochubBlocks = [];
let dochubPhysicsOn = false;
let themeWatch = null;
let adjustHubs = () => {};

const DOC_GRID = { cellW: 180, cellH: 36, itemFont: 14, gapX: 48, gapY: 56, hubGap: 16, hubPx: 14, minHubFont: 16, maxHubFont: 120 };

// Doc drift: /api/docs reports, per document, which of the files it names changed after the
// document itself was last committed (lib/hygiene.mjs docDrift). The map marks such a document
// with a dashed border in the theme's warning colour, the legend says what that means, and the
// details panel lists the files: never colour alone.
const isDrifted = doc => !!(doc.drift && doc.drift.drifted);

const folderOf = p => {
    const m = String(p).match(/^docs\/([^/]+)\//);
    if (m) return m[1];
    return String(p).includes('/') ? 'docs' : 'root';
};
const folderTitle = key => (key === 'root' ? t('maps_root_folder') : key);
const docName = doc => String(doc.name).replace(/\.md$/i, '');
// A link is a project path (a Markdown link, resolved by /api/docs) or a bare name (a [[wiki]] link).
const linkTarget = (target, byPath, byName) => byPath.get(target) || byName[target] || byName[String(target).replace(/^.*\//, '')] || null;

// The map card: search and the status line above the canvas, the legend below it, and one
// overlay for the loading, empty and error states. The search bar used to float over the map
// on a fixed dark panel, and the legend's text was the theme's body colour on that same panel.
// The toolbar, the legend, the state overlay and the controls are the shared .map-* , .field-* and
// .btn-* shapes (styles.css); the Code map draws the same ones.

function docFrame() {
    const graph = document.getElementById('dochub-graph');
    if (!graph) return null;
    if (graph.dataset.framed !== '1') {
        graph.innerHTML = `
            <div id="dochub-toolbar"></div>
            <div id="dochub-vis-canvas" role="img" style="flex:1 1 auto; min-height:0; width:100%; position:relative;"></div>
            <div id="dochub-legend" class="map-legend" style="display:none;"></div>
            <div id="dochub-state" class="map-state"></div>`;
        graph.style.display = 'flex';
        graph.style.flexDirection = 'column';
        graph.style.overflow = 'hidden';
        graph.dataset.framed = '1';
    }
    const toolbar = document.getElementById('dochub-toolbar');
    if (toolbar.dataset.lang !== currentLang) renderDocToolbar(toolbar);
    const canvas = document.getElementById('dochub-vis-canvas');
    canvas.setAttribute('aria-label', t('docmap_canvas_label'));
    return { graph, toolbar, canvas, legend: document.getElementById('dochub-legend'), state: document.getElementById('dochub-state') };
}

function renderDocToolbar(toolbar) {
    toolbar.dataset.lang = currentLang;
    toolbar.className = 'map-bar';
    toolbar.innerHTML = `
        <div class="field-row" style="gap:6px;">
            <input type="search" id="doc-search" placeholder="${escHtml(t('doc_search_placeholder'))}" aria-label="${escHtml(t('doc_search_placeholder'))}"
                class="field-input field-sm" style="width:min(220px, 100%); flex:none;">
            <button type="button" id="doc-search-btn" class="btn-secondary btn-sm">
                <i data-lucide="search"></i> ${escHtml(t('btn_search'))}</button>
            <button type="button" id="dochub-physics-toggle" class="btn-secondary btn-sm" aria-pressed="false" title="${escHtml(t('maps_physics_hint'))}">
                <i data-lucide="move"></i> ${escHtml(t('maps_physics'))}</button>
            <button type="button" id="dochub-fit" class="btn-secondary btn-sm" aria-label="${escHtml(t('maps_fit'))}" title="${escHtml(t('maps_fit'))}">
                <i data-lucide="maximize-2"></i></button>
        </div>
        <p id="dochub-status" role="status" aria-live="polite" class="page-status" style="margin:0; color:var(--text-body);"></p>`;
    toolbar.querySelector('#doc-search').onkeydown = e => { if (e.key === 'Enter') window.searchDocNode(); };
    toolbar.querySelector('#doc-search-btn').onclick = () => window.searchDocNode();
    toolbar.querySelector('#dochub-physics-toggle').onclick = () => window.toggleDochubPhysics();
    toolbar.querySelector('#dochub-fit').onclick = () => { if (dochubNetwork) dochubNetwork.fit({ animation: animation() }); };
    lucide.createIcons();
}

function showDocState(html) {
    const frame = docFrame();
    if (!frame) return;
    frame.state.innerHTML = `<div>${html}</div>`;
    frame.state.style.display = 'flex';
    frame.toolbar.style.visibility = 'hidden';
    frame.legend.style.display = 'none';
    lucide.createIcons();
}

function hideDocState() {
    const frame = docFrame();
    if (!frame) return;
    frame.state.style.display = 'none';
    frame.state.innerHTML = '';
    frame.toolbar.style.visibility = 'visible';
    frame.legend.style.display = 'flex';
}

function clearDocMap() {
    if (dochubNetwork) dochubNetwork.destroy();
    dochubNetwork = null;
    dochubNodes = null;
    dochubEdges = null;
}

function docLook(node, theme) {
    const color = theme.palette[node.colorIndex % theme.palette.length];
    if (node.kind === 'hub') {
        return {
            color: { background: color, border: color, highlight: { background: color, border: theme.brand }, hover: { background: color, border: theme.brand } },
            font: { color: textOn(color), size: node.hubFont, face: theme.font, mod: 'bold' }
        };
    }
    const border = node.drifted ? theme.warn : color;
    return {
        color: {
            background: withAlpha(color, theme.dark ? 0.16 : 0.1),
            border,
            highlight: { background: theme.surface, border: theme.brand },
            hover: { background: theme.surface, border: theme.brand }
        },
        font: { color: theme.title, size: DOC_GRID.itemFont, face: theme.font }
    };
}

function linkLook(theme) {
    return { color: withAlpha(theme.brand, 0.55), highlight: theme.brand, hover: theme.brand };
}

function renderDocGraph() {
    const frame = docFrame();
    if (!frame) return;
    const theme = mapTheme();

    // The top folder first (README and friends), then the rest biggest first.
    const counts = new Map();
    dochubRawDocs.forEach(d => counts.set(folderOf(d.path), (counts.get(folderOf(d.path)) || 0) + 1));
    const folders = [...counts.keys()].sort((a, b) => (a === 'root' ? -1 : b === 'root' ? 1 : (counts.get(b) - counts.get(a)) || a.localeCompare(b)));
    const docsByName = {};
    dochubRawDocs.forEach(d => { docsByName[docName(d)] = d; });

    dochubBlocks = folders.map((folder, i) => ({
        id: 'folder:' + folder,
        folder,
        colorIndex: i,
        items: dochubRawDocs.filter(d => folderOf(d.path) === folder).sort((a, b) => docName(a).localeCompare(docName(b))).map(d => d.path),
        lines: (name => [...name.slice(0, -1), `${name[name.length - 1]} · ${countLabel(counts.get(folder), 'docmap_doc_one', 'docmap_doc_many')}`])(wrapPath(folderTitle(folder)))
    }));
    const size = { width: frame.canvas.clientWidth || 700, height: frame.canvas.clientHeight || 520 };
    const layout = packBlocks(dochubBlocks, size, DOC_GRID);
    const maxChars = Math.floor((DOC_GRID.cellW - 32) / (DOC_GRID.itemFont * 0.58));
    const byPath = new Map(dochubRawDocs.map(d => [d.path, d]));

    const nodes = [];
    const edges = [];
    dochubBlocks.forEach(block => {
        const hub = {
            id: block.id, kind: 'hub', colorIndex: block.colorIndex, hubFont: layout.hubFont,
            label: block.lines.join('\n'), title: block.folder === 'root' ? t('maps_root_folder') : `docs/${block.folder === 'docs' ? '' : block.folder + '/'}`,
            shape: 'box', margin: 10, borderWidth: 2, borderWidthSelected: 3, shapeProperties: { borderRadius: 6 },
            ...(layout.pos[block.id] || {})
        };
        nodes.push({ ...hub, ...docLook(hub, theme) });
        block.items.forEach(path => {
            const doc = byPath.get(path);
            const drifted = isDrifted(doc);
            const node = {
                id: path, kind: 'doc', colorIndex: block.colorIndex, drifted,
                label: fitLabel(docName(doc), maxChars),
                title: drifted ? `${path} · ${t('docmap_legend_drift_hint')}` : path,
                shape: 'box', margin: 6, borderWidth: drifted ? 2.5 : 1.5, borderWidthSelected: 3,
                widthConstraint: { minimum: DOC_GRID.cellW - 50, maximum: DOC_GRID.cellW - 16 },
                shapeProperties: { borderRadius: 4, borderDashes: drifted ? [5, 4] : false },
                ...(layout.pos[path] || {})
            };
            nodes.push({ ...node, ...docLook(node, theme) });
            edges.push({ id: `${block.id}->${path}`, from: block.id, to: path, hidden: true });
        });
    });
    let links = 0;
    dochubRawDocs.forEach(doc => {
        (Array.isArray(doc.links) ? doc.links : []).forEach(target => {
            const to = linkTarget(target, byPath, docsByName);
            if (!to || to.path === doc.path) return;
            links++;
            edges.push({ id: `link:${doc.path}->${to.path}`, from: doc.path, to: to.path, kind: 'link', arrows: 'to', width: 1.5,
                smooth: { type: 'curvedCW', roundness: 0.15 }, color: linkLook(theme) });
        });
    });

    dochubNodes = new vis.DataSet(nodes);
    dochubEdges = new vis.DataSet(edges);
    if (dochubNetwork) dochubNetwork.destroy();
    dochubNetwork = new vis.Network(frame.canvas, { nodes: dochubNodes, edges: dochubEdges }, {
        layout: { improvedLayout: false },
        nodes: { scaling: { label: { drawThreshold: LABEL_MIN_PX } } },
        edges: { smooth: false },
        physics: { enabled: false },
        interaction: { hover: true, tooltipDelay: 150, keyboard: { enabled: true, bindToWindow: false } }
    });
    dochubPhysicsOn = false;
    adjustHubs = keepHubsReadable(dochubNetwork, dochubNodes);
    dochubNetwork.fit();
    updateDochubPhysicsButton();
    if (!themeWatch) themeWatch = onThemeChange(restyleDocs);

    dochubNetwork.on('click', params => {
        const id = params.nodes[0];
        if (id && String(id).startsWith('folder:')) {
            setOpacity(null);
            showFolderDetails(String(id).slice('folder:'.length));
            zoomToFolder(String(id).slice('folder:'.length));
            return;
        }
        const doc = id && dochubRawDocs.find(d => d.path === id);
        if (doc) { selectDoc(doc); return; }
        setOpacity(null);
        resetDocDetails();
    });
    dochubNetwork.on('zoom', () => updateDocStatus());
    dochubNetwork.on('animationFinished', () => updateDocStatus());

    updateDocStatus();
    updateDocLegend(links);
}

function updateDocStatus() {
    const line = document.getElementById('dochub-status');
    if (!line) return;
    const folderCount = dochubBlocks.length;
    let text = tf('docmap_status', {
        docs: countLabel(dochubRawDocs.length, 'docmap_doc_one', 'docmap_doc_many'),
        folders: countLabel(folderCount, 'maps_folder_one', 'maps_folder_many')
    });
    if (dochubNetwork && dochubNetwork.getScale() * DOC_GRID.itemFont < LABEL_MIN_PX) text += ' ' + t('docmap_status_zoom');
    if (line.textContent !== text) line.textContent = text;
}

function updateDocLegend(links) {
    const legend = document.getElementById('dochub-legend');
    if (!legend) return;
    const theme = mapTheme();
    legend.setAttribute('aria-label', t('maps_legend_label'));
    const swatch = style => `<span class="map-swatch" aria-hidden="true" style="${style}"></span>`;
    const item = (inner, text, title = '') => `<span class="map-legend-item"${title ? ` title="${escHtml(title)}"` : ''}>${inner}<span>${escHtml(text)}</span></span>`;
    const drifted = dochubRawDocs.filter(isDrifted).length;
    // A folder name opens that folder's list; the drift count lists the documents it counts.
    // Plain text here used to look like something to click and did nothing.
    const action = (inner, text, data, title = '') => `<button type="button" class="map-legend-item docmap-legend-btn" ${data}${title ? ` title="${escHtml(title)}"` : ''}>${inner}<span>${escHtml(text)}</span></button>`;
    legend.innerHTML = dochubBlocks.map(b => action(swatch(`background:${theme.palette[b.colorIndex % theme.palette.length]};`), folderTitle(b.folder), `data-folder="${escHtml(b.folder)}"`)).join('')
        + (drifted ? action(swatch(`border:2px dashed ${theme.warn};`), drifted === 1 ? t('docmap_legend_drift_one') : tf('docmap_legend_drift_many', { n: drifted }), 'data-drifted="1"', t('docmap_legend_drift_hint')) : '')
        + (links ? item(`<span aria-hidden="true" style="color:${theme.brand}; font-weight:700;">→</span>`, t('docmap_legend_links')) : '');
    legend.querySelectorAll('.docmap-legend-btn').forEach(button => {
        button.onclick = () => {
            if (button.dataset.folder) { setOpacity(null); showFolderDetails(button.dataset.folder); zoomToFolder(button.dataset.folder); }
            else showDriftedDetails();
        };
    });
    legend.style.display = 'flex';
}

// The documents the legend counts as possibly out of date: dimmed apart on the map, listed in the panel.
function showDriftedDetails() {
    const panel = docDetailsPanel();
    const drifted = dochubRawDocs.filter(isDrifted);
    if (!panel || !dochubNodes) return;
    const keep = new Set(drifted.map(d => d.path));
    dochubNodes.update(dochubNodes.get().map(n => ({ id: n.id, opacity: keep.has(n.id) ? 1 : 0.2 })));
    panel.innerHTML = `
        <p class="map-kind"><i data-lucide="alert-triangle"></i> ${escHtml(t('docmap_drifted_title'))}</p>
        <p style="margin:0 0 0.6rem; color:var(--text-body); font-size:0.85rem;">${escHtml(t('docmap_legend_drift_hint'))}</p>
        <ul class="plain-list" style="gap:0;">${drifted.map(doc => `<li><button type="button" class="map-item docmap-doc" data-path="${escHtml(doc.path)}"><span>${escHtml(doc.path)}</span></button></li>`).join('')}</ul>`;
    panel.querySelectorAll('.docmap-doc').forEach(button => {
        button.onclick = () => {
            const doc = dochubRawDocs.find(d => d.path === button.dataset.path);
            if (!doc) return;
            selectDoc(doc);
            if (dochubNetwork) dochubNetwork.focus(doc.path, { scale: Math.max(dochubNetwork.getScale(), 0.9), animation: animation() });
        };
    });
    lucide.createIcons();
}

function restyleDocs() {
    if (!dochubNetwork || !dochubNodes) return;
    const theme = mapTheme();
    dochubNodes.update(dochubNodes.get().map(n => ({ id: n.id, ...docLook(n, theme) })));
    dochubEdges.update(dochubEdges.get().filter(e => e.kind === 'link').map(e => ({ id: e.id, color: linkLook(theme) })));
    adjustHubs();
    updateDocLegend(dochubEdges.get().filter(e => e.kind === 'link').length);
}

function setOpacity(keepId) {
    if (!dochubNodes) return;
    dochubNodes.update(dochubNodes.get().map(n => ({ id: n.id, opacity: !keepId || n.id === keepId ? 1 : 0.35 })));
}

function selectDoc(doc) {
    setOpacity(doc.path);
    renderDocDetails(doc);
}

function zoomToFolder(folder) {
    const block = dochubBlocks.find(b => b.folder === folder);
    if (block && dochubNetwork) zoomToNodes(dochubNetwork, [block.id, ...block.items], DOC_GRID.itemFont, document.getElementById('dochub-vis-canvas'));
}

export async function fetchDocHubData() {
    const gitContainer = document.getElementById('dochub-git-container');
    const frame = docFrame();
    const loading = `<p class="page-status" style="margin:0;">${escHtml(t('loading'))}</p>`;
    if (gitContainer && !gitContainer.children.length) gitContainer.innerHTML = loading;
    if (frame && !dochubNetwork) showDocState(loading);

    let docsData = null;
    let gitData = null;
    try {
        [docsData, gitData] = await Promise.all([
            fetch('/api/docs').then(r => r.json()),
            fetch('/api/git/commits').then(r => r.json()).catch(() => ({ success: false, commits: [] }))
        ]);
    } catch (e) {
        if (dochubNetwork) { showToast(t('maps_offline_text'), 'error'); return; }
        const failed = emptyState({ icon: 'wifi-off', title: t('docmap_error_title'), text: t('maps_offline_text'),
            action: { label: t('maps_retry'), onclick: 'fetchDocHubData()' } });
        showDocState(failed);
        if (gitContainer) gitContainer.innerHTML = '';
        lucide.createIcons();
        return;
    }

    renderGit(gitContainer, gitData);
    if (docsData.needsProject) {
        clearDocMap();
        dochubRawDocs = [];
        showDocState(emptyState({ icon: 'folder-open', title: t('maps_no_project_title'), text: t('docmap_no_project_text'),
            action: { label: t('maps_open_projects'), onclick: "switchView('hub-view')" } }));
        resetDocDetails();
        return;
    }
    if (docsData.success === false) {
        clearDocMap();
        showDocState(emptyState({ icon: 'alert-triangle', title: t('docmap_error_title'), text: tf('docmap_error_server', { reason: docsData.message || '' }),
            action: { label: t('maps_retry'), onclick: 'fetchDocHubData()' } }));
        return;
    }
    dochubRawDocs = docsData.docs || [];
    if (!dochubRawDocs.length) {
        clearDocMap();
        showDocState(emptyState({ icon: 'file-text', title: t('docmap_empty_title'), text: t('docmap_empty_text'), ask: t('docmap_empty_ask') }));
        resetDocDetails();
        return;
    }
    try {
        hideDocState();
        renderDocGraph();
        resetDocDetails();
    } catch (e) {
        console.error('Documents map render failed:', e);
        clearDocMap();
        showDocState(emptyState({ icon: 'alert-triangle', title: t('docmap_draw_error_title'), text: t('docmap_draw_error_text'),
            action: { label: t('maps_retry'), onclick: 'fetchDocHubData()' } }));
    }
}
// The page head's Refresh button calls this from an inline onclick (known issue B27: it was only
// exported, so the click threw).
window.fetchDocHubData = fetchDocHubData;

function renderGit(container, gitData) {
    if (!container) return;
    if (gitData && gitData.needsProject) { container.innerHTML = ''; return; }
    const commits = gitData && Array.isArray(gitData.commits) ? gitData.commits : [];
    if (!commits.length) {
        container.innerHTML = emptyState({ icon: 'git-commit', title: t('docmap_git_empty_title'), text: t('docmap_git_empty_text') });
        lucide.createIcons();
        return;
    }
    container.innerHTML = commits.map(commit => {
        const when = new Date(commit.date).toLocaleString(mapLocale(), { dateStyle: 'medium', timeStyle: 'short' });
        return `
            <div class="commit-row">
                <div class="commit-head">
                    <b>${escHtml(commit.author)}</b>
                    <code class="pill pill-quiet" translate="no">${escHtml(commit.hash)}</code>
                </div>
                <div class="commit-text">${escHtml(commit.message)}</div>
                <span class="page-status">${escHtml(when)}</span>
            </div>`;
    }).join('');
}

function docDetailsPanel() {
    return document.getElementById('dochub-doc-details');
}

function resetDocDetails() {
    const panel = docDetailsPanel();
    if (panel) panel.innerHTML = `<p class="page-status" style="margin:0;">${escHtml(t('doc_info_placeholder'))}</p>`;
}

// A folder's documents as a list: the same content as its block on the map, readable at any zoom.
function showFolderDetails(folder) {
    const panel = docDetailsPanel();
    const block = dochubBlocks.find(b => b.folder === folder);
    if (!panel || !block) return;
    const byPath = new Map(dochubRawDocs.map(d => [d.path, d]));
    panel.innerHTML = `
        <p class="map-kind"><i data-lucide="folder"></i> ${escHtml(t('maps_kind_folder'))}</p>
        <p class="map-name">${escHtml(folderTitle(folder))}</p>
        <p style="margin:0 0 0.6rem; color:var(--text-body); font-size:0.85rem;">${escHtml(countLabel(block.items.length, 'docmap_doc_one', 'docmap_doc_many'))}</p>
        <ul class="plain-list" style="gap:0;">${block.items.map(path => {
            const doc = byPath.get(path);
            return `<li><button type="button" class="map-item docmap-doc" data-path="${escHtml(path)}">
                ${isDrifted(doc) ? `<i data-lucide="alert-triangle" aria-label="${escHtml(t('docmap_legend_drift_hint'))}" style="width:13px; height:13px; color:var(--status-todo); flex-shrink:0;"></i>` : ''}
                <span>${escHtml(docName(doc))}</span></button></li>`;
        }).join('')}</ul>`;
    panel.querySelectorAll('.docmap-doc').forEach(button => {
        button.onclick = () => {
            const doc = dochubRawDocs.find(d => d.path === button.dataset.path);
            if (!doc) return;
            selectDoc(doc);
            if (dochubNetwork) dochubNetwork.focus(doc.path, { scale: Math.max(dochubNetwork.getScale(), 0.9), animation: animation() });
        };
    });
    lucide.createIcons();
}

function renderDocDetails(doc) {
    const panel = docDetailsPanel();
    if (!panel) return;
    const modified = new Date(doc.lastModified).toLocaleString(mapLocale(), { dateStyle: 'medium', timeStyle: 'short' });
    const size = `${(doc.size / 1024).toLocaleString(mapLocale(), { maximumFractionDigits: 1 })} KB`;
    // A link to a document on the map is a button that selects it; one to a document the map
    // does not hold (outside the top folder and docs/) stays plain text.
    const byPath = new Map(dochubRawDocs.map(d => [d.path, d]));
    const byName = {};
    dochubRawDocs.forEach(d => { byName[docName(d)] = d; });
    const links = Array.isArray(doc.links) && doc.links.length
        ? doc.links.map(l => {
            const to = linkTarget(l, byPath, byName);
            return to && to.path !== doc.path
                ? `<button type="button" class="pill pill-quiet docmap-link" data-path="${escHtml(to.path)}" style="margin:2px; white-space:normal; text-align:left; color:var(--text-title);">${escHtml(l)}</button>`
                : `<span class="pill pill-quiet" style="margin:2px; white-space:normal;">${escHtml(l)}</span>`;
        }).join(' ')
        : `<span class="page-status">${escHtml(t('docmap_links_none'))}</span>`;

    const d = doc.drift || {};
    let drift;
    if (d.untracked) drift = `<p style="margin:0; font-size:0.8rem; color:var(--text-body);">${escHtml(t('doc_drift_untracked'))}</p>`;
    else if (d.noRefs) drift = `<p style="margin:0; font-size:0.8rem; color:var(--text-body);">${escHtml(t('doc_drift_no_refs'))}</p>`;
    else if (d.snapshot) drift = `<p style="margin:0; font-size:0.8rem; color:var(--text-body);">${escHtml(t('doc_drift_snapshot_hint'))}</p>`;
    else if (isDrifted(doc)) {
        const behind = Number(d.commitsBehind) || 0;
        drift = `
            <div style="background:var(--status-todo-bg); border:1px dashed var(--status-todo); border-radius:6px; padding:0.5rem 0.65rem;">
                <p style="display:flex; align-items:center; gap:5px; color:var(--status-todo); font-weight:700; font-size:0.8rem; margin:0 0 0.25rem;">
                    <i data-lucide="alert-triangle" style="width:14px; height:14px;"></i> ${escHtml(t('docmap_drifted_title'))}</p>
                <p style="margin:0 0 0.25rem; font-size:0.78rem; color:var(--text-body);">${escHtml(behind === 1 ? t('docmap_behind_one') : tf('docmap_behind_many', { n: behind }))}</p>
                ${(d.staleRefs || []).map(f => `<code style="font-family:var(--font-mono); font-size:0.72rem; color:var(--text-title); display:block; padding:1px 0; overflow-wrap:anywhere;">${escHtml(f)}</code>`).join('')}
            </div>`;
    } else {
        drift = `<p style="display:flex; align-items:center; gap:5px; margin:0; font-size:0.8rem; color:var(--status-done);"><i data-lucide="check" style="width:14px; height:14px;"></i> ${escHtml(t('doc_drift_current'))}</p>`;
    }

    panel.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 0.75rem;">
            <div>
                <p class="map-kind"><i data-lucide="file-text"></i> ${escHtml(t('docmap_kind_doc'))}</p>
                <p class="map-name">${escHtml(doc.name)}</p>
                <span style="font-family: var(--font-mono); font-size: 0.75rem; color: var(--text-body); overflow-wrap: anywhere;">${escHtml(doc.path)}</span>
            </div>
            <div class="panel kv-grid" style="grid-template-columns: 1fr 1fr;">
                <div><span class="kv-label">${escHtml(t('doc_size'))}</span><span class="kv-value">${escHtml(size)}</span></div>
                <div><span class="kv-label">${escHtml(t('doc_last_modified'))}</span><span class="kv-value">${escHtml(modified)}</span></div>
            </div>
            <div style="border-top: 1px solid var(--border-subtle); padding-top: 0.6rem;">
                <span style="color: var(--text-muted); display: block; font-size: 0.75rem; margin-bottom: 0.3rem;">${escHtml(t('docmap_links'))}</span>
                <div>${links}</div>
            </div>
            <div style="border-top: 1px solid var(--border-subtle); padding-top: 0.6rem;">
                <span style="color: var(--text-muted); display: block; font-size: 0.75rem; margin-bottom: 0.3rem;">${escHtml(t('doc_drift'))}</span>
                ${drift}
            </div>
            <div>
                <button type="button" class="btn-secondary btn-sm" onclick="openDocFile(${escHtml(jsArg(doc.path))})"><i data-lucide="external-link"></i> ${escHtml(t('btn_open_doc'))}</button>
            </div>
        </div>`;
    panel.querySelectorAll('.docmap-link').forEach(button => {
        button.onclick = () => {
            const to = dochubRawDocs.find(d => d.path === button.dataset.path);
            if (!to) return;
            selectDoc(to);
            if (dochubNetwork) dochubNetwork.focus(to.path, { scale: Math.max(dochubNetwork.getScale(), 0.9), animation: animation() });
        };
    });
    lucide.createIcons();
}

window.searchDocNode = function() {
    const input = document.getElementById('doc-search');
    if (!input || !dochubNetwork || !dochubNodes) return;
    const query = input.value.toLowerCase().trim();
    if (!query) { setOpacity(null); return; }
    const matches = dochubRawDocs.filter(d => docName(d).toLowerCase().includes(query) || d.path.toLowerCase().includes(query));
    if (!matches.length) {
        setOpacity(null);
        showToast(tf('maps_not_found', { q: input.value.trim() }), 'info');
        return;
    }
    const keep = new Set(matches.map(d => d.path));
    dochubNodes.update(dochubNodes.get().map(n => ({ id: n.id, opacity: keep.has(n.id) ? 1 : 0.2 })));
    dochubNetwork.focus(matches[0].path, { scale: Math.max(dochubNetwork.getScale(), 0.9), animation: animation() });
    renderDocDetails(matches[0]);
};

window.toggleDochubPhysics = function() {
    if (!dochubNetwork) return;
    dochubPhysicsOn = !dochubPhysicsOn;
    dochubNetwork.setOptions({
        physics: {
            enabled: dochubPhysicsOn,
            solver: 'forceAtlas2Based',
            forceAtlas2Based: { gravitationalConstant: -120, centralGravity: 0.01, springLength: 140, springConstant: 0.08, avoidOverlap: 1 }
        }
    });
    updateDochubPhysicsButton();
};

function updateDochubPhysicsButton() {
    const btn = document.getElementById('dochub-physics-toggle');
    if (!btn) return;
    btn.setAttribute('aria-pressed', String(dochubPhysicsOn));
    btn.style.background = dochubPhysicsOn ? 'var(--brand-primary)' : 'var(--bg-surface)';
    btn.style.color = dochubPhysicsOn ? 'var(--bg-surface)' : 'var(--text-title)';
    btn.style.borderColor = dochubPhysicsOn ? 'var(--brand-primary)' : 'var(--border-glow)';
}

window.openDocFile = async function(docPath) {
    try {
        const res = await fetch('/api/docs/open', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: docPath })
        });
        const data = await res.json();
        if (data.success) showToast(t('docmap_opened'), 'success');
        else showToast(data.message || t('docmap_open_failed'), 'error');
    } catch (e) {
        showToast(t('maps_offline_text'), 'error');
    }
};
