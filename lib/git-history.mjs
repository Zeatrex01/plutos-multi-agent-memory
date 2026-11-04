// History-only git reads, memoized per repository state.
//
// Why: the dashboard's first load fired the same history queries again and again — on one
// real project, 66 synchronous git processes in the first 12 seconds (4.2s with the event loop
// blocked), the same `git log -n 1000 --name-only` five times and the same doc-age lookups seven
// times, all answering for an unchanged HEAD. Every other request queued behind them.
//
// Only queries whose answer is fixed by the commit graph reachable from HEAD may use this:
// log/rev-list over history. Anything that reads the working tree or the index (status, diff)
// must not — those change without any ref moving.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const MAX_CACHED_CHARS = 16 * 1024 * 1024;
const cache = new Map();   // insertion order doubles as LRU order
let cachedChars = 0;
const stats = { hits: 0, misses: 0 };

function gitDirs(root) {
    const dotGit = path.join(root, '.git');
    let stat;
    try { stat = fs.statSync(dotGit); } catch { return null; }
    let gitDir = dotGit;
    if (stat.isFile()) {
        // A linked worktree or submodule: `.git` is a file pointing at the real git directory.
        const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
        if (!match) return null;
        gitDir = path.resolve(root, match[1]);
    }
    let commonDir = gitDir;
    try { commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()); } catch { /* not a linked worktree */ }
    return { gitDir, commonDir };
}
const read = file => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } };
const stamp = file => { try { const s = fs.statSync(file); return `${s.mtimeMs}:${s.size}`; } catch { return ''; } };

// Identity of the history git sees from HEAD: what HEAD names, the loose ref it points at, and
// packed-refs. A commit, checkout, reset, merge or pull changes at least one of them. null when
// this is not a recognisable git directory — callers then run git uncached.
export function historyKey(root) {
    const dirs = gitDirs(root);
    if (!dirs) return null;
    const head = read(path.join(dirs.gitDir, 'HEAD'));
    if (!head) return null;
    const ref = /^ref:\s*(\S+)$/.exec(head)?.[1];
    const parts = [head, stamp(path.join(dirs.commonDir, 'packed-refs'))];
    if (ref) parts.push(read(path.join(dirs.gitDir, ref)) || read(path.join(dirs.commonDir, ref)));
    return parts.join('|');
}

function runGit(root, args) {
    // execFileSync (argv array), never a shell string — a path with backticks must not execute.
    return execFileSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

// `windowMs` is for queries that also depend on the clock (`--since=7 days ago`): the answer is
// reused only within one window of that length. Failures are never cached.
export function historyGit(root, args, { windowMs = 0 } = {}) {
    const key = historyKey(root);
    if (key === null) return runGit(root, args);
    const id = JSON.stringify([path.resolve(root), key, windowMs ? Math.floor(Date.now() / windowMs) : 0, args]);
    if (cache.has(id)) {
        const value = cache.get(id);
        cache.delete(id); cache.set(id, value);
        stats.hits++;
        return value;
    }
    stats.misses++;
    const value = runGit(root, args);
    cache.set(id, value);
    cachedChars += value.length;
    for (const [oldest, old] of cache) {
        if (cachedChars <= MAX_CACHED_CHARS) break;
        cache.delete(oldest); cachedChars -= old.length;
    }
    return value;
}

export const historyGitStats = () => ({ ...stats, entries: cache.size });
