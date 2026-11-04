// Shared Table tab. Every department (office) works on the same job blind; the owner sees the offices side by
// side, what each designed, researched or critiqued, what was said, and what the shared table decided.
// Read + owner messages only — seats are started by the moderator (tools/council.mjs), never from here;
// the room says so with the exact command.
import { t } from '../i18n.js';
import { escHtml } from '../esc.js';
import { emptyState } from './page.js';

const STEPS = ['brief', 'blind', 'reveal', 'consolidate', 'decision'];
const WORK = ['research', 'design', 'critique'];
const FILTERS = ['all', 'design', 'research', 'critique'];
const DESK_PILL = { working: 'pill-progress', delivered: 'pill-done', failed: 'pill-blocked', waiting: 'pill-quiet' };
let departments = {}, seats = {}, rooms = [], slug = null, data = null, round = null, filter = 'all', source = null, request = null;
const open = new Set();

const root = () => window.activeWorkspacePath;
const q = extra => `project=${encodeURIComponent(root())}${extra}`;
const host = () => document.getElementById('council-container');
const deptLabel = id => departments[id]?.label || id;
const deptColor = id => departments[id]?.color || '#64748b';
const initials = name => escHtml(name.slice(0, 2).toUpperCase());

function closeStream() { source?.close(); source = null; }

// Safe, small markdown: text is escaped first, then headings, lists, bold, inline code and links.
function md(text) {
    const inline = s => s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    const out = []; let list = null;
    // The trailing "FILES:" line is the seat's file report for the log; the files are shown as links instead.
    for (const raw of escHtml(text || '').split('\n').filter(l => !/^FILES:/.test(l.trim()))) {
        const line = raw.trimEnd(), item = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/), head = line.match(/^#{1,4}\s+(.*)$/);
        if (item) { if (!list) { list = []; } list.push(`<li>${inline(item[1])}</li>`); continue; }
        if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
        if (head) out.push(`<h5>${inline(head[1])}</h5>`);
        else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    }
    if (list) out.push(`<ul>${list.join('')}</ul>`);
    return out.join('');
}

function stepOf(log, r) {
    const inRound = log.filter(m => m.round === r), has = kind => inRound.some(m => m.kind === kind);
    return has('decision') ? 'decision' : has('consolidation') ? 'consolidate' : has('reveal') ? 'reveal' : inRound.some(m => m.dept) ? 'blind' : 'brief';
}

function fileLinks(m) {
    if (!m.files?.length) return '';
    return `<div class="cn-files">${m.files.map(file => {
        const href = `/api/council/file?${q(`&slug=${encodeURIComponent(slug)}&path=${encodeURIComponent(file)}`)}`;
        return /\.(png|jpe?g|webp|svg)$/i.test(file)
            ? `<a href="${href}" target="_blank" rel="noopener"><img src="${href}" alt="${escHtml(file)}"></a>`
            : `<a class="cn-file" href="${href}" target="_blank" rel="noopener">${escHtml(file.split('/').pop())}</a>`;
    }).join('')}</div>`;
}

function body(m) {
    const long = (m.text || '').length > 700, expanded = open.has(m.id);
    return `<div class="cn-md${long && !expanded ? ' cn-clamped' : ''}">${md(m.text)}</div>
        ${long ? `<button type="button" class="card-link" data-council-expand="${m.id}">${t(expanded ? 'council_less' : 'council_more')}</button>` : ''}${fileLinks(m)}`;
}

function flow(step, log, r, status) {
    const at = step === 'decision' ? STEPS.length : STEPS.indexOf(step);   // a decision closes the round
    const inRound = log.filter(m => m.round === r);
    const delivered = new Set(inRound.filter(m => m.dept).map(m => m.dept)).size;
    const notes = { brief: t('council_note_brief'), blind: `${delivered}/${data.room.departments.length} ${t('council_note_delivered')}`,
        reveal: t('council_note_reveal'), consolidate: t('council_note_consolidate'), decision: t('council_note_decision') };
    return `<ol class="cn-flow">${STEPS.map((s, i) => `<li class="${i < at ? 'done' : i === at ? 'now' : ''}">
        <span class="cn-node">${i < at ? '✓' : i + 1}</span><strong>${t('council_step_' + s)}</strong><small>${escHtml(notes[s])}</small></li>`).join('')}</ol>`;
}

