// Development mode marker (lib/run-mode.mjs). A copy of PLUT_OS working on itself must never be
// mistaken for the one the owner uses, so it says so on every screen and in the tab title.
import { t } from '../i18n.js';

export async function showRunMode() {
    let mode = null;
    try { mode = await (await fetch('/api/app/mode')).json(); } catch (e) { return; }
    if (!mode?.devMode) return;
    document.documentElement.dataset.mode = 'dev';
    if (!document.title.startsWith('[DEV]')) document.title = `[DEV] ${document.title}`;
    if (document.querySelector('.dev-mode-bar')) return;
    const bar = document.createElement('div');
    bar.className = 'dev-mode-bar';
    bar.setAttribute('role', 'status');
    bar.dataset.i18n = 'dev_mode_banner';
    bar.textContent = t('dev_mode_banner');
    bar.title = mode.dataHome || '';
    document.body.prepend(bar);
}
