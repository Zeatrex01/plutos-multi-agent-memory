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
// `code_GRAPH_REPORT.md` beside it, plus `code_graph.html`, the interactive page the dashboard's Code
// map page shows (served from /api/graphify/html and drawn from the data by renderGraphPage).
import fs from 'fs';
import path from 'path';
import { walk, capFiles, isSourceNewerThan, MAX_SCAN_FILES } from './codeindex.mjs';
import { readCallers, isEngineRoot, CALLER_EXTS } from './codegraph-callers.mjs';
import { CODE_MAP_EXTS, JS_IMPORT_EXTS } from './file-types.mjs';
import { ENGINES, ENGINE_KINDS, markerName } from './engines.mjs';

// The languages the map reads come from the shared file-type table (lib/file-types.mjs, rows with
// inCodeMap). A language joins the map only once a scanner below can read it.
const CODE_EXTS = CODE_MAP_EXTS;

// Relative imports and configured project aliases become edges. External packages do not:
// drawing every dependency as a node buries the code the graph exists to show.
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
const JS_EXTS = new Set(JS_IMPORT_EXTS);   // rows with importSyntax 'js' in lib/file-types.mjs

// Up to five modifier words (public sealed partial ...) before the keyword, so C#, Java,
// Kotlin, Swift, Rust and Python all land with one pattern. Go's `type Foo struct` and the
// top-level function forms get their own — and only top-level: the function pattern is
// anchored at column 0, because an indented `def process(self)` is a method, and a method
// name is exactly the kind of identifier (`process`, `update`, `get`) that some unrelated
// object elsewhere also answers to. Measured: the indented form drew a wrong edge from an
// unrelated `q.process()` call; column-0 only lost no correct edge in six languages and
// keeps Lua and the other languages whose only declarations are functions on the map.
// A language whose type declaration is its engine's own form comes from that engine's row
// (lib/engines.mjs `classDecl`, for the row's code suffixes): see declPatternsFor below.
const DECL_PATTERNS = [
    /^[^\S\n]*(?:\w+[^\S\n]+){0,5}(?:class|interface|struct|enum|trait|protocol|record)[^\S\n]+(\w+)/gm,
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
// Triple-quoted blocks (Python docstrings and their kin, C# raw strings) span lines; the
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

// Resolve a candidate the way a bundler would, minus the cleverness: exact hit, then
// the usual extensions, then a directory's index file. An unresolvable specifier is dropped
// rather than guessed — a wrong edge is worse than a missing one on a map you navigate by.
function resolveCandidate(base, root) {
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

// Keep strings intact while stripping JSONC comments and trailing commas (including BOMs).
function parseJsonConfig(raw) {
    const clean = raw.replace(/^\uFEFF/, '').replace(/"(?:[^"\\]|\\.)*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
        token => token.startsWith('"') ? token : ' ');
    return JSON.parse(clean.replace(/"(?:[^"\\]|\\.)*"|,\s*(?=[}\]])/g,
        token => token.startsWith(',') ? '' : token));
}

// Configs are read once per scan, never per import. Inherited relative options keep the
// folder of their defining config; only relative extends are followed, at most two levels.
function importConfig(root) {
    const seen = new Set();
    function load(file, depth = 0) {
        file = path.resolve(file);
        if (depth > 2 || seen.has(file)) return {};
        seen.add(file);
        let config;
        try { config = parseJsonConfig(readHead(file)); } catch (e) { return {}; }
        if (!config || typeof config !== 'object') return {};
        const dir = path.dirname(file);
        let inherited = {};
        if (typeof config.extends === 'string' && config.extends.startsWith('.')) {
            let base = path.resolve(dir, config.extends);
            if (!fs.existsSync(base) && !base.endsWith('.json')) base += '.json';
            inherited = load(base, depth + 1);
        }
        const options = config.compilerOptions || {};
        const hasPaths = options.paths && typeof options.paths === 'object' && !Array.isArray(options.paths);
        return {
            baseUrl: typeof options.baseUrl === 'string' ? path.resolve(dir, options.baseUrl) : inherited.baseUrl,
            paths: hasPaths ? options.paths : inherited.paths,
            pathsBase: hasPaths ? dir : inherited.pathsBase
        };
    }
    const ts = path.join(root, 'tsconfig.json');
    const config = load(fs.existsSync(ts) ? ts : path.join(root, 'jsconfig.json'));
    const aliases = Object.entries(config.paths || {}).map(([pattern, targets]) => {
        const star = pattern.indexOf('*');
        return { pattern, star, prefix: star < 0 ? pattern : pattern.slice(0, star),
            suffix: star < 0 ? '' : pattern.slice(star + 1),
            targets: Array.isArray(targets) ? targets.filter(t => typeof t === 'string') : [] };
    }).sort((a, b) => Number(a.star >= 0) - Number(b.star >= 0) || b.prefix.length - a.prefix.length);
    return { baseUrl: config.baseUrl, pathsBase: config.baseUrl || config.pathsBase, aliases };
}

