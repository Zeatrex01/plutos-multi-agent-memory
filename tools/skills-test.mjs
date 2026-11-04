#!/usr/bin/env node
// lib/skills.mjs on temp folders only: the data folder is a temp PLUTOS_HOME set before any lib/
// module loads (lib/approot.mjs fixes PLUTOS_HOME_DIR at import), so the real registry is never read
// or written. Covers the list across both homes, the pack registry's refusals, activation and its
// no-partial-state refusal, the hash-checked deactivation, links, the pack's own measured line, the
// brief line and the CLI commands.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-skills-'));
const hub = path.join(tmp, 'hub');
const home = path.join(tmp, 'user-home');
process.env.PLUTOS_HOME = hub;
process.env.HOME = process.env.USERPROFILE = home;
process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
fs.mkdirSync(process.env.APPDATA, { recursive: true });
const { SKILL_HOMES, listProjectSkills, scanProjectSkills, registerPack, listPacks, forgetPack, activatePack, deactivatePack, readActivation, parseSkillFrontmatter, skillsBriefLines } = await import('../lib/skills.mjs');
const { initTargetProject } = await import('../lib/workspaces.mjs');
const { buildBrief } = await import('../lib/continuity.mjs');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
const skillMd = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
const env = { ...process.env };
const cli = (cwd, ...args) => spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), ...args], { env, cwd, encoding: 'utf8' });

