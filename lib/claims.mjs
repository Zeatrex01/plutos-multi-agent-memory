// Claims against reality, without an AI: what a project's records say
// that the repository does not show. It reports and changes nothing.
//
//   missing-path   a path a document names, in backticks or as a relative link, that is not on disk
//   line-past-end  a `file:line` citation past the end of the file it cites
//   npm-script     an `npm run <name>` that package.json does not define
//   count          in PLUT_OS's own current documents, a number of test suites that is not the number
//                  tools/run-all-tests.mjs runs. Records of what happened (docs/handoff/: the boards,
//                  the session record) are left out: "all 65 suites passed" was true when written.
//   release        what would leak if the repository were published (lib/release-scan.mjs:
//                  personal information, secrets, source maps)
//   contract-unreviewed
//                  in a PLUT_OS checkout, a commit that changed a contract line (an MCP tool schema,
//                  a route, a route or tool policy entry, an approval tier) with no critique-seat
//                  result in the session record (lib/contract-check.mjs: the surface, the start
//                  commit, what counts as a record). The working tree is a note, not a finding.
//
// The records are the current documents: the root's and docs/'s markdown, the boards and the
// session record included. History is left out: CHANGELOG.md and IDEAS.md, docs/handoff/archive/
// and results/, and a dated document that carries the snapshot marker. A path a kit project has
// but this repository may not (.plutos/, .claude/, docs/handoff/, docs/ai/, …), a placeholder, a
// path whose folder is not here (another repository's), and a sentence that says the file went
// (removed, retired, moved, …) are not findings.
//
// A baseline holds the findings accepted on a given day, so old debt is listed without failing
// anything, and a new finding fails `plutos check`. Its keys carry no line numbers, so an edit
// above a finding does not make it new. PLUT_OS keeps its baseline tracked
// (tools/claims-baseline.json); another project keeps it in .plutos/.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BUDGETS, collectDocPaths, hygieneReport } from './hygiene.mjs';
import { APP_ROOT } from './approot.mjs';
import { scanRelease } from './release-scan.mjs';
import { isPlutosSource } from './run-mode.mjs';
import { CONTRACT_CHECK, contractFindings, contractNote } from './contract-check.mjs';

export const CLAIM_CHECKS = ['missing-path', 'line-past-end', 'npm-script', 'count', 'release', CONTRACT_CHECK];

const HISTORY_DOC = /^(?:CHANGELOG|IDEAS)\.md$|^docs\/handoff\/(?:archive|results)\//;
const SNAPSHOT_MARKER = '<!-- plutos:snapshot -->';
// docs/handoff is checked like any folder since 2026-11-04 (a cited report or archive must exist); the
// exceptions are the kit files that exist only in target projects, written on request or beside a
// foreign AGENTS.md, and the dated archive names.
// Kit paths that a project gains only through use (CONTINUITY.md and CONTEXT.json at the first session_end, archive/ and
// results/ when something is archived or written) are cited by the shipped docs and exist in a working
// project but not in a fresh kit or the published core: they are not checked for existence.
const KIT_PATH = /^(?:\.git|\.plutos|\.claude|\.cursor|\.codex|\.gemini|\.agents|\.vscode|\.studio|docs\/ai|docs\/boards|public)\/|^docs\/handoff\/(?:PLUTOS_PROTOCOL|PROJECT_INTERVIEW)\.md$|^docs\/handoff\/(?:CONTEXT\.json|CONTINUITY\.md)$|^docs\/handoff\/(?:archive|results)\/$|^docs\/handoff\/archive\/(?:SESSIONS|BOARD|CONTEXT)-/;
const PLACEHOLDER = /[<>*{}$[\]%…|]|\.\.\.|YYYY|(?:^|\/)(?:x|y|foo|bar|example|name|your[-_]?\w*)\.\w+$/i;
const GONE = /\b(?:removed|deleted|retired|replaced|renamed|moved|dropped|archived|gone|no longer|used to|formerly|legacy|old|was|were|until)\b/i;
const CITE = /^(.+\.\w{1,8}):(\d+)(?:-(\d+))?$/;
const RELEASE_KINDS = ['personal', 'secret', 'maps'];