function resolveImport(fromAbs, spec, root, config) {
    if (spec.startsWith('.')) return resolveCandidate(path.resolve(path.dirname(fromAbs), spec), root);
    const alias = config.aliases.find(a => a.star < 0 ? spec === a.pattern
        : spec.length >= a.prefix.length + a.suffix.length && spec.startsWith(a.prefix) && spec.endsWith(a.suffix));
    if (alias) {
        const match = alias.star < 0 ? '' : spec.slice(alias.prefix.length, spec.length - alias.suffix.length);
        for (const target of alias.targets) {
            const resolved = resolveCandidate(path.resolve(config.pathsBase, target.replaceAll('*', match)), root);
            if (resolved) return resolved;
        }
        return null;
    }
    return config.baseUrl && !path.isAbsolute(spec) ? resolveCandidate(path.resolve(config.baseUrl, spec), root) : null;
}

// The text the scan reads: at most 400,000 characters (a minified bundle is not source), or null.
function readSource(abs) {
    let raw;
    // A FIFO or device named like a source file would block readFileSync forever.
    try { if (!fs.statSync(abs).isFile()) return null; raw = fs.readFileSync(abs, 'utf8'); } catch (e) { return null; }
    return raw.length > 400_000 ? raw.slice(0, 400_000) : raw;
}

// `text` is the file's readSource() text when the caller already holds it.
function importsOf(abs, root, config, symbols = null, text = undefined) {
    const raw = text === undefined ? readSource(abs) : text;
    if (raw === null) return [];
    if (symbols) symbols.set(rel(root, abs), [...declaredSymbols(stripNoise(raw), [...DECL_PATTERNS, JS_DECL])]);
    const out = new Set();
    for (const re of IMPORT_PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(raw))) {
            const target = resolveImport(abs, m[1], root, config);
            if (target) out.add(target);
        }
    }
    return [...out];
}

// ----------------------------------------------------------------------- engine edges
//
// The core recognises an engine, it does not know the engine (owner, 2026-11-17). Which folder is an
// engine project's root, which files are its code and its scenes or assets, and how one file names
// another all come from the engines table (lib/engines.mjs); this section interprets the rows and names
// no engine. An engine project is often nested in a repository, and its paths resolve from its own root.
// Inside such a root the scanner draws one edge per file pair, typed with the engine's id and a `kind`
// from its row (the strongest kind wins). Its assets join the map only there; a reference to a file the
// scan did not keep (a texture, a sound) draws nothing. Outside every engine root none of this runs.
const ENGINE_RULES = ENGINES.map(e => ({
    ...e,
    order: e.kinds.map(k => k.id),
    declRe: e.classDecl ? new RegExp(e.classDecl, 'm') : null,
    guidRe: e.guids ? new RegExp(e.guids.pattern, 'm') : null,
    rules: e.refs.map(r => ({ ...r, re: r.match === 'identifiers' ? null : new RegExp(r.match, r.flags || '') })),
}));
ENGINE_RULES.forEach(e => { e.codeRules = e.rules.filter(r => r.in === 'code'); e.assetRules = e.rules.filter(r => r.in === 'asset'); });
const MARKER_NAMES = [...new Set(ENGINE_RULES.map(markerName))];
const extOf = f => path.extname(f).toLowerCase();
// The declaration patterns for one file: the generic ones, plus each engine row's classDecl when the
// file has one of that row's code suffixes (wherever the file sits, as the generic patterns apply).
const ENGINE_DECLS = new Map();
for (const e of ENGINE_RULES) if (e.classDecl) for (const x of e.code) {
    ENGINE_DECLS.set(x, [...(ENGINE_DECLS.get(x) || DECL_PATTERNS), new RegExp(e.classDecl, 'gm')]);
}
const declPatternsFor = file => (file && ENGINE_DECLS.get(extOf(file))) || DECL_PATTERNS;

