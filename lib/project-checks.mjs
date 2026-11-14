// Declared checks: the commands a project counts as part of "done", in its tracked .plutos/checks.json.
//
//   [{ "name": "arch-lint", "command": "python tools/arch_lint.py",
//      "meaning": "a call by name in a string, or an untyped reference, was added" }]
//
// The core knows nothing about what a check measures: a pack or the project brings the command,
// and `meaning` says in one line what a failure means, for an owner who does not read the code.
//
// The push gate's `run` (lib/push-gate.mjs) runs every check after the project's tests and stamps
// a pass only when the tests and every check exit 0. It records each check's result in the git
// directory (never committed), where the gate's refusal and the claim check read it. The claim
// check (lib/claim-check.mjs) is a Stop hook with a 15 s limit, so it never runs a check: it reads
// that record.
//
// The file is shared project state, tracked in git, so every clone and every AI holds the same
// checks (lib/kit-history.mjs PLUTOS_STATE). A file that cannot be read as a list of checks fails
// the run: a check that silently stops running is the failure this exists to prevent.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const CHECKS_FILE = '.plutos/checks.json';
const RESULT = 'plutos-checks.json';   // inside the git dir, beside the push gate's stamp

const gitResult = dir => {
    try {
        const file = execFileSync('git', ['rev-parse', '--git-path', RESULT], { cwd: dir, encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
        return path.resolve(dir, file);
    } catch { return ''; }
};

/** The project's declared checks: { checks: [{ name, command, meaning }], problem }. No file is no
 *  checks and no problem; a file that is not a list of { name, command, meaning } is a problem. */
export function readChecks(root) {
    let text;
    try { text = fs.readFileSync(path.join(root, CHECKS_FILE), 'utf8'); } catch { return { checks: [], problem: '' }; }
    let list;
    try { list = JSON.parse(text); } catch (e) { return { checks: [], problem: `${CHECKS_FILE} is not valid JSON (${e.message}).` }; }
    if (!Array.isArray(list)) return { checks: [], problem: `${CHECKS_FILE} must be a list of { name, command, meaning }.` };
    const text1 = v => typeof v === 'string' && v.trim() !== '';
    const bad = list.findIndex(c => !c || !text1(c.name) || !text1(c.command) || (c.meaning !== undefined && typeof c.meaning !== 'string'));
    if (bad >= 0) return { checks: [], problem: `${CHECKS_FILE} entry ${bad + 1} needs a name and a command (and meaning as text).` };
    const names = list.map(c => c.name.trim());
    const twice = names.find((n, i) => names.indexOf(n) !== i);
    if (twice) return { checks: [], problem: `${CHECKS_FILE} names the check "${twice}" twice.` };
    return { checks: list.map(c => ({ name: c.name.trim(), command: c.command, meaning: (c.meaning || '').trim() })), problem: '' };
}

/** sha256 of .plutos/checks.json's bytes, or '' when there is no such file. A run records it, so a
 *  file that is new or changed since (a pull, a teammate's commit, a fresh clone) is shown with its
 *  commands before they run: the checks are code that runs with the owner's rights. */
export function checksHash(root) {
    try { return createHash('sha256').update(fs.readFileSync(path.join(root, CHECKS_FILE))).digest('hex'); } catch { return ''; }
}

/** When .plutos/checks.json is new or changed since the last recorded run, its commands, one per
 *  line ("  name: command") under a heading line; [] otherwise. */
export function changedChecksLines(root, last = lastChecks(root)) {
    const hash = checksHash(root);
    if (!hash || last?.checksHash === hash) return [];
    const { checks } = readChecks(root);
    if (!checks.length) return [];
    return [`${CHECKS_FILE} is ${last?.checksHash ? 'changed' : 'new'} since the last run through the push gate; read it first, its commands run with your rights:`,
        ...checks.map(c => `  ${c.name}: ${c.command}`)];
}

/** Runs every check in `root`, in order, each to the end so one run names every failure:
 *  [{ name, meaning, ok }]. `spawn` is for tests. */
export function runChecks(root, checks, { spawn = command => spawnSync(command, { cwd: root, stdio: 'inherit', shell: true }) } = {}) {
    return checks.map(c => {
        console.log(`push-gate: check ${c.name}: ${c.command}`);
        const ok = (spawn(c.command).status ?? 1) === 0;
        if (!ok) console.error(`push-gate: check ${c.name} failed${c.meaning ? `: ${c.meaning}` : ''}`);
        return { name: c.name, meaning: c.meaning, ok };
    });
}

/** Records one run through the gate: { tree, at, tests: 'passed'|'failed', checks: [{ name, meaning, ok }], checksHash }. */
export function recordChecks(dir, result) {
    const file = gitResult(dir);
    if (!file) return;
    try { fs.writeFileSync(file, `${JSON.stringify(result)}\n`); } catch { /* a read-only git dir: nothing recorded */ }
}

/** The last recorded run through the gate in `dir`'s repository, or null. */
export function lastChecks(dir) {
    const file = gitResult(dir);
    try { return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; } catch { return null; }
}

/** The failed checks of a recorded run, one per line: "  name: meaning". */
export function failedLines(result) {
    return (result?.checks || []).filter(c => !c.ok).map(c => `  ${c.name}${c.meaning ? `: ${c.meaning}` : ''}`);
}
