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
    // A bare `node cli.mjs` used to run init in the current folder (field report 2026-11-14).
    const emptyDir = path.join(temp, 'empty');
    fs.mkdirSync(emptyDir, { recursive: true });
    const bare = spawnSync(process.execPath, [path.join(root, 'cli.mjs')], { cwd: emptyDir, encoding: 'utf8', env });
    check('a bare node cli.mjs prints the usage, exits 0 and writes nothing', bare.status === 0 && /Usage: plutos/.test(bare.stdout) && /\binit\b/.test(bare.stdout)
        && fs.readdirSync(emptyDir).length === 0, bare.stdout.slice(0, 200) + bare.stderr);
    // plutos rebind <new path> [--from <old path>] calls lib/rebind.mjs; these refusals come before it.
    check('the usage offers rebind', /rebind <new path> \[--from <old path>\]/.test(help.stdout), help.stdout.slice(0, 200));
    const rebindBare = cli('rebind');
    check('rebind without a path prints its usage and exits 1', rebindBare.status === 1 && /Usage: plutos rebind <new path>/.test(rebindBare.stderr), rebindBare.stderr);
    const rebindMissing = cli('rebind', path.join(temp, 'nowhere'));
    check('rebind to a folder that does not exist is refused', rebindMissing.status === 1 && /does not exist/.test(rebindMissing.stderr), rebindMissing.stderr);
    const rebindNoFrom = cli('rebind', temp, '--from');
    check('rebind --from without a path is refused', rebindNoFrom.status === 1 && /--from needs the old path/.test(rebindNoFrom.stderr), rebindNoFrom.stderr);
    // --- install ---------------------------------------------------------------------------
    const init = cli('init', project);
    check('plutos init succeeds', init.status === 0, init.stderr || init.stdout);
    check('init lands the kit and the launcher', fs.existsSync(path.join(project, '.plutos', 'plutos-launch.mjs')) && fs.existsSync(path.join(project, 'docs', 'handoff', 'BOARD.md')));
    check('init writes no profile', !fs.existsSync(path.join(project, '.plutos', 'profile.json')) && !/Profile:/.test(init.stdout), init.stdout);
    check('init says what comes next', /Next: connect an AI/.test(init.stdout), init.stdout);
    check('init lists the files it wrote, the board among them', /Written: .*docs\/handoff\/BOARD\.md/.test(init.stdout), init.stdout);

    const again = cli('init', project);
    check('init is idempotent', again.status === 0 && /existing files untouched/.test(again.stdout), again.stdout + again.stderr);

    // --- the install record and the launcher, without the dashboard (plan 2026-11-14, stage 2) ---
    const installFile = path.join(home, 'install.json');
    let recorded = null;
    try { recorded = JSON.parse(fs.readFileSync(installFile, 'utf8')); } catch { recorded = null; }
    check('init records this PLUT_OS in install.json, which the launchers read', recorded && path.resolve(recorded.appRoot) === root, JSON.stringify(recorded) + init.stdout);
    const stubFile = path.join(project, '.plutos', 'plutos-launch.mjs');
    const currentStub = fs.readFileSync(stubFile, 'utf8');
    check('the launcher stub tells an unregistered machine to run init, not to launch the dashboard',
        /node cli\.mjs init/.test(currentStub) && !/Launch PLUT_OS once/.test(currentStub), currentStub.slice(0, 200));
    fs.rmSync(installFile);
    fs.writeFileSync(stubFile, '// Generated by PLUT_OS — do not edit. An older launcher.\n');
    const reconnect = cli('connect', 'claude-code', project);
    check('connect records the install again and heals an older generated launcher',
        reconnect.status === 0 && fs.existsSync(installFile) && fs.readFileSync(stubFile, 'utf8') === currentStub && /launcher .* up to date/.test(reconnect.stdout), reconnect.stdout + reconnect.stderr);
    const rebindDry = cli('rebind', project, '--from', path.join(temp, 'old-place'), '--dry-run');
    fs.rmSync(installFile);
    cli('rebind', project, '--from', path.join(temp, 'old-place'), '--dry-run');
    check('rebind --dry-run writes no install record', !fs.existsSync(installFile), rebindDry.stdout + rebindDry.stderr);
    const rebound = cli('rebind', project, '--from', path.join(temp, 'old-place'));
    check('rebind records the install', fs.existsSync(installFile), rebound.stdout + rebound.stderr);

    // Another usable PLUT_OS copy already recorded (the owner's real one): a worktree or older checkout
    // running connect must not repoint every project's launcher at itself; --register does it on purpose.
    const otherCopy = path.join(temp, 'other-plutos');
    fs.mkdirSync(path.join(otherCopy, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(otherCopy, 'lib', 'launch.mjs'), 'export function launch() {}\n');
    fs.writeFileSync(installFile, JSON.stringify({ appRoot: otherCopy }));
    const kept = cli('connect', 'claude-code', project);
    check('connect leaves another usable install recorded and says how to take it over',
        kept.status === 0 && JSON.parse(fs.readFileSync(installFile, 'utf8')).appRoot === otherCopy && /--register/.test(kept.stdout), kept.stdout + kept.stderr);
    const keptInit = cli('init', project);
    check('init leaves it too', JSON.parse(fs.readFileSync(installFile, 'utf8')).appRoot === otherCopy, keptInit.stdout);
    const taken = cli('connect', 'claude-code', project, '--register');
    check('connect --register records this copy', taken.status === 0 && path.resolve(JSON.parse(fs.readFileSync(installFile, 'utf8')).appRoot) === root, taken.stdout + taken.stderr);
    fs.rmSync(path.join(otherCopy, 'lib', 'launch.mjs'));
    fs.writeFileSync(installFile, JSON.stringify({ appRoot: otherCopy }));
    cli('connect', 'claude-code', project);
    check('a recorded install that can no longer start is replaced without --register',
        path.resolve(JSON.parse(fs.readFileSync(installFile, 'utf8')).appRoot) === root);

    // --- the dashboard's switches as CLI verbs (stage 3) --------------------------------------
    const hooksList = cli('hooks', project);
    check('hooks lists the project hooks, the watcher and the capture', hooksList.status === 0
        && ['brief', 'guard', 'session-close', 'claim-check', 'subagent', 'watcher', 'capture'].every(id => new RegExp(`^${id}\\s+(on|off)`, 'm').test(hooksList.stdout)), hooksList.stdout + hooksList.stderr);
    const settingsFile = path.join(project, '.claude', 'settings.local.json');
    const guardOn = cli('hooks', 'on', 'guard', project);
    check('hooks on guard writes the guard into the project\'s local settings', guardOn.status === 0 && /guard hook on/.test(guardOn.stdout)
        && fs.readFileSync(settingsFile, 'utf8').includes('guard.mjs'), guardOn.stdout + guardOn.stderr);
    const guardOff = cli('hooks', 'off', 'guard', project);
    check('hooks off guard needs an interactive terminal and leaves the guard on', guardOff.status === 1 && /interactive terminal/.test(guardOff.stderr)
        && fs.readFileSync(settingsFile, 'utf8').includes('guard.mjs'), guardOff.stderr);
    const briefOff = cli('hooks', 'off', 'brief', project);
    check('hooks off brief needs no terminal', briefOff.status === 0 && /brief hook off/.test(briefOff.stdout) && /^brief\s+off/m.test(cli('hooks', 'list', project).stdout), briefOff.stdout + briefOff.stderr);
    const subagentOff = cli('hooks', 'off', 'subagent', project);
    check('hooks off subagent needs no terminal and removes the SubagentStart hook', subagentOff.status === 0 && /subagent hook off/.test(subagentOff.stdout)
        && /^subagent\s+off/m.test(cli('hooks', project).stdout) && !fs.readFileSync(settingsFile, 'utf8').includes('subagent-hook.mjs'), subagentOff.stdout + subagentOff.stderr);
    const subagentOn = cli('hooks', 'on', 'subagent', project);
    check('hooks on subagent writes it for every agent type', subagentOn.status === 0 && /^subagent\s+on\s+SubagentStart/m.test(cli('hooks', project).stdout)
        && fs.readFileSync(settingsFile, 'utf8').includes('subagent-hook.mjs'), subagentOn.stdout + subagentOn.stderr);
    const unknownHook = cli('hooks', 'on', 'nope', project);
    check('an unknown hook id is refused with the ids', unknownHook.status === 1 && /Unknown hook "nope"/.test(unknownHook.stderr) && /watcher, capture/.test(unknownHook.stderr), unknownHook.stderr);
    // Switching on the watcher (board-fed turns) or the capture (paid claude -p runs) is the owner's:
    // without a terminal it is refused and nothing is installed. The libraries' own suites cover the install.
    const watcherOn = cli('hooks', 'on', 'watcher', project, '--agent', 'Claude');
    check('hooks on watcher needs an interactive terminal and installs nothing', watcherOn.status === 1 && /interactive terminal/.test(watcherOn.stderr)
        && /^watcher\s+off/m.test(cli('hooks', project).stdout), watcherOn.stdout + watcherOn.stderr);
    const watcherOff = cli('hooks', 'off', 'watcher', project);
    check('hooks off watcher needs no terminal', watcherOff.status === 0 && /^watcher\s+off/m.test(cli('hooks', project).stdout), watcherOff.stdout + watcherOff.stderr);
    const captureOn = cli('hooks', 'on', 'capture', project);
    check('hooks on capture needs an interactive terminal and stays off', captureOn.status === 1 && /interactive terminal/.test(captureOn.stderr)
        && /^capture\s+off/m.test(cli('hooks', project).stdout), captureOn.stdout + captureOn.stderr);
    const captureOff = cli('hooks', 'off', 'capture', project);
    check('hooks off capture needs no terminal', captureOff.status === 0 && /^capture\s+off/m.test(cli('hooks', project).stdout), captureOff.stdout + captureOff.stderr);

    fs.writeFileSync(stubFile, '// Generated by PLUT_OS — do not edit. An older launcher.\n');
    const preview = cli('repair', project);
    check('repair previews and writes nothing', preview.status === 0 && /plutos-launch\.mjs/.test(preview.stdout) && /no project file written/.test(preview.stdout)
        && fs.readFileSync(stubFile, 'utf8').includes('An older launcher'), preview.stdout + preview.stderr);
    const applied = cli('repair', project, '--apply');
    check('repair --apply writes the change and names its backup', applied.status === 0 && fs.readFileSync(stubFile, 'utf8') === currentStub && /Backup [\da-f-]{36}/.test(applied.stdout), applied.stdout + applied.stderr);
    const restored = cli('repair', project, '--restore');
    check('repair --restore undoes the latest repair', restored.status === 0 && /undone/.test(restored.stdout) && fs.readFileSync(stubFile, 'utf8').includes('An older launcher'), restored.stdout + restored.stderr);
    fs.writeFileSync(stubFile, currentStub);

    const mcpUnknown = cli('mcp', 'add', 'nope', project);
    check('mcp add refuses an id that is not recommended', mcpUnknown.status === 1 && /Unknown MCP "nope"/.test(mcpUnknown.stderr), mcpUnknown.stderr);
    const mcpThird = cli('mcp', 'add', 'codeburn', project);
    check('mcp add of a third-party server posts a board task and writes no config for it', mcpThird.status === 0 && /board task|already on the board/.test(mcpThird.stdout)
        && !(fs.existsSync(path.join(project, '.mcp.json')) && fs.readFileSync(path.join(project, '.mcp.json'), 'utf8').includes('codeburn')), mcpThird.stdout + mcpThird.stderr);
    const mcpOwn = cli('mcp', 'add', 'plutos', project);
    check('mcp add plutos wires PLUT_OS for Claude Code', mcpOwn.status === 0 && fs.readFileSync(path.join(project, '.mcp.json'), 'utf8').includes('plutos'), mcpOwn.stdout + mcpOwn.stderr);

    const rosterRm = cli('roster', 'rm', 'someone', project);
    check('roster rm needs an interactive terminal', rosterRm.status === 1 && /plutos roster rm needs an interactive terminal/.test(rosterRm.stderr), rosterRm.stderr);
    const memoryApply = cli('check', project, '--memory', '--apply');
    check('check --memory --apply is gone and says the migration is automatic', memoryApply.status === 1 && /is gone/.test(memoryApply.stderr) && /automatically/.test(memoryApply.stderr), memoryApply.stderr);
    check('the usage offers the new verbs and no longer offers --memory --apply', ['hooks [list]', 'repair [path] --apply', 'mcp add <id>', 'roster rm <name>', 'approvals [path] [--html]'].every(v => help.stdout.includes(v))
        && !/--memory \[--apply\]/.test(help.stdout), help.stdout);
    const header = fs.readFileSync(path.join(root, 'cli.mjs'), 'utf8').split('\nimport ')[0];
    check('the cli.mjs header lists wait and pack', /plutos wait --seat/.test(header) && /plutos pack /.test(header));

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
    // approvals --html writes a static page per waiting question (lib/approvals.mjs writeApprovalsPage);
    // a spawned CLI has no terminal, so it opens nothing.
    const pictured = createApproval(project, { agent: 'Claude Code', question: 'Which logo?', options: ['A', 'B'] });
    const html = cli('approvals', project, '--html');
    const { writeApprovalsPage } = await import('../lib/approvals.mjs');
    if (typeof writeApprovalsPage === 'function') {
        check('approvals --html lists the question and names the page it wrote', html.status === 0 && html.stdout.includes(pictured.id) && /\[\+\] Page: .*\.html/.test(html.stdout), html.stdout + html.stderr);
    } else {
        check('approvals --html without the page writer says so', html.status === 1 && /not available/.test(html.stderr), html.stdout + html.stderr);
    }
    check('answering an unknown ticket says so', /No such question/.test(throws(() => answerApproval(project, 'ask-nope-000000', { decision: 'approved', via: 'local' }))));
} finally {
    fs.rmSync(temp, { recursive: true, force: true });
}
console.log(`CLI: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
