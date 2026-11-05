#!/usr/bin/env node
// The design page (lib/design.mjs): a project with a user interface gets one Design line in the brief and its
// DESIGN.md named first for UI tasks; a project without one, or a game project, gets nothing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hasUserInterface, readDesign, designBriefLines, designForTask, resetDesignCache, DESIGN_TEMPLATE, DESIGN_SKILL } from '../lib/design.mjs';
import { buildBrief } from '../lib/continuity.mjs';
import { taskContext, resetTaskContextCache } from '../lib/task-context.mjs';

let passed = 0;
const check = (name, fn) => { resetDesignCache(); fn(); passed++; console.log(`  ok  ${name}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-design-'));
const project = (name, files) => {
    const dir = path.join(tmp, name);
    for (const [rel, body] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), body);
    }
    return dir;
};
const PAGE = `# DESIGN.md
Updated: 2026-11-01

## The project (sources)
- Warehouse staff on shared tablets (README.md:3)

## Tokens
\`\`\`
color.bg: #f7f5f0
color.text: rgb(17, 17, 17)
font.body: "Source Serif 4"
\`\`\`

## Decisions
- 2026-11-01 · dense tables, no cards · counts are scanned, not read · Claude
- 2026-11-02 · amber only for stock below minimum · one alarm colour · Codex
`;
try {
    const cli = project('cli', { 'index.mjs': 'console.log(1)\n', 'node_modules/x/a.css': 'a{}' });
    const web = project('web', { 'index.html': '<h1>Hi</h1>\n', 'src/app.css': 'h1{color:#7c3aed}\n', 'src/parser.mjs': 'export const parse = s => s;\n' });
    const game = project('game', { 'project.godot': '[application]\n', 'ui/menu.html': '<p></p>\n' });

    check('the template and the design skill ship with PLUT_OS; the skill carries the start checks', () => {
        assert.ok(fs.existsSync(DESIGN_TEMPLATE));
        assert.ok(fs.existsSync(DESIGN_SKILL));
        const checks = fs.readFileSync(path.join(path.dirname(DESIGN_SKILL), 'references', 'start-checks.md'), 'utf8');
        assert.equal((checks.match(/^C\d+\s/gm) || []).length, 15);
        assert.ok(fs.statSync(DESIGN_SKILL).size < 20000);
    });
    check('no UI files: no UI, no brief line (a CSS file inside node_modules does not count)', () => {
        assert.equal(hasUserInterface(cli), false);
        assert.deepEqual(designBriefLines(cli), []);
    });
    check('a game project is left to its own visual-direction flow, also with Godot in a subfolder', () => {
        assert.equal(hasUserInterface(game), false);
        const nested = project('nested', { 'proto/godot/project.godot': '', 'proto/web/index.html': '<p></p>' });
        assert.equal(hasUserInterface(nested), false);
    });
    check('in a git repository, a first page counts before its first commit', () => {
        const fresh = project('fresh', { 'README.md': '' });
        execFileSync('git', ['init', '-q'], { cwd: fresh });
        assert.equal(hasUserInterface(fresh), false);
        resetDesignCache();
        fs.writeFileSync(path.join(fresh, 'index.html'), '<p></p>');
        assert.equal(hasUserInterface(fresh), true);
    });
    check('docs sites, test fixtures, coverage and dot-folders are not the project\'s UI', () => {
        const lib = project('lib', { 'src/parse.py': '', 'docs/_static/custom.css': 'a{}', 'tests/fixtures/a.html': '<p>', 'htmlcov/index.html': '', '.venv/x/y.html': '', 'Build/app.css': '' });
        assert.equal(hasUserInterface(lib), false);
    });
    check('UI and no DESIGN.md: one line asking for it before the first UI change, with the template', () => {
        assert.equal(hasUserInterface(web), true);
        const text = designBriefLines(web).join('\n');
        assert.match(text, /No `docs\/ai\/DESIGN\.md`: before the first UI change/);
        assert.ok(text.includes('DESIGN-template.md'));
        assert.ok(text.includes('design-ui-direction/SKILL.md'));
    });
    fs.mkdirSync(path.join(web, 'docs', 'ai'), { recursive: true });
    fs.writeFileSync(path.join(web, 'docs', 'ai', 'DESIGN.md'), PAGE);
    check('a DESIGN.md is read leniently: date, tokens, decisions', () => {
        const d = readDesign(web);
        assert.equal(d.updated, '2026-11-01');
        assert.deepEqual(d.tokens.map(t => t.name), ['color.bg', 'color.text', 'font.body']);
        assert.equal(d.decisions, 2);
        assert.equal(d.template, false);
        assert.match(designBriefLines(web).join('\n'), /`docs\/ai\/DESIGN\.md` \(updated 2026-11-01, 3 token\(s\), 2 decision\(s\)\): follow it/);
    });
    check('a page without a Tokens block reads as no tokens, not as an error', () => {
        const odd = project('odd', { 'a.html': '<p></p>', 'docs/ai/DESIGN.md': '# DESIGN.md\n## Direction\nCalm.\n' });
        assert.deepEqual(readDesign(odd), { updated: '', tokens: [], decisions: 0, picks: 0, template: true });
    });
    check('an unfilled template copied in is named as the template, not as a page to follow', () => {
        const raw = project('raw', { 'a.html': '<p></p>', 'docs/ai/DESIGN.md': fs.readFileSync(DESIGN_TEMPLATE, 'utf8') });
        assert.equal(readDesign(raw).template, true);
        assert.match(designBriefLines(raw).join('\n'), /is still the unfilled template/);
    });
    check('owner picks are counted and named first in the brief line', () => {
        const picked = project('picked', { 'a.html': '<p></p>', 'docs/ai/DESIGN.md': PAGE + '\n## Owner picks\n- 2026-11-05 · Today · A dense list / B one card · picked B · "less text" · one framed card\n' });
        assert.equal(readDesign(picked).picks, 1);
        assert.match(designBriefLines(picked).join('\n'), /1 owner pick\(s\), follow them first/);
    });
    check('a DESIGN.md without UI files yet still gets its line', () => {
        const early = project('early', { 'README.md': '', 'docs/ai/DESIGN.md': PAGE });
        assert.match(designBriefLines(early).join('\n'), /follow it for UI work/);
    });
    check('UI task gets the Design line; a parser, an HTTP header or a form validator does not', () => {
        assert.match(designForTask(web, 'make the stock screen denser'), /^Design: docs\/ai\/DESIGN\.md: if this task changes the UI/);
        assert.match(designForTask(web, 'arayüzdeki butonu düzelt'), /^Design: docs\/ai\/DESIGN\.md/);
        assert.equal(designForTask(web, 'fix the CSV parser', ['src/parser.mjs']), null);
        assert.equal(designForTask(web, 'add an HTTP header to the API'), null);
        assert.equal(designForTask(web, 'add a form field validator', ['src/parser.mjs']), null);
        assert.match(designForTask(web, 'fix the parser', ['src/app.css']), /^Design: docs\/ai\/DESIGN\.md/);
        assert.match(designForTask(cli, 'make the screen denser'), /^Design: no filled docs\/ai\/DESIGN\.md yet: if this task changes the UI, write it first/);
        assert.equal(designForTask(game, 'make the menu screen calmer'), null);
    });
    check('plutos_context_for_task puts the Design line in its head for UI work', () => {
        resetTaskContextCache();
        const r = taskContext(web, 'make the header layout calmer');
        assert.match(r.text, /^Design: docs\/ai\/DESIGN\.md: if this task changes the UI, read it first/m);
    });
    check('the brief of a project without a UI carries no Design section', () => {
        assert.doesNotMatch(buildBrief(cli), /## Design/);
        assert.match(buildBrief(web), /## Design/);
    });
    console.log(`design: ${passed} passed`);
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}
