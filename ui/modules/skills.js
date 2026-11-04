// Skills page: the Agent Skills the open project's AI tools read (one row per skill folder, with
// the folders it sits in and the pack that placed it), and the registered packs, switched on or off
// per project. The pack's own measurement line is shown as it is; the core invents no score.
import { t } from '../i18n.js';
import { showToast } from './toast.js';
import { escHtml, jsArg } from '../esc.js';
import { emptyState } from './page.js';

const EXAMPLE_PATH = '.agents/skills/<name>/SKILL.md';

export async function fetchSkills() {
    const container = document.getElementById('skills-container');
    if (!container) return;
    try {
        // With no project open /api/skills answers the empty payload; the registry still shows.
        const data = await fetch('/api/skills').then(r => r.json());
        const registry = data.needsProject ? await fetch('/api/packs').then(r => r.json()) : data;
        render(container, data, registry);
        lucide.createIcons();
    } catch (e) {
        container.innerHTML = `<p class="page-status">${t('conn_error')}</p>`;
    }
}

function measuredLine(skill) {
    if (!skill.measured) return `<span class="page-status">${t('skills_not_measured')}</span>`;
    const m = skill.measured;
    const line = t('skills_measured').replace('{date}', m.date || '').replace('{summary}', m.summary || '');
    return `${escHtml(line)}${m.record ? ` <span class="page-status">(${escHtml(m.record)})</span>` : ''}`;
}

function renderSkills(data, packsById) {
    const skills = data.skills || [];
    let body;
    if (data.needsProject) {
        body = emptyState({ icon: 'folder', title: t('skills_no_project') });
    } else if (!skills.length) {
        body = emptyState({ icon: 'sparkles', title: t('skills_empty_title'), text: t('skills_empty_text').replace('{path}', EXAMPLE_PATH) });
    } else {
        const rows = skills.map(s => {
            const source = s.source === 'project' ? t('skills_source_project') : (packsById[s.source]?.name || s.source);
            return `<tr>
                <td><b>${escHtml(s.name)}</b><br><span class="page-status">${escHtml(s.folders.join(', '))}</span></td>
                <td>${escHtml(s.description)}</td>
                <td>${s.clients.map(c => `<span class="pill pill-quiet">${escHtml(c)}</span>`).join(' ')}</td>
                <td>${escHtml(source)}</td>
                <td>${measuredLine(s)}</td>
            </tr>`;
        }).join('');
        body = `<table class="data-table"><thead><tr>
            <th>${t('skills_col_name')}</th><th>${t('skills_col_description')}</th><th>${t('skills_col_clients')}</th><th>${t('skills_col_source')}</th><th>${t('skills_col_measured')}</th>
        </tr></thead><tbody>${rows}</tbody></table>`;
    }
    const homes = (data.homes || []).map(h => `<span class="pill pill-quiet">${escHtml(h.folder)} · ${escHtml(h.clients.join(', '))}</span>`).join(' ');
    const notes = (data.notes || []).map(n => `<p class="page-status">${escHtml(n)}</p>`).join('');
    return `<section class="card">
        <div class="card-head"><h3 class="card-title"><i data-lucide="sparkles"></i> ${t('skills_card_project')}</h3>
            <button class="btn-secondary btn-sm" style="margin-left:auto;" onclick="fetchSkillsPage()"><i data-lucide="refresh-cw"></i> ${t('skills_refresh')}</button>
        </div>
        ${homes ? `<p class="card-sub">${t('skills_homes_line')} ${homes}</p>` : ''}
        ${body}${notes}
    </section>`;
}

function renderPacks(data, registry) {
    const packs = registry.packs || [];
    const canSwitch = !data.needsProject && data.installed !== false;
    const list = packs.length ? packs.map(p => `<div class="field-row" style="padding:0.5rem 0; border-bottom:1px solid var(--border-subtle);">
            <div style="flex:1 1 16rem; min-width:0;">
                <b>${escHtml(p.name)}</b> <span class="page-status">${escHtml(p.id)}</span>
                ${p.active ? `<span class="pill pill-done">${t('skills_pack_active')}</span>` : `<span class="pill pill-quiet">${t('skills_pack_inactive')}</span>`}
                ${p.present ? '' : `<span class="pill pill-blocked">${t('skills_pack_missing')}</span>`}
                <br><span class="page-status">${escHtml(p.description || '')} ${t('skills_pack_skills').replace('{n}', String(p.skills.length))}: ${escHtml(p.skills.join(', '))}</span>
                <br><span class="page-status" translate="no">${escHtml(p.path)}</span>
            </div>
            <button class="btn-${p.active ? 'secondary' : 'primary'} btn-sm" ${canSwitch ? '' : 'disabled'} onclick="toggleSkillPack(${escHtml(jsArg(p.id))}, ${p.active ? 'false' : 'true'})">${p.active ? t('skills_pack_off') : t('skills_pack_on')}</button>
            <button class="btn-secondary btn-sm" onclick="forgetSkillPack(${escHtml(jsArg(p.id))})">${t('skills_pack_forget')}</button>
        </div>`).join('')
        : emptyState({ icon: 'package', title: t('skills_packs_empty_title'), text: t('skills_packs_empty_text') });
    return `<section class="card">
        <div class="card-head"><h3 class="card-title"><i data-lucide="package"></i> ${t('skills_card_packs')}</h3></div>
        ${list}
        <div class="field" style="margin-top:0.9rem;">
            <label class="field-label" for="pack-folder-input">${t('skills_add_label')}</label>
            <div class="field-row">
                <input id="pack-folder-input" class="field-input" type="text" placeholder="${escHtml(t('skills_add_placeholder'))}" onkeydown="if(event.key==='Enter') addSkillPack()">
                <button class="btn-primary" onclick="addSkillPack()"><i data-lucide="folder-plus"></i> ${t('skills_add_button')}</button>
            </div>
            <span class="field-hint">${t('skills_add_hint')}</span>
        </div>
    </section>`;
}

function render(container, data, registry) {
    const packsById = Object.fromEntries((registry.packs || []).map(p => [p.id, p]));
    container.innerHTML = renderSkills(data, packsById) + renderPacks(data, registry);
}

async function post(url, body) {
    try {
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const result = await res.json();
        showToast(result.message || (result.success ? t('skills_done') : t('error')), !result.success);
        return result.success;
    } catch (e) {
        showToast(t('conn_error'), true);
        return false;
    }
}

window.fetchSkillsPage = fetchSkills;

window.addSkillPack = async function() {
    const input = document.getElementById('pack-folder-input');
    const folder = (input?.value || '').trim();
    if (!folder) { showToast(t('skills_add_empty'), 'warning'); return; }
    if (await post('/api/packs/add', { path: folder })) { if (input) input.value = ''; await fetchSkills(); }
};

window.toggleSkillPack = async function(id, on) {
    if (await post(on ? '/api/packs/on' : '/api/packs/off', { id })) await fetchSkills();
};

window.forgetSkillPack = async function(id) {
    if (await post('/api/packs/forget', { id })) await fetchSkills();
};
