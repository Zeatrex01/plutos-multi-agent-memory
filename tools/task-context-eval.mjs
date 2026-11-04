// Measures plutos_context_for_task against a repository's own history: for each recent
// commit, the commit subject is the task, the code files it changed are the answer, and the
// ranking runs on the tree as it stood before that commit. Prints recall and precision at 5 and
// at the default list size, the MRR and the top-1 hit, with and without the graph step, so a
// tuning change shows its effect.
//
//   node tools/task-context-eval.mjs [repo] [--commits 60] [--max 12]
//
// recall@k: the share of the changed files in the top k. precision@k: the share of the top k that
// are changed files (divided by k, so a commit with fewer changed files than k cannot reach 1).
// MRR: the mean of 1 / rank of the first changed file within the top MAX (0 when none is there).
// top-1: the first file is a changed file.
//
// Read-only for the repository: each parent tree is checked out into a temporary worktree
// that is removed afterwards. It never prunes worktrees (that is repository-wide); a commit
// without a parent is skipped.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { buildTaskIndex, parseTask, rankFiles } from '../lib/task-context.mjs';
import { CODE_EXTS } from '../lib/graphify.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : dflt; };
const repo = path.resolve(args.find((a, i) => !a.startsWith('--') && !String(args[i - 1]).startsWith('--')) || '.');
const COMMITS = opt('--commits', 60), MAX = opt('--max', 12);
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const isCode = f => CODE_EXTS.includes(path.extname(f).toLowerCase());
const log = git('log', '--no-merges', '--format=%H%x09%s', `-n`, String(COMMITS * 3)).trim().split('\n');
const cases = [];
for (const line of log) {
    const [sha, subject] = line.split('\t');
    const changed = git('diff-tree', '--no-commit-id', '--name-only', '-r', '--diff-filter=M', sha).trim().split('\n').filter(f => f && isCode(f));
    if (changed.length < 1 || changed.length > 10) continue;
    cases.push({ sha, subject, changed });
    if (cases.length >= COMMITS) break;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-tc-eval-'));
const ARMS = [['graph', true], ['lexical', false]];
const totals = Object.fromEntries(ARMS.map(([name]) => [name, { r5: 0, rN: 0, p5: 0, pN: 0, rr: 0, top1: 0 }]));
let n = 0;
try {
    for (const c of cases) {
        const wt = path.join(tmp, c.sha.slice(0, 10));
        try { git('worktree', 'add', '--detach', '--quiet', wt, `${c.sha}^`); } catch (e) { continue; }
        try {
            const index = buildTaskIndex(wt);
            const truth = c.changed.filter(f => index.files.includes(f));
            if (!truth.length) continue;
            n++;
            const parsed = parseTask(c.subject);
            const row = [];
            for (const [name, graph] of ARMS) {
                const ranked = rankFiles(index, parsed, { graph }).ranked.map(r => r.file);
                const hits = k => truth.filter(f => ranked.slice(0, k).includes(f)).length;
                const recall = k => hits(k) / truth.length, precision = k => hits(k) / k;
                const first = ranked.slice(0, MAX).findIndex(f => truth.includes(f));
                const rr = first < 0 ? 0 : 1 / (first + 1);
                const t = totals[name];
                t.r5 += recall(5); t.rN += recall(MAX); t.p5 += precision(5); t.pN += precision(MAX); t.rr += rr;
                t.top1 += truth.includes(ranked[0]) ? 1 : 0;
                row.push(`${name} r5=${recall(5).toFixed(2)} r${MAX}=${recall(MAX).toFixed(2)} p5=${precision(5).toFixed(2)} p${MAX}=${precision(MAX).toFixed(2)} rr=${rr.toFixed(2)}`);
            }
            console.log(`${c.sha.slice(0, 7)} ${row.join('  ')}  | ${c.subject.slice(0, 70)}`);
        } finally {
            git('worktree', 'remove', '--force', wt);
        }
    }
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}
const pct = v => `${(100 * v / Math.max(n, 1)).toFixed(1)}%`;
console.log(`\n${n} commits from ${path.basename(repo)}`);
for (const [name] of ARMS) {
    const t = totals[name];
    console.log(`${name.padEnd(8)} recall@5 ${pct(t.r5)}  recall@${MAX} ${pct(t.rN)}  precision@5 ${pct(t.p5)}  precision@${MAX} ${pct(t.pN)}  MRR ${(t.rr / Math.max(n, 1)).toFixed(3)}  top-1 hit ${pct(t.top1)}`);
}