// The number of suites `npm test` runs in a PLUT_OS checkout, read from its runner; null elsewhere.
function suiteCount(root) {
    if (!isPlutosSource(root)) return null;
    try {
        const list = fs.readFileSync(path.join(root, 'tools', 'run-all-tests.mjs'), 'utf8').match(/const suites = \[([\s\S]*?)\];/);
        return list ? (list[1].match(/'[^']+\.m?js'/g) || []).length : null;
    } catch { return null; }
}
const SUITES = /\b(\d+) (?:test )?suites\b/g;

/** The documents whose claims are checked, relative to the root. */
export function claimSources(root) {
    return collectDocPaths(root).filter(doc => !HISTORY_DOC.test(doc));
}

/** What a line names: backticked tokens and relative link targets, with the link flag. */
function named(line) {
    const out = [];
    for (const m of line.matchAll(/`([^`\s]+)`/g)) out.push({ raw: m[1], link: false });
    for (const m of line.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) out.push({ raw: m[1], link: true });
    return out;
}

/** Every finding in the root's current records: [{ check, file, line, token, text }]. */
export function findClaims(root, { checks = CLAIM_CHECKS } = {}) {
    const findings = [];
    const add = (check, file, line, token, text) => findings.push({ check, file, line, token, text: text.trim().slice(0, 160) });
    let scripts = {};
    try { scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts || {}; } catch { /* no package.json */ }
    const lineCounts = new Map();
    const linesIn = file => {
        if (!lineCounts.has(file)) {
            let n = null;
            try { n = fs.readFileSync(file, 'utf8').split('\n').length; } catch { /* unreadable */ }
            lineCounts.set(file, n);
        }
        return lineCounts.get(file);
    };
    const inRoot = p => { const rel = path.relative(root, p); return !rel.startsWith('..') && !path.isAbsolute(rel); };

    const missing = [];
    const suites = checks.includes('count') ? suiteCount(root) : null;
    for (const doc of claimSources(root)) {
        let text;
        try { text = fs.readFileSync(path.join(root, doc), 'utf8'); } catch { continue; }
        if (text.split(/\r?\n/, 12).some(l => l.includes(SNAPSHOT_MARKER))) continue;
        const dir = path.dirname(path.join(root, doc));
        text.split(/\r?\n/).forEach((line, i) => {
            for (const { raw: token, link } of named(line)) {
                const cite = token.replace(/^\.\//, '').match(CITE);
                const rel = cite ? cite[1] : token.replace(/^\.\//, '');
                if (PLACEHOLDER.test(rel) || /^[a-z][a-z0-9+.-]*:/i.test(rel) || /^[/~-]/.test(rel) || KIT_PATH.test(rel)) continue;
                // A path, not a word: a folder in it, and a file name or a folder of its own (`a/b/`).
                if (!link && (!/[^/]\/[^/]/.test(rel) || !/\.\w{1,8}$|\/$/.test(rel))) continue;
                // A link resolves from the document; a backticked path from the root, or the document.
                const candidates = (link ? [path.resolve(dir, rel)] : [path.join(root, rel), path.resolve(dir, rel)]).filter(inRoot);
                const at = candidates.find(p => fs.existsSync(p));
                if (!at) {
                    const folderHere = candidates.some(p => fs.existsSync(path.dirname(p.replace(/[\\/]+$/, ''))));
                    if (checks.includes('missing-path') && folderHere && !GONE.test(line)) missing.push({ doc, line: i + 1, rel, text: line });
                    continue;
                }
                if (cite && checks.includes('line-past-end')) {
                    const lines = linesIn(at);
                    if (lines && Number(cite[3] || cite[2]) > lines) add('line-past-end', doc, i + 1, token, line);
                }
            }
            if (checks.includes('npm-script')) {
                for (const m of line.matchAll(/`npm run ([\w:.-]+)/g)) if (!scripts[m[1]]) add('npm-script', doc, i + 1, m[1], line);
            }
            if (suites !== null && !doc.startsWith('docs/handoff/') && !GONE.test(line)) {
                for (const m of line.matchAll(SUITES)) if (Number(m[1]) !== suites) add('count', doc, i + 1, `${m[1]} suites (runs ${suites})`, line);
            }
        });
    }
    // A path git ignores is generated or machine-local (dist/, a data folder): named, not missing.
    for (const m of withoutIgnored(root, missing)) add('missing-path', m.doc, m.line, m.rel, m.text);
    if (checks.includes('release')) {
        let release = [];
        try { release = scanRelease(root); } catch { /* not a git repository: nothing is tracked */ }
        for (const f of release.filter(f => RELEASE_KINDS.includes(f.kind))) add('release', f.file, f.line, f.kind, f.text);
    }
    if (checks.includes(CONTRACT_CHECK)) findings.push(...contractFindings(root));
    return findings;
}