function office(dept, log, r, revealed, status) {
    const work = log.filter(m => m.round === r && m.dept === dept && (filter === 'all' || m.kind === filter));
    const desk = status.round === r ? status.departments.find(d => d.id === dept)?.status : (work.length ? 'delivered' : 'waiting');
    const failed = log.filter(m => m.round === r && m.meta?.failed === dept).pop();
    const seat = seats[departments[dept]?.seat] || departments[dept]?.seat || '';
    const sealed = !revealed.has(r);
    const cards = work.map(m => `<article class="panel cn-card">
            <header><span class="cn-kind cn-kind-${m.kind}">${t('council_kind_' + m.kind)}</span>
                <time>${new Date(m.t).toLocaleString()}</time>${sealed ? `<span class="cn-lock" title="${escHtml(t('council_sealed_help'))}">${t('council_sealed')}</span>` : ''}</header>
            ${body(m)}</article>`).join('');
    const empty = desk === 'working' ? `<div class="cn-skeleton"><i></i><i></i><i></i><span>${t('council_working_now')}</span></div>`
        : desk === 'failed' ? `<p class="page-status cn-fail">${escHtml(failed?.text || t('council_status_failed'))}</p>`
        : `<p class="page-status">${t('council_no_work')}</p>`;
    return `<section class="cn-office" style="--dept:${escHtml(deptColor(dept))}">
        <header class="cn-office-head"><span class="cn-avatar">${initials(deptLabel(dept))}</span>
            <div><h4>${escHtml(deptLabel(dept))}</h4><small>${escHtml(departments[dept]?.role || '')}${seat ? ` · ${escHtml(seat)}` : ''}</small></div>
            <span class="pill ${DESK_PILL[desk] || 'pill-quiet'}">${t('council_status_' + desk)}</span></header>
        <div class="cn-office-body">${cards || empty}</div></section>`;
}

function table(log, r) {
    const items = log.filter(m => m.round === r && ['consolidation', 'decision'].includes(m.kind));
    if (!items.length) return `<p class="page-status">${t('council_table_empty')}</p>`;
    return items.map(m => `<article class="panel cn-card cn-${m.kind}"><header><span class="cn-kind cn-kind-${m.kind}">${t('council_kind_' + m.kind)}</span>
        <time>${new Date(m.t).toLocaleString()}</time></header>${body(m)}</article>`).join('');
}

function talk(log, r) {
    const items = log.filter(m => m.round === r && (m.kind === 'discussion' || (m.kind === 'system' && m.meta?.failed)));
    // "claude" is the moderator id rooms carried before council.config.json named one.
    const who = m => m.from === 'human' ? [t('council_owner'), '#8e44ad'] : (m.from === 'claude' || m.from === (data && data.moderator)) ? [t('council_moderator'), '#c4733a'] : [t('council_system'), '#888'];
    return `${items.map(m => { const [name, color] = who(m); return `<div class="cn-msg${m.from === 'human' ? ' cn-mine' : ''}">
            <span class="cn-avatar" style="background:${color}">${initials(name)}</span>
            <div><strong>${escHtml(name)}</strong> <time>${new Date(m.t).toLocaleTimeString()}</time>${md(m.text)}</div></div>`; }).join('')
        || `<p class="page-status">${t('council_talk_empty')}</p>`}
        <form class="cn-composer" data-council-form><textarea name="text" rows="2" class="field-input" placeholder="${escHtml(t('council_write'))}"></textarea>
            <button type="submit" class="btn-primary">${t('council_send')}</button></form>`;
}

