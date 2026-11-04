#!/usr/bin/env node
// Keeps only the named branches on origin and deletes the rest without losing a commit (owner,
// 2026-10-28: at most three branches, main, master and develop). Each branch the kept ones do not
// contain becomes a parent of one archive commit. That commit is tagged archive/branches-<date> and
// the tag is pushed first; the branches are deleted only after the tag is on origin. The tag's
// message lists every deleted branch with its last commit, so one comes back with
// `git push origin <sha>:refs/heads/<name>`.
//
//   node tools/prune-branches.mjs           list what would go and where its commits stay
//   node tools/prune-branches.mjs --yes     tag, push the tag, delete
//   --keep=main,master,develop              the default
//
// Run it in the repository from your own terminal: cloud sessions may not push tags or delete
// branches (both are refused there with HTTP 403).
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const git = (args, input) => execFileSync('git', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true }).trim();
const contains = (base, sha) => {
    try { execFileSync('git', ['merge-base', '--is-ancestor', sha, base], { stdio: 'ignore', windowsHide: true }); return true; } catch { return false; }
};

/** The remote branches, each to keep or to delete, and for one to delete the kept branch that holds it. */
export function planPrune(keep) {
    git(['fetch', '--quiet', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*']);
    const branches = git(['for-each-ref', '--format=%(refname:strip=3) %(objectname)', 'refs/remotes/origin'])
        .split('\n').filter(Boolean).map(line => line.split(' ')).filter(([name]) => name !== 'HEAD')
        .map(([name, sha]) => ({ name, sha }));
    const kept = branches.filter(b => keep.includes(b.name));
    if (!kept.length) throw new Error(`None of ${keep.join(', ')} is on origin, so nothing would hold the history.`);
    const doomed = branches.filter(b => !keep.includes(b.name))
        .map(b => ({ ...b, heldBy: kept.find(k => contains(k.sha, b.sha))?.name || null }));
    return { kept, doomed };
}

export function prune({ keep, date = new Date().toISOString().slice(0, 10) }) {
    const { kept, doomed } = planPrune(keep);
    if (!doomed.length) return { kept, doomed, tag: null };
    const tag = `archive/branches-${date}`;
    const emptyTree = git(['hash-object', '-t', 'tree', '--stdin'], '');
    const parents = [...new Set(doomed.filter(b => !b.heldBy).map(b => b.sha))].flatMap(sha => ['-p', sha]);
    const message = [`Archive of the branches deleted on ${date}`, '',
        `Only ${keep.join(', ')} were kept. An unmerged branch's last commit is a parent of this commit;`,
        'a merged one is in the kept branch named beside it. Restore one with:',
        '  git push origin <sha>:refs/heads/<name>', '',
        ...doomed.map(b => `${b.name} ${b.sha} ${b.heldBy ? `in ${b.heldBy}` : 'unmerged'}`), ''].join('\n');
    const commit = git(['commit-tree', emptyTree, ...parents], message);
    git(['tag', '-a', tag, commit, '-m', `Branches deleted on ${date}; this commit's message lists each one.`]);
    git(['push', '--quiet', 'origin', `refs/tags/${tag}`]);
    git(['push', '--quiet', 'origin', '--delete', ...doomed.map(b => b.name)]);
    return { kept, doomed, tag };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    const args = process.argv.slice(2);
    const keep = (args.find(a => a.startsWith('--keep='))?.slice('--keep='.length) || 'main,master,develop').split(',').filter(Boolean);
    const { kept, doomed } = planPrune(keep);
    console.log(`Kept: ${kept.map(b => b.name).join(', ')}`);
    for (const b of doomed) console.log(`  delete ${b.name}  ${b.sha.slice(0, 9)}  ${b.heldBy ? `in ${b.heldBy}` : 'unmerged: kept by the archive tag'}`);
    if (!doomed.length) console.log('Only the kept branches are on origin.');
    else if (!args.includes('--yes')) console.log(`${doomed.length} branch(es) would be deleted. Run again with --yes to tag the unmerged ones and delete them all.`);
    else {
        const { tag } = prune({ keep });
        console.log(`Pushed ${tag} and deleted ${doomed.length} branch(es).`);
    }
}
