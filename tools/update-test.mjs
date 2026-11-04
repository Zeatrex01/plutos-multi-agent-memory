#!/usr/bin/env node
// `plutos update` (lib/update.mjs) on scratch repositories: a checkout fast-forwards and runs npm
// install only when the dependencies changed; work in progress and local commits stop it with
// nothing changed; leftovers are listed and --clean moves them into the Hub; the restart advice names
// .bat files only on Windows; PLUT_OS as a submodule runs the commit its superproject records, also
// when the superproject was pulled without it, and never moves the superproject's branch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { updatePlutos, describeUpdate } from '../lib/update.mjs';

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-update-')));
Object.assign(process.env, {
    GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.invalid',
    // Local submodule URLs need file transport, which git turns off for submodules by default.
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always',
});
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (dir, file, text) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
const commit = (dir, file, text) => { write(dir, file, text); git(dir, 'add', file); git(dir, 'commit', '-q', '-m', file); return git(dir, 'rev-parse', 'HEAD'); };
const home = path.join(scratch, 'hub');
let installs = 0;
const options = extra => ({ home, install: () => { installs++; }, ...extra });
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log(`  ok  ${name}`); };

try {
    const origin = path.join(scratch, 'origin.git');
    git(scratch, 'init', '-q', '--bare', '-b', 'main', origin);
    const seed = path.join(scratch, 'seed');
    git(scratch, 'clone', '-q', origin, seed);
    commit(seed, 'package.json', '{"name":"p"}\n');
    write(seed, '.gitignore', 'node_modules/\n');
    git(seed, 'add', '.gitignore'); git(seed, 'commit', '-q', '-m', 'ignore');
    git(seed, 'push', '-q', 'origin', 'HEAD:main');
    const mine = path.join(scratch, 'mine');
    git(scratch, 'clone', '-q', origin, mine);

    check('a current checkout is up to date and lists nothing', () => {
        const r = updatePlutos(mine, options());
        assert.equal(r.state, 'up-to-date');
        assert.deepEqual(r.leftovers, []);
        assert.match(describeUpdate(r), /is up to date/);
    });
    check('--check reports new commits and changes nothing', () => {
        commit(seed, 'docs/new.md', 'new\n'); git(seed, 'push', '-q', 'origin', 'HEAD:main');
        const before = git(mine, 'rev-parse', 'HEAD');
        const r = updatePlutos(mine, options({ check: true }));
        assert.equal(r.behind, 1);
        assert.equal(git(mine, 'rev-parse', 'HEAD'), before);
        assert.match(describeUpdate(r), /1 new commit\(s\).*without --check/);
    });
    check('an update fast-forwards, and npm install runs only when the dependencies changed', () => {
        let r = updatePlutos(mine, options());
        assert.deepEqual([r.state, r.commits, r.npm, installs], ['updated', 1, false, 0]);
        assert.equal(git(mine, 'rev-parse', 'HEAD'), git(seed, 'rev-parse', 'HEAD'));
        commit(seed, 'package.json', '{"name":"p","version":"2"}\n'); git(seed, 'push', '-q', 'origin', 'HEAD:main');
        r = updatePlutos(mine, options());
        assert.deepEqual([r.state, r.npm, installs], ['updated', true, 1]);
        assert.match(describeUpdate(r), /npm install ran because the dependencies changed[\s\S]*Restart PLUT_OS/);
    });
    check('the restart advice names the .bat launchers on Windows only', () => {
        const updated = { kind: 'checkout', state: 'updated', root: mine, from: 'a'.repeat(40), to: 'b'.repeat(40), commits: 1, npm: false, leftovers: [] };
        assert.match(describeUpdate(updated, 'win32'), /Restart PLUT_OS \(STOP_PLUT_OS\.bat, then START_PLUT_OS\.bat\)/);
        for (const platform of ['linux', 'darwin']) {
            const text = describeUpdate(updated, platform);
            assert.match(text, /Restart PLUT_OS to run the new version: stop it with Ctrl\+C in its terminal/);
            assert.doesNotMatch(text, /\.bat\b/);
        }
    });
    check('a changed file the update would overwrite stops it, and the change is kept', () => {
        commit(seed, 'docs/new.md', 'theirs\n'); git(seed, 'push', '-q', 'origin', 'HEAD:main');
        const before = git(mine, 'rev-parse', 'HEAD');
        write(mine, 'docs/new.md', 'my work in progress\n');
        const r = updatePlutos(mine, options());
        assert.equal(r.state, 'refused');
        assert.match(r.message, /Git refused the update and changed nothing/);
        assert.equal(git(mine, 'rev-parse', 'HEAD'), before);
        assert.equal(fs.readFileSync(path.join(mine, 'docs/new.md'), 'utf8'), 'my work in progress\n');
        git(mine, 'checkout', '-q', '--', 'docs/new.md');
    });
    check('local commits are never moved: diverged is refused, ahead is reported', () => {
        commit(mine, 'mine.md', 'mine\n');
        const before = git(mine, 'rev-parse', 'HEAD');
        let r = updatePlutos(mine, options());
        assert.equal(r.state, 'refused');
        assert.match(r.message, /1 local commit\(s\) and origin\/main has 1 new one/);
        assert.equal(git(mine, 'rev-parse', 'HEAD'), before);
        git(mine, 'reset', '-q', '--hard', 'origin/main');
        commit(mine, 'mine.md', 'mine\n');
        r = updatePlutos(mine, options());
        assert.equal(r.state, 'ahead');
        assert.match(describeUpdate(r), /1 local commit\(s\) are not pushed yet/);
        git(mine, 'reset', '-q', '--hard', 'origin/main');
    });
    check('leftovers are the files git neither tracks nor ignores; --clean moves them into the Hub', () => {
        write(mine, 'docs/old-notes.md', 'left behind\n');
        write(mine, 'node_modules/x/index.js', 'ignored\n');
        let r = updatePlutos(mine, options());
        assert.deepEqual(r.leftovers, ['docs/old-notes.md']);
        assert.match(describeUpdate(r), /1 leftover file\(s\)[\s\S]*docs\/old-notes\.md[\s\S]*--clean/);
        r = updatePlutos(mine, options({ clean: true }));
        assert.ok(!fs.existsSync(path.join(mine, 'docs/old-notes.md')));
        assert.equal(fs.readFileSync(path.join(r.setAside, 'docs/old-notes.md'), 'utf8'), 'left behind\n');
        assert.ok(r.setAside.startsWith(path.join(home, 'update-leftovers')));
        assert.ok(fs.existsSync(path.join(mine, 'node_modules/x/index.js')), 'an ignored file stays');
    });
    check('a folder outside git is a packaged build', () => {
        const packaged = path.join(scratch, 'packaged');
        fs.mkdirSync(packaged);
        assert.equal(updatePlutos(packaged, options()).state, 'packaged');
    });
    check('a PLUT_OS folder inside an unrelated repository is packaged and never touches that repository', () => {
        // The release zip or a built dist/ unpacked inside some other checkout that is behind its upstream.
        commit(seed, 'docs/elsewhere.md', 'new upstream\n'); git(seed, 'push', '-q', 'origin', 'HEAD:main');
        const inner = path.join(mine, 'dist-copy');
        fs.mkdirSync(inner);
        const before = git(mine, 'rev-parse', 'HEAD');
        const r = updatePlutos(inner, options());
        assert.deepEqual([r.kind, r.state], ['packaged', 'packaged']);
        assert.match(r.message, /not a git checkout of its own/);
        assert.equal(git(mine, 'rev-parse', 'HEAD'), before);
        assert.equal(git(mine, 'rev-parse', 'origin/main'), before, 'nothing was fetched');
        fs.rmSync(inner, { recursive: true });
        git(mine, 'pull', '-q', '--ff-only');
    });

    // PLUT_OS as a submodule: the superproject records which commit it runs.
    const superOrigin = path.join(scratch, 'super.git');
    git(scratch, 'init', '-q', '--bare', '-b', 'main', superOrigin);
    const superSeed = path.join(scratch, 'super-seed');
    git(scratch, 'clone', '-q', superOrigin, superSeed);
    commit(superSeed, 'README.md', 'studio\n');
    git(superSeed, 'submodule', 'add', '-q', origin, 'plutos');
    git(superSeed, 'commit', '-q', '-m', 'plutos');
    git(superSeed, 'push', '-q', 'origin', 'HEAD:main');
    const studio = path.join(scratch, 'studio');
    git(scratch, 'clone', '-q', '--recurse-submodules', superOrigin, studio);
    const plutos = path.join(studio, 'plutos');
    const bump = () => {
        commit(seed, 'lib/next.mjs', `${Date.now()}\n`); git(seed, 'push', '-q', 'origin', 'HEAD:main');
        git(path.join(superSeed, 'plutos'), 'pull', '-q', 'origin', 'main');
        git(superSeed, 'add', 'plutos'); git(superSeed, 'commit', '-q', '-m', 'bump plutos'); git(superSeed, 'push', '-q', 'origin', 'HEAD:main');
        return git(seed, 'rev-parse', 'HEAD');
    };

    check('a submodule reports that its superproject is behind and never moves that branch', () => {
        const target = bump();
        const before = [git(studio, 'rev-parse', 'HEAD'), git(plutos, 'rev-parse', 'HEAD')];
        const r = updatePlutos(plutos, options());
        assert.deepEqual([r.kind, r.state, r.behind], ['submodule', 'up-to-date', 1]);
        assert.deepEqual([git(studio, 'rev-parse', 'HEAD'), git(plutos, 'rev-parse', 'HEAD')], before);
        assert.notEqual(before[1], target);
        assert.match(describeUpdate(r), /pins which PLUT_OS commit runs here and is 1 commit\(s\) behind origin\/main\. Pull it there, then run plutos update again/);
    });
    check('a superproject pulled without its submodule still gets this folder moved up', () => {
        const target = bump();
        git(studio, 'pull', '-q', '--no-recurse-submodules', 'origin', 'main');
        assert.notEqual(git(plutos, 'rev-parse', 'HEAD'), target);
        const r = updatePlutos(plutos, options());
        assert.equal(r.state, 'updated');
        assert.equal(git(plutos, 'rev-parse', 'HEAD'), target);
        assert.match(describeUpdate(r), /pins which PLUT_OS commit runs here\. To run a newer one, move that pin: git -C ".+" submodule update --remote -- plutos, then commit the change there/);
    });
    check('a submodule holding a commit no remote has is refused and left where it is', () => {
        bump();
        git(plutos, 'checkout', '-q', '-b', 'work');
        const local = commit(plutos, 'lib/mine.mjs', 'mine\n');
        const superBefore = git(studio, 'rev-parse', 'HEAD');
        const r = updatePlutos(plutos, options());
        assert.equal(r.state, 'refused');
        assert.match(r.message, /holds 1 commit\(s\) that no remote branch has/);
        assert.deepEqual([git(plutos, 'rev-parse', 'HEAD'), git(studio, 'rev-parse', 'HEAD')], [local, superBefore]);
    });
    console.log(`update: ${checks} checks passed`);
} finally {
    fs.rmSync(scratch, { recursive: true, force: true });
}
