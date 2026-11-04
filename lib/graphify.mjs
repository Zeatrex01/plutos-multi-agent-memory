// Graphify — the project's code graph: which source file imports which, or names a type that
// exactly one other file declares. (A second, `docs` mode went on 2026-10-28: it recomputed the
// document-to-file links the Document Hub's drift check already computes.)
//
// This used to shell out to `python tools/graphify-builder.py`, which imported a
// third-party `graphify` pip package that is not vendored here. On a machine without that
// package — which is every clean checkout, and every portable `dist/` build, since the exe
// bundles Node and not Python — it failed with ModuleNotFoundError. The runner discarded
// stderr, so the failure arrived as a blank map with no reason attached. That is why the
// codebase map never appeared.
//
// So it is native Node now: no Python, no pip, no network, nothing to install. It reuses
// the walker that already knows which directories to skip (lib/codeindex.mjs).
//
// The output filenames are unchanged on purpose: dashboard.mjs's routes and the graph page
// read `graphify-out/code_graph.{json,html}` and the report markdown beside them.
import fs from 'fs';
import path from 'path';
import { walk, capFiles, isSourceNewerThan } from './codeindex.mjs';

const CODE_EXTS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.cs', '.go',
    '.rs', '.java', '.cpp', '.c', '.h', '.hpp', '.gd', '.lua', '.php', '.rb', '.swift', '.kt'];

// Only relative specifiers become edges. A bare `react` or `express` is a package, not a
// part of this project's shape, and drawing every dependency as a node buries the code the
// graph exists to show.
const IMPORT_PATTERNS = [
    /import\s+[^'"()]*from\s*['"]([^'"]+)['"]/g,   // import x from './y'
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,        // await import('./y')
    /import\s*['"]([^'"]+)['"]/g,                  // import './y'
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,       // require('./y')
    /from\s+['"]([^'"]+)['"]/g                     // export ... from './y'
];

// Those five patterns are JS/TS syntax, but CODE_EXTS above lists twenty languages. A C#
// `using Demo;`, a Python `from app import Widget`, a Go `import "./pkg"` — none of them
// name a file the way a bundler does, so every non-JS project scanned to a pile of nodes
// with zero edges and still reported success: a blank map with no reason attached, which is
// the exact failure the Python runner was replaced to stop. So those languages get a second
// kind of edge, drawn from what each file DECLARES rather than what it imports: if a file
// names a type that exactly one other file declares, it depends on that file.
const JS_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);

// Up to five modifier words (public sealed partial ...) before the keyword, so C#, Java,
// Kotlin, Swift, Rust and Python all land with one pattern. Go's `type Foo struct` and the
// top-level function forms get their own — and only top-level: the function pattern is
// anchored at column 0, because an indented `def process(self)` is a method, and a method
// name is exactly the kind of identifier (`process`, `update`, `get`) that some unrelated
// object elsewhere also answers to. Measured: the indented form drew a wrong edge from an
// unrelated `q.process()` call; column-0 only lost no correct edge in six languages and
// keeps GDScript and Lua, whose only declarations are functions, on the map.
// `class_name` comes before `class` on purpose: the alternation is tried left to right, and
// `class` matches the first five characters of `class_name Player` and then fails on the
// underscore where it wants whitespace — without this, every GDScript type declaration is
// invisible and a GDScript project's edges come only from shared function names.
const DECL_PATTERNS = [
    /^[^\S\n]*(?:\w+[^\S\n]+){0,5}(?:class_name|class|interface|struct|enum|trait|protocol|record)[^\S\n]+(\w+)/gm,
    /^[^\S\n]*type[^\S\n]+(\w+)[^\S\n]+(?:struct|interface)/gm,
    /^(?:pub[^\S\n]+)?(?:async[^\S\n]+)?(?:def|func|fn|function)[^\S\n]+(\w+)/gm
];

// JS/TS draws its edges from imports, so its declarations never enter the owner table above.
// lib/task-context.mjs still needs them, to say which file defines `answerApproval`; this
// pattern adds the exported top-level forms for that list only and draws no edge.
const JS_DECL = /^export[^\S\n]+(?:default[^\S\n]+)?(?:async[^\S\n]+)?(?:function\*?|class|const|let|var)[^\S\n]+(\w+)/gm;

