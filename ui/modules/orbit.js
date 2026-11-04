// The live orbit: one orbit per AI connected to this project, around the shared core. The core is
// cold with nobody connected and warms with each agent; a connect or a disconnect slides a notice
// in at the corner on any page ("as many orbits as connected agents, a
// connected notice at the edge: the dashboard had become too much of a back end").
//
// The data is the MCP status the Activity page already reads (/api/mcp/status: one entry per
// connected PLUT_OS server process, with the client's name). One poll feeds every orbit on the
// page: the sidebar mark and the Home hero. Drawing stops while the tab is hidden, and with
// reduced motion the orbits are drawn still.
import { t } from '../i18n.js';
import { escHtml } from '../esc.js';

const POLL_MS = 4000;
// The owner's choices, kept per browser (notices are not forced on anyone).
const PREFS_KEY = 'plutos-orbit-prefs';
const DEFAULTS = { notices: true, duration: 'normal', motion: true, hero: true, mark: true };
const DURATIONS = { short: 2500, normal: 4200, sticky: 0 };
export function orbitPrefs() {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}
function savePrefs(patch) {
    const next = { ...orbitPrefs(), ...patch };
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* storage blocked: the choice lasts this visit */ }
    applyPrefs(); return next;
}
function applyPrefs() {
    const p = orbitPrefs();
    // toggleAttribute, not .hidden: the static mark is an SVG element, which has no hidden property.
    document.querySelectorAll('.orbit-hero').forEach(el => el.toggleAttribute('hidden', !p.hero));
    document.querySelectorAll('canvas[data-orbit="mini"]').forEach(el => el.toggleAttribute('hidden', !p.mark));
    document.querySelectorAll('.brand-logo-static').forEach(el => el.toggleAttribute('hidden', p.mark));
    kick(); orbits.forEach(o => o.draw());
}
// The core keeps amber; each client keeps one colour everywhere it appears.
const CLIENT_COLORS = [[/claude/i, '#FF9566'], [/codex|openai/i, '#3BB3A3'], [/gemini|antigravity|agy/i, '#8B7CF6'],
    [/cursor/i, '#5DA9F6'], [/copilot|vscode|code\b/i, '#E879F9'], [/windsurf|cline|roo/i, '#A3E635']];
const SPARE = ['#FACC15', '#F472B6', '#2DD4BF', '#C084FC'];
/** The client's colour when the name is a known AI client, else null (an agent's own name keeps its hue). */
export function knownClientColor(name = '') { const hit = CLIENT_COLORS.find(([re]) => re.test(name)); return hit ? hit[1] : null; }
export function clientColor(name = '') {
    const hit = CLIENT_COLORS.find(([re]) => re.test(name));
    if (hit) return hit[1];
    let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return SPARE[h % SPARE.length];
}

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const eio = x => x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
const lerp = (a, b, x) => a + (b - a) * x;
const mix = (h1, h2, x) => { const a = parseInt(h1.slice(1), 16), b = parseInt(h2.slice(1), 16);
    const c = [16, 8, 0].map(s => Math.round(lerp((a >> s) & 255, (b >> s) & 255, x))); return `rgb(${c[0]},${c[1]},${c[2]})`; };
const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
const reduced = () => !orbitPrefs().motion || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

