// The critique gate (SCOPE.md queue item 1; owner, 2026-11-04: a critique seat caught two breaks in
// P2-1 and three in P2-2): a commit that changes a contract — an MCP tool's schema, an HTTP route, a
// route or tool policy entry, an approval tier rule — with no critique-seat result in the session
// record is a `contract-unreviewed` finding of `plutos check`, so a contract change is reviewed
// before it ships (the push). It reads git and the record, runs no AI and changes nothing.
//
// The contract surface (CONTRACT_SURFACE): the files, and the lines in them that define a contract.
//   index.mjs, lib/code-tools.mjs, lib/admin-tools.mjs, lib/research/mcp.mjs, lib/drawers.mjs
//                             a tool's `name: "` (or `'`), `inputSchema`, `required:`, `enum:` and
//                             `description: "` (TOOLS, CODE_TOOLS, ADMIN_TOOLS, RESEARCH_TOOLS,
//                             DRAWERS and plutos_modules); in index.mjs also the server's
//                             `instructions:` string
//   dashboard.mjs, lib/*-routes.mjs, lib/research/routes.mjs
//                             a route key: `'GET /…':`, `'POST /…':`, `'DELETE /…':`
//   lib/route-policy.mjs      the entries of the route sets (PROJECT_READ_ROUTES,
//                             PROJECT_WRITE_ROUTES, PROJECT_PAGE_ROUTES)
//   lib/tool-policy.mjs       the entries of TOOL_ACCESS
//   lib/approvals.mjs         a code line naming a tier (approvalTier, tierAllows)
// A `description:` counts only with a string literal after it, so handler code such as
// `description: args?.description` is not a contract line; a line that is only a comment never
// is; dist/ and dist-research-mcp/ are builds, not the surface. lib/approval-effects.mjs holds no
// rule today (a comment and a null) and is left out.
//
// What is judged: committed history only. Every commit after the one that added this file
// (`git log --diff-filter=A -- lib/contract-check.mjs`, exclusive: the gate's start) that adds or
// removes a contract line (`git diff -U0 c^ c`; `-` lines count, a removed route is the most
// breaking change). One finding per file per commit, keyed `contract-unreviewed|<file>|<short sha>`
// in the baseline, so `--accept` mutes one commit and never a route or a tool for good. The working
// tree is a note, never a finding: it would be reported at the next commit unless session_end names
// a critique seat first.
//
// What covers a commit c — exactly, and only session blocks (docs/handoff/CONTINUITY.md and
// docs/handoff/archive/SESSIONS-*.md). A council room is machine-local and git-ignored, so it is
// not evidence; nothing is read from commit messages or inferred from the diff.
//   (a) a block whose HEAD is c's first parent and whose Did or Story names a critique seat with a
//       count. session_end writes the block before the commit that carries it, so a block's HEAD
//       is that commit's parent: the block carried by c covers c.
//   (b) a block whose Did names a critique seat with a count and c's sha (seven or more hex
//       digits): how a change already shipped gets its review on record afterwards.
// The working tree is covered by such a block whose HEAD is the current HEAD (a block no commit
// carries yet). A critique mention is `critique seat` (or `critique-seat`) followed in the same
// sentence by a lead-in (`found`, `:`, `(` or `first:`), a count (digits, or a number word from one
// to twenty) and `items`, `findings` or `blockers`: "A critique seat found 17 items", "Critique
// seat: 21 items", "found three blockers first", "with a critique seat (24 findings;". A plan ("the
// critique gate in plutos check", "Critique office") does not match, and only Did and Story are
// read, never the digest, Decided or Next.
//
// The blind spot, by design: the gate checks that a record exists, not that the critique was good;
// a change committed and recorded in the same session with a critique mention passes.
//
// Nothing here throws. No git, no commits, a detached HEAD, a start commit not in this history or a
// block HEAD that no longer resolves (rewritten history) give no finding, and the check runs only in
// a PLUT_OS checkout (isPlutosSource): a kit project has no contract files. It also judges only a
// repository that keeps the session record: a published copy ships the clean template with no session.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HEADER_RE, FIELD_RE, findBlocks } from './board.mjs';
import { isPlutosSource } from './run-mode.mjs';

