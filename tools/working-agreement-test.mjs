#!/usr/bin/env node
// The working agreement reaches every session brief: the shipped default, replaced by the
// owner's own copy in the hub when that exists, and nothing at all when neither can be read.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-agreement-'));
process.env.PLUTOS_HOME = path.join(tmp, 'hub');
const { workingAgreement, AGREEMENT_FILE, projectProfilePath, PROFILE_MAX_CHARS } = await import('../lib/working-agreement.mjs');
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log(`  ok  ${name}`); };

try {
    const home = path.join(tmp, 'hub');
    fs.mkdirSync(home, { recursive: true });
    check('without an owner copy the shipped agreement is delivered, with where the owner copy goes', () => {
        const text = workingAgreement(home, ROOT);
        assert.match(text, /^\n\nWORKING AGREEMENT/);
        assert.match(text, /Ask again only before/);
        assert.ok(text.includes(path.join(home, AGREEMENT_FILE)));
    });
    check("the owner's copy in the hub replaces the shipped one", () => {
        fs.writeFileSync(path.join(home, AGREEMENT_FILE), 'WORKING AGREEMENT\n1. Reply in Turkish.\n');
        const text = workingAgreement(home, ROOT);
        assert.match(text, /Reply in Turkish/);
        assert.doesNotMatch(text, /Ask again only before/);
    });
    check("an owner's copy made before the scope rule still gets the scope rule in the brief, without editing the copy", () => {
        const text = workingAgreement(home, ROOT);
        assert.match(text, /Reply in Turkish[\s\S]*Scope before features \(project-scissors/);
        assert.equal(fs.readFileSync(path.join(home, AGREEMENT_FILE), 'utf8'), 'WORKING AGREEMENT\n1. Reply in Turkish.\n');
    });
    check('an empty owner copy falls back to the shipped one instead of silencing the rules', () => {
        fs.writeFileSync(path.join(home, AGREEMENT_FILE), '  \n');
        assert.match(workingAgreement(home, ROOT), /Ask again only before/);
    });
    check('nothing readable means no block, not an error', () => {
        assert.equal(workingAgreement(path.join(tmp, 'none'), path.join(tmp, 'none')), '');
    });
    const project = path.join(tmp, 'My Game');
    fs.mkdirSync(project);
    check('a project without a profile asks for one and names where the profile goes', () => {
        const text = workingAgreement(home, ROOT, project);
        assert.match(text, /No owner profile for this project yet: before this session ends, ask the owner/);
        assert.ok(text.includes(projectProfilePath(project, home)));
        assert.doesNotMatch(text, /OWNER PROFILE FOR THIS PROJECT/);
    });
    check('the profile path lives in the hub, one file per project folder', () => {
        const file = projectProfilePath(project, home);
        assert.equal(path.dirname(file), path.join(home, 'profiles'));
        assert.match(path.basename(file), /^My-Game-[0-9a-f]{10}\.md$/);
        assert.notEqual(file, projectProfilePath(path.join(tmp, 'other', 'My Game'), home));
    });
    check('a fresh profile is delivered without the reminder', () => {
        const file = projectProfilePath(project, home);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '# Owner profile: My Game\n- Wants phased releases\n');
        const text = workingAgreement(home, ROOT, project);
        assert.match(text, /OWNER PROFILE FOR THIS PROJECT[^\n]*\n# Owner profile: My Game\n- Wants phased releases/);
        assert.doesNotMatch(text, /ask the owner how they want to work/);
    });
    check('an old profile is delivered with a refresh reminder', () => {
        const file = projectProfilePath(project, home);
        const old = new Date(Date.now() - 40 * 86_400_000);
        fs.utimesSync(file, old, old);
        assert.match(workingAgreement(home, ROOT, project), /over 30 days old: before this session ends, ask the owner/);
    });
    check('a long profile is cut at the cap and says where the rest is', () => {
        const file = projectProfilePath(project, home);
        fs.writeFileSync(file, 'x'.repeat(PROFILE_MAX_CHARS + 500));
        const text = workingAgreement(home, ROOT, project);
        assert.match(text, /\[profile truncated; read the file for the rest\]/);
        assert.ok(!text.includes('x'.repeat(PROFILE_MAX_CHARS + 1)));
    });
    console.log(`Working agreement: ${checks} passed, 0 failed`);
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}
