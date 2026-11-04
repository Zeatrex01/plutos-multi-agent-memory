// `plutos update`: brings this PLUT_OS up to date and sets aside what an update leaves behind (owner,
// 2026-10-28: "a cleaner that keeps it current"). The projects need nothing: their launcher hands
// over to this install (lib/launch.mjs), and an older stub is replaced when its project is opened.
//
// - A checkout fast-forwards to its upstream. Local commits are never moved: a branch that is
//   ahead only reports them, and one that has diverged is refused.
// - PLUT_OS as another repository's submodule runs the commit that superproject records, and an
//   update never moves the superproject's branch: it reports how far that branch is behind its
//   upstream and how to move PLUT_OS there. `git submodule update` checks this folder alone out at
//   the recorded commit, refused when the folder holds commits no remote has.
// - Git itself refuses to overwrite a changed file, so work in progress stops an update; it is
//   never lost to one.
// - npm install runs when package.json or package-lock.json changed.
// - Leftovers are the files git neither tracks nor ignores in this folder. They are listed;
//   --clean moves them into the Hub's update-leftovers/<time>/ folder instead of deleting them.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntry } from './entry.mjs';

// `timeout` (ms) only where a caller asked for one: the dashboard's child process (updateInChild).
const git = (cwd, args, timeout) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...(timeout ? { timeout } : {}) }).trim();
const tryGit = (cwd, args, timeout) => { try { return git(cwd, args, timeout); } catch { return null; } };
const lines = text => (text || '').split('\n').filter(Boolean);
const gitError = error => error.code === 'ETIMEDOUT' ? 'it got no answer in time.'
    : (error.stderr ? String(error.stderr) : error.message).trim().split('\n').slice(0, 6).join('\n');
// The native call expands Windows 8.3 short names (RUNNER~1) the way git's own paths are written;
// git prints C:/a/b where Node prints C:\a\b, and Windows paths are compared without case.
const realpath = dir => { try { return fs.realpathSync.native(dir); } catch { return path.resolve(dir); } };
const samePath = (a, b) => {
    const [x, y] = [realpath(a), realpath(b)].map(p => path.resolve(p));
    return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
};

/** The files git neither tracks nor ignores under `root`, relative to it. */
export function updateLeftovers(root) {
    return lines(tryGit(root, ['ls-files', '--others', '--exclude-standard']));
}

/** Moves each leftover under `home`/update-leftovers/<stamp>/, keeping its relative path. */
export function setAsideLeftovers(root, files, home, stamp = new Date().toISOString().replace(/[:.]/g, '-')) {
    const target = path.join(home, 'update-leftovers', stamp);
    for (const file of files) {
        const to = path.join(target, file);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        try { fs.renameSync(path.join(root, file), to); }
        catch { fs.cpSync(path.join(root, file), to, { recursive: true }); fs.rmSync(path.join(root, file), { recursive: true, force: true }); }
    }
    return target;
}

function npmInstall(root, stdio = 'inherit', timeout) {
    // npm is npm.cmd on Windows, which Node runs only through a shell.
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'],
        { cwd: root, stdio, shell: process.platform === 'win32', windowsHide: true, ...(timeout ? { timeout } : {}) });
}

/**
 * Updates the PLUT_OS at `root`. `check` fetches and reports without changing anything; `clean`
 * moves the leftovers aside. Returns { kind, state, from, to, behind, commits, ahead, npm,
 * leftovers, setAside, message }; state is up-to-date, updated, ahead, refused or packaged. For a
 * submodule, ahead and behind count the superproject's branch against its upstream, and recorded
 * is the commit the superproject pins for this folder; target is the upstream commit after the fetch.
 * `expect` ({ from, to }, the dashboard's checked commits) refuses when HEAD or the upstream moved
 * since; `fetchTimeoutMs` bounds each fetch.
 */
