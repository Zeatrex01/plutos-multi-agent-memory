// npm run build → dist/ : a portable folder with the PLUT_OS app (Node SEA, so the dashboard
// needs no Node on the target machine) plus the runtime assets (ui/, scaffold/, templates)
// the server reads from the folder next to it.
//
// The MCP server remains a separate Node entrypoint because AI clients spawn stdio servers,
// but esbuild bundles its runtime dependencies into dist/index.mjs. The exe removes the Node
// requirement for the dashboard; the MCP bridge still runs through the AI client's Node.
//
// Flags:
//   --windowed   Windows only: mark the exe as a GUI binary so double-clicking opens no
//                console window. Output goes to the stable per-user logs/plutos.log instead.
//   --console    keep the console window (the default, and the fallback if --windowed
//                misbehaves on a given machine).
//   --lite       no exe: the dashboard is one bundled file (PLUT_OS.cjs) run by the machine's
//                Node 22+, which the MCP server, the hooks and the CLI need anyway. About 4 MB
//                instead of about 125 MB; START_PLUT_OS.bat and start-plutos.sh launch it.
//
// The exe is a copy of the RUNNING Node binary, so a build always targets the platform it
// runs on: building on Linux produces a Linux binary, not a Windows one.
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { build } from 'esbuild';
import { markGuiSubsystem } from './tools/pe-subsystem.mjs';
import { createBrandSvg, createWindowsIcon } from './tools/plutos-icon.mjs';
import { assertWindowsBrand, brandWindowsExecutable } from './tools/windows-exe-brand.mjs';
import { SHIPPED_DIRS, SHIPPED_FILES, copyReleaseFiles, bundleOptions, bundledPackages, noticesText, buildOutputDir } from './tools/product.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = buildOutputDir(ROOT);
const BUILD = path.join(DIST, '_build');
const IS_WINDOWS = process.platform === 'win32';
const LITE = process.argv.includes('--lite');
const WINDOWED = !LITE && IS_WINDOWS && process.argv.includes('--windowed');
const EXE_NAME = LITE ? 'PLUT_OS.cjs' : IS_WINDOWS ? 'PLUT_OS.exe' : 'PLUT_OS';
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const ICON_FILE = path.join(ROOT, 'assets', 'plutos.ico');
const MARK_FILE = path.join(ROOT, 'assets', 'plutos-mark.svg');

console.log('[1/5] clean dist/');
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(BUILD, { recursive: true });

console.log('[2/5] bundle dashboard + MCP runtime (esbuild)');
// The MCP still runs under the AI client's Node process, but all npm runtime dependencies are
// bundled into dist/index.mjs. A copied portable folder therefore does not depend on a parent
// checkout's node_modules or require `npm install` after extraction. Options: tools/product.mjs.
const bundles = bundleOptions(ROOT, { lite: LITE });
const dashboardBundle = await build({ ...bundles.dashboard, outfile: LITE ? path.join(DIST, EXE_NAME) : path.join(BUILD, 'server.cjs') });
const mcpBundle = await build({ ...bundles.mcp, outfile: path.join(DIST, 'index.mjs') });

