// Dependency graph page (graphify): which source file depends on which, drawn by the page
// lib/graphify.mjs serves at /api/graphify/html in a frame here. This module shows the frame, or
// what is missing and how to get it, and runs the page's build, delete and keep-current controls.
import { t } from '../i18n.js';
import { showToast } from './toast.js';
import { escHtml } from '../esc.js';
import { emptyState } from './page.js';
import { tf, countLabel, mapLocale } from './codeindex.js';

const currentStudioMode = 'code';

// The frame's container takes the theme's canvas colour (dashboard-ui.html); it was a fixed near-black,
// which put the dark-text empty states on black in the light theme.
const canvasContainer = () => document.getElementById('graphify-studio-canvas-container');

function showState(container, html) {
    container.innerHTML = `<div class="map-state" style="display:flex; position:static;"><div>${html}</div></div>`;
    lucide.createIcons();
}

function setCounts(nodes, links) {
    const nodeCountEl = document.getElementById('graphify-studio-node-count');
    const edgeCountEl = document.getElementById('graphify-studio-edge-count');
    if (nodeCountEl) nodeCountEl.innerHTML = `<i data-lucide="file-code" style="color:var(--brand-primary);"></i> <b>${escHtml(nodes === null ? '–' : countLabel(nodes, 'codemap_file_one', 'codemap_file_many'))}</b>`;
    if (edgeCountEl) edgeCountEl.innerHTML = `<i data-lucide="link" style="color:var(--status-progress);"></i> <b>${escHtml(links === null ? '–' : countLabel(links, 'depgraph_links_one', 'depgraph_links_many'))}</b>`;
}

export async function fetchGraphifyStudio() {
    const container = canvasContainer();
    if (!container) return;
    const updatedEl = document.getElementById('graphify-studio-updated-at');
    const fsBtn = document.getElementById('graphify-studio-fullscreen-btn');
    if (fsBtn) fsBtn.href = '/api/graphify/html';

    container.innerHTML = `<div class="map-state" style="display:flex; position:static;"><p class="page-status">${escHtml(t('loading'))}</p></div>`;

    let res;
    let data;
    try {
        res = await fetch(`/api/graphify?mode=${currentStudioMode}`);
        data = await res.json().catch(() => ({}));
    } catch (e) {
        setCounts(null, null);
        if (updatedEl) updatedEl.textContent = '';
        showState(container, emptyState({ icon: 'wifi-off', title: t('depgraph_error_title'), text: t('maps_offline_text'),
            action: { label: t('maps_retry'), onclick: 'fetchGraphifyStudio()' } }));
        return;
    }
    if (!res.ok) {
        // The server says why: no project selected, a builder that threw. Reporting "restart
        // the server" for all of it sent people to fix the one thing that was never wrong.
        setCounts(null, null);
        if (updatedEl) updatedEl.textContent = '';
        showState(container, emptyState({ icon: 'alert-triangle', title: t('depgraph_error_title'),
            text: tf('depgraph_error_server', { reason: (data && data.message) || `HTTP ${res.status}` }),
            action: { label: t('maps_retry'), onclick: 'fetchGraphifyStudio()' } }));
        return;
    }

    // Reflect the project's own setting, not this browser's.
    const autoBox = document.getElementById('graphify-auto-toggle');
    if (autoBox) autoBox.checked = data.autoRefresh === true;
    const autoWrap = document.getElementById('graphify-auto-wrap');
    if (autoWrap) autoWrap.title = t('graphify_auto_hint');

    if (data.needsProject) {
        setCounts(null, null);
        if (updatedEl) updatedEl.textContent = '';
        showState(container, emptyState({ icon: 'folder-open', title: t('maps_no_project_title'), text: t('depgraph_no_project_text'),
            action: { label: t('maps_open_projects'), onclick: "switchView('hub-view')" } }));
        return;
    }
    setCounts(data.exists ? (data.nodeCount || 0) : null, data.exists ? (data.edgeCount || 0) : null);
    if (updatedEl) {
        updatedEl.textContent = data.updatedAt
            ? tf('depgraph_updated', { when: new Date(data.updatedAt).toLocaleString(mapLocale(), { dateStyle: 'medium', timeStyle: 'short' }) })
            : t('depgraph_not_built');
    }

    if (!data.exists) {
        showState(container, emptyState({ icon: 'network', title: t('depgraph_empty_title'), text: t('depgraph_empty_text'),
            action: { label: t('depgraph_build_action'), onclick: 'buildCurrentGraphifyStudioGraph()' } }));
        return;
    }
    if (!data.nodeCount) {
        showState(container, emptyState({ icon: 'file-search', title: t('depgraph_empty_graph_title'), text: t('depgraph_empty_graph_text'),
            action: { label: t('depgraph_build_action'), onclick: 'buildCurrentGraphifyStudioGraph()' } }));
        return;
    }

    // The page in the frame draws, themes and labels itself (lib/graphify.mjs renderHtml).
    container.innerHTML = `<iframe src="/api/graphify/html" title="${escHtml(t('depgraph_frame_title'))}" style="width:100%; height:100%; border:none; display:block; background:var(--bg-primary);"></iframe>`;
    lucide.createIcons();
}

