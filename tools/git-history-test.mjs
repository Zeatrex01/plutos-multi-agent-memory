#!/usr/bin/env node
// The history cache must never answer for a repository state it did not see. Real repositories,
// real ref movements: commit, branch switch, detached HEAD, packed refs, a linked worktree.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { historyGit, historyGitStats, historyKey } from '../lib/git-history.mjs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-git-history-'));
const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
let counter = 0;
const commit = (cwd, message) => { fs.writeFileSync(path.join(cwd, `file-${++counter}.txt`), message); sh(cwd, 'add', '-A'); sh(cwd, 'commit', '-q', '-m', message); return sh(cwd, 'rev-parse', 'HEAD'); };
const head = cwd => historyGit(cwd, ['log', '-1', '--format=%H']);
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log(`  ok  ${name}`); };

try {
    const repo = path.join(scratch, 'repo');
    fs.mkdirSync(repo);
    sh(repo, 'init', '-q', '-b', 'main');
    const first = commit(repo, 'first');

    check('a repeated history query is answered from the cache', () => {
        const before = historyGitStats();
        assert.equal(head(repo), first);
        assert.equal(head(repo), first);
        const after = historyGitStats();
        assert.equal(after.misses - before.misses, 1);
        assert.equal(after.hits - before.hits, 1);
    });
    check('a new commit changes the answer', () => {
        const second = commit(repo, 'second');
        assert.equal(head(repo), second);
    });
    check('switching branch changes the answer', () => {
        sh(repo, 'checkout', '-q', '-b', 'side', first);
        assert.equal(head(repo), first);
        const side = commit(repo, 'side');
        assert.equal(head(repo), side);
        sh(repo, 'checkout', '-q', 'main');
        assert.equal(head(repo), sh(repo, 'rev-parse', 'main'));
    });
    check('a detached HEAD is keyed by the commit it names', () => {
        sh(repo, 'checkout', '-q', '--detach', first);
        assert.equal(head(repo), first);
        sh(repo, 'checkout', '-q', 'main');
        assert.equal(head(repo), sh(repo, 'rev-parse', 'main'));
    });
    check('a commit after pack-refs (no loose ref left) still changes the answer', () => {
        sh(repo, 'pack-refs', '--all');
        assert.equal(head(repo), sh(repo, 'rev-parse', 'main'));
        const packed = commit(repo, 'after pack');
        assert.equal(head(repo), packed);
    });
    check('a reset to an older commit changes the answer', () => {
        sh(repo, 'reset', '-q', '--hard', first);
        assert.equal(head(repo), first);
    });
    check('a linked worktree is keyed by its own HEAD', () => {
        const tree = path.join(scratch, 'tree');
        sh(repo, 'worktree', 'add', '-q', '-b', 'wt', tree, first);
        assert.ok(fs.statSync(path.join(tree, '.git')).isFile());
        assert.notEqual(historyKey(tree), null);
        assert.equal(head(tree), first);
        const inTree = commit(tree, 'in worktree');
        assert.equal(head(tree), inTree);
        assert.equal(head(repo), first);
    });
    check('a clock window bounds reuse of time-relative queries', () => {
        const realNow = Date.now;
        try {
            const args = ['log', '--since=7 days ago', '--format=%H'];
            Date.now = () => 1_200_000;   // window 20
            historyGit(repo, args, { windowMs: 60_000 });
            const inside = historyGitStats();
            Date.now = () => 1_230_000;   // still window 20
            historyGit(repo, args, { windowMs: 60_000 });
            assert.equal(historyGitStats().hits, inside.hits + 1);
            Date.now = () => 1_290_000;   // window 21
            historyGit(repo, args, { windowMs: 60_000 });
            assert.equal(historyGitStats().misses, inside.misses + 1);
        } finally { Date.now = realNow; }
    });
    check('a failing query is not cached', () => {
        const before = historyGitStats();
        for (let i = 0; i < 2; i++) assert.throws(() => historyGit(repo, ['log', 'no-such-revision']));
        assert.equal(historyGitStats().misses, before.misses + 2);
        assert.equal(historyGitStats().entries, before.entries);
    });
    check('a folder that is not a repository runs git uncached', () => {
        const plain = path.join(scratch, 'plain');
        fs.mkdirSync(plain);
        assert.equal(historyKey(plain), null);
        const before = historyGitStats();
        assert.throws(() => historyGit(plain, ['log', '-1']));
        assert.deepEqual(historyGitStats(), before);
    });
    console.log(`Git history cache: ${checks} passed, 0 failed`);
} finally {
    fs.rmSync(scratch, { recursive: true, force: true });
}
