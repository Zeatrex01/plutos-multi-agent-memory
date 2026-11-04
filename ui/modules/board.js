// Council view: main board (boss tier) + agent board (worker tier) + ideas + roster + doc hygiene.
//
// Layout, after the owner's report that the page "keeps sliding down the more tasks arrive":
// the four sections used to stack, so every board with real work in it pushed the ideas list
// and the roster off the screen, and the roster is exactly what you need in view while you
// look at the board. Now the boards/ideas are one switched pane with columns that scroll
// inside themselves, and the people doing the work sit in a rail beside them that never moves.
import { t } from '../i18n.js';
import { knownClientColor } from './orbit.js';
import { showToast } from './toast.js';
import { escHtml, jsArg } from '../esc.js';
import { verificationBadge, verificationForm } from './verification.js';
import { emptyState } from './page.js';
import { returnProjectKey } from './return-summary.js';

// Kanban columns (approved redesign): status is spatial, not read off a pill. Column order
// mirrors the flow of work; colors come from the semantic status tokens, never the accent.
// Each column carries what its status MEANS, not just its name. The four are a protocol
// several AIs write into from different tools, and "In progress" alone does not say who is
// allowed to move it or what has to be true to leave it — so the caption states the rule the
// board is actually keeping.
const KANBAN_COLUMNS = [
    { status: 'TODO', labelKey: 'col_todo', color: 'var(--status-todo)', capKey: 'col_cap_todo', emptyKey: 'col_empty_todo' },
    { status: 'IN_PROGRESS', labelKey: 'col_progress', color: 'var(--status-progress)', capKey: 'col_cap_progress', emptyKey: 'col_empty_progress' },
    { status: 'DONE', labelKey: 'col_done', color: 'var(--status-done)', capKey: 'col_cap_done', emptyKey: 'col_empty_done' },
    { status: 'BLOCKED', labelKey: 'col_blocked', color: 'var(--status-error)', capKey: 'col_cap_blocked', emptyKey: 'col_empty_blocked' }
];
const KNOWN_STATUSES = new Set(KANBAN_COLUMNS.map(c => c.status));

// The pane is switched client-side from data already fetched — re-requesting four endpoints
// to show a list that is sitting in memory would make a tab click slower than it looks.
// Kept at module scope so a refresh after a write lands the owner back where they were.
let activeSegment = 'main';
let lastData = null;
// Fingerprint of the data the pane was last painted from. The board is rebuilt with
// innerHTML, so repainting is destructive: it drops the card you have open, the scroll
// position you are reading at, and any text selection. The refresh timer fires while you
// read, so an unchanged board must not be repainted at all.
let lastFingerprint = '';

// Which cards the reader has opened. Keyed by board + agent + title — the same identity the
// board writer upserts on — so a card stays open when its STATUS changes and it moves to
// another column, which is exactly when you most want to keep reading it.
const openCards = new Set();

window.boardToggleCard = function(el) {
    const key = el.getAttribute('data-key');
    if (el.classList.toggle('open')) openCards.add(key); else openCards.delete(key);
};

// Everything below is agent-written markdown. Column color is safe by construction (a lookup
// in the map above, never raw status); every other value is escaped on the way in.
// Timestamps are written as ISO because the file is machine-readable and shared; a card is
// not. "2026-08-20T05:20:07.288Z" wrapped onto two lines and told the reader nothing they
// wanted. Anything that does not parse as a date is passed through untouched — these fields
// are agent-written and mostly prose.
function humanizeValue(value) {
    if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/.test(value)) return value;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

// ---------------------------------------------------------------------------
// Drag to assign / drag to move.
//
// PLUT_OS starts nothing, and dragging does not change that: a drop writes the same board
// entry the assign form writes and the same one an AI writes through board_update. The AI
// finds it on its next session_start. The gesture is the point — "give this to Cursor" is
// one motion instead of retyping a title into a form.
//
// The dragged entry is held in a module variable rather than dataTransfer: this is
// same-document drag only, and dataTransfer would mean serializing a board entry into a
// string that comes back as text a drop handler has to trust.
let dragged = null;

const clearDropHighlights = () => document.querySelectorAll('.drop-on').forEach(el => el.classList.remove('drop-on'));

