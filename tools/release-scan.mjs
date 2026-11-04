#!/usr/bin/env node
// Prints what in a repository's tracked files would leak if it were published (lib/release-scan.mjs).
//
//   node tools/release-scan.mjs [--root <dir>] [--terms <file>] [--kinds personal,terms] [--limit 20] [--json]
//
// --terms names a local file with one term per line, for example the owner's other projects.
// Without it, <root>/.plutos/release-terms.txt is used if it exists; keep that file untracked.
// It only reports, and it always exits 0 unless the arguments are wrong.
import path from 'node:path';
import { RELEASE_KINDS, readTerms, releaseReport, scanRelease } from '../lib/release-scan.mjs';

const args = process.argv.slice(2);
const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (args.includes('--help')) {
    console.log('usage: node tools/release-scan.mjs [--root <dir>] [--terms <file>] [--kinds a,b] [--limit N] [--json]');
    process.exit(0);
}
const root = path.resolve(value('--root') || process.cwd());
const kinds = (value('--kinds') || RELEASE_KINDS.join(',')).split(',');
const unknown = kinds.filter(k => !RELEASE_KINDS.includes(k));
if (unknown.length) {
    console.error(`release-scan: unknown kind ${unknown.join(', ')}; the kinds are ${RELEASE_KINDS.join(', ')}`);
    process.exit(2);
}
const options = value('--terms') ? { terms: readTerms(path.resolve(value('--terms'))) } : {};
const findings = scanRelease(root, options).filter(f => kinds.includes(f.kind));
console.log(args.includes('--json') ? JSON.stringify(findings, null, 2) : releaseReport(findings, { limit: Number(value('--limit')) || 20 }));
