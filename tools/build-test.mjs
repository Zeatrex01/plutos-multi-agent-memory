#!/usr/bin/env node
// Test for the portable build. Separate from tools/smoke-test.mjs: it tests packaging, not the product.
//
// Usage: node tools/build-test.mjs
//
// The exe build is deliberately NOT run here: it copies a ~125 MB Node binary and takes the better
// part of a minute. The lite package (one esbuild bundle, seconds) is built to the end in a temp
// folder; the rest is everything that could be wrong without anyone noticing: the shipped list,
// the branding order, the committed icons and the byte-level PE patch that could otherwise ship a
// corrupted executable.
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { markGuiSubsystem, readSubsystem, SUBSYSTEM_GUI, SUBSYSTEM_CUI } from './pe-subsystem.mjs';
import { createBrandSvg, createWindowsIcon, ICON_SIZES, readIconSizes } from './plutos-icon.mjs';
import { SHIPPED_DIRS, SHIPPED_FILES } from './product.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-build-'));
// A temp output folder, so a test build never empties the repository's own dist/.
const OUT = path.join(tmpRoot, 'dist');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
    if (cond) { passed++; console.log(`  ✅ ${name}`); }
    else { failed++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

const dirSize = dir => fs.readdirSync(dir, { withFileTypes: true })
    .reduce((n, e) => n + (e.isDirectory() ? dirSize(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);

try {
    console.log('\nPLUT_OS build test\n');

    // 1. What build.mjs ships and in which order it brands the exe.
    const buildSource = fs.readFileSync(path.join(ROOT, 'build.mjs'), 'utf8');
    // The shipped list is tools/product.mjs (docs/PRODUCT.md); build.mjs copies from it.
    check('portable build ships clean scaffold, not live handoff state',
        SHIPPED_DIRS.includes('scaffold') && buildSource.includes('for (const dir of SHIPPED_DIRS)')
        && ![...SHIPPED_DIRS, ...SHIPPED_FILES].some(item => item.startsWith('docs')));
    check('Windows builds brand before injection and verify the finished executable',
        buildSource.indexOf('brandWindowsExecutable(') < buildSource.indexOf("'NODE_SEA_BLOB'")
        && buildSource.indexOf('assertWindowsBrand(exePath)') > buildSource.indexOf("'NODE_SEA_BLOB'"));
    const bat = fs.readFileSync(path.join(ROOT, 'BUILD_PLUT_OS.bat'), 'utf8');
    check('BUILD_PLUT_OS.bat builds in the terminal: it runs build.mjs and opens no page',
        /node build\.mjs/.test(bat) && !/buildtool|start http|localhost/i.test(bat));

    // 2. The committed artwork. The SVG is the human-editable mark; the ICO is its deterministic,
    //    multi-resolution Windows form. Both are checked against the generator so stale artwork
    //    can never pass review and then ship from build.mjs.
    const assetRoot = path.join(ROOT, 'assets');
    const committedSvg = fs.readFileSync(path.join(assetRoot, 'plutos-mark.svg'), 'utf8');
    const committedIco = fs.readFileSync(path.join(assetRoot, 'plutos.ico'));
    check('the committed SVG matches the canonical mark', committedSvg === createBrandSvg() + '\n');
    check('the committed ICO matches its deterministic generator', committedIco.equals(createWindowsIcon()));
    check('the Windows icon contains every Explorer size',
        JSON.stringify(readIconSizes(committedIco)) === JSON.stringify(ICON_SIZES),
        readIconSizes(committedIco).join(', '));

    // 3. The lite package, built to the end: the folder it leaves is what an owner copies to a
    //    machine that has Node.
    const lite = spawnSync(process.execPath, [path.join(ROOT, 'build.mjs'), '--lite'], {
        cwd: ROOT, encoding: 'utf8', timeout: 120000, env: { ...process.env, PLUTOS_BUILD_OUT: OUT }
    });
    check('a lite build finishes', lite.status === 0 && /Done →/.test(lite.stdout), (lite.stderr || lite.stdout || '').trim().split('\n').slice(-2).join(' | '));
    check('it prints its steps in the terminal', /\[1\/5\][\s\S]*\[5\/5\]/.test(lite.stdout));
    check('it leaves the bundle and both launchers, and no exe',
        ['PLUT_OS.cjs', 'START_PLUT_OS.bat', 'start-plutos.sh', 'index.mjs', 'ui'].every(f => fs.existsSync(path.join(OUT, f)))
        && !fs.existsSync(path.join(OUT, 'PLUT_OS')) && !fs.existsSync(path.join(OUT, 'PLUT_OS.exe')));
    check('the lite package stays small', fs.existsSync(OUT) && dirSize(OUT) < 20 * 1048576, fs.existsSync(OUT) ? String(dirSize(OUT)) : 'no output');
    check('the repository\'s own dist/ was not touched', !fs.existsSync(path.join(ROOT, 'dist', 'PLUT_OS.cjs')) || fs.statSync(path.join(ROOT, 'dist', 'PLUT_OS.cjs')).mtimeMs < Date.now() - 120000);

    // 4. The PE subsystem patch. Windows decides whether to attach a console window from one
    //    16-bit header field; flipping it is what lets the packaged app open without a
    //    terminal. Exercised against a synthetic header so the byte arithmetic is verified on
    //    every platform, not only Windows.
    const fakePe = (magic = 0x20b, subsystem = SUBSYSTEM_CUI) => {
        const peOffset = 0x80;
        const buf = Buffer.alloc(peOffset + 24 + 96);
        buf.writeUInt32LE(peOffset, 0x3c);
        buf.writeUInt32LE(0x00004550, peOffset);            // "PE\0\0"
        buf.writeUInt16LE(magic, peOffset + 24);
        buf.writeUInt16LE(subsystem, peOffset + 24 + 68);
        return buf;
    };
    const peFile = path.join(tmpRoot, 'fake.exe');
    const write = (buf) => { fs.writeFileSync(peFile, buf); return peFile; };

    check('a console binary is flipped to windowless',
        markGuiSubsystem(write(fakePe())) === 'patched'
        && readSubsystem(fs.readFileSync(peFile)) === SUBSYSTEM_GUI);
    check('patching is idempotent', markGuiSubsystem(peFile) === 'already-gui');
    // Only that one field may move — everything around it is executable code.
    {
        const before = fakePe();
        const original = fs.readFileSync(write(Buffer.from(before)));
        markGuiSubsystem(peFile);
        const patched = fs.readFileSync(peFile);
        const differing = [...patched].reduce((n, byte, i) => n + (byte !== original[i] ? 1 : 0), 0);
        check('exactly one byte changes', differing === 1 && patched.length === before.length, String(differing));
    }
    check('PE32 (32-bit) headers use the same field offset',
        markGuiSubsystem(write(fakePe(0x10b))) === 'patched');
    // Refusing beats guessing: this writes into an executable, and a corrupted binary is far
    // worse than a visible console window.
    const refuses = (buf) => {
        try { markGuiSubsystem(write(buf)); return false; } catch (e) { return true; }
    };
    check('a non-PE file is refused, not patched', refuses(Buffer.alloc(4096)));
    check('a truncated file is refused', refuses(Buffer.alloc(8)));
    check('an unknown optional-header magic is refused', refuses(fakePe(0xdead)));
    check('an unexpected subsystem value is refused', refuses(fakePe(0x20b, 9)));
} catch (e) {
    failed++;
    console.log(`\n  ❌ fatal: ${e.message}`);
} finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    console.log(failed
        ? `\n❌ BUILD FAIL — ${passed} passed, ${failed} failed\n`
        : `\n✅ BUILD PASS — ${passed} passed, 0 failed\n`);
    process.exit(failed ? 1 : 0);
}
