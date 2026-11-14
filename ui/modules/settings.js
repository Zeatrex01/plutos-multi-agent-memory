// Settings page: storage paths, the project-links repair, and the one fixed refresh of the open
// page. Language and light/dark are switched by i18n.js and the shell.
import { fetchBoard } from './board.js';
import { t } from '../i18n.js';
import { openProjectRepair } from './repair.js';
import { fetchOverview } from './overview.js';

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
            status.classList.remove('is-error'); status.classList.add('is-ok');
        }
    } catch (e) {
        if (status) {
            status.textContent = e.message;
            status.classList.remove('is-ok'); status.classList.add('is-error');
        }
    }
}

// One fixed refresh of the open page, Home or Board. The rate used to be a setting with four
// choices and "manual"; nobody needs to tune it, and a hidden tab is not polled at all.
// Board refreshes every tick. Home's status builds the whole report (boards, continuity, git), so
// it refreshes every HOME_EVERY ticks (30 s); the questions on Home poll on their own in approvals.js.
const REFRESH_MS = 5000;
const HOME_EVERY = 6;
let refreshTimer = null;
let ticks = 0;

export function initRefreshRate() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
        if (document.hidden) return;
        ticks++;
        if (ticks % HOME_EVERY === 0 && document.getElementById('view-overview')?.classList.contains('active')) fetchOverview();
        if (document.getElementById('view-board')?.classList.contains('active')) fetchBoard();
    }, REFRESH_MS);
}

// One-time repair for the selected project if it still has a pre-stable-storage launcher.
// New launchers follow install.json and need no rewrite when the app folder moves.
window.repairProjectLinks = openProjectRepair;
