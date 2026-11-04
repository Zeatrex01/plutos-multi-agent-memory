// Codebase index scan — generates a small catalog at docs/ai/CODEINDEX.md plus one
// shard per top-level folder under docs/ai/codeindex/ (and the matching Obsidian graph
// shards). A single dump does not survive a growing project; the catalog is what a
// session reads, then only the shard for the folder it is changing.
import fs from 'fs';
import path from 'path';
import { commitsSinceDocChanged, BUDGETS } from './hygiene.mjs';

const EXCLUDE_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', '.vscode', 'obj', 'bin', 'Library', 'Temp', 'Packages',
    // common C/C++/Rust/Java build + vendor dirs (generic scanner territory)
    'cmake-build-debug', 'cmake-build-release', 'CMakeFiles', 'vendor', 'third_party', 'external', 'target', '.idea', '__pycache__', '.venv', 'venv',
    // Unreal: generated/derived trees dwarf the real Source/ — indexing them buries it
    'Binaries', 'Intermediate', 'Saved', 'DerivedDataCache', 'Content',
    // Generated knowledge-graph output. Left in, its own GRAPH_REPORT.md is always newer than
    // the graph beside it, so the staleness check would find the graph stale the moment it
    // finished building and rebuild it on every single session, forever.
    'graphify-out']);

// Every scanned file is read and regex-parsed, so an unbounded scan of a large monorepo
// takes minutes and produces an index no one can render. Two guards: a hard ceiling on
// directory enumeration, and a per-scan file budget (override with PLUTOS_MAX_SCAN_FILES).
const WALK_HARD_LIMIT = 50000;
const MAX_SCAN_FILES = Math.max(100, Number(process.env.PLUTOS_MAX_SCAN_FILES) || 2500);

// Exported for lib/graphify.mjs: the exclusion list, the hard limit and the round-robin
// budget below encode real lessons (Unreal's generated trees, monorepo blowups). A second
// walker beside them would rediscover each one the hard way.
export function walk(dir, exts, acc = []) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return acc; }
    for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.') continue;
        if (acc.length >= WALK_HARD_LIMIT) return acc;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (EXCLUDE_DIRS.has(entry.name)) continue;
            walk(full, exts, acc);
        } else if (exts.some(ext => entry.name.endsWith(ext))) {
            acc.push(full);
        }
    }
    return acc;
}

// Trims the file list to the budget round-robin across directories, so the index stays a
// map of the whole project instead of an alphabetical prefix of it.
export function capFiles(files) {
    if (files.length <= MAX_SCAN_FILES) return { files, skipped: 0 };
    const byDir = new Map();
    for (const file of files) {
        const dir = path.dirname(file);
        if (!byDir.has(dir)) byDir.set(dir, []);
        byDir.get(dir).push(file);
    }
    const lists = [...byDir.values()];
    const kept = [];
    for (let i = 0; kept.length < MAX_SCAN_FILES; i++) {
        let progressed = false;
        for (const list of lists) {
            if (i >= list.length) continue;
            kept.push(list[i]);
            progressed = true;
            if (kept.length >= MAX_SCAN_FILES) break;
        }
        if (!progressed) break;
    }
    return { files: kept.sort(), skipped: files.length - kept.length };
}

function limitNote(skipped) {
    return skipped > 0
        ? `> Scan limit: ${MAX_SCAN_FILES} files indexed, ${skipped} skipped. Raise PLUTOS_MAX_SCAN_FILES to include more.`
        : null;
}

// A real Unity project has Assets/ AND ProjectSettings/ProjectVersion.txt — checking only that
// the two folders exist was fooled by stray empty Assets/ProjectSettings shells sitting at a
// wrapper root (e.g. a PLUT_OS project folder one level above the actual Unity checkout, left
// behind by a restructure) into scanning nothing and overwriting a good index with an empty one.
function isUnityProjectDir(dir) {
    return fs.existsSync(path.join(dir, 'Assets')) && fs.existsSync(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt'));
}

// Finds the real Unity project: `root` itself, or — when `root` is a wrapper folder that is not
// itself a Unity project — the first immediate subdirectory that is one. Returns null if neither.
export function findUnityRoot(root) {
    if (isUnityProjectDir(root)) return root;
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return null; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || EXCLUDE_DIRS.has(entry.name)) continue;
        const candidate = path.join(root, entry.name);
        if (isUnityProjectDir(candidate)) return candidate;
    }
    return null;
}