// A symbol named inside a comment or a string literal is talk about the code, not a use of
// it, and an edge drawn from talk is the wrong-edge case this file already refuses to make.
// One pass, one alternation, whichever token starts first wins — a lexer, not a chain of
// replaces. The chain was wrong in a way that only shows on real code: a `#` inside a
// docstring (`"""Item #1"""`) let the comment pass delete the closing fence, and the
// triple-quote pass then swallowed everything up to the next `"""` in the file, class
// declarations included. A class thereby hidden flipped its name from ambiguous to owned by
// the other file that declared it, and a third file drew an edge to the wrong one.
// Triple-quoted blocks (Python and GDScript docstrings, C# raw strings) span lines; the
// single-quote forms stop at a newline so one unbalanced quote cannot eat a file.
const NOISE = /\/\*[\s\S]*?\*\/|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|(^|[^:\w])\/\/[^\n]*|(^|\s)#[^\n]*/gm;

function stripNoise(src) {
    return src.replace(NOISE, (m, slash, hash) => slash ?? hash ?? ' ');
}

function declaredSymbols(clean, patterns = DECL_PATTERNS) {
    const out = new Set();
    for (const re of patterns) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(clean))) if (m[1] && m[1].length >= 3) out.add(m[1]);
    }
    return out;
}

const rel = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

// ---------------------------------------------------------------------------- code graph

// Resolve a relative import the way a bundler would, minus the cleverness: exact hit, then
// the usual extensions, then a directory's index file. An unresolvable specifier is dropped
// rather than guessed — a wrong edge is worse than a missing one on a map you navigate by.
function resolveImport(fromAbs, spec, root) {
    if (!spec.startsWith('.')) return null;
    const base = path.resolve(path.dirname(fromAbs), spec);
    const candidates = [base, ...CODE_EXTS.map(e => base + e),
        ...CODE_EXTS.map(e => path.join(base, 'index' + e))];
    for (const cand of candidates) {
        try {
            if (fs.statSync(cand).isFile()) {
                const r = rel(root, cand);
                return r.startsWith('..') ? null : r;   // never leave the project
            }
        } catch (e) { /* not this one */ }
    }
    return null;
}

function importsOf(abs, root, symbols = null) {
    let raw;
    try { raw = fs.readFileSync(abs, 'utf8'); } catch (e) { return []; }
    if (raw.length > 400_000) raw = raw.slice(0, 400_000);   // a minified bundle is not source
    if (symbols) symbols.set(rel(root, abs), [...declaredSymbols(stripNoise(raw), [...DECL_PATTERNS, JS_DECL])]);
    const out = new Set();
    for (const re of IMPORT_PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(raw))) {
            const target = resolveImport(abs, m[1], root);
            if (target) out.add(target);
        }
    }
    return [...out];
}

// `withSymbols` adds what each file declares, for lib/task-context.mjs. The map is in memory
// only: it is never written to graphify-out, whose JSON shape the dashboard already reads.
function buildCodeGraph(root, { withSymbols = false } = {}) {
    const { files } = capFiles(walk(root, CODE_EXTS));
    const symbols = withSymbols ? new Map() : null;
    const nodes = new Map();
    const links = [];

    const addNode = (id) => {
        if (!nodes.has(id)) {
            nodes.set(id, {
                id,
                label: path.basename(id),
                group: id.includes('/') ? id.split('/')[0] : 'root',
                title: id,
                degree: 0
            });
        }
        return nodes.get(id);
    };

    for (const abs of files) addNode(rel(root, abs));

    for (const abs of files) {
        const from = rel(root, abs);
        const isJs = JS_EXTS.has(path.extname(abs).toLowerCase());
        for (const target of importsOf(abs, root, isJs ? symbols : null)) {
            if (target === from) continue;
            addNode(target);
            links.push({ source: from, target, type: 'imports' });
            nodes.get(from).degree++;
            nodes.get(target).degree++;
        }
    }

    // Symbol edges, for the languages a path resolver cannot reach. Read each non-JS file
    // once: its identifiers for the reference pass, its declarations for the owner table.
    // The identifiers are a Set, tokenized once per file, rather than the stripped text: the
    // reference pass below visits every (file, symbol) pair, and compiling a `\bsym\b` regex
    // for each of them scaled as files x symbols — about a second for 400 files, fifteen for
    // a large C# project — where a Set lookup is constant. Same answer: a `\w+` run is exactly
    // what `\b...\b` around a `\w+` symbol matches.
    const owner = new Map();       // symbol -> relative path, or null once it is ambiguous
    const identsOf = new Map();    // relative path -> Set of identifiers, comments and strings gone
    for (const abs of files) {
        if (JS_EXTS.has(path.extname(abs).toLowerCase())) continue;
        let raw;
        try { raw = fs.readFileSync(abs, 'utf8'); } catch (e) { continue; }
        if (raw.length > 400_000) raw = raw.slice(0, 400_000);
        // The function pattern is anchored at column 0, and a BOM is column 0.
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
        const relPath = rel(root, abs);
        const clean = stripNoise(raw);
        identsOf.set(relPath, new Set(clean.match(/\w+/g) || []));
        const declared = declaredSymbols(clean);
        if (symbols) symbols.set(relPath, [...declared]);
        for (const sym of declared) {
            // A name two files both declare cannot say which one a third file meant, and a
            // guess here is the wrong edge. Drop it for everyone.
            owner.set(sym, owner.has(sym) ? null : relPath);
        }
    }

    const drawn = new Set();
    for (const [from, idents] of identsOf) {
        for (const [sym, target] of owner) {
            if (!target || target === from) continue;
            const key = from + '\u0000' + target;
            if (drawn.has(key)) continue;
            if (!idents.has(sym)) continue;
            drawn.add(key);
            addNode(target);
            links.push({ source: from, target, type: 'references' });
            nodes.get(from).degree++;
            nodes.get(target).degree++;
        }
    }

    return { mode: 'code', nodes: [...nodes.values()], links, fileCount: files.length, ...(symbols ? { symbols } : {}) };
}