// A code line without its comment; a comment opener inside a string stays (`"res://a#b"` is rare, but a
// comment pass that eats a path draws nothing rather than something wrong).
function dropLineComments(raw, opener) {
    return raw.split('\n').map(line => {
        let q = null;
        for (let i = 0; i < line.length; i++) {
            const c = line[i];
            if (q) { if (c === '\\') i++; else if (c === q) q = null; }
            else if (c === '"' || c === "'") q = c;
            else if (line.startsWith(opener, i)) return line.slice(0, i);
        }
        return line;
    }).join('\n');
}

// The engine project roots among the walked marker files: [{ root, engine }], root relative to the scan
// root ('' for the root itself), deepest first so a file resolves against its nearest one.
function engineRootsOf(root, markerFiles) {
    const found = new Map();
    for (const abs of markerFiles) {
        const base = path.basename(abs);
        for (const engine of ENGINE_RULES) {
            const parts = engine.marker.file.split('/');
            const last = parts[parts.length - 1];
            if (last.startsWith('*') ? !base.endsWith(last.slice(1)) : base !== last) continue;
            let dir = path.dirname(abs);
            for (let i = parts.length - 2; i >= 0 && dir; i--) { if (path.basename(dir) !== parts[i]) { dir = null; break; } dir = path.dirname(dir); }
            if (!dir || !isEngineRoot(dir, engine)) continue;
            const r = rel(root, dir);
            if (r.startsWith('..')) continue;
            if (!found.has(r)) found.set(r, engine);
        }
    }
    return [...found].map(([r, engine]) => ({ root: r, engine })).sort((a, b) => b.root.length - a.root.length);
}
const engineRootOf = (roots, relPath) => roots.find(r => r.root === '' || relPath.startsWith(r.root + '/'));
const isMarkerFile = f => { const base = path.basename(f); return ENGINE_RULES.some(e => {
    const last = e.marker.file.split('/').pop();
    return last.startsWith('*') ? base.endsWith(last.slice(1)) : base === last;
}); };
// A path a reference names, from its engine root: cut at the row's pathCut, never above the root.
const pathToRel = (engine, eRoot, p) => {
    const clean = path.posix.normalize(engine.pathCut ? p.split(engine.pathCut)[0] : p);
    if (clean.startsWith('..') || path.posix.isAbsolute(clean)) return null;
    return eRoot ? eRoot + '/' + clean : clean;
};

// The first `max` bytes of a regular file as text, BOM dropped; '' for anything else. A scene or asset
// can be megabytes of embedded data (or, for an engine's settings, hundreds of MB of binary): only that
// much is ever read from disk. The default suits a file whose references sit at its top; an engine row
// whose references are spread through the file sets its own `assetBytes`. The open does not block: a
// FIFO (or a link to one) opens at once and is refused as not a regular file, never waited on.
export const HEAD_BYTES = 400_000;
const OPEN_HEAD = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0);
export function readHead(abs, max = HEAD_BYTES) {
    let fd;
    try {
        fd = fs.openSync(abs, OPEN_HEAD);
        const st = fs.fstatSync(fd);
        if (!st.isFile()) return '';
        const buf = Buffer.alloc(Math.min(max, Math.max(0, st.size)));
        let n = 0, got;
        while (n < buf.length && (got = fs.readSync(fd, buf, n, buf.length - n, null)) > 0) n += got;
        const raw = buf.toString('utf8', 0, n);
        return raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
    } catch (e) { return ''; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (e) { /* closed */ } }
}

