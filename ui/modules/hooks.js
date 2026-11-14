// Hooks section — every hook PLUT_OS can put on this project, in one plain section of the Board page.
//
// The session brief, the guard, the push gate, the claim check and the session close are switched
// here (lib/project-hooks.mjs).
// The watcher and the shared-context capture keep the switches they already had — a second
// switch for the same thing is how two places disagree — so this section only shows their state.
import { t } from '../i18n.js';
import { escHtml, jsArg } from '../esc.js';
import { showToast } from './toast.js';

const OWN = [
    { id: 'brief', name: 'hooks_brief', desc: 'hooks_brief_desc' },
    { id: 'guard', name: 'hooks_guard', desc: 'hooks_guard_desc' },
    { id: 'push-gate', name: 'hooks_push_gate', desc: 'hooks_push_gate_desc' },
    { id: 'claim-check', name: 'hooks_claim_check', desc: 'hooks_claim_check_desc' },
    { id: 'session-close', name: 'hooks_session_close', desc: 'hooks_session_close_desc' },
    { id: 'subagent', name: 'hooks_subagent', desc: 'hooks_subagent_desc' },
];

// On or off, in words; the class only tints the word (is-on / is-off), it carries no meaning alone.
const state = on => `<b class="hook-state ${on ? 'is-on' : 'is-off'}">${t(on ? 'hooks_on' : 'hooks_off')}</b>`;

export async function fetchHooks() {
    const box = document.getElementById('hooks-container');
    if (!box) return;
    try {
        const d = await (await fetch('/api/hooks')).json();
        const byId = Object.fromEntries((d.hooks || []).map(h => [h.id, h]));
        const own = OWN.map(h => {
            const s = byId[h.id] || {};
            const action = s.needsUpgrade ? 'hooks_update' : (s.on ? 'hooks_turn_off' : 'hooks_turn_on');
            const next = s.needsUpgrade ? true : !s.on;
            return `
            <div class="watch-row hook-row">
                <div class="watch-seats">
                    <span class="watch-seat"><b>${t(h.name)}</b> ${state(s.on)}</span>
                    <p class="watch-note">${t(h.desc)}</p>
                    ${h.id === 'push-gate' && s.on && s.gitHook != null ? `<p class="watch-note">${t(s.gitHook ? 'hooks_git_on' : 'hooks_git_off')}</p>` : ''}
                    ${s.problem ? `<p class="watch-state is-error">${escHtml(s.problem)}</p>` : ''}
                </div>
                <div class="watch-actions">
                    <button class="btn-secondary btn-sm${s.on && !s.needsUpgrade ? ' btn-danger' : ''}"
                        onclick="setHook(${jsArg(h.id)}, ${next})">${t(action)}</button>
                </div>
            </div>`;
        }).join('');
        box.innerHTML = `
            <p class="watch-note">${t('hooks_desc')}</p>
            ${own}
            <p class="watch-state">${t('hooks_codex')}: ${state(d.codex && d.codex.on)} — ${t('hooks_codex_note')}<br>
                ${t('hooks_watcher')}: ${state(d.watcher)} — ${t('hooks_elsewhere_watcher')}<br>
                ${t('hooks_context')}: ${state(d.context)} — ${t('hooks_elsewhere_context')}</p>
            ${d.error ? `<p class="watch-state is-error">${escHtml(d.error)}</p>` : ''}`;
    } catch (e) {
        box.innerHTML = `<p class="page-status">${t('conn_error')}</p>`;
    }
}

window.setHook = async (id, enabled) => {
    try {
        const res = await fetch('/api/hooks', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, enabled })
        });
        const d = await res.json();
        showToast(d.message, d.success ? 'success' : 'error');
        await fetchHooks();
    } catch (e) { showToast(t('conn_error'), 'error'); }
};
window.fetchHooks = fetchHooks;
