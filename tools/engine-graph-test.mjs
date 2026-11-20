#!/usr/bin/env node
// The code map inside an engine project (lib/engines.mjs read by lib/graphify.mjs engineEdges) and the
// function-level callers read from a pack-prepared .codegraph/graph.db (lib/codegraph-callers.mjs):
// Godot (edges and callers), Unity (guid edges), Unreal (recognised, no edges), and a repository on no
// engine left as it was. Temp folders only.
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { spawn, execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { scanCodeGraph, buildProjectDocGraph, renderGraphPage, getProjectDocGraphStatus, readHead, HEAD_BYTES } from '../lib/graphify.mjs';
import { taskContext, resetTaskContextCache } from '../lib/task-context.mjs';
import { readCallers, CODEGRAPH_LIMITS, CALLER_EXTS } from '../lib/codegraph-callers.mjs';
import { ENGINES, ENGINE_KINDS } from '../lib/engines.mjs';
import { routeNeedsProject, PROJECT_READ_ROUTES } from '../lib/route-policy.mjs';

const GODOT = ENGINES.find(e => e.id === 'godot');
const CODEGRAPH_REL = path.join(...GODOT.callers.db.split('/'));
const CODEGRAPH_HINT = GODOT.callers.hint;
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };
const checkAsync = async (name, fn) => { await fn(); passed++; console.log(`  ok  ${name}`); };
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-godot-graph-'));
const write = (root, rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };

// A Godot project nested in a repository (game/project.godot), so res:// is not the repository root.
const godot = path.join(tmp, 'godot');
write(godot, 'game/project.godot', 'config_version=5\n[application]\nconfig/name="Fixture"\n');
write(godot, 'game/scripts/enemy.gd', 'class_name Enemy\nextends CharacterBody2D\n\nconst Bullet = preload("res://scripts/bullet.gd")\n\n'
    + 'func take_hit(amount: int) -> void:\n\tvar b = Bullet.new()\n\tb.fire(amount)\n');
write(godot, 'game/scripts/boss.gd', 'extends Enemy\n# preload("res://scripts/ghost.gd") is a comment\n\nfunc roar() -> void:\n\ttake_hit(5)\n');
write(godot, 'game/scripts/bullet.gd', 'extends Node\n\nfunc fire(power: int) -> void:\n\tvar target: Enemy = null\n\tprint(power, target)\n');
write(godot, 'game/scripts/ghost.gd', 'extends "res://scripts/boss.gd"\nvar loader = load("res://scenes/level.tscn")\n');
write(godot, 'game/scenes/main.tscn', '[gd_scene load_steps=3 format=3 uid="uid://abc"]\n\n'
    + '[ext_resource type="Script" uid="uid://s1" path="res://scripts/boss.gd" id="1_a"]\n'
    + '[ext_resource type="PackedScene" path="res://scenes/level.tscn" id="2_b"]\n'
    + '[ext_resource type="Texture2D" path="res://icon.svg" id="3_c"]\n\n[node name="Main" type="Node2D"]\nscript = ExtResource("1_a")\n');
write(godot, 'game/scenes/level.tscn', '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://scripts/enemy.gd" id="1"]\n\n[node name="Level" type="Node2D"]\n');
write(godot, 'game/data/stats.tres', '[gd_resource type="Resource" format=3]\n\n[ext_resource type="Script" path="res://scripts/bullet.gd" id="1"]\n');

const edgesOf = g => g.links.map(l => `${l.source} -> ${l.target} ${l.type}${l.kind ? ':' + l.kind : ''}`).sort();

check('JSONC tsconfig aliases resolve Next.js imports and read the config once per scan', () => {
    const dir = path.join(tmp, 'ts-alias');
    write(dir, 'tsconfig.json', '{ // comment\n "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./*"] } }, }');
    write(dir, 'lib/server/orderPricing.ts', 'export function priceCartServerSide() {}\n');
    write(dir, 'app/api/orders/route.ts', "import { priceCartServerSide } from '@/lib/server/orderPricing';\nimport React from 'react';\n");
    write(dir, 'app/api/orders/sync/route.ts', "export { priceCartServerSide } from '@/lib/server/orderPricing';\n");
    const reads = [];
    const original = fs.openSync;
    fs.openSync = function (file, ...args) { reads.push(String(file)); return original.call(this, file, ...args); };
    let g;
    try { g = scanCodeGraph(dir); } finally { fs.openSync = original; }
    assert.deepEqual(edgesOf(g), [
        'app/api/orders/route.ts -> lib/server/orderPricing.ts imports',
        'app/api/orders/sync/route.ts -> lib/server/orderPricing.ts imports'
    ]);
    assert.equal(reads.filter(f => f === path.join(dir, 'tsconfig.json')).length, 1);
});

check('relative extends keeps inherited config origins across two levels', () => {
    const dir = path.join(tmp, 'ts-extends');
    write(dir, 'tsconfig.json', '{ "extends": "./config/middle" }');
    write(dir, 'config/middle.json', '{ "extends": "./base.json" }');
    write(dir, 'config/base.json', '{ /* base */ "compilerOptions": { "baseUrl": "../src", "paths": { "@/*": ["./*"] } } }');
    write(dir, 'src/lib/value.ts', 'export const value = 1;\n');
    write(dir, 'app.ts', "import { value } from '@/lib/value';\nimport 'lib/value';\n");
    assert.deepEqual(edgesOf(scanCodeGraph(dir)), ['app.ts -> src/lib/value.ts imports']);
});

check('jsconfig aliases default to the config folder and use extension/index resolution', () => {
    const dir = path.join(tmp, 'js-alias');
    write(dir, 'jsconfig.json', '{ "compilerOptions": { "paths": { "@/*": ["src/*"], "@value": ["src/value"] } } }');
    write(dir, 'src/value/index.js', 'export const value = 1;\n');
    write(dir, 'app.js', "import '@value';\nimport '@/value';\n");
    assert.deepEqual(edgesOf(scanCodeGraph(dir)), ['app.js -> src/value/index.js imports']);
});

check('alias targets use the first existing file; wildcard suffixes and specific patterns match', () => {
    const dir = path.join(tmp, 'alias-targets');
    write(dir, 'tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: {
        '@/*': ['missing/*', 'src/*', 'other/*'], '@special/*': ['special/*'], '@suffix/*/item': ['src/*']
    } } }));
    for (const folder of ['src', 'other', 'special']) write(dir, `${folder}/value.ts`, 'export const value = 1;\n');
    write(dir, 'src/special/value.ts', 'export const value = 2;\n');
    write(dir, 'app.ts', "import '@/value';\nimport '@special/value';\nimport '@suffix/value/item';\nimport '@/absent';\nimport 'some-package';\n");
    assert.deepEqual(edgesOf(scanCodeGraph(dir)), ['app.ts -> special/value.ts imports', 'app.ts -> src/value.ts imports']);
});

check('bare baseUrl imports resolve only existing project files and configs are reloaded each scan', () => {
    const dir = path.join(tmp, 'base-url');
    write(dir, 'tsconfig.json', '{ "compilerOptions": { "baseUrl": "src" } }');
    write(dir, 'src/lib/value.ts', 'export const value = 1;\n');
    write(dir, 'local.ts', 'export const local = 1;\n');
    write(dir, 'app.ts', "import 'lib/value';\nimport 'missing-package';\nimport './local';\n");
    assert.deepEqual(edgesOf(scanCodeGraph(dir)), ['app.ts -> local.ts imports', 'app.ts -> src/lib/value.ts imports']);
    write(dir, 'tsconfig.json', '{}');
    write(dir, 'app.ts', "import 'lib/value';\n");
    assert.deepEqual(scanCodeGraph(dir).links, []);
});