// The typed edges inside each engine project: [{ source, target, type, kind }], one per pair.
// `scriptText` maps a code file's relative path to the text the main scan already read (read once).
function engineEdges(root, roots, scriptText, assets, known) {
    const raws = new Map();
    const classes = new Map();   // root\0name -> file, null once two files claim it
    for (const [from, text] of scriptText) {
        const at = engineRootOf(roots, from);
        if (!at || !at.engine.code.includes(extOf(from))) continue;
        const code = at.engine.lineComment ? dropLineComments(text, at.engine.lineComment) : text;
        raws.set(from, code);
        const m = at.engine.declRe && code.match(at.engine.declRe);
        if (!m) continue;
        const key = at.root + '\u0000' + m[1];
        classes.set(key, classes.has(key) ? null : from);
    }
    // id -> file, from the id file beside each mapped file (one small read each, mapped files only).
    const guids = new Map();
    let realRoot;
    try { realRoot = fs.realpathSync(root); } catch (e) { realRoot = root; }
    for (const id of known.keys()) {
        const at = engineRootOf(roots, id);
        if (!at || !at.engine.guidRe) continue;
        const metaAbs = path.join(root, ...id.split('/')) + at.engine.guids.suffix;
        if (!fs.existsSync(metaAbs)) continue;
        // An id file linked from outside the project names nothing in it.
        let real;
        try { real = fs.realpathSync(metaAbs); } catch (e) { continue; }
        if (real !== realRoot && !real.startsWith(realRoot + path.sep)) continue;
        const m = readHead(metaAbs).match(at.engine.guidRe);
        if (!m) continue;
        const key = at.root + '\u0000' + m[1];
        guids.set(key, guids.has(key) ? null : id);
    }
    const best = new Map();   // "from\0target" -> kind, the strongest kind wins
    const add = (from, at, target, kind) => {
        if (!target || target === from || !known.has(target)) return;
        const key = from + '\u0000' + target;
        const had = best.get(key);
        if (!had || at.engine.order.indexOf(kind) < at.engine.order.indexOf(had.kind)) best.set(key, { kind, type: at.engine.id });
    };
    const resolve = (at, to, value) => to === 'path' ? pathToRel(at.engine, at.root, value)
        : to === 'class' ? classes.get(at.root + '\u0000' + value) || null
        : to === 'guid' ? guids.get(at.root + '\u0000' + value) || null : null;
    const apply = (from, at, rules, text) => {
        for (const r of rules) {
            if (!r.re) {
                for (const name of new Set(stripNoise(text).match(/[A-Za-z_]\w*/g) || [])) add(from, at, resolve(at, r.to, name), r.kind);
            } else if (r.re.global) {
                r.re.lastIndex = 0;
                let m;
                while ((m = r.re.exec(text))) add(from, at, resolve(at, r.to, m[1]), r.kind);
            } else {
                const m = text.match(r.re);
                if (m) add(from, at, resolve(at, r.to, m[1]), r.kind);
            }
        }
    };
    for (const [from, code] of raws) {
        const at = engineRootOf(roots, from);
        apply(from, at, at.engine.codeRules, code);
    }
    for (const abs of assets) {
        const from = rel(root, abs);
        const at = engineRootOf(roots, from);
        if (!at || !at.engine.assetRules.length) continue;
        apply(from, at, at.engine.assetRules, readHead(abs, at.engine.assetBytes || HEAD_BYTES));
    }
    return [...best].map(([key, { kind, type }]) => { const [source, target] = key.split('\u0000'); return { source, target, type, kind }; });
}