export function detectProjectType(root) {
    if (findUnityRoot(root)) return 'unity';
    if (fs.existsSync(path.join(root, 'package.json'))) return 'node';
    return 'unknown';
}

function readMdDocs(root) {
    const docsDir = path.join(root, 'docs');
    const mdContents = {};
    if (!fs.existsSync(docsDir)) return mdContents;
    for (const file of walk(docsDir, ['.md'])) {
        const posix = file.replace(/\\/g, '/');
        if (/\/docs\/ai\/(codeindex|obsidian)\//i.test(posix)) continue;
        const name = path.basename(file, '.md');
        if (/INDEX|CODEINDEX/i.test(name)) continue;
        try { mdContents[name] = fs.readFileSync(file, 'utf8'); } catch (e) {}
    }
    return mdContents;
}

// Generated maps are a CATALOG plus one shard per top-level folder, not one dump.
// Agents open docs/ai/CODEINDEX.md (the catalog) then only the shard they need.
export const CODEINDEX_SHARD_DIR = ['docs', 'ai', 'codeindex'];
export const OBSIDIAN_SHARD_DIR = ['docs', 'ai', 'obsidian'];

export function shardKey(rel) {
    const parts = String(rel).replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length <= 1) return '_root';
    if (parts[0] === 'Assets' && parts.length > 2) return safeShardName(parts[1]);
    return safeShardName(parts[0]);
}

function safeShardName(name) {
    const cleaned = String(name).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
    return (cleaned || '_root').slice(0, 80);
}

function replaceDirMarkdown(dir, files) {
    fs.mkdirSync(dir, { recursive: true });
    const want = new Set(files.map(f => f.name));
    for (const { name, body } of files) {
        const text = body.endsWith('\n') ? body : body + '\n';
        fs.writeFileSync(path.join(dir, name), text, 'utf8');
    }
    if (!fs.existsSync(dir)) return;
    for (const existing of fs.readdirSync(dir)) {
        if (!existing.endsWith('.md') || want.has(existing)) continue;
        try { fs.unlinkSync(path.join(dir, existing)); } catch (e) { /* stale shard leftover is retryable */ }
    }
}

// Concatenate compact or obsidian shards. Empty string when the partitioned index is absent
// (legacy single-file installs fall back at the call site).
export function readIndexShards(root, kind = 'codeindex') {
    const dir = path.join(root, ...(kind === 'obsidian' ? OBSIDIAN_SHARD_DIR : CODEINDEX_SHARD_DIR));
    if (!root || !fs.existsSync(dir)) return '';
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.md'))
        .sort()
        .map(f => fs.readFileSync(path.join(dir, f), 'utf8'))
        .join('\n');
}