check('extends cycles stop, child options override parents, and JSONC preserves string contents', () => {
    const dir = path.join(tmp, 'alias-cycle');
    write(dir, 'tsconfig.json', '{ "extends": "./base.json", "compilerOptions": { "paths": { "@/*": ["./src/*"], "@literal": ["./src/comma,]value"] } } }');
    write(dir, 'base.json', '{ "extends": "./tsconfig.json", "compilerOptions": { "paths": { "@/*": ["./wrong/*"] } } }');
    write(dir, 'src/value.ts', 'export const value = 1;\n');
    write(dir, 'src/comma,]value.ts', 'export const literal = 1;\n');
    write(dir, 'app.ts', "import '@/value';\nimport '@literal';\n");
    assert.deepEqual(edgesOf(scanCodeGraph(dir)), ['app.ts -> src/comma,]value.ts imports', 'app.ts -> src/value.ts imports']);
});

check('tsconfig takes precedence over jsconfig and malformed configs keep relative imports working', () => {
    const dir = path.join(tmp, 'bad-config');
    write(dir, 'tsconfig.json', '{ invalid }');
    write(dir, 'jsconfig.json', '{ "compilerOptions": { "paths": { "@/*": ["./*"] } } }');
    write(dir, 'value.ts', 'export const value = 1;\n');
    write(dir, 'app.ts', "import '@/value';\nimport './value';\n");
    assert.deepEqual(edgesOf(scanCodeGraph(dir)), ['app.ts -> value.ts imports']);
    write(dir, 'app.ts', "import '@/value';\n");
    assert.deepEqual(scanCodeGraph(dir).links, []);
});

check('a Godot project: script and scene edges with their kinds, res:// from the folder holding project.godot', () => {
    const g = scanCodeGraph(godot);
    const ids = g.nodes.map(n => n.id).sort();
    assert.deepEqual(ids, ['game/data/stats.tres', 'game/scenes/level.tscn', 'game/scenes/main.tscn', 'game/scripts/boss.gd',
        'game/scripts/bullet.gd', 'game/scripts/enemy.gd', 'game/scripts/ghost.gd']);
    const godotEdges = edgesOf({ links: g.links.filter(l => l.type === 'godot') });
    assert.deepEqual(godotEdges, [
        'game/data/stats.tres -> game/scripts/bullet.gd godot:scene',
        'game/scenes/level.tscn -> game/scripts/enemy.gd godot:scene',
        'game/scenes/main.tscn -> game/scenes/level.tscn godot:scene',
        'game/scenes/main.tscn -> game/scripts/boss.gd godot:scene',
        'game/scripts/boss.gd -> game/scripts/enemy.gd godot:extends',
        'game/scripts/bullet.gd -> game/scripts/enemy.gd godot:class',
        'game/scripts/enemy.gd -> game/scripts/bullet.gd godot:preload',
        'game/scripts/ghost.gd -> game/scenes/level.tscn godot:preload',
        'game/scripts/ghost.gd -> game/scripts/boss.gd godot:extends'
    ]);
    // One edge per pair: the references pass draws nothing a Godot edge already drew.
    const pairs = g.links.map(l => l.source + '>' + l.target);
    assert.equal(new Set(pairs).size, pairs.length);
    // The commented preload names a file that does not exist and draws nothing; icon.svg is not scanned.
    assert.ok(!g.links.some(l => /ghost/.test(l.target) || /icon/.test(l.target)));
    assert.deepEqual(g.engines, [{ id: 'godot', label: 'Godot', roots: ['game'] }]);
    assert.equal(g.fileCount, 7);
});

check('a class_name two scripts declare is dropped, not guessed', () => {
    const dup = path.join(tmp, 'dup');
    write(dup, 'project.godot', 'config_version=5\n');
    write(dup, 'a.gd', 'class_name Twin\nextends Node\n');
    write(dup, 'b.gd', 'class_name Twin\nextends Node\n');
    write(dup, 'c.gd', 'extends Twin\n');
    const g = scanCodeGraph(dup);
    assert.equal(g.links.filter(l => l.type === 'godot').length, 0);
});

check('outside a Godot project: .tscn files are not nodes, .gd keeps its reference edges, nothing typed godot', () => {
    const plain = path.join(tmp, 'plain');
    write(plain, 'src/a.mjs', "import { b } from './b.mjs';\nexport const a = b;\n");
    write(plain, 'src/b.mjs', 'export const b = 1;\n');
    write(plain, 'src/Widget.cs', 'public class Widget {}\n');
    write(plain, 'src/Use.cs', 'public class Use { Widget w; }\n');
    write(plain, 'scripts/player.gd', 'class_name Player\nextends Node\n');
    write(plain, 'scripts/world.gd', 'extends Node\nvar p: Player\nvar q = preload("res://scripts/player.gd")\n');
    write(plain, 'scenes/main.tscn', '[ext_resource type="Script" path="res://scripts/player.gd" id="1"]\n');
    const g = scanCodeGraph(plain);
    assert.ok(!g.nodes.some(n => n.id.endsWith('.tscn')));
    assert.equal(g.engines, undefined);
    assert.deepEqual(edgesOf(g), [
        'scripts/world.gd -> scripts/player.gd references',
        'src/Use.cs -> src/Widget.cs references',
        'src/a.mjs -> src/b.mjs imports'
    ]);
    assert.equal(g.fileCount, 6);
});

check('the built page carries the callers suffixes and the edge kinds; the status names the engine', () => {
    const r = buildProjectDocGraph(godot);
    assert.ok(r.success, r.message);
    const html = renderGraphPage(godot);
    assert.ok(html.includes('"callerExts":[".gd"]'));
    assert.ok(html.includes('"kind":"preload"') && html.includes('/api/graphify/callers?file='));
    const report = fs.readFileSync(path.join(godot, 'graphify-out', 'code_GRAPH_REPORT.md'), 'utf8');
    assert.ok(/Godot project \(`game\/`\).*extends, preload, scene, class/.test(report), report);
    assert.deepEqual(getProjectDocGraphStatus(godot).engines, [{ id: 'godot', label: 'Godot' }]);
    // A graph built before the engines list: its typed links still name the engine.
    const file = path.join(godot, 'graphify-out', 'code_graph.json');
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete old.engines;
    fs.writeFileSync(file, JSON.stringify(old));
    assert.ok(renderGraphPage(godot).includes('"callerExts":[".gd"]'));
    assert.deepEqual(getProjectDocGraphStatus(godot).engines, [{ id: 'godot', label: 'Godot' }]);
});

check('the callers route is a project read route', () => {
    assert.ok(PROJECT_READ_ROUTES.has('GET /api/graphify/callers'));
    assert.ok(routeNeedsProject('GET /api/graphify/callers'));
});

check('no .codegraph: one hint, nothing built', () => {
    const r = readCallers(godot, 'game/scripts/enemy.gd');
    assert.equal(r.available, false);
    assert.equal(r.reason, 'absent');
    // Only the command travels from the server; the sentence around it is the page's, in the owner's language.
    assert.equal(r.hint, CODEGRAPH_HINT);
    assert.ok(/^python \S+who_calls\.py --rebuild$/.test(r.hint), r.hint);
    assert.ok(!fs.existsSync(path.join(godot, 'game', '.codegraph')));
});