// `withSymbols` adds what each file declares, for lib/task-context.mjs. The map is in memory
// only: it is never written to graphify-out, whose JSON shape the dashboard already reads.
function buildCodeGraph(root, { withSymbols = false } = {}) {
    const config = importConfig(root);
    // The code walk also notes each engine's marker file (lib/engines.mjs; a repository without one walks
    // exactly the code files, as before). Only when an engine root exists are that engine's assets
    // walked, inside those roots alone, and they get what is left of the scan budget after the code
    // files, so the map never holds more than MAX_SCAN_FILES files.
    const walked = walk(root, [...CODE_EXTS, ...MARKER_NAMES]);
    const isCode = f => CODE_EXTS.some(e => f.endsWith(e));
    const { files } = capFiles(walked.filter(f => !isMarkerFile(f) && isCode(f)));
    const engineRoots = engineRootsOf(root, walked.filter(isMarkerFile));
    let resources = [];
    if (engineRoots.some(r => r.engine.assets.length)) {
        // Walk each outermost root once per engine: a nested root's files are already inside its parent's walk.
        const found = new Set();
        for (const engine of ENGINE_RULES.filter(e => e.assets.length)) {
            const mine = engineRoots.filter(r => r.engine === engine).map(r => r.root);
            // With assetDirs a nested root may sit outside its parent's asset folders: walk every root then.
            const outer = engine.assetDirs ? mine : mine.filter(r => !mine.some(o => o !== r && (o === '' || r.startsWith(o + '/'))));
            for (const r of outer) {
                const base = r ? path.join(root, ...r.split('/')) : root;
                // A row's assetDirs narrow the walk to those folders of the root (an engine's settings folders stay out).
                for (const dir of engine.assetDirs ? engine.assetDirs.map(d => path.join(base, ...d.split('/'))) : [base])
                    for (const f of walk(dir, engine.assets)) found.add(f);
            }
        }
        // An asset joins the map only when its nearest engine root's engine lists its suffix (and, with
        // assetDirs, the file sits in one of that root's asset folders).
        const inDirs = (at, relPath) => !at.engine.assetDirs
            || at.engine.assetDirs.some(d => relPath.startsWith((at.root ? at.root + '/' : '') + d + '/'));
        const kept = [...found].filter(f => {
            const relPath = rel(root, f);
            const at = engineRootOf(engineRoots, relPath);
            return at && at.engine.assets.includes(extOf(f)) && inDirs(at, relPath);
        });
        resources = capFiles(kept, MAX_SCAN_FILES - files.length).files;
    }
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
    for (const abs of resources) addNode(rel(root, abs));

    // Inside an engine root whose rows read code, a code file's text is read once and kept for the passes
    // below and engineEdges.
    const scriptText = engineRoots.length ? new Map() : null;
    const isEngineScript = abs => {
        if (!scriptText) return false;
        const at = engineRootOf(engineRoots, rel(root, abs));
        return !!at && at.engine.codeRules.length > 0 && at.engine.code.includes(extOf(abs));
    };
    for (const abs of files) {
        const from = rel(root, abs);
        const isJs = JS_EXTS.has(path.extname(abs).toLowerCase());
        let text;
        if (isEngineScript(abs)) { text = readSource(abs); if (text !== null) scriptText.set(from, text); }
        for (const target of importsOf(abs, root, config, isJs ? symbols : null, text)) {
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
        const relPath = rel(root, abs);
        const kept = isEngineScript(abs);
        let raw = kept ? (scriptText.get(relPath) ?? null) : readSource(abs);
        if (raw === null) continue;
        // The function pattern is anchored at column 0, and a BOM is column 0.
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
        if (kept) scriptText.set(relPath, raw);
        const clean = stripNoise(raw);
        identsOf.set(relPath, new Set(clean.match(/\w+/g) || []));
        const declared = declaredSymbols(clean, declPatternsFor(abs));
        if (symbols) symbols.set(relPath, [...declared]);
        for (const sym of declared) {
            // A name two files both declare cannot say which one a third file meant, and a
            // guess here is the wrong edge. Drop it for everyone.
            owner.set(sym, owner.has(sym) ? null : relPath);
        }
    }

    const drawn = new Set();
    if (engineRoots.length) {
        for (const { source, target, type, kind } of engineEdges(root, engineRoots, scriptText, resources, nodes)) {
            drawn.add(source + '\u0000' + target);
            links.push({ source, target, type, kind });
            nodes.get(source).degree++;
            nodes.get(target).degree++;
        }
    }
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

    return { mode: 'code', nodes: [...nodes.values()], links, fileCount: files.length + resources.length,
        ...(engineRoots.length ? { engines: enginesFound(engineRoots) } : {}), ...(symbols ? { symbols } : {}) };
}

// The engines recognised, in table order, each with its roots deepest first: [{ id, label, roots }].
function enginesFound(engineRoots) {
    return ENGINE_RULES.filter(e => engineRoots.some(r => r.engine === e))
        .map(e => ({ id: e.id, label: e.label, roots: engineRoots.filter(r => r.engine === e).map(r => r.root) }));
}

// The code graph plus each file's declared symbols, built in memory and written nowhere.
export function scanCodeGraph(root) {
    return buildCodeGraph(root, { withSymbols: true });
}

// The names a non-JS file declares, by the same patterns the reference pass uses, for the files
// the task index reads beside the map (lib/task-context.mjs).
export function declaredNames(raw, file = '') {
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return [...declaredSymbols(stripNoise(raw), declPatternsFor(file))];
}

export { CODE_EXTS };

// Function-level callers for one script, for the page's click panel (GET /api/graphify/callers): the
// function graph an engine's pack prepared, when there is one (lib/codegraph-callers.mjs), read-only.
export function readFunctionCallers(projectRoot, file) {
    return readCallers(projectRoot, file);
}

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
    folderLabel: 'Only this top folder',
    // One word per engine edge kind, from the engines table (kind_<id>).
    ...Object.fromEntries(ENGINE_KINDS.map(k => ['kind_' + k.id, k.label])),
    callsTitle: 'Functions in {file}',
    callsLoading: 'Reading the code graph…',
    callsNone: 'No functions recorded for this file.',
    callsCallers: '{n} callers',
    callsNoCallers: 'no resolved caller',
    callsUnresolved: '+{n} untyped calls of this name',
    callsStale: 'The script is newer than .codegraph/: callers may be out of date.',
    callsError: 'Could not read the callers.',
    callsClose: 'Close',
    callsAbsent: 'No function-level code graph (.codegraph/) in this project. The engine pack\'s code tools build it; PLUT_OS only reads it. With them installed, run once:',
    callsNoSqlite: 'Reading .codegraph/ needs node:sqlite (Node 22.13 or newer).',
    callsUnreadable: 'The code graph (.codegraph/graph.db) could not be read:'
};
const PAGE_KEYS = {
    hud: 'depgraph_page_hud', hint: 'depgraph_page_hint', arranging: 'depgraph_page_arranging', fit: 'depgraph_page_fit',
    settleOn: 'depgraph_page_settle_on', settleOff: 'depgraph_page_settle_off', settleHint: 'depgraph_page_settle_hint',
    links: 'depgraph_page_links', empty: 'depgraph_page_empty', legend: 'depgraph_page_legend', root: 'maps_root_folder',
    shown: 'depgraph_page_shown', limitN: 'depgraph_page_limit_n', limitAll: 'depgraph_page_limit_all',
    limitLabel: 'depgraph_page_limit_label', folderAll: 'depgraph_page_folder_all', folderLabel: 'depgraph_page_folder_label',
    ...Object.fromEntries(ENGINE_KINDS.map(k => ['kind_' + k.id, 'depgraph_page_kind_' + k.id])), callsTitle: 'depgraph_page_calls_title', callsLoading: 'depgraph_page_calls_loading',
    callsNone: 'depgraph_page_calls_none', callsCallers: 'depgraph_page_calls_callers', callsNoCallers: 'depgraph_page_calls_no_callers',
    callsUnresolved: 'depgraph_page_calls_unresolved', callsStale: 'depgraph_page_calls_stale', callsError: 'depgraph_page_calls_error',
    callsClose: 'depgraph_page_calls_close', callsAbsent: 'depgraph_page_calls_absent', callsNoSqlite: 'depgraph_page_calls_no_sqlite',
    callsUnreadable: 'depgraph_page_calls_unreadable'
};

