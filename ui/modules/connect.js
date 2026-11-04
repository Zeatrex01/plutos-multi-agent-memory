// "Connect an AI" rows on the Projects page.
//
// The problem this solves: Add Project wrote `.mcp.json` and stopped. That is Claude Code's
// convention and only Claude Code's — Cursor, VS Code, Windsurf and the rest each read a
// different file, so they genuinely had nothing to find. Each row here shows where that
// tool's config lives, whether it already points at PLUT_OS, and offers both routes: let
// PLUT_OS write it, or copy the exact snippet and paste it by hand.
import { t } from '../i18n.js';
import { showToast } from './toast.js';
import { openProjectRepair } from './repair.js';

let plan = [];
// Whether the project's launcher (.plutos/plutos-launch.mjs) exists. A project can count as
// installed by its rules file alone, and every client write needs the launcher; Repair writes it.
let launcherReady = true;

// Repair, then the step re-reads /api/connect when its dialog closes, so a written launcher
// ticks step 1 without a page refresh.
async function repairThenRefresh() {
    await openProjectRepair();
    document.getElementById('repair-dialog')?.addEventListener('close', () => fetchConnect(), { once: true });
}

function repairLauncher() {
    showToast(t('connect_launcher_missing'), 'warning');
    repairThenRefresh();
}

// textContent everywhere below: these strings carry filesystem paths.
function el(tag, style, text) {
    const n = document.createElement(tag);
    if (style) n.style.cssText = style;
    if (text != null) n.textContent = text;
    return n;
}

const PILL = { 'is-done': 'pill-done', 'is-kit': 'pill-done', 'is-open': 'pill-brand' };
function pill(text, kind) {
    const n = el('span', null, text);
    n.className = 'pill ' + (PILL[kind] || 'pill-quiet');
    return n;
}

function button(label, primary) {
    const b = el('button', null, label);
    b.type = 'button';
    b.className = (primary ? 'btn-primary' : 'btn-secondary') + ' btn-sm';
    return b;
}

function para(text, kind) {
    const n = el('p', null, text);
    if (kind) n.className = kind;
    return n;
}

function automationCard(status) {
    const card = el('div'); card.className = 'panel hub-auto';
    const head = el('div', 'display:flex; align-items:center; gap:0.6rem; flex-wrap:wrap;');
    head.append(el('strong', 'color:var(--text-title);', t('context_auto_title')),
        pill(status?.enabled ? t('context_auto_enabled') : t('context_auto_disabled'), status?.enabled ? 'is-done' : ''));
    if (status?.enabled || status?.available) {
        const toggle = button(status?.enabled ? t('context_auto_disable') : t('context_auto_enable'), !status?.enabled);
        toggle.style.marginLeft = 'auto';
        toggle.onclick = () => toggleAutomation(!status.enabled, toggle);
        head.append(toggle);
    }
    card.append(head, para(t('context_auto_desc')), para(status?.notice || t('context_auto_usage')));
    if (!status?.enabled && !status?.available) card.append(para(t('context_auto_needs_claude')));
    if (status?.error) card.append(para(status.error, 'is-warn'));
    const capture = status?.capture;
    if (capture?.queued) card.append(para(`${capture.queued} ${t('context_auto_queued')}.`));
    if (capture?.staleQueued) card.append(para(t('context_auto_stale_queue'), 'is-warn'));
    if (capture?.last?.state === 'done') {
        const label = capture.last.skipped ? t('context_auto_last_skipped') : t('context_auto_last_done');
        const counts = capture.last.context
            ? ` · ${capture.last.context.sourceBacked} source-backed, ${capture.last.context.unverified} unverified`
            : '';
        card.append(para(`${label}: ${capture.last.event || 'lifecycle'} · ${capture.last.at}${counts}`, 'is-done'));
    } else if (capture?.last?.state === 'failed') {
        card.append(para(`${t('context_auto_last_failed')}: ${capture.last.error || 'unknown error'}`, 'is-warn'));
    }
    return card;
}