function withoutIgnored(root, missing) {
    if (!missing.length) return missing;
    let ignored = '';
    try {
        ignored = execFileSync('git', ['check-ignore', '--no-index', '--stdin'], { cwd: root, encoding: 'utf8', windowsHide: true,
            input: [...new Set(missing.map(m => m.rel))].join('\n'), stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (error) { ignored = error.stdout || ''; }   // exit 1: none ignored
    const set = new Set(ignored.split(/\r?\n/).filter(Boolean));
    return missing.filter(m => !set.has(m.rel));
}

const keyOf = f => `${f.check}|${f.file}|${f.token}`;

export function baselinePath(root) {
    return isPlutosSource(root) ? path.join(root, 'tools', 'claims-baseline.json') : path.join(root, '.plutos', 'claims-baseline.json');
}

export function readBaseline(root) {
    try { return new Set(JSON.parse(fs.readFileSync(baselinePath(root), 'utf8')).accepted || []); } catch { return new Set(); }
}

/** Accept today's findings: the baseline becomes exactly what is found now. */
export function acceptClaims(root, findings) {
    const file = baselinePath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const accepted = [...new Set(findings.map(keyOf))].sort();
    fs.writeFileSync(file, JSON.stringify({ acceptedAt: new Date().toISOString().slice(0, 10), accepted }, null, 2) + '\n');
    return accepted.length;
}

/** The findings split by the baseline: `fresh` fail a check, `known` are accepted debt, and
 *  `fixed` counts baseline entries no longer found (accepting again drops them). `notes` fail
 *  nothing: the working tree's contract changes, reported at the next commit. */
export function checkClaimsAgainstBaseline(root, options) {
    const findings = findClaims(root, options);
    const baseline = readBaseline(root);
    const found = new Set(findings.map(keyOf));
    const note = (options?.checks || CLAIM_CHECKS).includes(CONTRACT_CHECK) ? contractNote(root) : null;
    return {
        fresh: findings.filter(f => !baseline.has(keyOf(f))),
        known: findings.filter(f => baseline.has(keyOf(f))),
        fixed: [...baseline].filter(k => !found.has(k)).length,
        notes: note ? [note] : []
    };
}

/** Plain text: per check, the findings with `file:line`, then the notes and the totals. */
export function claimsReport({ fresh, known, fixed, notes = [] }, { all = false, limit = 30 } = {}) {
    const shown = all ? [...fresh, ...known] : fresh;
    const lines = [];
    for (const check of CLAIM_CHECKS) {
        const own = shown.filter(f => f.check === check);
        if (!own.length) continue;
        lines.push(`${check}: ${own.length}`);
        for (const f of own.slice(0, limit)) lines.push(`  ${f.file}:${f.line}  ${f.check === CONTRACT_CHECK ? f.text : `${f.token}${f.check === 'release' ? `  ${f.text}` : ''}`}`);
        if (own.length > limit) lines.push(`  … ${own.length - limit} more`);
    }
    for (const n of notes) lines.push(`note: ${n}`);
    lines.push(`${fresh.length} new finding(s); ${known.length} accepted in the baseline${fixed ? `; ${fixed} accepted one(s) no longer found` : ''}.`);
    return lines.join('\n');
}

// --- Weight -----------------------------------------------------------------------------
// What a session in this project carries, against the limit each part has: `plutos check --weight`.
// The kit's figures are what npm test last measured on a fresh kit project (tools/token-budget.json).

/** [{ name, value, unit, limit?, note?, over }] */
export async function projectWeight(root) {
    const { sessionBriefParts } = await import('./session-brief.mjs');
    const { hookBrief, HOOK_TEXT_CAP } = await import('./project-hooks.mjs');
    const rows = [];
    try {
        const { budgets, measuredAt } = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'tools', 'token-budget.json'), 'utf8'));
        for (const [name, value] of Object.entries(budgets)) rows.push({ name: `kit ${name}`, value, unit: 'tokens', note: `measured by npm test, ${measuredAt}` });
    } catch { /* an install without the tools folder */ }
    const brief = hookBrief(sessionBriefParts(root, 'Claude Code', { writes: false }));
    rows.push({ name: 'session brief', value: brief.length, unit: 'characters', limit: HOOK_TEXT_CAP,
        note: brief.includes('Cut to fit') ? 'the hook cuts its context' : 'Claude Code\'s hook limit' });
    const bytes = file => { try { return fs.statSync(path.join(root, file)).size; } catch { return null; } };
    if (bytes('AGENTS.md') != null) rows.push({ name: 'AGENTS.md', value: bytes('AGENTS.md'), unit: 'bytes', limit: 32 * 1024, note: 'what Codex reads by default' });
    if (bytes('CLAUDE.md') != null) rows.push({ name: 'CLAUDE.md', value: bytes('CLAUDE.md'), unit: 'bytes' });
    const hygiene = hygieneReport(root);
    for (const board of hygiene.boards.filter(b => b.exists)) rows.push({ name: board.name, value: board.active, unit: 'active entries', limit: BUDGETS.activeEntries });
    rows.push({ name: 'results/', value: hygiene.inventory.results.files, unit: 'reports', limit: BUDGETS.resultsFiles });
    return rows.map(row => ({ ...row, over: row.limit != null && row.value > row.limit }));
}

export function weightReport(rows) {
    const width = Math.max(...rows.map(r => r.name.length));
    return rows.map(r => `${r.over ? '!' : ' '} ${r.name.padEnd(width)}  ${r.value.toLocaleString('en-US')} ${r.unit}`
        + `${r.limit != null ? ` of ${r.limit.toLocaleString('en-US')}` : ''}${r.note ? ` (${r.note})` : ''}`).join('\n')
        + (rows.some(r => r.over) ? '\n! over its limit' : '');
}