class Orbit {
    constructor(canvas, { mini = false } = {}) {
        this.canvas = canvas; this.mini = mini; this.g = canvas.getContext('2d');
        this.agents = new Map(); // key -> { name, col, born, gone, seed }
        this.t0 = performance.now();
    }
    set(list) {
        const now = this.now(), keys = new Set(list.map(a => a.key));
        for (const a of list) if (!this.agents.has(a.key) || this.agents.get(a.key).gone) {
            this.agents.set(a.key, { name: a.name, col: clientColor(a.name), born: this.first ? now - 5 : now, gone: null, seed: Math.random() * 360 });
        }
        for (const [k, a] of this.agents) if (!keys.has(k) && a.gone === null) a.gone = now;
        this.first = false;
    }
    now() { return (performance.now() - this.t0) / 1000; }
    draw() {
        const c = this.canvas, dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
        if (!w || !h) return;
        if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
        const g = this.g, t = reduced() ? 1e6 : this.now(), still = reduced();
        g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
        for (const [k, a] of this.agents) if (a.gone !== null && t - a.gone > 1) this.agents.delete(k);
        const live = [...this.agents.values()].map(a => ({ ...a, inP: still ? 1 : eio(clamp((t - a.born) / 1)), outP: a.gone === null ? 0 : (still ? 1 : eio(clamp((t - a.gone) / .9))) }))
            .filter(a => a.outP < 1);
        const weights = live.map(a => a.inP * (1 - a.outP)), total = weights.reduce((s, x) => s + x, 0);
        let acc = 0; live.forEach((a, i) => { const mid = acc + weights[i] / 2; acc += weights[i]; a.tilt = lerp(-18, -70 + 140 * mid / (total || 1), clamp(total - 1)); });
        const warm = this.mini ? Math.max(.85, clamp(total / 3)) : clamp(total / 3), cx = w / 2, cy = h / 2, s = Math.min(w, h);
        const R = s * (this.mini ? .46 : .44), RY = .34, r = s * (this.mini ? .2 : .16);
        const pt = (tilt, deg) => { const an = deg * Math.PI / 180, q = tilt * Math.PI / 180;
            return [cx + R * Math.cos(an) * Math.cos(q) - R * RY * Math.sin(an) * Math.sin(q), cy + R * Math.cos(an) * Math.sin(q) + R * RY * Math.sin(an) * Math.cos(q)]; };
        const front = deg => Math.sin(deg * Math.PI / 180) > 0;
        const ring = (a, side) => {
            const sweep = 360 * a.inP, fade = 1 - a.outP, n = this.mini ? 48 : 120;
            g.strokeStyle = rgba(a.col, .9 * fade); g.lineWidth = this.mini ? 1.4 : Math.max(1.6, s * .006); g.lineCap = 'round';
            for (let k = 0; k < n; k++) { const d0 = a.seed + k * sweep / n, d1 = a.seed + (k + 1) * sweep / n; if (front((d0 + d1) / 2) !== side) continue;
                const [x0, y0] = pt(a.tilt, d0), [x1, y1] = pt(a.tilt, d1); g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); }
            const d = a.seed + sweep + (still ? 0 : Math.max(0, t - a.born - 1) * (30 + (a.seed % 20)));
            if (front(d) === side && a.inP > .02) { const [x, y] = pt(a.tilt, d);
                g.globalAlpha = fade; g.fillStyle = a.col; g.beginPath(); g.arc(x, y, this.mini ? 2.2 : Math.max(3, s * .018), 0, 7); g.fill(); g.globalAlpha = 1; }
        };
        // the sidebar mark stays recognisable before any AI joins: two faint brand orbits
        const idle = this.mini ? clamp(1 - total) : 0;
        if (idle > 0) { g.lineWidth = 1.4; [[-24, '#8B7CF6'], [24, '#3BB3A3']].forEach(([tilt, col]) => {
            g.strokeStyle = rgba(col, .45 * idle); g.beginPath();
            for (let k = 0; k <= 48; k++) { const [x, y] = pt(tilt, k * 7.5); k ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke(); }); }
        live.forEach(a => ring(a, false));
        // the core: cold and dim alone, warmer with each agent (the sidebar mark never fully cold)
        if (!this.mini) { const glow = g.createRadialGradient(cx, cy, r * .5, cx, cy, r * (2.2 + warm));
            glow.addColorStop(0, rgba('#F2A541', .28 * warm)); glow.addColorStop(1, 'rgba(242,165,65,0)'); g.fillStyle = glow; g.beginPath(); g.arc(cx, cy, r * 3.2, 0, 7); g.fill(); }
        const body = g.createRadialGradient(cx - r * .45, cy - r * .5, r * .05, cx - r * .1, cy - r * .1, r * 1.15);
        body.addColorStop(0, mix('#9FB4D8', '#FFD08A', warm)); body.addColorStop(.7, mix('#2B3A5E', '#E8892B', warm)); body.addColorStop(1, mix('#151E33', '#9C4E12', warm));
        g.fillStyle = body; g.beginPath(); g.arc(cx, cy, r * (1 + (still ? 0 : .03 * Math.sin(t * 2.2) * warm)), 0, 7); g.fill();
        if (!this.mini) { g.save(); g.beginPath(); g.arc(cx, cy, r, 0, 7); g.clip();
            g.strokeStyle = `rgba(255,255,255,${.07 + .05 * warm})`; g.lineWidth = r * .16; g.beginPath(); g.ellipse(cx, cy + r * .18, r * 1.1, r * .32, -.18, 0, 7); g.stroke(); g.restore(); }
        live.forEach(a => ring(a, true));
    }
}

const orbits = [];
let known = null, loop = 0, timer = 0;

function frame() { orbits.forEach(o => o.draw()); loop = document.hidden || reduced() ? 0 : requestAnimationFrame(frame); }
function kick() { if (!loop) loop = requestAnimationFrame(frame); }

