// Settings tab: visual theme, auto-refresh rate, local cache reset.
import { showToast } from './toast.js';
import { fetchBoard } from './board.js';
import { t } from '../i18n.js';
import { openProjectRepair } from './repair.js';
import { refreshReturnSummary } from './overview.js';

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value || '—';
}

export async function fetchStorageInfo() {
    const status = document.getElementById('settings-storage-status');
    try {
        const res = await fetch('/api/settings/storage');
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Storage status unavailable.');
        setText('settings-app-root', data.appRoot);
        setText('settings-data-root', data.dataRoot);
        setText('settings-project-data-root', data.project?.dataRoot || t('settings_storage_no_project'));
        setText('settings-project-data-mode', data.project
            ? (data.project.mode === 'project-owned'
                ? t('settings_storage_project_owned')
                : t('settings_storage_sidecar'))
            : t('settings_storage_no_project'));
        setText('settings-runtime-os', data.runtime?.platform);
        setText('settings-runtime-node', `${data.runtime?.node || 'Node'} · ${t('settings_storage_online')} ${data.runtime?.port || ''}`);
        setText('settings-runtime-mode', data.runtime?.packaged
            ? t('settings_storage_packaged')
            : t('settings_storage_development'));
        if (status) {
            const migrated = data.migration?.items?.length || 0;
            status.textContent = migrated
                ? t('settings_storage_migrated').replace('{n}', String(migrated))
                : t('settings_storage_stable');
            status.style.color = 'var(--status-done)';
        }
    } catch (e) {
        if (status) {
            status.textContent = e.message;
            status.style.color = 'var(--status-blocked)';
        }
    }
}

function applyTheme(theme) {
    const root = document.documentElement;
    if (theme === 'cyberpunk') {
        root.style.setProperty('--brand-primary', '#8b7cf6'); root.style.setProperty('--on-brand', '#ffffff');
    } else if (theme === 'neon-blue') {
        root.style.setProperty('--brand-primary', '#5da9f6'); root.style.setProperty('--on-brand', '#0b1120');
    } else if (theme === 'emerald') {
        root.style.setProperty('--brand-primary', '#3bb3a3'); root.style.setProperty('--on-brand', '#0b1120');
    } else {
        // Default = no override: the light and dark tokens supply the core's amber, each with
        // the text colour that reads on it.
        root.style.removeProperty('--brand-primary'); root.style.removeProperty('--on-brand');
    }
}

export function initVisualTheme() {
    const saved = localStorage.getItem('plutos-theme');
    if (saved) {
        const select = document.getElementById('setting-theme');
        if (select) select.value = saved;
        applyTheme(saved);
    }
}

window.applyVisualTheme = function() {
    const select = document.getElementById('setting-theme');
    if (!select) return;
    const theme = select.value;
    localStorage.setItem('plutos-theme', theme);
    applyTheme(theme);
    showToast('Visual theme updated!');
};

export function initRefreshRate() {
    const saved = localStorage.getItem('plutos-refresh') || '3000';
    const select = document.getElementById('setting-refresh');
    if (select) select.value = saved;

    if (window.refreshIntervalId) clearInterval(window.refreshIntervalId);

    if (saved !== 'manual') {
        const ms = parseInt(saved, 10);
        window.refreshIntervalId = setInterval(() => {
            if (document.getElementById('view-overview').classList.contains('active')) {
                refreshReturnSummary();
            }
            if (document.getElementById('view-board').classList.contains('active')) {
                fetchBoard();
            }
        }, ms);
    }
}

window.applyRefreshRate = function() {
    const select = document.getElementById('setting-refresh');
    if (!select) return;
    const rate = select.value;
    localStorage.setItem('plutos-refresh', rate);
    initRefreshRate();
    showToast('Refresh rate updated!');
};

window.clearSystemCache = function() {
    localStorage.clear();
    showToast('Resetting system settings...');
    setTimeout(() => { window.location.reload(); }, 1000);
};

// One-time repair for the selected project if it still has a pre-stable-storage launcher.
// New launchers follow install.json and need no rewrite when the app folder moves.
window.repairProjectLinks = openProjectRepair;