try {
    check('the homes name the two folders, each with the clients its documentation names, dated', () => {
        assert.deepEqual(SKILL_HOMES.map(h => h.folder), ['.claude/skills', '.agents/skills']);
        for (const h of SKILL_HOMES) { assert.ok(h.clients.length, h.folder); assert.match(h.verified, /^\d{4}-\d{2}-\d{2}$/); }
    });

    check('frontmatter: quoted, bare and block values; nothing without the fence', () => {
        assert.deepEqual(parseSkillFrontmatter('---\nname: "a"\ndescription: >\n  two\n  lines\n---\nbody'), { name: 'a', description: 'two lines' });
        assert.deepEqual(parseSkillFrontmatter('# no fence\nname: x'), { name: '', description: '' });
    });

    const project = path.join(tmp, 'project');
    fs.mkdirSync(project, { recursive: true });
    write(path.join(project, '.agents', 'skills', 'alpha', 'SKILL.md'), skillMd('alpha', 'Alpha does one thing.'));
    write(path.join(project, '.claude', 'skills', 'alpha', 'SKILL.md'), skillMd('alpha', 'Alpha does one thing.'));
    write(path.join(project, '.claude', 'skills', 'beta', 'SKILL.md'), skillMd('beta', 'Beta.'));
    write(path.join(project, '.claude', 'skills', 'noskill', 'README.md'), 'not a skill');
    check('list finds a skill in both homes and merges it; a folder without SKILL.md is not a skill', () => {
        const skills = listProjectSkills(project);
        assert.deepEqual(skills.map(s => s.name), ['alpha', 'beta']);
        const alpha = skills[0];
        assert.deepEqual(alpha.folders, ['.claude/skills', '.agents/skills']);
        assert.deepEqual(alpha.clients, ['Claude Code', 'Codex', 'Gemini CLI']);
        assert.equal(alpha.description, 'Alpha does one thing.');
        assert.equal(alpha.source, 'project');
        assert.equal(alpha.measured, null);
        assert.deepEqual(skills[1].clients, ['Claude Code']);
    });

    check('a symlinked skill folder is skipped with a note', () => {
        const link = path.join(project, '.agents', 'skills', 'linked');
        try { fs.symlinkSync(path.join(project, '.claude', 'skills', 'beta'), link, 'dir'); } catch (e) { console.log('  (links not permitted here; skipped)'); return; }
        const { skills, notes } = scanProjectSkills(project);
        assert.ok(!skills.some(s => s.name === 'linked'));
        assert.ok(notes.some(n => n.includes('.agents/skills/linked') && /link/.test(n)), notes.join(' | '));
        fs.unlinkSync(link);
    });

    check('nothing is listed without a project root', () => assert.deepEqual(listProjectSkills(''), []));

    // The registry.
    const packDir = path.join(tmp, 'packs', 'demo-pack');
    write(path.join(packDir, 'skills.json'), JSON.stringify({
        version: 1, id: 'demo-pack', name: 'Demo pack', description: 'Two skills for the test.',
        skills: [
            { name: 'demo-skill', description: 'From the record.', measured: { date: '2026-11-01', summary: '3 of 4 blind pairs', record: 'evals/demo.md' } },
            { name: 'other-skill' }
        ]
    }));
    write(path.join(packDir, 'skills', 'demo-skill', 'SKILL.md'), skillMd('demo-skill', 'Demo.'));
    write(path.join(packDir, 'skills', 'demo-skill', 'references', 'notes.md'), 'reference text');
    write(path.join(packDir, 'skills', 'other-skill', 'SKILL.md'), skillMd('other-skill', 'Other.'));
    check('registerPack refuses a folder without a record, a bad id, a missing skills folder and a folder inside the data folder', () => {
        const bare = path.join(tmp, 'packs', 'bare'); fs.mkdirSync(bare, { recursive: true });
        assert.throws(() => registerPack(bare), /No skills.json or module.json/);
        const badId = path.join(tmp, 'packs', 'bad-id');
        write(path.join(badId, 'module.json'), JSON.stringify({ id: 'Bad_Id', name: 'x' }));
        write(path.join(badId, 'skills', 's', 'SKILL.md'), skillMd('s', 'd'));
        assert.throws(() => registerPack(badId), /pack id must match/);
        const noSkills = path.join(tmp, 'packs', 'no-skills');
        write(path.join(noSkills, 'module.json'), JSON.stringify({ id: 'no-skills', name: 'x' }));
        assert.throws(() => registerPack(noSkills), /no skills\/ folder/);
        const inHub = path.join(hub, 'inside-pack');
        write(path.join(inHub, 'module.json'), JSON.stringify({ id: 'inside', name: 'x' }));
        write(path.join(inHub, 'skills', 's', 'SKILL.md'), skillMd('s', 'd'));
        assert.throws(() => registerPack(inHub), /inside the data folder/);
        assert.throws(() => registerPack(path.join(project, 'sub'), { projectRoot: project }), /not found/);
        write(path.join(project, 'sub', 'module.json'), JSON.stringify({ id: 'sub', name: 'x' }));
        write(path.join(project, 'sub', 'skills', 's', 'SKILL.md'), skillMd('s', 'd'));
        assert.throws(() => registerPack(path.join(project, 'sub'), { projectRoot: project }), /inside the open project/);
        fs.rmSync(path.join(project, 'sub'), { recursive: true });
        assert.deepEqual(listPacks(), []);
    });

    check('registerPack stores the record, the skill folders and the measured line; module.json only gives id and name', () => {
        const r = registerPack(packDir);
        assert.equal(r.id, 'demo-pack');
        assert.deepEqual(r.skills.map(s => s.name), ['demo-skill', 'other-skill']);
        assert.equal(r.skills[0].description, 'From the record.');
        assert.deepEqual(r.skills[0].measured, { date: '2026-11-01', summary: '3 of 4 blind pairs', record: 'evals/demo.md' });
        assert.equal(r.skills[1].measured, null);
        const stored = JSON.parse(fs.readFileSync(path.join(hub, 'packs.json'), 'utf8'));
        assert.equal(stored.version, 1);
        assert.equal(stored.packs['demo-pack'].path, fs.realpathSync(packDir));
        const legacy = path.join(tmp, 'packs', 'legacy-pack');
        write(path.join(legacy, 'module.json'), JSON.stringify({ id: 'legacy-pack', name: 'Legacy', description: 'ignored', packageSources: ['x'] }));
        write(path.join(legacy, 'skills', 'legacy-skill', 'SKILL.md'), skillMd('legacy-skill', 'Legacy skill.'));
        const l = registerPack(legacy);
        assert.equal(l.description, '');
        assert.deepEqual(l.skills, [{ name: 'legacy-skill', description: 'Legacy skill.', measured: null }]);
        assert.deepEqual(listPacks().map(p => p.id), ['demo-pack', 'legacy-pack']);
        forgetPack('legacy-pack');
        assert.throws(() => forgetPack('legacy-pack'), /Unknown pack/);
        assert.deepEqual(listPacks().map(p => p.id), ['demo-pack']);
    });

    // Activation on a fresh project.
    const target = path.join(tmp, 'target');
    fs.mkdirSync(target, { recursive: true });
    check('activate refuses when a project folder of the same name exists and leaves nothing behind', () => {
        write(path.join(target, '.agents', 'skills', 'other-skill', 'SKILL.md'), skillMd('other-skill', 'The project\'s own.'));
        assert.throws(() => activatePack(target, 'demo-pack'), /\.agents\/skills\/other-skill already exists/);
        assert.ok(!fs.existsSync(path.join(target, '.claude', 'skills')), 'no home was created');
        assert.ok(!fs.existsSync(path.join(target, '.plutos', 'packs.json')), 'no record was written');
        fs.rmSync(path.join(target, '.agents'), { recursive: true });
        assert.throws(() => activatePack(target, 'nope'), /Unknown pack/);
        assert.throws(() => activatePack('', 'demo-pack'), /Select a project/);
    });

    check('activate copies into both homes and records every file with its hash, no machine path', () => {
        const r = activatePack(target, 'demo-pack');
        assert.equal(r.placed, 4);
        for (const h of SKILL_HOMES) for (const name of ['demo-skill', 'other-skill']) {
            assert.ok(fs.existsSync(path.join(target, ...h.folder.split('/'), name, 'SKILL.md')), `${h.folder}/${name}`);
        }
        assert.ok(fs.existsSync(path.join(target, '.claude', 'skills', 'demo-skill', 'references', 'notes.md')));
        const record = JSON.parse(fs.readFileSync(path.join(target, '.plutos', 'packs.json'), 'utf8'));
        assert.deepEqual(Object.keys(record.active['demo-pack'].placed).sort(), ['.agents/skills/demo-skill', '.agents/skills/other-skill', '.claude/skills/demo-skill', '.claude/skills/other-skill']);
        assert.deepEqual(Object.keys(record.active['demo-pack'].placed['.claude/skills/demo-skill'].files).sort(), ['SKILL.md', 'references/notes.md']);
        assert.ok(!JSON.stringify(record).includes(tmp), 'the record carries no machine path');
        const listed = listProjectSkills(target);
        assert.deepEqual(listed.map(s => [s.name, s.source]), [['demo-skill', 'demo-pack'], ['other-skill', 'demo-pack']]);
        assert.equal(listed[0].measured.summary, '3 of 4 blind pairs');
        assert.equal(activatePack(target, 'demo-pack').placed, 0, 'a second activation places nothing');
    });

    check('deactivate removes only placed, unchanged files; an edited file and an added file survive', () => {
        fs.writeFileSync(path.join(target, '.agents', 'skills', 'demo-skill', 'SKILL.md'), 'edited by the owner');
        fs.writeFileSync(path.join(target, '.claude', 'skills', 'other-skill', 'extra.md'), 'added by the owner');
        write(path.join(target, '.claude', 'skills', 'own-skill', 'SKILL.md'), skillMd('own-skill', 'Not the pack\'s.'));
        const r = deactivatePack(target, 'demo-pack');
        assert.deepEqual(r.removed.sort(), ['.agents/skills/other-skill', '.claude/skills/demo-skill']);
        assert.deepEqual(r.kept.sort(), ['.agents/skills/demo-skill', '.agents/skills/demo-skill/SKILL.md', '.claude/skills/other-skill']);
        assert.ok(fs.existsSync(path.join(target, '.agents', 'skills', 'demo-skill', 'SKILL.md')), 'edited file kept');
        assert.ok(fs.existsSync(path.join(target, '.claude', 'skills', 'other-skill', 'extra.md')), 'added file kept');
        assert.ok(!fs.existsSync(path.join(target, '.claude', 'skills', 'other-skill', 'SKILL.md')), 'placed file removed');
        assert.ok(!fs.existsSync(path.join(target, '.claude', 'skills', 'demo-skill')), 'empty folder removed');
        assert.ok(fs.existsSync(path.join(target, '.claude', 'skills', 'own-skill', 'SKILL.md')), 'the project\'s own skill untouched');
        assert.deepEqual(readActivation(target).active, {});
        assert.throws(() => deactivatePack(target, 'demo-pack'), /not active/);
    });

    check('the brief carries the Skills line with a skill and omits it without', () => {
        const fresh = path.join(tmp, 'fresh');
        fs.mkdirSync(fresh, { recursive: true });
        initTargetProject(fresh);
        assert.ok(!buildBrief(fresh).includes('Skills:'), 'no line on a fresh project');
        assert.deepEqual(skillsBriefLines(fresh), []);
        write(path.join(fresh, '.agents', 'skills', 'review-checklist', 'SKILL.md'), skillMd('review-checklist', 'Secret words that must not reach the brief.'));
        const brief = buildBrief(fresh);
        assert.ok(brief.includes('Skills: 1 in this project — review-checklist, more in the Skills page.'), brief);
        assert.ok(!brief.includes('Secret words'), 'folder names only');
        assert.ok(brief.indexOf('Skills: 1') < brief.indexOf('On demand:'), 'right before the On demand line');
        for (let i = 0; i < 9; i++) write(path.join(fresh, '.agents', 'skills', `s${i}`, 'SKILL.md'), skillMd(`s${i}`, 'x'));
        assert.match(skillsBriefLines(fresh)[0], /^Skills: 10 in this project — (?:[\w-]+, ){7}[\w-]+ …2 more, more in the Skills page\.$/);
    });

    // The CLI, as the owner runs it, on an installed project.
    const cliProject = path.join(tmp, 'cli-project');
    fs.mkdirSync(cliProject, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: cliProject });
    check('plutos skills needs the kit; pack on and off round-trip through the CLI', () => {
        const before = cli(tmp, 'skills', cliProject);
        assert.equal(before.status, 1);
        assert.match(before.stderr, /has no PLUT_OS kit/);
        assert.equal(cli(tmp, 'init', cliProject).status, 0);
        const empty = cli(tmp, 'skills', cliProject);
        assert.equal(empty.status, 0, empty.stderr);
        assert.match(empty.stdout, /No skill yet/);
        assert.equal(cli(tmp, 'pack', 'list').stdout.trim().startsWith('- demo-pack'), true);
        const on = cli(tmp, 'pack', 'on', 'demo-pack', cliProject);
        assert.equal(on.status, 0, on.stderr);
        const listed = cli(tmp, 'skills', cliProject);
        assert.match(listed.stdout, /demo-skill · Claude Code, Codex, Gemini CLI · pack demo-pack · measured 2026-11-01: 3 of 4 blind pairs \(evals\/demo.md\)/);
        assert.match(listed.stdout, /other-skill · .* · not measured/);
        const off = cli(tmp, 'pack', 'off', 'demo-pack', cliProject);
        assert.equal(off.status, 0, off.stderr);
        assert.match(off.stdout, /4 folder\(s\) removed/);
        assert.match(cli(tmp, 'skills', cliProject).stdout, /No skill yet/);
        const bad = cli(tmp, 'pack', 'on', 'nope', cliProject);
        assert.equal(bad.status, 1);
        assert.match(bad.stderr, /^\[!\] Unknown pack "nope"/);
        assert.equal(cli(tmp, 'pack').status, 1);
        assert.match(cli(tmp, '--help').stdout, /pack on <id> \[path\]/);
    });
} finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`Skills: ${passed} passed, 0 failed`);
