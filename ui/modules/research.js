// Research tab: topics on the left, the selected topic's principles, branch tree, sources,
// frozen-source reader and live URL fetcher on the right.
import { t } from '../i18n.js';
import { escHtml as esc, escHref } from '../esc.js';
import { showToast } from './toast.js';
import { emptyState } from './page.js';

let selected = null;
let activeTab = 'branches';
let searchQuery = '';
let lastBrief = '';
let lastData = null;
let showNewTopicForm = false;
let openSourceReader = null;
let missingRuntimePrompt = '';

async function get(url) {
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok || data.success === false) throw new Error(data.message || `HTTP ${res.status}`);
    return data;
}

async function post(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
    });
    const data = await res.json();
    if (!res.ok || data.success === false) throw new Error(data.message || `HTTP ${res.status}`);
    return data;
}

const statusLabel = status => t(`research_status_${status}`);
const day = ms => new Date(ms).toLocaleDateString();
const fmtChars = n => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n || 0}`;

function matchesSearch(text) {
    if (!searchQuery) return true;
    return String(text || '').toLowerCase().includes(searchQuery.toLowerCase());
}

function renderTopics(topics) {
    const host = document.getElementById('research-topics');
    host.closest('.research-layout')?.classList.toggle('is-empty', !topics.length && !showNewTopicForm);
    if (!topics.length && !showNewTopicForm) {
        host.innerHTML = emptyState({
            icon: 'telescope',
            title: t('research_empty_title'),
            text: t('research_empty_text'),
            ask: t('research_empty_ask')
        });
        window.lucide?.createIcons();
        return;
    }
    host.innerHTML = topics.map(topic => `<button type="button" class="research-topic${topic.id === selected ? ' is-active' : ''}" data-topic="${esc(topic.id)}">
        <b>${esc(topic.title)}</b>
        <span>${topic.sources} ${t('research_pages')} · ${topic.findings} ${t('research_findings')}${topic.open ? ` · ${topic.open} ${t('research_status_open').toLowerCase()}` : ''}</span>
    </button>`).join('');
}

function renderNewTopicCard() {
    if (!showNewTopicForm) return '';
    return `<div class="card card-accent">
        <div class="card-head"><h3 class="card-title">${esc(t('research_new_topic'))}</h3></div>
        <div class="research-form-grid">
            <input type="text" class="field-input" id="res-new-title" placeholder="${esc(t('research_title_placeholder'))}" maxlength="120">
            <input type="text" class="field-input" id="res-new-question" placeholder="${esc(t('research_question_placeholder'))}" maxlength="500">
            <input type="text" class="field-input" id="res-new-goal" placeholder="${esc(t('research_goal_placeholder'))}" maxlength="500">
            <div class="research-form-actions">
                <label class="field-inline">${esc(t('research_page_budget'))}: <input type="number" class="field-input field-sm" id="res-new-pages" value="30" min="1" max="120"></label>
                <button type="button" class="btn-primary" data-research-create-submit>${esc(t('research_create'))}</button>
                <button type="button" class="btn-secondary" data-research-new-cancel>${esc(t('research_cancel'))}</button>
            </div>
        </div>
    </div>`;
}

function renderSourceReader() {
    if (!openSourceReader) return '';
    const { source, text, offset, nextOffset, total } = openSourceReader;
    return `<div class="card card-accent research-source-reader">
        <div class="research-reader-head">
            <div>
                <b>${esc(source.title || source.url)}</b>
                <span class="page-status"> · <a href="${escHref(source.url)}" target="_blank" rel="noopener noreferrer">${esc(source.url)}</a> (${fmtChars(total)})</span>
            </div>
            <div class="research-detail-actions">
                ${offset > 0 ? `<button type="button" class="btn-secondary btn-sm" data-source-page="${Math.max(0, offset - 30000)}" data-source-id="${esc(source.id)}">${esc(t('research_prev_page'))}</button>` : ''}
                ${nextOffset ? `<button type="button" class="btn-secondary btn-sm" data-source-page="${nextOffset}" data-source-id="${esc(source.id)}">${esc(t('research_next_page'))}</button>` : ''}
                <button type="button" class="btn-secondary btn-sm" data-source-close>${esc(t('research_close_source'))}</button>
            </div>
        </div>
        <pre class="research-reader-body">${esc(text)}</pre>
    </div>`;
}

function renderDetail(payload) {
    lastData = payload;
    const { topic, status, brief } = payload;
    lastBrief = brief;
    const sourceNo = id => topic.sources.findIndex(s => s.id === id) + 1;
    const cites = ids => ids.map(sourceNo).filter(n => n > 0).map(n => `<sup>[${n}]</sup>`).join('');
    const principleCites = p => cites([...new Set(p.findingIds.flatMap(id => topic.findings.find(f => f.id === id)?.sourceIds || []))]);

    const principlesHtml = [['do', 'research_do'], ['avoid', 'research_avoid'], ['note', 'research_notes']].map(([kind, label]) => {
        const items = topic.principles.filter(p => p.kind === kind && matchesSearch(p.statement));
        return `<div class="card research-principles-card research-${kind}">
            <div class="card-head"><h3 class="card-title">${esc(t(label))} (${items.length})</h3></div>
            ${items.length ? `<ul>${items.map(p => `<li>${esc(p.statement)} ${principleCites(p)}</li>`).join('')}</ul>` : `<p class="page-status">—</p>`}
        </div>`;
    }).join('');

    const renderBranch = b => {
        const branchFindings = topic.findings.filter(f => f.branchId === b.id && (matchesSearch(f.claim) || f.quotes.some(q => matchesSearch(q.text))));
        const children = topic.branches.filter(c => c.parentId === b.id);
        if (searchQuery && !matchesSearch(b.question) && !branchFindings.length && !children.length) return '';
        return `<li class="panel research-branch is-${b.status}">
            <div class="research-branch-head">
                <div><span class="pill ${b.status === 'answered' ? 'pill-done' : 'pill-quiet'}">${esc(statusLabel(b.status))}</span> <b>${esc(b.question)}</b></div>
            </div>
            ${b.note ? `<p class="page-status">${esc(b.note)}</p>` : ''}
            ${branchFindings.map(f => `<div class="card research-finding">${esc(f.claim)} ${cites(f.sourceIds)}
                ${f.quotes.map(q => `<blockquote>${esc(q.text)} ${cites([q.sourceId])}</blockquote>`).join('')}</div>`).join('')}
            ${children.length ? `<ul>${children.map(renderBranch).join('')}</ul>` : ''}
        </li>`;
    };

    const filteredSources = topic.sources.filter(s => matchesSearch(s.title) || matchesSearch(s.url));
    const sourcesHtml = filteredSources.length ? `<div class="card-grid">${filteredSources.map((s, idx) => {
        let host = s.url;
        try { host = new URL(s.url).host; } catch { /* ignore */ }
        const branchObj = topic.branches.find(b => b.id === s.branchId);
        return `<div class="card research-source-card">
            <div class="research-source-card-top">
                <span class="research-source-index">[${idx + 1}]</span>
                <a href="${escHref(s.url)}" target="_blank" rel="noopener noreferrer"><b>${esc(s.title || s.url)}</b></a>
            </div>
            <div class="page-status">${esc(host)} · ${fmtChars(s.chars)} · ${day(s.fetchedAt)}${branchObj ? ` · ${esc(branchObj.question)}` : ''}</div>
            <div class="research-source-actions">
                <button type="button" class="btn-secondary btn-sm" data-read-source="${esc(s.id)}">${esc(t('research_read_source'))}</button>
            </div>
        </div>`;
    }).join('')}</div>` : `<p class="page-status">—</p>`;

    let tabBody = '';
    if (activeTab === 'branches') {
        const roots = topic.branches.filter(b => !b.parentId);
        tabBody = `
            <div class="panel field-row research-quick-branch">
                <input type="text" class="field-input" id="res-branch-question" placeholder="${esc(t('research_branch_placeholder'))}" maxlength="500">
                <button type="button" class="btn-secondary" data-research-add-branch>${esc(t('research_add_branch'))}</button>
            </div>
            <ul class="research-tree">${roots.map(renderBranch).join('')}</ul>
            ${topic.openQuestions.length ? `<h4 class="research-section">${esc(t('research_open_questions'))}</h4><ul>${topic.openQuestions.map(q => `<li>${esc(q.question)}</li>`).join('')}</ul>` : ''}
        `;
    } else if (activeTab === 'principles') {
        tabBody = `<div class="research-principles-grid">${principlesHtml}</div>`;
    } else if (activeTab === 'sources') {
        tabBody = `${renderSourceReader()}${sourcesHtml}`;
    } else if (activeTab === 'brief') {
        tabBody = `<pre class="research-reader-body">${esc(brief)}</pre>`;
    }

    const totalQuotes = topic.findings.reduce((sum, f) => sum + (f.quotes?.length || 0), 0);

    document.getElementById('research-detail').innerHTML = `
        <div class="research-detail-head">
            <div>
                <h3>${esc(topic.title)}</h3>
                <p>${esc(topic.question)}</p>
                ${topic.goal ? `<p class="page-status">${esc(t('research_goal'))}: ${esc(topic.goal)}</p>` : ''}
            </div>
            <div class="research-detail-actions">
                <span class="pill ${status.ready ? 'pill-done' : 'pill-quiet'}">${status.ready ? esc(t('research_ready')) : esc(t('research_draft'))}</span>
                <button type="button" class="btn-secondary btn-sm" data-research-copy>${esc(t('research_copy'))}</button>
            </div>
        </div>
        <p class="page-status">${status.pagesUsed} / ${topic.budget.pages} ${esc(t('research_pages'))} · ${topic.findings.length} ${esc(t('research_findings'))} · ${totalQuotes} ${esc(t('research_quotes'))}</p>

        <div class="panel field-row research-fetcher-bar">
            <input type="url" class="field-input" id="res-fetch-url" placeholder="${esc(t('research_url_placeholder'))}" />
            <select id="res-fetch-branch" class="field-select">
                <option value="">${esc(t('research_branch_optional'))}</option>
                ${topic.branches.map(b => `<option value="${esc(b.id)}">${esc(b.question)}</option>`).join('')}
            </select>
            <label class="field-inline">
                <input type="checkbox" id="res-fetch-render"> ${esc(t('research_render_js'))}
            </label>
            <button type="button" class="btn-primary" data-research-fetch-btn>${esc(t('research_fetch_btn'))}</button>
        </div>

        ${status.gaps.length ? `<div class="research-gaps"><b>${esc(t('research_gaps'))}</b><ul>${status.gaps.map(g => `<li>${esc(g)}</li>`).join('')}</ul></div>` : ''}

        <div class="research-tabs-bar">
            <div class="seg-bar">
                <button type="button" class="seg${activeTab === 'branches' ? ' active' : ''}" data-res-tab="branches">${esc(t('research_branches'))} <span class="seg-n">${topic.branches.length}</span></button>
                <button type="button" class="seg${activeTab === 'principles' ? ' active' : ''}" data-res-tab="principles">${esc(t('research_principles'))} <span class="seg-n">${topic.principles.length}</span></button>
                <button type="button" class="seg${activeTab === 'sources' ? ' active' : ''}" data-res-tab="sources">${esc(t('research_sources'))} <span class="seg-n">${topic.sources.length}</span></button>
                <button type="button" class="seg${activeTab === 'brief' ? ' active' : ''}" data-res-tab="brief">${esc(t('research_tab_brief'))}</button>
            </div>
            <input type="search" class="field-input field-sm research-search-input" placeholder="${esc(t('research_search_placeholder'))}" value="${esc(searchQuery)}" id="res-search-input">
        </div>

        <div class="research-tab-content">${tabBody}</div>
    `;
}

export async function fetchResearch() {
    const runtime = document.getElementById('research-runtime');
    try {
        const data = await get('/api/research/topics');
        if (data.needsProject) return;
        const reason = data.webFetch.reason || '';
        const installCard = (!data.webFetch.available || missingRuntimePrompt)
            ? `<div class="research-gaps is-row">
                <span>${esc(missingRuntimePrompt || reason)}</span>
                <button type="button" class="btn-primary" data-research-install-runtime>${esc(t('research_install_runtime'))}</button>
            </div>`
            : '';
        const statusBanner = data.webFetch.available
            ? `<p class="page-status">${esc(t('research_fetch_on'))}</p>`
            : `<div class="research-notice">${emptyState({
                icon: 'globe',
                title: t('research_fetch_off_title'),
                text: /Scrapling is not/.test(reason) ? t('research_fetch_missing') : reason,
                command: (reason.match(/pip install .+$/) || [''])[0]
            })}</div>`;
        runtime.innerHTML = `${statusBanner}${installCard}${renderNewTopicCard()}`;
        window.lucide?.createIcons();
        if (!selected && data.topics.length) selected = data.topics[0].id;
        renderTopics(data.topics);
        const detail = document.getElementById('research-detail');
        if (!selected) { detail.innerHTML = ''; return; }
        renderDetail(await get(`/api/research/topic?id=${encodeURIComponent(selected)}`));
    } catch (error) {
        runtime.textContent = error.message;
    }
}

window.refreshResearch = fetchResearch;

document.addEventListener('input', event => {
    if (event.target.id === 'res-search-input') {
        searchQuery = event.target.value;
        if (lastData) renderDetail(lastData);
        const input = document.getElementById('res-search-input');
        if (input) {
            input.focus();
            input.setSelectionRange(searchQuery.length, searchQuery.length);
        }
    }
});

document.addEventListener('click', async event => {
    const topicBtn = event.target.closest('[data-topic]');
    if (topicBtn) {
        selected = topicBtn.dataset.topic;
        openSourceReader = null;
        fetchResearch();
        return;
    }

    const tabBtn = event.target.closest('[data-res-tab]');
    if (tabBtn) {
        activeTab = tabBtn.dataset.resTab;
        if (lastData) renderDetail(lastData);
        return;
    }

    if (event.target.closest('[data-research-new-toggle]')) {
        showNewTopicForm = !showNewTopicForm;
        fetchResearch();
        return;
    }

    if (event.target.closest('[data-research-new-cancel]')) {
        showNewTopicForm = false;
        fetchResearch();
        return;
    }

    if (event.target.closest('[data-research-create-submit]')) {
        const title = document.getElementById('res-new-title')?.value?.trim();
        const question = document.getElementById('res-new-question')?.value?.trim();
        const goal = document.getElementById('res-new-goal')?.value?.trim();
        const pages = Number(document.getElementById('res-new-pages')?.value || 30);
        if (!title || !question) return;
        try {
            const res = await post('/api/research/topic', { title, question, goal, pages });
            showNewTopicForm = false;
            selected = res.topic.id;
            fetchResearch();
        } catch (e) {
            showToast(e.message);
        }
        return;
    }

    if (event.target.closest('[data-research-add-branch]')) {
        const q = document.getElementById('res-branch-question')?.value?.trim();
        if (!q || !selected) return;
        try {
            await post('/api/research/branch', { topicId: selected, question: q });
            fetchResearch();
        } catch (e) {
            showToast(e.message);
        }
        return;
    }

    const fetchBtn = event.target.closest('[data-research-fetch-btn]');
    if (fetchBtn) {
        const url = document.getElementById('res-fetch-url')?.value?.trim();
        const branchId = document.getElementById('res-fetch-branch')?.value || null;
        const render = !!document.getElementById('res-fetch-render')?.checked;
        if (!url || !selected) return;
        fetchBtn.disabled = true;
        fetchBtn.textContent = t('research_fetching');
        try {
            await post('/api/research/fetch', { topicId: selected, url, branchId, render });
            missingRuntimePrompt = '';
            activeTab = 'sources';
            await fetchResearch();
        } catch (e) {
            if (/playwright|chromium|scrapling/i.test(e.message)) {
                missingRuntimePrompt = e.message;
                await fetchResearch();
            }
            showToast(e.message);
            fetchBtn.disabled = false;
            fetchBtn.textContent = t('research_fetch_btn');
        }
        return;
    }

    const installBtn = event.target.closest('[data-research-install-runtime]');
    if (installBtn) {
        installBtn.disabled = true;
        installBtn.textContent = t('research_installing_runtime');
        try {
            await post('/api/research/install', { chromium: true });
            missingRuntimePrompt = '';
            showToast(t('research_installed_runtime'));
            await fetchResearch();
        } catch (e) {
            showToast(e.message);
            installBtn.disabled = false;
            installBtn.textContent = t('research_install_runtime');
        }
        return;
    }

    const readBtn = event.target.closest('[data-read-source]');
    if (readBtn && selected) {
        const sourceId = readBtn.dataset.readSource;
        try {
            openSourceReader = await get(`/api/research/source?topicId=${encodeURIComponent(selected)}&sourceId=${encodeURIComponent(sourceId)}&offset=0&length=30000`);
            activeTab = 'sources';
            if (lastData) renderDetail(lastData);
        } catch (e) {
            showToast(e.message);
        }
        return;
    }

    const pageBtn = event.target.closest('[data-source-page]');
    if (pageBtn && selected) {
        const sourceId = pageBtn.dataset.sourceId;
        const offset = Number(pageBtn.dataset.sourcePage || 0);
        try {
            openSourceReader = await get(`/api/research/source?topicId=${encodeURIComponent(selected)}&sourceId=${encodeURIComponent(sourceId)}&offset=${offset}&length=30000`);
            if (lastData) renderDetail(lastData);
        } catch (e) {
            showToast(e.message);
        }
        return;
    }

    if (event.target.closest('[data-source-close]')) {
        openSourceReader = null;
        if (lastData) renderDetail(lastData);
        return;
    }

    if (event.target.closest('[data-research-copy]')) {
        navigator.clipboard?.writeText(lastBrief).then(() => showToast(t('research_copied'))).catch(() => showToast(lastBrief.slice(0, 80)));
    }
});