function writePartitionedIndex(root, scan) {
    const outDir = path.join(root, 'docs', 'ai');
    fs.mkdirSync(outDir, { recursive: true });

    const compactShards = new Map();
    const obsidianShards = new Map();
    const ensureOb = (shard) => {
        if (!obsidianShards.has(shard)) obsidianShards.set(shard, { tree: new Map(), details: [] });
        return obsidianShards.get(shard);
    };

    for (const file of scan.treeFiles || []) {
        const shard = shardKey(file.rel);
        const folder = file.rel.includes('/') ? file.rel.split('/').slice(0, -1).pop() : shard;
        const ob = ensureOb(shard);
        if (!ob.tree.has(folder)) ob.tree.set(folder, []);
        ob.tree.get(folder).push(file);
    }

    for (const e of scan.entries || []) {
        const shard = shardKey(e.rel);
        if (e.compact) {
            if (!compactShards.has(shard)) compactShards.set(shard, []);
            compactShards.get(shard).push(e.compact);
        }
        if (e.obsidian && e.obsidian.length) {
            ensureOb(shard).details.push(...e.obsidian, '');
        }
    }

    const shardKeys = [...new Set([...compactShards.keys(), ...obsidianShards.keys()])].sort();

    const compactFiles = shardKeys.map((key) => {
        const lines = compactShards.get(key) || [];
        return {
            name: `${key}.md`,
            key,
            lines: lines.length,
            body: [
                `# CODEINDEX shard: ${key}`,
                `# Generated ${scan.timestamp}`,
                `# Source: ${scan.source}`,
                `# Parent: docs/ai/CODEINDEX.md`,
                '',
                ...lines,
                ''
            ].join('\n')
        };
    });

    const obsidianFiles = shardKeys.map((key) => {
        const ob = obsidianShards.get(key) || { tree: new Map(), details: [] };
        const treeLines = [];
        for (const [folder, files] of [...ob.tree.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            treeLines.push(`### Folder: ${folder}`);
            // Relative only: a file:/// link would publish this machine's home folder with the shard.
            for (const file of files) treeLines.push(`- [[${file.label}]] | ${file.rel}`);
            treeLines.push('');
        }
        return {
            name: `${key}.md`,
            body: [
                `# Obsidian shard: ${key}`,
                `# Generated ${scan.timestamp}`,
                '',
                '## Codebase Directory Tree',
                '',
                ...treeLines,
                '---',
                '## Detailed File Details',
                '',
                ...ob.details
            ].join('\n')
        };
    });

    replaceDirMarkdown(path.join(root, ...CODEINDEX_SHARD_DIR), compactFiles);
    replaceDirMarkdown(path.join(root, ...OBSIDIAN_SHARD_DIR), obsidianFiles);

    const catalog = [
        '# CODEINDEX - catalog',
        `# Generated ${scan.timestamp}`,
        `# Source: ${scan.source}`,
        ...(scan.note ? [scan.note] : []),
        '',
        `Shards: ${shardKeys.length}. Open only the shard for the folder you are changing — do not read every shard.`,
        '',
        '| folder | symbols | shard |',
        '| --- | ---: | --- |',
        ...compactFiles.map(f => `| ${f.key} | ${f.lines} | \`docs/ai/codeindex/${f.name}\` |`),
        '',
        'Compact map: `docs/ai/codeindex/<folder>.md`. Graph map: `docs/ai/obsidian/<folder>.md`.',
        ''
    ].join('\n');

    const obsidianCatalog = [
        '---', 'title: Codebase Obsidian Index', 'type: index', 'tags:', '  - codebase', '  - index', '  - architecture', '---', '',
        '# Codebase Obsidian Index',
        `*Generated on: ${scan.timestamp}*`,
        ...(scan.note ? ['', scan.note] : []),
        '',
        'Catalog only. Details live in `docs/ai/obsidian/<folder>.md` — the dashboard concatenates those shards.',
        '',
        ...shardKeys.map(k => `- [[${k}]] — \`docs/ai/obsidian/${k}.md\``),
        ''
    ].join('\n');

    fs.writeFileSync(path.join(outDir, 'CODEINDEX.md'), catalog, 'utf8');
    fs.writeFileSync(path.join(outDir, 'OBSIDIAN_INDEX.md'), obsidianCatalog, 'utf8');

    return { shards: shardKeys.length };
}

// --- Node/TS/JS scanner ------------------------------------------------------

// .mjs/.cjs matter: an ESM-first Node project (PLUT_OS itself) is otherwise invisible
// in its own index — the scan reported 15 files for a repo whose logic is all .mjs.
const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

const EXPORT_PATTERNS = [
    /export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/g,
    /export\s+(?:default\s+)?class\s+(\w+)/g,
    /export\s+const\s+(\w+)/g,
    /export\s+interface\s+(\w+)/g,
    /export\s+type\s+(\w+)/g,
    // CommonJS (.cjs and plain .js in non-ESM packages)
    /(?:^|\s)(?:module\.)?exports\.(\w+)\s*=/g,
];

function extractExports(raw) {
    const names = new Set();
    for (const re of EXPORT_PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(raw))) names.add(m[1]);
    }
    return [...names];
}