check('a file outside the project, a non-.gd file, or a missing one is refused', () => {
    write(tmp, 'outside.gd', 'extends Node\n');
    for (const f of ['../outside.gd', path.join(tmp, 'outside.gd'), 'game/scenes/main.tscn', 'game/scripts/nope.gd', '', null])
        assert.equal(readCallers(godot, f).reason, 'bad-file', String(f));
    write(tmp, 'plainproj/x.gd', 'extends Node\n');
    assert.equal(readCallers(path.join(tmp, 'plainproj'), 'x.gd').reason, 'not-godot');
});

// The fixture database: the tables and columns who_calls.py reads from sangsik-gdscript-graph's
// graph.db (symbols, calls, unresolved_calls, files), made here with node:sqlite.
const sqlite = typeof process.getBuiltinModule === 'function' ? (() => {
    const original = process.emitWarning;
    process.emitWarning = () => undefined;
    try { return process.getBuiltinModule('node:sqlite'); } catch (e) { return null; } finally { process.emitWarning = original; }
})() : null;
if (!sqlite || typeof sqlite.DatabaseSync !== 'function') {
    console.log('  SKIP the .codegraph reader on a fixture database: node:sqlite is not available on this Node (needs 22.13+)');
} else {
    check('the .codegraph reader: a file\'s functions, their resolved callers, untyped calls of the name', () => {
        const dbFile = path.join(godot, 'game', CODEGRAPH_REL);
        fs.mkdirSync(path.dirname(dbFile), { recursive: true });
        const db = new sqlite.DatabaseSync(dbFile);
        // WAL, as a real build may leave it: a plain read-only open of such a file writes -shm and -wal.
        db.exec('pragma journal_mode = wal');
        db.exec(`create table files (res_path text primary key, class_name text, extends text, parse_error text);
            create table symbols (id integer primary key, res_path text not null, name text not null, kind text not null,
                scope text, line integer not null, is_static integer not null default 0);
            create table calls (id integer primary key, source_symbol_id integer not null, target_symbol_id integer not null, line integer not null);
            create table unresolved_calls (id integer primary key, source_res_path text not null, source_scope text,
                source_function text not null, receiver text, called_name text not null, line integer not null, reason text not null);
            insert into files values ('res://scripts/enemy.gd', 'Enemy', 'CharacterBody2D', null),
                ('res://scripts/boss.gd', null, 'Enemy', null), ('res://scripts/bullet.gd', null, 'Node', null);
            insert into symbols values (1, 'res://scripts/enemy.gd', 'take_hit', 'function', null, 6, 0),
                (2, 'res://scripts/boss.gd', 'roar', 'function', null, 4, 0),
                (3, 'res://scripts/bullet.gd', 'fire', 'function', null, 3, 0),
                (4, 'res://scripts/enemy.gd', 'Bullet', 'const', null, 4, 0),
                (5, 'res://scripts/enemy.gd', '<img src=x onerror=alert(1)>', 'function', null, 9, 0);
            insert into calls values (1, 2, 1, 5);
            insert into unresolved_calls values (1, 'res://scripts/enemy.gd', null, 'take_hit', 'b', 'fire', 8, 'unknown_receiver');`);
        db.close();
        // A future mtime keeps the fixture database newer than the scripts written above.
        const later = new Date(Date.now() + 60_000);
        fs.utimesSync(dbFile, later, later);
        const enemy = readCallers(godot, 'game/scripts/enemy.gd');
        assert.equal(enemy.available, true, JSON.stringify(enemy));
        assert.equal(enemy.godotRoot, 'game');
        assert.equal(enemy.stale, false);
        assert.deepEqual(enemy.functions.map(f => f.name), ['take_hit', '<img src=x onerror=alert(1)>']);
        assert.deepEqual(enemy.functions[0].callers, [{ file: 'game/scripts/boss.gd', line: 5, function: 'roar', scope: null }]);
        assert.equal(enemy.functions[0].callerCount, 1);
        const bullet = readCallers(godot, 'game/scripts/bullet.gd');
        assert.deepEqual(bullet.functions.map(f => [f.name, f.callerCount, f.unresolved]), [['fire', 0, 1]]);
        // Read-only: the reader never writes the database, nor anything beside it (no -shm, no -wal).
        const before = fs.statSync(dbFile).mtimeMs;
        assert.deepEqual(fs.readdirSync(path.dirname(dbFile)), ['graph.db']);
        assert.equal(fs.readFileSync(dbFile)[18], 2, 'the fixture is a WAL database');
        readCallers(godot, 'game/scripts/boss.gd');
        assert.equal(fs.statSync(dbFile).mtimeMs, before);
        assert.deepEqual(fs.readdirSync(path.dirname(dbFile)), ['graph.db']);
        // A script edited after the build says the callers may be out of date.
        const earlier = new Date(Date.now() - 3_600_000);
        fs.utimesSync(dbFile, earlier, earlier);
        assert.equal(readCallers(godot, 'game/scripts/enemy.gd').stale, true);
    });

    check('grouped queries keep the limits: 400 functions, 100 callers each, the full count beside them', () => {
        const lim = path.join(tmp, 'limits');
        write(lim, 'project.godot', 'config_version=5\n');
        write(lim, 'big.gd', 'extends Node\n');
        write(lim, 'caller.gd', 'extends Node\n');
        const dbFile = path.join(lim, CODEGRAPH_REL);
        fs.mkdirSync(path.dirname(dbFile), { recursive: true });
        const db = new sqlite.DatabaseSync(dbFile);
        db.exec(`create table symbols (id integer primary key, res_path text, name text, kind text, scope text, line integer);
            create table calls (id integer primary key, source_symbol_id integer, target_symbol_id integer, line integer);
            create table unresolved_calls (id integer primary key, source_res_path text, source_function text, receiver text,
                called_name text, line integer, reason text);`);
        const sym = db.prepare('insert into symbols values (?, ?, ?, ?, ?, ?)');
        for (let i = 1; i <= 450; i++) sym.run(i, 'res://big.gd', 'f' + i, 'function', null, i);
        sym.run(1000, 'res://caller.gd', 'go', 'function', null, 1);
        const call = db.prepare('insert into calls (source_symbol_id, target_symbol_id, line) values (?, ?, ?)');
        for (let i = 0; i < 150; i++) call.run(1000, 1, i + 1);
        call.run(1000, 2, 7);
        const un = db.prepare("insert into unresolved_calls (source_res_path, source_function, receiver, called_name, line, reason) values ('res://caller.gd', 'go', 'x', ?, 1, ?)");
        un.run('f2', 'unknown_receiver'); un.run('f2', 'unknown_receiver'); un.run('f2', 'other'); un.run('f3', 'unknown_receiver');
        db.close();
        const r = readCallers(lim, 'big.gd');
        assert.equal(r.available, true, JSON.stringify(r));
        assert.equal(r.functions.length, CODEGRAPH_LIMITS.functions);
        assert.equal(r.functions[0].callerCount, 150);
        assert.equal(r.functions[0].callers.length, CODEGRAPH_LIMITS.callersPerFunction);
        assert.deepEqual(r.functions[0].callers.slice(0, 2).map(c => c.line), [1, 2]);
        assert.deepEqual(r.functions.slice(1, 4).map(f => [f.name, f.callerCount, f.callers.length, f.unresolved]),
            [['f2', 1, 1, 2], ['f3', 0, 0, 1], ['f4', 0, 0, 0]]);
        assert.equal(r.parseError, null);   // no files table: no parse error, not a failure
    });

    check('a corrupt or other-schema graph.db is unreadable, its raw error only, and nothing is written', () => {
        const bad = path.join(tmp, 'bad');
        write(bad, 'project.godot', 'config_version=5\n');
        write(bad, 'a.gd', 'extends Node\n');
        const dbFile = path.join(bad, CODEGRAPH_REL);
        write(bad, CODEGRAPH_REL, 'this is not a database, only text long enough to look like a header '.repeat(10));
        const corrupt = readCallers(bad, 'a.gd');
        assert.equal(corrupt.reason, 'unreadable', JSON.stringify(corrupt));
        assert.ok(corrupt.hint && !/could not be read/.test(corrupt.hint), corrupt.hint);
        assert.deepEqual(fs.readdirSync(path.dirname(dbFile)), ['graph.db']);
        fs.rmSync(dbFile);
        const other = new sqlite.DatabaseSync(dbFile);
        other.exec('create table notes (id integer primary key, body text); insert into notes (body) values (\'x\');');
        other.close();
        const r = readCallers(bad, 'a.gd');
        assert.equal(r.reason, 'unreadable', JSON.stringify(r));
        assert.ok(/symbols/.test(r.hint), r.hint);
        assert.deepEqual(fs.readdirSync(path.dirname(dbFile)), ['graph.db']);
    });

    check('nested projects: a script reads the graph of its nearest project.godot', () => {
        const nest = path.join(tmp, 'nested-db');
        write(nest, 'project.godot', 'config_version=5\n');
        write(nest, 'outer.gd', 'extends Node\n');
        write(nest, 'sub/project.godot', 'config_version=5\n');
        write(nest, 'sub/inner.gd', 'extends Node\n');
        const dbFile = path.join(nest, 'sub', CODEGRAPH_REL);
        fs.mkdirSync(path.dirname(dbFile), { recursive: true });
        const db = new sqlite.DatabaseSync(dbFile);
        db.exec(`create table symbols (id integer primary key, res_path text, name text, kind text, scope text, line integer);
            create table calls (id integer primary key, source_symbol_id integer, target_symbol_id integer, line integer);
            insert into symbols values (1, 'res://inner.gd', 'ping', 'function', null, 2);`);
        db.close();
        const inner = readCallers(nest, 'sub/inner.gd');
        assert.equal(inner.available, true, JSON.stringify(inner));
        assert.equal(inner.godotRoot, 'sub');
        assert.deepEqual(inner.functions.map(f => [f.name, f.unresolved]), [['ping', null]]);
        assert.equal(readCallers(nest, 'outer.gd').reason, 'absent');
    });

    let canLink = true;
    try { fs.symlinkSync(path.join(tmp, 'outside.gd'), path.join(tmp, 'probe-link')); } catch (e) { canLink = false; }
    if (!canLink) console.log('  SKIP symlink checks: this system cannot make symlinks here');
    else check('a symlinked .gd or graph.db pointing outside the project is refused or absent', () => {
        const sl = path.join(tmp, 'symlinks');
        write(sl, 'project.godot', 'config_version=5\n');
        write(sl, 'real.gd', 'extends Node\n');
        const away = path.join(tmp, 'away');
        write(away, 'secret.gd', 'extends Node\n');
        fs.symlinkSync(path.join(away, 'secret.gd'), path.join(sl, 'link.gd'));
        assert.equal(readCallers(sl, 'link.gd').reason, 'bad-file');
        // A graph.db elsewhere (valid, readable) linked into the project is not read.
        const outsideDb = path.join(away, 'graph.db');
        const db = new sqlite.DatabaseSync(outsideDb);
        db.exec(`create table symbols (id integer primary key, res_path text, name text, kind text, scope text, line integer);
            create table calls (id integer primary key, source_symbol_id integer, target_symbol_id integer, line integer);`);
        db.close();
        fs.mkdirSync(path.join(sl, '.codegraph'));
        fs.symlinkSync(outsideDb, path.join(sl, CODEGRAPH_REL));
        assert.equal(readCallers(sl, 'real.gd').reason, 'absent');
        // So is a whole .codegraph folder linked from elsewhere.
        fs.rmSync(path.join(sl, '.codegraph'), { recursive: true });
        fs.symlinkSync(away, path.join(sl, '.codegraph'));
        assert.equal(readCallers(sl, 'real.gd').reason, 'absent');
    });
}