// The code graph plus each file's declared symbols, built in memory and written nowhere.
export function scanCodeGraph(root) {
    return buildCodeGraph(root, { withSymbols: true });
}

export { CODE_EXTS };

// ------------------------------------------------------------------------------- output

// vis-network comes from the dashboard's own vendored copy (`ui/vendor/`), the same one the
// code map and the Documents page draw with. The page is served from /api/graphify/html, so that
// path resolves; nothing is fetched off this machine. Opened straight off disk instead, the data
// is still there but the library will not load, and the page says so rather than showing an
// empty canvas.
//
// What the page does while it opens (the canvas was black and empty although
// the header said 322 nodes): vis draws nothing until the layout has settled, which took 5.5 s on
// PLUT_OS's own 322 files, so the page shows the progress of that work instead of a blank frame.
// The layout is forceAtlas2, which settles about three times sooner here and fills the frame at
// three times the zoom, so the most connected files can be read at the first view. It follows the
// dashboard's light or dark theme, and takes its words from the dashboard's dictionary when it can
// reach it (English otherwise).
const PAGE_STRINGS = {
    hud: '{files} files · {links} links',
    hint: 'Scroll to zoom, drag to move. Point at a dot to see its file.',
    arranging: 'Arranging {files} files… {pct}%',
    fit: 'Show all',
    settleOn: 'Live layout: on',
    settleOff: 'Live layout: off',
    settleHint: 'When on, dragging a dot pushes its neighbours aside.',
    links: '{n} links',
    empty: 'This graph has no files in it. Build it again from the dashboard.',
    legend: 'Colours are top-level folders',
    root: 'top folder',
    shown: 'Showing the {shown} most connected of {files} files · {links} links',
    limitN: '{n} files',
    limitAll: 'All files (slow on big projects)',
    limitLabel: 'How many files to draw',
    folderAll: 'All folders',
    folderLabel: 'Only this top folder'
};
const PAGE_KEYS = {
    hud: 'depgraph_page_hud', hint: 'depgraph_page_hint', arranging: 'depgraph_page_arranging', fit: 'depgraph_page_fit',
    settleOn: 'depgraph_page_settle_on', settleOff: 'depgraph_page_settle_off', settleHint: 'depgraph_page_settle_hint',
    links: 'depgraph_page_links', empty: 'depgraph_page_empty', legend: 'depgraph_page_legend', root: 'maps_root_folder',
    shown: 'depgraph_page_shown', limitN: 'depgraph_page_limit_n', limitAll: 'depgraph_page_limit_all',
    limitLabel: 'depgraph_page_limit_label', folderAll: 'depgraph_page_folder_all', folderLabel: 'depgraph_page_folder_label'
};

