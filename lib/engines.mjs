// The engines the core recognises, in one table (owner decision 2026-11-17: "The core recognises an
// engine, it does not know the engine"). The core detects which path a project is on and what that
// path needs at file level: which files are code, which are scenes and assets, how files name each
// other. How to write code for an engine, its APIs and its traps belong to packs, and so do
// function-level callers: a pack prepares `.codegraph/graph.db`, the core only shows it.
//
// This is the only core file that names an engine for the code map (tools/rule-of-two-test.mjs).
// lib/graphify.mjs, lib/codegraph-callers.mjs and lib/file-types.mjs read the rows generically; a new
// engine is a new row here and nothing else.
//
// A row:
//   id, label   a short name (also the code map's link `type` for this engine's edges) and the name shown
//   marker      what identifies the engine project's root folder, relative to that folder:
//                 file  a file path; its last part may be `*.ext` (any file with that suffix)
//                 dirs  folders that must also sit in the root
//   language    optional: the id of the language row (lib/file-types.mjs) for the `code` suffixes, when
//               the language belongs to this engine alone; the row is mapped like any other language
//   code        code suffixes whose files this engine's `in: 'code'` rules read (the file is read once,
//               by the main scan; the files themselves are in the code map wherever they sit)
//   assets      scene/asset suffixes that join the code map only inside such a root, read to their
//               first `assetBytes` bytes (default 400 KB)
//   assetDirs   optional: the folders, from the root, the asset walk covers; without it, the whole root
//   assetBytes  optional: how much of each asset is read, when references are spread through the file
//               (the asset rules' cost must then stay linear: no nested or overlapping quantifiers)
//   lineComment a line-comment opener dropped from code text before the code rules run, outside strings
//   kinds       edge kinds, strongest first (one edge per file pair, the strongest kind wins), with the
//               page's English word for each (ui/i18n.js depgraph_page_kind_<id> translates it)
//   classDecl   a pattern whose group 1 is a class name a code file declares; within one root a name two
//               files declare is dropped, not guessed. It also counts as a declaration for the references
//               edges wherever a file with one of the `code` suffixes sits
//   guids       { suffix, pattern }: the file `<file><suffix>` beside a mapped file gives that file's id
//               (group 1); within one root a duplicated id is dropped
//   refs        reference rules: { in: 'code'|'asset', match, flags, to, kind }. `match` is a regex
//               source whose group 1 names the target; a `g` flag takes every match, otherwise the
//               first. `match: 'identifiers'` takes every identifier outside comments and strings.
//               `to` says how a match resolves to a mapped file:
//                 path   a path from the root (after `pathPrefix`, cut at `pathCut`); never above the root
//                 class  a classDecl name in the same root
//                 guid   a guids id in the same root
//               Cost (checked by tools/engine-graph-test.mjs): a line-anchored pattern opens with `^[ \t]*`,
//               never `^\s*`, which is quadratic on blank-line runs; a repeated group never holds `\s`, `\S`,
//               `\W`, `\D` or a `[^…]` without `\n`, so its backtracking stays inside one line. That keeps a
//               match attempt to one line's length; it is not a proof of linearity for any pattern.
//   fileTypes   the task index's rows for this engine (lib/file-types.mjs splices them in, in order)
//   callers     the pack-prepared function graph lib/codegraph-callers.mjs reads, when present:
//                 exts      code suffixes it answers for
//                 db        its path from the root
//                 pathPrefix  how the database names a file (`<pathPrefix><path from the root>`)
//                 hint      the command the engine's pack documents for building it (shown, never run)
//                 rootField the response field naming the root folder (the GET /api/graphify/callers
//                           contract has carried this name since it shipped)
//
// "web" is not a row: a project with no marker is on the default path, the code map as it always was.

