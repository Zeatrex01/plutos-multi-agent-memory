#!/usr/bin/env node
// Claim check: a "done" is held against git and the disk before the session stops.
//
// Coding agents overstate their work, and asking the model to check itself does not catch it.
// This hook checks with no model call: it
// reads the last assistant message and tests the claims a script can test.
//
//   - "the tests passed": the push gate's record of the tree the tests last passed on must be
//     the tree a commit of the work would carry now (lib/push-gate.mjs). Checked only in a
//     project that keeps that record.
//   - "pushed": HEAD must not be ahead of its upstream.
//   - "created `path`": the path must exist, unless git knows it as deleted.
//   - the unpushed diff of test files: an added focused or skipped test, or assertions removed
//     while the message says the tests passed.
//   - "fixed" or "the tests pass" while the unpushed diff changes a test file together with
//     other code and the message does not name that test file: a fix that edits the tests must
//     say what the test change is (research item 1: a weakened or deleted assertion).
//   - "the tests passed" with no passing stamp for this tree, while the transcript shows no test
//     command run in this session, or the last one failed. Without a readable transcript, or
//     one that records no tool calls, this is not checked (Codex sends the message only).
//   - "done": a session that made commits or changes and has no session record since it began is
//     sent back to call session_end (lib/session-close.mjs; it began at its transcript's first
//     timestamp). Without a transcript this is not checked.
//
//   node lib/claim-check.mjs             The Stop hook for Claude Code and Codex, which send the
//                                        same stdin fields (`cwd`, `session_id`, `stop_hook_active`,
//                                        `last_assistant_message`) and take the same answer.
//   node lib/claim-check.mjs install     Switches it on or off for a project, the same as the
//   node lib/claim-check.mjs uninstall   dashboard's Hooks panel (lib/project-hooks.mjs).
//   … install --codex [dir]              The same for Codex, in the project's .codex/hooks.json;
//                                        Codex then asks the owner to trust it in /hooks.
//
// A finding sends the turn back once, with the reason. If the session
// stops again with it still standing, the stop goes through and the claim is recorded as failing
// the check; the next brief's housekeeping shows it. The record is a file in the git directory,
// so it is never committed. Anything the check cannot work out passes: it catches a false "done",
// it is not a lock.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { passedTree, workingTree } from './push-gate.mjs';
import { unrecordedWork } from './session-close.mjs';
import { isEntry } from './entry.mjs';

const LOG = 'plutos-claim-check.log';
const LOG_BYTES = 64 * 1024;