window.boardDragStart = function(ev, el, board, agent, status, title) {
    dragged = { board, agent, status, title, projectRoot: lastData?.[board]?.projectRoot };
    el.classList.add('dragging');
    if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = 'move';
        // Firefox refuses to start a drag at all unless some data is set.
        try { ev.dataTransfer.setData('text/plain', title); } catch (e) { /* not fatal */ }
    }
};

window.boardDragEnd = function(el) {
    dragged = null;
    el.classList.remove('dragging');
    clearDropHighlights();
};

window.boardDragOver = function(ev, el) {
    if (!dragged) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    el.classList.add('drop-on');
};

window.boardDragLeave = function(el) { el.classList.remove('drop-on'); };

// One write path for both drop targets. `patch` is what the drop changes — a status, or an
// assignee — on top of the entry's own identity (board + agent + title), which is what
// applyBoardUpdate matches on.
async function dropWrite(ev, el, patch) {
    ev.preventDefault();
    el.classList.remove('drop-on');
    const entry = dragged;
    dragged = null;
    if (!entry) return;
    try {
        const res = await fetch('/api/board', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                board: entry.board, agent: entry.agent, status: entry.status, title: entry.title, projectRoot: entry.projectRoot, ...patch
            })
        });
        const data = await res.json();
        showToast(data.success ? t('toast_board_saved') : (data.message || t('error')), !data.success);
        if (data.success) fetchBoard();
    } catch (e) { showToast(t('conn_error'), true); }
}

window.boardDropStatus = function(ev, el, status) {
    if (dragged && dragged.status === status) { dragged = null; el.classList.remove('drop-on'); return; }
    return dropWrite(ev, el, { status });
};

window.boardDropAssignee = function(ev, el, name) {
    return dropWrite(ev, el, { assignee: name });
};

// ---------------------------------------------------------------------------
// The card.
//
// It used to print every field an entry had — Started, Task, Role, Needs, Assignee, Result,
// plus notes — inside a column roughly 260px wide. Four such cards filled the screen and the
// owner's word for it was "cramped": the one thing you scan a board for, the titles, was the
// smallest part of each card.
//
// So a card shows what a column is scanned for — the title and who has it — and the rest is
// one click away, in place. Dragging still works because a drag never fires a click.
const initials = (name) => String(name || '?').trim().split(/[\s\-_.]+/).filter(Boolean)
    .slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';

// A stable colour per name, so the same AI reads the same in the rail and on every card it
// holds. Derived, never taken from the data: only a number reaches the style attribute.
function hueOf(name) {
    let h = 0;
    for (const ch of String(name || '')) h = (h * 31 + ch.codePointAt(0)) % 360;
    return h;
}

const ownerOf = (e) => (e.fields.Assignee || e.agent || '').trim();

function chip(name) {
    // A known AI client wears its orbit colour on the board too (ui/modules/orbit.js).
    const agent = knownClientColor(name);
    if (agent) return `<span class="chip chip-agent" style="--agent:${agent};"><span class="chip-dot"></span>${escHtml(name)}</span>`;
    const hue = hueOf(name);
    return `<span class="chip" style="--chip-h:${hue};">
        <span class="chip-dot"></span>${escHtml(name)}
    </span>`;
}

const PRIORITY_RE = /^P([1-9])\s*[-–—:]\s*/;
const priorityOf = (e) => Number((PRIORITY_RE.exec(e.title) || [])[1]) || Infinity;
const titleWithoutPriority = (title) => title.replace(PRIORITY_RE, '');

