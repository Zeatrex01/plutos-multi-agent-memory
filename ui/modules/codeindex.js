// Code map (the codeindex tab): this project's folders and the files in them, drawn from the scan
// lib/codeindex.mjs writes into docs/ai/obsidian/. One box per folder with its files in a grid
// below it, the folder list beside the map, and a details panel. The map helpers at the end of
// this file (theme colours, block layout, zoom) are shared with the Documents page, dochub.js.
import { t, currentLang } from '../i18n.js';
import { showToast } from './toast.js';
import { escHtml } from '../esc.js';
import { emptyState, askLine } from './page.js';

let network = null;
let drawn = null;  // the current drawing: { nodes, edges (vis DataSets), blocks, view }
let model = null;  // the whole parsed index; the map may draw only part of it
let themeWatch = null;
window.currentClassData = {};

// Which third-party folders the owner has opened this tab session. Session-only on purpose:
// folded by default is the point, so an opened set surviving a reload would undo it on the
// next big scan.
let expandedThirdParty = new Set();

// Large repos produce thousands of file nodes; drawing all of them with a force simulation
// locks the tab. Defaults: a capped node count, a fixed layout, physics off.
const PREFS_KEY = 'plutos-graph-prefs';
const DEFAULT_PREFS = { layout: 'tidy', physics: false, limit: 500 };

function loadPrefs() {
    try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; }
    catch (e) { return { ...DEFAULT_PREFS }; }
}

function savePrefs(patch) {
    const next = { ...loadPrefs(), ...patch };
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch (e) { /* storage blocked: the choice lasts this visit */ }
    return next;
}

// ---- Reading the index ----------------------------------------------------------------------