check('blank-line runs stay linear: 200,000 blank lines before extends scan fast and keep the edge', () => {
    const big = path.join(tmp, 'blank');
    write(big, 'project.godot', 'config_version=5\n');
    write(big, 'b.gd', 'extends Node\n');
    write(big, 'a.gd', '\n'.repeat(200_000) + 'extends "res://b.gd"\n');
    const t0 = process.hrtime.bigint();
    const g = scanCodeGraph(big);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 1000, `scan took ${ms.toFixed(0)} ms`);
    assert.deepEqual(edgesOf({ links: g.links.filter(l => l.type === 'godot') }), ['a.gd -> b.gd godot:extends']);
});

check('res:// cannot climb out of its Godot project: res://../ and res://a/../../ draw nothing', () => {
    const esc = path.join(tmp, 'escape');
    write(esc, 'shared/util.gd', 'extends Node\n');            // a scanned file outside the Godot project
    write(esc, 'game/project.godot', 'config_version=5\n');
    write(esc, 'game/inner.gd', 'extends Node\n');
    write(esc, 'game/a.gd', 'extends Node\nvar u = preload("res://../shared/util.gd")\nvar v = load("res://a/../../shared/util.gd")\n'
        + 'var w = preload("res://x/../inner.gd")\n');
    write(esc, 'game/s.tscn', '[ext_resource type="Script" path="res://../shared/util.gd" id="1"]\n');
    const g = scanCodeGraph(esc);
    assert.deepEqual(edgesOf({ links: g.links.filter(l => l.type === 'godot') }), ['game/a.gd -> game/inner.gd godot:preload']);
});

check('nested Godot projects: each file resolves res:// against its nearest project.godot', () => {
    const nest = path.join(tmp, 'nested');
    write(nest, 'project.godot', 'config_version=5\n');
    write(nest, 'lib.gd', 'extends Node\n');
    write(nest, 'main.gd', 'extends Node\nvar l = preload("res://lib.gd")\n');
    write(nest, 'sub/project.godot', 'config_version=5\n');
    write(nest, 'sub/lib.gd', 'extends Node\n');
    write(nest, 'sub/inner.gd', 'extends Node\nvar l = preload("res://lib.gd")\n');
    write(nest, 'sub/s.tscn', '[ext_resource type="Script" path="res://inner.gd" id="1"]\n');
    write(nest, 'o.tscn', '[ext_resource type="Script" path="res://sub/inner.gd" id="1"]\n');
    const g = scanCodeGraph(nest);
    assert.deepEqual(g.engines.map(e => [e.id, e.roots]), [['godot', ['sub', '']]]);
    assert.deepEqual(edgesOf({ links: g.links.filter(l => l.type === 'godot') }), [
        'main.gd -> lib.gd godot:preload',
        'o.tscn -> sub/inner.gd godot:scene',
        'sub/inner.gd -> sub/lib.gd godot:preload',
        'sub/s.tscn -> sub/inner.gd godot:scene'
    ]);
    // Each scene once, though the inner project lies inside the outer one's walk.
    assert.equal(g.nodes.filter(n => n.id.endsWith('.tscn')).length, 2);
    assert.equal(g.fileCount, 6);
});