function renderEntries(entries, board) {
    const projectRoot = lastData?.[board]?.projectRoot;
    const card = (e, color, draggable) => {
        const detail = Object.entries(e.fields)
            .filter(([key]) => !['verification', 'evidence'].includes(key.toLowerCase()))
            .map(([k, v]) => `<div class="kc-field"><b>${escHtml(k)}:</b> ${escHtml(humanizeValue(v))}</div>`).join('')
            + e.notes.map(n => `<div class="kc-note"><span class="kc-q" aria-hidden="true">?</span>${escHtml(n)}</div>`).join('')
            + (draggable ? verificationForm(e, board, projectRoot) : '');
        // Only entries the board actually models are draggable. A hand-written status the
        // writer would reject is better left alone than silently rewritten by a drop.
        const drag = draggable
            ? ` draggable="true" title="${t('drag_hint')}"
                ondragstart="boardDragStart(event, this, ${escHtml(jsArg(board))}, ${escHtml(jsArg(e.agent))}, ${escHtml(jsArg(e.status))}, ${escHtml(jsArg(e.title))})"
                ondragend="boardDragEnd(this)"`
            : '';
        // Built by join, not by a template literal: the raw-sink guard in the smoke test greps
        // this file for an unescaped agent field interpolated inside backticks, and it cannot
        // tell key-building backticks from markup ones. The guard is worth more than the two
        // characters a template literal would save.
        const key = [board, ownerOf(e), e.title].join('::');
        const pri = priorityOf(e);
        return `<div class="kanban-card${draggable ? ' draggable' : ''}" style="border-left-color: ${color};"${drag}
             data-key="${escHtml(key)}" data-agent="${escHtml(e.agent)}" data-title="${escHtml(e.title)}" onclick="boardToggleCard(this)">
            <div class="kc-title">
                ${pri < Infinity ? `<span class="kc-pri p${pri}" title="${t('card_priority')}">P${pri}</span>` : ''}${escHtml(titleWithoutPriority(e.title))}
            </div>
            <div class="kc-foot">
                ${chip(ownerOf(e))}
                ${e.notes.length ? `<span class="kc-flag" title="${t('card_has_note')}"><span class="kc-q" aria-hidden="true">?</span></span>` : ''}
                ${detail ? `<span class="kc-more"></span>` : ''}
            </div>
            ${(badge => badge ? `<div style="display:flex;flex-wrap:wrap;gap:0.4rem;margin-top:0.3rem;">${badge}</div>` : '')(verificationBadge(e, board, projectRoot))}
            ${detail ? `<div class="kc-detail">${detail}</div>` : ''}
        </div>`;
    };
    const cols = KANBAN_COLUMNS.map(col => {
        const items = entries.filter(e => e.status === col.status)
            .sort((a, b) => priorityOf(a) - priorityOf(b));
        // Open questions are the one thing in a column you have to answer rather than read,
        // and they were only visible one card at a time — folded inside cards you had to open.
        const questions = items.reduce((n, e) => n + e.notes.length, 0);
        const body = items.length
            ? items.map(e => card(e, col.color, true)).join('')
            : `<div class="empty-state kanban-empty"><p class="empty-text">${t(col.emptyKey)}</p></div>`;
        return `<div class="kanban-col" style="--col-accent: ${col.color};">
            <div class="kanban-head">
                <span class="lbl" style="color: ${col.color};">${t(col.labelKey)}</span>
                <span class="n">${items.length}</span>
                ${questions ? `<span class="kc-flag" title="${t('col_questions')}"><span class="kc-q" aria-hidden="true">?</span>${questions}</span>` : ''}
                <span class="rail" style="background: ${col.color};"></span>
            </div>
            <div class="kanban-cap">${t(col.capKey)}</div>
            <div class="kanban-body" data-status="${escHtml(col.status)}"
                 ondragover="boardDragOver(event, this)"
                 ondragleave="boardDragLeave(this)"
                 ondrop="boardDropStatus(event, this, ${escHtml(jsArg(col.status))})">${body}</div>
        </div>`;
    }).join('');
    // Entries in a status outside the four known columns (hand-edited markdown) must not
    // vanish — they land under the grid in a plain list.
    const strays = entries.filter(e => !KNOWN_STATUSES.has(e.status));
    const strayHtml = strays.length
        ? `<div class="kanban-strays">
             <div class="strays-head">${t('board_strays').replace('{n}', strays.length)}</div>
             ${strays.map(e => card(e, 'var(--text-muted)', false)).join('')}
           </div>`
        : '';
    return `<div class="kanban">${cols}</div>${strayHtml}`;
}

// Assigning work is the owner's core action, and the dashboard had no way to do it: the
// board was read-only here, so giving a task meant asking an AI to write the entry or
// hand-editing BOARD.md. The fields mirror the MCP board_update contract exactly — an
// assignment made here is indistinguishable from one an AI made, which is the point.
//
// Folded shut by default: five inputs is the tallest thing on this screen and it is used
// once per task, while the board underneath it is read continuously.
const field = (id, label, placeholder, hint = '') => `
    <label class="field">
        <span class="field-label">${label}</span>
        <input id="${id}" type="text" class="field-input" autocomplete="off" placeholder="${placeholder}">
        ${hint ? `<span class="field-hint">${hint}</span>` : ''}
    </label>`;

