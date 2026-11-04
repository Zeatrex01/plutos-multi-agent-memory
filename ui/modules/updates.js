// Settings → Updates and Settings → Install as an app.
//
// Updates: opening Settings shows the last check the server remembers (GET /api/update, no
// network). Only "Check for updates" checks (GET /api/update?check=1): a git copy against its
// branch, the portable app against the newest release. "Update now" appears for a git checkout that
// is behind and POSTs the check's token; the result says to restart PLUT_OS, and the page is never
// reloaded for the owner.
//
// The app: the service worker (ui/sw.js) is registered on localhost only, in the top window (the
// browser client frames this page), and a failure is silent. Chrome and Edge offer their install
// prompt through `beforeinstallprompt`, kept here for the Install button; other browsers never fire
// it, so the card says where their own Install option is.
import { t } from '../i18n.js';

let lastUpdate = null;
let installPrompt = null;
let installed = false;

const el = id => document.getElementById(id);
const show = (node, visible) => { if (node) node.style.display = visible ? '' : 'none'; };

export function initAppShell() {
    try {
        if (window.top === window && 'serviceWorker' in navigator && ['localhost', '127.0.0.1'].includes(location.hostname)) {
            navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
        }
    } catch { /* a blocked registration only means no offline page */ }
    window.addEventListener('beforeinstallprompt', event => {
        event.preventDefault();
        installPrompt = event;
        renderInstall();
    });
    window.addEventListener('appinstalled', () => {
        installPrompt = null;
        installed = true;
        renderInstall();
    });
}

function renderInstall() {
    const status = el('app-install-status');
    if (!status) return;
    const standalone = window.matchMedia?.('(display-mode: standalone)').matches;
    show(el('app-install'), !!installPrompt && !standalone && !installed);
    status.textContent = standalone ? t('app_standalone') : installed ? t('app_installed') : installPrompt ? '' : t('app_hint');
    show(status, !!status.textContent);
}

window.installApp = async function () {
    if (!installPrompt) return renderInstall();
    const prompt = installPrompt;
    installPrompt = null;
    try {
        await prompt.prompt();
        const choice = await prompt.userChoice;
        if (choice?.outcome === 'accepted') installed = true;
    } catch { /* the browser refused to show it again */ }
    renderInstall();
};

function statusLine(u) {
    if (!u || u.state === 'unchecked') return t('updates_unchecked');
    if (u.kind === 'packaged') {
        if (u.state === 'available') return t('updates_available').replace('{v}', u.latest).replace('{c}', u.current);
        if (u.state === 'current') return t('updates_release_current').replace('{c}', u.current);
        if (u.state === 'none') return t('updates_none');
    }
    if (u.state === 'error') return t('updates_error').replace('{reason}', (u.message || '').replace(/^Could not check for updates: /, ''));
    if (u.state === 'behind') return t('updates_behind').replace('{n}', String(u.behind));
    if (u.state === 'ahead') return t('updates_ahead').replace('{n}', String(u.ahead));
    if (u.state === 'up-to-date' && u.kind === 'checkout') return t('updates_current');
    // A submodule or a refused check: the server's own words say what to do.
    return u.message || t('updates_unchecked');
}

function renderUpdate(u, { busy = false } = {}) {
    lastUpdate = u;
    const status = el('update-status');
    if (!status) return;
    status.textContent = statusLine(u);
    const ok = ['up-to-date', 'current', 'behind', 'available', 'ahead'].includes(u?.state);
    status.style.color = u?.state === 'error' ? 'var(--status-blocked)' : ok ? 'var(--status-done)' : '';
    const detail = el('update-detail');
    // A submodule's pointer and anything refused are in the message; a plain state needs nothing more.
    const showDetail = u && u.kind !== 'packaged' && (u.kind === 'submodule' || u.state === 'refused') && u.message && statusLine(u) !== u.message;
    if (detail) { detail.textContent = showDetail ? u.message : ''; show(detail, !!showDetail); }
    const when = el('update-checked-at');
    if (when) {
        when.textContent = u?.checkedAt ? t('updates_checked_at').replace('{time}', new Date(u.checkedAt).toLocaleString()) : '';
        show(when, !!u?.checkedAt);
    }
    const download = el('update-download');
    if (download) {
        const href = u?.kind === 'packaged' && u.state === 'available' && /^https:\/\/github\.com\//.test(u.url || '') ? u.url : '';
        if (href) download.href = href;
        show(download, !!href);
    }
    show(el('update-now'), !busy && u?.kind === 'checkout' && u.state === 'behind' && !!u.token);
    const check = el('update-check');
    if (check) check.disabled = busy;
}

/** Settings opened: the last check the server remembers, without checking again. */
export async function showUpdateStatus() {
    renderInstall();
    try {
        const res = await fetch('/api/update');
        renderUpdate(await res.json());
    } catch {
        renderUpdate(lastUpdate || { state: 'unchecked' });
    }
}

window.checkForUpdates = async function () {
    const status = el('update-status');
    renderUpdate(lastUpdate || { state: 'unchecked' }, { busy: true });
    if (status) { status.textContent = t('updates_checking'); status.style.color = ''; }
    try {
        const res = await fetch('/api/update?check=1');
        renderUpdate(await res.json());
    } catch (e) {
        renderUpdate({ state: 'error', message: e.message });
    }
};

window.applyUpdate = async function () {
    if (!lastUpdate?.token) return;
    const status = el('update-status');
    renderUpdate(lastUpdate, { busy: true });
    show(el('update-now'), false);
    if (status) { status.textContent = t('updates_running'); status.style.color = ''; }
    let r;
    try {
        const res = await fetch('/api/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: lastUpdate.token }) });
        r = await res.json();
    } catch (e) {
        r = { state: 'error', message: e.message };
    }
    renderUpdate({ kind: r.kind || 'checkout', state: r.state === 'updated' ? 'updated' : r.state, message: r.message });
    if (status) {
        status.textContent = r.state === 'updated' ? t('updates_done') : r.success ? (r.message || '').split('\n')[0] : `${t('updates_refused')} ${(r.message || '').split('\n')[0]}`;
        status.style.color = r.success ? 'var(--status-done)' : 'var(--status-blocked)';
    }
    // What happened and how to restart: the first two lines. The rest (leftover files, --clean) is
    // the terminal's business.
    const detail = el('update-detail');
    if (detail && r.message) { detail.textContent = r.message.split('\n').slice(0, 2).join('\n'); show(detail, true); }
};
