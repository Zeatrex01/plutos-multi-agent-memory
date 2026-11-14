#!/usr/bin/env node
// lib/file-types.mjs: the one file-type table the code map, the task index and the code index read
// (owner decision d-a67637f8d490). Its shape, no suffix in two rows, the code map unchanged by it,
// and the meta files recognised with their concepts.
import assert from 'node:assert/strict';
import { FILE_TYPES, CODE_MAP_EXTS, IMPORT_PARSED_EXTS, TASK_ONLY_EXTS, CODE_INDEX_EXTS, KNOWN_SUFFIXES, KNOWN_NAMES,
    conceptLocations, fileTypeOf } from '../lib/file-types.mjs';
import { CODE_EXTS } from '../lib/graphify.mjs';
import { TASK_EXTRA_EXTS, CONVENTIONAL } from '../lib/task-context.mjs';
import { GENERIC_EXTS } from '../lib/codeindex.mjs';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

const KINDS = new Set(['code', 'meta', 'doc', 'asset']);
const FLAGS = ['inCodeMap', 'taskSearch', 'importsParsed', 'codeIndex'];

check('every row has the table shape', () => {
    const ids = new Set();
    for (const r of FILE_TYPES) {
        assert.ok(/^[a-z][a-z0-9-]*$/.test(r.id), `id ${r.id}`);
        assert.ok(!ids.has(r.id), `duplicate id ${r.id}`); ids.add(r.id);
        assert.ok(KINDS.has(r.kind), `${r.id}: kind ${r.kind}`);
        assert.ok(Array.isArray(r.concepts), `${r.id}: concepts`);
        for (const f of FLAGS) assert.equal(typeof r[f], 'boolean', `${r.id}.${f}`);
        const found = [...(r.exts || []), ...(r.names || []), ...(r.paths || [])];
        assert.ok(found.length, `${r.id} matches no file`);
        for (const e of r.exts || []) assert.ok(/^\.[a-z0-9]+$/.test(e), `${r.id}: ext ${e} is lower case with a dot`);
        if (r.importsParsed) assert.ok(r.inCodeMap, `${r.id}: imports are parsed only for code-map rows`);
        if (r.inCodeMap) assert.ok(r.taskSearch && r.kind === 'code', `${r.id}: a code-map row is code the task index reads`);
    }
});
check('no suffix in two rows', () => {
    const seen = new Map();
    for (const r of FILE_TYPES) for (const e of r.exts || []) {
        assert.ok(!seen.has(e), `${e} in ${seen.get(e)} and ${r.id}`); seen.set(e, r.id);
    }
});
check('the code map reads exactly the languages it read before the table, in the same order', () => {
    assert.deepEqual(CODE_EXTS, ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.cs', '.go',
        '.rs', '.java', '.cpp', '.c', '.h', '.hpp', '.gd', '.lua', '.php', '.rb', '.swift', '.kt']);
    assert.deepEqual(CODE_EXTS, CODE_MAP_EXTS);
});
check('relative imports are parsed for the JS/TS family only', () => {
    assert.deepEqual([...IMPORT_PARSED_EXTS].sort(), ['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
});
check('the code index reads the same languages as before', () => {
    assert.deepEqual([...GENERIC_EXTS].sort(), ['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx',
        '.py', '.rs', '.go', '.java', '.kt', '.swift', '.rb', '.php', '.lua', '.gd',
        '.cs', '.m', '.mm', '.scala', '.zig', '.dart', '.ex', '.exs', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].sort());
    assert.deepEqual(GENERIC_EXTS, CODE_INDEX_EXTS);
});
check('the task index reads SQL, Dart, Scala, Elixir, Zig, web components and shaders beside the map', () => {
    assert.deepEqual(TASK_EXTRA_EXTS, TASK_ONLY_EXTS);
    for (const e of ['.sql', '.dart', '.scala', '.ex', '.zig', '.vue', '.svelte', '.astro', '.gdshader', '.hlsl', '.glsl', '.wgsl', '.shader'])
        assert.ok(TASK_EXTRA_EXTS.includes(e), e);
    for (const e of TASK_EXTRA_EXTS) assert.ok(!CODE_EXTS.includes(e), `${e} is in both`);
});
check('meta files are recognised with their concepts', () => {
    const cases = {
        'project.godot': ['engine-settings', 'godot-project'], 'vercel.json': ['deploy', 'vercel'],
        'Game.uproject': ['engine-settings', 'unreal-project'], 'scenes/main.tscn': ['scene', 'godot-scene'],
        'Assets/Scenes/Level.unity': ['scene', 'unity-scene'], 'Dockerfile': ['deploy', 'docker'],
        'docker-compose.prod.yml': ['deploy', 'docker'], '.github/workflows/ci.yml': ['ci', 'github-actions'],
        '.gitlab-ci.yml': ['ci', 'ci-config'], 'supabase/migrations/001_init.sql': ['schema', 'migrations'],
        'prisma/schema.prisma': ['schema', 'prisma'], 'db/report.sql': ['schema', 'migrations'], 'queries/report.sql': ['data', 'sql'],
        'playwright.config.ts': ['test', 'test-config'], 'pytest.ini': ['test', 'test-config'],
        'package.json': ['package', 'node-package'], 'Cargo.toml': ['package', 'cargo'], 'go.mod': ['package', 'go-module'],
        'pubspec.yaml': ['package', 'pubspec'], 'App.csproj': ['build', 'dotnet-project'], 'tsconfig.json': ['config', 'typescript-config'],
        'src/settings.json': ['config', 'json'], 'shaders/dissolve.gdshader': [null, 'shader'], 'src/App.vue': [null, 'web-component'],
    };
    for (const [file, [concept, id]] of Object.entries(cases)) {
        const row = fileTypeOf(file);
        assert.equal(row?.id, id, file);
        if (concept) assert.ok(row.concepts.includes(concept), `${file}: ${concept} not in ${row.concepts}`);
    }
    assert.equal(fileTypeOf('notes/unknown.qqq'), null);
});
check('code is code wherever it sits: a folder rule does not take a code file it shares no concept with', () => {
    const cases = { 'Assets/Scenes/Player.cs': 'csharp', 'tests/board.test.mjs': 'javascript', 'db/models.py': 'python',
        'scenes/player.gd': 'gdscript', 'src/tests/e2e/login.ts': 'typescript',
        // ...but a folder still takes what belongs there, and a named file is its row.
        'db/001.sql': 'migrations', 'scenes/main.tscn': 'godot-scene', 'tests/fixtures/data.json': 'test-config',
        'vitest.config.ts': 'test-config', 'src/middleware.ts': 'auth-entry' };
    for (const [file, id] of Object.entries(cases)) assert.equal(fileTypeOf(file)?.id, id, file);
});
check('every suffix the table knows is a file suffix for a task; its names are matched whole', () => {
    for (const s of ['sql', 'tscn', 'vue', 'json', 'toml', 'yml', 'csproj', 'wgsl']) assert.ok(KNOWN_SUFFIXES.has(s), s);
    for (const s of ['items', 'mod', 'example', 'sample', 'godot']) assert.ok(!KNOWN_SUFFIXES.has(s), `${s} is a name's tail, not a suffix`);
    for (const n of ['project.godot', 'go.mod', '.env.example', 'package.json']) assert.ok(KNOWN_NAMES.has(n), n);
    assert.ok(![...KNOWN_NAMES].some(n => n.includes('*')));
});
check('every concept the task index has words for has conventional locations in the table', () => {
    for (const c of CONVENTIONAL) assert.ok(c.paths.length && c.paths.join() === conceptLocations(c.concept).join(), c.concept);
    assert.deepEqual(conceptLocations('deploy').slice(0, 3), ['vercel.json', 'netlify.toml', 'Dockerfile']);
    assert.deepEqual(conceptLocations('config').slice(0, 6), ['.env.example', '.env.sample', 'next.config.*', 'vite.config.*', 'webpack.config.*', 'tsconfig.json']);
    assert.deepEqual(conceptLocations('schema').slice(0, 3), ['prisma/schema.prisma', 'supabase/migrations/', 'migrations/']);
});
console.log(`File types: ${passed} passed, 0 failed`);