function renderAssignForm() {
    return `<details class="card assign-panel" data-panel="assign" data-project-root="${escHtml(lastData?.main?.projectRoot || '')}">
        <summary>
            <i data-lucide="plus-circle"></i> ${t('assign_title')}
        </summary>
        <div class="assign-panel-body">
            <div class="assign-row">
                ${field('assign-title', t('assign_field_title'), t('assign_ph_title'))}
                ${field('assign-assignee', t('assign_field_assignee'), t('assign_ph_assignee'))}
                ${field('assign-role', t('assign_field_role'), t('assign_ph_role'))}
            </div>
            <div class="assign-row two">
                ${field('assign-task', t('assign_field_task'), t('assign_ph_task'))}
                ${field('assign-needs', t('assign_field_needs'), t('assign_ph_needs'), t('assign_hint_needs'))}
            </div>
            <div class="field-row" style="margin-top:0.9rem;">
                <button class="btn-primary" onclick="assignTask()">${t('assign_submit')}</button>
                <span class="page-status" style="margin:0;">${t('assign_note')}</span>
            </div>
        </div>
    </details>`;
}

window.assignTask = async function() {
    const val = (id) => (document.getElementById(id)?.value || '').trim();
    const title = val('assign-title');
    if (!title) { showToast(t('assign_need_title'), true); return; }
    const needs = val('assign-needs').split(',').map(s => s.trim()).filter(Boolean);
    try {
        const res = await fetch('/api/board', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                // The owner is the boss tier by definition, and a task starts unclaimed.
                agent: 'owner', status: 'TODO', title,
                projectRoot: document.querySelector?.('[data-panel="assign"]')?.dataset.projectRoot || lastData?.main?.projectRoot,
                task: val('assign-task') || undefined,
                assignee: val('assign-assignee') || undefined,
                role: val('assign-role') || undefined,
                needs: needs.length ? needs : undefined
            })
        });
        const data = await res.json();
        showToast(data.success ? t('toast_board_saved') : (data.message || t('error')), !data.success);
        if (data.success) {
            for (const id of ['assign-title', 'assign-task', 'assign-assignee', 'assign-role', 'assign-needs']) {
                const el = document.getElementById(id); if (el) el.value = '';
            }
            fetchBoard();
        }
    } catch (e) { showToast(t('conn_error'), true); }
};

// The deferred list. Written by whoever hits an off-scope idea — usually an AI mid-task,
// which is exactly why the owner never saw them: parking an idea in IDEAS.md and reading it
// back were two different activities in two different windows. Here it is one.
//
// Settled ideas (struck through, or marked promoted/DONE) are the majority of a mature file
// and they are history, not work — they collapse into a <details> so the pending ones, the
// only ones a decision is still owed on, are what the section actually shows.
function renderIdeas(data) {
    // Which file this came from, always — "no IDEAS.md in this project" without naming the
    // path it looked for is a dead end, and it is exactly the question that got asked.
    const source = (label) => `<div class="ideas-src">${label} <code>${escHtml(data?.rel || 'IDEAS.md')}</code></div>`;
    if (!data || !data.exists) {
        return renderIdeaForm()
            + emptyState({ icon: 'lightbulb', title: t('ideas_missing') })
            + source(t('ideas_will_create'));
    }
    const row = (i) => `<li class="idea-item${i.settled ? ' settled' : ''}">
        ${i.section ? `<span class="pill pill-quiet">${escHtml(i.section)}</span>` : ''}
        <span>${escHtml(i.text)}</span>
    </li>`;
    const pending = data.ideas.filter(i => !i.settled);
    const settled = data.ideas.filter(i => i.settled);
    const pendingHtml = pending.length
        ? `<ul class="idea-list">${pending.map(row).join('')}</ul>`
        : emptyState({ icon: 'lightbulb', title: t('ideas_empty') });
    const settledHtml = settled.length
        ? `<details class="cmd-line" style="margin-top: 0.75rem;">
             <summary>${t('ideas_settled').replace('{n}', settled.length)}</summary>
             <ul class="idea-list">${settled.map(row).join('')}</ul>
           </details>`
        : '';
    return renderIdeaForm() + source(t('ideas_source')) + pendingHtml + settledHtml;
}