function renderHtml(graph, title) {
    const json = value => JSON.stringify(value).replace(/</g, '\\u003c');
    const payload = json({ nodes: graph.nodes, links: graph.links });
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<script src="/ui/vendor/vis-network.min.js"></script>
<style>
  :root{--bg:#fbfbfa;--panel:#ffffff;--line:#d6d5d0;--title:#1b1c21;--body:#4c515b;--brand:#b45309;--on-brand:#ffffff;color-scheme:light;}
  :root[data-theme="dark"]{--bg:#16213a;--panel:#111a2e;--line:#2d3e60;--title:#eef1f7;--body:#a9b3c6;--brand:#f2a541;--on-brand:#101826;color-scheme:dark;}
  html,body{margin:0;height:100%;background:var(--bg);color:var(--title);
    font-family:-apple-system,"Segoe UI",system-ui,Roboto,sans-serif;}
  #net{width:100%;height:100%;}
  .panel{position:fixed;z-index:5;background:var(--panel);border:1px solid var(--line);border-radius:8px;}
  #hud{top:10px;left:10px;max-width:calc(100% - 250px);padding:6px 10px;font-size:.8rem;line-height:1.45;color:var(--body);}
  #hud b{color:var(--title);}
  #ctl{top:10px;right:10px;display:none;gap:6px;background:none;border:0;}
  #ctl button{background:var(--panel);color:var(--title);border:1px solid var(--line);border-radius:6px;
    padding:6px 10px;font:inherit;font-size:.78rem;cursor:pointer;min-height:32px;}
  #ctl button:hover{border-color:var(--brand);}
  #ctl select{background:var(--panel);color:var(--title);border:1px solid var(--line);border-radius:6px;padding:4px 6px;font:inherit;font-size:.8rem;max-width:180px;}
  #ctl button:focus-visible{outline:2px solid var(--brand);outline-offset:2px;}
  #ctl button[aria-pressed="true"]{background:var(--brand);color:var(--on-brand);border-color:var(--brand);}
  #legend{left:10px;bottom:10px;display:none;flex-wrap:wrap;gap:4px 12px;max-width:calc(100% - 22px);
    padding:6px 10px;font-size:.75rem;color:var(--body);}
  #legend span{display:inline-flex;align-items:center;gap:5px;}
  #legend i{width:10px;height:10px;border-radius:50%;flex-shrink:0;}
  #busy{position:fixed;inset:0;z-index:6;display:flex;flex-direction:column;align-items:center;justify-content:center;
    gap:10px;color:var(--body);font-size:.9rem;background:var(--bg);}
  #busy .bar{width:min(280px,60vw);height:4px;border-radius:2px;background:var(--line);overflow:hidden;}
  #busy .bar span{display:block;height:100%;width:0;background:var(--brand);transition:width .2s;}
  #note{position:fixed;inset:0;z-index:7;display:none;align-items:center;justify-content:center;
    text-align:center;padding:2rem;font-size:.9rem;color:var(--body);background:var(--bg);}
  html body div.vis-tooltip{background:var(--panel);color:var(--title);border:1px solid var(--line);border-radius:6px;
    font-family:inherit;font-size:.78rem;padding:4px 8px;box-shadow:0 2px 8px rgba(0,0,0,.18);}
  @media (max-width:560px){#hud{max-width:calc(100% - 22px);}#ctl{top:auto;bottom:10px;}#legend{bottom:54px;}}
  @media (prefers-reduced-motion:reduce){#busy .bar span{transition:none;}}
</style></head><body>
<div id="net" role="img"></div>
<div id="hud" class="panel"><b id="hud-count"></b><br><span id="hud-hint"></span></div>
<div id="ctl" class="panel">
  <select id="limit"></select>
  <select id="folder"></select>
  <button id="physics" type="button" aria-pressed="false"></button>
  <button id="refit" type="button"></button>
</div>
<div id="legend" class="panel"></div>
<div id="busy" role="status" aria-live="polite"><span id="busy-text"></span><div class="bar"><span id="busy-bar"></span></div></div>
<div id="note">This map is served by PLUT_OS. Open it from the dashboard's Dependency graph page
rather than from disk, so the graph library can load.</div>
<script>
const DATA = ${payload};
const EN = ${json(PAGE_STRINGS)};
const KEYS = ${json(PAGE_KEYS)};
const $ = id => document.getElementById(id);
const fill = (text, vars) => Object.keys(vars).reduce((s, k) => s.split('{' + k + '}').join(vars[k]), text);
let tr = key => EN[key];

// The dashboard's own theme when this page sits in its frame; else the saved choice; else the OS.
function themeMode() {
  try {
    const framed = window.parent !== window && window.parent.document.documentElement.getAttribute('data-theme');
    if (framed === 'light' || framed === 'dark') return framed;
  } catch (e) { /* a different origin: fall through */ }
  let saved = null;
  try { saved = localStorage.getItem('plutos-mode'); } catch (e) { /* storage blocked */ }
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
// Light uses 700-level hues and dark 300/400-level ones: each keeps 3:1 against its own canvas.
const PALETTE = {
  light: ['#b45309','#0f766e','#5b4bc4','#1d4ed8','#c2410c','#a21caf','#4d7c0f','#a16207','#0e7490','#be185d'],
  dark: ['#f2a541','#3bb3a3','#8b7cf6','#5da9f6','#ff9566','#e879f9','#a3e635','#facc15','#2dd4bf','#f472b6']
};
const INK = {
  light: { bg: '#fbfbfa', title: '#1b1c21', edge: 'rgba(76,81,91,0.22)', brand: '#b45309' },
  dark: { bg: '#16213a', title: '#eef1f7', edge: 'rgba(170,176,187,0.2)', brand: '#f2a541' }
};
document.documentElement.setAttribute('data-theme', themeMode());

const counts = {};
DATA.nodes.forEach(n => { counts[n.group] = (counts[n.group] || 0) + 1; });
const groups = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
const groupName = g => (g === 'root' ? tr('root') : g);

// How much is drawn (a graph with many links froze the page). The most
// connected files first, up to the chosen limit, optionally one top folder; links only between
// drawn files. The choice is kept per browser and the page reloads to apply it.
const LIMITS = [150, 300, 600, 0];
const VIEW_KEY = 'plutos-depgraph-view';
let view = { limit: 300, folder: '' };
try { view = Object.assign(view, JSON.parse(localStorage.getItem(VIEW_KEY) || '{}')); } catch (e) { /* storage blocked */ }
view.limit = Number(view.limit);
if (!LIMITS.includes(view.limit)) view.limit = 300;
if (view.folder && !counts[view.folder]) view.folder = '';
const ALL = { nodes: DATA.nodes.length, links: DATA.links.length };
(function narrow() {
  let pool = view.folder ? DATA.nodes.filter(n => n.group === view.folder) : DATA.nodes.slice();
  pool.sort((a, b) => b.degree - a.degree || (a.id < b.id ? -1 : 1));
  if (view.limit) pool = pool.slice(0, view.limit);
  const keep = new Set(pool.map(n => n.id));
  DATA.nodes = pool;
  DATA.links = DATA.links.filter(l => keep.has(l.source) && keep.has(l.target));
})();
function saveView(patch) {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(Object.assign({}, view, patch))); } catch (e) { /* storage blocked */ }
  location.reload();
}

if (typeof vis === 'undefined') {
  $('busy').style.display = 'none';
  $('note').style.display = 'flex';
} else if (!DATA.nodes.length) {
  $('busy').style.display = 'none';
  $('note').textContent = EN.empty;
  $('note').style.display = 'flex';
} else {
  start();
}

function start() {
  const mode = themeMode();
  const colorOf = (g, m) => PALETTE[m][groups.indexOf(g) % PALETTE[m].length];
  const look = (n, m) => {
    const c = colorOf(n.group, m);
    return {
      color: { background: c, border: c, highlight: { background: c, border: INK[m].brand }, hover: { background: c, border: INK[m].brand } },
      font: { color: INK[m].title, size: 12, strokeWidth: 3, strokeColor: INK[m].bg }
    };
  };
  // No \`group\` field: vis would paint its own group palette over these colours.
  const nodes = new vis.DataSet(DATA.nodes.map(n => Object.assign({
    id: n.id, label: n.label, folder: n.group, value: 1 + n.degree,
    title: n.title + ' · ' + fill(tr('links'), { n: n.degree })
  }, look(n, mode))));
  const edges = new vis.DataSet(DATA.links.map((l, i) => ({ id: i, from: l.source, to: l.target, arrows: { to: { enabled: true, scaleFactor: 0.35 } } })));
  // A flat iteration count under-solved every graph bigger than the one it was tuned on; the
  // budget grows with the graph, with a ceiling so a huge project still opens promptly.
  const ITERATIONS = Math.min(600, 200 + DATA.nodes.length * 2);
  const net = new vis.Network($('net'), { nodes, edges }, {
    // A fixed seed: the same project opens to the same picture, so its shape can be recognised.
    layout: { improvedLayout: false, randomSeed: 7 },
    // Label size follows how connected a file is, and a label under 7 px is not drawn: the most
    // connected files are named at the first view, the rest when you zoom in.
    nodes: { shape: 'dot', scaling: { min: 6, max: 30, label: { enabled: true, min: 11, max: 34, drawThreshold: 8, maxVisible: 22 } } },
    edges: { smooth: false, width: 0.6, color: { color: INK[mode].edge, highlight: INK[mode].brand, hover: INK[mode].brand } },
    physics: { solver: 'forceAtlas2Based', stabilization: { iterations: ITERATIONS },
      forceAtlas2Based: { gravitationalConstant: -60, centralGravity: 0.03, springLength: 80, springConstant: 0.06,
        damping: 0.5, avoidOverlap: 0.6 } },
    interaction: { hover: true, tooltipDelay: 120, keyboard: { enabled: true, bindToWindow: false } }
  });

  let physicsOn = true;
  const physicsBtn = $('physics');
  const setPhysics = (on) => {
    physicsOn = on;
    net.setOptions({ physics: on });
    physicsBtn.textContent = tr(on ? 'settleOn' : 'settleOff');
    physicsBtn.setAttribute('aria-pressed', String(on));
  };
  physicsBtn.addEventListener('click', () => setPhysics(!physicsOn));
  $('limit').addEventListener('change', e => saveView({ limit: Number(e.target.value) }));
  $('folder').addEventListener('change', e => saveView({ folder: e.target.value }));
  const still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  $('refit').addEventListener('click', () => net.fit({ animation: still ? false : { duration: 400 } }));

  let pct = 0;
  const words = () => {
    $('hud-count').textContent = DATA.nodes.length < ALL.nodes
      ? fill(tr('shown'), { shown: DATA.nodes.length, files: ALL.nodes, links: DATA.links.length })
      : fill(tr('hud'), { files: DATA.nodes.length, links: DATA.links.length });
    const limitBox = $('limit');
    limitBox.textContent = '';
    LIMITS.forEach(n => limitBox.add(new Option(n ? fill(tr('limitN'), { n }) : tr('limitAll'), String(n), false, n === view.limit)));
    limitBox.title = tr('limitLabel');
    limitBox.setAttribute('aria-label', tr('limitLabel'));
    const folderBox = $('folder');
    folderBox.textContent = '';
    folderBox.add(new Option(tr('folderAll'), '', false, !view.folder));
    groups.forEach(g => folderBox.add(new Option(groupName(g) + ' (' + counts[g] + ')', g, false, g === view.folder)));
    folderBox.title = tr('folderLabel');
    folderBox.setAttribute('aria-label', tr('folderLabel'));
    $('hud-hint').textContent = tr('hint');
    $('busy-text').textContent = fill(tr('arranging'), { files: DATA.nodes.length, pct });
    $('refit').textContent = tr('fit');
    physicsBtn.textContent = tr(physicsOn ? 'settleOn' : 'settleOff');
    physicsBtn.title = tr('settleHint');
    $('net').setAttribute('aria-label', $('hud-count').textContent);
    $('legend').setAttribute('aria-label', tr('legend'));
    $('legend').title = tr('legend');
  };
  const legend = () => {
    const m = themeMode();
    const box = $('legend');
    box.textContent = '';
    groups.forEach(g => {
      const item = document.createElement('span');
      const dot = document.createElement('i');
      dot.style.background = colorOf(g, m);
      item.append(dot, document.createTextNode(groupName(g) + ' ' + counts[g]));
      box.appendChild(item);
    });
  };
  const repaint = () => {
    const m = themeMode();
    document.documentElement.setAttribute('data-theme', m);
    nodes.update(DATA.nodes.map(n => Object.assign({ id: n.id }, look(n, m))));
    net.setOptions({ edges: { color: { color: INK[m].edge, highlight: INK[m].brand, hover: INK[m].brand } } });
    legend();
  };
  words();
  legend();

  net.on('stabilizationProgress', p => {
    pct = Math.round(100 * p.iterations / Math.max(1, p.total));
    $('busy-bar').style.width = pct + '%';
    $('busy-text').textContent = fill(tr('arranging'), { files: DATA.nodes.length, pct });
  });
  // Stop the simulation once it has run its budget — 'stabilizationIterationsDone', not
  // 'stabilized', because a dense layout never drops under the velocity threshold the latter
  // waits for and the map would sit half off-screen burning CPU. But stopping the simulation is
  // not the same as taking it away: switching physics off for good left every dense graph frozen
  // in whatever knot the last iteration ended on, where dragging a node moved that node and
  // nothing else. The button hands the simulation back whenever the reader wants it.
  net.once('stabilizationIterationsDone', () => {
    $('busy').style.display = 'none';
    $('ctl').style.display = 'flex';
    $('legend').style.display = 'flex';
    setPhysics(false);
    net.fit({ animation: still ? false : { duration: 400 } });
  });

  // A theme switch in the dashboard reaches this frame as a storage event; the OS one through
  // the media query.
  window.addEventListener('storage', e => { if (e.key === 'plutos-mode') repaint(); });
  if (window.matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener('change', repaint);

  // The dashboard's dictionary, when this page is served by the dashboard; off disk the import
  // fails and the English above stays.
  import('/ui/i18n.js').then(i18n => {
    i18n.initLanguage();
    document.documentElement.lang = i18n.currentLang;
    tr = key => { const v = i18n.t(KEYS[key]); return v && v !== KEYS[key] ? v : EN[key]; };
    words();
    legend();
    nodes.update(DATA.nodes.map(n => ({ id: n.id, title: n.title + ' · ' + fill(tr('links'), { n: n.degree }) })));
  }).catch(() => { /* opened off disk */ });
}
</script></body></html>`;
}

// The page the dashboard serves, drawn from the graph data with the current renderer: a page
// improvement then reaches every project's existing graph without a rebuild. The HTML file
// beside the data is kept for opening the map off disk. Null when there is no graph.
export function renderGraphPage(projectRoot, mode = 'code') {
    if (!projectRoot) return null;
    const names = NAMES[mode] || NAMES.code;
    const outDir = path.join(projectRoot, 'graphify-out');
    try {
        const graph = JSON.parse(fs.readFileSync(path.join(outDir, names.json), 'utf8'));
        if (Array.isArray(graph.nodes) && Array.isArray(graph.links)) return renderHtml(graph, GRAPH_TITLE);
    } catch (e) { /* missing or half-written data: fall back to the file */ }
    const htmlPath = path.join(outDir, names.html);
    return fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : null;
}

function renderReport(graph, title) {
    const top = [...graph.nodes].sort((a, b) => b.degree - a.degree).slice(0, 25);
    const lines = [
        `# ${title}`,
        '',
        `Generated by PLUT_OS from ${graph.fileCount} files — ${graph.nodes.length} nodes, ` +
        `${graph.links.length} edges. Native scan: no Python, no network, nothing installed.`,
        '',
        'Edges are resolved relative imports between source files (`imports`), plus, for '
            + 'languages whose imports do not name files, a reference to a type exactly one '
            + 'other file declares (`references`). Package imports are deliberately not drawn '
            + '— they are not part of this project\'s shape.',
        '',
        '## Most connected',
        ''
    ];
    for (const n of top) lines.push(`- \`${n.id}\` — ${n.degree} connections`);
    if (!top.length) lines.push('- (nothing linked yet)');
    return lines.join('\n') + '\n';
}

