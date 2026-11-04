// Open-source readiness without an AI: what in a repository's tracked files would leak if the
// repository were published. It reports and changes
// nothing; the cleanup is a separate step (P4).
//
// Five kinds of finding:
// - personal: e-mail addresses and home-folder paths (C:\Users\<name>, /Users/<name>, /home/<name>);
// - secret: strings shaped like API keys, tokens and private keys;
// - terms: the names in a local terms file, one per line. The default file is
//   .plutos/release-terms.txt, which is not tracked: a list of the owner's other projects must not
//   itself be published;
// - maps: tracked source maps and `sourceMappingURL` comments;
// - turkish: lines with ğ, ş, ı or İ, letters other languages rarely use.
//
// Only tracked files count, because only they would be published. Binary files and files over
// 5 MB are skipped.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const RELEASE_KINDS = ['personal', 'secret', 'terms', 'maps', 'turkish'];

const MAX_BYTES = 5 * 1024 * 1024;
// Not followed by more of an expression: `world@mesh.vertices[i]` is Python's matrix product, not mail.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w[(]|\.\w)/g;
// Addresses that name nobody: documentation placeholders, the domains RFC 2606 reserves for tests
// and examples, no-reply senders, git's SSH remotes, and a file name after an `@` (`@AGENTS.md`, an
// import line; `Hero@Kick.fbx`, an animation take; `icon@2x.png`).
const PLACEHOLDER_EMAIL = /^(noreply@|no-reply@|git@)|@(?:[\w-]+\.)*example\.(com|org|net)$|\.(test|example|invalid|localhost|local)$|@users\.noreply\.github\.com$|\.(?:md|mjs|cjs|js|json|ts|py|txt|html|css|fbx|glb|gltf|blend|obj|png|jpe?g|gif|svg|webp|wav|mp3|ogg)$/i;
const HOME = /(?:\b[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}|(?<![\w.-])\/(?:Users|home)\/)([A-Za-z0-9._-]+)/g;
// Path segments that stand for "some user" in docs and tests rather than naming one (`user` is also
// the account name of the cloud containers PLUT_OS is developed in).
const PLACEHOLDER_USER = /^(<.*|\$.*|%.*|you|your|yourname|username|user-?name|user|owner|name|someone|example|me|o|pc|test|runner|\.\.\.)$/i;
const SECRET = /\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const TURKISH = /[ğĞşŞıİ]/u;
// Built at run time, so this file's own source is not a finding.
const MAP_COMMENT = ['sourceMapping', 'URL='].join('');

/** The tracked files of a repository, relative to its root. */
function trackedFiles(root) {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    return out.split('\0').filter(Boolean);
}

function readText(file) {
    let stat;
    try { stat = fs.statSync(file); } catch { return null; }
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    const bytes = fs.readFileSync(file);
    if (bytes.subarray(0, 8192).includes(0)) return null;
    return bytes.toString('utf8');
}

/** One term per line; blank lines and lines starting with # are ignored. */
export function readTerms(file) {
    try {
        return fs.readFileSync(file, 'utf8').split(/\r?\n/).map(t => t.trim()).filter(t => t && !t.startsWith('#'));
    } catch { return []; }
}

/** Every finding in the tracked files of `root`, or in `files` (paths relative to it): [{ kind,
 *  file, line, text }]. `terms` defaults to the root's untracked .plutos/release-terms.txt. */
export function scanRelease(root, { terms = readTerms(path.join(root, '.plutos', 'release-terms.txt')), files = trackedFiles(root) } = {}) {
    const termPatterns = terms.map(term => ({ term, re: new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }));
    const findings = [];
    const add = (kind, file, line, text) => findings.push({ kind, file, line, text: text.trim().slice(0, 160) });
    for (const file of files) {
        if (/\.map$/i.test(file)) add('maps', file, 0, 'source map file');
        const content = readText(path.join(root, file));
        if (content === null) continue;
        content.split(/\r?\n/).forEach((text, i) => {
            const line = i + 1;
            for (const [address] of text.matchAll(EMAIL)) if (!PLACEHOLDER_EMAIL.test(address)) add('personal', file, line, text);
            for (const match of text.matchAll(HOME)) if (!PLACEHOLDER_USER.test(match[1])) add('personal', file, line, text);
            if (text.match(SECRET)) add('secret', file, line, text);
            for (const { re } of termPatterns) if (re.test(text)) { add('terms', file, line, text); break; }
            if (text.includes(MAP_COMMENT)) add('maps', file, line, text);
            if (TURKISH.test(text)) add('turkish', file, line, text);
        });
    }
    // One line can hold two addresses or paths; report it once per kind.
    const seen = new Set();
    return findings.filter(f => { const key = `${f.kind}\0${f.file}\0${f.line}`; return seen.has(key) ? false : seen.add(key); });
}

/** A plain-text report: per kind, the total, the number of files, and the first `limit` findings. */
export function releaseReport(findings, { limit = 20 } = {}) {
    const lines = [];
    for (const kind of RELEASE_KINDS) {
        const own = findings.filter(f => f.kind === kind);
        const files = new Set(own.map(f => f.file));
        lines.push(`${kind}: ${own.length} finding(s) in ${files.size} file(s)`);
        for (const f of own.slice(0, limit)) lines.push(`  ${f.file}${f.line ? `:${f.line}` : ''}  ${f.text}`);
        if (own.length > limit) lines.push(`  … ${own.length - limit} more`);
    }
    return lines.join('\n');
}
