// The CLI around the kit and the owner's questions: init installs the kit and the launcher (the
// gap B14 named) and nothing else, status reports the project in one screen, and a question is
// answered from the terminal the same way as at the dashboard. Profiles and system roles were cut
// on 2026-11-04: the brief carries no profile line or charter, `plutos full` is gone, and a ticket
// from before the cut (a profile_full casting) is answered without error and applies nothing.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-cli-profile-'));
const home = path.join(temp, 'home');
const project = path.join(temp, 'project');
fs.mkdirSync(project, { recursive: true });
process.env.PLUTOS_HOME = home;

const { createApproval, readApproval, answerApproval, approvalsDir, askSeal } = await import('../lib/approvals.mjs');
const { applyApprovedSideEffects } = await import('../lib/approval-effects.mjs');
const { buildBrief } = await import('../lib/continuity.mjs');

let passed = 0, failed = 0;
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ok  ${name}`); } else { failed++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); } };
const throws = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };
const env = { ...process.env, PLUTOS_HOME: home };
const cli = (...args) => spawnSync(process.execPath, [path.join(root, 'cli.mjs'), ...args], { cwd: temp, encoding: 'utf8', env });

try {
    const help = cli('--help');
    check('--help prints the usage and installs nothing', help.status === 0 && /Usage|USAGE|plutos/i.test(help.stdout) && !fs.existsSync(path.join(temp, 'AGENTS.md')) && !fs.existsSync(path.join(temp, '.mcp.json')), help.stdout.slice(0, 200));
    check('the usage no longer offers plutos full', !/\bfull\b/.test(help.stdout), help.stdout);
    // --- install ---------------------------------------------------------------------------
    const init = cli('init', project);
    check('plutos init succeeds', init.status === 0, init.stderr || init.stdout);
    check('init lands the kit and the launcher', fs.existsSync(path.join(project, '.plutos', 'plutos-launch.mjs')) && fs.existsSync(path.join(project, 'docs', 'handoff', 'BOARD.md')));
    check('init writes no profile', !fs.existsSync(path.join(project, '.plutos', 'profile.json')) && !/Profile:/.test(init.stdout), init.stdout);
    check('init says what comes next', /Next: connect an AI/.test(init.stdout), init.stdout);
    check('init lists the files it wrote, the board among them', /Written: .*docs\/handoff\/BOARD\.md/.test(init.stdout), init.stdout);

    const again = cli('init', project);
    check('init is idempotent', again.status === 0 && /existing files untouched/.test(again.stdout), again.stdout + again.stderr);

    const legacy = cli(project);
    check('"node cli.mjs <path>" without a command still runs init', legacy.status === 0 && /PLUT_OS · install/.test(legacy.stdout), legacy.stderr);
    const unknown = cli('frobnicate', project);
    check('an unknown command fails with the usage', unknown.status === 1 && /Unknown command "frobnicate"/.test(unknown.stderr) && /Usage: plutos/.test(unknown.stderr));
    const full = cli('full', project);
    check('plutos full is an unknown command', full.status === 1 && /Unknown command "full"/.test(full.stderr), full.stderr);
    const notInstalled = cli('status', path.join(temp, 'elsewhere'));
    check('status on a folder without the kit says to init first', notInstalled.status === 1 && /does not exist|has no PLUT_OS kit/.test(notInstalled.stderr), notInstalled.stderr);

    const status = cli('status', project);
    check('status reports the readiness stage', status.status === 0 && /Readiness: unmapped/.test(status.stdout), status.stdout + status.stderr);
    check('status reports the board, approvals and clients, and no profile or cast', /Board:\s+\d+ entries/.test(status.stdout) && /Approvals: 0 pending/.test(status.stdout) && /Clients:/.test(status.stdout)
        && !/Profile:|Cast:/.test(status.stdout), status.stdout);

    // --- the brief carries no profile line and no charter ----------------------------------
    const briefs = [buildBrief(project, { ai: 'Claude Code', full: true }), buildBrief(project, { ai: 'Claude Code' })];
    check('neither brief names a profile or a system role', briefs.every(b => !/Profile:|Your system role|proposal/.test(b)), briefs[0].slice(0, 300));

    // --- a question answered from the terminal ---------------------------------------------
    // `plutos approve` and `plutos reject` need an interactive terminal (O14, 2026-11-04), so a
    // spawned CLI cannot answer: the one CLI check below is that refusal. The answer the command
    // then records is answerApproval with via 'local' (cli.mjs `answer()`), exercised directly.
    const ticket = createApproval(project, { agent: 'Claude Code', question: 'Delete the orphaned rows?', context: 'They are 200 rows in orders_legacy.' });
    check('a new ticket is a plain T0 question', ticket.tier === 'T0' && ticket.action === null);
    const listed = cli('approvals', project);
    check('plutos approvals lists the question with its ticket', listed.status === 0 && listed.stdout.includes(ticket.id) && /\[T0\] Claude Code: Delete the orphaned rows\?/.test(listed.stdout), listed.stdout);
    const noTerminal = cli('approve', ticket.id, project, '--note', 'go');
    check('plutos approve without a terminal exits 1, says so, and leaves the ticket pending',
        noTerminal.status === 1 && /plutos approve needs an interactive terminal/.test(noTerminal.stderr) && !/Approved/.test(noTerminal.stdout)
        && readApproval(project, ticket.id).status === 'pending' && readApproval(project, ticket.id).note === null, noTerminal.stdout + noTerminal.stderr);
    const approved = answerApproval(project, ticket.id, { decision: 'approved', note: 'go', via: 'local' });
    check('the terminal answer records the note as local', approved.status === 'approved' && readApproval(project, ticket.id).status === 'approved' && readApproval(project, ticket.id).note === 'go' && readApproval(project, ticket.id).answeredVia === 'local');
    check('approving twice is refused', /already approved/.test(throws(() => answerApproval(project, ticket.id, { decision: 'approved', via: 'local' }))));

    // A ticket written before the cut carries a profile_full action and is T2; it still answers
    // at the computer, and nothing is applied (lib/approval-effects.mjs returns null).
    const now = Date.now();
    const old = { id: `ask-${now.toString(36)}-legacy`, agent: 'Codex', question: 'Full profile?', context: 'Seats: none', options: null,
        action: { kind: 'profile_full', projectRoot: project, packageId: 'profile:full', version: 'a'.repeat(64), target: 'full', proposal: { kernel: 'Claude Code', casts: [] } },
        status: 'pending', note: null, option: null, tier: 'T2', createdAt: now, expiresAt: now + 30 * 60_000, answeredAt: null, answeredVia: null };
    old.askSeal = askSeal(old);
    fs.writeFileSync(path.join(approvalsDir(project), `${old.id}.json`), JSON.stringify(old, null, 2));
    check('plutos approvals lists a ticket from before the cut with its action', cli('approvals', project).stdout.includes(`${old.id}  [T2] Codex: Full profile? · profile_full profile:full`), cli('approvals', project).stdout);
    const oldApproved = answerApproval(project, old.id, { decision: 'approved', via: 'local' });
    check('a ticket from before the cut is approved without error and applies nothing',
        oldApproved.status === 'approved' && applyApprovedSideEffects(project, oldApproved) === null && readApproval(project, old.id).status === 'approved'
        && !readApproval(project, old.id).actionResult && !fs.existsSync(path.join(project, 'docs', 'handoff', 'SYSTEM.md')) && !fs.existsSync(path.join(project, '.plutos', 'profile.json')));

    const third = createApproval(project, { agent: 'Codex', question: 'Plain question?' });
    const rejected = answerApproval(project, third.id, { decision: 'rejected', note: 'not now', via: 'local' });
    check('a rejection records the note and runs nothing', rejected.status === 'rejected' && applyApprovedSideEffects(project, rejected) === null
        && readApproval(project, third.id).status === 'rejected' && readApproval(project, third.id).note === 'not now');
    check('answering an unknown ticket says so', /No such question/.test(throws(() => answerApproval(project, 'ask-nope-000000', { decision: 'approved', via: 'local' }))));
} finally {
    fs.rmSync(temp, { recursive: true, force: true });
}
console.log(`CLI: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