window.fetchGraphifyStudio = fetchGraphifyStudio;

window.buildCurrentGraphifyStudioGraph = async function() {
    // Both the toolbar button and the one drawn inside the empty canvas call this. Spinning
    // only the toolbar one left whoever clicked the in-canvas button staring at a button
    // that never reacted.
    const btns = [
        document.getElementById('graphify-studio-build-btn'),
        ...document.querySelectorAll('#graphify-studio-canvas-container .empty-state .btn-primary')
    ].filter(Boolean);
    const orig = btns.map(b => b.innerHTML);
    for (const b of btns) {
        b.disabled = true;
        b.innerHTML = `<i data-lucide="loader-2" class="spin" style="width:14px; height:14px;"></i> <span>${escHtml(t('depgraph_building'))}</span>`;
    }
    if (btns.length) lucide.createIcons();

    try {
        const res = await fetch(`/api/graphify/scan?mode=${currentStudioMode}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: currentStudioMode })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            // 409 = no project selected, 500 = the builder's own message. Both were being
            // reported as "restart the server", which was never the reason.
            showToast(tf('depgraph_build_failed', { reason: data.message || `HTTP ${res.status}` }), 'error');
            return;
        }
        showToast(tf('depgraph_built', {
            files: countLabel(data.nodeCount || 0, 'codemap_file_one', 'codemap_file_many'),
            links: countLabel(data.edgeCount || 0, 'depgraph_links_one', 'depgraph_links_many')
        }), 'success');
        await fetchGraphifyStudio();
    } catch (e) {
        showToast(t('maps_offline_text'), 'error');
    } finally {
        btns.forEach((b, i) => { if (b.isConnected) { b.disabled = false; b.innerHTML = orig[i]; } });
        if (btns.length) lucide.createIcons();
    }
};

window.setGraphifyAutoRefresh = async function(enabled) {
    const box = document.getElementById('graphify-auto-toggle');
    try {
        const res = await fetch('/api/graphify/auto', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: !!enabled })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            // Put the checkbox back where the project actually is, so the UI never claims a
            // setting the server did not accept.
            if (box) box.checked = !enabled;
            showToast(tf('depgraph_auto_failed', { reason: data.message || `HTTP ${res.status}` }), 'error');
            return;
        }
        showToast(t(enabled ? 'graphify_auto_on' : 'graphify_auto_off'), enabled ? 'success' : 'info');
    } catch (e) {
        if (box) box.checked = !enabled;
        showToast(t('maps_offline_text'), 'error');
    }
};

window.cleanCurrentGraphifyStudioGraph = async function() {
    if (!confirm(t('confirm_clean_graphify'))) return;

    const btn = document.getElementById('graphify-studio-clean-btn');
    const origHtml = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i data-lucide="loader-2" class="spin" style="width:14px; height:14px;"></i>`;
        lucide.createIcons();
    }

    try {
        const res = await fetch(`/api/graphify/clean?mode=${currentStudioMode}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: currentStudioMode })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success) {
            showToast(t('graph_cleaned_success'), 'success');
            await fetchGraphifyStudio();
        } else {
            showToast(tf('depgraph_clean_failed', { reason: data.message || `HTTP ${res.status}` }), 'error');
        }
    } catch (e) {
        showToast(t('maps_offline_text'), 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = origHtml;
            lucide.createIcons();
        }
    }
};