// ------------------------------------------------------------------------------- public

const NAMES = {
    code: { json: 'code_graph.json', html: 'code_graph.html', report: 'code_GRAPH_REPORT.md' }
};
const GRAPH_TITLE = 'Codebase Knowledge Graph';

/**
 * Builds or refreshes the code graph for one project. `mode` stays for the routes and the npm
 * script that pass it; 'code' is the only one.
 */
export function buildProjectDocGraph(projectRoot, mode = 'code') {
    if (!projectRoot || !fs.existsSync(projectRoot)) {
        throw new Error('Valid project root is required.');
    }
    if (mode !== 'code') {
        return { success: false, mode, message: `Unknown mode "${mode}": only the code graph is built (the docs graph was removed).` };
    }

    try {
        const graph = buildCodeGraph(projectRoot);
        const title = GRAPH_TITLE;
        const outDir = path.join(projectRoot, 'graphify-out');
        fs.mkdirSync(outDir, { recursive: true });

        const names = NAMES[mode];
        fs.writeFileSync(path.join(outDir, names.json), JSON.stringify(graph, null, 1), 'utf8');
        fs.writeFileSync(path.join(outDir, names.html), renderHtml(graph, title), 'utf8');
        fs.writeFileSync(path.join(outDir, names.report), renderReport(graph, title), 'utf8');

        return {
            success: true,
            mode,
            project: path.basename(projectRoot),
            outDir,
            nodeCount: graph.nodes.length,
            edgeCount: graph.links.length,
            hasGraph: true,
            hasReport: true,
            hasHtml: true,
            // Zero edges over a non-empty scan is the shape a silent extractor failure takes,
            // so it says so rather than passing as a clean empty map.
            message: `Graphify ${mode} graph built: ${graph.nodes.length} nodes, ${graph.links.length} edges `
                + `from ${graph.fileCount} files.`
                + (graph.links.length === 0 && graph.fileCount > 0
                    ? ` Scanned ${graph.fileCount} files but drew no edges — nothing in them `
                      + `links to anything else here, or this project's language is not one the `
                      + `scanner can read.`
                    : '')
        };
    } catch (e) {
        // The old runner threw this away. A build that fails silently is the one bug a map
        // cannot survive — you cannot tell an empty project from a broken scanner.
        return {
            success: false,
            mode,
            project: path.basename(projectRoot),
            message: (e && e.message) || `Failed to build ${mode} graph.`
        };
    }
}

