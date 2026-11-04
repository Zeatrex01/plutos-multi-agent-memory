#!/usr/bin/env node
// Safety guard — a Claude Code PreToolUse hook for the commands the owner's standing rules forbid,
// so they are stopped by the hook instead of by a reminder. Switched on per project in the
// dashboard's Hooks panel (lib/project-hooks.mjs). It refuses (exit 2, the reason on stderr):
//
//   - a force push (`--force`, `-f`, `+ref`); `--force-with-lease` still goes;
//   - `git reset --hard` and `git clean -f`, which throw away work that cannot be got back;
//   - discarding the whole tree's changes: `git checkout -- .`, `git checkout -f`, `git restore .`
//     (unstaging with `--staged` alone still goes), `git switch -f` or `--discard-changes`, and
//     `git stash drop` or `clear`. Other agents' uncommitted work goes with them. Restoring a file
//     by name still goes;
//   - a recursive delete (`rm`, or PowerShell's Remove-Item and its aliases) whose target is not
//     a literal absolute path: a variable, a glob, `~`, `..`, a relative path, or a root or home
//     folder itself, in Git Bash's `/c/...` spelling too;
//   - a commit message that carries an AI co-author trailer or an AI session link: the AI that wrote a
//     change does not sign the repository. A model named as a subject (a research
//     finding, a client's records) is content, not a signature, and passes.
//
// The owner can still run any of these from their own terminal; the hook only sees an AI's
// tool calls. Anything it cannot read lets the command through.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandSegments, commandWords, gitSubcommand, isGit, nativePath } from './shell-segments.mjs';
import { isEntry } from './entry.mjs';

// PowerShell's rm, rmdir, rd, ri, del and erase are all Remove-Item.
const DELETE = /^(rm|rmdir|rd|ri|del|erase|Remove-Item)$/i;
// Pathspecs that mean the whole tree.
const WHOLE_TREE = new Set(['.', './', ':/', ':/*', '*']);
const DISCARD = 'discards every uncommitted change in the tree, other agents\' work included. Commit or stash first, or restore the files you changed by name.';

function rmTargetProblem(target, platform = process.platform) {
    // `~` expands only at the start of a word; inside one it is a literal character, as in the
    // Windows short name C:\Users\RUNNER~1.
    if (/[$*?`]/.test(target) || target.startsWith('~') || target.includes('..')) return `"${target}" is not a literal path`;
    const local = nativePath(target, platform);
    if (!path.isAbsolute(local) && !/^[A-Za-z]:[\\/]/.test(local)) return `"${target}" is relative`;
    const fold = p => platform === 'win32' ? p.toLowerCase() : p;
    const clean = fold(path.resolve(local)), home = fold(os.homedir());
    if (clean === fold(path.parse(path.resolve(local)).root) || clean === home || clean === path.dirname(home)) return `"${target}" is a root or home folder`;
    return '';
}

// Why this git subcommand throws away uncommitted work across the tree, or ''.
function discardProblem(sub, rest) {
    const flags = rest.filter(w => w.startsWith('-')), specs = rest.filter(w => !w.startsWith('-'));
    const whole = specs.some(w => WHOLE_TREE.has(w));
    if (sub === 'checkout' && (whole || flags.some(f => f === '-f' || f === '--force'))) return `\`git checkout ${rest.join(' ')}\` ${DISCARD}`;
    if (sub === 'restore' && whole) {
        const onlyStaged = flags.some(f => f === '--staged' || f === '-S') && !flags.some(f => f === '--worktree' || f === '-W');
        if (!onlyStaged) return `\`git restore ${rest.join(' ')}\` ${DISCARD}`;
    }
    if (sub === 'switch' && flags.some(f => f === '-f' || f === '--force' || f === '--discard-changes')) return `\`git switch ${rest.join(' ')}\` ${DISCARD}`;
    if (sub === 'stash' && (specs[0] === 'drop' || specs[0] === 'clear')) return `\`git stash ${specs[0]}\` deletes stashed work for good. Apply it, or leave it for the owner.`;
    return '';
}

/** Why this command line is refused, or '' when it may run. */
export function guardRefusal(command) {
    for (const segment of commandSegments(command)) {
        const words = commandWords(segment);
        if (isGit(words[0])) {
            const { sub, rest } = gitSubcommand(words);
            if (sub === 'push' && rest.some(w => w === '--force' || w === '-f' || /^-[a-z]*f[a-z]*$/.test(w) || /^\+/.test(w))) {
                return 'a force push rewrites published history. Push normally; if history really must change, the owner does it.';
            }
            if (sub === 'reset' && rest.includes('--hard')) return '`git reset --hard` discards uncommitted work. Use `git stash` or a new commit instead.';
            if (sub === 'clean' && rest.some(w => /^-[a-z]*f/.test(w) || w === '--force')) return '`git clean -f` deletes untracked files for good. List them with `git clean -n` and remove what you have read.';
            const discard = discardProblem(sub, rest);
            if (discard) return discard;
        }
        if (DELETE.test(words[0] || '')) {
            const flags = words.slice(1).filter(w => w.startsWith('-'));
            const recursive = flags.some(f => /^-[a-z]*r/i.test(f) || /^--recursive$/i.test(f) || /^-Recurse$/i.test(f));
            if (recursive) {
                const targets = words.slice(1).filter(w => !w.startsWith('-') && !/^[0-9&]*[<>]/.test(w));   // not 2>/dev/null
                if (!targets.length) return 'a recursive delete with no target.';
                for (const t of targets) {
                    const why = rmTargetProblem(t);
                    if (why) return `recursive delete: ${why}. Read what is there, then delete it by its literal absolute path.`;
                }
            }
        }
    }
    if (/\bgit\b[^\n]*\bcommit\b/.test(command)) {
        const trailer = command.split('\n').find(line => /Co-Authored-By:.*(anthropic\.com|\bclaude\b)|claude\.ai\/code\/session/i.test(line));
        if (trailer) return `the commit message carries an AI attribution line ("${trailer.trim().slice(0, 40)}"). The AI that wrote a change does not sign the repository.`;
    }
    return '';
}

function hook() {
    let input;
    try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return 0; }
    const command = input?.tool_input?.command;
    if (typeof command !== 'string') return 0;
    const why = guardRefusal(command);
    if (!why) return 0;
    process.stderr.write(`PLUT_OS guard: ${why}\n(The owner can run it in their own terminal; this hook only sees an AI's tool calls.)\n`);
    return 2;
}

if (isEntry(import.meta.url)) process.exit(hook());
