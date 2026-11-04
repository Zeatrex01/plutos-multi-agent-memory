// Watcher panel — the "wire every seat at once" button, on the Board tab where the work is.
//
// The owner's complaint: opening PLUT_OS and then setting up each AI's watcher by hand, every
// time, for three different tools. Tick the seats, press once.
//
// The panel shows the split honestly rather than pretending it is uniform: PLUT_OS wires the
// Claude Code seat itself, and for every other tool it writes a board task for the main AI —
// because it does not know their hook formats and will not guess one into somebody's config.
import { t } from '../i18n.js';
import { escHtml } from '../esc.js';
import { showToast } from './toast.js';

let seats = [];

export async function fetchWatcher() {
    const box = document.getElementById('watcher-container');
    if (!box) return;
    try {
        const d = await (await fetch('/api/watcher')).json();
        seats = d.seats || [];
        box.innerHTML = `
            <div class="watch-row">
                <div class="watch-seats">${seats.map(s => `
                    <label class="watch-seat">
                        <input type="checkbox" data-seat="${escHtml(s.id)}" ${s.native ? 'checked' : ''}>
                        <span>${escHtml(s.name)}</span>
                        <em>${t(s.native ? 'watcher_native' : 'watcher_delegated')}</em>
                    </label>`).join('')}
                </div>
                <div class="watch-actions">
                    <button class="btn-primary btn-sm" onclick="installWatchers()">${t(d.needsUpgrade ? 'watcher_upgrade' : 'watcher_install')}</button>
                    ${d.installed || d.needsUpgrade ? `<button class="btn-secondary btn-sm btn-danger" onclick="removeWatchers()">${t('watcher_remove')}</button>` : ''}
                </div>
            </div>
            <p class="watch-state">${d.installed
                ? `<b style="color:var(--status-done);">${t('watcher_on')}</b> ${escHtml(d.scriptPath || '')}`
                : t(d.needsUpgrade ? 'watcher_upgrade_needed' : 'watcher_off')}</p>
            ${d.error ? `<p class="watch-state" style="color:var(--status-error);">${escHtml(d.error)}</p>` : ''}
            <p class="watch-note">${t('watcher_hint')}</p>`;
    } catch (e) {
        box.innerHTML = `<p class="page-status">${t('conn_error')}</p>`;
    }
}

const ticked = () => [...document.querySelectorAll('#watcher-container input[data-seat]:checked')]
    .map(el => el.getAttribute('data-seat'));

async function post(body) {
    try {
        const res = await fetch('/api/watcher', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        const d = await res.json();
        showToast(d.message, !d.success ? 'error' : d.warning ? 'warning' : 'success');
        await fetchWatcher();
    } catch (e) { showToast(t('conn_error'), 'error'); }
}

window.installWatchers = () => {
    const picked = ticked();
    if (!picked.length) { showToast(t('watcher_pick_one'), 'warning'); return; }
    post({ seats: picked, enabled: true });
};
// Removal takes the Claude hook and its script out and stops there — a board entry the main
// AI may already have acted on is not ours to retract.
window.removeWatchers = () => post({ seats: [], enabled: false });
window.fetchWatcher = fetchWatcher;

// Copying is the real gesture here — the snapshot exists to be pasted into another AI's window,
// and a download that lands in a folder is one step further from that than it needs to be. The
// download link stays for a snapshot too large to want in a clipboard.
window.copySnapshot = async function() {
    try {
        const res = await fetch('/api/snapshot');
        if (!res.ok) { showToast((await res.json().catch(() => ({}))).message || t('conn_error'), 'error'); return; }
        const text = await res.text();
        await navigator.clipboard.writeText(text);
        showToast(t('snapshot_copied').replace('{kb}', Math.round(text.length / 1024)), 'success');
    } catch (e) {
        // A blocked clipboard is the common failure and the download link is right there.
        showToast(t('snapshot_copy_failed'), 'warning');
    }
};