// A notice in the corner: the agent's colour, what happened, and what it means for the work.
function notice(name, joined) {
    const prefs = orbitPrefs();
    if (!prefs.notices) return;
    let box = document.getElementById('agent-notices');
    if (!box) { box = document.createElement('div'); box.id = 'agent-notices'; box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
    const el = document.createElement('div');
    el.className = 'agent-notice' + (joined ? '' : ' gone');
    el.style.setProperty('--agent', clientColor(name));
    el.innerHTML = `<i></i><div><b>${escHtml(t(joined ? 'orbit_connected' : 'orbit_disconnected').replace('{name}', name))}</b>
        <span>${escHtml(t(joined ? 'orbit_connected_note' : 'orbit_disconnected_note'))}</span></div>
        <button type="button" class="agent-notice-close" aria-label="${escHtml(t('orbit_notice_close'))}" title="${escHtml(t('orbit_notice_close'))}">×</button>`;
    const close = () => { el.classList.remove('in'); setTimeout(() => el.remove(), 400); };
    el.querySelector('button').onclick = close;
    box.prepend(el);
    while (box.children.length > 4) box.lastElementChild.remove();
    requestAnimationFrame(() => el.classList.add('in'));
    const ms = DURATIONS[prefs.duration] ?? DURATIONS.normal;
    if (ms) setTimeout(close, ms);
}

function summary(list) {
    const count = document.getElementById('home-orbit-count'), names = document.getElementById('home-orbit-names');
    if (count) count.textContent = list.length
        ? t(list.length === 1 ? 'orbit_count_one' : 'orbit_count_many').replace('{n}', list.length) : t('orbit_count_none');
    if (names) names.innerHTML = list.length
        ? list.map(a => `<span class="orbit-chip" style="--agent:${clientColor(a.name)}"><i></i>${escHtml(a.name)}</span>`).join('')
        : `<span class="orbit-empty">${escHtml(t('orbit_none_hint'))}</span>`;
}

async function poll() {
    try {
        const status = await (await fetch('/api/mcp/status')).json();
        const list = Object.entries(status.clients || {}).map(([pid, c]) => ({ key: String(pid), name: c.client || 'AI' }));
        if (known) {
            const before = new Map(known.map(a => [a.key, a.name]));
            for (const a of list) if (!before.has(a.key)) notice(a.name, true);
            const now = new Set(list.map(a => a.key));
            for (const [k, n] of before) if (!now.has(k)) notice(n, false);
        }
        known = list;
        orbits.forEach(o => o.set(list));
        summary(list);
        kick(); if (reduced()) frame();
    } catch { /* the dashboard is restarting: the next poll tries again */ }
}

/** The Settings card: each switch saves at once and applies to every page. */
export function renderOrbitSettings() {
    const box = document.getElementById('orbit-settings');
    if (!box) return;
    const p = orbitPrefs();
    const sw = (key, label) => `<label class="field-inline"><input type="checkbox" data-pref="${key}"${p[key] ? ' checked' : ''}> <span>${escHtml(t(label))}</span></label>`;
    box.innerHTML = sw('notices', 'orbit_pref_notices')
        + `<label class="field-inline orbit-setting-sub"><span>${escHtml(t('orbit_pref_duration'))}</span>
            <select class="field-select field-sm" data-pref="duration"${p.notices ? '' : ' disabled'}>${['short', 'normal', 'sticky'].map(d => `<option value="${d}"${p.duration === d ? ' selected' : ''}>${escHtml(t('orbit_duration_' + d))}</option>`).join('')}</select></label>`
        + sw('hero', 'orbit_pref_hero') + sw('mark', 'orbit_pref_mark') + sw('motion', 'orbit_pref_motion')
        + `<button type="button" class="btn-secondary orbit-test">${escHtml(t('orbit_pref_test'))}</button>`;
    box.querySelectorAll('input[data-pref]').forEach(el => { el.onchange = () => { savePrefs({ [el.dataset.pref]: el.checked }); renderOrbitSettings(); }; });
    box.querySelector('select').onchange = e => savePrefs({ duration: e.target.value });
    box.querySelector('.orbit-test').onclick = () => { const was = orbitPrefs(); if (!was.notices) return; notice(known?.[0]?.name || 'Claude Code', true); };
}

/** Starts the one poll and draws every canvas marked data-orbit ("mini" for the sidebar mark). */
export function startOrbits() {
    document.querySelectorAll('canvas[data-orbit]').forEach(c => { const o = new Orbit(c, { mini: c.dataset.orbit === 'mini' }); o.first = true; orbits.push(o); });
    applyPrefs(); renderOrbitSettings();
    if (!orbits.length) return;
    poll(); clearInterval(timer); timer = setInterval(poll, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { poll(); kick(); } });
    window.addEventListener('resize', () => orbits.forEach(o => o.draw()));
}