function scanJsProject(root, timestamp) {
    const { files, skipped } = capFiles(walk(root, JS_EXTS)
        .filter(f => !f.includes(`${path.sep}node_modules${path.sep}`))
        .sort());
    const mdContents = readMdDocs(root);
    const note = limitNote(skipped);
    const treeFiles = [];
    const entries = [];

    for (const file of files) {
        const rel = path.relative(root, file).replace(/\\/g, '/');
        treeFiles.push({ rel, label: path.basename(file) });
    }

    let exportedFileCount = 0;
    for (const file of files) {
        let raw;
        try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
        const rel = path.relative(root, file).replace(/\\/g, '/');
        const exports = extractExports(raw);
        if (exports.length === 0) continue;
        exportedFileCount++;

        const refs = [];
        for (const name of exports) {
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(`\\b${escaped}\\b`);
            for (const mdName of Object.keys(mdContents)) {
                if (re.test(mdContents[mdName]) && !refs.includes(`[[${mdName}]]`)) refs.push(`[[${mdName}]]`);
            }
        }

        entries.push({
            rel,
            compact: `[${rel}] exports: ${exports.join(' ')}`,
            obsidian: [
                `### [[${rel}]]`,
                `* **Exports:** ${exports.map(e => `\`${e}\``).join(', ')}`,
                `* **Documentation References:** ${refs.length ? refs.join(', ') : 'None'}`
            ]
        });
    }

    return {
        source: 'JS/TS export scan',
        timestamp,
        note,
        treeFiles,
        entries,
        scannedFiles: files.length,
        exportedFiles: exportedFileCount,
        skippedFiles: skipped
    };
}

// --- Unity (C#) scanner — ported from the previous PowerShell template ------

const CS_SKIP_METHODS = new Set(['Awake', 'Start', 'Update', 'FixedUpdate', 'LateUpdate', 'OnEnable', 'OnDisable', 'OnDestroy', 'OnTriggerEnter', 'OnTriggerExit', 'OnCollisionEnter', 'OnCollisionExit']);

function scanUnityProject(root, timestamp) {
    // `root` may be a wrapper folder (a PLUT_OS project dir one level above the actual Unity
    // checkout) rather than the Unity project itself — resolve the real one for the file walk
    // and for `rel` so shard keys stay `Assets/<category>/...`-shaped; doc cross-refs and the
    // output location still key off the original `root` (unchanged below/at the call site).
    const unityRoot = findUnityRoot(root) || root;
    const targetDir = fs.existsSync(path.join(unityRoot, 'Assets')) ? path.join(unityRoot, 'Assets') : unityRoot;
    const allCs = walk(targetDir, ['.cs']);
    // Only the non-Editor scripts are read and parsed, so the budget applies to those;
    // Editor scripts are listed by path alone and cost nothing.
    const { files, skipped } = capFiles(allCs.filter(f => !f.includes(`${path.sep}Editor${path.sep}`)).sort());
    const editorFiles = allCs.filter(f => f.includes(`${path.sep}Editor${path.sep}`)).sort();
    const mdContents = readMdDocs(root);
    const note = limitNote(skipped);
    const treeFiles = [];
    const entries = [];

    for (const file of files) {
        const raw = fs.readFileSync(file, 'utf8');
        const rel = path.relative(unityRoot, file).replace(/\\/g, '/');
        const classMatch = raw.match(/public\s+(?:abstract\s+|static\s+|partial\s+|sealed\s+)*(?:class|interface|struct)\s+(\w+)/);
        const className = classMatch ? classMatch[1] : path.basename(file, '.cs');
        treeFiles.push({ rel, label: className });
    }

    for (const file of files) {
        const raw = fs.readFileSync(file, 'utf8');
        const rel = path.relative(unityRoot, file).replace(/\\/g, '/');

        const nsMatch = raw.match(/namespace\s+([\w.]+)/);
        const ns = nsMatch ? nsMatch[1] : 'none';

        const classMatch = raw.match(/public\s+(?:abstract\s+|static\s+|partial\s+|sealed\s+)*(?:class|interface|struct)\s+(\w+)(?:\s*:\s*([^\n{]+))?/);
        // className becomes this file's graph-node id (`### [[${className}]]` below) — it must
        // be unique per file. A literal '?' for every file with no matching public type (many,
        // in any real project: private/partial classes, using+namespace-only files) collided on
        // the same id and crashed the dashboard's graph renderer ("item with id ? already
        // exists"), which is what actually produced the "Connection error." the owner saw — the
        // scan itself was fine. The tree-building loop above already falls back to the file's
        // own basename for this exact reason; this loop had drifted from it. classStr (the
        // human-readable "class: X" signature text) has no uniqueness requirement, so its own
        // '?' fallback is unrelated and left as-is.
        const className = classMatch ? classMatch[1] : path.basename(file, '.cs');
        const classStr = classMatch ? (className + (classMatch[2] ? ' : ' + classMatch[2].trim() : '')) : '?';

        const methods = [...raw.matchAll(/public\s+(?:override\s+|static\s+|virtual\s+)*(?:void|bool|int|float|string|IEnumerator|\w+)\s+(\w+)\s*\(/g)]
            .map(m => m[1]).filter(m => !CS_SKIP_METHODS.has(m));
        const uniqueMethods = [...new Set(methods)];
        const fires = [...new Set([...raw.matchAll(/GameEvents\.(On\w+)\?/g)].map(m => m[1]))];
        const listens = [...new Set([...raw.matchAll(/GameEvents\.(On\w+)\s*[+-]=/g)].map(m => m[1]))];

        let compact = `[${rel}] ns=${ns} | ${classStr}`;
        if (uniqueMethods.length) compact += ` | pub: ${uniqueMethods.join(' ')}`;
        if (fires.length) compact += ` | fires: ${fires.join(' ')}`;
        if (listens.length) compact += ` | listens: ${listens.join(' ')}`;

        const refs = [];
        if (className !== '?') {
            const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(`\\b${escaped}\\b`);
            for (const mdName of Object.keys(mdContents)) {
                if (re.test(mdContents[mdName])) refs.push(`[[${mdName}]]`);
            }
        }

        const obsidian = [
            `### [[${className}]]`,
            `* **Signature:** \`namespace ${ns} | class ${classStr}\``,
            `* **Documentation References:** ${refs.length ? refs.join(', ') : 'None'}`
        ];
        if (uniqueMethods.length) obsidian.push(`* **Public Methods:** ${uniqueMethods.map(m => `\`${m}()\``).join(', ')}`);
        if (fires.length) obsidian.push(`* **Events Fired:** ${fires.map(f => `\`${f}\``).join(', ')}`);
        if (listens.length) obsidian.push(`* **Events Listened:** ${listens.map(l => `\`${l}\``).join(', ')}`);

        entries.push({ rel, compact, obsidian });
    }

    for (const file of editorFiles) {
        const rel = path.relative(unityRoot, file).replace(/\\/g, '/');
        const name = path.basename(file, '.cs');
        treeFiles.push({ rel, label: name });
        entries.push({
            rel,
            compact: `[${rel}] editor`,
            obsidian: [`- [[${name}]] | [[Notes - ${name}|Notes]]`]
        });
    }

    return {
        source: 'C# Script Scan',
        timestamp,
        note,
        treeFiles,
        entries,
        scannedFiles: files.length + editorFiles.length,
        exportedFiles: files.length,
        skippedFiles: skipped
    };
}

// --- Generic scanner (any stack: C/C++, Python, Rust, Go, Java, ...) --------
// Fallback for projects that are neither Unity nor Node. Walks a broad set of source
// extensions and extracts what can be had cheaply and language-agnostically: type
// definitions (class/struct/interface/enum/trait) and function definitions in the
// `def/func/fn/function` families. C/C++ function bodies are deliberately not parsed
// (too noisy without a real parser) — headers' type definitions carry the map.

export const GENERIC_EXTS = ['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx',
    '.py', '.rs', '.go', '.java', '.kt', '.swift', '.rb', '.php', '.lua', '.gd',
    '.cs', '.m', '.mm', '.scala', '.zig', '.dart', '.ex', '.exs', ...JS_EXTS];

const GENERIC_TYPE_RE = /(?:^|\s)(?:class|struct|interface|enum|trait)\s+([A-Za-z_]\w*)/g;
const GENERIC_FN_RES = [
    /(?:^|\s)def\s+([A-Za-z_]\w*)\s*\(/g,          // python, ruby, elixir
    /(?:^|\s)func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[(\[<]/g, // go, swift, gdscript (incl. go methods)
    /(?:^|\s)fn\s+([A-Za-z_]\w*)\s*[(<]/g,          // rust, zig
    /(?:^|\s)function\s+([A-Za-z_]\w*)\s*\(/g,      // js, php, lua
];

function extractGenericSymbols(raw) {
    const types = new Set();
    const fns = new Set();
    GENERIC_TYPE_RE.lastIndex = 0;
    let m;
    while ((m = GENERIC_TYPE_RE.exec(raw))) types.add(m[1]);
    for (const re of GENERIC_FN_RES) {
        re.lastIndex = 0;
        while ((m = re.exec(raw))) fns.add(m[1]);
    }
    return { types: [...types], fns: [...fns] };
}

function scanGenericProject(root, timestamp) {
    const { files, skipped } = capFiles(walk(root, GENERIC_EXTS).sort());
    const mdContents = readMdDocs(root);
    const note = limitNote(skipped);
    const treeFiles = [];
    const entries = [];

    for (const file of files) {
        const rel = path.relative(root, file).replace(/\\/g, '/');
        treeFiles.push({ rel, label: path.basename(file) });
    }

    let symbolFileCount = 0;
    for (const file of files) {
        let raw;
        try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
        const rel = path.relative(root, file).replace(/\\/g, '/');
        const { types, fns } = extractGenericSymbols(raw);
        if (types.length === 0 && fns.length === 0) continue;
        symbolFileCount++;

        let compact = `[${rel}]`;
        if (types.length) compact += ` types: ${types.join(' ')}`;
        if (fns.length) compact += ` | fns: ${fns.join(' ')}`;

        const refs = [];
        for (const name of [...types, ...fns]) {
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(`\\b${escaped}\\b`);
            for (const mdName of Object.keys(mdContents)) {
                if (re.test(mdContents[mdName]) && !refs.includes(`[[${mdName}]]`)) refs.push(`[[${mdName}]]`);
            }
        }

        const obsidian = [`### [[${rel}]]`];
        if (types.length) obsidian.push(`* **Types:** ${types.map(t => `\`${t}\``).join(', ')}`);
        if (fns.length) obsidian.push(`* **Functions:** ${fns.map(f => `\`${f}()\``).join(', ')}`);
        obsidian.push(`* **Documentation References:** ${refs.length ? refs.join(', ') : 'None'}`);

        entries.push({ rel, compact, obsidian });
    }

    return {
        source: 'generic source scan',
        timestamp,
        note,
        treeFiles,
        entries,
        scannedFiles: files.length,
        exportedFiles: symbolFileCount,
        skippedFiles: skipped
    };
}

// → { type, scannedFiles, exportedFiles, skippedFiles, maxScanFiles, outPath }
export function runCodeScan(root, { outputRoot = root } = {}) {
    const detected = detectProjectType(root);
    // Unknown stacks (C++, Python, Rust, Go, ...) get the generic scanner instead of an
    // error — every project deserves at least a file/symbol map. Was: throw, which made
    // the Codebase Index tab fail outright for anything that wasn't Unity or Node.
    const type = detected === 'unknown' ? 'generic' : detected;
    const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const result = type === 'unity' ? scanUnityProject(root, timestamp)
        : type === 'node' ? scanJsProject(root, timestamp)
        : scanGenericProject(root, timestamp);

    // Reading and storage are deliberately separate. The dashboard's non-invasive
    // "observe" mode scans the real project but writes the generated index under the
    // PLUT_OS home directory; an explicitly installed project keeps the traditional
    // in-repository docs/ai output. A scanner must never force installation merely
    // because somebody wanted to look at a code map.
    const outDir = path.join(outputRoot, 'docs', 'ai');
    const written = writePartitionedIndex(outputRoot, result);

    return {
        type,
        scannedFiles: result.scannedFiles,
        exportedFiles: result.exportedFiles,
        skippedFiles: result.skippedFiles || 0,
        shards: written.shards,
        maxScanFiles: MAX_SCAN_FILES,
        outPath: outDir
    };
}

// Check if any source file in the project is newer than the generated index
// Exported for lib/graphify.mjs: "has the source moved past this generated artifact" is the
// same question for the graph as for the index, and it should not get a second answer.
export function isSourceNewerThan(dir, exts, targetMtime, depth = 0) {
    if (depth > 6) return false;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return false; }
    for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.') continue;
        if (EXCLUDE_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (isSourceNewerThan(full, exts, targetMtime, depth + 1)) return true;
        } else if (exts.some(ext => entry.name.endsWith(ext))) {
            try {
                if (fs.statSync(full).mtimeMs > targetMtime) return true;
            } catch (e) {}
        }
    }
    return false;
}

// Mechanical, lossless self-heal for the ONE map that is generated rather than authored.
// The catalog (CODEINDEX.md) plus docs/ai/codeindex/*.md shards are produced by runCodeScan,
// so regenerating them when missing, still a legacy dump, or well behind the code is always
// safe. PROJECT_MAP.md is deliberately NOT touched here. Never throws.
export function refreshIndexIfStale(root) {
    try {
        if (!root || !fs.existsSync(root)) return { rescanned: false };
        const rel = 'docs/ai/CODEINDEX.md';
        const indexPath = path.join(root, 'docs', 'ai', 'CODEINDEX.md');
        const exists = fs.existsSync(indexPath);
        const shardDir = path.join(root, ...CODEINDEX_SHARD_DIR);
        const sharded = fs.existsSync(shardDir) && fs.readdirSync(shardDir).some(f => f.endsWith('.md'));
        const age = exists ? commitsSinceDocChanged(root, rel) : null;
        let stale = false;
        let reason = !exists ? 'missing' : (!sharded ? 'unsharded' : '');

        if (age) {
            stale = age.commitsBehind > BUDGETS.docCommitsBehind;
            // A rescan rewrites the index without committing it, so the commit count stays over
            // the budget and every brief used to scan again (about half a second each time). An
            // index file newer than every source file is current, whatever the count says.
            if (stale) {
                try { if (!isSourceNewerThan(root, GENERIC_EXTS, fs.statSync(indexPath).mtimeMs)) stale = false; } catch (e) {}
            }
            if (stale) reason = 'stale';
        } else if (exists && sharded) {
            // Git fallback: compare source file mtimes against CODEINDEX.md
            try {
                const indexMtime = fs.statSync(indexPath).mtimeMs;
                if (isSourceNewerThan(root, GENERIC_EXTS, indexMtime)) {
                    stale = true;
                    reason = 'mtime-stale';
                }
            } catch (e) {}
        }

        if (!exists || !sharded || stale) {
            runCodeScan(root);
            return { rescanned: true, reason };
        }
    } catch (e) { /* generating a map must never break session_start */ }
    return { rescanned: false };
}