function copyButton(label, text) {
    const btn = button(label, false);
    btn.onclick = async () => {
        try {
            await navigator.clipboard.writeText(text);
            showToast(t('connect_copied'));
        } catch (e) {
            // clipboard is blocked on some setups — reveal the text so it can still be taken
            // by hand rather than failing with nothing to show for it.
            const box = btn.closest('[data-row]').querySelector('[data-snippet]');
            box.style.display = 'block';
            box.focus();
            box.select();
        }
    };
    return btn;
}

function row(client, projectRoot) {
    const card = el('div'); card.className = 'hub-tool';
    card.setAttribute('data-row', client.id);

    const name = el('div'); name.className = 'hub-tool-name';
    const scope = el('span', null, client.scope === 'global' ? t('connect_scope_global')
        : client.scope === 'local' ? t('connect_scope_local') : t('connect_scope_project'));
    scope.className = 'hub-tool-scope';
    name.append(el('strong', null, client.name), pill(client.wired ? t('connect_wired') : t('connect_not_wired'), client.wired ? 'is-done' : ''), scope);

    const actions = el('div'); actions.className = 'hub-tool-actions';
    if (!client.wired) {
        // A vendor one-click install link, where the vendor actually publishes one. It hands
        // the config to the tool itself, which is better than any file PLUT_OS can write.
        if (client.deeplink) {
            const link = el('a', null, t('connect_one_click'));
            link.className = 'btn-secondary btn-sm';
            link.href = client.deeplink;
            actions.append(link);
        }
        if (client.canWrite) {
            const write = button(t('connect_write'), true);
            // Without the launcher the write is refused by the server; say why and offer Repair here.
            write.onclick = () => launcherReady ? wire(client.id, write, projectRoot) : repairLauncher();
            actions.append(write);
        }
    }
    // Already wired does not mean "never touch again": PLUT_OS's own entry can change (a
    // launcher path move, a fix like Cursor's node.exe pin) and a hand-edited file can drift.
    // Re-running the same write brings it back to PLUT_OS's current canonical entry. Gated on
    // canWrite so it never appears where PLUT_OS is not allowed to write anyway.
    if (client.wired && client.canWrite) {
        const rewrite = button(t('connect_rewrite'), false);
        rewrite.onclick = () => wire(client.id, rewrite, projectRoot);
        actions.append(rewrite);
    }
    // The prompt is the universal route: it works for configs PLUT_OS refuses to merge,
    // tools that are not installed here, and tools not on this list at all.
    actions.append(copyButton(t('connect_copy_prompt'), client.prompt));
    card.append(name, actions);

    // The file path, the notes and the by-hand snippets, one click away instead of on every row.
    const more = el('details'); more.className = 'hub-tool-more';
    more.append(el('summary', null, t('hub_details')));
    more.append(el('code', null, client.path));
    if (!client.wired && !client.canWrite) {
        more.append(para(client.format === 'toml' ? t('connect_manual_toml') : t('connect_not_installed')));
    }
    if (client.note) more.append(para(client.note));
    if (client.warning) more.append(para(client.warning, 'is-warn'));
    const copies = el('div', 'display:flex; gap:0.35rem; flex-wrap:wrap; margin-top:0.45rem;');
    copies.append(copyButton(client.format === 'toml' ? t('connect_copy_toml') : t('connect_copy_json'), client.snippet));
    if (client.command) copies.append(copyButton(t('connect_copy_cmd'), client.command));
    more.append(copies);
    card.append(more);

    // Fallback for a blocked clipboard: a real textarea, so the text can always be selected.
    const snippet = el('textarea'); snippet.className = 'field-input';
    snippet.setAttribute('data-snippet', '');
    snippet.readOnly = true;
    snippet.value = client.snippet;
    card.append(snippet);
    return card;
}

async function wire(clientId, button, projectRoot) {
    // Shared by the first-time "Set it up" and the "Reinstall" button on an already-wired
    // row, so the label restored on failure must be whichever one was actually clicked.
    const label = button.textContent;
    button.disabled = true;
    button.textContent = t('connect_writing');
    try {
        const res = await fetch('/api/connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client: clientId, projectRoot })
        });
        const data = await res.json();
        if (data.success) {
            // A config git already tracks now holds this machine's paths: the server says so.
            showToast(t('connect_written') + ' ' + data.path + (data.warning ? '. ' + data.warning : ''), data.warning ? 'warning' : false);
            await fetchConnect();
        } else {
            showToast(data.message, true);
            button.disabled = false;
            button.textContent = label;
        }
    } catch (e) {
        showToast(t('conn_error'), true);
        button.disabled = false;
        button.textContent = label;
    }
}

