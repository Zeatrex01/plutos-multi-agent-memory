#!/usr/bin/env node
// lib/skills.mjs on temp folders only: the data folder is a temp PLUTOS_HOME set before any lib/
// module loads (lib/approot.mjs fixes PLUTOS_HOME_DIR at import), so the real registry is never read
// or written. Covers the list across both homes, the pack registry's refusals, activation and its
// no-partial-state refusal, the hash-checked deactivation, links, the pack's own measured line, the
// brief line, the CLI commands, a pack's declared MCP servers in the project's .mcp.json, the two
// packs PLUT_OS ships (packs/) and activePackMcpServers.
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
const { SKILL_HOMES, listProjectSkills, scanProjectSkills, registerPack, listPacks, forgetPack, activatePack, deactivatePack, readActivation, parseSkillFrontmatter, skillsBriefLines, shippedPacks, SHIPPED_PACKS_DIR, activePackMcpServers } = await import('../lib/skills.mjs');
const { resolvePackMcpEntry, parsePackMcpServers, MCP_CONFIGS, RECOMMENDED_MCPS } = await import('../lib/mcps.mjs');
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

    // A skill added to the pack folder after `pack add` (field report 2026-11-14, amongrooms D3).
    const growDir = path.join(tmp, 'packs', 'grow-pack');
    write(path.join(growDir, 'module.json'), JSON.stringify({ id: 'grow-pack', name: 'Grow' }));
    write(path.join(growDir, 'skills', 'first', 'SKILL.md'), skillMd('first', 'First.'));
    check('pack list counts the pack folder live; activation writes the inspected skills back to the registry', () => {
        registerPack(growDir);
        write(path.join(growDir, 'skills', 'second', 'SKILL.md'), skillMd('second', 'Second.'));
        write(path.join(growDir, 'skills', 'not-a-skill', 'README.md'), 'no SKILL.md');
        assert.deepEqual(listPacks().find(p => p.id === 'grow-pack').skills, ['first', 'second']);
        assert.match(cli(tmp, 'pack', 'list').stdout, /grow-pack · Grow · 2 skill\(s\)/);
        const stored = () => JSON.parse(fs.readFileSync(path.join(hub, 'packs.json'), 'utf8')).packs['grow-pack'].skills.map(s => s.name);
        assert.deepEqual(stored(), ['first'], 'the registry still holds the count from pack add');
        const growTarget = path.join(tmp, 'grow-target');
        fs.mkdirSync(growTarget, { recursive: true });
        activatePack(growTarget, 'grow-pack');
        assert.deepEqual(stored(), ['first', 'second']);
    });

    check('pack on warns when git ignores a placed skill, not one added with git add -f, and is silent outside a repository', () => {
        const repo = path.join(tmp, 'ignored-repo');
        fs.mkdirSync(repo, { recursive: true });
        if (spawnSync('git', ['init', '-q'], { cwd: repo }).status !== 0) { console.log('  (git not available; skipped)'); return; }
        fs.writeFileSync(path.join(repo, '.gitignore'), '.agents/\n');
        const first = activatePack(repo, 'grow-pack');
        const warning = first.notes.find(n => /^git ignores /.test(n));
        assert.ok(warning, first.notes.join(' | '));
        assert.match(warning, /\.agents\/skills\/first, \.agents\/skills\/second/);
        assert.ok(!/\.claude\/skills/.test(warning), warning);
        // Every recorded placement is checked, not only this run's copies.
        assert.ok(activatePack(repo, 'grow-pack').notes.some(n => /^git ignores /.test(n)), 'a second run still warns');
        assert.equal(spawnSync('git', ['add', '-f', '.agents/skills'], { cwd: repo }).status, 0);
        assert.ok(!activatePack(repo, 'grow-pack').notes.some(n => /^git ignores /.test(n)), 'files added with git add -f are not flagged');
        const plain = path.join(tmp, 'grow-target');
        assert.ok(!activatePack(plain, 'grow-pack').notes.some(n => /^git ignores /.test(n)), 'no warning outside a repository');
    });

    // A pack's declared MCP servers (owner decision d-9ca58ad53503): project .mcp.json only.
    const mcpPack = path.join(tmp, 'packs', 'mcp-pack');
    const mcpDecl = {
        tool: { command: 'python3', args: ['-m', 'tool_server'], env: { MODE: 'pack' }, os: { win32: { command: 'python' } } },
        other: { command: 'npx', args: ['-y', 'other-server'] }
    };
    write(path.join(mcpPack, 'skills.json'), JSON.stringify({ version: 1, id: 'mcp-pack', name: 'MCP pack', skills: [], mcpServers: mcpDecl }));
    write(path.join(mcpPack, 'skills', 'uses-tool', 'SKILL.md'), skillMd('uses-tool', 'Calls the tool server.'));
    const readMcp = root => JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
    check('registerPack refuses a malformed mcpServers declaration and lists the declared names', () => {
        const bad = path.join(tmp, 'packs', 'bad-mcp');
        write(path.join(bad, 'skills', 's', 'SKILL.md'), skillMd('s', 'd'));
        for (const servers of [{ 'bad name': { command: 'x' } }, { x: { args: ['a'] } }, { x: { command: 'x', args: 'a' } }, { x: { command: 'x', os: { plan9: { command: 'y' } } } }, ['x']]) {
            write(path.join(bad, 'skills.json'), JSON.stringify({ version: 1, id: 'bad-mcp', name: 'Bad', mcpServers: servers }));
            assert.throws(() => registerPack(bad), /mcpServers/, JSON.stringify(servers));
        }
        assert.deepEqual(registerPack(mcpPack).mcpServers, ['tool', 'other']);
    });

    const mcpProject = path.join(tmp, 'mcp-project');
    fs.mkdirSync(mcpProject, { recursive: true });
    const realHome = path.join(home, '.claude.json');
    check('pack on adds the declared servers to the project .mcp.json, resolved for this OS, and records them; no home config is written', () => {
        write(path.join(mcpProject, '.mcp.json'), JSON.stringify({ mcpServers: { plutos: { command: 'node', args: ['.plutos/plutos-launch.mjs'] } } }));
        const r = activatePack(mcpProject, 'mcp-pack');
        assert.deepEqual(r.mcp, { added: ['tool', 'other'], conflicts: [] });
        const cfg = readMcp(mcpProject);
        assert.deepEqual(Object.keys(cfg.mcpServers), ['plutos', 'tool', 'other']);
        assert.equal(cfg.mcpServers.tool.command, process.platform === 'win32' ? 'python' : 'python3');
        assert.deepEqual(cfg.mcpServers.tool.args, ['-m', 'tool_server']);
        assert.equal(cfg.mcpServers.tool.os, undefined, 'the per-OS table is not written');
        const rec = readActivation(mcpProject).active['mcp-pack'].mcp;
        assert.deepEqual(Object.keys(rec.servers), ['tool', 'other']);
        assert.equal(rec.created, false);
        assert.ok(r.notes.some(n => /Added to \.mcp\.json: tool, other/.test(n)), r.notes.join(' | '));
        assert.ok(r.notes.some(n => /mcpServers\.tool holds the .* command/.test(n)), 'the per-OS entry is flagged');
        assert.ok(!fs.existsSync(realHome), 'no ~/.claude.json was written');
        // A second run changes nothing.
        const again = activatePack(mcpProject, 'mcp-pack');
        assert.deepEqual(again.mcp, { added: [], conflicts: [] });
        assert.deepEqual(readMcp(mcpProject), cfg);
    });

    check('the per-OS command: win32 and linux resolve differently', () => {
        const decl = parsePackMcpServers(mcpDecl).tool;
        assert.equal(resolvePackMcpEntry(decl, 'win32').command, 'python');
        assert.equal(resolvePackMcpEntry(decl, 'linux').command, 'python3');
        assert.deepEqual(resolvePackMcpEntry(decl, 'darwin').env, { MODE: 'pack' });
    });

    check('pack off removes only unchanged entries it added; an edited one stays with a note; the owner\'s own stays', () => {
        const cfg = readMcp(mcpProject);
        cfg.mcpServers.other.args = ['-y', 'other-server', '--edited'];
        fs.writeFileSync(path.join(mcpProject, '.mcp.json'), JSON.stringify(cfg, null, 4));
        const r = deactivatePack(mcpProject, 'mcp-pack');
        assert.deepEqual(r.mcp, { removed: ['tool'], kept: ['other'] });
        assert.ok(r.kept.includes('.mcp.json:other'));
        assert.ok(r.notes.some(n => /other changed since pack on and stayed/.test(n)), r.notes.join(' | '));
        assert.deepEqual(Object.keys(readMcp(mcpProject).mcpServers), ['plutos', 'other']);
        assert.equal(readActivation(mcpProject).active['mcp-pack'], undefined);
    });

    check('pack on never overwrites an entry of the same name it did not add: a conflict is reported', () => {
        // `other` is now the owner's (the record was dropped at pack off).
        const r = activatePack(mcpProject, 'mcp-pack');
        assert.deepEqual(r.mcp, { added: ['tool'], conflicts: ['other'] });
        assert.ok(r.notes.some(n => /already has other, not added by the pack "mcp-pack"/.test(n)), r.notes.join(' | '));
        assert.deepEqual(readMcp(mcpProject).mcpServers.other.args, ['-y', 'other-server', '--edited']);
        assert.deepEqual(Object.keys(readActivation(mcpProject).active['mcp-pack'].mcp.servers), ['tool']);
        const off = deactivatePack(mcpProject, 'mcp-pack');
        assert.deepEqual(off.mcp, { removed: ['tool'], kept: [] });
        assert.deepEqual(Object.keys(readMcp(mcpProject).mcpServers), ['plutos', 'other'], 'the conflicting entry survives pack off');
    });

    check('a .mcp.json that is not JSON refuses pack on before any skill is placed', () => {
        const broken = path.join(tmp, 'mcp-broken');
        write(path.join(broken, '.mcp.json'), '{ not json');
        assert.throws(() => activatePack(broken, 'mcp-pack'), /\.mcp\.json is not valid JSON/);
        assert.ok(!fs.existsSync(path.join(broken, '.claude', 'skills')), 'nothing was placed');
        assert.ok(!fs.existsSync(path.join(broken, '.plutos', 'packs.json')));
    });

    check('a .mcp.json the pack created goes again at pack off when nothing else is left in it', () => {
        const fresh = path.join(tmp, 'mcp-fresh');
        fs.mkdirSync(fresh, { recursive: true });
        activatePack(fresh, 'mcp-pack');
        assert.equal(readActivation(fresh).active['mcp-pack'].mcp.created, true);
        assert.deepEqual(deactivatePack(fresh, 'mcp-pack').mcp.removed, ['tool', 'other']);
        assert.ok(!fs.existsSync(path.join(fresh, '.mcp.json')));
    });

    check('pack on again does not put back a pack entry the owner removed from .mcp.json; it is forgotten', () => {
        const proj = path.join(tmp, 'mcp-owner-removed');
        fs.mkdirSync(proj, { recursive: true });
        activatePack(proj, 'mcp-pack');
        const cfg = readMcp(proj);
        delete cfg.mcpServers.tool;
        fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify(cfg, null, 2));
        const r = activatePack(proj, 'mcp-pack');
        assert.deepEqual(r.mcp, { added: [], conflicts: [] });
        assert.deepEqual(Object.keys(readMcp(proj).mcpServers), ['other'], 'tool is not written again');
        assert.ok(r.notes.some(n => /no longer has tool/.test(n)), r.notes.join(' | '));
        assert.deepEqual(Object.keys(readActivation(proj).active['mcp-pack'].mcp.servers), ['other']);
        // pack off, then pack on, brings it back.
        deactivatePack(proj, 'mcp-pack');
        assert.deepEqual(activatePack(proj, 'mcp-pack').mcp.added, ['tool', 'other']);
    });

    check('pack off with an unreadable .mcp.json keeps the record of the pack\'s entries, so a later pack off removes them', () => {
        const proj = path.join(tmp, 'mcp-unreadable');
        fs.mkdirSync(proj, { recursive: true });
        activatePack(proj, 'mcp-pack');
        const good = fs.readFileSync(path.join(proj, '.mcp.json'), 'utf8');
        fs.writeFileSync(path.join(proj, '.mcp.json'), '{ half written');
        const r = deactivatePack(proj, 'mcp-pack');
        assert.deepEqual(r.mcp.removed, []);
        assert.ok(r.notes.some(n => /stays on record/.test(n)), r.notes.join(' | '));
        const kept = readActivation(proj).active['mcp-pack'];
        assert.deepEqual(Object.keys(kept.mcp.servers), ['tool', 'other']);
        assert.deepEqual(kept.placed, {}, 'the skills it removed are no longer recorded');
        fs.writeFileSync(path.join(proj, '.mcp.json'), good);
        assert.deepEqual(deactivatePack(proj, 'mcp-pack').mcp.removed, ['tool', 'other']);
        assert.equal(readActivation(proj).active['mcp-pack'], undefined);
    });

    // The packs PLUT_OS ships (packs/): upstream servers run with npx, one skill each, no upstream code.
    check('PLUT_OS ships codebase-memory and context-mode; each declares the MCP_CONFIGS command, Windows through cmd /c, and links upstream', () => {
        assert.equal(SHIPPED_PACKS_DIR, path.join(ROOT, 'packs'));
        assert.deepEqual(shippedPacks(), ['codebase-memory', 'context-mode']);
        for (const [id, server] of [['codebase-memory', 'codebase-memory-mcp'], ['context-mode', 'context-mode']]) {
            const record = JSON.parse(fs.readFileSync(path.join(ROOT, 'packs', id, 'skills.json'), 'utf8'));
            const decl = parsePackMcpServers(record.mcpServers)[server];
            assert.ok(decl, `${id} declares ${server}`);
            for (const platform of ['linux', 'darwin']) assert.deepEqual(resolvePackMcpEntry(decl, platform), MCP_CONFIGS[server], `${id} on ${platform}`);
            assert.deepEqual(resolvePackMcpEntry(decl, 'win32'), { command: 'cmd', args: ['/c', MCP_CONFIGS[server].command, ...MCP_CONFIGS[server].args] });
            assert.ok(decl.purpose, `${id} gives a purpose`);
            const skill = fs.readFileSync(path.join(ROOT, 'packs', id, 'skills', id, 'SKILL.md'), 'utf8');
            assert.equal(parseSkillFrontmatter(skill).name, id);
            assert.ok(skill.includes(record.homepage) && record.homepage.startsWith('https://github.com/'), `${id} links upstream`);
            const shipped = fs.readdirSync(path.join(ROOT, 'packs', id), { recursive: true }).filter(f => fs.statSync(path.join(ROOT, 'packs', id, f)).isFile());
            assert.deepEqual(shipped.map(f => f.split(path.sep).join('/')).sort(), ['skills.json', `skills/${id}/SKILL.md`], `${id} holds no upstream code`);
        }
        assert.ok(/session_start/.test(fs.readFileSync(path.join(ROOT, 'packs', 'context-mode', 'skills', 'context-mode', 'SKILL.md'), 'utf8')));
    });

    check('the recommended MCP cards name the pack that declares their server', () => {
        const withPack = RECOMMENDED_MCPS.filter(m => m.pack);
        assert.deepEqual(withPack.map(m => m.pack).sort(), ['codebase-memory', 'context-mode']);
        for (const m of withPack) {
            const record = JSON.parse(fs.readFileSync(path.join(ROOT, 'packs', m.pack, 'skills.json'), 'utf8'));
            assert.ok(Object.hasOwn(record.mcpServers, m.id), `${m.pack} declares ${m.id}`);
            assert.deepEqual(m.config, MCP_CONFIGS[m.id], 'the dashboard install path keeps its config');
        }
    });

    check('pack add takes a shipped pack by id without a path; an unknown bare id names the shipped ones', () => {
        const r = registerPack('codebase-memory');
        assert.equal(r.id, 'codebase-memory');
        assert.equal(r.path, fs.realpathSync(path.join(ROOT, 'packs', 'codebase-memory')));
        assert.deepEqual(r.mcpServers, ['codebase-memory-mcp']);
        assert.throws(() => registerPack('no-such-pack'), /not found: no-such-pack\. PLUT_OS ships codebase-memory, context-mode/);
        const out = cli(tmp, 'pack', 'add', 'context-mode');
        assert.equal(out.status, 0, out.stderr);
        assert.match(out.stdout, /Registered "Context Mode" \(context-mode\)/);
    });

    check('a folder of the same name in the working folder wins over the shipped pack', () => {
        const here = path.join(tmp, 'cwd-test');
        write(path.join(here, 'context-mode', 'skills.json'), JSON.stringify({ version: 1, id: 'local-context', name: 'Local' }));
        write(path.join(here, 'context-mode', 'skills', 'x', 'SKILL.md'), skillMd('x', 'local'));
        const out = cli(here, 'pack', 'add', 'context-mode');
        assert.equal(out.status, 0, out.stderr);
        assert.match(out.stdout, /\(local-context\)/);
        forgetPack('local-context');
    });

    check('a folder of the same name that is not a pack (an upstream clone) does not hide the shipped pack', () => {
        const here = path.join(tmp, 'cwd-clone');
        write(path.join(here, 'context-mode', 'README.md'), '# upstream clone\n');
        const out = cli(here, 'pack', 'add', 'context-mode');
        assert.equal(out.status, 0, out.stderr);
        assert.match(out.stdout, /Registered "Context Mode" \(context-mode\)/);
        assert.equal(listPacks().find(p => p.id === 'context-mode')?.path, fs.realpathSync(path.join(ROOT, 'packs', 'context-mode')));
    });

    check('a purpose must be a short string and never reaches .mcp.json', () => {
        assert.throws(() => parsePackMcpServers({ x: { command: 'x', purpose: 3 } }), /purpose/);
        assert.throws(() => parsePackMcpServers({ x: { command: 'x', purpose: 'p'.repeat(201) } }), /purpose/);
        assert.equal(resolvePackMcpEntry(parsePackMcpServers({ x: { command: 'x', purpose: 'why' } }).x).purpose, undefined);
    });

    check('activePackMcpServers lists each active pack\'s server still in .mcp.json, with its purpose; [] otherwise', () => {
        assert.deepEqual(activePackMcpServers(''), []);
        const proj = path.join(tmp, 'served');
        fs.mkdirSync(proj, { recursive: true });
        assert.deepEqual(activePackMcpServers(proj), [], 'no pack active');
        registerPack('codebase-memory');
        activatePack(proj, 'codebase-memory');
        activatePack(proj, 'mcp-pack');
        const list = activePackMcpServers(proj);
        assert.deepEqual(list.map(s => [s.pack, s.server]), [['codebase-memory', 'codebase-memory-mcp'], ['mcp-pack', 'other'], ['mcp-pack', 'tool']]);
        assert.match(list[0].purpose, /callers/);
        assert.equal(list[0].name, 'codebase-memory-mcp');
        assert.equal(list[0].description, list[0].purpose);
        assert.equal(list[1].purpose, '', 'a server without a purpose');
        const cfg = readMcp(proj);
        delete cfg.mcpServers.tool;
        fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify(cfg));
        assert.deepEqual(activePackMcpServers(proj).map(s => s.server), ['codebase-memory-mcp', 'other'], 'a server removed from .mcp.json is not offered');
        fs.writeFileSync(path.join(proj, '.mcp.json'), '{ broken');
        assert.equal(activePackMcpServers(proj).length, 3, 'an unreadable .mcp.json hides nothing');
        fs.rmSync(path.join(proj, '.mcp.json'));
        assert.deepEqual(activePackMcpServers(proj), [], 'no .mcp.json, no server');
    });
} finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`Skills: ${passed} passed, 0 failed`);
