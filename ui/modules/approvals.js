// Pending questions: the owner's half of plutos_ask. They are Home's focal block (#home-waiting):
// an unanswered question is an agent sitting idle, so it is the first thing Home shows. On every
// other page only a count rides on the Home nav item; nothing covers the page being read.
//
// It polls every 5s, and it is careful about two things: re-render only when the set of questions
// actually changes (otherwise the note you are typing is ripped out every five seconds), and move
// the countdown by writing text into the existing node rather than rebuilding the card.
import { t } from '../i18n.js';
import { showToast } from './toast.js';
import { escHtml, jsArg } from '../esc.js';
import { returnProjectKey } from './project-key.js';

const POLL_MS = 5000;
let timer = null;
let lastIds = '';
let lastProject = '';
let requestGeneration = 0;

function countdown(expiresAt) {
    const left = Math.max(0, expiresAt - Date.now());
    const mins = Math.floor(left / 60000);
    if (mins >= 60) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
    if (mins >= 1) return `${mins}m`;
    return `${Math.max(0, Math.floor(left / 1000))}s`;
}

// Everything interpolated here is agent-written: the question, the context line and the agent
// name all arrive from an MCP tool call. Escaped on the way in, ids passed through jsArg.
// approvableHere comes from the server, which decides it from the action and from where this
// browser connects; it is only a hint here. The server refuses the approval either way.
function card(q, projectRoot) {
    const approvable = q.approvableHere !== false;
    return `<div class="ask-card" data-ask-id="${escHtml(q.id)}" data-ask-project-root="${escHtml(projectRoot)}">
        <div class="ask-head">
            <span class="ask-who">${escHtml(q.agent)}</span>
            <span class="ask-ttl" data-ask-ttl="${escHtml(q.id)}">${t('approval_expires')} ${countdown(q.expiresAt)}</span>
        </div>
        <div class="ask-q">${escHtml(q.question)}</div>
        ${q.context ? `<div class="ask-ctx">${escHtml(q.context)}</div>` : ''}
        ${(q.images || []).length ? `<div class="ask-images">${q.images.map((src, i) => {
            const url = `/api/approvals/image?project=${encodeURIComponent(projectRoot)}&path=${encodeURIComponent(src)}`;
            const label = (q.options || [])[i] || String(i + 1);
            return `<a class="ask-image" href="${escHtml(url)}" target="_blank" rel="noopener"><span>${escHtml(label)}</span><img src="${escHtml(url)}" alt="${escHtml(label)}" loading="lazy"></a>`;
        }).join('')}</div>` : ''}
        <input class="field-input field-sm ask-note" id="ask-note-${escHtml(q.id)}" type="text"
               placeholder="${escHtml(t('approval_note_ph'))}" autocomplete="off">
        ${approvable ? '' : `<div class="ask-desk-only">${t('approval_desk_only')}</div>`}
        ${approvable && (q.options || []).length ? `<div class="ask-pick">${t('approval_pick')}</div><div class="ask-options">${q.options.map(o =>
            `<button class="ask-btn ask-opt" onclick="answerAsk(${escHtml(jsArg(q.id))}, 'approved', ${escHtml(jsArg(o))}, ${escHtml(jsArg(projectRoot))})">${escHtml(o)}</button>`
        ).join('')}</div>` : ''}
        <div class="ask-actions">
            ${!approvable || (q.options || []).length ? '' : `<button class="ask-btn ask-yes" onclick="answerAsk(${escHtml(jsArg(q.id))}, 'approved', undefined, ${escHtml(jsArg(projectRoot))})">
                ${t('approval_approve')}
            </button>`}
            <button class="ask-btn ask-no" onclick="answerAsk(${escHtml(jsArg(q.id))}, 'rejected', undefined, ${escHtml(jsArg(projectRoot))})">
                ${t('approval_reject')}
            </button>
        </div>
    </div>`;
}

// Home's container. It sits in the page whether Home is open or not, so the cards are ready the
// moment Home is; null only before the page markup exists.
const host = () => document.getElementById('home-waiting');