function renderRoom() {
    const { room, log, status } = data;
    const r = round || status.round, revealed = new Set(log.filter(m => m.kind === 'reveal').map(m => m.round));
    const brief = log.filter(m => m.round <= r && m.kind === 'brief').pop();
    // A filter for a kind of work no office in this room does (a room without a Critique office) is not shown.
    const kinds = new Set(room.departments.map(d => departments[d]?.kind));
    const filters = FILTERS.filter(f => f === 'all' || kinds.has(f));
    if (!filters.includes(filter)) filter = 'all';
    const counts = Object.fromEntries(filters.map(f => [f, log.filter(m => m.round === r && m.dept && (f === 'all' ? WORK.includes(m.kind) : m.kind === f)).length]));
    const seatCmd = `node tools/council.mjs ask ${room.slug || slug} <${room.departments.join('|')}> --instruction "…" --project "${root()}"`;
    const rounds = [...new Set(log.map(m => m.round))].sort((a, b) => a - b);
    host().innerHTML = `<div class="cn-room">
        <div class="cn-topbar"><button type="button" class="card-link" data-council-action="overview">← ${t('council_all_rooms')}</button>
            <h3>${escHtml(room.title)}</h3>
            <div class="seg-control">${rounds.map(n => `<button type="button" class="${n === r ? 'active' : ''}" data-council-round="${n}">${t('council_round')} ${n}</button>`).join('')}</div>
            <span class="cn-live${source?.readyState === 1 ? ' on' : ''}"><i></i>${t('council_live')}</span></div>
        ${brief ? `<details class="card card-accent cn-brief" open><summary>${t('council_kind_brief')} · ${t('council_round')} ${brief.round}</summary>${md(brief.text)}</details>` : ''}
        ${flow(stepOf(log, r), log, r, status)}
        <p class="page-status cn-seat-line">${t('council_seats_cli')} <code>${escHtml(seatCmd)}</code></p>
        <div class="cn-section-head"><h4>${t('council_offices')}</h4>
            <span class="cn-hint">${revealed.has(r) ? t('council_revealed_hint') : t('council_sealed_hint')}</span>
            <div class="seg-bar">${filters.map(f => `<button type="button" class="seg${f === filter ? ' active' : ''}" data-council-filter="${f}">${t('council_filter_' + f)} <span class="seg-n">${counts[f]}</span></button>`).join('')}</div></div>
        <div class="cn-offices" style="--cols:${room.departments.length}">${room.departments.map(d => office(d, log, r, revealed, status)).join('')}</div>
        <div class="cn-lower">
            <section class="card cn-table"><div class="cn-section-head"><h4>${t('council_table')}</h4></div>${table(log, r)}</section>
            <section class="card cn-talk"><div class="cn-section-head"><h4>${t('council_tab_discussion')}</h4></div>${talk(log, r)}</section>
        </div></div>`;
}

function renderOverview() {
    host().innerHTML = rooms.length ? `<div class="card-grid">${rooms.map(r => {
        const at = STEPS.indexOf(r.step);
        return `<button type="button" class="card cn-room-card" data-council-room="${escHtml(r.slug)}">
            <span class="cn-room-top"><strong>${escHtml(r.title)}</strong><span class="pill pill-quiet">${t('council_round')} ${r.round}</span></span>
            <span class="cn-progress">${STEPS.map((s, i) => `<i class="${i <= at ? 'on' : ''}" title="${escHtml(t('council_step_' + s))}"></i>`).join('')}</span>
            <small>${t('council_step_' + r.step)}</small>
            <span class="cn-room-desks">${r.departments.map(d => `<span class="pill" style="--dept:${escHtml(deptColor(d.id))}"><i class="cn-dot cn-dot-${d.status}"></i>${escHtml(deptLabel(d.id))}</span>`).join('')}</span>
            <span class="cn-room-decision">${r.lastDecision ? `<b>${t('council_kind_decision')}:</b> ${escHtml(r.lastDecision)}` : `<em>${t('council_no_decision')}</em>`}</span></button>`;
    }).join('')}</div>`
        : emptyState({ icon: 'layout-panel-left', title: t('council_empty_title'), text: t('council_empty_text'), ask: t('council_empty_ask'),
            command: `node tools/council.mjs new <room> --title "…" --brief "…" --project "${root()}"` });
    if (!rooms.length) window.lucide?.createIcons();
}

