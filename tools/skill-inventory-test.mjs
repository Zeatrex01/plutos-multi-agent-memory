#!/usr/bin/env node
// lib/skill-inventory.mjs on temp folders only: PLUTOS_HOME, HOME, the app root, the project and every
// skill source are under one temp folder, set before any lib/ module loads, so the real ~ and the real
// data folder are never read or written. Covers each source, the duplicate verdicts, same content under
// two names, which client loads which copy, version order, broken links, export (record, refusals,
// --force only on accounted folders, --force-local with a whole backup, protected destinations), export
// states, links and escaping paths, the bounded scan, a huge SKILL.md and the CLI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-skill-inv-')));
const hub = path.join(tmp, 'hub');
const userHome = path.join(tmp, 'user-home');
process.env.PLUTOS_HOME = hub;
process.env.HOME = process.env.USERPROFILE = userHome;
process.env.APPDATA = path.join(userHome, 'AppData', 'Roaming');
fs.mkdirSync(process.env.APPDATA, { recursive: true });
const { registerPack, activatePack } = await import('../lib/skills.mjs');
const { inventory, exportSkill, missingLinks, normaliseSkillName, renderInventory, compareVersions, INVENTORY_LIMITS, BACKUP_LIMITS, SOURCE_RECORD } = await import('../lib/skill-inventory.mjs');
const { createHash } = await import('node:crypto');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
const skillMd = (name, description, body = '') => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n${body}\n`;
const canLink = (() => { try { fs.symlinkSync(tmp, path.join(tmp, '.probe'), 'dir'); fs.unlinkSync(path.join(tmp, '.probe')); return true; } catch (e) { return false; } })();

// Two unrelated bodies that share a name, and a long shared body for "the same skill, edited".
const BRAINSTORM_A = 'Generate divergent ideas, cluster them, then converge with explicit criteria before writing any plan. Ask clarifying questions first; one question per message; propose approaches with tradeoffs.';
const BRAINSTORM_B = 'Sketch level layouts quickly on paper grids; test pacing with colored tokens; measure density and enemy placement against the difficulty curve of the campaign map.';
const SHARED = 'Execute playable prototype tests: legal-move bot, softlock search, color-vision readability, frame pacing, losing conditions, random-click wins and human playtest evidence kept separate from design hypotheses.';

const appRoot = path.join(tmp, 'app');
const project = path.join(tmp, 'project');
const packDir = path.join(tmp, 'packs', 'testing');
const plugins = path.join(userHome, '.claude', 'plugins');
const syncedPlugins = path.join(plugins, 'synced', 'bucket-1');
const installedRoot = path.join(tmp, 'cache', 'market', 'toolkit', '1.2.0');

// PLUT_OS's own skills and mini.
write(path.join(appRoot, 'skills', 'project-scissors', 'SKILL.md'), skillMd('project-scissors', 'Plan scope.', SHARED + ' scope cut architecture'));
write(path.join(appRoot, 'skills', 'project-scissors', 'references', 'a.md'), 'ref');
write(path.join(appRoot, 'mini', 'SKILL.md'), skillMd('plutos-mini', 'The shell brief.'));
write(path.join(appRoot, 'mini', 'plutos-mini.mjs'), '// code');
// A pack with a measured line, registered, then switched on in the project.
write(path.join(packDir, 'skills.json'), JSON.stringify({ version: 1, id: 'testing', name: 'Testing', skills: [{ name: 'test-game-prototype', measured: { date: '2026-11-01', summary: '3 of 4 blind pairs', record: 'evals/t.md' } }] }));
write(path.join(packDir, 'module.json'), JSON.stringify({ id: 'testing', name: 'Testing', version: '12.4.1' }));
write(path.join(packDir, 'skills', 'test-game-prototype', 'SKILL.md'), skillMd('test-game-prototype', 'Test prototypes.', SHARED));
write(path.join(packDir, 'skills', 'test-game-prototype', 'scripts', 'bot.js'), 'bot v2');
// The project, with its own skill.
write(path.join(project, '.claude', 'skills', 'local-only', 'SKILL.md'), skillMd('local-only', 'Only here.'));
// The user's skills, one claude.ai-synced bucket, and a skills-dir plugin.
write(path.join(userHome, '.claude', 'skills', 'brainstorming', 'SKILL.md'), skillMd('brainstorming', 'Ideas first.', BRAINSTORM_A));
write(path.join(userHome, '.agents', 'skills', 'codex-only', 'SKILL.md'), skillMd('codex-only', 'For Codex.'));
// The same SKILL.md under two folder names (no `name:` in its frontmatter, so the folder names it).
const artMd = '---\ndescription: Art review.\n---\n\n# Art review\n';
write(path.join(userHome, '.claude', 'skills', 'synced', 'acct-1', 'game-art-review', 'SKILL.md'), artMd);
write(path.join(userHome, '.claude', 'skills', 'synced', 'acct-1', 'art-review-copy', 'SKILL.md'), artMd);
// Synced plugins: superpowers (another brainstorming), plutos-testing (an older test-game-prototype),
// and design (identical to the user's codex-only copy).
write(path.join(syncedPlugins, 'superpowers', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'superpowers', version: '7.0.2' }));
write(path.join(syncedPlugins, 'superpowers', 'skills', 'brainstorming', 'SKILL.md'), skillMd('brainstorming', 'Level sketches.', BRAINSTORM_B));
write(path.join(syncedPlugins, 'uuid-folder', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'plutos-testing', version: '12.3.0' }));
write(path.join(syncedPlugins, 'uuid-folder', 'skills', 'test-game-prototype', 'SKILL.md'), skillMd('test-game-prototype', 'Test prototypes (older words).', SHARED));
write(path.join(syncedPlugins, 'uuid-folder', 'skills', 'test-game-prototype', 'scripts', 'bot.js'), 'bot v1');
write(path.join(syncedPlugins, 'extra-paths', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'extra', skills: ['./more', '../../escape'] }));
write(path.join(syncedPlugins, 'extra-paths', 'more', 'deep-skill', 'SKILL.md'), skillMd('deep-skill', 'From the skills key.'));
fs.cpSync(path.join(userHome, '.agents', 'skills', 'codex-only'), path.join(syncedPlugins, 'twin', 'skills', 'codex-only'), { recursive: true });
// An installed plugin, recorded in installed_plugins.json (both shapes: one entry and a list).
write(path.join(installedRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'toolkit', version: '1.2.0' }));
write(path.join(installedRoot, 'skills', 'lint-helper', 'SKILL.md'), `---\nname: lint-helper\ndescription: Lints.\ndisable-model-invocation: true\nuser-invocable: false\npaths:\n  - src/**\n---\nbody\n`);
const singleRoot = path.join(tmp, 'single-plugin');
write(path.join(singleRoot, 'SKILL.md'), skillMd('solo', 'A single-skill plugin.'));
write(path.join(plugins, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
    'toolkit@market': [{ scope: 'user', installPath: installedRoot, version: '1.2.0' }],
    'solo@local': { scope: 'user', installPath: singleRoot, version: 'unknown' }
} }));

const env = { ...process.env };
const cli = (cwd, ...args) => spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), ...args], { env, cwd, encoding: 'utf8' });
const run = () => inventory({ projectRoot: project, home: hub, userHome, appRoot });
const group = (r, name) => r.duplicates.find(g => g.name === name);

try {
    registerPack(packDir, { home: hub });
    fs.mkdirSync(path.join(project, '.plutos'), { recursive: true });
    activatePack(project, 'testing', { home: hub });

    check('normalised names: case-insensitive, without a plugin prefix', () => {
        assert.equal(normaliseSkillName('Superpowers:Brainstorming'), 'brainstorming');
        assert.equal(normaliseSkillName('  Test-Game  '), 'test-game');
    });

    check('each source is found and labelled', () => {
        const r = run();
        const by = src => r.skills.filter(s => s.source === src).map(s => s.name).sort();
        assert.deepEqual(by('plutos'), ['plutos-mini', 'project-scissors']);
        assert.deepEqual(by('pack:testing'), ['test-game-prototype']);
        assert.deepEqual(by('project'), ['local-only', 'test-game-prototype', 'test-game-prototype']);
        assert.deepEqual(by('user'), ['brainstorming', 'codex-only']);
        assert.deepEqual(by('synced'), ['art-review-copy', 'game-art-review']);
        assert.deepEqual(by('plugin:superpowers'), ['brainstorming']);
        assert.deepEqual(by('plugin:plutos-testing'), ['test-game-prototype']);
        assert.deepEqual(by('plugin:extra'), ['deep-skill']);
        assert.deepEqual(by('plugin:toolkit'), ['lint-helper']);
        assert.deepEqual(by('plugin:solo'), ['solo']);
        assert.equal(r.sources['plugin:superpowers'], 1);
    });

    check('each entry carries hashes, description, version, gates and the measured line verbatim', () => {
        const r = run();
        const lint = r.skills.find(s => s.name === 'lint-helper');
        assert.match(lint.skillMdHash, /^[0-9a-f]{64}$/);
        assert.match(lint.folderHash, /^[0-9a-f]{64}$/);
        assert.equal(lint.version, '1.2.0');
        assert.equal(lint.qualified, 'toolkit:lint-helper');
        assert.deepEqual(lint.gates, { disableModelInvocation: true, userInvocable: false, paths: true });
        const pack = r.skills.find(s => s.source === 'pack:testing');
        assert.equal(pack.version, '12.4.1');
        assert.deepEqual(pack.measured, { date: '2026-11-01', summary: '3 of 4 blind pairs', record: 'evals/t.md' });
        const placed = r.skills.filter(s => s.source === 'project' && s.name === 'test-game-prototype');
        assert.ok(placed.every(s => s.placedBy?.pack === 'testing' && s.placedBy.state === 'as-placed'));
        assert.ok(placed.every(s => s.measured?.summary === '3 of 4 blind pairs'));
        assert.equal(r.skills.find(s => s.name === 'brainstorming' && s.source === 'user').description, 'Ideas first.');
    });

    check('identical copies, different versions with the reference named, and a name clash', () => {
        const r = run();
        const twin = group(r, 'codex-only');
        assert.equal(twin.verdict, 'identical');
        const tgp = group(r, 'test-game-prototype');
        assert.equal(tgp.verdict, 'different-versions');
        assert.equal(tgp.reference, 'pack:testing');
        assert.deepEqual(tgp.differFromReference, ['plugin:plutos-testing']);
        assert.ok(tgp.copies.filter(c => c.source.startsWith('project')).every(c => c.matches === 'pack:testing'));
        const clash = group(r, 'brainstorming');
        assert.equal(clash.verdict, 'name-clash');
        assert.ok(r.recommendations.some(l => l.startsWith('brainstorming: 2 copies with different content (user ~/.claude/skills, plugin:superpowers) — a name clash') && /no client loads two of them/.test(l)), r.recommendations.join('\n'));
        assert.ok(r.recommendations.some(l => l.startsWith('test-game-prototype: plugin:plutos-testing differs from the copy PLUT_OS carries (pack:testing, version 12.4.1) — decide which to keep; the PLUT_OS copy is the one \'plutos skills export\' tracks.')), r.recommendations.join('\n'));
        // Synced, plugin and pack-placed copies carry no reliable date, and not every copy has a version.
        assert.equal(tgp.order.by, 'unknown');
        assert.ok(!r.recommendations.some(l => /mtime|file date/.test(l) && l.startsWith('test-game-prototype')));
        // Claude Code loads the plugin's copy as plutos-testing:test-game-prototype: no collision.
        assert.deepEqual(tgp.loadedTwice, []);
        assert.deepEqual(tgp.perClient['Claude Code'].sort(), ['plugin:plutos-testing', 'project .claude/skills (placed by pack:testing)']);
    });

    check('plugin skills are namespaced: only two copies under one plugin name load twice', () => {
        write(path.join(userHome, '.claude', 'skills', 'gamma', 'SKILL.md'), skillMd('gamma', 'Gamma here.', 'user body'));
        write(path.join(userHome, '.claude', 'skills', 'synced', 'acct-1', 'gamma', 'SKILL.md'), skillMd('gamma', 'Gamma there.', 'synced body'));
        write(path.join(syncedPlugins, 'superpowers', 'skills', 'gamma', 'SKILL.md'), skillMd('gamma', 'Gamma plugin.', 'plugin body'));
        let g = group(run(), 'gamma');
        assert.deepEqual(g.perClient['Claude Code'].length, 3);
        assert.deepEqual(g.loadedTwice, ['Claude Code']);
        assert.deepEqual(g.sameNamespace['Claude Code'], ['user ~/.claude/skills', 'synced']);
        fs.rmSync(path.join(userHome, '.claude', 'skills', 'synced', 'acct-1', 'gamma'), { recursive: true });
        const r = run();
        g = group(r, 'gamma');
        assert.deepEqual(g.loadedTwice, []);
        assert.ok(r.recommendations.some(l => l.startsWith('gamma:') && /no client loads two of them/.test(l)), r.recommendations.join('\n'));
        fs.rmSync(path.join(userHome, '.claude', 'skills', 'gamma'), { recursive: true });
        fs.rmSync(path.join(syncedPlugins, 'superpowers', 'skills', 'gamma'), { recursive: true });
    });

    check('the same SKILL.md under two names is reported', () => {
        const r = run();
        const same = r.sameContent.find(s => s.copies.some(c => c.name === 'game-art-review'));
        assert.ok(same, JSON.stringify(r.sameContent));
        assert.deepEqual(same.copies.map(c => c.name).sort(), ['art-review-copy', 'game-art-review']);
    });

    check('a pack switched on is one copy per client, expected; a duplicate is one client loading two copies', () => {
        write(path.join(packDir, 'skills', 'pack-only', 'SKILL.md'), skillMd('pack-only', 'Only in the pack.', SHARED));
        registerPack(packDir, { home: hub });
        activatePack(project, 'testing', { home: hub });
        // The user's two homes: Claude Code reads one, Codex and Gemini CLI the other.
        write(path.join(userHome, '.claude', 'skills', 'both-homes', 'SKILL.md'), skillMd('both-homes', 'In both user homes.'));
        write(path.join(userHome, '.agents', 'skills', 'both-homes', 'SKILL.md'), skillMd('both-homes', 'In both user homes.'));
        // The project and the user's Claude Code home: Claude Code loads both.
        write(path.join(project, '.claude', 'skills', 'twice', 'SKILL.md'), skillMd('twice', 'Loaded twice.'));
        write(path.join(userHome, '.claude', 'skills', 'twice', 'SKILL.md'), skillMd('twice', 'Loaded twice.'));
        const r = run();
        const placed = group(r, 'pack-only');
        assert.equal(placed.verdict, 'identical');
        assert.deepEqual(placed.loadedTwice, []);
        assert.equal(placed.expected, true);
        assert.deepEqual(placed.perClient, { 'Claude Code': ['project .claude/skills (placed by pack:testing)'], Codex: ['project .agents/skills (placed by pack:testing)'], 'Gemini CLI': ['project .agents/skills (placed by pack:testing)'] });
        assert.ok(!r.recommendations.some(l => l.startsWith('pack-only:') && !l.endsWith('not measured.')), r.recommendations.join('\n'));
        assert.deepEqual(group(r, 'both-homes').loadedTwice, []);
        assert.ok(!r.recommendations.some(l => l.startsWith('both-homes:') && !l.endsWith('not measured.')));
        const twice = group(r, 'twice');
        assert.deepEqual(twice.loadedTwice, ['Claude Code']);
        assert.ok(r.recommendations.some(l => l.startsWith('twice: 2 identical copies') && /Claude Code loads 2 of them/.test(l) && /keep one per client/.test(l)));
        assert.match(renderInventory(r), /pack-only · identical · .* · one copy per client/);
    });

    check('order: an explicit version when every copy has one, a file date only for copies whose date means something, else none', () => {
        assert.ok(compareVersions('1.10.0', '1.2.0') > 0 && compareVersions('v2', '10') < 0 && compareVersions('1.0', '1.0') === 0);
        write(path.join(syncedPlugins, 'toolkit-next', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'toolkit-next', version: '1.10.0' }));
        write(path.join(syncedPlugins, 'toolkit-next', 'skills', 'lint-helper', 'SKILL.md'), `---\nname: lint-helper\ndescription: Lints.\n---\nbody v2\n`);
        write(path.join(project, '.claude', 'skills', 'dated', 'SKILL.md'), skillMd('dated', 'Has a date.', 'old body'));
        write(path.join(userHome, '.claude', 'skills', 'dated', 'SKILL.md'), skillMd('dated', 'Has a date.', 'new body'));
        fs.utimesSync(path.join(project, '.claude', 'skills', 'dated', 'SKILL.md'), new Date('2026-01-01'), new Date('2026-01-01'));
        const r = run();
        const lint = group(r, 'lint-helper');
        assert.equal(lint.verdict, 'different-versions');
        assert.deepEqual(lint.order, { by: 'version', newest: 'plugin:toolkit-next', version: '1.10.0' });
        assert.ok(r.recommendations.some(l => l.startsWith('lint-helper:') && /Newest by version: plugin:toolkit-next \(1\.10\.0\)/.test(l)));
        assert.deepEqual(group(r, 'dated').order, { by: 'mtime', newest: 'user ~/.claude/skills' });
        assert.ok(r.recommendations.some(l => l.startsWith('dated:') && /weak hint: user ~\/\.claude\/skills/.test(l)));
        assert.ok(r.recommendations.some(l => l.startsWith('test-game-prototype:') && /No order is known/.test(l)));
    });

    check('short unrelated skills that share a name are a name clash, not two versions (short-file probe)', () => {
        write(path.join(userHome, '.claude', 'skills', 'notes', 'SKILL.md'), skillMd('notes', 'Take meeting notes.', 'Write them down.'));
        write(path.join(syncedPlugins, 'superpowers', 'skills', 'notes', 'SKILL.md'), skillMd('notes', 'Read sheet music.', 'Name each pitch.'));
        const r = run();
        assert.equal(group(r, 'notes').verdict, 'name-clash');
    });

    check('common words do not make two short unrelated skills one skill (stopword probe)', () => {
        write(path.join(userHome, '.claude', 'skills', 'deploy', 'SKILL.md'), skillMd('deploy', 'Deploy the website.', 'Use this skill when you want to deploy the website with your settings from this repository. Always check that your build passes before you push, then wait until the preview is live.'));
        write(path.join(userHome, '.agents', 'skills', 'deploy', 'SKILL.md'), skillMd('deploy', 'Deploy the game.', 'Use this skill when you want to deploy a mobile game build to the store with your signing keys from this machine. Always check that your keystore exists before you upload, then wait until review starts.'));
        const r = run();
        assert.equal(group(r, 'deploy').verdict, 'name-clash');
        assert.ok(!r.recommendations.some(l => l.startsWith('deploy:') && /versions of one skill/.test(l)));
        fs.rmSync(path.join(userHome, '.claude', 'skills', 'deploy'), { recursive: true });
        fs.rmSync(path.join(userHome, '.agents', 'skills', 'deploy'), { recursive: true });
    });

    check('broken copies: relative links to missing files are counted, and the complete copy is preferred', () => {
        const syncedSkill = path.join(userHome, '.claude', 'skills', 'synced', 'acct-1', 'broken-skill');
        write(path.join(syncedSkill, 'SKILL.md'), skillMd('broken-skill', 'Has references.', 'Read `references/stages.md` first; the recipe is in [fleet](../codex-fleet/SKILL.md).'));
        const full = path.join(syncedPlugins, 'superpowers', 'skills', 'broken-skill');
        write(path.join(full, 'SKILL.md'), skillMd('broken-skill', 'Has references.', 'Read `references/stages.md` first.'));
        write(path.join(full, 'references', 'stages.md'), 'stages');
        const lonely = path.join(userHome, '.agents', 'skills', 'lonely');
        write(path.join(lonely, 'SKILL.md'), skillMd('lonely', 'Alone.', 'Run `./scripts/run.js` (ours) and `scripts/deploy.sh` (in your project). See [web](https://example.com/a.md), [here](#top), `other-skill/references/a.md` and\n```\n`references/in-fence.md`\n```\n'));
        const r = run();
        const g = group(r, 'broken-skill');
        assert.equal(g.verdict, 'different-versions');
        const syncedCopy = g.copies.find(c => c.source === 'synced');
        assert.deepEqual(syncedCopy.brokenLinks, ['../codex-fleet/SKILL.md', 'references/stages.md']);
        assert.deepEqual(g.copies.find(c => c.source === 'plugin:superpowers').brokenLinks, []);
        assert.deepEqual(g.prefer, ['plugin:superpowers']);
        assert.ok(r.recommendations.some(l => l.startsWith('broken-skill:') && /Broken: synced \(2 missing links\); prefer the complete copy \(plugin:superpowers\)/.test(l)), r.recommendations.join('\n'));
        assert.ok(r.recommendations.includes('lonely (user ~/.agents/skills): broken: 1 missing link (./scripts/run.js).'), r.recommendations.join('\n'));
        assert.ok(r.broken.some(b => b.name === 'lonely'));
        assert.match(renderInventory(r), /synced \[broken: 2 missing link\(s\)\]/);
    });

    check('folder names that are not skill names, broken frontmatter and a name already prefixed', () => {
        write(path.join(userHome, '.claude', 'skills', 'Bad Name!', 'SKILL.md'), skillMd('bad', 'x'));
        write(path.join(userHome, '.claude', 'skills', 'yaml-open', 'SKILL.md'), '---\nname: open\ndescription: never closed\n\n# body\n');
        write(path.join(userHome, '.claude', 'skills', 'yaml-list', 'SKILL.md'), '---\nname: [a, b]\ndescription: a list\n---\nbody\n');
        write(path.join(syncedPlugins, 'superpowers', 'skills', 'prefixed', 'SKILL.md'), skillMd('superpowers:prefixed', 'Already prefixed.'));
        const r = run();
        assert.ok(r.notes.some(n => n.includes('Bad Name!') && /not a skill name/.test(n)), r.notes.join(' | '));
        assert.ok(r.skills.some(s => s.key === 'yaml-open'));
        assert.ok(r.notes.some(n => n.includes('yaml-open/SKILL.md') && /not closed/.test(n)));
        assert.ok(r.skills.some(s => s.key === 'yaml-list'));
        assert.ok(r.notes.some(n => n.includes('yaml-list/SKILL.md') && /not a skill name/.test(n)));
        assert.equal(r.skills.find(s => s.key === 'prefixed').qualified, 'superpowers:prefixed');
    });

    check('a huge SKILL.md is not hashed and does not stop the inventory', () => {
        const huge = path.join(userHome, '.agents', 'skills', 'huge');
        write(path.join(huge, 'SKILL.md'), skillMd('huge', 'Very large.') + 'x'.repeat(INVENTORY_LIMITS.bytesPerSkill + 1024));
        const r = run();
        const h = r.skills.find(s => s.name === 'huge');
        assert.ok(h);
        assert.equal(h.skillMdHash, null);
        assert.equal(h.folderHash, null);
        assert.ok(r.notes.some(n => n.includes('huge/SKILL.md') && /not hashed/.test(n)));
        assert.ok(r.skills.some(s => s.name === 'codex-only'));
        fs.rmSync(huge, { recursive: true });
    });

    check('a skill with no measurement anywhere gets a "not measured" line; a measured one does not', () => {
        const r = run();
        assert.ok(r.recommendations.includes('lint-helper: not measured.'));
        assert.ok(!r.recommendations.includes('test-game-prototype: not measured.'));
        assert.ok(!r.unmeasured.includes('test-game-prototype'));
    });

    check('an escaping plugin.json skills path is refused with a note', () => {
        const r = run();
        assert.ok(r.notes.some(n => n.includes('../../escape') && /escapes/.test(n)), r.notes.join(' | '));
    });

    check('links are not followed: a linked skill folder, a linked SKILL.md and a linked folder inside a skill are skipped', () => {
        if (!canLink) { console.log('  (links not permitted here; skipped)'); return; }
        const outside = path.join(tmp, 'outside-skill');
        write(path.join(outside, 'SKILL.md'), skillMd('outside', 'Elsewhere.'));
        fs.symlinkSync(outside, path.join(userHome, '.claude', 'skills', 'linked'), 'dir');
        write(path.join(userHome, '.agents', 'skills', 'md-link', 'x.md'), 'x');
        fs.symlinkSync(path.join(outside, 'SKILL.md'), path.join(userHome, '.agents', 'skills', 'md-link', 'SKILL.md'));
        fs.symlinkSync(path.join(outside), path.join(appRoot, 'skills', 'project-scissors', 'references', 'linked-dir'), 'dir');
        const r = run();
        assert.ok(!r.skills.some(s => s.name === 'outside'));
        assert.ok(r.notes.some(n => n.includes('linked') && /link/.test(n)));
        assert.ok(r.notes.some(n => n.includes('md-link/SKILL.md') && /link/.test(n)));
        assert.ok(r.notes.some(n => n.includes('references/linked-dir') && /link/.test(n)));
        fs.unlinkSync(path.join(userHome, '.claude', 'skills', 'linked'));
        fs.rmSync(path.join(userHome, '.agents', 'skills', 'md-link'), { recursive: true });
        fs.unlinkSync(path.join(appRoot, 'skills', 'project-scissors', 'references', 'linked-dir'));
    });

    check('the scan is bounded: a root with too many entries is cut with a note, a huge skill is not hashed whole', () => {
        const many = path.join(userHome, '.agents', 'skills');
        for (let i = 0; i < INVENTORY_LIMITS.foldersPerRoot + 3; i++) fs.mkdirSync(path.join(many, `zz-${String(i).padStart(4, '0')}`), { recursive: true });
        const big = path.join(userHome, '.claude', 'skills', 'big');
        write(path.join(big, 'SKILL.md'), skillMd('big', 'Many files.'));
        for (let i = 0; i < INVENTORY_LIMITS.filesPerSkill + 2; i++) fs.writeFileSync(path.join(big, `f${i}.txt`), String(i));
        const r = run();
        assert.ok(r.notes.some(n => n.startsWith('~/.agents/skills holds') && n.includes(`first ${INVENTORY_LIMITS.foldersPerRoot}`)), r.notes.join(' | '));
        assert.equal(r.skills.find(s => s.name === 'big').folderHash, null);
        assert.ok(r.notes.some(n => n.includes('big') && /not hashed whole/.test(n)));
        for (const e of fs.readdirSync(many)) if (e.startsWith('zz-')) fs.rmdirSync(path.join(many, e));
        fs.rmSync(big, { recursive: true });
    });

    const dest = path.join(tmp, 'my-skills');
    check('export writes the copy and its source record, and lists it in the data folder', () => {
        const r = exportSkill('project-scissors', dest, { appRoot, home: hub, plutosVersion: '9.9.9' });
        assert.equal(r.path, path.join(dest, 'project-scissors'));
        const record = JSON.parse(fs.readFileSync(path.join(dest, 'project-scissors', SOURCE_RECORD), 'utf8'));
        assert.equal(record.version, 1);
        assert.deepEqual(record.from, { kind: 'plutos', id: 'plutos', path: 'skills/project-scissors' });
        assert.equal(record.skill, 'project-scissors');
        assert.match(record.sourceHash, /^[0-9a-f]{64}$/);
        assert.equal(record.plutosVersion, '9.9.9');
        assert.ok(record.exportedAt);
        assert.ok(fs.existsSync(path.join(dest, 'project-scissors', 'references', 'a.md')));
        assert.ok(JSON.parse(fs.readFileSync(path.join(hub, 'skill-exports.json'), 'utf8')).exports.some(e => e.path === r.path));
        exportSkill('testing:test-game-prototype', dest, { appRoot, home: hub });
        assert.throws(() => exportSkill('nope', dest, { appRoot, home: hub }), /No skill "nope"/);
    });

    check('export refuses to overwrite without --force, and refuses local edits without --force-local', () => {
        assert.throws(() => exportSkill('project-scissors', dest, { appRoot, home: hub }), /already exists; pass --force/);
        exportSkill('project-scissors', dest, { appRoot, home: hub, force: true });   // no edits: replaced
        fs.appendFileSync(path.join(dest, 'project-scissors', 'SKILL.md'), '\nmy note\n');
        assert.throws(() => exportSkill('project-scissors', dest, { appRoot, home: hub, force: true }), /local edits.*SKILL\.md/);
        write(path.join(dest, 'hand-made', 'SKILL.md'), skillMd('hand-made', 'x'));
        fs.mkdirSync(path.join(appRoot, 'skills', 'hand-made'), { recursive: true });
        fs.copyFileSync(path.join(dest, 'hand-made', 'SKILL.md'), path.join(appRoot, 'skills', 'hand-made', 'SKILL.md'));
        assert.throws(() => exportSkill('hand-made', dest, { appRoot, home: hub, force: true }), /no \.plutos-source\.json/);
        fs.rmSync(path.join(appRoot, 'skills', 'hand-made'), { recursive: true });
        fs.rmSync(path.join(dest, 'hand-made'), { recursive: true });
    });

    check('the inventory marks exports current, locally edited, stale and source gone', () => {
        let r = run();
        const state = name => r.exports.find(e => e.name === name)?.state;
        assert.equal(state('project-scissors'), 'edited');
        assert.equal(state('test-game-prototype'), 'current');
        assert.ok(r.exports.find(e => e.name === 'project-scissors').editedFiles.includes('SKILL.md'));
        // The pack moves on: the export is stale.
        fs.writeFileSync(path.join(packDir, 'skills', 'test-game-prototype', 'scripts', 'bot.js'), 'bot v3');
        r = run();
        assert.equal(state('test-game-prototype'), 'stale');
        assert.ok(r.recommendations.some(l => l.startsWith('test-game-prototype (export at') && /changed since the export \(scripts\/bot\.js\)/.test(l)));
        // --force --force-local takes the source's version and keeps the edits in the data folder.
        const replaced = exportSkill('project-scissors', dest, { appRoot, home: hub, force: true, forceLocal: true });
        assert.ok(replaced.replacedTo && fs.readFileSync(path.join(replaced.replacedTo, 'SKILL.md'), 'utf8').includes('my note'));
        r = run();
        assert.equal(state('project-scissors'), 'current');
        // The source goes away.
        fs.renameSync(path.join(appRoot, 'skills', 'project-scissors'), path.join(tmp, 'moved'));
        r = run();
        assert.equal(state('project-scissors'), 'source-gone');
        fs.renameSync(path.join(tmp, 'moved'), path.join(appRoot, 'skills', 'project-scissors'));
    });

    check('an export inside a client folder is recognised there by its record', () => {
        exportSkill('plutos-mini', path.join(userHome, '.claude', 'skills'), { appRoot, home: hub });
        const r = run();
        const e = r.exports.find(x => x.name === 'plutos-mini');
        assert.equal(e.source, 'user');
        assert.equal(e.state, 'current');
        assert.equal(group(r, 'plutos-mini').verdict, 'identical');
    });

    check('an export outside every client folder is in its duplicate group, labelled export, loaded by no client', () => {
        const r = run();
        const g = group(r, 'project-scissors');
        const copy = g.copies.find(c => c.source === 'export');
        assert.ok(copy, JSON.stringify(g.copies));
        assert.equal(copy.loaded, false);
        assert.deepEqual(copy.clients, []);
        assert.equal(copy.path, path.join(dest, 'project-scissors'));
    });

    check('export --force replaces only what its record accounts for; anything else needs --force-local and a whole backup', () => {
        const target = path.join(dest, 'project-scissors');
        exportSkill('project-scissors', dest, { appRoot, home: hub, force: true });   // current, accounted: replaced
        // A .git folder and an untracked file are not in the record.
        write(path.join(target, '.git', 'HEAD'), 'ref: main');
        write(path.join(target, 'mine.txt'), 'mine');
        assert.throws(() => exportSkill('project-scissors', dest, { appRoot, home: hub, force: true }), /\.git\/ \(not in the record\).*mine\.txt \(not in the record\)/);
        assert.ok(fs.existsSync(path.join(target, '.git', 'HEAD')));
        const outsideFile = path.join(tmp, 'outside-target.txt');
        write(outsideFile, 'keep me');
        if (canLink) {
            fs.symlinkSync(outsideFile, path.join(target, 'ln'));
            assert.throws(() => exportSkill('project-scissors', dest, { appRoot, home: hub, force: true }), /ln \(a link\)/);
        }
        const r = exportSkill('project-scissors', dest, { appRoot, home: hub, force: true, forceLocal: true });
        assert.ok(r.replacedTo.startsWith(path.join(hub, 'skill-exports', 'replaced') + path.sep));
        assert.equal(fs.readFileSync(path.join(r.replacedTo, '.git', 'HEAD'), 'utf8'), 'ref: main');
        assert.equal(fs.readFileSync(path.join(r.replacedTo, 'mine.txt'), 'utf8'), 'mine');
        assert.ok(fs.existsSync(path.join(r.replacedTo, SOURCE_RECORD)));
        if (canLink) {
            assert.ok(fs.lstatSync(path.join(r.replacedTo, 'ln')).isSymbolicLink());
            assert.equal(fs.readlinkSync(path.join(r.replacedTo, 'ln')), outsideFile);
        }
        assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'keep me');
        assert.ok(!fs.existsSync(path.join(target, '.git')) && !fs.existsSync(path.join(target, 'mine.txt')));
        // More entries than a backup may hold: refused, nothing removed.
        const bulk = path.join(target, 'bulk');
        fs.mkdirSync(bulk);
        for (let i = 0; i <= BACKUP_LIMITS.entries; i++) fs.writeFileSync(path.join(bulk, `f${i}`), '');
        assert.throws(() => exportSkill('project-scissors', dest, { appRoot, home: hub, force: true, forceLocal: true }), /cannot be backed up whole \(more than \d+ entries\)/);
        assert.equal(fs.readdirSync(bulk).length, BACKUP_LIMITS.entries + 1);
        fs.rmSync(bulk, { recursive: true });
        // A named pipe cannot be backed up: refused, nothing removed.
        const fifo = path.join(target, 'pipe');
        // Git for Windows ships an mkfifo that leaves a plain file, not a pipe: test only a real one.
        if (spawnSync('mkfifo', [fifo]).status === 0 && fs.lstatSync(fifo).isFIFO()) {
            assert.throws(() => exportSkill('project-scissors', dest, { appRoot, home: hub, force: true, forceLocal: true }), /cannot be backed up whole \(pipe is not a file, a folder or a link\)/);
            assert.ok(fs.lstatSync(fifo).isFIFO());
        }
        fs.rmSync(fifo, { force: true });
        exportSkill('project-scissors', dest, { appRoot, home: hub, force: true });
    });

    check('export never lands in, on or around its source, PLUT_OS\'s skill folders or a pack', () => {
        const srcMd = path.join(appRoot, 'skills', 'project-scissors', 'SKILL.md');
        const before = fs.readFileSync(srcMd, 'utf8');
        assert.throws(() => exportSkill('project-scissors', path.join(appRoot, 'skills'), { appRoot, home: hub, force: true, forceLocal: true }), /the skill being exported; nothing was changed/);
        assert.throws(() => exportSkill('project-scissors', path.join(packDir, 'skills'), { appRoot, home: hub, force: true, forceLocal: true }), /a PLUT_OS or pack source folder/);
        assert.throws(() => exportSkill('testing:test-game-prototype', path.join(appRoot, 'skills'), { appRoot, home: hub, force: true, forceLocal: true }), /a PLUT_OS or pack source folder/);
        assert.throws(() => exportSkill('project-scissors', path.join(appRoot, 'skills', 'project-scissors', 'references'), { appRoot, home: hub }), /the skill being exported/);
        assert.equal(fs.readFileSync(srcMd, 'utf8'), before);
        assert.ok(!fs.existsSync(path.join(appRoot, 'skills', 'test-game-prototype')));
    });

    check('export never replaces a PLUT_OS app folder; only a client skills folder inside it takes one', () => {
        write(path.join(appRoot, 'lib', 'core.js'), '// core');
        write(path.join(packDir, 'skills', 'lib', 'SKILL.md'), skillMd('lib', 'A skill named like a source folder.'));
        for (const where of [appRoot, path.join(appRoot, 'lib'), path.join(appRoot, 'docs', 'skills')]) {
            assert.throws(() => exportSkill('testing:lib', where, { appRoot, home: hub, force: true, forceLocal: true }), /PLUT_OS app folder|a PLUT_OS or pack source folder/);
        }
        assert.equal(fs.readFileSync(path.join(appRoot, 'lib', 'core.js'), 'utf8'), '// core');
        assert.ok(!fs.existsSync(path.join(appRoot, 'lib', 'lib')));
        const r = exportSkill('testing:lib', path.join(appRoot, '.claude', 'skills'), { appRoot, home: hub });
        assert.equal(r.path, path.join(appRoot, '.claude', 'skills', 'lib'));
        fs.rmSync(path.join(appRoot, '.claude'), { recursive: true });
        fs.rmSync(path.join(packDir, 'skills', 'lib'), { recursive: true });
    });

    check('the backup folder is built from the validated folder name, inside the data folder', () => {
        write(path.join(appRoot, 'skills', 'evil-name', 'SKILL.md'), skillMd('../../../evil', 'A bad name.'));
        const r1 = exportSkill('evil-name', dest, { appRoot, home: hub });
        assert.equal(r1.path, path.join(dest, 'evil-name'));
        fs.appendFileSync(path.join(dest, 'evil-name', 'SKILL.md'), 'edit');
        const r2 = exportSkill('evil-name', dest, { appRoot, home: hub, force: true, forceLocal: true });
        assert.equal(path.dirname(r2.replacedTo), path.join(hub, 'skill-exports', 'replaced'));
        assert.match(path.basename(r2.replacedTo), /^evil-name-/);
        assert.ok(!fs.existsSync(path.join(tmp, 'evil')) && !fs.existsSync(path.join(hub, 'evil')));
        fs.rmSync(path.join(appRoot, 'skills', 'evil-name'), { recursive: true });
    });

    check('the inventory changes nothing it reads: names, contents, sizes and dates', () => {
        const snapshot = dir => {
            const out = {};
            for (const rel of fs.readdirSync(dir, { recursive: true }).sort()) {
                const full = path.join(dir, rel);
                const st = fs.lstatSync(full);
                out[rel] = `${st.isDirectory() ? 'd' : st.isSymbolicLink() ? 'l' : 'f'}|${st.size}|${st.mtimeMs}|${st.isFile() ? createHash('sha256').update(fs.readFileSync(full)).digest('hex') : ''}`;
            }
            return out;
        };
        const roots = [userHome, project, appRoot, packDir, hub, dest];
        const before = roots.map(snapshot);
        run();
        renderInventory(run());
        assert.deepEqual(roots.map(snapshot), before);
    });

    check('render: counts per source, duplicate verdicts, exports, unmeasured, recommendations', () => {
        const text = renderInventory(run());
        assert.match(text, /plugin:superpowers: \d+/);
        assert.match(text, /brainstorming · name-clash/);
        assert.match(text, /Exports: \d+ \(/);
        assert.match(text, /Not measured: \d+ of \d+ skill names/);
    });

    check('CLI: skills inventory (text and --json, exit 0) and skills export; usage on a missing argument', () => {
        const text = cli(tmp, 'skills', 'inventory', project);
        assert.equal(text.status, 0, text.stderr);
        assert.match(text.stdout, /PLUT_OS · skill inventory/);
        assert.match(text.stdout, /Duplicate names:/);
        const json = cli(tmp, 'skills', 'inventory', project, '--json');
        assert.equal(json.status, 0, json.stderr);
        const parsed = JSON.parse(json.stdout);
        assert.ok(Array.isArray(parsed.skills) && Array.isArray(parsed.duplicates) && Array.isArray(parsed.recommendations));
        const cliDest = path.join(tmp, 'cli-dest');
        const exp = cli(tmp, 'skills', 'export', 'testing:test-game-prototype', cliDest);
        assert.equal(exp.status, 0, exp.stderr);
        assert.ok(fs.existsSync(path.join(cliDest, 'test-game-prototype', SOURCE_RECORD)));
        const again = cli(tmp, 'skills', 'export', 'testing:test-game-prototype', cliDest);
        assert.equal(again.status, 1);
        assert.match(again.stderr, /^\[!\] .*already exists/);
        assert.equal(cli(tmp, 'skills', 'export').status, 1);
        assert.match(cli(tmp, '--help').stdout, /skills inventory \[path\] \[--json\]/);
        assert.match(cli(tmp, '--help').stdout, /\.\/inventory/);
        // A project folder named inventory is reached as ./inventory.
        write(path.join(tmp, 'inventory', '.claude', 'skills', 'inv-skill', 'SKILL.md'), skillMd('inv-skill', 'In a folder named inventory.'));
        const inv = cli(tmp, 'skills', 'inventory', './inventory');
        assert.equal(inv.status, 0, inv.stderr);
        assert.ok(inv.stdout.includes(`Project: ${path.join(tmp, 'inventory')}`));
        assert.ok(!cli(tmp, 'skills', './inventory').stdout.includes('skill inventory'));
        // --force refuses a .git folder the record does not account for; the text report folds "not measured".
        write(path.join(cliDest, 'test-game-prototype', '.git', 'HEAD'), 'x');
        const forced = cli(tmp, 'skills', 'export', 'testing:test-game-prototype', cliDest, '--force');
        assert.equal(forced.status, 1);
        assert.match(forced.stderr, /\.git\/ \(not in the record\)/);
        assert.ok(fs.existsSync(path.join(cliDest, 'test-game-prototype', '.git', 'HEAD')));
        const local = cli(tmp, 'skills', 'export', 'testing:test-game-prototype', cliDest, '--force-local');
        assert.equal(local.status, 0, local.stderr);
        assert.match(local.stdout, /kept in .*skill-exports.replaced/);
        assert.match(text.stdout, /Not measured: \d+ of \d+ skill names have no measurement anywhere; --json lists them\./);
        assert.ok(!/: not measured\./.test(text.stdout));
    });
    check('a bare backtick path is not a link; ./ and Markdown links are', () => {
        const dir = path.join(tmp, 'links-probe', 'one');
        write(path.join(dir, 'SKILL.md'), '---\nname: one\n---\nEdit `scripts/build.sh` and `examples/demo.md` in your project. See [ref](references/a.md), `references/c.md` and `./notes/b.md`.\n');
        assert.deepEqual(missingLinks(dir, fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')), ['./notes/b.md', 'references/a.md', 'references/c.md']);
    });
    check('two unrelated short skills sharing only a licence and a readme are a name clash', () => {
        const home2 = path.join(tmp, 'clash-home'), app2 = path.join(tmp, 'clash-app'), data2 = path.join(tmp, 'clash-data'), proj2 = path.join(tmp, 'clash-proj');
        for (const [dir, body] of [[path.join(home2, '.claude', 'skills', 'deploy'), 'Ship the website to the hosting provider after the tests pass.'],
            [path.join(home2, '.agents', 'skills', 'deploy'), 'Upload a signed mobile game build to the app store with the release keys.']]) {
            write(path.join(dir, 'SKILL.md'), `---\nname: deploy\ndescription: ${body}\n---\n${body}\n`);
            write(path.join(dir, 'LICENSE.txt'), 'MIT');
            write(path.join(dir, 'README.md'), 'readme');
        }
        fs.mkdirSync(app2, { recursive: true }); fs.mkdirSync(data2, { recursive: true }); fs.mkdirSync(proj2, { recursive: true });
        const r = inventory({ projectRoot: proj2, home: data2, userHome: home2, appRoot: app2 });
        const g = r.duplicates.find(d => d.name === 'deploy');
        assert.ok(g, 'deploy group');
        assert.equal(g.verdict, 'name-clash');
    });
} finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`Skill inventory: ${passed} passed, 0 failed`);
