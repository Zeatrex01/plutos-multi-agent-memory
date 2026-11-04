// Add Project modal: in-page folder browser (backed by /api/fs/list) + workspace creation.
import { t } from '../i18n.js';
import { showToast } from './toast.js';
// A folder name is user data — one containing < or " would otherwise land raw in the row markup.
import { escHtml } from '../esc.js';

let fsCurrentPath = '';
let fsParentPath = null;
// Clicking a folder navigates INTO it, so the folder you are standing in is the one you
// mean. The path field follows the browser automatically; the moment the user types their
// own path it stops following, so a pasted path is never overwritten by navigation.
let pathEditedByUser = false;

function syncInstallPath() {
    if (pathEditedByUser) return;
    document.getElementById('install-path').value = fsCurrentPath || '';
}

document.getElementById('install-path').addEventListener('input', () => { pathEditedByUser = true; });

window.fsBrowse = async function(p) {
    try {
        const res = await fetch('/api/fs/list' + (p ? '?path=' + encodeURIComponent(p) : ''));
        const data = await res.json();
        if (!data.success) { showToast(data.message, true); return; }
        fsCurrentPath = data.path;
        fsParentPath = data.parent;
        syncInstallPath();
        document.getElementById('fs-current').textContent = data.path || 'Drives';
        const rowStyle = 'padding:0.35rem 0.75rem; cursor:pointer; color:var(--text-body); font-size:0.85rem; border-bottom:1px solid var(--border-subtle); display:flex; align-items:center; gap:0.5rem;';
        document.getElementById('fs-list').innerHTML = data.dirs.length
            ? data.dirs.map(d => `<div style="${rowStyle}" onmouseover="this.style.background='var(--bg-surface)'" onmouseout="this.style.background=''" onclick="fsBrowse(decodeURIComponent('${encodeURIComponent(d.path).replace(/'/g, '%27')}'))">&#128193; ${escHtml(d.name)}</div>`).join('')
            : `<div style="padding:0.75rem; color:var(--text-muted); font-size:0.85rem;">${t('fs_empty')}</div>`;
    } catch(e) {
        showToast(t('conn_error'), true);
    }
};

window.fsBrowseUp = function() {
    window.fsBrowse(fsParentPath || '');
};

window.fsUseCurrent = function() {
    if (!fsCurrentPath) { showToast(t('install_pick_folder'), true); return; }
    pathEditedByUser = false;
    document.getElementById('install-path').value = fsCurrentPath;
};

// Escape closes the modal, as it closes every other dialog here; a plain div has no such default.
document.addEventListener('keydown', event => {
    const modal = document.getElementById('install-modal');
    if (event.key === 'Escape' && modal && modal.style.display === 'flex') modal.style.display = 'none';
});

window.addNewWorkspace = async function() {
    // Open the modal with the in-page folder browser — no OS dialog needed.
    // The path field stays editable for direct paste.
    document.getElementById('install-path').value = '';
    pathEditedByUser = false;
    fsCurrentPath = '';
    document.getElementById('install-modal').style.display = 'flex';
    document.getElementById('workspace-dropdown').style.display = 'none';
    lucide.createIcons();
    window.fsBrowse('');
};

function describeDetected(data) {
    const d = data && data.detected;
    if (!d) return '';
    const fw = (d.frameworks && d.frameworks.length) ? ` / ${d.frameworks.join(', ')}` : '';
    const maps = d.codeIndex && d.docs ? t('install_detected_maps') : '';
    return `${t('install_detected')}: ${d.stack}${fw}. ${maps}`;
}

window.executeInstall = async function() {
    try {
        const targetPath = document.getElementById('install-path').value.trim();
        if (!targetPath) { showToast(t('install_pick_folder'), true); return; }
        const payload = { path: targetPath };

        const res = await fetch('/api/workspaces/add', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if(data.success) {
            const detectedLine = describeDetected(data);
            showToast(detectedLine ? `${t('msg_proj_added')} ${detectedLine}` : t('msg_proj_added'));
            // Adding a project also OPENS it (addWorkspace makes it active), so this is the
            // second door into a project switch and reloads like the first — see the note in
            // modules/workspaces.js. The delay is only so the detection toast can be read;
            // the reload is what closes the modal and refills every tab for the new project.
            setTimeout(() => location.reload(), 900);
        } else {
            showToast(t('error') + ': ' + data.message, true);
        }
    } catch(e) {
        showToast(t('err_conn_cancel'), true);
    }
};