// Extra tools from other developers (lib/mcps.mjs RECOMMENDED_MCPS) that the owner's AI sets up on
// request: the button posts a board TODO (POST /api/install-recommended-mcp, lib/mcp-requests.mjs),
// and the AI asks global-vs-project before writing anything. This was the one useful part of the
// AI tools (MCP) page, removed on 2026-11-04.
function about(tool) {
    const key = `mcp_about_${String(tool.id).replace(/[^a-z0-9]/gi, '_')}`;
    const text = t(key);
    return text === key ? tool.desc : text;
}

async function requestTool(tool, button) {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = t('mcp_working');
    try {
        const res = await fetch('/api/install-recommended-mcp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: tool.id })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.message);
        showToast(t(data.requested?.length ? 'mcp_requested' : 'mcp_already_requested').replace('{name}', tool.name));
        await fetchConnect();
        return;
    } catch (e) {
        showToast(e.message || t('conn_error'), true);
    }
    button.disabled = false;
    button.textContent = label;
}

function extraTools(recommended) {
    const tools = (recommended || []).filter(tool => tool.viaBoard);
    if (!tools.length) return null;
    const li = el('li'); li.className = 'hub-step';
    const mark = el('span', null, '+'); mark.className = 'hub-step-num';
    const main = el('div', 'min-width:0;');
    const head = el('div'); head.className = 'hub-step-head';
    head.append(el('strong', null, t('connect_extra_tools')));
    const list = el('div'); list.className = 'hub-tools';
    for (const tool of tools) {
        const card = el('div'); card.className = 'hub-tool';
        const name = el('div'); name.className = 'hub-tool-name';
        name.append(el('strong', null, tool.name));
        const actions = el('div'); actions.className = 'hub-tool-actions';
        const ask = button(t('mcp_ask_ai_setup'), false);
        ask.onclick = () => requestTool(tool, ask);
        actions.append(ask);
        if (tool.link) {
            const link = el('a', null, t('btn_view_docs'));
            link.className = 'btn-secondary btn-sm';
            link.href = tool.link; link.target = '_blank'; link.rel = 'noopener noreferrer';
            actions.append(link);
        }
        card.append(name, actions, el('p', 'grid-column:1 / -1; margin:0; color:var(--text-muted); font-size:.78rem; line-height:1.5;', about(tool)));
        list.append(card);
    }
    main.append(head, para(t('mcp_via_board_intro'), 'hub-step-note'), list);
    li.append(mark, main);
    return li;
}

// The four tools most people use stay in view; the rest are one click away. A tool already
// connected is always in view, wherever it sits in that order.
const MAIN_TOOLS = ['claude-code', 'codex', 'gemini-cli', 'cursor'];

function step(num, done, locked, title, status, action, ...body) {
    const li = el('li'); li.className = 'hub-step' + (done ? ' is-done' : '') + (locked ? ' is-locked' : '');
    const mark = el('span', null, done ? '✓' : String(num)); mark.className = 'hub-step-num';
    const main = el('div', 'min-width:0;');
    const head = el('div'); head.className = 'hub-step-head';
    head.append(el('strong', null, title));
    if (status) head.append(status);
    if (action) head.append(action);
    main.append(head, ...body.filter(Boolean));
    li.append(mark, main);
    return li;
}

function render(clients, { installed = true, launcher = installed, automation = null, projectRoot = null, recommended = null } = {}) {
    plan = clients || [];
    launcherReady = !!launcher;
    const host = document.getElementById('connect-rows');
    if (!host) return;
    if (!plan.length) { host.replaceChildren(); return; }

    let install = null;
    if (!installed) {
        install = button(t('connect_install_kit'), true);
        install.onclick = () => installProjectKit(install);
    } else if (!launcher) {
        // The rules file is there but the launcher is not (a clone, where it is git-ignored):
        // step 1 is not done, and Repair, which writes the launcher, is offered on the step.
        install = button(t('connect_repair'), true);
        install.onclick = () => repairThenRefresh();
    }
    const kitDone = installed && !!launcher;
    // Done shows as the check mark; the pill is there only while the step is still needed.
    const kit = step(1, kitDone, false, t('hub_step_kit'),
        kitDone ? null : pill(t(installed ? 'hub_step_launcher_missing' : 'hub_step_needed')), install,
        para(t(kitDone ? 'hub_step_kit_done' : installed ? 'connect_launcher_missing' : 'connect_observe_desc'), 'hub-step-note'));

    const wired = plan.filter(client => client.wired).length;
    const count = pill(`${wired} / ${plan.length} ${t('hub_connected')}`, wired ? 'is-done' : '');
    let connect;
    if (!installed) {
        // Before the kit there is nothing for a tool to connect to, so no buttons: the names
        // say what will be offered, the note says what unlocks it.
        const chips = el('div'); chips.className = 'hub-tool-chips';
        chips.append(...plan.map(client => pill(client.name)));
        connect = step(2, false, true, t('connect_title'), count, null, para(t('hub_step_connect_locked'), 'hub-step-note'), chips);
    } else {
        const shown = plan.filter(client => client.wired || MAIN_TOOLS.includes(client.id));
        const rest = plan.filter(client => !shown.includes(client));
        const list = el('div'); list.className = 'hub-tools';
        list.append(...shown.map(client => row(client, projectRoot)));
        let more = null;
        if (rest.length) {
            more = el('details'); more.className = 'hub-more-tools';
            more.append(el('summary', null, `${t('hub_more_tools')} (${rest.length})`));
            const extra = el('div'); extra.className = 'hub-tools';
            extra.append(...rest.map(client => row(client, projectRoot)));
            more.append(extra);
        }
        connect = step(2, wired > 0, false, t('connect_title'), count, null,
            para(t('hub_step_connect_note'), 'hub-step-note'), list, more, automation ? automationCard(automation) : null);
    }
    // The extra tools need the kit (the request is refused without it), so they wait for step 1.
    const extras = installed ? extraTools(recommended) : null;
    host.replaceChildren(...[kit, connect, extras].filter(Boolean));
}

async function toggleAutomation(enabled, button) {
    if (enabled && !confirm(t('context_auto_confirm'))) return;
    button.disabled = true;
    button.textContent = t('context_auto_working');
    try {
        const res = await fetch('/api/context/automation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled })
        });
        const data = await res.json();
        if (!data.success) {
            showToast(data.message, true);
            button.disabled = false;
            button.textContent = enabled ? t('context_auto_enable') : t('context_auto_disable');
            return;
        }
        showToast(data.message);
        await fetchConnect();
    } catch (e) {
        showToast(t('conn_error'), true);
        button.disabled = false;
        button.textContent = enabled ? t('context_auto_enable') : t('context_auto_disable');
    }
}

async function installProjectKit(button) {
    if (!confirm(t('connect_install_kit_confirm'))) return;
    button.disabled = true;
    button.textContent = t('connect_installing_kit');
    try {
        const data = await (await fetch('/api/project/install', { method: 'POST' })).json();
        if (!data.success) {
            showToast(data.message, true);
            button.disabled = false;
            button.textContent = t('connect_install_kit');
            return;
        }
        showToast(data.message);
        // Coordination roots move from the Hub sidecar into the project, so refresh every
        // project-dependent module together instead of leaving half the page on old data.
        location.reload();
    } catch (e) {
        showToast(t('conn_error'), true);
        button.disabled = false;
        button.textContent = t('connect_install_kit');
    }
}

export async function fetchConnect() {
    try {
        const [data, automation, extra] = await Promise.all([
            fetch('/api/connect').then(response => response.json()),
            fetch('/api/context/automation').then(response => response.json()).catch(() => null),
            fetch('/api/recommended-mcps').then(response => response.json()).catch(() => null)
        ]);
        render(data.clients, { ...data, automation, recommended: extra?.recommended });
    } catch (e) {
        showToast(t('conn_error'), true);
    }
}

window.fetchConnect = fetchConnect;