const exePath = path.join(DIST, EXE_NAME);
if (LITE) {
    console.log('[3/5] lite: no exe; the dashboard runs under this machine\'s Node');
    fs.writeFileSync(path.join(DIST, 'START_PLUT_OS.bat'), [
        '@echo off', 'cd /d "%~dp0"',
        'where node >nul 2>nul', 'if errorlevel 1 (', '    echo PLUT_OS lite needs Node.js 22 or newer: https://nodejs.org', '    pause', '    exit /b 1', ')',
        'node "%~dp0PLUT_OS.cjs" %*', ''
    ].join('\r\n'));
    fs.writeFileSync(path.join(DIST, 'start-plutos.sh'), '#!/bin/sh\ncd "$(dirname "$0")"\ncommand -v node >/dev/null 2>&1 || { echo "PLUT_OS lite needs Node.js 22 or newer: https://nodejs.org"; exit 1; }\nexec node ./PLUT_OS.cjs "$@"\n', { mode: 0o755 });
} else {
    console.log('[3/5] build SEA blob + inject into a copy of node.exe');
    const seaConfig = path.join(BUILD, 'sea-config.json');
    const blob = path.join(BUILD, 'sea-prep.blob');
    fs.writeFileSync(seaConfig, JSON.stringify({
        main: path.join(BUILD, 'server.cjs'),
        output: blob,
        disableExperimentalSEAWarning: true
    }, null, 2));
    execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

    if (IS_WINDOWS) {
        // Assets are committed so the icon has an obvious home, but generated deterministically
        // so an old .ico can never silently ship after the mark changes.
        const expectedIcon = createWindowsIcon();
        const expectedMark = createBrandSvg() + '\n';
        if (!fs.existsSync(ICON_FILE) || !fs.readFileSync(ICON_FILE).equals(expectedIcon)) {
            throw new Error('assets/plutos.ico is stale or missing; run `node tools/plutos-icon.mjs`');
        }
        if (!fs.existsSync(MARK_FILE) || fs.readFileSync(MARK_FILE, 'utf8') !== expectedMark) {
            throw new Error('assets/plutos-mark.svg is stale or missing; run `node tools/plutos-icon.mjs`');
        }
        const branded = brandWindowsExecutable(process.execPath, exePath, {
            iconFile: ICON_FILE,
            version: PACKAGE.version
        });
        console.log(`       Windows resources: PLUT_OS icon (${branded.iconSizes.join(', ')} px) + metadata`);
    } else {
        fs.copyFileSync(process.execPath, exePath);
    }
    execFileSync(process.execPath, [
        path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js'),
        exePath, 'NODE_SEA_BLOB', blob,
        '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
    ], { stdio: 'inherit' });
    if (!IS_WINDOWS) fs.chmodSync(exePath, 0o755);

    if (IS_WINDOWS) {
        // postject adds NODE_SEA_BLOB after branding. Read the finished PE back and prove its icon
        // and metadata survived; success output must mean the actual artifact is branded.
        assertWindowsBrand(exePath);
    }

    if (WINDOWED) {
        // Fail the build rather than shipping a binary whose header we could not verify — the
        // user's fallback is one flag away, and a corrupted exe is not recoverable by them.
        try {
            console.log(`       --windowed: ${markGuiSubsystem(exePath)} (no console window)`);
        } catch (e) {
            throw new Error(`--windowed failed: ${e.message}. Rebuild with --console.`);
        }
    }
}

console.log('[4/5] copy runtime assets next to the exe');
// What ships is defined in tools/product.mjs and docs/PRODUCT.md; a file git ignores is not copied.
for (const dir of SHIPPED_DIRS) copyReleaseFiles(path.join(ROOT, dir), path.join(DIST, dir));
for (const file of SHIPPED_FILES) {
    fs.mkdirSync(path.dirname(path.join(DIST, file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(DIST, file));
}
fs.writeFileSync(path.join(DIST, 'THIRD_PARTY_NOTICES.txt'), noticesText(bundledPackages(ROOT, [dashboardBundle.metafile, mcpBundle.metafile])));
fs.writeFileSync(path.join(DIST, 'README.txt'), [
    ...(LITE ? [
        'PLUT_OS lite — portable PC app without an exe. Copy this whole folder.',
        '',
        'Needs Node.js 22 or newer (the MCP server, the hooks and the CLI need it anyway).',
        'Run START_PLUT_OS.bat on Windows or ./start-plutos.sh elsewhere. It opens your browser at',
        'http://localhost:3040 by itself. Launching it again while it is already running just reopens',
        'that window rather than reporting an error.',
    ] : [
    'PLUT_OS — portable PC app. Copy this whole folder. Double-click the binary.',
    '',
    `Run ${EXE_NAME}. It opens your browser at http://localhost:3040 by itself —`,
    'no Node.js required for the dashboard. Launching it again while it is already',
    'running just reopens that window rather than reporting an error.',
    ]),
    '',
    'Workspace registrations and other machine data are stored in the operating system user-data folder,',
    'not beside this executable. Moving or rebuilding this folder does not erase the project list.',
    `Each launch writes its log under that stable data folder${WINDOWED ? ' (the only output a windowless build has)' : ''}.`,
    '',
    LITE ? null : WINDOWED
        ? 'This build is windowless: no console window appears. If it fails to start on your'
        : 'This build keeps its console window. Rebuild with --windowed to remove it.',
    WINDOWED ? 'machine, read logs/plutos.log under the stable user-data folder, or rebuild with --console.' : null,
    '',
    'The MCP server (index.mjs) is bundled with its runtime dependencies. It still runs under',
    'Node.js through the connected AI client, but this folder needs no npm install after copying.',
    '',
    'Without an AI: node cli.mjs report <project> writes a status report, node cli.mjs check <project>',
    'lists what its records name that the repository does not hold.',
    '',
    'LICENSE: PLUT_OS is proprietary. THIRD_PARTY_NOTICES.txt: the licences of the software inside it.',
    '',
    'Optional browser client: open browser-client/index.html with the local app running.',
    'The same browser-client folder is an unpacked Chrome extension; installation is owner-controlled.',
    'It embeds the existing loopback UI and does not relay project data to a remote server.',
    ''
].filter(line => line !== null).join('\r\n'));

console.log('[5/5] cleanup');
fs.rmSync(BUILD, { recursive: true, force: true });

console.log(`\nDone → ${exePath}`);
