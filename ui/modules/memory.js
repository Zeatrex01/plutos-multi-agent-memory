// What the AIs have recorded as known, with how far each claim can be trusted (shown on Report).
// It used to live on a separate Agent Signals page (Job 18); the "where I left off" card that sat
// beside it left with the Activity page on 2026-11-04 (Home has its own).
import { t } from '../i18n.js';
import { escHtml } from '../esc.js';

const group = (title, color, items, open = false) => items.length ? `
    <details class="memory-group"${open ? ' open' : ''}>
        <summary style="color:${color};">${escHtml(title)} (${items.length})</summary>
        <ul class="known-list">${items.map(item => `<li style="border-left-color:${color};">
            <div>${escHtml(item.claim)}</div>
            ${item.detail ? `<div class="known-detail">${escHtml(item.detail)}</div>` : ''}
        </li>`).join('')}</ul>
    </details>` : '';

// Decisions, claims checked against a source, claims set aside because their source changed, and
// claims nobody checked: the last group is listed so it is not mistaken for knowledge.
export async function fetchSessionMemory(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    try {
        const contRes = await fetch('/api/continuity').then(r => r.json());
        const ctx = contRes?.context || {};
        // The digest is the list; a line's trailing record id (d-…) looks its status up in the registry.
        const byId = new Map(['reversed', 'verified', 'valid'].flatMap(status => (ctx.decisions?.[status] || []).map(item => [item.id, status])));
        const decisions = (contRes?.digest || []).filter(item => /^DECISION:/i.test(item)).map(item => {
            const id = (item.match(/\((d-[0-9a-f]{12})\)\s*$/) || [])[1];
            const status = id && byId.get(id);
            return { claim: item.replace(/^DECISION:\s*/i, '').replace(/\s*\(d-[0-9a-f]{12}\)\s*$/, ''),
                detail: status ? `${t('memory_type_decision')} · ${t(`memory_status_${status}`)}` : '' };
        });
        const legacy = (contRes?.digest || []).filter(item => !/^DECISION:/i.test(item))
            .map(claim => ({ claim, detail: t('memory_legacy_note') }));
        const current = (ctx.current || []).map(item => ({ claim: item.claim, detail: (item.sources || []).map(source => source.path).join(', ') }));
        const stale = (ctx.stale || []).map(item => ({ claim: item.claim, detail: (item.reasons || []).join('; ') }));
        const unverified = [...(ctx.unverified || []).map(item => ({ claim: item.claim, detail: (item.reasons || []).join('; ') })), ...legacy];
        const body = group(t('continuity_digest'), 'var(--brand-primary)', decisions, true)
            + group(t('continuity_current'), 'var(--status-done)', current)
            + group(t('continuity_stale'), 'var(--status-error)', stale)
            + group(t('continuity_unverified'), 'var(--text-muted)', unverified)
            + (ctx.error ? `<p class="page-status" style="color:var(--status-error);">${escHtml(ctx.error)}</p>` : '');
        container.innerHTML = `<section class="card">
            <div class="card-head"><h3 class="card-title"><i data-lucide="brain"></i> ${t('continuity_title')}</h3></div>
            ${body || `<p class="page-status">${t('memory_empty')}</p>`}
        </section>`;
        lucide.createIcons();
    } catch (e) {
        container.innerHTML = '';
    }
}