export const CONTRACT_CHECK = 'contract-unreviewed';
const SELF = 'lib/contract-check.mjs';

const TOOL_LINE = /^\s*name: ["']|\binputSchema\b|\brequired:|\benum:|\bdescription: ["']/;
const ROUTE_KEY = /^\s*['"](?:GET|POST|DELETE) \//;
/** [{ file: string | RegExp, what, line: RegExp }]: a changed line in `file` matching `line` is a contract change. */
export const CONTRACT_SURFACE = [
    { file: 'index.mjs', what: 'MCP tool schema', line: new RegExp(`${TOOL_LINE.source}|^\\s*instructions: [\`"']`) },
    { file: /^lib\/(?:code-tools|admin-tools|drawers|research\/mcp)\.mjs$/, what: 'MCP tool schema', line: TOOL_LINE },
    { file: /^(?:dashboard|lib\/[\w-]+-routes|lib\/research\/routes)\.mjs$/, what: 'HTTP route', line: ROUTE_KEY },
    { file: 'lib/route-policy.mjs', what: 'route policy', line: new RegExp(`${ROUTE_KEY.source}|_ROUTES = new Set\\(`) },
    { file: 'lib/tool-policy.mjs', what: 'tool access', line: /^\s*\w+: ['"]\w+['"],?\s*$/ },
    { file: 'lib/approvals.mjs', what: 'approval tier', line: /\btier|Tier\b/ }
];
const PATHSPEC = ['index.mjs', 'dashboard.mjs', 'lib'];
const COMMENT = /^\s*\/\//;

const COUNT = '(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)';
/** A critique-seat result with its count, in one sentence of a Did or Story field. */
export const CRITIQUE_MENTION = new RegExp(`critique[- ]seat\\b[^.;]*?(?:found|:|\\(|first:)\\s*${COUNT}\\s+(?:items?|findings?|blockers?)\\b`, 'i');

export const contractHint = (file, sha) => `a contract line changed in ${file} at ${sha}; run a critique seat on the diff and name it with its count in session_end's did (or in a later did with the sha)`;

const git = (dir, args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
const tryGit = (dir, args) => { try { return git(dir, args); } catch { return null; } };

const ruleFor = file => CONTRACT_SURFACE.find(r => typeof r.file === 'string' ? r.file === file : r.file.test(file)) || null;
const isContract = (rule, line) => !COMMENT.test(line) && rule.line.test(line);

/** The first contract line each file gains or loses in `git diff -U0 <args>`: Map file → { line, text }. */
function changedContractLines(root, args) {
    const out = new Map();
    const text = tryGit(root, ['diff', '-U0', '--no-color', ...args, '--', ...PATHSPEC]);
    if (!text) return out;
    let file = '', old = '', rule = null, lineNo = 0;
    for (const raw of text.split('\n')) {
        if (raw.startsWith('--- ')) { old = raw.replace(/^--- (?:a\/)?/, ''); continue; }
        if (raw.startsWith('+++ ')) {
            file = raw.replace(/^\+\+\+ (?:b\/)?/, '');
            if (file === '/dev/null') file = old;   // a deleted file: its name is on the --- line
            rule = ruleFor(file);
            continue;
        }
        if (raw.startsWith('@@')) { lineNo = Number((raw.match(/\+(\d+)/) || [])[1]) || 0; continue; }
        if (!rule || raw.startsWith('\\')) continue;
        const changed = raw.startsWith('+') || raw.startsWith('-');
        if (changed && !out.has(file) && isContract(rule, raw.slice(1))) out.set(file, { line: Math.max(lineNo, 1), text: raw.slice(1).trim(), what: rule.what });
        if (raw.startsWith('+')) lineNo++;
    }
    return out;
}

// --- The record -----------------------------------------------------------------------------

/** Session blocks in the live record and the archives: [{ time, fields }], the shape parseContinuity gives. */
export function sessionBlocks(root) {
    const files = [path.join(root, 'docs', 'handoff', 'CONTINUITY.md')];
    const archive = path.join(root, 'docs', 'handoff', 'archive');
    try { for (const f of fs.readdirSync(archive)) if (/^SESSIONS-.*\.md$/.test(f)) files.push(path.join(archive, f)); } catch { /* no archive */ }
    const blocks = [];
    for (const file of files) {
        let text;
        try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
        const lines = text.split(/\r?\n/);
        for (const block of findBlocks(lines)) {
            const m = lines[block.start].match(HEADER_RE);
            if (!m) continue;
            const fields = {};
            for (const line of lines.slice(block.start + 1, block.end)) {
                const f = line.match(FIELD_RE);
                if (f) fields[f[1].replace(/:$/, '').trim()] = f[2].trim();
            }
            blocks.push({ time: m[1].trim(), fields });
        }
    }
    return blocks;
}

const mentionsCritique = b => CRITIQUE_MENTION.test(`${b.fields.Did || ''} ${b.fields.Story || ''}`);
const sameCommit = (a, b) => { a = String(a || '').trim(); b = String(b || '').trim(); return a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a)); };
const namesSha = (text, sha) => (String(text || '').match(/\b[0-9a-f]{7,40}\b/g) || []).some(t => sha.startsWith(t));

/** Whether a block with a critique-seat result covers commit `sha` (its first parent is `parent`). */
function covered(blocks, sha, parent) {
    return blocks.some(b => (parent && sameCommit(b.fields.HEAD, parent)) || namesSha(b.fields.Did, sha));
}

// --- The check ------------------------------------------------------------------------------

/** The commit that introduced the gate here, or null: the oldest commit that added this file. */
function startCommit(root) {
    const added = (tryGit(root, ['log', '--diff-filter=A', '--format=%H', '--', SELF]) || '').split('\n').filter(Boolean);
    return added.length ? added[added.length - 1] : null;
}

/** Committed contract changes after the gate's start with no critique-seat result in the record:
 *  [{ check, file, line, token: <short sha>, text: hint }]. */
export function contractFindings(root) {
    if (!isPlutosSource(root) || !tryGit(root, ['symbolic-ref', '-q', 'HEAD'])) return [];
    const start = startCommit(root);
    if (!start) return [];
    const commits = (tryGit(root, ['rev-list', '--reverse', '--parents', `${start}..HEAD`]) || '').split('\n').filter(Boolean);
    if (!commits.length) return [];
    // The gate judges a repository that keeps the session record. A published copy ships the clean
    // template with no session, so its contract changes are reviewed where its pull requests are.
    const blocks = sessionBlocks(root);
    if (!blocks.length) return [];
    const record = blocks.filter(mentionsCritique);
    const findings = [];
    for (const row of commits) {
        const [sha, parent] = row.split(' ');
        if (!parent) continue;   // a root commit has nothing to diff against
        const changes = changedContractLines(root, [parent, sha]);
        if (!changes.size || covered(record, sha, parent)) continue;
        const short = sha.slice(0, 7);
        for (const [file, hit] of changes) findings.push({ check: CONTRACT_CHECK, file, line: hit.line, token: short, text: contractHint(file, short) });
    }
    return findings;
}

/** The working tree's contract changes as one note, or null: reported at the next commit unless a
 *  block whose HEAD is the current HEAD names a critique seat. */
export function contractNote(root) {
    if (!isPlutosSource(root)) return null;
    const head = tryGit(root, ['rev-parse', '--verify', '-q', 'HEAD']);
    if (!head) return null;
    const changes = changedContractLines(root, ['HEAD']);
    if (!changes.size) return null;
    if (!sessionBlocks(root).length) return null;
    if (sessionBlocks(root).some(b => mentionsCritique(b) && sameCommit(b.fields.HEAD, head))) return null;
    const where = [...changes].map(([file, hit]) => `${file}:${hit.line}`).join(', ');
    return `contract lines changed in the working tree (${where}): would be reported at the next commit unless session_end names a critique seat with its count`;
}