/**
 * Reads the code graph's status for one project.
 */
export function getProjectDocGraphStatus(projectRoot, mode = 'code') {
    if (!projectRoot) return { exists: false, project: null, mode };
    const outDir = path.join(projectRoot, 'graphify-out');
    const names = NAMES[mode] || NAMES.code;

    const graphJsonPath = path.join(outDir, names.json);
    const htmlPath = path.join(outDir, names.html);
    const reportPath = path.join(outDir, names.report);

    const exists = fs.existsSync(graphJsonPath);
    let nodeCount = 0;
    let edgeCount = 0;
    if (exists) {
        try {
            const data = JSON.parse(fs.readFileSync(graphJsonPath, 'utf8'));
            nodeCount = (data.nodes || []).length;
            edgeCount = (data.links || data.edges || []).length;
        } catch (e) { /* a half-written file reports zero rather than throwing */ }
    }

    return {
        exists,
        mode,
        project: path.basename(projectRoot),
        outDir,
        nodeCount,
        edgeCount,
        hasReport: fs.existsSync(reportPath),
        hasHtml: fs.existsSync(htmlPath),
        updatedAt: exists ? fs.statSync(graphJsonPath).mtime : null
    };
}

// ------------------------------------------------------- keeping it in the loop (opt-in)
//
// The Settings module switch decides whether you SEE the tab; this decides whether the graph
// is actually part of the loop. They are different questions, and they live in different
// places for a reason: the module list is localStorage, which the MCP server cannot read, and
// the refresh has to happen where the session starts. So this is a project setting, in the
// same `.plutos/plutos.config.json` that already carries the detected stack.
//
// Off by default. A map that rebuilds itself on every session is a promise about someone
// else's disk and CPU, and PLUT_OS does not make those without being asked.
const CONFIG_REL = ['.plutos', 'plutos.config.json'];