export function updatePlutos(root, { check = false, clean = false, home, install = npmInstall, expect, fetchTimeoutMs } = {}) {
    const top = tryGit(root, ['rev-parse', '--show-toplevel']);
    if (!top) {
        return { kind: 'packaged', state: 'packaged', message: 'This PLUT_OS is a packaged build, not a git checkout: build it again from an updated checkout (npm run build).' };
    }
    // A copy without git of its own (the release zip, a built dist/ folder) inside another repository
    // must never fetch, fast-forward or npm install that repository.
    if (!samePath(top, root)) {
        return { kind: 'packaged', state: 'packaged', message: `This PLUT_OS is not a git checkout of its own (it sits inside ${top}): it updates like a packaged build, by a new download or build.` };
    }
    const superproject = tryGit(root, ['rev-parse', '--show-superproject-working-tree']) || '';
    const repo = superproject || top;
    const result = { kind: superproject ? 'submodule' : 'checkout', root: top, repo, state: 'up-to-date', from: git(top, ['rev-parse', 'HEAD']), npm: false };
    const refuse = message => ({ ...result, state: 'refused', message, leftovers: updateLeftovers(top) });

    const upstream = tryGit(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    if (!upstream) return refuse(`${repo} has no upstream branch to update from. Check out a branch that tracks one (git branch -u origin/main).`);
    try { git(repo, ['fetch', '--quiet', upstream.split('/')[0]], fetchTimeoutMs); }
    catch (error) { return refuse(`Fetching ${upstream} failed:\n${gitError(error)}`); }
    const [ahead, behind] = git(repo, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`]).split(/\s+/).map(Number);
    Object.assign(result, { upstream, ahead, behind, target: tryGit(repo, ['rev-parse', upstream]) });
    if (expect && (expect.from !== result.from || expect.to !== result.target)) {
        return refuse('PLUT_OS or its upstream changed since the last check. Check again, then update.');
    }
    if (ahead && behind) return refuse(`${repo} has ${ahead} local commit(s) and ${upstream} has ${behind} new one(s). Merge them by hand; an update never moves local commits.`);
    if (superproject) {
        // `git submodule update` moves this folder's HEAD to the recorded commit: refuse when that
        // would leave a commit no remote holds (the owner develops PLUT_OS here too).
        tryGit(top, ['fetch', '--quiet'], fetchTimeoutMs);
        const local = Number(tryGit(top, ['rev-list', '--count', 'HEAD', '--not', '--remotes']) || 0);
        if (local) return refuse(`${top} holds ${local} commit(s) that no remote branch has. Push them first; an update would move this folder off them.`);
    }

    // Only a checkout's own branch moves. A superproject is another repository: describeUpdate
    // reports how far behind it is, and the owner pulls it there.
    if (behind && !check && !superproject) {
        try { git(top, ['merge', '--ff-only', '--quiet', upstream]); }
        catch (error) { return refuse(`Git refused the update and changed nothing:\n${gitError(error)}`); }
    }
    if (superproject) {
        // Also when the superproject was pulled without its submodules: this folder then lags
        // behind the commit the superproject records for it.
        const relative = path.relative(superproject, top).split(path.sep).join('/');
        result.submodule = relative;
        result.recorded = tryGit(superproject, ['rev-parse', `HEAD:${relative}`]);
        if (result.recorded && result.recorded !== result.from && !check) {
            try { git(superproject, ['submodule', 'update', '--init', '--', relative]); }
            catch (error) { return refuse(`Checking out the commit the superproject records for ${relative}/ failed:\n${gitError(error)}`); }
        }
    }
    result.to = git(top, ['rev-parse', 'HEAD']);
    if (result.to !== result.from) {
        result.commits = Number(tryGit(top, ['rev-list', '--count', `${result.from}..${result.to}`]) || 0);
        const changed = lines(tryGit(top, ['diff', '--name-only', result.from, result.to, '--', 'package.json', 'package-lock.json']));
        if (changed.length) { install(top); result.npm = true; }
        result.state = 'updated';
    } else if (ahead) result.state = 'ahead';

    result.leftovers = updateLeftovers(top);
    if (clean && result.leftovers.length && !check) result.setAside = setAsideLeftovers(top, result.leftovers, home);
    return result;
}

/** What `plutos update` prints for a result; the restart advice follows `platform`. */
export function describeUpdate(r, platform = process.platform) {
    if (r.state === 'packaged' || r.state === 'refused') {
        const out = [r.message];
        if (r.leftovers?.length) out.push(`${r.leftovers.length} leftover file(s) git neither tracks nor ignores; run again with --clean after the update to set them aside.`);
        return out.join('\n');
    }
    const short = sha => sha ? sha.slice(0, 7) : '';
    const out = [];
    const submodule = r.kind === 'submodule';
    const where = submodule ? `${r.root} (a submodule of ${r.repo})` : r.root;
    if (r.state === 'updated') out.push(`Updated ${where}: ${short(r.from)} → ${short(r.to)}, ${r.commits} new commit(s) in this folder${r.npm ? '; npm install ran because the dependencies changed' : ''}.`);
    else if (submodule && r.recorded && r.recorded !== r.from) out.push(`${r.repo} records ${short(r.recorded)} for this folder. Run plutos update without --check to take it.`);
    else if (!submodule && r.behind) out.push(`${r.behind} new commit(s) for ${where}. Run plutos update without --check to take them.`);
    else out.push(`${where} is up to date${submodule && r.recorded ? ' with the commit its superproject records' : ''}.`);
    // The .bat launchers exist only on Windows; elsewhere PLUT_OS runs in a terminal.
    if (r.state === 'updated') out.push(platform === 'win32'
        ? 'Restart PLUT_OS (STOP_PLUT_OS.bat, then START_PLUT_OS.bat) to run the new version.'
        : "Restart PLUT_OS to run the new version: stop it with Ctrl+C in its terminal, then start it again (node dashboard.mjs --open, or a project's PLUT_OS.sh).");
    // The superproject's own commits are reported, never taken: its branch belongs to that repository.
    if (submodule) out.push(r.behind
        ? `${r.repo} pins which PLUT_OS commit runs here and is ${r.behind} commit(s) behind ${r.upstream}. Pull it there, then run plutos update again.`
        : `${r.repo} pins which PLUT_OS commit runs here. To run a newer one, move that pin: git -C "${r.repo}" submodule update --remote -- ${r.submodule}, then commit the change there.`);
    if (r.state === 'ahead') out.push(`${r.ahead} local commit(s)${submodule ? ` in ${r.repo}` : ''} are not pushed yet; an update leaves them as they are.`);
    if (r.setAside) out.push(`Moved ${r.leftovers.length} leftover file(s) to ${r.setAside}.`);
    else if (r.leftovers?.length) {
        out.push(`${r.leftovers.length} leftover file(s) git neither tracks nor ignores:`);
        for (const file of r.leftovers.slice(0, 20)) out.push(`  ${file}`);
        if (r.leftovers.length > 20) out.push(`  … and ${r.leftovers.length - 20} more`);
        out.push('Run plutos update --clean to move them into the Hub, out of the way (nothing is deleted).');
    }
    out.push('Projects need nothing: their launcher uses this install, and an older one is replaced when the project is opened.');
    return out.join('\n');
}

// --- The dashboard's update check (Settings → Updates) ------------------------------------------

/** -1, 0 or 1. Numeric x.y.z, then a pre-release (`-beta`) before its release:
 *  0.5.0-beta < 0.5.0 < 0.5.1. A leading v is ignored; a part that is not a number counts as 0. */
export function compareVersions(a, b) {
    const parse = v => {
        const [core, pre = ''] = String(v || '').trim().replace(/^v/i, '').split('+')[0].split(/-(.*)/s);
        return { nums: core.split('.').map(n => Number.parseInt(n, 10) || 0), pre: pre ? pre.split('.') : [] };
    };
    const x = parse(a), y = parse(b);
    for (let i = 0; i < Math.max(x.nums.length, y.nums.length, 3); i++) {
        const d = (x.nums[i] || 0) - (y.nums[i] || 0);
        if (d) return d < 0 ? -1 : 1;
    }
    if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : (x.pre.length ? -1 : 1);
    for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
        const p = x.pre[i], q = y.pre[i];
        if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
        if (p === q) continue;
        const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
        if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
        if (pn !== qn) return pn ? -1 : 1;
        return p < q ? -1 : 1;
    }
    return 0;
}

/** `owner/repo` from package.json's `repository` (`github:o/r`, `o/r`, a github.com URL or `{ url }`), else ''. */
export function githubRepo(pkg) {
    const raw = typeof pkg?.repository === 'string' ? pkg.repository : pkg?.repository?.url || '';
    const m = raw.match(/^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/) || raw.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
    return m ? `${m[1]}/${m[2]}` : '';
}

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The newest published release of this PLUT_OS on GitHub against the version it runs, for a
 * packaged build (a checkout asks git instead). `root` holds the package.json read at run time (the
 * dashboard passes APP_ROOT; it ships beside the exe). It reads the last five releases, not
 * /releases/latest, which skips pre-releases, and takes the highest tag that is not a draft.
 * Returns { state, current, latest, url, message }: available, current, none (no release yet, or a
 * private repository) or error (offline, timed out, rate-limited). Never throws.
 */
export async function latestRelease({ fetchImpl = fetch, timeoutMs = 5000, root = MODULE_ROOT, pkg } = {}) {
    let current = '', url = '';
    const error = reason => ({ state: 'error', current, latest: null, url, message: `Could not check for updates: ${reason}.` });
    try {
        pkg ??= JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        current = String(pkg.version || '');
        const repo = githubRepo(pkg);
        if (!repo) return error('package.json names no GitHub repository');
        url = `https://github.com/${repo}/releases`;
        const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=5`, {
            headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'PLUT_OS' }, signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 404) return { state: 'none', current, latest: null, url, message: 'No release published yet (or the repository is private).' };
        if (res.status === 403 || res.status === 429) return error(`GitHub refused the request (${res.status}), usually its rate limit; try again later`);
        if (!res.ok) return error(`GitHub answered ${res.status}`);
        const releases = (await res.json() || []).filter(r => r && !r.draft && typeof r.tag_name === 'string' && r.tag_name.trim());
        if (!releases.length) return { state: 'none', current, latest: null, url, message: 'No release published yet.' };
        const newest = releases.reduce((a, b) => compareVersions(b.tag_name, a.tag_name) > 0 ? b : a);
        const latest = newest.tag_name.trim().replace(/^v/i, '');
        if (typeof newest.html_url === 'string' && newest.html_url.startsWith('https://github.com/')) url = newest.html_url;
        return compareVersions(latest, current) > 0
            ? { state: 'available', current, latest, url, message: `PLUT_OS ${latest} is available; this is ${current}.` }
            : { state: 'current', current, latest, url, message: `PLUT_OS ${current} is the latest release.` };
    } catch (e) {
        const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
        return error(timedOut ? `no answer within ${Math.round(timeoutMs / 1000)} s` : String(e?.cause?.code || e?.message || e).split('\n')[0]);
    }
}

const SELF = fileURLToPath(import.meta.url);
// Per step in the dashboard's child process: a fetch, then npm install when the dependencies changed.
export const FETCH_TIMEOUT_MS = 20_000;
export const INSTALL_TIMEOUT_MS = 180_000;

/**
 * updatePlutos for the dashboard, which must never wait on the synchronous path: it runs in a child
 * process (`node lib/update.mjs --json …`), each fetch bounded by FETCH_TIMEOUT_MS and npm install by
 * INSTALL_TIMEOUT_MS, git told never to prompt, and the whole child (with git and npm under it)
 * killed when it outlives `timeoutMs`. The CLI keeps the synchronous call. Resolves with the result
 * and its `description`, or { state: 'error', message }; never rejects.
 */
export function updateInChild(root, { check = false, expect, timeoutMs = check ? 2 * FETCH_TIMEOUT_MS + 10_000 : 2 * FETCH_TIMEOUT_MS + INSTALL_TIMEOUT_MS + 20_000 } = {}) {
    return new Promise(resolve => {
        const args = [SELF, '--json', root, ...(check ? ['--check'] : []), ...(expect ? ['--expect', `${expect.from}..${expect.to}`] : [])];
        const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
        // An owner's own ssh command is kept; the default one is told never to ask.
        if (!env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
        let child;
        try { child = spawn(process.execPath, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
        catch (e) { resolve({ state: 'error', message: `The update could not start: ${e.message}` }); return; }
        let out = '', err = '', timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
            else child.kill('SIGKILL');
        }, timeoutMs);
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { err = (err + d).slice(-4000); });
        child.on('error', e => { err += e.message; });
        child.on('close', () => {
            clearTimeout(timer);
            try {
                const line = out.trim().split('\n').pop();
                if (line && !timedOut) return resolve(JSON.parse(line));
            } catch { /* no result line: reported below */ }
            const reason = timedOut ? `no answer within ${Math.round(timeoutMs / 1000)} s` : (err.trim().split('\n').pop() || 'no result');
            resolve({ state: 'error', message: `The update${check ? ' check' : ''} could not run: ${reason}.` });
        });
    });
}

// `node lib/update.mjs --json <root> [--check] [--expect <from>..<to>]`: one JSON line, the result
// with its description; npm's own output goes to stderr. Used by updateInChild.
if (isEntry(import.meta.url) && process.argv[2] === '--json') {
    const args = process.argv.slice(3);
    const at = args.indexOf('--expect');
    const [from, to] = at >= 0 ? String(args[at + 1] || '').split('..') : [];
    const r = updatePlutos(args[0], {
        check: args.includes('--check'), fetchTimeoutMs: FETCH_TIMEOUT_MS,
        ...(at >= 0 ? { expect: { from, to } } : {}),
        install: dir => npmInstall(dir, ['ignore', 2, 2], INSTALL_TIMEOUT_MS),
    });
    process.stdout.write(JSON.stringify({ ...r, description: describeUpdate(r) }) + '\n');
}