function renderIdeaForm() {
    return `<div class="field-row" style="margin-bottom: 0.9rem;">
        <input id="idea-text" type="text" class="field-input" autocomplete="off" placeholder="${t('ideas_ph')}"
               onkeydown="if(event.key==='Enter') parkIdea()">
        <button class="btn-primary" onclick="parkIdea()">${t('ideas_submit')}</button>
    </div>
    <p class="page-status" style="margin: -0.4rem 0 0.9rem;">${t('ideas_note')}</p>`;
}

window.parkIdea = async function() {
    const input = document.getElementById('idea-text');
    const text = (input?.value || '').trim();
    if (!text) { showToast(t('ideas_need_text'), true); return; }
    try {
        const res = await fetch('/api/ideas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text })
        });
        const data = await res.json();
        showToast(data.success ? t('toast_idea_saved') : (data.message || t('error')), !data.success);
        if (data.success) { input.value = ''; fetchBoard(); }
    } catch (e) { showToast(t('conn_error'), true); }
};

// Hygiene: boards and maps rot silently — bloated entries get skimmed by the AIs reading
// them, stale maps describe a codebase that moved on. This card is the alarm, and the
// archive button is the fix that needs no AI.
const LEVEL_COLOR = { action: 'var(--status-todo)', warn: 'var(--status-todo)', info: 'var(--text-muted)' };

function renderHygiene(h) {
    if (!h || (!h.warnings?.length && !h.boards?.some(b => b.exists))) return '';
    const sizeLine = h.boards.filter(b => b.exists).map(b =>
        `<span style="margin-right: 1.2rem;"><b style="color: var(--text-title);">${escHtml(b.name)}</b> — ${escHtml(b.active)} ${t('hygiene_active')}, ${escHtml(b.done)} DONE, ${Math.round(b.bytes / 1024) || '<1'} KB</span>`).join('');
    const docLine = h.docs.filter(d => d.exists && d.commitsBehind !== null).map(d =>
        `<span style="margin-right: 1.2rem;"><b style="color: var(--text-title);">${escHtml(d.name)}</b> — ${escHtml(d.commitsBehind)} ${t('hygiene_commits_behind')}</span>`).join('');
    const warnHtml = h.warnings.length
        ? h.warnings.map(w => `<div style="color: ${LEVEL_COLOR[w.level] || 'var(--text-muted)'}; font-size: 0.85rem; margin-top: 4px;">
             <span class="dot"></span><b>${escHtml(w.source)}:</b> ${escHtml(w.message)}
             ${w.action === 'archive' ? `<button class="btn-secondary btn-sm" style="margin-left: 8px;" onclick="archiveBoard(${escHtml(jsArg(w.board))})">${t('hygiene_archive_btn')}</button>` : ''}
           </div>`).join('')
        : `<div style="color: var(--status-done); font-size: 0.85rem; margin-top: 4px;">${t('hygiene_ok')}</div>`;
    // Folded, like the assign form above it. Three stale-doc warnings and two file sizes are
    // worth keeping, but they were pushing the board itself below the fold on every visit —
    // and the board is what this tab is for. The summary carries the one number that decides
    // whether it is worth opening.
    const n = h.warnings.length;
    const badge = n
        ? `<span class="pill pill-todo">${n} ${t(n === 1 ? 'hygiene_warn_one' : 'hygiene_warn_many')}</span>`
        : `<span class="pill pill-done">${t('hygiene_all_clear')}</span>`;
    return `<details class="card assign-panel" data-panel="hygiene">
        <summary>
            <i data-lucide="activity"></i> ${t('hygiene_title')} ${badge}
        </summary>
        <div class="assign-panel-body">
            <div style="color: var(--text-muted); font-size: 0.8rem;">${sizeLine}${docLine}</div>
            ${warnHtml}
        </div>
    </details>`;
}

// Removing an ACTIVE agent's registration is a real decision — the confirm names its status
// so the owner knows whether they are deleting a live agent or just a pre-introduction.
window.removeRosterAgent = async function(name, status) {
    if (!confirm(t('confirm_roster_remove').replace('{name}', name).replace('{status}', status))) return;
    try {
        const res = await fetch('/api/roster/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        const data = await res.json();
        showToast(data.success ? t('toast_roster_removed').replace('{name}', name) : data.message, !data.success);
        if (data.success) fetchBoard();
    } catch (e) {
        showToast(t('conn_error'), true);
    }
};

window.archiveBoard = async function(board) {
    try {
        const res = await fetch('/api/board/archive', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ board })
        });
        const data = await res.json();
        const archived = data.success
            ? (data.archived ? t('toast_board_archived').replace('{n}', data.archived) : t('toast_board_nothing_to_archive'))
            : data.message;
        showToast(archived, !data.success);
        if (data.success) fetchBoard();
    } catch (e) {
        showToast(t('conn_error'), true);
    }
};

