// The page frame's moving parts, shared by every view ("the panels do not
// explain themselves"). Each page opens with the same head in dashboard-ui.html (.page-head: title,
// one line on what the page is for, its actions) and a "How this page works" fold; anything empty
// says why and what fills it, through emptyState() below. A next step the owner takes through their
// AI is a sentence they can copy (askLine), not a command line; a terminal command, when there is
// one, is folded away (commandLine), because most owners never need it.
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

// "How this page works" is open the first time a page is seen on a computer (closed on a phone) and
// stays the way the owner leaves it.
const HELP_KEY = 'plutos-help-closed';
function closedHelp() {
    try { return new Set(JSON.parse(localStorage.getItem(HELP_KEY) || '[]')); } catch { return new Set(); }
}

export function initPageHelp() {
    const closed = closedHelp();
    // On a phone the open fold would fill the first screen, so there it starts closed: one tap opens it.
    const phone = window.matchMedia?.('(max-width: 640px)').matches;
    document.querySelectorAll('details.page-help[data-help]').forEach(fold => {
        // A page whose own content already guides the first step starts with the fold closed.
        const startsClosed = fold.dataset.helpDefault === 'closed';
        fold.open = !phone && !startsClosed && !closed.has(fold.dataset.help);
        fold.addEventListener('toggle', () => {
            const now = closedHelp();
            if (fold.open) now.delete(fold.dataset.help); else now.add(fold.dataset.help);
            try { localStorage.setItem(HELP_KEY, JSON.stringify([...now])); } catch { /* storage blocked: it opens again next time */ }
        });
    });
}