function readProjectConfig(projectRoot) {
    try {
        return JSON.parse(fs.readFileSync(path.join(projectRoot, ...CONFIG_REL), 'utf8')) || {};
    } catch (e) {
        return {};
    }
}

export function isGraphAutoRefresh(projectRoot) {
    if (!projectRoot) return false;
    return readProjectConfig(projectRoot).graphifyAuto === true;
}

export function setGraphAutoRefresh(projectRoot, enabled) {
    if (!projectRoot || !fs.existsSync(projectRoot)) {
        return { success: false, message: 'Valid project root is required.' };
    }
    const file = path.join(projectRoot, ...CONFIG_REL);
    // Merge, never replace: this file also carries the detected stack, and
    // clobbering it to store one boolean would be a poor trade.
    const config = readProjectConfig(projectRoot);
    config.graphifyAuto = !!enabled;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf8');
        return { success: true, enabled: !!enabled };
    } catch (e) {
        return { success: false, message: (e && e.message) || 'Could not save the setting.' };
    }
}

/**
 * Rebuilds any graph the code has moved past — the same self-heal `refreshIndexIfStale`
 * performs for the generated code index, on the same trigger (session_start). No-ops unless
 * the project opted in, and never throws: a briefing outranks a map.
 * → { refreshed: [modes], reason }
 */
