#!/usr/bin/env node
// The rule of two: the core holds a capability
// only when it serves any project. This fails on a pack path, a pack name, a game engine or a workspace
// manifest read in lib/, ui/, scaffold/, the council configuration or the three entry files. Stack scanners
// may name an engine as data (O5 amendment): those files are listed below with the reason, nothing else is.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATTRIBUTION } from './publish-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

// Engine names allowed, as scanner data only. A new entry needs a reason that names the scanner.
const ENGINE_DATA = {
    'lib/recommend.mjs': 'stack scanner: the engine project markers (Assets/, .uproject, project.godot) and the stack names',
    'lib/codeindex.mjs': 'stack scanner: detectProjectType and the C# scanner that reads an Assets/ tree',
    'lib/claim-check.mjs': 'the test-runner command list a session may claim to have run (run_tests)',
    'ui/modules/codeindex.js': 'the code index view: the vendored-folder names and the Assets/ shard rule of that scan',
    'ui/modules/setup.js': 'the display labels of the stacks the scanner detects',
};

function walk(dir, keep, acc = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'vendor' && entry.name !== 'node_modules') walk(full, keep, acc); }
        else if (keep(entry.name)) acc.push(full);
    }
    return acc;
}
const files = [
    ...walk(path.join(ROOT, 'lib'), f => f.endsWith('.mjs')),
    ...walk(path.join(ROOT, 'ui'), f => f.endsWith('.js') || f.endsWith('.html')),
    ...walk(path.join(ROOT, 'scaffold'), () => true),
    ...['council.config.json', 'index.mjs', 'dashboard.mjs', 'cli.mjs'].map(f => path.join(ROOT, f)),
].map(full => ({ rel: path.relative(ROOT, full).replace(/\\/g, '/'), text: fs.readFileSync(full) }))
    .filter(f => !f.text.subarray(0, 1024).includes(0)).map(f => ({ rel: f.rel, lines: f.text.toString('utf8').split('\n') }));

// Every line of the given files that matches, as "path:line: text", for a readable failure.
const hits = (pattern, subset = files) => subset.flatMap(f => f.lines.map((line, i) => pattern.test(line) ? `${f.rel}:${i + 1}: ${line.trim()}` : null).filter(Boolean));
const inside = (...dirs) => files.filter(f => dirs.some(d => f.rel.startsWith(d + '/')));

check('no workspace-manifest read or package source list in the core', () => {
    assert.deepEqual(hits(/\.studio\/workspace\.json|packageSources/), []);
});
check('no pack path in the core', () => {
    assert.deepEqual(hits(/packages\/(art|design|platform-mobile|platform-pc|reporting|testing|research)\//), []);
});
check('no game engine identifier or path outside the stack scanners', () => {
    assert.deepEqual(hits(/\b(godot|unity|unreal|blender)\b/, files.filter(f => !ENGINE_DATA[f.rel])), []);
});
check('every allowed scanner file still exists and still names an engine', () => {
    for (const rel of Object.keys(ENGINE_DATA)) {
        const file = files.find(f => f.rel === rel);
        assert.ok(file, `${rel} is allowed but gone: drop it from ENGINE_DATA`);
        assert.ok(hits(/\b(godot|unity|unreal|blender)\b/, [file]).length, `${rel} names no engine any more: drop it from ENGINE_DATA`);
    }
});
// The names of the owner's other projects come from the same untracked list the release scan reads
// (.plutos/release-terms.txt), so the names never sit in a tracked file; without the list only the
// generic words are checked and the release scan is the gate.
const termsFile = path.join(ROOT, '.plutos', 'release-terms.txt');
const ownerTerms = fs.existsSync(termsFile)
    ? fs.readFileSync(termsFile, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    : [];
const packNames = new RegExp([...ownerTerms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'game pack'].join('|'));
// The author's own name in the About box is attribution, not a pack name: the same rule the
// release scan applies (tools/publish-core.mjs ATTRIBUTION).
const attribution = h => { const m = h.match(/^([^:]+):\d+: (.*)$/); return m && ATTRIBUTION({ kind: 'terms', file: m[1], text: m[2] }); };
check('no pack name in lib/, ui/ or scaffold/ except on a dated line', () => {
    assert.deepEqual(hits(packNames, inside('lib', 'ui', 'scaffold')).filter(h => !/\d{4}-\d{2}-\d{2}/.test(h) && !attribution(h)), []);
});
console.log(`Rule of two: ${passed} passed, 0 failed`);