function paint(pending, projectRoot) {
    const el = host();
    if (el) el.innerHTML = pending.length
        ? pending.map(question => card(question, projectRoot)).join('')
        : `<p class="home-waiting-none">${t('home_waiting_none')}</p>`;
    showCount(pending.length);
}

// The count on the Home nav item (sidebar and phone bar), so a question reaches the owner on any page.
function showCount(n) {
    document.querySelectorAll(`.tab-btn[onclick*="'overview'"], .mob-tab-btn[data-mob-view="overview"]`).forEach(btn => {
        let badge = btn.querySelector('.nav-count');
        if (!n) { badge?.remove(); return; }
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'nav-count';
            btn.appendChild(badge);
        }
        badge.textContent = String(n);
        badge.title = t('home_waiting_count').replace('{n}', n);
    });
}

window.answerAsk = async function(id, decision, option, expectedProject) {
    const el = document.querySelector(`.ask-card[data-ask-id="${CSS.escape(id)}"]`);
    const projectRoot = el?.dataset.askProjectRoot;
    // A delayed click from an old card must not answer a copied ticket in a new project.
    if (!returnProjectKey(projectRoot) || (expectedProject && returnProjectKey(expectedProject) !== returnProjectKey(projectRoot))) {
        showToast(t('approval_outdated'), true); return;
    }
    const input = document.getElementById(`ask-note-${id}`);
    const note = input ? input.value : '';
    // Remove optimistically: the answer is written under a lock server-side, and leaving the
    // card up for another poll cycle invites a second click on a question already answered.
    ++requestGeneration; // An earlier read cannot put the optimistically removed card back.
    if (el) el.remove();
    try {
        const res = await fetch('/api/approvals', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json',
                'X-Plutos-Approval': document.querySelector('meta[name="plutos-approval-token"]')?.content || '' },
            body: JSON.stringify({ projectRoot, id, decision, note, option })
        });
        const data = await res.json();
        showToast(data.message, !res.ok || !data.success);
    } catch (e) {
        showToast(t('conn_error'), true);
    }
    lastIds = '';   // force a repaint so a failed answer comes back on screen
    tick();
};

async function tick(expectedProject = window.activeWorkspacePath) {
    const project = returnProjectKey(expectedProject);
    const active = returnProjectKey(window.activeWorkspacePath);
    if (!project || !active) {
        ++requestGeneration;
        const el = host();
        if (el) el.innerHTML = '';
        showCount(0);
        lastIds = ''; lastProject = '';
        return false;
    }
    if (project !== active) return false;
    const generation = ++requestGeneration;
    if (lastProject && project !== lastProject) {
        const el = host();
        if (el) el.innerHTML = '';
        showCount(0);
        lastIds = ''; lastProject = '';
    }
    let pending, projectRoot;
    try {
        const response = await fetch(`/api/approvals?project=${encodeURIComponent(expectedProject)}`);
        if (!response.ok) return false;
        const data = await response.json();
        if (generation !== requestGeneration || project !== returnProjectKey(window.activeWorkspacePath)
            || returnProjectKey(data.projectRoot) !== project || !Array.isArray(data.pending)) return false;
        pending = data.pending;
        projectRoot = data.projectRoot;
    } catch (e) {
        return false;   // dashboard offline — existing cards still carry their captured root
    }
    const ids = JSON.stringify([project, pending.map(q => q.id)]);
    if (ids === lastIds) {
        // Same questions, one second-hand: only the countdowns move.
        for (const q of pending) {
            const node = document.querySelector(`[data-ask-ttl="${CSS.escape(q.id)}"]`);
            if (node) node.textContent = `${t('approval_expires')} ${countdown(q.expiresAt)}`;
        }
        return true;
    }
    lastIds = ids;
    lastProject = project;
    paint(pending, projectRoot);
    return true;
}

// Home calls this on open so the block is current at once, not up to five seconds later. An
// unchanged set keeps its cards, and with them a note the owner had started.
export function refreshApprovals() {
    return tick();
}

export function startApprovalWatch() {
    if (timer) return;
    tick();
    timer = setInterval(() => { if (!document.hidden) tick(); }, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
}
