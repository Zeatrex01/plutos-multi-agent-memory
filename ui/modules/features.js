// Optional-module gating. The product decision behind it (2026-08-01, owner): the core is
// the trio — prepare a project, remember across sessions, coordinate on the board — and
// everything beyond it made the first screen look like a cockpit. So the extras still ship,
// but OFF: their tabs are hidden until the user flips them on in Settings → Modules. No
// code is removed and no server behavior changes — the MCP tools all stay live for the AIs;
// this is purely which tabs a human sees.
//
// The registry below and the data-module attributes in dashboard-ui.html must agree —
// tools/smoke-test.mjs asserts it, so adding a module here without tagging its tab (or vice
// versa) fails CI instead of silently producing an untogglable tab.
import { t } from '../i18n.js';

// The defaultOn line is the product's stated purpose, not taste (owner correction,
// 2026-08-01 — the first cut hid too much): a tab that lets you SEE the shared knowledge —
// where the project stands (Report), where the code lives (Codebase Index), what the
// handoff produced (Document Hub) — IS the purpose and starts visible. A tab that adds a
// differentiator or setup depth (Dependency graph) starts
// hidden. Everything stays toggleable both ways; nothing is ever uninstalled.
export const MODULES = [
    // id = the switchView() view id, which is also the data-module value on the tab button.
    { id: 'research',  labelKey: 'tab_research',  descKey: 'module_desc_research',  defaultOn: true },
    { id: 'report',    labelKey: 'tab_report',    descKey: 'module_desc_report',    defaultOn: true },
    // On by default: the project's own ledger reads local files only; CodeBurn waits for its button.
    { id: 'costs',     labelKey: 'tab_codeburn',  descKey: 'module_desc_codeburn',  defaultOn: true },
    { id: 'codeindex', labelKey: 'tab_codeindex', descKey: 'module_desc_codeindex', defaultOn: true },
    { id: 'dochub',    labelKey: 'tab_dochub',    descKey: 'module_desc_dochub',    defaultOn: true },
    // Off by default: Graphify is an extra map you switch on, not part
    // of the trio. It also builds on demand and writes into the project, so a tab nobody
    // asked for should not be the thing that offers to do that.
    { id: 'graphify',  labelKey: 'tab_graphify',  descKey: 'module_desc_graphify',  defaultOn: false },
    { id: 'council',   labelKey: 'tab_council',   descKey: 'module_desc_council',   defaultOn: true },
    // On by default: the skills a project's AI tools read are shared knowledge of the same kind as
    // the report and the code map, and the page is also where a pack is switched on.
    { id: 'skills',    labelKey: 'tab_skills',    descKey: 'module_desc_skills',    defaultOn: true }
];

const isDefault = m => m.defaultOn;

const STORAGE_KEY = 'plutos-modules';

const allIds = () => MODULES.map(m => m.id);
const defaultIds = () => MODULES.filter(isDefault).map(m => m.id);

// Stored shape: { on: [ids], known: [ids] }. The `known` half is the whole point. The
// previous version stored a bare array of enabled ids, which made absence mean two
// different things — "the user switched this off" and "this module did not exist when the
// choice was saved" — and the merge step could only assume the second. So every defaultOn
// module was pushed straight back in on the next read, and unchecking Report, Codebase
// Index or Document Hub did nothing at all. `known` records which modules the user
// has actually been offered, which restores the older invariant this broke: a stored
// choice, even an empty list, is the user's own and wins verbatim.
function readStored() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw === null) return null;
        const parsed = JSON.parse(raw);
        // The bare-array form is what older builds wrote. Everything it lists is a module
        // the user had been offered, so reading it as known preserves the one behavior that
        // form got right — a module added after the choice still gets its default — and the
        // next write upgrades the record, after which off is durable.
        if (Array.isArray(parsed)) return { on: parsed, known: parsed };
        if (parsed && Array.isArray(parsed.on) && Array.isArray(parsed.known)) return parsed;
        return null;
    } catch (e) { return null; }
}

export function enabledModules() {
    const stored = readStored();
    if (!stored) return defaultIds();
    const valid = new Set(allIds());
    const known = new Set(stored.known);
    const on = stored.on.filter(id => valid.has(id));
    MODULES.forEach(m => {
        if (isDefault(m) && !known.has(m.id) && !on.includes(m.id)) on.push(m.id);
    });
    return on;
}

function setEnabled(ids) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ on: ids, known: allIds() }));
    } catch (e) { /* private mode */ }
}

// Show/hide module tabs, then hide any nav-group header whose every tab is hidden —
// an empty "Library" heading over nothing reads as a rendering bug.
export function applyModuleFlags() {
    const on = new Set(enabledModules());
    document.querySelectorAll('.tab-btn[data-module]').forEach(btn => {
        btn.style.display = on.has(btn.getAttribute('data-module')) ? '' : 'none';
    });
    // A module that is a part of a page, not a tab (the phone access card).
    document.querySelectorAll('[data-module]:not(.tab-btn)').forEach(el => {
        el.style.display = on.has(el.getAttribute('data-module')) || el.dataset.forcedOn === '1' ? '' : 'none';
    });
    document.querySelectorAll('.nav-group').forEach(group => {
        let el = group.nextElementSibling, any = false;
        while (el && !el.classList.contains('nav-group')) {
            if (el.classList.contains('tab-btn') && el.style.display !== 'none') { any = true; break; }
            el = el.nextElementSibling;
        }
        group.style.display = any ? '' : 'none';
    });
}

window.toggleModule = function(id, checked) {
    const on = new Set(enabledModules());
    if (checked) on.add(id); else on.delete(id);
    setEnabled([...on]);
    applyModuleFlags();
    // Turning off the module whose view is open would leave the user staring at a tab that
    // no longer exists in the nav — fall back to the core landing view.
    const active = document.querySelector('.view-section.active');
    if (!checked && active && (active.id === id || active.id === 'view-' + id)) {
        const overviewBtn = document.querySelector('.tab-btn[onclick*="overview"]');
        if (overviewBtn && window.switchView) window.switchView('overview', overviewBtn);
    }
};

export function renderModuleToggles() {
    const box = document.getElementById('module-toggles');
    if (!box) return;
    const on = new Set(enabledModules());
    box.innerHTML = MODULES.map(m => `
        <label class="field-inline">
            <input type="checkbox" ${on.has(m.id) ? 'checked' : ''} onchange="toggleModule('${m.id}', this.checked)">
            <span><b>${t(m.labelKey)}</b><small>${t(m.descKey)}</small></span>
        </label>`).join('');
}