async function load(path) {
    request?.abort();
    const current = new AbortController(); request = current;
    const res = await fetch(path, { signal: current.signal });
    const json = await res.json();
    if (!res.ok || json.success === false || json.needsProject) throw new Error(json.message || t('council_choose_project'));
    return json;
}
const reload = async () => { data = await load(`/api/council/room?${q(`&slug=${encodeURIComponent(slug)}`)}`); renderRoom(); };

function follow() {
    closeStream();
    const since = data.log.length ? data.log[data.log.length - 1].id : 0;
    source = new EventSource(`/api/council/events?${q(`&slug=${encodeURIComponent(slug)}&since=${since}`)}`);
    source.onmessage = async event => {
        if (!document.getElementById('view-council')?.classList.contains('active')) { closeStream(); return; }
        const m = JSON.parse(event.data);
        if (data.log.some(x => x.id === m.id)) return;
        const follows = !round || round === data.status.round;
        try { await reload(); if (follows) { round = null; renderRoom(); } } catch { }
    };
    // EventSource reconnects by itself after a blip or a dashboard restart; only the pill follows its state.
    const pill = () => document.querySelector('.cn-live')?.classList.toggle('on', source?.readyState === 1);
    source.onopen = pill;
    source.onerror = pill;
}

async function openRoom(next) {
    slug = next; round = null; filter = 'all'; open.clear(); closeStream();
    try { await reload(); follow(); renderRoom(); }
    catch (error) { if (error.name !== 'AbortError') host().innerHTML = `<p class="page-status cn-fail">${escHtml(error.message)}</p>`; }
}

export async function fetchCouncil() {
    if (!host()) return;
    closeStream();
    if (!root()) { host().innerHTML = `<p class="page-status">${t('council_choose_project')}</p>`; return; }
    try {
        const json = await load(`/api/council/rooms?${q('')}`);
        departments = json.departments || {}; seats = json.seats || {}; rooms = json.rooms || [];
        if (slug && rooms.some(r => r.slug === slug)) return openRoom(slug);
        slug = null; renderOverview();
    } catch (error) { if (error.name !== 'AbortError') host().innerHTML = `<p class="page-status cn-fail">${escHtml(error.message)}</p>`; }
}

document.addEventListener('click', event => {
    // Leaving the tab closes the live stream; a quiet room would otherwise keep it open forever.
    const nav = event.target.closest('.tab-btn, .mob-tab-btn');
    if (nav && nav.dataset.mobView !== 'council' && !(nav.getAttribute('onclick') || '').includes("'council'")) closeStream();
    const el = name => event.target.closest(`[data-council-${name}]`);
    if (el('room')) return openRoom(el('room').dataset.councilRoom);
    if (el('round')) { round = +el('round').dataset.councilRound; return renderRoom(); }
    if (el('filter')) { filter = el('filter').dataset.councilFilter; return renderRoom(); }
    if (el('expand')) { const id = +el('expand').dataset.councilExpand; open.has(id) ? open.delete(id) : open.add(id); return renderRoom(); }
    const action = el('action')?.dataset.councilAction;
    if (action === 'overview') { slug = null; data = null; fetchCouncil(); }
    if (action === 'refresh') fetchCouncil();
});
document.addEventListener('submit', async event => {
    const form = event.target.closest('[data-council-form]');
    if (!form) return;
    event.preventDefault();
    const text = form.text.value.trim();
    if (!text || !slug) return;
    form.querySelector('button').disabled = true;
    try {
        const res = await fetch('/api/council/human', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectRoot: root(), slug, text }) });
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json.message);
        await reload();
    } catch (error) { form.insertAdjacentHTML('beforebegin', `<p class="page-status cn-fail">${escHtml(error.message)}</p>`); }
    finally { form.querySelector('button')?.removeAttribute('disabled'); }
});