check('a scene is read only to 400 KB, and each .gd is read from disk once', () => {
    const head = path.join(tmp, 'head');
    write(head, 'project.godot', 'config_version=5\n');
    write(head, 'a.gd', 'extends Node\n');
    write(head, 'b.gd', 'extends Node\n');
    const pad = '; ' + 'x'.repeat(98) + '\n';
    write(head, 'top.tscn', '[ext_resource type="Script" path="res://a.gd" id="1"]\n' + pad.repeat(6000));
    write(head, 'late.tscn', pad.repeat(5000) + '[ext_resource type="Script" path="res://b.gd" id="1"]\n');
    const reads = new Map();
    const original = fs.readFileSync;
    fs.readFileSync = function (file, ...rest) { const k = String(file); reads.set(k, (reads.get(k) || 0) + 1); return original.call(this, file, ...rest); };
    let g;
    try { g = scanCodeGraph(head); } finally { fs.readFileSync = original; }
    assert.deepEqual(edgesOf({ links: g.links.filter(l => l.type === 'godot') }), ['top.tscn -> a.gd godot:scene']);
    assert.equal(reads.get(path.join(head, 'a.gd')), 1);
    assert.equal(reads.get(path.join(head, 'top.tscn')), undefined, 'scenes go through the 400 KB head reader');
});

check('the scan budget: without project.godot no scene is walked; with one, scenes get only what code left', () => {
    const budget = path.join(tmp, 'budget');
    for (let i = 0; i < 80; i++) write(budget, `scripts/s${i}.gd`, 'extends Node\n');
    for (let i = 0; i < 60; i++) write(budget, `scenes/m${i}.tscn`, `[ext_resource type="Script" path="res://scripts/s${i}.gd" id="1"]\n`);
    const probe = `import { scanCodeGraph } from ${JSON.stringify(new URL('../lib/graphify.mjs', import.meta.url).href)};
        const g = scanCodeGraph(${JSON.stringify(budget)});
        console.log(JSON.stringify({ files: g.fileCount, nodes: g.nodes.length, scenes: g.nodes.filter(n => n.id.endsWith('.tscn')).length }));`;
    const run = () => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe],
        { env: { ...process.env, PLUTOS_MAX_SCAN_FILES: '100' }, encoding: 'utf8' }).trim().split('\n').pop());
    assert.deepEqual(run(), { files: 80, nodes: 80, scenes: 0 });
    write(budget, 'project.godot', 'config_version=5\n');
    assert.deepEqual(run(), { files: 100, nodes: 100, scenes: 20 });
});

// The cost rules a table pattern keeps (lib/engines.mjs header): no `^\s`; every `[^…]` excludes a newline;
// a repeated group (`(…)*`, `+`, `{n,}`) holds no `\s`, `\S`, `\W` or `\D` outside a class, so its
// backtracking stays inside one line. Returns what breaks them.
function costProblems(src) {
    const out = [];
    if (src.includes('^\\s')) out.push('opens a line with ^\\s');
    for (const m of src.matchAll(/\[\^((?:\\.|[^\]\\])*)\]/g)) if (!m[1].includes('\\n')) out.push(`[^${m[1]}] can cross a line`);
    const open = [];
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (c === '\\') { i++; continue; }
        if (c === '[') { i++; while (i < src.length && src[i] !== ']') { if (src[i] === '\\') i++; i++; } continue; }
        if (c === '(') { open.push(i); continue; }
        if (c !== ')') continue;
        const start = open.pop(), rest = src.slice(i + 1);
        if (!/^(?:[*+]|\{\d+,\d*\})/.test(rest) || /^\{(\d+),\1\}/.test(rest) || /^\{[01],1\}/.test(rest)) continue;
        const body = src.slice(start, i + 1).replace(/\[(?:\\.|[^\]\\])*\]/g, '');
        if (/\\[sSWD]/.test(body)) out.push(`repeated group ${src.slice(start, i + 2)} can cross a line`);
    }
    return out;
}

check('the cost check itself: it rejects the patterns that were quadratic and passes their fixes', () => {
    assert.ok(costProblems('^\\s*extends').length);
    assert.ok(costProblems('^[ \\t]*(?:@\\w+(?:\\([^)]*\\))?\\s+)*class_name').length);
    assert.deepEqual(costProblems('^[ \\t]*(?:@\\w+(?:\\([^)\\n]*\\))?[ \\t]+)*class_name\\s+(\\w+)'), []);
    assert.deepEqual(costProblems('(?:\\s+x)?y'), []);
});

check('the engines table: every row has a marker, suffix lists, kinds and rules that the scanner can read', () => {
    const ids = new Set();
    for (const e of ENGINES) {
        assert.ok(/^[a-z][a-z0-9-]*$/.test(e.id) && !ids.has(e.id), e.id);
        ids.add(e.id);
        assert.ok(typeof e.label === 'string' && e.label, `${e.id}: label`);
        assert.ok(e.marker && typeof e.marker.file === 'string' && e.marker.file, `${e.id}: marker.file`);
        for (const list of [e.code, e.assets]) assert.ok(Array.isArray(list) && list.every(x => /^\.[a-z0-9]+$/.test(x)), `${e.id}: suffixes`);
        assert.ok(Array.isArray(e.kinds) && e.kinds.every(k => /^[a-z]+$/.test(k.id) && k.label), `${e.id}: kinds`);
        const kinds = e.kinds.map(k => k.id);
        for (const r of e.refs) {
            assert.ok(['code', 'asset'].includes(r.in), `${e.id}: in ${r.in}`);
            assert.ok(['path', 'class', 'guid'].includes(r.to), `${e.id}: to ${r.to}`);
            assert.ok(kinds.includes(r.kind), `${e.id}: kind ${r.kind} not in its kinds`);
            if (r.to === 'class') assert.ok(e.classDecl, `${e.id}: a class rule needs classDecl`);
            if (r.to === 'guid') assert.ok(e.guids, `${e.id}: a guid rule needs guids`);
            if (r.in === 'code') assert.ok(e.code.length, `${e.id}: a code rule needs code suffixes`);
            if (r.in === 'asset') assert.ok(e.assets.length, `${e.id}: an asset rule needs asset suffixes`);
            if (r.match !== 'identifiers') assert.doesNotThrow(() => new RegExp(r.match, r.flags || ''));
        }
        // Cost: no ^\s (quadratic on blank-line runs), and nothing repeated that can cross a line.
        for (const src of [e.classDecl, e.guids && e.guids.pattern, ...e.refs.map(r => r.match)].filter(s => s && s !== 'identifiers'))
            assert.deepEqual(costProblems(src), [], `${e.id}: ${src}`);
        if (e.assetDirs) assert.ok(Array.isArray(e.assetDirs) && e.assetDirs.every(d => d && !d.startsWith('/') && !d.includes('..')), `${e.id}: assetDirs`);
        if (e.assetBytes !== undefined) assert.ok(Number.isInteger(e.assetBytes) && e.assetBytes > 0, `${e.id}: assetBytes`);
        if (e.language !== undefined) assert.ok(/^[a-z][a-z0-9-]*$/.test(e.language) && e.code.length, `${e.id}: language`);
        if (e.callers) {
            assert.ok(e.callers.exts.every(x => e.code.includes(x)), `${e.id}: callers answer for its own code`);
            assert.ok(e.callers.db && e.callers.hint && e.callers.rootField && typeof e.callers.pathPrefix === 'string', `${e.id}: callers`);
        }
        assert.ok(Array.isArray(e.fileTypes) && e.fileTypes.every(r => r.id && Array.isArray(r.concepts)), `${e.id}: fileTypes`);
    }
    assert.deepEqual([...ids], ['godot', 'unity', 'unreal']);
    assert.deepEqual(ENGINE_KINDS.map(k => k.id), ['extends', 'preload', 'scene', 'class', 'uses']);
    assert.deepEqual(CALLER_EXTS, ['.gd']);
});