// `content` is every obsidian shard concatenated (readIndexShards). A shard opens with
// `# Obsidian shard: <key>`: the top-level folder, or for Unity the folder under Assets/ with its
// leading underscore stripped (_GAME -> GAME). Then a directory tree (`### Folder: <name>` and
// `- [[label]] | <relative path>`; older shards carry a file:/// link before the bar), then one `### [[...]]` section per
// file. JS and generic scans head that section with the file's path (a root file is just its name,
// in the _root shard); Unity scans head it with the class name and file it by the tree's folder.
export function parseCodeIndex(mdContent) {
    const lines = String(mdContent || '').split('\n').map(line => line.trim());
    const treeFolder = {};
    const treeRel = {};
    let folder = '';
    for (const line of lines) {
        if (line.startsWith('## Detailed') || /^#\s*Obsidian shard:/.test(line)) { folder = ''; continue; }
        if (line.startsWith('### Folder:')) { folder = line.slice('### Folder:'.length).trim(); continue; }
        if (!folder) continue;
        const entry = line.match(/^-\s+\[\[([^\]]+)\]\](.*)$/);
        if (!entry) continue;
        treeFolder[entry[1]] = folder;
        const bar = entry[2].lastIndexOf('| ');
        if (bar >= 0) treeRel[entry[1]] = entry[2].slice(bar + 2).trim();
    }

    // C# partial classes (LevelController.Pools.cs, LevelController.Build.cs, ... each declaring
    // `partial class LevelController`) put several sections under one class name. vis DataSet ids
    // must be unique, so a name is one node; its details are the last section read.
    const files = {};
    const order = [];
    let shard = '';
    let lastFolder = '';
    let current = null;
    for (const line of lines) {
        const shardHead = line.match(/^#\s*Obsidian shard:\s*(.+)$/);
        if (shardHead) { shard = shardHead[1].trim(); current = null; continue; }
        if (line.startsWith('### Folder:')) { lastFolder = line.slice('### Folder:'.length).trim(); current = null; continue; }
        if (line.startsWith('### ')) {
            const name = line.slice(4).replace(/\[\[|\]\]/g, '').trim();
            if (!name) { current = null; continue; }
            const isPath = name.includes('/') || shard === '_root';
            const rel = isPath ? name : (treeRel[name] || '');
            if (!files[name]) order.push(name);
            current = files[name] = {
                id: name,
                name,
                label: isPath ? name.split('/').pop() : name,
                // A folder is its directory path. Keyed by the bare folder name, an SDK's Scripts/
                // merged into the game's own Scripts/ box, and its files could never be unfolded.
                folder: rel ? rel.split('/').slice(0, -1).join('/') : (treeFolder[name] || lastFolder || 'Core'),
                shard: shard || (isPath && name.includes('/') ? name.split('/')[0] : ''),
                rel,
                byClass: !isPath,
                signature: '', exports: '', types: '', functions: '', methods: '', fires: '', listens: '', refs: []
            };
            continue;
        }
        if (!current || !line.startsWith('* ')) continue;
        const field = line.slice(2);
        const value = label => field.slice(label.length).trim().replace(/`/g, '');
        if (field.startsWith('**Signature:**')) current.signature = value('**Signature:**');
        else if (field.startsWith('**Exports:**')) current.exports = value('**Exports:**');
        else if (field.startsWith('**Types:**')) current.types = value('**Types:**');
        else if (field.startsWith('**Functions:**')) current.functions = value('**Functions:**');
        else if (field.startsWith('**Public Methods:**')) current.methods = value('**Public Methods:**');
        else if (field.startsWith('**Events Fired:**')) current.fires = value('**Events Fired:**');
        else if (field.startsWith('**Events Listened:**')) current.listens = value('**Events Listened:**');
        else if (field.startsWith('**Documentation References:**')) {
            const refs = value('**Documentation References:**');
            current.refs = refs && refs !== 'None'
                ? refs.split(',').map(r => r.replace(/\[\[|\]\]/g, '').trim()).filter(Boolean) : [];
        }
    }
    return { files, order };
}

// ---- Whose code is it ---------------------------------------------------------------------

// The owner's Unity projects keep their own code in Assets/_GAME and Assets/_PROJECT (shards GAME
// and PROJECT). Where a Unity scan has those shards, they are the project and every other Assets
// folder is an imported package or SDK: the rule the owner approved, unchanged. Any other layout
// (Node, Python, C++, Godot, Unreal, a Unity project organised differently) is the project's own
// code except what sits in a folder that holds someone else's code.
const CORE_SHARDS = new Set(['GAME', 'PROJECT']);

// Folder names that mean vendored code in any letter case. node_modules, vendor, third_party,
// external and Packages never reach the index at all (lib/codeindex.mjs EXCLUDE_DIRS skips them);
// they are listed so an index written by another tool reads the same way.
const VENDORED_ANY_CASE = new Set(['node_modules', 'bower_components', 'jspm_packages', 'vendor', 'vendors',
    'third_party', 'third-party', 'thirdparty', '3rdparty', 'external', 'externals', 'extern', 'deps',
    'pods', 'carthage', 'site-packages', 'dist-packages']);
// Names that mean vendored only in the engines' own spelling: Unity's and Unreal's Plugins and
// Packages, Unreal's ThirdParty, Godot's addons. Lower-case packages/ or plugins/ is usually the
// project's own code (a monorepo's packages, a site's plugins), so those stay the project's.
const VENDORED_EXACT = new Set(['Plugins', 'Packages', 'addons', 'Third Party', 'Third_Party']);
// Asset Store and SDK folders that a Unity project imports straight under Assets/.
const UNITY_SDK_FOLDERS = new Set(['TextMesh Pro', 'TextMeshPro', 'Demigiant', 'DOTween', 'Sirenix', 'MoreMountains',
    'AppsFlyer', 'Firebase', 'GoogleMobileAds', 'GooglePlayGames', 'ExternalDependencyManager', 'PlayServicesResolver',
    'FacebookSDK', 'GameAnalytics', 'IronSource', 'LevelPlay', 'MaxSdk', 'AppLovin', 'Adjust', 'Spine',
    'spine-csharp', 'spine-unity', 'Photon', 'Samples', 'Standard Assets', 'AssetStoreTools', 'NaughtyAttributes']);

export function isVendoredPath(rel) {
    const dirs = String(rel || '').replace(/\\/g, '/').split('/').filter(Boolean).slice(0, -1);
    if (dirs[0] === 'Assets' && UNITY_SDK_FOLDERS.has(dirs[1])) return true;
    return dirs.some(dir => VENDORED_ANY_CASE.has(dir.toLowerCase()) || VENDORED_EXACT.has(dir));
}

// Marks every file third-party or not; returns which rule decided it.
export function classifyFiles(files) {
    const all = Object.values(files);
    const coreShards = all.some(f => f.byClass && CORE_SHARDS.has(f.shard));
    all.forEach(f => {
        f.thirdParty = coreShards
            ? !CORE_SHARDS.has(f.shard)
            : isVendoredPath(f.rel || (f.byClass && f.shard ? `Assets/${f.shard}/${f.name}` : f.name));
    });
    return coreShards ? 'core-shards' : 'paths';
}

// The parsed index as the page uses it: files, and folders with their files and whose they are.
// A folder is the project's when any file in it is, erring toward showing real code.
export function buildModel(mdContent) {
    const { files, order } = parseCodeIndex(mdContent);
    const rule = classifyFiles(files);
    const folders = new Map();
    order.forEach(id => {
        const file = files[id];
        if (!folders.has(file.folder)) folders.set(file.folder, { key: file.folder, files: [], thirdParty: true });
        const folder = folders.get(file.folder);
        folder.files.push(id);
        if (!file.thirdParty) folder.thirdParty = false;
    });
    // A third-party folder keeps its parent in the label: Vendor/Source says more than Source.
    const labels = shortFolderLabels([...folders.keys()], key => (folders.get(key).thirdParty ? 2 : 1));
    folders.forEach(folder => {
        folder.label = labels.get(folder.key);
        folder.files.sort((a, b) => files[a].label.localeCompare(files[b].label));
    });
    // Biggest first: they get the most distinct colours and the top of the map.
    const sorted = [...folders.values()].sort((a, b) => (a.thirdParty - b.thirdParty)
        || (b.files.length - a.files.length) || a.key.localeCompare(b.key));
    sorted.forEach((folder, i) => { folder.colorIndex = i; });
    return { files, order, folders: sorted, rule };
}

// Folder keys from path scans are directory paths (ui/modules, lib/research); the label is the
// shortest tail that no other folder shares, so `lib` and `lib/research` stay two different boxes. Keying by the bare folder name merged them, counts and all.
export function shortFolderLabels(keys, minParts = () => 1) {
    // Unity paths start at Assets/, which every folder shares and nobody needs to read.
    const parts = new Map(keys.map(k => [k, k ? k.split('/').filter((p, i) => !(i === 0 && p === 'Assets')) : []]));
    const tail = (p, n) => p.slice(-n).join('/');
    const out = new Map();
    for (const key of keys) {
        const p = parts.get(key);
        let n = Math.min(p.length, Math.max(1, minParts(key)));
        while (n < p.length && keys.some(o => o !== key && tail(parts.get(o), n) === tail(p, n))) n++;
        out.set(key, tail(p, n) || key);
    }
    return out;
}

// Keeps the drawn file count bounded and third-party folders folded unless opened. The
// project's own files claim the budget first, round-robin across folders so one huge folder
// cannot crowd out the rest; opened third-party folders share what is left. Folder boxes are
// always drawn, even a folded one that shows none of its files.
export function capFiles(m, limit, expanded = new Set()) {
    const own = [];
    const opened = [];
    m.order.forEach(id => {
        const file = m.files[id];
        if (!file.thirdParty) own.push(file);
        else if (expanded.has(file.folder)) opened.push(file);
    });
    const eligible = own.length + opened.length;
    if (!limit || eligible <= limit) {
        return { shown: own.concat(opened).map(f => f.id), shownOwn: own.length, ownTotal: own.length, eligible, capped: false };
    }
    const keptOwn = roundRobinTake(groupByFolder(own), limit);
    const keptOpened = roundRobinTake(groupByFolder(opened), Math.max(0, limit - keptOwn.length));
    return { shown: keptOwn.concat(keptOpened).map(f => f.id), shownOwn: keptOwn.length, ownTotal: own.length, eligible, capped: true };
}

function groupByFolder(files) {
    const queues = new Map();
    files.forEach(f => {
        if (!queues.has(f.folder)) queues.set(f.folder, []);
        queues.get(f.folder).push(f);
    });
    queues.forEach(list => list.sort((a, b) => a.label.localeCompare(b.label)));
    return queues;
}

function roundRobinTake(queues, budget) {
    const kept = [];
    const lists = [...queues.values()];
    for (let i = 0; kept.length < budget; i++) {
        let progressed = false;
        for (const list of lists) {
            if (i >= list.length) continue;
            kept.push(list[i]);
            progressed = true;
            if (kept.length >= budget) break;
        }
        if (!progressed) break;
    }
    return kept;
}

// What the status line says, as numbers (the sentence is built from these in statusText).
export function mapSummary(m, view, expanded = new Set()) {
    const own = m.folders.filter(f => !f.thirdParty);
    const thirdParty = m.folders.filter(f => f.thirdParty);
    return {
        rule: m.rule,
        ownFiles: view.ownTotal,
        ownFolders: own.length,
        shownOwn: view.shownOwn,
        shown: view.shown.length,
        capped: view.capped,
        thirdPartyFolders: thirdParty.length,
        folded: thirdParty.filter(f => !expanded.has(f.key)).length,
        opened: thirdParty.filter(f => expanded.has(f.key)).length
    };
}

// ---- Loading and states ---------------------------------------------------------------------

export async function fetchCodeIndex() {
    const frame = mapFrame();
    if (!frame) return;
    const meta = document.getElementById('codeindex-meta');
    if (!network) showMapState(`<p class="page-status" style="margin:0;">${escHtml(t('loading'))}</p>`);

    let data;
    try {
        const res = await fetch('/api/codeindex');
        data = await res.json();
    } catch (err) {
        // A failed refresh keeps the map already on screen; only a first load needs the page.
        if (network) { showToast(t('maps_offline_text'), 'error'); return; }
        showMapState(emptyState({ icon: 'wifi-off', title: t('codemap_error_title'), text: t('maps_offline_text'),
            action: { label: t('maps_retry'), onclick: 'fetchCodeIndex()' } }));
        renderFolderList();
        return;
    }

    if (data.needsProject) {
        clearDrawing();
        if (meta) meta.textContent = '';
        showMapState(emptyState({ icon: 'folder-open', title: t('maps_no_project_title'), text: t('codemap_no_project_text'),
            action: { label: t('maps_open_projects'), onclick: "switchView('hub-view')" } }));
        renderFolderList();
        return;
    }
    if (!data.exists) {
        clearDrawing();
        if (meta) meta.textContent = '';
        showMapState(emptyState({ icon: 'map', title: t('codemap_empty_title'), text: t('codemap_empty_text'),
            action: { label: t('codemap_scan_action'), onclick: 'regenerateCodebaseIndex(this)' } }));
        renderFolderList();
        return;
    }
    if (meta) meta.textContent = data.updatedAt ? tf('codemap_scanned_at', { when: formatWhen(data.updatedAt) }) : '';

    try {
        model = buildModel(data.content);
        window.currentClassData = model.files;
        if (!model.order.length) {
            clearDrawing();
            showMapState(emptyState({ icon: 'file-search', title: t('codemap_no_files_title'), text: t('codemap_no_files_text'),
                action: { label: t('codemap_scan_again'), onclick: 'regenerateCodebaseIndex(this)' } }));
            renderFolderList();
            return;
        }
        hideMapState();
        drawGraph();
        renderFolderList();
        resetDetails();
    } catch (err) {
        console.error('Code map render failed:', err);
        clearDrawing();
        showMapState(emptyState({ icon: 'alert-triangle', title: t('codemap_draw_error_title'), text: t('codemap_draw_error_text'),
            action: { label: t('codemap_scan_again'), onclick: 'regenerateCodebaseIndex(this)' } }));
    }
}
window.fetchCodeIndex = fetchCodeIndex;

function formatWhen(value) {
    try { return new Date(value).toLocaleString(mapLocale(), { dateStyle: 'medium', timeStyle: 'short' }); }
    catch (e) { return String(value); }
}

// The map card's parts, made here so the page works whatever static markup it starts with: the
// toolbar and status line above the canvas, the legend below it, and one overlay for the loading,
// empty and error states (which used to overwrite the card and take the toolbar with it). The
// toolbar and legend used to float over the canvas and hid the top and bottom rows of the map.
// The toolbar, the legend and the controls are the shared .map-bar, .map-legend, .field-* and .btn-*
// shapes (styles.css); the same ones draw the Documents map.

function mapFrame() {
    const graph = document.getElementById('codeindex-graph');
    if (!graph) return null;
    const part = id => {
        let el = document.getElementById(id);
        if (!el) {
            el = document.createElement('div');
            el.id = id;
            graph.appendChild(el);
        }
        return el;
    };
    const toolbar = part('codeindex-toolbar');
    const canvas = part('codeindex-vis-canvas');
    const legend = part('codeindex-legend');
    const state = part('codemap-state');
    if (!canvas.dataset.framed) {
        graph.style.display = 'flex';
        graph.style.flexDirection = 'column';
        graph.style.overflow = 'hidden';
        graph.append(toolbar, canvas, legend, state);
        canvas.style.cssText = 'flex:1 1 auto; min-height:0; width:100%; position:relative;';
        canvas.setAttribute('role', 'img');
        state.className = 'map-state';
        canvas.dataset.framed = '1';
    }
    canvas.setAttribute('aria-label', t('codemap_canvas_label'));
    renderToolbar(toolbar);
    return { graph, toolbar, legend, canvas, state };
}

function showMapState(html) {
    const frame = mapFrame();
    if (!frame) return;
    frame.state.innerHTML = `<div>${html}</div>`;
    frame.state.style.display = 'flex';
    frame.toolbar.style.visibility = 'hidden';
    frame.legend.style.display = 'none';
    lucide.createIcons();
}

function hideMapState() {
    const frame = mapFrame();
    if (!frame) return;
    frame.state.style.display = 'none';
    frame.state.innerHTML = '';
    frame.toolbar.style.visibility = 'visible';
    frame.legend.style.display = 'flex';
}

function clearDrawing() {
    if (network) network.destroy();
    network = null;
    drawn = null;
    model = null;
    window.currentClassData = {};
}

function renderToolbar(toolbar) {
    if (toolbar.dataset.lang === currentLang) return;
    toolbar.dataset.lang = currentLang;
    const prefs = loadPrefs();
    const limits = [200, 500, 1000, 0];
    toolbar.className = 'map-bar';
    toolbar.innerHTML = `
        <div class="field-row" style="gap:6px;">
            <input type="search" id="graph-search" placeholder="${escHtml(t('codemap_search_placeholder'))}" aria-label="${escHtml(t('codemap_search_placeholder'))}"
                class="field-input field-sm" style="width:min(190px, 100%); flex:none;">
            <button type="button" id="graph-search-btn" class="btn-secondary btn-sm">
                <i data-lucide="search"></i> ${escHtml(t('btn_search'))}</button>
            <select id="graph-layout" class="field-select field-sm" aria-label="${escHtml(t('codemap_layout_label'))}" title="${escHtml(t('codemap_layout_label'))}">
                <option value="tidy"${prefs.layout === 'tidy' ? ' selected' : ''}>${escHtml(t('codemap_layout_tidy'))}</option>
                <option value="organic"${prefs.layout === 'organic' ? ' selected' : ''}>${escHtml(t('codemap_layout_organic'))}</option>
            </select>
            <select id="graph-limit" class="field-select field-sm" aria-label="${escHtml(t('codemap_limit_label'))}" title="${escHtml(t('codemap_limit_label'))}">
                ${limits.map(n => `<option value="${n}"${Number(prefs.limit || 0) === n ? ' selected' : ''}>${escHtml(n ? tf('codemap_limit_n', { n: n.toLocaleString(mapLocale()) }) : t('codemap_limit_none'))}</option>`).join('')}
            </select>
            <label class="field-inline" title="${escHtml(t('maps_physics_hint'))}" style="font-size:0.8rem; padding:0 4px;">
                <input type="checkbox" id="graph-physics"${prefs.physics ? ' checked' : ''}> ${escHtml(t('maps_physics'))}
            </label>
            <button type="button" id="graph-fit" class="btn-secondary btn-sm" aria-label="${escHtml(t('maps_fit'))}" title="${escHtml(t('maps_fit'))}">
                <i data-lucide="maximize-2"></i></button>
            <button type="button" id="graph-toggle-3p" class="btn-secondary btn-sm" hidden></button>
        </div>
        <p id="graph-count" role="status" aria-live="polite" class="page-status" style="margin:0; color:var(--text-body);"></p>`;

    toolbar.querySelector('#graph-search-btn').onclick = () => window.searchGraphNode();
    toolbar.querySelector('#graph-search').onkeydown = e => { if (e.key === 'Enter') window.searchGraphNode(); };
    toolbar.querySelector('#graph-layout').onchange = e => { savePrefs({ layout: e.target.value }); drawGraph(); };
    toolbar.querySelector('#graph-limit').onchange = e => { savePrefs({ limit: Number(e.target.value) }); drawGraph(); renderFolderList(); };
    toolbar.querySelector('#graph-fit').onclick = () => { if (network) network.fit({ animation: animation() }); };
    toolbar.querySelector('#graph-physics').onchange = e => {
        const on = e.target.checked;
        savePrefs({ physics: on });
        const count = drawn ? drawn.nodes.length : 0;
        if (network) {
            network.setOptions({ physics: on ? physicsOptions(count) : { enabled: false } });
            if (on) network.stabilize();
        }
        if (on && count > 500) showToast(tf('codemap_physics_slow', { n: count.toLocaleString(mapLocale()) }), 'warning');
    };
    lucide.createIcons();
}

// ---- Drawing --------------------------------------------------------------------------------

const GRID = { cellW: 200, cellH: 36, itemFont: 14, gapX: 56, gapY: 64, hubGap: 18, hubPx: 16, minHubFont: 16, maxHubFont: 160 };

function physicsOptions(nodeCount) {
    // Stabilization cost grows with node count — a 1000-iteration run over a big graph is
    // exactly what used to freeze the tab.
    const iterations = nodeCount > 600 ? 150 : nodeCount > 300 ? 350 : 800;
    return {
        enabled: true,
        solver: 'forceAtlas2Based',
        forceAtlas2Based: { gravitationalConstant: -120, centralGravity: 0.01, springLength: 140, springConstant: 0.08, avoidOverlap: 1 },
        stabilization: { enabled: true, iterations, updateInterval: 50, fit: true }
    };
}

function folderTitle(folder) {
    return folder.label || t('maps_root_folder');
}

// A project folder's box is one line, "lib · 110 files": a second line doubled the header of
// every small folder and cost the map a third of its zoom. A third-party box says what it is
// and what a click does.
function hubLines(folder) {
    const name = wrapPath(folderTitle(folder));
    const files = countLabel(folder.files.length, 'codemap_file_one', 'codemap_file_many');
    if (!folder.thirdParty) return [...name.slice(0, -1), `${name[name.length - 1]} · ${files}`];
    const open = expandedThirdParty.has(folder.key);
    return [...name.slice(0, -1), `${name[name.length - 1]} · ${t('codemap_thirdparty_tag')}`, tf(open ? 'codemap_hub_open' : 'codemap_hub_folded', { files })];
}

function nodeLook(node, theme) {
    const color = theme.palette[node.colorIndex % theme.palette.length];
    if (node.kind === 'file') {
        // A light wash of the folder's colour: at the first zoom, where file names are too small
        // to draw, each folder still reads as one coloured block.
        const wash = withAlpha(color, theme.dark ? 0.16 : 0.1);
        return {
            color: { background: wash, border: color, highlight: { background: theme.surface, border: theme.brand }, hover: { background: theme.surface, border: theme.brand } },
            font: { color: theme.title, size: GRID.itemFont, face: theme.font }
        };
    }
    if (node.kind === 'hub-3p') {
        return {
            color: { background: theme.canvas, border: color, highlight: { background: theme.surface, border: theme.brand }, hover: { background: theme.surface, border: theme.brand } },
            font: { color: theme.title, size: node.hubFont, face: theme.font, mod: 'bold' }
        };
    }
    return {
        color: { background: color, border: color, highlight: { background: color, border: theme.brand }, hover: { background: color, border: theme.brand } },
        font: { color: textOn(color), size: node.hubFont, face: theme.font, mod: 'bold' }
    };
}

function drawGraph() {
    if (!model) return;
    const frame = mapFrame();
    if (!frame) return;
    const prefs = loadPrefs();
    const theme = mapTheme();
    const view = capFiles(model, prefs.limit, expandedThirdParty);
    const shown = new Set(view.shown);
    const maxChars = Math.floor((GRID.cellW - 36) / (GRID.itemFont * 0.58));
    const blocks = model.folders.map(folder => ({
        id: 'folder:' + folder.key,
        folder,
        items: folder.files.filter(id => shown.has(id)),
        lines: hubLines(folder)
    }));
    const size = { width: frame.canvas.clientWidth || 800, height: frame.canvas.clientHeight || 560 };
    const layout = prefs.layout === 'organic' ? ringLayout(blocks, size) : packBlocks(blocks, size, GRID);

    const nodes = [];
    const edges = [];
    blocks.forEach(block => {
        const folder = block.folder;
        const hub = {
            id: block.id,
            label: block.lines.join('\n'),
            title: `${folder.key || t('maps_root_folder')} · ${countLabel(folder.files.length, 'codemap_file_one', 'codemap_file_many')}`,
            kind: folder.thirdParty ? 'hub-3p' : 'hub',
            colorIndex: folder.colorIndex,
            hubFont: layout.hubFont,
            shape: 'box',
            margin: 10,
            borderWidth: 2,
            borderWidthSelected: 3,
            shapeProperties: { borderRadius: 6, borderDashes: folder.thirdParty ? [6, 4] : false },
            ...(layout.pos[block.id] || {})
        };
        nodes.push({ ...hub, ...nodeLook(hub, theme) });
        block.items.forEach(id => {
            const file = model.files[id];
            const node = {
                id,
                label: fitLabel(file.label, maxChars),
                title: file.rel || file.name,
                kind: 'file',
                colorIndex: folder.colorIndex,
                shape: 'box',
                margin: 6,
                borderWidth: 1.5,
                borderWidthSelected: 3,
                widthConstraint: { minimum: GRID.cellW - 56, maximum: GRID.cellW - 20 },
                shapeProperties: { borderRadius: 4 },
                ...(layout.pos[id] || {})
            };
            nodes.push({ ...node, ...nodeLook(node, theme) });
            // In the grid a file's place already says which folder it is in, and a hundred lines
            // fanning out of one box only hide the names; hidden edges still hold the files near
            // their folder when "Move freely" runs the simulation.
            edges.push({ id: `${block.id}->${id}`, from: block.id, to: id, colorIndex: folder.colorIndex, width: 1,
                hidden: prefs.layout !== 'organic', color: edgeLook(folder.colorIndex, theme) });
        });
    });

    const data = { nodes: new vis.DataSet(nodes), edges: new vis.DataSet(edges) };
    const options = {
        layout: { improvedLayout: false },
        // A label under 7 px on screen is not drawn at all: unreadable text is noise. Zooming in
        // brings the file names back; the folder boxes are sized to be read at the first view.
        nodes: { scaling: { label: { drawThreshold: LABEL_MIN_PX } } },
        physics: prefs.physics ? physicsOptions(nodes.length) : { enabled: false },
        edges: { smooth: false, arrows: { to: { enabled: false } }, selectionWidth: 1 },
        interaction: { hover: true, tooltipDelay: 150, zoomView: true, dragView: true, keyboard: { enabled: true, bindToWindow: false }, hideEdgesOnDrag: nodes.length > 300 }
    };

    if (network) network.destroy();
    network = new vis.Network(frame.canvas, data, options);
    drawn = { nodes: data.nodes, edges: data.edges, blocks, view, adjustHubs: keepHubsReadable(network, data.nodes) };
    if (prefs.physics) network.once('stabilizationIterationsDone', () => network.fit());
    else network.fit();
    if (!themeWatch) themeWatch = onThemeChange(restyle);

    network.on('selectNode', params => {
        const id = params.nodes[0];
        if (!String(id).startsWith('folder:')) { displayNodeDetails(id); return; }
        const key = String(id).slice('folder:'.length);
        const folder = model.folders.find(f => f.key === key);
        if (folder && folder.thirdParty) { toggleThirdParty(key); return; }
        displayFolderDetails(key);
        zoomToFolder(key);
    });
    network.on('zoom', () => updateStatus());
    network.on('animationFinished', () => updateStatus());
    updateStatus();
    updateLegend();
}

function edgeLook(colorIndex, theme) {
    const color = theme.palette[colorIndex % theme.palette.length];
    return { color: withAlpha(color, theme.dark ? 0.45 : 0.4), highlight: theme.brand, hover: theme.brand };
}

// The canvas cannot read CSS variables, so a theme switch repaints the same drawing in place.
function restyle() {
    if (!drawn || !network) return;
    const theme = mapTheme();
    drawn.nodes.update(drawn.nodes.get().map(n => ({ id: n.id, ...nodeLook(n, theme) })));
    drawn.edges.update(drawn.edges.get().map(e => ({ id: e.id, color: edgeLook(e.colorIndex, theme) })));
    drawn.adjustHubs();
    updateLegend();
    document.querySelectorAll('#codeindex-systems [data-swatch]').forEach(swatch => {
        const color = theme.palette[Number(swatch.dataset.swatch) % theme.palette.length];
        if (swatch.dataset.dashed === '1') swatch.style.borderColor = color;
        else swatch.style.background = color;
    });
}

function toggleThirdParty(key) {
    if (expandedThirdParty.has(key)) expandedThirdParty.delete(key);
    else expandedThirdParty.add(key);
    drawGraph();
    renderFolderList();
    displayFolderDetails(key);
    if (expandedThirdParty.has(key)) zoomToFolder(key);
}

function zoomToFolder(key) {
    if (!network || !drawn) return;
    const block = drawn.blocks.find(b => b.folder.key === key);
    if (!block) return;
    zoomToNodes(network, [block.id, ...block.items], GRID.itemFont, document.getElementById('codeindex-vis-canvas'));
}

// ---- Status line, legend, toolbar state --------------------------------------------------------

function updateStatus() {
    const line = document.getElementById('graph-count');
    if (!line || !model || !drawn) return;
    const prefs = loadPrefs();
    const s = mapSummary(model, drawn.view, expandedThirdParty);
    const files = n => countLabel(n, 'codemap_file_one', 'codemap_file_many');
    const folders = n => countLabel(n, 'maps_folder_one', 'maps_folder_many');
    const parts = [];
    if (s.capped) {
        parts.push(tf('codemap_status_capped', { shown: s.shownOwn.toLocaleString(mapLocale()), total: s.ownFiles.toLocaleString(mapLocale()), limit: Number(prefs.limit).toLocaleString(mapLocale()) }));
    } else if (s.thirdPartyFolders) {
        parts.push(tf('codemap_status_own', { files: files(s.ownFiles), folders: folders(s.ownFolders) }));
    } else {
        parts.push(tf('codemap_status_all', { files: files(s.ownFiles), folders: folders(s.ownFolders) }));
    }
    if (s.folded) parts.push(s.folded === 1 ? t('codemap_status_folded_one') : tf('codemap_status_folded_many', { n: s.folded }));
    else if (s.opened) parts.push(t('codemap_status_opened'));
    if (network && network.getScale() * GRID.itemFont < LABEL_MIN_PX && s.shown) parts.push(t('codemap_status_zoom'));
    const text = parts.join(' ');
    if (line.textContent !== text) line.textContent = text;

    const toggle = document.getElementById('graph-toggle-3p');
    if (toggle) {
        toggle.hidden = !s.thirdPartyFolders;
        const allOpen = s.thirdPartyFolders > 0 && s.folded === 0;
        toggle.textContent = t(allOpen ? 'codemap_hide_thirdparty' : 'codemap_show_thirdparty');
        toggle.onclick = () => {
            if (allOpen) expandedThirdParty.clear();
            else model.folders.filter(f => f.thirdParty).forEach(f => expandedThirdParty.add(f.key));
            drawGraph();
            renderFolderList();
        };
    }
}

function updateLegend() {
    const legend = document.getElementById('codeindex-legend');
    if (!legend || !drawn) return;
    const theme = mapTheme();
    legend.className = 'map-legend';
    legend.setAttribute('aria-label', t('maps_legend_label'));
    const own = drawn.blocks.filter(b => !b.folder.thirdParty && b.items.length);
    const top = own.slice(0, 10);
    const swatch = (color, dashed) => `<span class="map-swatch" aria-hidden="true" style="${dashed ? `border:2px dashed ${color};` : `background:${color};`}"></span>`;
    const item = (inner, text) => `<span class="map-legend-item">${inner}<span style="max-width:16ch;">${escHtml(text)}</span></span>`;
    let html = top.map(b => item(swatch(theme.palette[b.folder.colorIndex % theme.palette.length], false), folderTitle(b.folder))).join('');
    if (own.length > top.length) html += `<span style="color:var(--text-muted);">${escHtml(tf('codemap_legend_more', { n: own.length - top.length }))}</span>`;
    if (drawn.blocks.some(b => b.folder.thirdParty)) html += item(swatch(theme.muted, true), t('codemap_legend_thirdparty'));
    legend.innerHTML = html;
}

// ---- Folder list --------------------------------------------------------------------------------

// The scannable answer to "which parts does this project have, and how big are they": the map
// alone buries it on a big project. Opening a folder shows it on the map; a file focuses it.
function renderFolderList() {
    const list = document.getElementById('codeindex-systems');
    if (!list) return;
    if (!model || !model.order.length) {
        list.innerHTML = `<p class="page-status" style="margin:0;">${escHtml(t('codemap_list_empty'))}</p>`;
        return;
    }
    const theme = mapTheme();
    const block = folder => {
        const color = theme.palette[folder.colorIndex % theme.palette.length];
        const items = folder.files.map(id => {
            const file = model.files[id];
            return `<li><button type="button" class="map-item codemap-file" data-node="${escHtml(id)}" title="${escHtml(file.rel || file.name)}"
                style="padding-left:20px; font-size:0.8rem;"><span>${escHtml(file.label)}</span></button></li>`;
        }).join('');
        return `<details class="codemap-folder" data-folder="${escHtml(folder.key)}" style="margin-bottom:0.35rem;">
            <summary title="${escHtml(folder.key || t('maps_root_folder'))}" style="cursor:pointer; display:flex; align-items:center; gap:6px; color:var(--text-title); font-size:0.85rem; font-weight:600; padding:2px 0; min-width:0;">
                <span class="map-swatch" aria-hidden="true" data-swatch="${folder.colorIndex}" data-dashed="${folder.thirdParty ? 1 : 0}" style="${folder.thirdParty ? `border:2px dashed ${color};` : `background:${color};`}"></span>
                <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escHtml(folderTitle(folder))}</span>
                <span style="color:var(--text-muted); font-weight:400; flex-shrink:0;">${escHtml(String(folder.files.length))}</span>
            </summary><ul style="list-style:none; margin:0.2rem 0 0.4rem; padding:0;">${items}</ul></details>`;
    };
    const own = model.folders.filter(f => !f.thirdParty);
    const thirdParty = model.folders.filter(f => f.thirdParty);
    const thirdPartyFiles = thirdParty.reduce((sum, f) => sum + f.files.length, 0);
    list.innerHTML = own.map(block).join('') + (thirdParty.length ? `
        <details style="margin-top:0.6rem; border-top:1px solid var(--border-subtle); padding-top:0.5rem;">
            <summary style="cursor:pointer; color:var(--text-title); font-size:0.84rem; font-weight:600;">${escHtml(tf('codemap_thirdparty_group', {
                folders: countLabel(thirdParty.length, 'maps_folder_one', 'maps_folder_many'),
                files: countLabel(thirdPartyFiles, 'codemap_file_one', 'codemap_file_many') }))}</summary>
            <p style="margin:0.35rem 0 0.5rem; color:var(--text-muted); font-size:0.78rem; line-height:1.45;">${escHtml(t('codemap_thirdparty_hint'))}</p>
            <div style="padding-left:6px;">${thirdParty.map(block).join('')}</div>
        </details>` : '');

    list.querySelectorAll('details.codemap-folder').forEach(fold => {
        fold.addEventListener('toggle', () => {
            if (!fold.open) return;
            const folder = model.folders.find(f => f.key === fold.dataset.folder);
            if (!folder) return;
            displayFolderDetails(folder.key);
            if (!folder.thirdParty) zoomToFolder(folder.key);
        });
    });
    list.querySelectorAll('.codemap-file').forEach(button => {
        button.onclick = () => {
            const id = button.dataset.node;
            const file = model.files[id];
            // A file inside a folded third-party folder: open the folder first, or the map has
            // nothing to focus and the list would be pointing at a file that is not drawn.
            if (file && file.thirdParty && !expandedThirdParty.has(file.folder)) {
                expandedThirdParty.add(file.folder);
                drawGraph();
            }
            displayNodeDetails(id);
            focusNode(id);
        };
    });
}

// The list and the search cover the whole index, the map only what is drawn, so a target may
// legitimately not be on screen.
function focusNode(id) {
    if (!network) return false;
    if (!network.body.nodes[id]) {
        showToast(t('codemap_not_drawn'), 'info');
        return false;
    }
    network.selectNodes([id]);
    network.focus(id, { scale: Math.max(network.getScale(), READABLE_PX / GRID.itemFont), animation: animation() });
    return true;
}

window.searchGraphNode = function() {
    const input = document.getElementById('graph-search');
    const query = input ? input.value.toLowerCase().trim() : '';
    if (!query || !model) return;
    const folder = model.folders.find(f => f.key.toLowerCase() === query || (f.label || '').toLowerCase() === query);
    if (folder) {
        if (folder.thirdParty && !expandedThirdParty.has(folder.key)) toggleThirdParty(folder.key);
        else { displayFolderDetails(folder.key); zoomToFolder(folder.key); }
        return;
    }
    const id = model.order.find(i => model.files[i].label.toLowerCase().includes(query) || i.toLowerCase().includes(query));
    if (!id) {
        showToast(tf('maps_not_found', { q: input.value.trim() }), 'info');
        return;
    }
    const file = model.files[id];
    if (file.thirdParty && !expandedThirdParty.has(file.folder)) {
        expandedThirdParty.add(file.folder);
        drawGraph();
        renderFolderList();
    }
    displayNodeDetails(id);
    focusNode(id);
};

// ---- Details panel ------------------------------------------------------------------------------

function detailsPanel() {
    return document.getElementById('graph-node-details');
}

function resetDetails() {
    const panel = detailsPanel();
    if (panel) panel.innerHTML = `<p class="page-status" style="margin:0;">${escHtml(t('codeindex_details_placeholder'))}</p>`;
}


function displayFolderDetails(key) {
    const panel = detailsPanel();
    const folder = model && model.folders.find(f => f.key === key);
    if (!panel || !folder) return;
    const open = expandedThirdParty.has(key);
    const count = countLabel(folder.files.length, 'codemap_file_one', 'codemap_file_many');
    const action = folder.thirdParty
        ? `<button type="button" class="btn-secondary" id="codemap-folder-toggle">${escHtml(t(open ? 'codemap_btn_hide_files' : 'codemap_btn_show_files'))}</button>`
        : `<button type="button" class="btn-secondary" id="codemap-folder-zoom"><i data-lucide="zoom-in"></i> ${escHtml(t('codemap_btn_zoom_folder'))}</button>`;
    panel.innerHTML = `
        <p class="map-kind"><i data-lucide="folder"></i> ${escHtml(t(folder.thirdParty ? 'codemap_kind_thirdparty' : 'maps_kind_folder'))}</p>
        <p class="map-name">${escHtml(folder.key || t('maps_root_folder'))}</p>
        <p style="margin:0 0 0.6rem; color:var(--text-body); font-size:0.85rem;">${escHtml(tf('codemap_folder_count', { files: count }))}</p>
        <p style="margin:0 0 0.8rem; color:var(--text-body); font-size:0.85rem; line-height:1.5;">${escHtml(t(folder.thirdParty ? 'codemap_folder_thirdparty' : 'codemap_folder_own'))}</p>
        ${action}`;
    const toggle = panel.querySelector('#codemap-folder-toggle');
    if (toggle) toggle.onclick = () => toggleThirdParty(key);
    const zoom = panel.querySelector('#codemap-folder-zoom');
    if (zoom) zoom.onclick = () => zoomToFolder(key);
    lucide.createIcons();
}

function displayNodeDetails(nodeId) {
    const panel = detailsPanel();
    if (!panel || !model) return;
    if (String(nodeId).startsWith('folder:')) { displayFolderDetails(String(nodeId).slice('folder:'.length)); return; }
    const data = model.files[nodeId];
    if (!data) { resetDetails(); return; }
    const folder = model.folders.find(f => f.key === data.folder);
    const path = data.rel || data.name;
    const section = (labelKey, value, mono = true) => value ? `
        <div style="margin-bottom:0.75rem;">
            <p style="margin:0 0 0.2rem; font-size:0.78rem; color:var(--text-muted);">${escHtml(t(labelKey))}</p>
            <p style="margin:0; font-size:0.8rem; color:var(--text-title); line-height:1.5; overflow-wrap:anywhere; max-height:7.5em; overflow-y:auto; ${mono ? 'font-family:var(--font-mono);' : ''}">${escHtml(value)}</p>
        </div>` : '';
    panel.innerHTML = `
        <p class="map-kind"><i data-lucide="file-code"></i> ${escHtml(t(data.thirdParty ? 'codemap_kind_thirdparty_file' : 'codemap_kind_file'))}</p>
        <p class="map-name">${escHtml(data.label)}</p>
        <p style="margin:0 0 0.8rem; font-family:var(--font-mono); font-size:0.78rem; color:var(--text-body); overflow-wrap:anywhere;">${escHtml(path)}</p>
        ${section('codemap_exports', data.exports)}
        ${section('codemap_types', data.types)}
        ${section('codemap_functions', data.functions)}
        ${section('codemap_signature', data.signature)}
        ${section('codemap_methods', data.methods)}
        ${section('codemap_fires', data.fires)}
        ${section('codemap_listens', data.listens)}
        ${section('codemap_refs', data.refs.join(', '), false)}
        ${!data.exports && !data.types && !data.functions && !data.signature && !data.methods ? `<p style="margin:0 0 0.75rem; font-size:0.82rem; color:var(--text-muted);">${escHtml(t('codemap_no_symbols'))}</p>` : ''}
        <div class="field-row" style="margin-bottom:0.75rem;">
            <button type="button" class="btn-secondary btn-sm" data-copy="${escHtml(path)}"><i data-lucide="copy"></i> ${escHtml(t('codemap_copy_path'))}</button>
            ${folder ? `<button type="button" class="btn-secondary btn-sm" id="codemap-file-folder"><i data-lucide="folder"></i> ${escHtml(folderTitle(folder))}</button>` : ''}
        </div>
        ${askLine(tf('codemap_ask_explain', { path }))}`;
    const toFolder = panel.querySelector('#codemap-file-folder');
    if (toFolder) toFolder.onclick = () => { displayFolderDetails(data.folder); if (!data.thirdParty) zoomToFolder(data.folder); };
    lucide.createIcons();
}

// Takes the button explicitly instead of reading the ambient `event` global — the latter only
// works when called from a raw inline onclick, and throws otherwise.
window.regenerateCodebaseIndex = async function(btn) {
    btn = btn || (typeof event !== 'undefined' && event.currentTarget);
    const originalHtml = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i data-lucide="loader" class="spin" style="width:14px; height:14px;"></i> ${escHtml(t('codemap_scanning'))}`;
        lucide.createIcons();
    }
    try {
        const res = await fetch('/api/codeindex/scan', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast(data.skippedFiles > 0
                ? tf('codemap_scan_capped', { max: Number(data.maxScanFiles).toLocaleString(mapLocale()), skipped: Number(data.skippedFiles).toLocaleString(mapLocale()) })
                : t('codemap_scan_done'), data.skippedFiles > 0 ? 'warning' : 'success');
            await fetchCodeIndex();
        } else {
            showToast(tf('codemap_scan_failed', { reason: data.message || `HTTP ${res.status}` }), 'error');
        }
    } catch (e) {
        showToast(t('codemap_scan_offline'), 'error');
    } finally {
        if (btn && btn.isConnected) {
            btn.disabled = false;
            btn.innerHTML = originalHtml;
            lucide.createIcons();
        }
    }
};

// ---- Map helpers, shared with the Documents page (dochub.js) ---------------------------------------

// A label under this many pixels on screen is not drawn; READABLE_PX is where a zoom aims.
export const LABEL_MIN_PX = 8;
export const READABLE_PX = 12;

export const mapLocale = () => (currentLang === 'tr' ? 'tr-TR' : 'en-US');

export function tf(key, vars = {}) {
    return Object.entries(vars).reduce((text, [name, value]) => text.split(`{${name}}`).join(String(value)), t(key));
}

export function countLabel(n, oneKey, manyKey) {
    return n === 1 ? t(oneKey) : t(manyKey).split('{n}').join(Number(n).toLocaleString(mapLocale()));
}

export function fitLabel(text, maxChars) {
    const s = String(text);
    return s.length > maxChars ? s.slice(0, Math.max(1, maxChars - 1)) + '…' : s;
}

// A long folder path breaks after its slashes, so a box is not one very wide line.
export function wrapPath(label, max = 18) {
    const s = String(label);
    if (s.length <= max || !s.includes('/')) return [s];
    const lines = [];
    let line = '';
    s.split('/').forEach((piece, i, all) => {
        const part = piece + (i < all.length - 1 ? '/' : '');
        if (line && (line + part).length > max) { lines.push(line); line = part; }
        else line += part;
    });
    if (line) lines.push(line);
    return lines;
}

// Folder colours, one set per theme. Light uses 700-level hues and dark 300/400-level ones, so
// each keeps 3:1 against its own canvas as a border or a line; a folder box's label is drawn in
// whichever of white or near-black reads better on it (textOn).
const MAP_PALETTE = {
    light: ['#b45309', '#0f766e', '#5b4bc4', '#1d4ed8', '#c2410c', '#a21caf', '#4d7c0f', '#a16207', '#0e7490', '#be185d', '#2563eb', '#7e22ce'],
    dark: ['#f2a541', '#3bb3a3', '#8b7cf6', '#5da9f6', '#ff9566', '#e879f9', '#a3e635', '#facc15', '#2dd4bf', '#f472b6', '#60a5fa', '#d8b4fe']
};

// The canvas cannot read CSS variables, so the map reads the theme's tokens when it draws.
export function mapTheme() {
    const root = document.documentElement;
    const css = getComputedStyle(root);
    const dark = root.getAttribute('data-theme') === 'dark';
    const token = (name, light, darkValue) => (css.getPropertyValue(name) || '').trim() || (dark ? darkValue : light);
    return {
        dark,
        canvas: token('--bg-primary', '#fbfbfa', '#16213a'),
        surface: token('--bg-surface', '#ffffff', '#111a2e'),
        title: token('--text-title', '#1b1c21', '#e7e9ee'),
        body: token('--text-body', '#4c515b', '#aab0bb'),
        muted: token('--text-muted', '#686d76', '#8e949f'),
        brand: token('--brand-primary', '#b45309', '#f2a541'),
        warn: token('--status-todo', '#9a5b0b', '#e0b341'),
        font: token('--font-ui', 'system-ui, sans-serif', 'system-ui, sans-serif'),
        palette: MAP_PALETTE[dark ? 'dark' : 'light']
    };
}

function luminance(hex) {
    const m = String(hex).trim().match(/^#?([0-9a-f]{6})$/i);
    if (!m) return 0.5;
    const channel = i => {
        const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

export function contrast(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

export function textOn(hex) {
    return contrast(hex, '#ffffff') >= contrast(hex, '#101826') ? '#ffffff' : '#101826';
}

export function withAlpha(hex, alpha) {
    const m = String(hex).trim().match(/^#?([0-9a-f]{6})$/i);
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function onThemeChange(callback) {
    if (typeof MutationObserver === 'undefined') return null;
    let queued = false;
    const observer = new MutationObserver(() => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; callback(); });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
    return observer;
}

export function animation() {
    const still = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    return still ? false : { duration: 450, easingFunction: 'easeInOutQuad' };
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// The zoom that frames a width x height drawing in the canvas, as vis fit() picks it: canvas size
// over 1.1 times the drawing's extent (a little more here, for the boxes' own edges).
export function fitScale(width, height, frame) {
    return Math.min(Math.max(1, frame.width) / Math.max(1, width), Math.max(1, frame.height) / Math.max(1, height)) / 1.12;
}

// Lays out folder blocks (a folder box on top, its items in a grid below) shelf by shelf. It tries
// block shapes and shelf widths and keeps the drawing that frames at the largest zoom: a map four
// times wider than its canvas is fitted at a quarter of the zoom, which is what put every label
// under the size vis will draw. The folder boxes' font is then set so their names read at that
// first zoom, and the layout runs again with the bigger boxes until the two agree.
const SHAPES = [0.6, 0.8, 1, 1.25, 1.6, 2, 2.6];
export function packBlocks(blocks, frame, o) {
    const margin = 10;
    const hubGap = o.hubGap || 18;
    const aspect = frame.width / Math.max(1, frame.height);
    let hubFont = o.minHubFont;
    let best = null;
    for (let pass = 0; pass < 8; pass++) {
        let passBest = null;
        for (const shape of SHAPES) {
            const sized = blocks.map(b => {
                const n = b.items.length;
                const cols = n ? clamp(Math.round(Math.sqrt(n * o.cellH * aspect / o.cellW) * shape), 1, Math.min(n, o.maxCols || 8)) : 1;
                const rows = Math.ceil(n / cols);
                const chars = Math.max(1, ...b.lines.map(l => l.length));
                const hubW = chars * hubFont * 0.62 + 2 * margin;
                const hubH = b.lines.length * hubFont * 1.25 + 2 * margin;
                const w = Math.max(cols * o.cellW, hubW);
                return { b, cols, w, hubH, h: hubH + (n ? hubGap + rows * o.cellH : 0) };
            });
            const pack = bestShelf(sized, frame, o.gapX, o.gapY);
            if (!passBest || pack.scale > passBest.scale) passBest = pack;
        }
        best = { ...passBest, hubFont };
        const want = clamp(o.hubPx / Math.min(1, passBest.scale), o.minHubFont, o.maxHubFont);
        if (Math.abs(want - hubFont) < 1) break;
        hubFont = want;
    }
    const pos = {};
    best.at.forEach(({ s, x, y }) => {
        pos[s.b.id] = { x: x + s.w / 2, y: y + s.hubH / 2 };
        const left = x + (s.w - s.cols * o.cellW) / 2;
        s.b.items.forEach((id, i) => {
            pos[id] = {
                x: left + (i % s.cols) * o.cellW + o.cellW / 2,
                y: y + s.hubH + hubGap + Math.floor(i / s.cols) * o.cellH + o.cellH / 2
            };
        });
    });
    return { pos, hubFont: best.hubFont, scale: best.scale, width: best.width, height: best.height };
}

function bestShelf(sized, frame, gapX, gapY) {
    const widest = Math.max(1, ...sized.map(s => s.w));
    const total = sized.reduce((sum, s) => sum + s.w, 0) + gapX * Math.max(0, sized.length - 1);
    let best = null;
    for (let k = 0; k <= 32; k++) {
        const limit = widest + (Math.max(widest, total) - widest) * (k / 32);
        let x = 0, y = 0, rowH = 0, width = 0;
        const at = [];
        for (const s of sized) {
            if (x > 0 && x + s.w > limit + 0.5) { x = 0; y += rowH + gapY; rowH = 0; }
            at.push({ s, x, y });
            width = Math.max(width, x + s.w);
            x += s.w + gapX;
            rowH = Math.max(rowH, s.h);
        }
        const height = y + rowH;
        const scale = fitScale(width, height, frame);
        if (!best || scale > best.scale) best = { at, width, height, scale };
    }
    return best;
}

// The free-form layout: folder boxes on a ring, their files spiralling out, a seed the force
// simulation relaxes from when "Move freely" is on.
function ringLayout(blocks, frame) {
    const pos = {};
    const hubFont = 24;
    const R = Math.max(420, blocks.length * 140);
    blocks.forEach((b, i) => {
        const angle = (i / Math.max(1, blocks.length)) * Math.PI * 2;
        const fx = Math.cos(angle) * R;
        const fy = Math.sin(angle) * R;
        pos[b.id] = { x: fx, y: fy };
        b.items.forEach((id, j) => {
            const r = 150 + hubFont * b.lines.length * 0.7 + Math.floor(j / 14) * 95;
            const a = angle + ((j % 14) / 14) * Math.PI * 2;
            pos[id] = { x: fx + Math.cos(a) * r, y: fy + Math.sin(a) * r };
        });
    });
    const xs = Object.values(pos).map(p => p.x);
    const ys = Object.values(pos).map(p => p.y);
    const scale = fitScale(Math.max(...xs) - Math.min(...xs) + GRID.cellW, Math.max(...ys) - Math.min(...ys) + 120, frame);
    return { pos, scale, hubFont };
}

// Folder boxes are sized for the first view; zoomed in, vis grows their text with the zoom until
// a box is a banner wider than the screen. This keeps folder names at about `px` on screen when
// zoomed in, and never larger than the room the layout gave them. Returns the function that
// applies it, for after a repaint.
export function keepHubsReadable(net, nodesSet, px = 18) {
    let queued = false;
    const apply = () => {
        queued = false;
        if (!net || !nodesSet) return;
        const scale = Math.max(0.02, net.getScale());
        const hubs = nodesSet.get({ filter: n => n.kind === 'hub' || n.kind === 'hub-3p' });
        const changed = hubs.filter(n => {
            const size = Math.min(n.hubFont, px / scale);
            return !n.font || Math.abs(n.font.size - size) >= 0.5;
        });
        if (changed.length) nodesSet.update(changed.map(n => ({ id: n.id, font: { ...n.font, size: Math.min(n.hubFont, px / scale) } })));
    };
    const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(apply); } };
    net.on('zoom', schedule);
    net.on('animationFinished', schedule);
    return apply;
}

// Frames a group of nodes. When framing all of them would make their names too small to read
// (a folder of a hundred files), it shows the top of the group at a readable zoom instead.
export function zoomToNodes(net, ids, itemFont, container) {
    const boxes = ids.map(id => { try { return net.getBoundingBox(id); } catch (e) { return null; } }).filter(Boolean);
    if (!boxes.length) return;
    const left = Math.min(...boxes.map(b => b.left));
    const right = Math.max(...boxes.map(b => b.right));
    const top = Math.min(...boxes.map(b => b.top));
    const bottom = Math.max(...boxes.map(b => b.bottom));
    const frame = { width: (container && container.clientWidth) || 800, height: (container && container.clientHeight) || 560 };
    const readable = READABLE_PX / itemFont;
    const framed = Math.min(1.2, fitScale(right - left, bottom - top, frame));
    const scale = Math.max(framed, Math.min(readable, 1.2));
    const viewW = frame.width / scale;
    const viewH = frame.height / scale;
    // Too big to frame readable: show its top, centred on the first node (the folder's own box,
    // so its name is on screen) as far as the group's edges allow.
    const anchor = (boxes[0].left + boxes[0].right) / 2;
    const x = right - left <= viewW ? (left + right) / 2 : clamp(anchor, left + viewW / 2, right - viewW / 2);
    const position = scale > framed
        ? { x, y: top + Math.min(bottom - top, viewH) / 2 }
        : { x: (left + right) / 2, y: (top + bottom) / 2 };
    net.moveTo({ position, scale, animation: animation() });
}
