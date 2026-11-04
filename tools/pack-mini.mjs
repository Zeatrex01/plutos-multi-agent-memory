#!/usr/bin/env node
// Packs PLUT_OS mini (mini/): the server-less project memory, with the shipped working agreement, the scope reader
// (lib/scope.mjs, the same file the full brief uses) and the project-scissors skill, into <outDir>/plutos-mini/ and
// plutos-mini-<date>.zip. Usage: node tools/pack-mini.mjs [outDir]   (default ./dist)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipFolder } from './zip-folder.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function packMini(outDir = path.join(root, 'dist'), { zip = true } = {}) {
    const dest = path.join(outDir, 'plutos-mini');
    fs.rmSync(dest, { recursive: true, force: true });
    const skill = path.join(dest, 'skills', 'plutos-mini');
    fs.mkdirSync(path.join(skill, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(skill, 'references'), { recursive: true });
    fs.copyFileSync(path.join(root, 'mini', 'SKILL.md'), path.join(skill, 'SKILL.md'));
    fs.copyFileSync(path.join(root, 'mini', 'plutos-mini.mjs'), path.join(skill, 'scripts', 'plutos-mini.mjs'));
    fs.copyFileSync(path.join(root, 'lib', 'scope.mjs'), path.join(skill, 'scripts', 'scope.mjs'));
    fs.copyFileSync(path.join(root, 'scaffold', 'WORKING_AGREEMENT.md'), path.join(skill, 'references', 'WORKING_AGREEMENT.md'));
    fs.cpSync(path.join(root, 'skills', 'project-scissors'), path.join(dest, 'skills', 'project-scissors'), { recursive: true });
    fs.copyFileSync(path.join(root, 'mini', 'README.md'), path.join(dest, 'README.md'));
    const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    fs.mkdirSync(path.join(dest, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(dest, '.claude-plugin', 'plugin.json'), `${JSON.stringify({ name: 'plutos-mini', version,
        description: 'PLUT_OS project memory without the server: session brief, session record, board and the scope skill, from one Node script.' }, null, 2)}\n`);
    const file = zip ? path.join(outDir, `plutos-mini-${new Date().toISOString().slice(0, 10)}.zip`) : null;
    if (zip) zipFolder(dest, file);
    return { dest, zip: file };
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) console.log(JSON.stringify(packMini(process.argv[2] ? path.resolve(process.argv[2]) : undefined), null, 2));