// The rail: who is here, what they are holding, and what you drop a task onto.
//
// Two changes after the first cut. It grew down the page without limit — a project with a
// dozen registered subagents pushed its own scrollbar past the board's — so it scrolls
// inside itself now and subagents, which are the many, fold away under the AI that owns
// them. And it showed only names: a drop target that cannot tell you who is already loaded
// is a worse place to drop a task than the form it replaced. Each row carries its open
// count, from the board you are looking at.
function railRow(a, open, main) {
    const status = a.fields.Status || 'active';
    const hue = hueOf(a.name);
    const last = a.fields['Last active'] || a.fields.Registered || '';
    const agent = knownClientColor(a.name);
    return `<div class="ai-row${main ? ' main' : ''}${agent ? ' ai-row-agent' : ''}" style="--chip-h:${hue};${agent ? `--agent:${agent};` : ''}"
         title="${escHtml(a.owner)} · ${escHtml(a.role)}${last ? ' · ' + escHtml(humanizeValue(last)) : ''}"
         ondragover="boardDragOver(event, this)"
         ondragleave="boardDragLeave(this)"
         ondrop="boardDropAssignee(event, this, ${escHtml(jsArg(a.name))})">
        <span class="ai-avatar">${escHtml(initials(a.name))}</span>
        <span class="ai-name">${escHtml(a.name)}</span>
        ${open ? `<span class="ai-load" title="${t('rail_open_tasks')}">${open}</span>` : ''}
        <button class="ai-remove" title="${t('roster_remove_hint')}"
            onclick="removeRosterAgent(${escHtml(jsArg(a.name))}, ${escHtml(jsArg(status))})">×</button>
    </div>`;
}

function renderRail(roster, entries) {
    const agents = (roster && roster.agents) || [];
    const isMain = (a) => (a.fields.Kind || '').toLowerCase().includes('main-ai');
    // "Open" is what a drop actually adds to: work that is not finished. A DONE pile says
    // nothing about who can take the next task.
    const openFor = (name) => (entries || []).filter(e =>
        e.status !== 'DONE' && ownerOf(e).toLowerCase() === String(name).toLowerCase()).length;

    const mains = agents.filter(isMain);
    const subs = agents.filter(a => !isMain(a));
    const body = agents.length
        ? mains.map(a => railRow(a, openFor(a.name), true)).join('')
          + (subs.length
              ? `<details class="rail-subs"><summary>${t('rail_subagents').replace('{n}', subs.length)}</summary>
                   ${subs.map(a => railRow(a, openFor(a.name), false)).join('')}
                 </details>`
              : '')
        : `<p class="rail-empty">${t('rail_empty')}</p>`;
    return `<aside class="board-rail" title="${t('rail_hint')}">
        <div class="rail-head"><i data-lucide="users" style="width:15px;height:15px;"></i> ${t('rail_title')}</div>
        <div class="rail-body">${body}</div>
    </aside>`;
}

const SEGMENTS = [
    { id: 'main', labelKey: 'board_seg_main' },
    { id: 'agents', labelKey: 'board_seg_agents' },
    { id: 'ideas', labelKey: 'board_seg_ideas' }
];

window.boardSegment = function(id) {
    activeSegment = id;
    paint();
};

function renderSegmentBar(counts) {
    return `<div class="seg-bar">${SEGMENTS.map(s => `
        <button class="seg${activeSegment === s.id ? ' active' : ''}" onclick="boardSegment(${escHtml(jsArg(s.id))})">
            ${t(s.labelKey)}<span class="seg-n">${counts[s.id]}</span>
        </button>`).join('')}</div>`;
}