// A Unity project nested in a repository: ProjectSettings/ProjectVersion.txt beside Assets/.
const guid = c => c.repeat(32);
const meta = g => `fileFormatVersion: 2\nguid: ${g}\nMonoImporter:\n  serializedVersion: 2\n`;
const yaml = body => '%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n' + body;
const unity = path.join(tmp, 'unity');
write(unity, 'game/ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 2022.3.10f1\n');
write(unity, 'game/Assets/Player.cs', 'using UnityEngine;\npublic class Player : MonoBehaviour { }\n');
write(unity, 'game/Assets/Player.cs.meta', meta(guid('a')));
write(unity, 'game/Assets/Helper.cs', 'public static class Helper { static Player p; }\n');
write(unity, 'game/Assets/Helper.cs.meta', meta(guid('d')));
write(unity, 'game/Assets/Red.mat', yaml('--- !u!21 &2100000\nMaterial:\n  m_Name: Red\n'));
write(unity, 'game/Assets/Red.mat.meta', meta(guid('c')));
write(unity, 'game/Assets/Enemy.prefab', yaml('--- !u!114 &1\nMonoBehaviour:\n  m_Script: {fileID: 11500000, guid: ' + guid('a') + ', type: 3}\n'));
write(unity, 'game/Assets/Enemy.prefab.meta', meta(guid('b')));
write(unity, 'game/Assets/Scenes/Main.unity', yaml('--- !u!114 &10\nMonoBehaviour:\n  m_Script: {fileID: 11500000, guid: ' + guid('a') + ', type: 3}\n'
    + '--- !u!1001 &20\nPrefabInstance:\n  m_SourcePrefab: {fileID: 100100000, guid: ' + guid('b') + ', type: 3}\n'
    + '--- !u!23 &30\nMeshRenderer:\n  m_Materials:\n  - {fileID: 2100000, guid: ' + guid('c') + ', type: 2}\n'
    + '  - {fileID: 10303, guid: 0000000000000000f000000000000000, type: 0}\n'));
write(unity, 'game/Assets/Scenes/Main.unity.meta', meta(guid('e')));
write(unity, 'loose/Stray.prefab', yaml('m_Script: {fileID: 1, guid: ' + guid('a') + ', type: 3}\n'));

check('a Unity project: guid references from scenes and prefabs to the script, prefab and material they use', () => {
    const g = scanCodeGraph(unity);
    assert.deepEqual(g.nodes.map(n => n.id).sort(), ['game/Assets/Enemy.prefab', 'game/Assets/Helper.cs', 'game/Assets/Player.cs',
        'game/Assets/Red.mat', 'game/Assets/Scenes/Main.unity']);
    assert.deepEqual(edgesOf(g), [
        'game/Assets/Enemy.prefab -> game/Assets/Player.cs unity:uses',
        'game/Assets/Helper.cs -> game/Assets/Player.cs references',
        'game/Assets/Scenes/Main.unity -> game/Assets/Enemy.prefab unity:uses',
        'game/Assets/Scenes/Main.unity -> game/Assets/Player.cs unity:uses',
        'game/Assets/Scenes/Main.unity -> game/Assets/Red.mat unity:uses'
    ]);
    assert.deepEqual(g.engines, [{ id: 'unity', label: 'Unity', roots: ['game'] }]);
    assert.equal(g.fileCount, 5);
    // Unity has no pack-prepared callers in the table: the page offers no click panel.
    assert.ok(buildProjectDocGraph(unity).success);
    assert.ok(renderGraphPage(unity).includes('"callerExts":[]'));
    assert.deepEqual(getProjectDocGraphStatus(unity).engines, [{ id: 'unity', label: 'Unity' }]);
});

check('Unity: a guid two .meta files claim is dropped, and ProjectVersion.txt without Assets/ is no Unity project', () => {
    const dupe = path.join(tmp, 'unity-dupe');
    write(dupe, 'ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 6000.0.1f1\n');
    write(dupe, 'Assets/A.cs', 'public class A {}\n');
    write(dupe, 'Assets/A.cs.meta', meta(guid('1')));
    write(dupe, 'Assets/B.cs', 'public class B {}\n');
    write(dupe, 'Assets/B.cs.meta', meta(guid('1')));
    write(dupe, 'Assets/S.prefab', yaml('m_Script: {fileID: 1, guid: ' + guid('1') + ', type: 3}\n'));
    assert.equal(scanCodeGraph(dupe).links.filter(l => l.type === 'unity').length, 0);
    const half = path.join(tmp, 'unity-half');
    write(half, 'ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 6000.0.1f1\n');
    write(half, 'Src/A.cs', 'public class A {}\n');
    write(half, 'Src/S.prefab', 'm_Script: {fileID: 1, guid: ' + guid('1') + ', type: 3}\n');
    const g = scanCodeGraph(half);
    assert.equal(g.engines, undefined);
    assert.deepEqual(g.nodes.map(n => n.id), ['Src/A.cs']);
});

check('an Unreal project is recognised and labelled, with no engine edges; its C++ keeps its reference edges', () => {
    const ue = path.join(tmp, 'unreal');
    write(ue, 'Shooter.uproject', '{ "FileVersion": 3, "EngineAssociation": "5.4" }\n');
    write(ue, 'Source/Shooter/Gun.h', 'class Gun { };\n');
    write(ue, 'Source/Shooter/Hero.cpp', '#include "Gun.h"\nvoid fire(Gun* g) {}\n');
    const g = scanCodeGraph(ue);
    assert.deepEqual(g.engines, [{ id: 'unreal', label: 'Unreal', roots: [''] }]);
    assert.deepEqual(edgesOf(g), ['Source/Shooter/Hero.cpp -> Source/Shooter/Gun.h references']);
    assert.ok(buildProjectDocGraph(ue).success);
    const report = fs.readFileSync(path.join(ue, 'graphify-out', 'code_GRAPH_REPORT.md'), 'utf8');
    assert.ok(/Unreal project \(the root\): recognised, with no file edges/.test(report), report);
});

check('a repository on no engine: no engines key, no typed links, the same nodes and edges as a plain scan', () => {
    const web = path.join(tmp, 'web');
    write(web, 'package.json', '{"name":"w"}\n');
    write(web, 'src/a.ts', "import { b } from './b';\nexport const a = b;\n");
    write(web, 'src/b.ts', 'export const b = 1;\n');
    write(web, 'src/Project.prefab', 'm_Script: {fileID: 1, guid: ' + guid('a') + ', type: 3}\n');
    const g = scanCodeGraph(web);
    assert.equal(g.engines, undefined);
    assert.deepEqual(edgesOf(g), ['src/a.ts -> src/b.ts imports']);
    assert.equal(g.fileCount, 2);
    assert.ok(buildProjectDocGraph(web).success);
    assert.deepEqual(getProjectDocGraphStatus(web).engines, []);
    assert.ok(renderGraphPage(web).includes('"callerExts":[]'));
});

