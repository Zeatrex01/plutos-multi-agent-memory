// A recorded outcome and reference, independent of workflow status. Evidence is not
// executed or interpreted here; the owner can open it and judge the stated result.
import { t } from '../i18n.js';
import { escHtml } from '../esc.js';
import { showToast } from './toast.js';

const STATES = ['unverified', 'passed', 'failed'];
const COLORS = { unverified: 'var(--text-muted)', passed: 'var(--status-done)', failed: 'var(--status-error)' };
const stateOf = entry => STATES.includes(entry.verification) && (entry.verification !== 'passed' || entry.evidence)
    ? entry.verification : 'unverified';

// On a card, the check is news only for finished work or once someone recorded one: "not checked
// yet" on every open task was noise the owner learned to skip (Job 18).
export function verificationBadge(entry, board, projectRoot) {
    const state = stateOf(entry);
    if (state === 'unverified' && entry.status !== 'DONE') return '';
    let href = '';
    if (/^https?:\/\//i.test(entry.evidence || '')) {
        try { href = new URL(entry.evidence).href; } catch { /* malformed legacy reference */ }
    } else if (entry.evidence && projectRoot) {
        href = '/api/board/evidence?' + new URLSearchParams({ project: projectRoot, board, agent: entry.agent, title: entry.title });
    }
    return `<span style="font-size:0.68rem;color:${COLORS[state]};">${escHtml(t('verification_label'))}: ${escHtml(t('verification_' + state))}</span>
        ${href ? `<a href="${escHtml(href)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" style="font-size:0.68rem;">${escHtml(t('verification_open'))}</a>` : ''}`;
}

export function verificationForm(entry, board, projectRoot) {
    if (!projectRoot) return '';
    const id = 'verification-' + encodeURIComponent([board, entry.agent, entry.title].join('::'));
    return `<form onsubmit="recordTaskVerification(event, this)" onclick="event.stopPropagation()"
        data-project-root="${escHtml(projectRoot)}" data-board="${escHtml(board)}" data-agent="${escHtml(entry.agent)}"
        data-status="${escHtml(entry.status)}" data-title="${escHtml(entry.title)}" data-revision="${escHtml(entry.revision || '')}" style="margin-top:0.8rem;display:grid;gap:0.4rem;">
        <label class="field-label" for="${escHtml(id)}">${escHtml(t('verification_label'))}</label>
        <select id="${escHtml(id)}" name="verification" class="field-select field-sm">
            ${STATES.map(state => `<option value="${state}"${state === stateOf(entry) ? ' selected' : ''}>${escHtml(t('verification_' + state))}</option>`).join('')}
        </select>
        <label class="field-label" for="${escHtml(id + '-evidence')}">${escHtml(t('verification_evidence'))}</label>
        <input id="${escHtml(id + '-evidence')}" name="evidence" value="${escHtml(entry.evidence || '')}" maxlength="2000"
            placeholder="${escHtml(t('verification_evidence_hint'))}" class="field-input field-sm">
        <small class="field-hint">${escHtml(t('verification_recorded_note'))}</small>
        <button type="submit" class="btn-primary btn-sm" style="justify-self:start;">${escHtml(t('verification_record'))}</button>
    </form>`;
}

window.recordTaskVerification = async function(event, form) {
    event.preventDefault();
    event.stopPropagation();
    const verification = form.elements.namedItem('verification').value;
    const evidence = form.elements.namedItem('evidence').value.trim();
    if (verification === 'passed' && !evidence) { showToast(t('verification_need_evidence'), true); return; }
    const { projectRoot, board, agent, status, title, revision: expectedRevision } = form.dataset;
    const button = form.querySelector('button[type="submit"]');
    if (button) button.disabled = true;
    try {
        const response = await fetch('/api/board', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectRoot, board, agent, status, title, verification, evidence, expectedRevision })
        });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.message || t('error'));
        showToast(t('verification_saved'));
        document.dispatchEvent(new CustomEvent('plutos-board-updated'));
    } catch (error) { showToast(error.message || t('conn_error'), true); }
    finally { if (button) button.disabled = false; }
};