// windowsHide: the brief and the dashboard read the record too, and a bare git child flashes a console.
const git = (dir, args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
const tryGit = (dir, args) => { try { return git(dir, args); } catch { return null; } };

// Claims are read per sentence, in English and Turkish, because the owner's sessions report in
// Turkish. A sentence that negates, asks or makes a condition claims nothing.
const NEGATED = /\b(?:not|no|never|without|unless|if|whether)\b|n't\b|\?|değil|henüz|olmadan|(?:^|\s)m[ıiuü](?:\s|$)/i;
const TESTS_PASSED = /\b(?:all \d+ (?:suites|tests|checks) passed|(?:tests?|suites?|checks?) (?:all )?passed|npm test passed|\d+ passed, 0 failed)\b|(?:testler|paket(?:ler)?)(?:in)? (?:hepsi )?geçti|testler geçiyor/i;
const PUSHED = /\b(?:pushed|is on origin)\b|gönderdim|push ettim|gönderildi/i;
const CREATED = /\b(?:created|added|wrote|new file)\b|oluşturdum|ekledim|yazdım|yeni dosya/i;
const FINISHED = /\b(?:done|finished|completed?|wrapped up)\b|bitti|bitirdim|tamamlandı|tamamladım/i;
const FOCUSED = /\b(?:it|test|describe)\.(?:only|skip)\s*\(|\bx(?:it|describe|test)\s*\(|\{\s*(?:only|skip)\s*:\s*true|@pytest\.mark\.skip|\bt\.Skip\(/;
const ASSERTION = /\b(?:assert(?:\.\w+)?|expect|check)\s*\(/;
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__)\/|[-_.](?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:py|go)$/;
const FIXED = /\b(?:fix(?:ed|es)?|pass(?:es|ing)?|green)\b|düzelt(?:tim|ildi)|geçiyor/i;
// A test command in a Bash call: the project's runners, the push gate's recorder and the common
// runners of other stacks. A plain list; extend it here.
const TEST_COMMAND = /(?:^|[\s;&|(])(?:npm (?:run )?(?:test|check)|push-gate\.mjs run|node tools\/(?:run-all-tests|[\w.-]+-test)\.mjs|pytest|go test|cargo test|vitest|jest|make (?:test|check)|[\w.-]*test[\w.-]*\.bat|godot\b.*run_tests)\b/i;
const RUN_FAILED = /\b[Ee]xit code [1-9]|\b[1-9]\d* (?:failed|failing|failures?)\b|\bnot ok\b|npm ERR!|\bFAIL(?:ED|URE)?\b/;

const claims = (text, re) => text.split(/(?<=[.!])\s+|\n/).filter(s => re.test(s) && !NEGATED.test(s));

/** Backticked project paths in a text: `lib/x.mjs`, `docs/a.md:12`; not URLs, flags or globs. */
function quotedPaths(text) {
    return [...text.matchAll(/`([^`\s*?<>|]+\/[^`\s*?<>|]*\.[A-Za-z0-9]{1,8})(?::\d+(?:-\d+)?)?`/g)].map(m => m[1])
        .filter(p => !/^[a-z]+:\/\//i.test(p) && !p.startsWith('-') && !p.startsWith('~') && !path.isAbsolute(p));
}

/** Every finding about `message` in the repository at `dir`: [{ key, detail }]. The key names the
 *  problem, not its wording: one stale test run, one unpushed HEAD, one missing path. */
export function checkClaims(dir, message, { transcriptPath, session = '' } = {}) {
    const top = tryGit(dir, ['rev-parse', '--show-toplevel']);
    if (!top || typeof message !== 'string' || !message.trim()) return [];
    const findings = [];
    const claimsPassed = claims(message, TESTS_PASSED).length > 0;

    if (claimsPassed) {
        const passed = passedTree(top);
        let now = null;
        try { now = workingTree(top); } catch { /* not checkable */ }
        if (passed && now && passed !== now) {
            const changed = (tryGit(top, ['diff', '--name-only', passed, now]) || '').split('\n').filter(Boolean);
            const list = changed.length ? `: ${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ` and ${changed.length - 5} more` : ''}` : '';
            findings.push({ key: `tests:${passed}`, detail: `The message says the tests passed, but the work changed after the last passing run${list}. Run them again, or say which version they passed on.` });
        }
        // No stamp for this tree: the transcript must show a test command that ran and passed.
        const runs = passed && now && passed === now ? null : testRuns(transcriptPath);
        if (runs && !runs.ran) findings.push({ key: `notests:${session}`, detail: 'The message says the tests pass, but no test command ran in this session. Run them, or say they were not run.' });
        else if (runs && runs.lastFailed) findings.push({ key: `notests:${session}`, detail: 'The message says the tests pass, but the last test command in this session failed. Run them again, or say which failed.' });
    }

    if (claims(message, PUSHED).length) {
        const ahead = Number(tryGit(top, ['rev-list', '--count', '@{u}..HEAD']));
        if (ahead > 0) findings.push({ key: `push:${tryGit(top, ['rev-parse', 'HEAD'])}`, detail: `The message says the work was pushed, but HEAD is ${ahead} commit(s) ahead of its upstream.` });
    }

    const named = claims(message, CREATED).flatMap(quotedPaths)
        .filter(p => fs.existsSync(path.join(top, p.split('/')[0])) && !fs.existsSync(path.join(top, p)));
    if (named.length) {
        const deleted = new Set([...(tryGit(top, ['log', '--diff-filter=D', '--name-only', '--format=', '-n', '200']) || '').split('\n'),
            ...(tryGit(top, ['diff', '--name-only', '--diff-filter=D', 'HEAD']) || '').split('\n')]);
        for (const p of new Set(named)) if (!deleted.has(p)) findings.push({ key: `path:${p}`, detail: `\`${p}\` is named as created, but it does not exist.` });
    }

    // The unpushed diff, or the uncommitted one without an upstream: what this work changes.
    const base = tryGit(top, ['rev-parse', '--verify', '-q', '@{u}']) ? '@{u}' : 'HEAD';
    let file = '', removed = 0, added = 0;
    for (const line of (tryGit(top, ['diff', '-U0', base]) || '').split('\n')) {
        if (line.startsWith('+++ ')) { file = line.replace(/^\+\+\+ (?:b\/)?/, ''); continue; }
        if (line.startsWith('--- ') || !TEST_FILE.test(file)) continue;
        if (line.startsWith('+') && FOCUSED.test(line)) findings.push({ key: `focused:${file}:${line.trim()}`, detail: `${file} gains \`${line.slice(1).trim().slice(0, 60)}\`: a focused or skipped test hides the others.` });
        if (ASSERTION.test(line)) { if (line.startsWith('-')) removed++; else if (line.startsWith('+')) added++; }
    }
    if (claimsPassed && removed > added) findings.push({ key: `assertions:${removed - added}`, detail: `The test files lose ${removed - added} assertion(s) in this work while the message says the tests passed. Say why each went.` });

    // A fix that edits the tests with the code must say what the test change is: the test file
    // named in the message (path or basename), or "test"/"flaky" in the same sentence as its
    // stem (`a` for tools/a-test.mjs), counts as said.
    if (claimsPassed || claims(message, FIXED).length) {
        const changed = (tryGit(top, ['diff', '--name-only', base]) || '').split('\n').filter(Boolean);
        const tests = changed.filter(f => TEST_FILE.test(f));
        const stem = f => path.posix.basename(f).replace(/[-_.](?:test|spec)\.[^.]+$|\.[^.]+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const explained = f => new RegExp(`(?:test|flaky)[^.\n]{0,60}\\b${stem(f)}\\b|\\b${stem(f)}\\b[^.\n]{0,60}(?:test|flaky)`, 'i').test(message);
        const unnamed = tests.filter(f => !message.includes(f) && !message.includes(path.posix.basename(f)) && !explained(f));
        if (tests.length && tests.length < changed.length && unnamed.length) {
            findings.push({ key: `testfix:${session}`, detail: `The message says the work is fixed or passes, but the work since ${base} changes ${unnamed.join(', ')} with the code. Say what the test change is and why: a weakened or deleted assertion is a fix that hides the failure.` });
        }
    }

    if (claims(message, FINISHED).length) {
        const work = unrecordedWork(top, transcriptPath);
        if (work) {
            const what = [work.commits.length ? `made ${work.commits.length} commit(s)` : '', work.changed ? `left ${work.changed} changed file(s)` : ''].filter(Boolean).join(' and ');
            findings.push({ key: `session:${session}`, detail: `The message says the work is done, but this session ${what} and is not recorded. Call session_end (learned with its sources, decided, story) before you stop.` });
        }
    }
    return findings;
}

/** The text a blocked stop hands back: a few lines. */
function blockReason(findings) {
    return 'PLUT_OS claim check: the final message claims something git or the disk does not show.\n'
        + findings.map(f => `- ${f.detail}`).join('\n')
        + '\nFix it, or correct the message ("not verified" is a finished result). The check runs again when you stop.';
}

function logPath(dir) {
    const top = tryGit(dir, ['rev-parse', '--show-toplevel']);
    const file = top && tryGit(top, ['rev-parse', '--git-path', LOG]);
    return file ? path.resolve(top, file) : null;
}

/** The claim check's record: [{ at, session, phase: 'blocked' | 'failed', findings }]. */
export function claimLog(dir) {
    const file = logPath(dir);
    let text = '';
    try { text = file ? fs.readFileSync(file, 'utf8') : ''; } catch { return []; }
    return text.split('\n').flatMap(line => { try { return line ? [JSON.parse(line)] : []; } catch { return []; } });
}

function record(dir, entry) {
    const file = logPath(dir);
    if (!file) return;
    try {
        let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        if (text.length > LOG_BYTES) text = text.slice(text.indexOf('\n', text.length - LOG_BYTES / 2) + 1);
        fs.writeFileSync(file, text + JSON.stringify(entry) + '\n');
    } catch { /* a read-only checkout still stops */ }
}

/** The hook's answer to one Stop event: `{}`, or a block with its reason. Each finding sends a
 *  session back once; a stop that follows a block records what still stands as failing. */
export function stopHook(input, { now = new Date() } = {}) {
    const dir = input?.cwd || process.cwd();
    const findings = checkClaims(dir, input?.last_assistant_message ?? lastAssistantText(input?.transcript_path),
        { transcriptPath: input?.transcript_path, session: String(input?.session_id || '') });
    if (!findings.length) return {};
    const session = String(input?.session_id || '');
    const sent = new Set(claimLog(dir).filter(e => e.session === session && e.phase === 'blocked').flatMap(e => e.findings.map(f => f.key)));
    const standing = findings.filter(f => sent.has(f.key));
    const fresh = findings.filter(f => !sent.has(f.key));
    if (standing.length && input?.stop_hook_active) record(dir, { at: now.toISOString(), session, phase: 'failed', findings: standing });
    if (!fresh.length || input?.stop_hook_active) return {};
    record(dir, { at: now.toISOString(), session, phase: 'blocked', findings: fresh });
    return { decision: 'block', reason: blockReason(fresh) };
}

/** The test commands a transcript's Bash calls ran: { ran, lastFailed }, or null when the
 *  transcript cannot be read or records no tool call at all (a client the check does not know).
 *  Claude Code's JSONL: a `tool_use` block in an assistant row, its `tool_result` block, with
 *  `is_error`, in a later user row; subagent rows (isSidechain, parent_tool_use_id) are skipped. */
function testRuns(transcript) {
    let lines = [];
    try { lines = fs.readFileSync(transcript, 'utf8').split('\n'); } catch { return null; }
    let seen = false, ran = false, lastFailed = false;
    const pending = new Set();
    for (const line of lines) {
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        if (!row || row.isSidechain || row.parent_tool_use_id) continue;
        const content = row.message?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
            if (block?.type === 'tool_use') {
                seen = true;
                if (typeof block.input?.command === 'string' && TEST_COMMAND.test(block.input.command)) pending.add(block.id);
            } else if (block?.type === 'tool_result' && pending.delete(block.tool_use_id)) {
                const text = Array.isArray(block.content) ? block.content.map(c => c?.text || '').join('\n') : String(block.content || '');
                ran = true;
                lastFailed = Boolean(block.is_error) || RUN_FAILED.test(text);
            }
        }
    }
    return seen ? { ran, lastFailed } : null;
}

// A client that sends no last_assistant_message: the last assistant text of the transcript.
function lastAssistantText(transcript) {
    let lines = [];
    try { lines = fs.readFileSync(transcript, 'utf8').trim().split('\n'); } catch { return ''; }
    for (let i = lines.length - 1; i >= 0; i--) {
        try {
            const content = JSON.parse(lines[i])?.message;
            if (content?.role !== 'assistant') continue;
            const text = Array.isArray(content.content) ? content.content.filter(c => c?.type === 'text').map(c => c.text).join('\n') : String(content.content || '');
            if (text.trim()) return text;
        } catch { /* a partial last line */ }
    }
    return '';
}

if (isEntry(import.meta.url)) {
    const [mode, ...rest] = process.argv.slice(2);
    const codex = rest.includes('--codex');
    const dir = rest.find(a => a !== '--codex') || process.cwd();
    // No top-level await: the dashboard bundle is CommonJS (build.mjs), and this file is in it.
    if (mode === 'install' || mode === 'uninstall') {
        import('./project-hooks.mjs').then(({ setProjectHook, setCodexClaimCheck }) => {
            const status = codex ? setCodexClaimCheck(dir, mode === 'install') : setProjectHook(dir, 'claim-check', mode === 'install');
            console.log(`claim check ${status.on ? 'on' : 'off'} in ${status.settingsPath}`);
            if (codex && status.on) console.log('Codex runs it once you trust it: open /hooks in Codex in this project.');
        }).catch(e => { console.error(e.message); process.exitCode = 1; });
    } else {
        let out = {};
        try { out = stopHook(JSON.parse(fs.readFileSync(0, 'utf8'))); } catch { /* unreadable input: let the stop go */ }
        process.stdout.write(JSON.stringify(out), () => process.exit(0));
    }
}