function renderHtml(graph, title) {
    const json = value => JSON.stringify(value).replace(/</g, '\\u003c');
    // The engines recognised: the graph's own list, or, for a graph built before the list, the engine
    // ids its typed links carry. Their packs' function graphs answer for `callerExts`.
    const ids = new Set([...(Array.isArray(graph.engines) ? graph.engines.map(e => e && e.id) : []),
        ...graph.links.map(l => l && l.type)]);
    const callerExts = [...new Set(ENGINES.filter(e => ids.has(e.id) && e.callers).flatMap(e => e.callers.exts))];
    const payload = json({ nodes: graph.nodes, links: graph.links, kinds: ENGINE_KINDS.map(k => k.id), callerExts });
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
  #legend .kinds{display:inline-flex;flex-wrap:wrap;gap:4px 12px;}
  #legend b{width:14px;height:3px;border-radius:2px;flex-shrink:0;display:inline-block;}
  #calls{top:56px;right:10px;width:min(360px,calc(100% - 22px));max-height:calc(100% - 120px);overflow:auto;display:none;
    padding:8px 12px;font-size:.8rem;color:var(--body);}
  #calls h2{font-size:.85rem;margin:0 0 6px;color:var(--title);word-break:break-all;padding-right:56px;}
  #calls .close{position:absolute;top:6px;right:8px;background:var(--panel);color:var(--title);border:1px solid var(--line);
    border-radius:6px;font:inherit;font-size:.75rem;padding:2px 8px;cursor:pointer;}
  #calls ul{list-style:none;margin:0;padding:0;}
  #calls li{margin:0 0 6px;}
  #calls li>span{color:var(--title);font-weight:600;}
  #calls ol{margin:2px 0 0 14px;padding:0;}
  #calls code{font-size:.75rem;word-break:break-all;}
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
<div id="calls" class="panel" role="region" aria-live="polite"><button class="close" type="button" id="calls-close"></button><h2 id="calls-title"></h2><div id="calls-body"></div></div>
<div id="busy" role="status" aria-live="polite"><span id="busy-text"></span><div class="bar"><span id="busy-bar"></span></div></div>
<div id="note">This map is served by PLUT_OS. Open it from the dashboard's Code map page
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
// Engine edge kinds (lib/engines.mjs, every kind in table order): one colour each, by position, from
// the same two palettes, so a kind keeps its colour from project to project.
const KINDS = DATA.kinds;
const KIND_WORD = Object.fromEntries(KINDS.map(k => [k, 'kind_' + k]));
const KIND_INK = {
  light: ['#be185d', '#1d4ed8', '#4d7c0f', '#a16207', '#0e7490', '#5b4bc4', '#c2410c', '#a21caf'],
  dark: ['#f472b6', '#5da9f6', '#a3e635', '#facc15', '#2dd4bf', '#8b7cf6', '#ff9566', '#e879f9']
};
const KIND_COLOR = {
  light: Object.fromEntries(KINDS.map((k, i) => [k, KIND_INK.light[i % KIND_INK.light.length]])),
  dark: Object.fromEntries(KINDS.map((k, i) => [k, KIND_INK.dark[i % KIND_INK.dark.length]]))
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
  const kindsShown = KINDS.filter(k => DATA.links.some(l => l.kind === k));
  const edgeLook = (l, m) => (l.kind && KIND_COLOR[m][l.kind]
    ? { color: { color: KIND_COLOR[m][l.kind], highlight: INK[m].brand, hover: INK[m].brand, opacity: 0.85 }, width: 1.4, title: tr(KIND_WORD[l.kind]) }
    : {});
  const edges = new vis.DataSet(DATA.links.map((l, i) => Object.assign({ id: i, from: l.source, to: l.target, arrows: { to: { enabled: true, scaleFactor: 0.35 } } }, edgeLook(l, mode))));
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
    if (kindsShown.length) {
      const wrap = document.createElement('span');
      wrap.className = 'kinds';
      kindsShown.forEach(k => {
        const item = document.createElement('span');
        const line = document.createElement('b');
        line.style.background = KIND_COLOR[m][k];
        item.append(line, document.createTextNode(tr(KIND_WORD[k])));
        wrap.appendChild(item);
      });
      box.appendChild(wrap);
    }
  };
  const repaint = () => {
    const m = themeMode();
    document.documentElement.setAttribute('data-theme', m);
    nodes.update(DATA.nodes.map(n => Object.assign({ id: n.id }, look(n, m))));
    net.setOptions({ edges: { color: { color: INK[m].edge, highlight: INK[m].brand, hover: INK[m].brand } } });
    if (kindsShown.length) edges.update(DATA.links.map((l, i) => Object.assign({ id: i }, edgeLook(l, m))).filter(e => e.color));
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

  // A script's functions and their callers, from the function graph its engine's pack prepared
  // (GET /api/graphify/callers). Names come from the project: text nodes only, never HTML.
  const callsBox = $('calls');
  const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
  let callsFor = '';
  $('calls-close').addEventListener('click', () => { callsBox.style.display = 'none'; callsFor = ''; });
  function showCalls(file) {
    callsFor = file;
    $('calls-close').textContent = tr('callsClose');
    $('calls-title').textContent = fill(tr('callsTitle'), { file });
    const body = $('calls-body');
    body.textContent = '';
    body.appendChild(el('p', tr('callsLoading')));
    callsBox.style.display = 'block';
    fetch('/api/graphify/callers?file=' + encodeURIComponent(file)).then(r => r.json()).then(data => {
      if (callsFor !== file) return;
      body.textContent = '';
      if (!data || !data.available) {
        // The sentence is the page's own; what the server adds (a command, an SQLite error) only ever goes in <code>.
        const word = { absent: 'callsAbsent', 'no-sqlite': 'callsNoSqlite', unreadable: 'callsUnreadable' }[data && data.reason];
        body.appendChild(el('p', tr(word || 'callsError')));
        if (data && (data.reason === 'absent' || data.reason === 'unreadable') && data.hint) body.appendChild(el('code', data.hint));
        return;
      }
      if (data.stale) body.appendChild(el('p', tr('callsStale')));
      if (data.parseError) body.appendChild(el('p', data.parseError));
      if (!data.functions.length) { body.appendChild(el('p', tr('callsNone'))); return; }
      const list = el('ul');
      data.functions.forEach(f => {
        const li = el('li');
        li.appendChild(el('span', (f.scope ? f.scope + '.' : '') + f.name + '()'));
        li.appendChild(document.createTextNode(' :' + f.line + ' · ' + (f.callerCount ? fill(tr('callsCallers'), { n: f.callerCount }) : tr('callsNoCallers'))));
        if (f.callers.length) {
          const ol = el('ol');
          f.callers.forEach(c => { const item = el('li'); item.appendChild(el('code', c.file + ':' + c.line + ' ' + (c.scope ? c.scope + '.' : '') + c.function)); ol.appendChild(item); });
          li.appendChild(ol);
        }
        if (f.unresolved) li.appendChild(el('div', fill(tr('callsUnresolved'), { n: f.unresolved })));
        list.appendChild(li);
      });
      body.appendChild(list);
    }).catch(() => { if (callsFor === file) { body.textContent = ''; body.appendChild(el('p', tr('callsError'))); } });
  }
  if (DATA.callerExts.length) net.on('click', p => {
    const id = p.nodes.length === 1 ? String(p.nodes[0]) : '';
    if (id && DATA.callerExts.some(x => id.toLowerCase().endsWith(x))) showCalls(id);
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
    } catch (e) { /* missing or half-written data */ }
    // Never serve a code_graph.html from disk: a cloned repository can commit one with its own script,
    // and the route serves it on the dashboard's origin. The page is always rebuilt from the data.
    return null;
}

// The report's sentence on the engines recognised (lib/engines.mjs), or nothing on the default path.
function engineReportLine(graph) {
    const found = Array.isArray(graph.engines) ? graph.engines : [];
    return found.map(f => {
        const e = ENGINES.find(x => x.id === f.id);
        if (!e) return '';
        const where = f.roots.map(r => r === '' ? 'the root' : '`' + r + '/`').join(', ');
        if (!e.kinds.length) return `This is a ${e.label} project (${where}): recognised, with no file edges to read. `;
        return `Inside the ${e.label} project (${where}) files are linked by the references the engine resolves (\`${e.id}\`, `
            + `with a kind: ${e.kinds.map(k => k.id).join(', ')}). `;
    }).join('');
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
            + 'other file declares (`references`). '
            + engineReportLine(graph)
            + 'Package imports are deliberately not drawn '
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
    // The engines the last build recognised (lib/engines.mjs), for the page's one line: [{ id, label }].
    let engines = [];
    if (exists) {
        try {
            const data = JSON.parse(fs.readFileSync(graphJsonPath, 'utf8'));
            nodeCount = Array.isArray(data.nodes) ? data.nodes.length : 0;
            const links = Array.isArray(data.links) ? data.links : data.edges;
            edgeCount = Array.isArray(links) ? links.length : 0;
            // A graph built before the list: the engine ids its typed links carry.
            const ids = new Set([...(Array.isArray(data.engines) ? data.engines.map(e => e && e.id) : []),
                ...(Array.isArray(links) ? links.map(l => l && l.type) : [])]);
            engines = ENGINES.filter(e => ids.has(e.id)).map(e => ({ id: e.id, label: e.label }));
        } catch (e) { /* a half-written file reports zero rather than throwing */ }
    }

    return {
        exists,
        mode,
        project: path.basename(projectRoot),
        outDir,
        nodeCount,
        edgeCount,
        engines,
        hasReport: fs.existsSync(reportPath),
        hasHtml: fs.existsSync(htmlPath),
        updatedAt: exists ? fs.statSync(graphJsonPath).mtime : null
    };
}

// ------------------------------------------------------- keeping it in the loop (opt-in)
//
// A project setting (`graphifyAuto` in `.plutos/plutos.config.json`, beside the detected stack)
// decides whether session_start rebuilds a stale graph: the refresh has to happen where the
// session starts, and the MCP server reads this file. The Code map page's "Keep current
// automatically" box writes it through POST /api/graphify/auto; setGraphAutoRefresh is the one
// writer, and it merges rather than replaces.
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
