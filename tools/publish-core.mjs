#!/usr/bin/env node
// Publishes PLUT_OS's core from this repository, the owner's working copy, to the main repository
// (the cleanest, most core version goes to the main repository; the working repository stays the owner's own, where every change is
// tested and cleaned first).
//
// It copies every tracked file except this repository's working records and the owner's own
// documents (PRIVATE), deletes from the target what this repository no longer ships, and never
// touches the target's own files (TARGET_OWN: its clean board templates and its CI). Before it
// writes anything, the release scan (lib/release-scan.mjs) must find no personal path, e-mail
// address, secret, source map or listed term in the files it would copy. It only writes files:
// committing and pushing the target are separate, visible steps.
//
//   node tools/publish-core.mjs <target checkout> [--source <dir>] [--dry-run] [--json]
//
// Exit 0: published, or nothing to change. Exit 1: refused (a scan finding, a dirty target, the
// target is the source). Exit 2: wrong usage.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanRelease } from '../lib/release-scan.mjs';

// The working records and the owner's own documents: they describe this repository's work, not
// the product. A folder entry ends in '/'.
export const PRIVATE = [
    'docs/handoff/', 'docs/evals/', 'docs/research/', 'docs/ai/', '.claude/', '.studio/', 'graphify-out/',
    'MVP.md', 'IDEAS.md', 'CLAUDE.md', 'CHANGELOG.md', 'docs/IMPROVEMENTS.md', 'docs/BRANCHING.md',
    'docs/RELEASE-NOTES-next.md', // the owner's own to-do list and the records it cites
    'SCOPE.md', // this repository's own queue and appetite, not the product's
    'ARCHITECTURE.md', 'docs/architecture/', 'tools/architecture-docs-test.mjs', // the internals reference a rebuild starts from (not published)
    'tools/public-repo/', // the seeds of the target's own files, copied only where the target has none
    'tools/memory-probes.json', 'tools/memory-probes-heldout.json', 'tools/memory-probes-third.json', // probes keyed to this repository's record ids
];
// Files the main repository keeps as its own: clean board templates in place of the working
// records, and its own CI (it runs on every push there; the working copy is tested locally). A new,
// empty target gets them from tools/public-repo/ (same paths); an existing one is never overwritten.
export const TARGET_OWN = [
    'docs/handoff/BOARD.md', 'docs/handoff/AGENT_BOARD.md', 'docs/handoff/ROSTER.md', 'docs/handoff/CONTINUITY.md',
    '.github/workflows/ci.yml',
];
// A finding of these kinds stops the publish. Turkish lines are expected (the Turkish UI strings).
const BLOCKING = ['personal', 'secret', 'maps', 'terms'];
// The author's own name is not a leak where the product names its author: the licence, the
// About box and its links, and the main repository's own address (the clone line, the server's link).
// Minified vendor files only match a term by chance.
export const ATTRIBUTION = f => f.kind === 'terms' && (f.file === 'LICENSE' || f.file === 'NOTICE' || (f.file === 'package.json' && /"author"/.test(f.text)) || f.file.startsWith('ui/vendor/')
    || /settings_about_desc|youtube\.com\/c\/Zeatrex\/|github\.com\/Zeatrex01"|github\.com\/Zeatrex01\/(?:Plut-os|plutos-multi-agent-memory)\b/.test(f.text));

const SEEDS = 'tools/public-repo';
const isPrivate = file => PRIVATE.some(p => p.endsWith('/') ? file.startsWith(p) : file === p);
const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const tracked = root => git(root, ['ls-files', '-z']).split('\0').filter(Boolean);

/** What publishing would copy and remove, without writing anything. */
export function planPublish(source, target) {
    const own = new Set(TARGET_OWN);
    const copy = tracked(source).filter(f => !isPrivate(f) && !own.has(f));
    const shipped = new Set(copy);
    const remove = tracked(target).filter(f => !shipped.has(f) && !own.has(f));
    const changed = copy.filter(f => {
        const to = path.join(target, f);
        return !fs.existsSync(to) || !fs.readFileSync(to).equals(fs.readFileSync(path.join(source, f)));
    });
    const seed = TARGET_OWN.filter(f => !fs.existsSync(path.join(target, f)) && fs.existsSync(path.join(source, SEEDS, f)));
    return { copy, changed, remove, seed };
}

export function publishCore({ source, target, dryRun = false }) {
    if (path.resolve(source) === path.resolve(target)) return { ok: false, reason: 'the target is the source repository' };
    if (git(target, ['status', '--porcelain']).trim()) return { ok: false, reason: `the target has uncommitted changes: commit or discard them first (${target})` };
    const plan = planPublish(source, target);
    const findings = scanRelease(source, { files: [...plan.changed, ...plan.seed.map(f => `${SEEDS}/${f}`)] }).filter(f => BLOCKING.includes(f.kind) && !ATTRIBUTION(f));
    if (findings.length) return { ok: false, reason: 'the release scan found something that must not be published', findings, ...plan };
    if (!dryRun) {
        for (const f of plan.changed) {
            const from = path.join(source, f), to = path.join(target, f);
            fs.mkdirSync(path.dirname(to), { recursive: true });
            fs.copyFileSync(from, to);
            fs.chmodSync(to, fs.statSync(from).mode & 0o777);
        }
        for (const f of plan.seed) {
            fs.mkdirSync(path.dirname(path.join(target, f)), { recursive: true });
            fs.copyFileSync(path.join(source, SEEDS, f), path.join(target, f));
        }
        for (const f of plan.remove) {
            fs.rmSync(path.join(target, f), { force: true });
            // Drop folders the removal left empty, up to the target's root.
            for (let dir = path.dirname(path.join(target, f)); dir !== path.resolve(target) && fs.existsSync(dir) && !fs.readdirSync(dir).length; dir = path.dirname(dir)) fs.rmdirSync(dir);
        }
    }
    return { ok: true, dryRun, changed: plan.changed, removed: plan.remove, seeded: plan.seed, unchanged: plan.copy.length - plan.changed.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
    const target = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--source');
    if (args.includes('--help') || !target) {
        console.log('usage: node tools/publish-core.mjs <target checkout> [--source <dir>] [--dry-run] [--json]');
        process.exit(args.includes('--help') ? 0 : 2);
    }
    const source = path.resolve(value('--source') || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
    if (!fs.existsSync(path.join(path.resolve(target), '.git'))) {
        console.error(`publish-core: ${target} is not a git checkout`);
        process.exit(2);
    }
    const result = publishCore({ source, target: path.resolve(target), dryRun: args.includes('--dry-run') });
    if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else if (!result.ok) {
        console.error(`publish-core: refused: ${result.reason}`);
        for (const f of result.findings || []) console.error(`  ${f.kind} ${f.file}:${f.line}  ${f.text}`);
    } else {
        console.log(`${result.dryRun ? 'would publish' : 'published'}: ${result.changed.length} changed, ${result.removed.length} removed, ${result.seeded.length} seeded, ${result.unchanged} unchanged`);
        for (const f of result.seeded) console.log(`  * ${f}`);
        for (const f of result.changed) console.log(`  + ${f}`);
        for (const f of result.removed) console.log(`  - ${f}`);
    }
    process.exit(result.ok ? 0 : 1);
}