export const ENGINES = [
    {
        id: 'godot', label: 'Godot',
        marker: { file: 'project.godot' },
        language: 'gdscript',
        code: ['.gd'],
        assets: ['.tscn', '.tres'],
        lineComment: '#',
        pathPrefix: 'res://', pathCut: '::',
        kinds: [
            { id: 'extends', label: 'extends' },
            { id: 'preload', label: 'preload/load' },
            { id: 'scene', label: 'scene resource' },
            { id: 'class', label: 'uses class' },
        ],
        classDecl: '^[ \\t]*(?:@\\w+(?:\\([^)\\n]*\\))?[ \\t]+)*class_name\\s+([A-Za-z_]\\w*)',
        refs: [
            { in: 'code', match: '\\b(?:preload|load)\\s*\\(\\s*["\']res:\\/\\/([^"\'\\n]+)["\']', flags: 'g', to: 'path', kind: 'preload' },
            { in: 'code', match: '^[ \\t]*(?:@\\w+(?:\\([^)\\n]*\\))?[ \\t]+)*(?:class_name\\s+\\w+\\s+)?extends\\s+["\']res:\\/\\/([^"\'\\n]+)["\']', flags: 'm', to: 'path', kind: 'extends' },
            { in: 'code', match: '^[ \\t]*(?:@\\w+(?:\\([^)\\n]*\\))?[ \\t]+)*(?:class_name\\s+\\w+\\s+)?extends\\s+([A-Za-z_]\\w*)\\s*(?:$|[#:\\n])', flags: 'm', to: 'class', kind: 'extends' },
            { in: 'code', match: 'identifiers', to: 'class', kind: 'class' },
            { in: 'asset', match: '^\\[ext_resource\\b[^\\n\\]]*?\\bpath="res:\\/\\/([^"\\n]+)"', flags: 'gm', to: 'path', kind: 'scene' },
        ],
        fileTypes: [
            { id: 'godot-project', concepts: ['engine-settings', 'package'], names: ['project.godot'] },
            { id: 'godot-scene', concepts: ['scene'], exts: ['.tscn', '.tres'], paths: ['scenes/'] },
        ],
        callers: {
            exts: ['.gd'],
            db: '.codegraph/graph.db',
            pathPrefix: 'res://',
            hint: 'python .claude/skills/godot-code-tools/scripts/who_calls.py --rebuild',
            rootField: 'godotRoot',
        },
    },
    {
        id: 'unity', label: 'Unity',
        marker: { file: 'ProjectSettings/ProjectVersion.txt', dirs: ['Assets'] },
        code: ['.cs'],
        assets: ['.unity', '.prefab', '.asset', '.mat', '.controller'],
        // Project and editor settings (ProjectSettings/, UserSettings/) are .asset files too, not project assets.
        assetDirs: ['Assets'],
        // A scene's references are spread through the whole YAML, not gathered at its top; the guid rule
        // below is linear, so reading 4 MB of each costs time in proportion to the bytes only.
        assetBytes: 4_000_000,
        kinds: [{ id: 'uses', label: 'uses asset' }],
        // Unity YAML names another asset by the guid in that asset's .meta file:
        // `m_Script: {fileID: 11500000, guid: 0123…, type: 3}`.
        guids: { suffix: '.meta', pattern: '^guid:[ \\t]*([0-9a-f]{32})\\b' },
        refs: [
            { in: 'asset', match: '\\bguid:[ \\t]*([0-9a-f]{32})\\b', flags: 'g', to: 'guid', kind: 'uses' },
        ],
        fileTypes: [
            { id: 'unity-scene', concepts: ['scene'], exts: ['.unity', '.prefab', '.asset', '.mat', '.controller'], paths: ['Assets/Scenes/'] },
            { id: 'unity-settings', concepts: ['engine-settings'], exts: ['.meta'], paths: ['ProjectSettings/'] },
        ],
    },
    {
        // Recognised and labelled only: .uasset and .umap are binary, so there are no file edges to read.
        id: 'unreal', label: 'Unreal',
        marker: { file: '*.uproject' },
        code: [],
        assets: [],
        kinds: [],
        refs: [],
        fileTypes: [
            { id: 'unreal-project', concepts: ['engine-settings', 'package'], exts: ['.uproject'], paths: ['*.uproject'] },
        ],
    },
];

// Every edge kind in table order: the page gives each its own colour, stable across projects.
export const ENGINE_KINDS = (() => {
    const seen = new Map();
    for (const e of ENGINES) for (const k of e.kinds) if (!seen.has(k.id)) seen.set(k.id, k.label);
    return [...seen].map(([id, label]) => ({ id, label }));
})();

// The base name (or `.ext` suffix) the walker looks for to find an engine's marker.
export const markerName = engine => {
    const last = engine.marker.file.split('/').pop();
    return last.startsWith('*') ? last.slice(1) : last;
};
