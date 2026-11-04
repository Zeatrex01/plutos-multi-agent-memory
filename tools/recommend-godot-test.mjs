// Godot projects must be recognised as games: scanProject once never set stack 'godot', so a Godot game
// was not seen as one (found live 2026-10-15).
// Also: a package.json "test" script is a test setup (Setup said "Tests: no" for PLUT_OS itself, whose
// suites run with `npm test`, 2026-10-28), but npm's own placeholder script is not.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { scanProject, buildRecommendation } from '../lib/recommend.mjs';

let passed = 0, failed = 0;
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ok  ${name}`); } else { failed++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); } };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-godot-'));
try {
    fs.writeFileSync(path.join(dir, 'project.godot'), 'config_version=5\n');
    const signals = scanProject(dir);
    check('Godot detected via project.godot', signals.stack === 'godot', signals.stack);
    check('Godot is recognised as a game, and the core recommends no game role', buildRecommendation(signals, {}).reasons.some(r => r.startsWith('game project: a Godot project')) && !('roles' in buildRecommendation(signals, {})));
    const node = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-node-'));
    fs.writeFileSync(path.join(node, 'package.json'), '{"name":"x"}');
    check('a plain Node project is still not a game', scanProject(node).stack === 'node' && !buildRecommendation(scanProject(node), {}).reasons.some(r => r.startsWith('game project')));
    check('a Node project with no test dependency, folder or script has no tests', scanProject(node).hasTests === false);
    fs.writeFileSync(path.join(node, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    check("npm's placeholder test script is not a test setup", scanProject(node).hasTests === false);
    fs.writeFileSync(path.join(node, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node tools/run-all-tests.mjs' } }));
    check('a real test script counts as tests', scanProject(node).hasTests === true);
    fs.writeFileSync(path.join(node, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: '   ' } }));
    check('a blank test script is not a test setup', scanProject(node).hasTests === false);
    const plutos = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    check('PLUT_OS itself (tests under tools/, run by npm test) is seen to have tests', scanProject(plutos).hasTests === true);
    fs.rmSync(node, { recursive: true, force: true });
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log(`Project scan and recommendation: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
