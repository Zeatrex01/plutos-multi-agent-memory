// What a Bash or PowerShell tool call will run, as the hooks need to see it: the simple commands
// of a command line and their words. Not a shell parser — quotes are only trimmed off words —
// so a check built on it should fail towards letting a command through.
export function commandSegments(command) {
    return String(command).split(/&&|\|\||[;|\n]/)
        .map(part => part.trim().split(/\s+/).filter(Boolean).map(w => w.replace(/^["']|["']$/g, '')))
        .filter(words => words.length);
}

/** The words of one simple command with `FOO=bar`, `sudo`, `env`, `time` and similar prefixes dropped. */
export function commandWords(words) {
    let i = 0;
    while (i < words.length && (/^\w+=/.test(words[i]) || /^(sudo|env|time|nice|command|exec)$/.test(words[i]))) i++;
    return words.slice(i);
}

/** A path as the platform reads it. Git Bash on Windows writes `C:\Users` as `/c/Users`, which
 * path.resolve would read as `C:\c\Users`. */
export function nativePath(p, platform = process.platform) {
    return platform === 'win32' && /^\/[a-zA-Z](\/|$)/.test(p) ? `${p[1].toUpperCase()}:\\${p.slice(3).replace(/\//g, '\\')}` : p;
}

/** `git`, `/usr/bin/git` or `git.exe` — the program a command starts with is git. */
export const isGit = word => /(^|[\\/])git(\.exe)?$/i.test(word || '');

/** For a git command: its subcommand and the words after it, git's own options (`-C dir`, `-c k=v`) skipped. */
export function gitSubcommand(words) {
    let i = 1;
    let dir = null;
    for (; i < words.length && words[i].startsWith('-'); i++) {
        if (words[i] === '-C' && words[i + 1]) dir = words[++i];
        else if (words[i] === '-c' || words[i] === '--git-dir' || words[i] === '--work-tree') i++;
    }
    return { sub: words[i] || '', rest: words.slice(i + 1), dir };
}