// Rewriting a container with innerHTML throws away everything the reader had done to it: the
// card they opened, how far they had scrolled each column, what they had half-typed into the
// assign form, which panels they had unfolded, and where the caret sat. This owns that whole
// invariant, so paint() below can go back to being about markup — nothing else in this module
// needs to know what "the reader's place" is made of.
//
// Every DOM read here is optional on purpose: this also runs against a bare { innerHTML }
// container in the tests, where there is no state to keep, and skipping is the correct
// behaviour there rather than a workaround.
function repaintKeepingReadersPlace(container, html) {
    const find = (sel) => (container.querySelectorAll ? [...container.querySelectorAll(sel)] : []);
    const fields = () => find('input[id], textarea[id], select[id]');

    // Columns are matched by status rather than position, so a column that gains or loses
    // entries still gets its own scroll back.
    const scrolls = new Map();
    find('.kanban-body[data-status]').forEach(el => {
        if (el.scrollTop) scrolls.set(el.getAttribute('data-status'), el.scrollTop);
    });
    const typed = new Map();
    fields().forEach(el => {
        if (el.value) typed.set(el.id, { value: el.value, revision: el.closest?.('form[data-revision]')?.dataset.revision });
    });
    // By name, not position: the hygiene panel is absent entirely when it has nothing to
    // report, which would otherwise shift the assign form into its slot.
    const panels = new Set();
    find('details[data-panel]').forEach(el => { if (el.open) panels.add(el.getAttribute('data-panel')); });
    const here = document.activeElement;
    const focused = here && here.id && fields().some(el => el === here)
        ? { id: here.id, start: here.selectionStart, end: here.selectionEnd }
        : null;

    container.innerHTML = html;

    find('.kanban-card[data-key]').forEach(el => {
        if (openCards.has(el.getAttribute('data-key'))) el.classList.add('open');
    });
    find('.kanban-body[data-status]').forEach(el => {
        const top = scrolls.get(el.getAttribute('data-status'));
        if (top) el.scrollTop = top;
    });
    // Panels before fields: a field inside a folded <details> cannot take focus.
    find('details[data-panel]').forEach(el => { if (panels.has(el.getAttribute('data-panel'))) el.open = true; });
    fields().forEach(el => {
        const draft = typed.get(el.id);
        if (draft && draft.revision === el.closest?.('form[data-revision]')?.dataset.revision) el.value = draft.value;
    });
    if (focused) {
        const el = fields().find(e => e.id === focused.id);
        if (el) {
            el.focus();
            // Only text-ish inputs carry a selection range; asking any other kind throws.
            try { el.setSelectionRange(focused.start, focused.end); } catch { /* not a text field */ }
        }
    }
}

// Paints from `lastData` — no request. Switching panes must not re-read four files off disk.
function paint() {
    const container = document.getElementById('board-container');
    if (!container || !lastData) return;
    const { main, agents, roster, hygiene, ideas } = lastData;

    let pane;
    if (activeSegment === 'ideas') {
        pane = renderIdeas(ideas);
    } else if (activeSegment === 'agents') {
        pane = !agents.exists
            ? emptyState({ icon: 'users', title: t('agent_board_missing') })
            : (agents.entries.length ? renderEntries(agents.entries, 'agents') : emptyState({ icon: 'users', title: t('agent_board_empty'), text: t('agent_board_empty_text') }));
    } else {
        pane = !main.exists
            ? emptyState({ icon: 'kanban', title: t('board_missing') })
            : (main.entries.length ? renderEntries(main.entries, 'main') : emptyState({ icon: 'kanban', title: t('board_empty'), text: t('home_step_task_text'),
                action: { label: t('home_step_task_btn'), onclick: 'openAssignTask()' } }));
    }

    const counts = {
        main: main.entries?.length || 0,
        agents: agents.entries?.length || 0,
        ideas: (ideas?.ideas || []).filter(i => !i.settled).length
    };
    const subtitleKey = activeSegment === 'ideas' ? 'ideas_title'
        : activeSegment === 'agents' ? 'board_agents_title' : 'board_main_title';
    // The ideas pane has no entries of its own; the rail keeps counting the main board there,
    // because "who is loaded" does not stop being true while you read the parking lot.
    const railEntries = (activeSegment === 'agents' ? agents.entries : main.entries) || [];

    repaintKeepingReadersPlace(container,
        renderAssignForm() +
        `<div class="board-layout">
            <div class="board-topbar">
                ${renderSegmentBar(counts)}
                ${renderRail(roster, railEntries)}
            </div>
            <div class="pane-sub">${t(subtitleKey)}</div>
            ${pane}
        </div>`);
    // Document checks sit in Board tools below the board; a warning shows on the fold's summary,
    // so a problem is still seen without the panel standing between the owner and the board.
    const tools = document.getElementById('board-hygiene');
    const wasOpen = tools?.querySelector('details[data-panel="hygiene"]')?.open;
    if (tools) tools.innerHTML = renderHygiene(hygiene);
    if (wasOpen) tools.querySelector('details[data-panel="hygiene"]')?.setAttribute('open', '');
    const flag = document.getElementById('board-tools-flag');
    const warnings = hygiene?.warnings?.length || 0;
    if (flag) { flag.hidden = !warnings; flag.textContent = `${warnings} ${t(warnings === 1 ? 'hygiene_warn_one' : 'hygiene_warn_many')}`; }
    lucide.createIcons();
    if (assignPending) openAssignPanel();
}

