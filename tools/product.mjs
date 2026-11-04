// The product: what `npm run build` puts in dist/ (docs/PRODUCT.md). build.mjs and
// tools/product-test.mjs both read this file, so the release and its check cannot drift apart.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

// Copied beside the executable. A file git ignores never ships. A new file not yet added to git
// ships, so a build before a commit still works.
export const SHIPPED_DIRS = ['ui', 'browser-client', 'scaffold', 'lib'];
export const SHIPPED_FILES = ['LICENSE', 'AGENTS.md', 'package.json', 'cli.mjs', 'dashboard-ui.html', 'council.config.json', 'tools/council.mjs'];

/** The files under `dir` that git tracks or does not ignore and that exist, relative to `dir`. */
export function releaseFiles(dir) {
    const out = execFileSync('git', ['-C', dir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    return [...new Set(out.split('\0'))].filter(file => file && fs.existsSync(path.join(dir, file)));
}

export function copyReleaseFiles(from, to) {
    for (const file of releaseFiles(from)) {
        fs.mkdirSync(path.dirname(path.join(to, file)), { recursive: true });
        fs.copyFileSync(path.join(from, file), path.join(to, file));
    }
}

/** The source files, relative to `root`, whose text the build ships: the copied folders
 *  and files, and the two entry points the bundles start from (with the lib/ modules they
 *  import, already counted). */
export function shippedSources(root) {
    return [
        ...SHIPPED_DIRS.flatMap(dir => releaseFiles(path.join(root, dir)).map(file => `${dir}/${file}`)),
        ...SHIPPED_FILES, 'index.mjs', 'dashboard.mjs',
    ];
}

/** esbuild options for the two bundles, without `outfile`. The dashboard is CommonJS for the
 *  executable, so no module in it may use top-level await; the MCP server is ESM, run by the AI
 *  client's Node. Neither writes a source map. */
export function bundleOptions(root, { lite = false } = {}) {
    const common = { bundle: true, platform: 'node', absWorkingDir: root, metafile: true };
    return {
        // import.meta.url shim: the bundle is CJS, so rebuild the URL from __filename.
        // PLUTOS_PACKAGED=1 is baked in: lib/approot.mjs then resolves the app root as the exe's
        // own directory, and lib/entry.mjs knows no module in the bundle is a command.
        dashboard: {
            ...common, entryPoints: [path.join(root, 'dashboard.mjs')], format: 'cjs',
            // PLUTOS_LITE=1: the bundle runs under the machine's Node, so the app root is its own folder.
            define: { 'process.env.PLUTOS_PACKAGED': '"1"', 'import.meta.url': '__IMPORT_META_URL', ...(lite ? { 'process.env.PLUTOS_LITE': '"1"' } : {}) },
            banner: { js: 'const __IMPORT_META_URL = require("url").pathToFileURL(__filename).href;' },
        },
        mcp: {
            ...common, entryPoints: [path.join(root, 'index.mjs')], target: 'node22', format: 'esm',
            define: { 'process.env.PLUTOS_BUNDLED_MCP': '"1"' },
        },
    };
}

/** The npm packages esbuild put in the bundles, read from their metafiles (input paths relative
 *  to `root`): [{ name, version, license, text }], `text` being the package's licence file. */
export function bundledPackages(root, metafiles) {
    const dirs = new Set();
    for (const meta of metafiles) {
        for (const input of Object.keys(meta.inputs)) {
            const m = input.replace(/\\/g, '/').match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
            if (m) dirs.add(m[1]);
        }
    }
    return [...dirs].sort().map(dir => {
        const abs = path.resolve(root, dir);
        const pkg = JSON.parse(fs.readFileSync(path.join(abs, 'package.json'), 'utf8'));
        const file = fs.readdirSync(abs).find(f => /^(licen[cs]e|copying)(\.|-|$)/i.test(f));
        return { name: pkg.name, version: pkg.version, license: pkg.license, text: file ? fs.readFileSync(path.join(abs, file), 'utf8').trim() : null };
    });
}

/** THIRD_PARTY_NOTICES.txt: the licences MIT and its kind require every copy to carry, for the
 *  bundled packages and for the Node.js runtime the executable is a copy of. */
export function noticesText(packages, { nodeVersion = process.version, nodeLicense = findNodeLicense() } = {}) {
    const rule = '-'.repeat(72);
    return [
        'PLUT_OS is proprietary (LICENSE). It contains the third-party software below, each under its own licence.',
        '', rule, '',
        `Node.js ${nodeVersion}: the executable is a copy of the Node.js binary.`, '',
        nodeLicense ?? `Its licence: https://github.com/nodejs/node/blob/${nodeVersion}/LICENSE`,
        ...packages.flatMap(p => ['', rule, '', `${p.name} ${p.version} (${p.license}), bundled into index.mjs and the executable`, '',
            p.text ?? `The package carries no licence file; its package.json names ${p.license}.`]),
        '',
    ].join('\n');
}

// A Node.js tarball keeps LICENSE one folder above bin/; some installs keep it beside the binary.
function findNodeLicense() {
    const bin = path.dirname(process.execPath);
    for (const file of [path.join(bin, 'LICENSE'), path.join(bin, '..', 'LICENSE')]) {
        try { return fs.readFileSync(file, 'utf8').trim(); } catch { /* not in this install */ }
    }
    return null;
}

/** Where a build writes: the repository's dist/, or the folder PLUTOS_BUILD_OUT names when it lies under the
 *  system temp folder. Only a test sets it, so a test build never empties the owner's dist/ (cleanup plan P1-9). */
export function buildOutputDir(root, env = process.env) {
    const asked = env.PLUTOS_BUILD_OUT ? path.resolve(env.PLUTOS_BUILD_OUT) : '';
    const temp = path.resolve(os.tmpdir());
    return asked && asked.startsWith(temp + path.sep) ? asked : path.join(root, 'dist');
}
