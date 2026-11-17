// Open-source readiness without an AI: what in a repository's tracked files would leak if the
// repository were published. It reports and changes
// nothing; the cleanup is a separate step (P4).
//
// Five kinds of finding:
// - personal: e-mail addresses and home-folder paths (C:\Users\<name>, /Users/<name>, /home/<name>);
//   an address on a line that sets a form field's placeholder is a sample, not a finding;
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
// A form field's sample value (`placeholder="dealer@firm.com"`, `placeholder: '…'`) names nobody. Only
// that value is exempt, not the line (a minified file holds real addresses beside it) and not the local
// part (a real address can start with any word).
const PLACEHOLDER_FIELD = /placeholder["']?\s*[=:]\s*["']([^"']+)["']/gi;
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
            const samples = new Set();
            for (const [, value] of text.matchAll(PLACEHOLDER_FIELD)) for (const [address] of value.matchAll(EMAIL)) samples.add(address);
            for (const [address] of text.matchAll(EMAIL)) if (!samples.has(address) && !PLACEHOLDER_EMAIL.test(address)) add('personal', file, line, text);
            for (const match of text.matchAll(HOME)) if (!PLACEHOLDER_USER.test(match[1])) add('personal', file, line, text);
            if (text.match(SECRET)) add('secret', file, line, text);
            // Every term on the line, so an exemption for one (tools/publish-core.mjs ATTRIBUTION) leaves the others found.
            const onLine = termPatterns.filter(({ re }) => re.test(text)).map(({ term }) => term);
            if (onLine.length) findings.push({ kind: 'terms', file, line, text: text.trim().slice(0, 160), terms: onLine });
            if (text.includes(MAP_COMMENT)) add('maps', file, line, text);
            if (TURKISH.test(text)) add('turkish', file, line, text);
        });
    }
    // One line can hold two addresses or paths; report it once per kind.
    const seen = new Set();
    return findings.filter(f => { const key = `${f.kind}\0${f.file}\0${f.line}`; return seen.has(key) ? false : seen.add(key); });
}

// The scrub has its own, wider pattern set. The scan above blocks a publish, so it must stay narrow
// (a false positive stops a release); the scrub only rewrites an AI's free text before it leaves the
// machine's private context, where an over-match costs a word and a miss leaks a name or a key.
// Home folders: any letters (the `u` flag: accented and non-Latin names), names with spaces when a
// separator follows, any prefix (WSL /mnt/c/Users/<name>, /var/home/<name>, //server/home/<name>),
// UNC \\server\share\<name>, and ~<name>. Doubled backslashes are a JSON- or source-escaped path.
const NAME = String.raw`(?:[\p{L}\p{M}\p{N}._$-]+(?: [\p{L}\p{M}\p{N}._$-]+)+(?=[\\/])|[\p{L}\p{M}\p{N}._$-]+)`;
const SEP = String.raw`(?:\\{1,2}|/{1,2})`;
const SCRUB_HOME = [
    new RegExp(String.raw`(?<![\p{L}\p{N}~])~[\p{L}\p{M}\p{N}._-]+(?=[\\/])`, 'gu'),
    new RegExp(String.raw`\b[A-Za-z]:${SEP}(?:Users|Documents and Settings)${SEP}${NAME}`, 'giu'),
    new RegExp(String.raw`(?:/{1,2}[\p{L}\p{M}\p{N}._-]+)*/(?:Users|home)/${NAME}`, 'gu'),
    new RegExp(String.raw`\\{2,4}\p{L}[\p{L}\p{M}\p{N}._-]+(?:\\{1,2}|/)[\p{L}\p{M}\p{N}._$ -]+?(?:\\{1,2}|/)${NAME}`, 'gu')
];
// Secrets the scan does not block on, scrub only. Each entry: [pattern, replacement].
const SCRUB_SECRET = [
    // scheme://user:pass@host keeps the scheme and the host: `postgres://<secret>@db:5432`.
    [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1<secret>@'],
    [/https?:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9/_-]+/gi, '<secret>'],
    [/https?:\/\/(?:[\w-]+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/gi, '<secret>'],
    [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, '<secret>'],
    [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g, '$1 <secret>'],
    [/\b(?:gh[opsur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{30,}|hf_[A-Za-z0-9]{30,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|xox[a-z]-[A-Za-z0-9-]{10,})\b/g, '<secret>'],
    // key=value and key: value for the words that name a credential; the key stays, the value goes.
    [/\b((?:[A-Za-z0-9]+[_-])*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)["']?\s*[:=]\s*)(["']?)[^\s"'&,;]{3,}\2/gi, '$1$2<secret>$2']
];

/** The text with personal strings replaced: a home folder becomes `~` and keeps its rest
 *  (`/home/<name>/x` → `~/x`), an e-mail address becomes `<email>`, a secret-shaped string
 *  `<secret>` (the scan's kinds plus the scrub-only set above: more token prefixes, JWTs, Bearer
 *  values, `password=…`-style values, chat webhooks, and the credentials in `scheme://user:pass@`).
 *  Used where an AI's free text leaves the machine's private context (the feedback lines,
 *  lib/feedback.mjs). Placeholders are scrubbed too: the writer cannot tell. */
export function scrubPersonal(text) {
    let s = String(text ?? '');
    for (const [re, to] of SCRUB_SECRET) s = s.replace(re, to);
    s = s.replace(SECRET, '<secret>');
    for (const re of SCRUB_HOME) s = s.replace(re, '~');
    return s.replace(EMAIL, '<email>');
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