export function refreshGraphIfStale(projectRoot) {
    try {
        if (!projectRoot || !fs.existsSync(projectRoot)) return { refreshed: [], reason: 'no-project' };
        if (!isGraphAutoRefresh(projectRoot)) return { refreshed: [], reason: 'not-enabled' };

        const refreshed = [];
        const status = getProjectDocGraphStatus(projectRoot, 'code');
        // Never built is not stale — building a graph nobody asked for on first contact
        // is exactly the surprise this setting exists to avoid. Refresh what exists.
        if (status.exists) {
            const builtAt = status.updatedAt ? new Date(status.updatedAt).getTime() : 0;
            if (isSourceNewerThan(projectRoot, CODE_EXTS, builtAt) && buildProjectDocGraph(projectRoot, 'code').success) refreshed.push('code');
        }
        return { refreshed, reason: refreshed.length ? 'stale' : 'current' };
    } catch (e) {
        return { refreshed: [], reason: 'error' };
    }
}

/**
 * Removes generated Graphify output for one project.
 * mode: 'code' | 'all'
 */
export function cleanProjectGraph(projectRoot, mode = 'all') {
    if (!projectRoot || !fs.existsSync(projectRoot)) {
        return { success: false, message: 'Valid project root is required.' };
    }
    const outDir = path.join(projectRoot, 'graphify-out');
    if (!fs.existsSync(outDir)) {
        return { success: true, message: 'Nothing to clean — graphify-out does not exist.' };
    }

    try {
        if (mode === 'all') {
            fs.rmSync(outDir, { recursive: true, force: true });
            return { success: true, message: 'All Graphify files removed successfully.' };
        }
        const names = NAMES[mode];
        if (!names) return { success: false, message: `Unknown mode "${mode}".` };

        const targets = [names.json, names.html, names.report];
        for (const f of targets) {
            const target = path.join(outDir, f);
            if (fs.existsSync(target)) fs.unlinkSync(target);
        }
        return { success: true, message: `Graphify ${mode} files removed successfully.` };
    } catch (e) {
        return { success: false, message: (e && e.message) || 'Failed to clean Graphify files.' };
    }
}
