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
// Output: `graphify-out/code_graph.json` (lib/task-context.mjs and the brief read the graph) and
// `code_GRAPH_REPORT.md` beside it. There is no HTML page any more (see OLD_HTML below).
import fs from 'fs';
import path from 'path';
import { walk, capFiles, isSourceNewerThan } from './codeindex.mjs';
import { CODE_MAP_EXTS, IMPORT_PARSED_EXTS } from './file-types.mjs';

// The languages the map reads come from the shared file-type table (lib/file-types.mjs, rows with
// inCodeMap). A language joins the map only once a scanner below can read it.
const CODE_EXTS = CODE_MAP_EXTS;

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
const JS_EXTS = new Set(IMPORT_PARSED_EXTS);   // rows with importsParsed in lib/file-types.mjs

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

// The names a non-JS file declares, by the same patterns the reference pass uses, for the files
// the task index reads beside the map (lib/task-context.mjs).
export function declaredNames(raw) {
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return [...declaredSymbols(stripNoise(raw))];
}

export { CODE_EXTS };

// ------------------------------------------------------------------------------- output

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
    code: { json: 'code_graph.json', report: 'code_GRAPH_REPORT.md' }
};
// The interactive graph page (vis-network) went with the dashboard's graph viewer (owner decision
// d-51e97352b22e, 2026-11-14). A code_graph.html an older version wrote loads a script the dashboard
// no longer serves, so a build or a clean removes it.
const OLD_HTML = 'code_graph.html';
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
        fs.writeFileSync(path.join(outDir, names.report), renderReport(graph, title), 'utf8');
        fs.rmSync(path.join(outDir, OLD_HTML), { force: true });

        return {
            success: true,
            mode,
            project: path.basename(projectRoot),
            outDir,
            nodeCount: graph.nodes.length,
            edgeCount: graph.links.length,
            hasGraph: true,
            hasReport: true,
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
        updatedAt: exists ? fs.statSync(graphJsonPath).mtime : null
    };
}

// ------------------------------------------------------- keeping it in the loop (opt-in)
//
// A project setting (`graphifyAuto` in `.plutos/plutos.config.json`, beside the detected stack)
// decides whether session_start rebuilds a stale graph: the refresh has to happen where the
// session starts, and the MCP server reads this file. The dashboard toggle went with the graph
// viewer (2026-11-14); setGraphAutoRefresh stays as the one writer that merges, not replaces.
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

        const targets = [names.json, names.report, OLD_HTML];
        for (const f of targets) {
            const target = path.join(outDir, f);
            if (fs.existsSync(target)) fs.unlinkSync(target);
        }
        return { success: true, message: `Graphify ${mode} files removed successfully.` };
    } catch (e) {
        return { success: false, message: (e && e.message) || 'Failed to clean Graphify files.' };
    }
}