check('annotation runs stay linear: 100,000 `@x` lines, and as many unclosed `@x(` lines, match and scan fast', () => {
    const pats = [GODOT.classDecl, ...GODOT.refs.filter(r => r.match !== 'identifiers').map(r => r.match)];
    for (const text of ['@x\n'.repeat(100_000), '@x(\n'.repeat(100_000), '@x(a\n'.repeat(100_000), '@x extends \n'.repeat(100_000)]) {
        for (const src of pats) {
            const re = new RegExp(src, 'gm');
            const t0 = performance.now();
            while (re.exec(text)) { /* every match */ }
            const ms = performance.now() - t0;
            assert.ok(ms < 500, `${ms.toFixed(0)} ms on ${JSON.stringify(text.slice(0, 6))}: ${src}`);
        }
    }
    const ann = path.join(tmp, 'annotations');
    write(ann, 'project.godot', 'config_version=5\n');
    write(ann, 'b.gd', 'extends Node\n');
    write(ann, 'a.gd', '@x\n'.repeat(60_000) + '@x(\n'.repeat(30_000) + '@tool @icon("res://i.svg") extends "res://b.gd"\n');
    const t0 = performance.now();
    const g = scanCodeGraph(ann);
    assert.ok(performance.now() - t0 < 2000, `scan took ${(performance.now() - t0).toFixed(0)} ms`);
    assert.deepEqual(edgesOf({ links: g.links.filter(l => l.type === 'godot') }), ['a.gd -> b.gd godot:extends']);
});

// The Unity fixtures below share the meta/yaml helpers and the fixed-character guids above.
const unityRoot = (dir, version = 'm_EditorVersion: 6000.0.1f1\n') => write(dir, 'ProjectSettings/ProjectVersion.txt', version);

check('Unity: a reference far past 400 KB in a scene still draws its edge (the row reads 4 MB of each asset)', () => {
    const big = path.join(tmp, 'unity-big');
    unityRoot(big);
    write(big, 'Assets/A.cs', 'public class A {}\n');
    write(big, 'Assets/A.cs.meta', meta(guid('a')));
    const filler = '--- !u!4 &1\nTransform:\n  m_LocalPosition: {x: 0, y: 0, z: 0}\n';
    write(big, 'Assets/Big.unity', yaml(filler.repeat(Math.ceil(600_000 / filler.length)) + '  m_Script: {fileID: 11500000, guid: ' + guid('a') + ', type: 3}\n'));
    assert.ok(fs.statSync(path.join(big, 'Assets/Big.unity')).size > HEAD_BYTES);
    assert.deepEqual(edgesOf({ links: scanCodeGraph(big).links.filter(l => l.type === 'unity') }), ['Assets/Big.unity -> Assets/A.cs unity:uses']);
    assert.equal(ENGINES.find(e => e.id === 'godot').assetBytes, undefined, 'Godot scenes keep the 400 KB head');
});

check('Unity: only Assets/ is walked for assets; ProjectSettings/ and UserSettings/ .asset files are no nodes', () => {
    const set = path.join(tmp, 'unity-settings');
    unityRoot(set);
    write(set, 'ProjectSettings/TagManager.asset', yaml('TagManager:\n  tags: []\n'));
    write(set, 'ProjectSettings/QualitySettings.asset', yaml('QualitySettings:\n  m_CurrentQuality: 1\n'));
    write(set, 'UserSettings/Layouts.asset', yaml('Layouts: {}\n'));
    write(set, 'Assets/Data.asset', yaml('MonoBehaviour:\n  m_Name: Data\n'));
    write(set, 'Assets/A.cs', 'public class A {}\n');
    assert.deepEqual(scanCodeGraph(set).nodes.map(n => n.id).sort(), ['Assets/A.cs', 'Assets/Data.asset']);
});

check('Unity: a malformed .meta (no guid, upper-case or short hex) names nothing', () => {
    const bad = path.join(tmp, 'unity-badmeta');
    unityRoot(bad);
    write(bad, 'Assets/NoGuid.cs', 'public class NoGuid {}\n');
    write(bad, 'Assets/NoGuid.cs.meta', 'fileFormatVersion: 2\nMonoImporter:\n  serializedVersion: 2\n');
    write(bad, 'Assets/Upper.cs', 'public class Upper {}\n');
    write(bad, 'Assets/Upper.cs.meta', meta('A'.repeat(32)));
    write(bad, 'Assets/Short.cs', 'public class Short {}\n');
    write(bad, 'Assets/Short.cs.meta', meta('b'.repeat(31)));
    write(bad, 'Assets/S.prefab', yaml('a: {fileID: 1, guid: ' + 'a'.repeat(32) + ', type: 3}\nb: {fileID: 1, guid: ' + 'A'.repeat(32) + ', type: 3}\n'
        + 'c: {fileID: 1, guid: ' + 'b'.repeat(31) + '0, type: 3}\nd: {fileID: 1, guid: ' + 'b'.repeat(31) + ', type: 3}\n'));
    assert.deepEqual(scanCodeGraph(bad).links.filter(l => l.type === 'unity'), []);
});

check('Unity nested in a Godot root: each file resolves against its nearest root and keeps that engine\'s rules', () => {
    const mix = path.join(tmp, 'unity-in-godot');
    write(mix, 'project.godot', 'config_version=5\n');
    write(mix, 'main.gd', 'extends Node\n');
    write(mix, 'main.tscn', '[ext_resource type="Script" path="res://main.gd" id="1"]\n');
    unityRoot(path.join(mix, 'port'));
    write(mix, 'port/Assets/A.cs', 'public class A {}\n');
    write(mix, 'port/Assets/A.cs.meta', meta(guid('a')));
    write(mix, 'port/Assets/S.prefab', yaml('m_Script: {fileID: 1, guid: ' + guid('a') + ', type: 3}\n'));
    write(mix, 'port/Assets/stray.tscn', '[ext_resource type="Script" path="res://main.gd" id="1"]\n');
    const g = scanCodeGraph(mix);
    assert.deepEqual(g.engines.map(e => [e.id, e.roots]), [['godot', ['']], ['unity', ['port']]]);
    assert.deepEqual(g.nodes.map(n => n.id).sort(), ['main.gd', 'main.tscn', 'port/Assets/A.cs', 'port/Assets/S.prefab']);
    assert.deepEqual(edgesOf({ links: g.links.filter(l => l.type) }).filter(e => / (godot|unity):/.test(e)),
        ['main.tscn -> main.gd godot:scene', 'port/Assets/S.prefab -> port/Assets/A.cs unity:uses']);
});

check('Unity: a guid only another Unity root\'s .meta carries draws nothing across roots', () => {
    const two = path.join(tmp, 'unity-two');
    unityRoot(path.join(two, 'one'));
    write(two, 'one/Assets/A.cs', 'public class A {}\n');
    write(two, 'one/Assets/A.cs.meta', meta(guid('a')));
    unityRoot(path.join(two, 'two'));
    write(two, 'two/Assets/B.cs', 'public class B {}\n');
    write(two, 'two/Assets/S.prefab', yaml('m_Script: {fileID: 1, guid: ' + guid('a') + ', type: 3}\n'));
    assert.deepEqual(scanCodeGraph(two).links.filter(l => l.type === 'unity'), []);
});