// "Assign a task" from anywhere (the page head, Home's next step, an empty board): open the
// form and put the caret in its first field, once the board has drawn it.
let assignPending = false;
function openAssignPanel() {
    const panel = document.querySelector('#board-container details[data-panel="assign"]');
    if (!panel) return;
    assignPending = false;
    panel.open = true;
    panel.scrollIntoView({ block: 'start' });
    document.getElementById('assign-title')?.focus({ preventScroll: true });
}

window.openAssignTask = function() {
    const panel = document.querySelector('#board-container details[data-panel="assign"]');
    const here = document.getElementById('view-board')?.classList.contains('active');
    // The page head's button toggles the form; from anywhere else it opens it.
    if (here && panel?.open) { panel.open = false; return; }
    assignPending = true;
    if (!here) window.switchView?.('board');
    openAssignPanel();
};

export async function fetchBoard() {
    const container = document.getElementById('board-container');
    const meta = document.getElementById('board-meta');
    try {
        const [main, agents, roster, hygiene, ideas] = await Promise.all([
            fetch('/api/board').then(r => r.json()),
            fetch('/api/board?board=agents').then(r => r.json()),
            fetch('/api/roster').then(r => r.json()),
            fetch('/api/hygiene').then(r => r.json()).catch(() => null),
            fetch('/api/ideas').then(r => r.json()).catch(() => null)
        ]);

        meta.textContent = main.exists
            ? `${main.project} · ${new Date(main.updatedAt).toLocaleString('en-US')}`
            : (main.project || '');

        const next = { main, agents, roster, hygiene, ideas };
        // The cheapest fix for a destructive repaint is not to repaint. The timer fires every
        // few seconds whether or not anybody wrote to the board, and on an idle board that was
        // pure loss: the card you had open closed itself and the pane jumped back to the top.
        const fingerprint = JSON.stringify(next);
        if (fingerprint === lastFingerprint) return true;
        lastFingerprint = fingerprint;
        lastData = next;
        paint();
        return true;
    } catch (err) {
        // The pane now holds an error instead of the board, so the memo above must not let an
        // unchanged next read skip the repaint that puts the board back.
        lastFingerprint = '';
        container.innerHTML = `<p class="page-status">${t('conn_error')}</p>`;
        return false;
    }
}

document.addEventListener('plutos-board-updated', () => { void fetchBoard(); });

window.focusBoardTask = async function(board, agent, title, projectRoot) {
    if (!['main', 'agents'].includes(board)) return;
    const expected = returnProjectKey(projectRoot || window.activeWorkspacePath || lastData?.main?.projectRoot);
    const selectedMatches = () => expected && returnProjectKey(window.activeWorkspacePath) === expected;
    const outdated = () => { showToast(t('return_summary_outdated'), true); return false; };
    if (!selectedMatches() || (lastData?.main?.projectRoot && returnProjectKey(lastData.main.projectRoot) !== expected)) return outdated();
    activeSegment = board;
    window.switchView?.('board');
    const refreshed = await fetchBoard();
    if (!refreshed || !selectedMatches() || returnProjectKey(lastData?.main?.projectRoot) !== expected
        || returnProjectKey(lastData?.[board]?.projectRoot) !== expected) return outdated();
    const entry = lastData?.[board]?.entries?.find(item => item.agent === agent && item.title === title);
    if (!entry) return;
    const key = [board, ownerOf(entry), entry.title].join('::');
    openCards.add(key);
    paint();
    const cards = document.querySelectorAll('.kanban-card[data-key]');
    const card = [...cards].find(item => item.getAttribute('data-key') === key
        && item.getAttribute('data-agent') === agent && item.getAttribute('data-title') === title);
    card?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return !!card;
};
