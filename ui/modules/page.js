// Shared page helpers: copy-to-clipboard for [data-copy] buttons, and the empty state every page
// uses (what is missing, why, and at most one way forward).
import { t } from '../i18n.js';
import { escHtml } from '../esc.js';
import { showToast } from './toast.js';

// navigator.clipboard needs a secure context: 127.0.0.1 is one, the phone's LAN address is not.
export async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch { ok = false; }
        area.remove();
        return ok;
    }
}

document.addEventListener('click', async event => {
    const button = event.target.closest('[data-copy]');
    if (!button) return;
    const text = button.dataset.copy;
    if (await copyText(text)) showToast(t('page_copied'), 'success');
    else showToast(text, 'info');
});

export function askLine(sentence) {
    return `<div class="tell-line"><span class="tell-label">${t('page_ask_label')}</span>
        <q class="tell-text">${escHtml(sentence)}</q>
        <button type="button" class="btn-secondary btn-sm" data-copy="${escHtml(sentence)}">${t('page_copy')}</button></div>`;
}

export function commandLine(command) {
    return `<details class="cmd-line"><summary>${t('page_terminal')}</summary>
        <div class="cmd-row"><code translate="no">${escHtml(command)}</code>
        <button type="button" class="btn-secondary btn-sm" data-copy="${escHtml(command)}">${t('page_copy')}</button></div></details>`;
}

// title: what is missing; text: why, in a sentence; then at most one way forward: a button
// (action: { label, onclick }), a sentence for the AI (ask) and, folded, a command.
export function emptyState({ icon = 'inbox', title, text = '', action = null, ask = '', command = '' }) {
    return `<div class="empty-state">
        <i data-lucide="${escHtml(icon)}" aria-hidden="true"></i>
        <div class="empty-body">
            <p class="empty-title">${escHtml(title)}</p>
            ${text ? `<p class="empty-text">${escHtml(text)}</p>` : ''}
            ${action ? `<button type="button" class="btn-primary" onclick="${escHtml(action.onclick)}">${escHtml(action.label)}</button>` : ''}
            ${ask ? askLine(ask) : ''}
            ${command ? commandLine(command) : ''}
        </div>
    </div>`;
}