if (process.platform === 'win32') console.log('  skip  FIFOs and symlinked .meta files (no named pipes or unprivileged symlinks on Windows)');
else check('a FIFO is never waited on, and a .meta linked from outside the project names nothing', () => {
    const pipe = path.join(tmp, 'unity-fifo');
    unityRoot(pipe);
    const fifo = path.join(tmp, 'a.fifo');
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    write(pipe, 'Assets/A.cs', 'public class A {}\n');
    fs.symlinkSync(fifo, path.join(pipe, 'Assets/A.cs.meta'));
    fs.symlinkSync(fifo, path.join(pipe, 'Assets/Linked.prefab'));
    execFileSync('mkfifo', [path.join(pipe, 'Assets/Pipe.unity')]);
    // Outside the project, a .meta claiming B's guid; inside, a link to a file in the project still counts.
    write(tmp, 'outside/B.cs.meta', meta(guid('b')));
    write(pipe, 'Assets/B.cs', 'public class B {}\n');
    fs.symlinkSync(path.join(tmp, 'outside/B.cs.meta'), path.join(pipe, 'Assets/B.cs.meta'));
    write(pipe, 'Assets/C.cs', 'public class C {}\n');
    write(pipe, 'Meta/C.meta.txt', meta(guid('c')));
    fs.symlinkSync(path.join(pipe, 'Meta/C.meta.txt'), path.join(pipe, 'Assets/C.cs.meta'));
    write(pipe, 'Assets/S.prefab', yaml(['a', 'b', 'c'].map(c => `- {fileID: 1, guid: ${guid(c)}, type: 3}\n`).join('')));
    // In a child with a timeout, so a blocking read fails the check instead of hanging the suite.
    const probe = `import { scanCodeGraph, readHead } from ${JSON.stringify(new URL('../lib/graphify.mjs', import.meta.url).href)};
        const g = scanCodeGraph(${JSON.stringify(pipe)});
        console.log(JSON.stringify({ head: readHead(${JSON.stringify(fifo)}), links: g.links.filter(l => l.type === 'unity').map(l => l.source + ' -> ' + l.target) }));`;
    const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8', timeout: 15_000 }).trim().split('\n').pop());
    assert.deepEqual(out, { head: '', links: ['Assets/S.prefab -> Assets/C.cs'] });
});

check('the task index reads a huge engine asset only to its head, never whole', () => {
    const huge = path.join(tmp, 'unity-huge');
    unityRoot(huge);
    write(huge, 'Assets/A.cs', 'public class A {}\n');
    const big = path.join(huge, 'Assets/Terrain.asset');
    fs.writeFileSync(big, yaml('TerrainData:\n  m_Name: zorblaxterrain\n'));
    fs.truncateSync(big, 300 * 1024 * 1024);   // sparse: no 300 MB is written
    assert.equal(readHead(big, 1000).length, 1000);
    const reads = [];
    const original = fs.readFileSync;
    fs.readFileSync = function (file, ...rest) { reads.push(String(file)); return original.call(this, file, ...rest); };
    let result;
    try { resetTaskContextCache(); result = taskContext(huge, 'fix the zorblaxterrain data'); } finally { fs.readFileSync = original; resetTaskContextCache(); }
    assert.ok(!reads.some(f => f.endsWith('Terrain.asset')), 'the asset went through readFileSync');
    assert.equal(result.files[0] && result.files[0].file, 'Assets/Terrain.asset');
});

await checkAsync('the page words every reason itself: each page key exists in en and tr, unreadable among them', async () => {
    const src = fs.readFileSync(path.join(repo, 'ui', 'i18n.js'), 'utf8');
    // The dictionary alone: the rest of the file is browser code.
    const dict = src.slice(src.indexOf('export const translations'), src.indexOf('export let currentLang'));
    const { translations } = await import('data:text/javascript,' + encodeURIComponent(dict));
    const html = renderGraphPage(godot);
    const keys = JSON.parse(html.match(/const KEYS = (\{.*?\});/)[1]);
    assert.equal(keys.callsUnreadable, 'depgraph_page_calls_unreadable');
    for (const k of Object.values(keys)) {
        assert.ok(translations.en[k], 'en ' + k);
        assert.ok(translations.tr[k], 'tr ' + k);
    }
    assert.deepEqual(Object.keys(translations.en).sort(), Object.keys(translations.tr).sort());
    // Server text reaches the page only inside <code>.
    assert.ok(html.includes("unreadable: 'callsUnreadable'") && html.includes("body.appendChild(el('p', tr(word || 'callsError')))"));
});

// The route itself, on a real dashboard with its own hub: no project, then a bad file, then the absent answer.
const freePort = () => new Promise(resolve => { const srv = net.createServer(); srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); }); });
await checkAsync('GET /api/graphify/callers: the no-project payload, 400 on a bad file, 200 with the hint otherwise', async () => {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const home = path.join(tmp, 'user-home');
    fs.mkdirSync(home, { recursive: true });
    const env = { ...process.env, PLUTOS_PORT: String(port), PLUTOS_HOME: path.join(tmp, 'hub'), PLUTOS_NO_OS_OPEN: '1',
        HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData') };
    for (const k of ['PLUTOS_PROJECT_ROOT', 'CLAUDE_PROJECT_DIR', 'PLUTOS_MODE', 'PLUTOS_DEV']) delete env[k];
    const server = spawn(process.execPath, [path.join(repo, 'dashboard.mjs')], { cwd: tmp, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    server.stderr.on('data', c => { err = (err + c).slice(-2000); });
    const closed = new Promise(resolve => server.once('close', resolve));
    try {
        let up = false;
        for (let i = 0; i < 100 && !up && server.exitCode === null; i++) {
            try { up = (await fetch(base + '/api/app/mode')).ok; } catch (e) { await new Promise(r => setTimeout(r, 150)); }
        }
        assert.ok(up, 'dashboard did not start: ' + err);
        const none = await fetch(base + '/api/graphify/callers?file=game/scripts/enemy.gd');
        assert.equal(none.status, 200);
        const nonePayload = await none.json();
        assert.equal(nonePayload.needsProject, true);
        assert.equal(nonePayload.available, undefined);
        const proj = path.join(tmp, 'route');
        write(proj, 'project.godot', 'config_version=5\n');
        write(proj, 'a.gd', 'extends Node\n');
        const add = await (await fetch(base + '/api/workspaces/add', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: proj }) })).json();
        assert.equal(add.success, true, JSON.stringify(add));
        for (const f of ['../x.gd', 'a.tscn', '']) {
            const r = await fetch(base + '/api/graphify/callers?file=' + encodeURIComponent(f));
            assert.equal(r.status, 400, f);
            assert.equal((await r.json()).reason, 'bad-file');
        }
        const missing = await fetch(base + '/api/graphify/callers');
        assert.equal(missing.status, 400);
        const ok = await fetch(base + '/api/graphify/callers?file=a.gd');
        assert.equal(ok.status, 200);
        const body = await ok.json();
        assert.equal(body.reason, 'absent');
        assert.equal(body.hint, CODEGRAPH_HINT);
    } finally {
        server.kill();
        await closed;
    }
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`Engine graph: ${passed} passed, 0 failed`);
