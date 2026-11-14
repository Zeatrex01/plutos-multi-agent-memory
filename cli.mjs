#!/usr/bin/env node
// PLUT_OS CLI — the terminal surface over the same lib calls the dashboard makes.
//
//   plutos init [path] [--interview] [--client <id>]   install the kit and the launcher; wire one client
//   plutos connect <client-id> [path]  write one AI client's MCP config (the Connect panel's button)
//   plutos status [path]               readiness, board, approvals, clients
//   plutos approvals [path] [--html]   questions waiting for the owner; --html writes a page with the images
//   plutos approve <ticket> [path] [--option <number|text>] [--note <text>]   (interactive terminal only)
//   plutos reject <ticket> [path] [--note <text>]                      (interactive terminal only)
//   plutos check [path] [--all] [--accept] [--json]   what the records claim that the repository
//                                      does not show (lib/claims.mjs); exit 1 on a new finding;
//                                      --accept needs an interactive terminal (the owner's)
//   plutos check [path] --weight       what a session there carries, against each part's limit
//   plutos check [path] --memory       the memory report (lib/memory.mjs), exit 0
//   plutos memory list|find|open|verify|supersede|retire   the memory verbs over CONTEXT.json;
//                                      find searches the git-ignored index (.plutos/memory.db)
//   plutos changelog <section> <text…> [--project <path>]   one line under ## [Unreleased], unread
//   plutos idea <text…> [--project <path>]      one line in IDEAS.md, unread
//   plutos decide "<text>" [path] [--supersedes <d-id>]   record an owner's decision the moment it is stated
//   plutos rebind <new path> [--from <old path>] [--dry-run]   rewire the clients and the hub entry after a move
//   plutos report [path] [--days N] [--json]   where the project stands, each part labelled
//                                      verified (git, the files) or claimed (what an AI wrote)
//   plutos usage [path] [--days N] [--json]   which AIs called which PLUT_OS tools and hooks, from the
//                                      local .plutos/usage.jsonl (not the plutos_usage MCP tool: tokens)
//   plutos update [--check] [--clean]  this PLUT_OS, not a project: fast-forward, npm install when
//                                      the dependencies changed, leftovers listed (lib/update.mjs)
//   plutos skills inventory [path] [--json]   every skill on this machine, duplicates, exports
//   plutos skills export <name> <dest> [--force] [--force-local]   a tracked copy of one skill
//   plutos audit [path] [--json] [--clean]   what older PLUT_OS versions left in a project and what
//                                      else needs a look (lib/audit.mjs), exit 0; --clean moves the
//                                      leftovers into the Hub (interactive terminal only)
//   plutos wait --seat <name> [path]   wait, without tokens, until the board assigns that seat a TODO
//   plutos pack add|list|on|off|forget  register skill packs and place them in a project
//   plutos hooks [list|on|off <id>] [path]   the project's hooks, the watcher and the context capture
//   plutos repair [path] [--apply|--restore [backup-id]]   preview, apply or undo the project repair
//   plutos mcp add <id> [path]         a recommended MCP server (third-party ones become a board task)
//   plutos roster rm <name> [path]     take an agent off the roster (interactive terminal only)
//
// `node cli.mjs [path] [--interview]` without a command still runs init; a bare `node cli.mjs`
// prints the usage and exits 0.
//
// init, connect, update and rebind also record this PLUT_OS as the machine's current install
// (install.json, which every project launcher reads) and bring the project's launcher up to date,
// so nothing an AI needs depends on the dashboard having been started.
//
// Init installs the kit and the launcher: enough that every change from the first session goes
// through the MCP server and is attributed. Answering an approval from the terminal counts as
// local, the same as the dashboard at the PLUTOS computer: every tier may be approved here
// (lib/approval-effects.mjs runs whatever side effect a ticket carries). It needs an interactive
// terminal (O14, 2026-11-04): a ticket answered from a script could be an AI approving itself.
import fs from 'fs';
import path from 'path';
import { initTargetProject, describeIgnores, looksLikePlutosProject, getCoordinationRoot, healLauncherStub } from './lib/workspaces.mjs';
import { registerCurrentInstall, readCurrentInstall } from './lib/app-data.mjs';
import { CLIENTS, findClient, wireClient, connectionPlan, configEntry, STUB_REL } from './lib/connect.mjs';
import { enableDefaultHooks, healDefaultHooks } from './lib/project-hooks.mjs';
import { APP_ROOT, PLUTOS_HOME_DIR } from './lib/approot.mjs';
import { isDevMode, devProjectAllowed, devProjectRefusal } from './lib/run-mode.mjs';
import { projectReadiness } from './lib/readiness.mjs';
import { listApprovals, answerApproval, readApproval, resolveOptionArg } from './lib/approvals.mjs';
import { applyApprovedSideEffects } from './lib/approval-effects.mjs';
import { boardPathFor } from './lib/roadmap.mjs';
import { parseBoardEntries, BOARD_STATUSES } from './lib/board.mjs';
import { readMcpStatus, projectMcpStatus } from './lib/mcp-status.mjs';
import { waitForTask } from './lib/wait.mjs';

const COMMANDS = ['init', 'connect', 'status', 'approvals', 'approve', 'reject', 'check', 'report', 'usage', 'changelog', 'idea', 'decide', 'rebind', 'update', 'audit', 'wait', 'skills', 'pack', 'memory', 'hooks', 'repair', 'mcp', 'roster', 'help'];
const USAGE = `Usage: plutos <command> [path] [options]

  init [path] [--interview] [--client <id>]
                                install the kit and the launcher; --client also wires that AI tool
  connect <client-id> [path]    write one AI client's MCP config (no id: list the clients)
                                init, connect, rebind and update record this copy as the one project
                                launchers start only if none usable is recorded; --register takes it over
  status [path]                 readiness, board, approvals, live clients
  approvals [path] [--html]     questions waiting for the owner; --html writes a page per question
                                with its images labelled by option (the answer is still typed)
  approve <ticket> [path] [--option <number|text>] [--note <text>]
  reject <ticket> [path] [--note <text>]
                                answer a question; both need an interactive terminal (the owner's)
  check [path] [--all] [--accept] [--json]
                                what the records claim that the repository does not show; exit 1
                                on a finding the baseline does not hold (--accept records today's;
                                it needs an interactive terminal, the owner's)
  check [path] --weight         what a session there carries, against each part's limit
  check [path] --memory         the memory report: broken anchors, duplicates, supersede chains,
                                old unverified claims, what ageing would archive, caps, hidden
                                characters. A report, not a gate: exit 0
  memory list [path] [--type decision|claim] [--status reversed|verified|valid|review|stale|unverified]
  memory find "<query>" [path] [--budget 1..3] [--archived] [--json]
                                at most 3 cards above the floor, Turkish or English; --archived
                                searches the cold records too (the flags come last)
  memory open <id> [path]       the record's card: text, type, status, sources, links, dates
  memory verify <id> [path]     re-snapshot the sources when every excerpt is still verbatim
  memory supersede <old-id> <text> [path]   a new decision that reverses the old one
  memory retire <id> <reason> [path]        archive the record with the reason
                                verify, supersede and retire need an interactive terminal
  report [path] [--days N] [--json]
                                where the project stands, each section labelled fact, assumption
                                or proposal
  usage [path] [--days N] [--json]
                                how much PLUT_OS is used and by which AIs (default 7 days): tool
                                calls, sessions started and ended, tools never called, sub-agent
                                starts, commit days with no session record. Read from the local,
                                git-ignored .plutos/usage.jsonl. Not the plutos_usage MCP tool,
                                which reports token use per session
  changelog <Added|Changed|Fixed|…> <text> [--project <path>]
                                add one line to CHANGELOG.md without reading it
  idea <text> [--project <path>]   add one line to IDEAS.md without reading it
  decide "<text>" [path] [--supersedes <d-id>] [--ai <name>]
                                record a decision the owner just stated, with its reason; the
                                next session's brief shows it under Settled decisions.
                                --supersedes: the id of the decision he changed. Legacy DECISION
                                digest lines without an id become records first (count printed)
  rebind <new path> [--from <old path>] [--dry-run]
                                after the project folder moved: rewire each AI client whose config
                                names the old absolute path, and move the hub entry; --dry-run
                                lists the plan and writes nothing
  update [--check] [--clean]    bring this PLUT_OS up to date; --clean moves the files git neither
                                tracks nor ignores into the Hub instead of leaving them
  audit [path] [--json] [--clean]
                                what older PLUT_OS versions left in a project (files they wrote that
                                nothing reads now, older kit copies) and what else needs a look:
                                records, documents, memory, setup. A report: exit 0. --clean moves
                                the leftovers into the Hub, never deletes (interactive terminal only)
  wait --seat <name> [path] [--interval S] [--timeout S]
                                wait, without spending tokens, until the board has a TODO assigned
                                to that seat; print the instruction for the AI and exit 0 (exit 3
                                on timeout). For a loop: while plutos wait --seat codex → codex exec
  skills [path]                 the Agent Skills in the project: name, which AI tools read it,
                                where it came from, the pack's own measurement. A project folder
                                named inventory or export: write it as ./inventory or ./export
  skills inventory [path] [--json]
                                every skill a client on this machine would load: PLUT_OS's own, the
                                registered packs', the project's, the user's (claude.ai-synced too)
                                and Claude Code plugins'; copies that share a name (identical,
                                different versions, name clash), exports and whether each is
                                current, copies with missing links, what is not measured, one
                                line to act on per finding. A duplicate is a problem only when one
                                client loads two copies. Read-only, a report: exit 0
  skills export <name> <dest-folder> [--force] [--force-local]
                                copy one of PLUT_OS's or a pack's skills to <dest-folder>/<name>/
                                with a .plutos-source.json record, so the inventory can say when
                                the source moved on. --force replaces an earlier export whose
                                record accounts for every entry, unchanged; --force-local replaces
                                anything else after copying the whole folder to the data folder
                                (refused when it cannot be copied whole). Never into the source or
                                a PLUT_OS or pack folder. Flags come last
  pack add <folder|id>          register a pack folder (skills.json or module.json, skills/<name>/SKILL.md), or a shipped pack by id (codebase-memory, context-mode)
  pack list                     the registered packs
  pack on <id> [path]           copy the pack's skills into the project's skill folders
  pack off <id> [path]          remove the folders that pack placed there
  pack forget <id>              drop a pack from the registry (projects keep what was placed)
  hooks [list] [path]           the project's Claude Code hooks, the watcher and the context capture
  hooks on|off <id> [path] [--agent <name>]
                                switch one: brief, guard, push-gate, claim-check, session-close,
                                subagent (a tool map for every subagent), watcher (--agent: the
                                board name it answers to) or capture. Turning guard, push-gate or
                                claim-check off, or watcher or capture on, needs an interactive
                                terminal (the owner's)
  repair [path]                 preview the project repair (launcher, MCP link, older kit copies)
  repair [path] --apply         apply it; a backup is kept
  repair [path] --restore [backup-id]
                                undo the latest repair (or the one named), unless a file changed since
  mcp add <id> [path]           a recommended MCP server: plutos wires PLUT_OS's own entry for Claude
                                Code; a third-party one becomes a board task for your AI
  roster rm <name> [path]       take an agent off the roster (interactive terminal only)
  help

[path] defaults to the current folder. "node cli.mjs <path>" without a command runs init; a bare
"node cli.mjs" prints this usage. init, connect, update and rebind also record where this PLUT_OS
is (the file every project launcher reads) and bring the project's launcher up to date.`;

const argv = process.argv.slice(2);
const fail = message => { console.error(`[!] ${message}`); process.exit(1); };

// `--note a b c` takes the rest until the next flag; `--interview` and `--dry-run` are switches; `--client` takes one id.
function parseArgs(args) {
    const flags = {}, positional = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (!arg.startsWith('--')) { positional.push(arg); continue; }
        const key = arg.slice(2);
        if (key === 'interview' || key === 'dry-run') { flags[key] = true; continue; }
        if (key === 'client') { flags.client = args[++i] || ''; continue; }
        const words = [];
        while (i + 1 < args.length && !args[i + 1].startsWith('--')) words.push(args[++i]);
        flags[key] = words.join(' ');
    }
    return { flags, positional };
}

function projectPath(candidate) {
    return candidate ? path.resolve(candidate) : process.cwd();
}

// Commands that write into the target stop at development mode's sandbox.
function refuseRealProjectInDev(targetPath) {
    if (isDevMode() && !devProjectAllowed(targetPath, { home: PLUTOS_HOME_DIR, appRoot: APP_ROOT })) {
        fail(devProjectRefusal(targetPath, PLUTOS_HOME_DIR));
    }
}

function requireInstalled(targetPath) {
    if (!fs.existsSync(targetPath)) fail(`${targetPath} does not exist.`);
    if (!looksLikePlutosProject(targetPath)) fail(`${targetPath} has no PLUT_OS kit. Run "plutos init ${targetPath}" first.`);
    return targetPath;
}

// install.json is what every project launcher reads to find PLUT_OS; the dashboard used to be its
// only writer, so a machine that never started the dashboard had launchers that could not start.
// Another PLUT_OS copy (an AI's worktree, an older checkout, a vendored copy) must not take it over by
// running init or connect: every project's launcher would follow it, and lose its MCP when that copy
// is deleted. So it is written only when nothing usable is recorded, the record is this copy already,
// or the owner passes --register. A failure here is reported, not fatal: the command's own work is done.
function registerInstall(targetPath, flags = {}) {
    try {
        const recorded = readCurrentInstall();
        const usable = recorded && fs.existsSync(path.join(recorded.appRoot, 'lib', 'launch.mjs'));
        const norm = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
        const same = recorded && norm(recorded.appRoot) === norm(APP_ROOT);
        if (usable && !same && !('register' in flags)) {
            console.log(`[i] Project launchers start the PLUT_OS at ${recorded.appRoot}; this copy (${APP_ROOT}) left that record alone. Pass --register to make this copy the one they start.`);
        } else {
            const r = registerCurrentInstall();
            if (r.changed) console.log(`[+] Recorded this PLUT_OS (${APP_ROOT}) as the install project launchers start.`);
        }
    } catch (e) {
        console.log(`[!] Could not record where this PLUT_OS is: ${e.message}`);
    }
    if (targetPath && healLauncherStub(targetPath)) console.log('[+] Brought the project launcher (.plutos/plutos-launch.mjs) up to date.');
    const healed = targetPath ? healDefaultHooks(targetPath) : null;
    if (healed?.notice) console.log(`[+] ${healed.notice}`);
}

function init({ flags, positional }) {
    const targetPath = projectPath(positional[0]);
    refuseRealProjectInDev(targetPath);
    const withInterview = flags.interview === true;
    console.log(`\nPLUT_OS · install\nTarget: ${targetPath}\nInterview: ${withInterview ? 'yes (--interview)' : 'no (opt-in, pass --interview to include)'}\n`);

    const { ignores, detected, written } = initTargetProject(targetPath, { withInterview });
    const ignoreNotice = describeIgnores(ignores);
    if (ignoreNotice) console.log(`[i] ${ignoreNotice}\n`);
    if (detected) {
        console.log(`[i] Detected ${detected.stack}${detected.frameworks.length ? ' / ' + detected.frameworks.join(', ') : ''}.`);
    }
    // The list is what this run created; every kit write is create-if-absent.
    console.log(written.length ? `[+] Written: ${written.join(', ')} (existing files untouched).` : '[+] Nothing new to write (existing files untouched).');
    registerInstall(targetPath, flags);
    // A client is wired only when named: the kit is the same for every AI tool, the entry is not.
    if (typeof flags.client === 'string' && flags.client) connect({ flags, positional: [flags.client, targetPath] });
    else console.log('\nNext: connect an AI (plutos connect <client-id>, or plutos init --client <client-id>) and let it run session_start; it reads the project and writes the map first.');
}

function connect({ flags = {}, positional }) {
    const clientId = positional[0];
    if (!clientId) {
        console.log('Usage: plutos connect <client-id> [path]\n\nClient ids:');
        for (const c of CLIENTS) console.log(`  ${c.id.padEnd(20)} ${c.name}`);
        process.exit(1);
    }
    const client = findClient(clientId);
    if (!client) fail(`Unknown client "${clientId}". Run "plutos connect" with no id to list them.`);
    const targetPath = projectPath(positional[1]);
    refuseRealProjectInDev(targetPath);
    registerInstall(targetPath, flags);
    if (client.writable === false) {
        // PLUT_OS does not write this client's config (Claude's ~/.claude.json): the owner runs the
        // client's own command. Claude Code's session hooks are PLUT_OS's to write, so they come on
        // here as they do for the team-shared wiring (owner, d-acf9cf7ef2c9).
        if (!fs.existsSync(path.join(targetPath, STUB_REL))) fail('Install the PLUT_OS project kit first (plutos init); the project launcher does not exist yet.');
        if (client.claudeLocal) {
            const hooks = enableDefaultHooks(targetPath);
            if (hooks.notice) console.log(`[i] ${hooks.notice}`);
            if (hooks.error) console.log(`[!] Hooks not switched on: ${hooks.error}`);
        }
        console.log(`[i] PLUT_OS does not write ${client.name}'s config. Run:\n${client.command(configEntry(client, targetPath), targetPath)}`);
        return;
    }
    try {
        const result = wireClient(clientId, targetPath);
        console.log(`[+] Wrote ${client.name} config: ${result.path}`);
        if (result.ignored) console.log('[i] Added it to .gitignore: it names paths on this machine.');
        if (result.warning) console.log(`[!] ${result.warning}`);
        if (result.hooksNotice) console.log(`[i] ${result.hooksNotice}`);
        if (result.hooks?.error) console.log(`[!] Hooks not switched on: ${result.hooks.error}`);
    } catch (e) {
        fail(e.message);
    }
}

function pendingFor(targetPath) {
    return listApprovals(getCoordinationRoot(targetPath)).filter(t => t.status === 'pending');
}

function describeTicket(t) {
    const action = t.action ? ` · ${t.action.kind} ${t.action.packageId}` : '';
    const lines = [`${t.id}  [${t.tier}] ${t.agent}: ${t.question}${action}`];
    if (t.context) lines.push(...t.context.split('\n').map(l => `    ${l}`));
    if (t.options?.length) lines.push(`    options: ${t.options.join(' | ')}`);
    if (t.images?.length) lines.push(`    images (open them before you pick): ${t.images.join(' | ')}`);
    lines.push(`    expires ${new Date(t.expiresAt).toISOString()}`);
    return lines.join('\n');
}

function status({ positional }) {
    const targetPath = requireInstalled(projectPath(positional[0]));
    const readiness = projectReadiness(targetPath);
    console.log(`PLUT_OS · ${path.basename(targetPath)} (${targetPath})`);
    console.log(`Readiness: ${readiness.stage}${readiness.next ? ` — next: ${readiness.next.action}` : ''}`);

    let entries = [];
    try { entries = fs.existsSync(boardPathFor(targetPath)) ? parseBoardEntries(fs.readFileSync(boardPathFor(targetPath), 'utf8')) : []; } catch { entries = []; }
    const counts = BOARD_STATUSES.map(s => `${s} ${entries.filter(e => e.status === s).length}`).join(', ');
    console.log(`Board:     ${entries.length} entries (${counts})`);

    const pending = pendingFor(targetPath);
    console.log(`Approvals: ${pending.length} pending${pending.length ? ' (plutos approvals)' : ''}`);

    const live = projectMcpStatus(readMcpStatus(path.join(PLUTOS_HOME_DIR, 'mcp_status.json')), targetPath);
    const liveNames = Object.values(live.clients).map(c => c.client || 'unknown');
    const wired = connectionPlan(targetPath).filter(c => c.wired).map(c => c.id);
    console.log(`Clients:   live ${liveNames.length ? liveNames.join(', ') : 'none'}; wired ${wired.length ? wired.join(', ') : 'none (plutos connect <client-id>)'}`);
}

async function approvals({ flags, positional }) {
    const targetPath = requireInstalled(projectPath(positional[0]));
    const pending = pendingFor(targetPath);
    if (!pending.length) { console.log('No questions waiting.'); return; }
    console.log(`${pending.length} waiting (approve: plutos approve <ticket>; reject: plutos reject <ticket>):\n`);
    for (const t of pending) console.log(describeTicket(t) + '\n');
    if ('html' in flags) await approvalsPage(targetPath);
}

// A static page per waiting question, its images labelled by option: pixels without a server. The
// answer is still typed (plutos approve), so the page grants nothing. Opened only at a terminal.
async function approvalsPage(targetPath) {
    const lib = await import('./lib/approvals.mjs');
    if (typeof lib.writeApprovalsPage !== 'function') fail('approvals --html is not available in this PLUT_OS (lib/approvals.mjs has no writeApprovalsPage).');
    const written = lib.writeApprovalsPage(getCoordinationRoot(targetPath), { appRoot: APP_ROOT });
    const files = (Array.isArray(written) ? written : [written?.paths || written?.files || written?.path || written].flat())
        .map(f => typeof f === 'string' ? f : f?.path).filter(Boolean);
    if (!files.length) { console.log('No page written.'); return; }
    for (const file of files) console.log(`[+] Page: ${file}`);
    if (process.stdout.isTTY) {
        const { pathToFileURL } = await import('url');
        const { openBrowser } = await import('./lib/open-browser.mjs');
        for (const file of files) openBrowser(pathToFileURL(path.resolve(getCoordinationRoot(targetPath), file)).href);
    }
}

function answer(decision, { flags, positional }) {
    const verb = decision === 'approved' ? 'approve' : 'reject';
    // O14 (cleanup plan, 2026-11-03): the ticket is sealed, so an AI cannot approve itself by editing
    // the file; this check closes the other door, an AI with a shell running the command.
    requireTerminal(`plutos ${verb}`, 'it answers a ticket, which is the owner\'s action');
    const id = positional[0];
    if (!id) fail(`Usage: plutos ${verb} <ticket> [path] [--note <text>]`);
    const targetPath = requireInstalled(projectPath(positional[1]));
    refuseRealProjectInDev(targetPath);
    const coordination = getCoordinationRoot(targetPath);
    const asked = readApproval(coordination, id);
    if (!asked) fail(`No such question: ${id} (plutos approvals lists the pending ones).`);
    // --option takes the option's number (what the approvals page and the AI's relay print) or its text.
    const option = resolveOptionArg(asked, flags.option);
    try {
        const ticket = answerApproval(coordination, id, {
            decision: option ? undefined : decision, option, note: flags.note || undefined, via: 'local'
        });
        console.log(`[+] ${ticket.status === 'approved' ? 'Approved' : 'Rejected'} ${ticket.id}${ticket.option ? ` — "${ticket.option}"` : ''} — ${ticket.agent} can continue.`);
        const outcome = applyApprovedSideEffects(targetPath, ticket);
        if (outcome) console.log(`[+] ${outcome.detail}`);
    } catch (e) {
        fail(e.message);
    }
}

// Writes to shared memory outside session_end, and the answer to a ticket, are the owner's own
// terminal actions (the review inbox of the canonical architecture, 2026-11-03 §6; O14): they need
// a terminal a person is at, so an AI with a shell cannot rewrite memory or approve its own ticket
// from a script. The dashboard's POST /api/approvals is the owner's browser action and is not
// affected.
function requireTerminal(what, why = 'it rewrites shared memory, which is the owner\'s action') {
    if (!(process.stdin.isTTY && process.stdout.isTTY)) fail(`${what} needs an interactive terminal: ${why}.`);
}

// Paths, line citations and npm scripts the records name, and what would leak on publishing. The
// baseline accepts old debt; a finding it does not hold fails the command (and, in PLUT_OS, npm test).
async function check({ flags, positional }) {
    const root = projectPath(positional[0]);
    if (!fs.existsSync(root)) fail(`${root} does not exist.`);
    if ('memory' in flags) {
        const { memoryCheck, renderMemoryCheck } = await import('./lib/memory.mjs');
        // The migration runs on its own now (the next plutos decide, plutos_decide or session_end).
        if ('apply' in flags) fail('check --memory --apply is gone: the DECISION digest migration runs automatically on the next plutos decide, plutos_decide or session_end. plutos check --memory reports what is left.');
        const report = memoryCheck(root);
        console.log('json' in flags ? JSON.stringify(report, null, 2) : renderMemoryCheck(report));
        return;
    }
    const { findClaims, acceptClaims, baselinePath, checkClaimsAgainstBaseline, claimsReport, projectWeight, weightReport } = await import('./lib/claims.mjs');
    if ('weight' in flags) {
        const rows = await projectWeight(root);
        console.log('json' in flags ? JSON.stringify(rows, null, 2) : weightReport(rows));
        return;
    }
    if ('accept' in flags) {
        // Raising the baseline mutes findings for good, so it is the owner's call (feedback 2026-11-14 §2.8).
        requireTerminal('plutos check --accept', 'it raises the claims baseline, which silences findings and is the owner\'s call; fix the finding, or ask the owner to run it');
        const count = acceptClaims(root, findClaims(root));
        console.log(`Accepted ${count} finding(s) as the baseline: ${path.relative(root, baselinePath(root))}`);
        return;
    }
    const result = checkClaimsAgainstBaseline(root);
    console.log('json' in flags ? JSON.stringify(result, null, 2) : claimsReport(result, { all: 'all' in flags }));
    if (result.fresh.length) process.exitCode = 1;
}

// plutos memory list|open|verify|supersede|retire (lib/memory.mjs): the registry's records by id.
async function memory({ flags, positional }) {
    const [action, ...rest] = positional;
    const lib = await import('./lib/memory.mjs');
    const clipText = text => { const flat = String(text).replace(/\s+/g, ' '); return flat.length > 110 ? `${flat.slice(0, 107)}…` : flat; };
    if (action === 'list') {
        const root = requireInstalled(projectPath(rest[0]));
        const { error, records } = lib.listMemory(root, { type: flags.type || '', status: flags.status || '' });
        if (error) fail(`CONTEXT.json cannot be read: ${error}`);
        if (!records.length) { console.log('No record matches.'); return; }
        for (const r of records) console.log(`${r.id.padEnd(24)}  ${r.type.padEnd(8)}  ${r.status.padEnd(10)}  ${clipText(r.text)}`);
        console.log(`${records.length} record(s); plutos memory open <id> shows one.`);
        return;
    }
    if (action === 'find') {
        // The query comes first, the flags after it (a flag swallows the words that follow it).
        const last = rest.length > 1 && fs.existsSync(rest.at(-1)) && fs.statSync(rest.at(-1)).isDirectory() ? rest.pop() : '';
        const query = rest.join(' ').trim();
        if (!query) fail('Usage: plutos memory find "<query>" [path] [--budget 1..3] [--archived] [--json]');
        const root = requireInstalled(projectPath(last));
        const budget = flags.budget === undefined ? lib.FIND_BUDGET.default : Number(flags.budget);
        if (!Number.isInteger(budget) || budget < lib.FIND_BUDGET.min || budget > lib.FIND_BUDGET.max) fail(`--budget is ${lib.FIND_BUDGET.min}..${lib.FIND_BUDGET.max}.`);
        const r = lib.findMemory(root, query, { budget, archived: 'archived' in flags });
        console.log('json' in flags ? JSON.stringify(r, null, 2) : lib.renderFind(r));
        return;
    }
    if (action === 'open') {
        if (!rest[0]) fail('Usage: plutos memory open <id> [path]');
        const card = lib.openMemory(requireInstalled(projectPath(rest[1])), rest[0]);
        if (!card) fail(`No record ${rest[0]} (plutos memory list shows the ids).`);
        console.log(lib.renderCard(card));
        return;
    }
    if (action === 'verify') {
        if (!rest[0]) fail('Usage: plutos memory verify <id> [path]');
        const root = requireInstalled(projectPath(rest[1]));
        refuseRealProjectInDev(root);
        requireTerminal('plutos memory verify');
        const r = lib.verifyMemory(root, rest[0]);
        if (r.verified) console.log(`[+] ${rest[0]} verified: ${r.sources} source(s) re-snapshotted at ${r.at}.`);
        else { console.log(`[!] ${rest[0]} not verified; nothing changed:`); for (const line of r.failed) console.log(`    ${line}`); process.exitCode = 1; }
        return;
    }
    if (action === 'supersede') {
        if (!rest[0] || !rest[1]) fail('Usage: plutos memory supersede <old-id> "<new text>" [path]');
        const root = requireInstalled(projectPath(rest[2]));
        refuseRealProjectInDev(root);
        requireTerminal('plutos memory supersede');
        const r = lib.supersedeMemory(root, rest[0], rest[1]);
        console.log(`[+] ${r.id} supersedes ${r.oldId}; the digest in docs/handoff/CONTINUITY.md has the new line. Commit both files.`);
        return;
    }
    if (action === 'retire') {
        if (!rest[0] || !rest[1]) fail('Usage: plutos memory retire <id> "<reason>" [path]');
        const root = requireInstalled(projectPath(rest[2]));
        refuseRealProjectInDev(root);
        requireTerminal('plutos memory retire');
        const r = lib.retireMemory(root, rest[0], rest[1]);
        console.log(`[+] ${r.id} (${r.type}) archived under docs/handoff/archive/ with the reason. Commit the registry and the archive.`);
        return;
    }
    fail('Usage: plutos memory <list [--type t] [--status s] | find "<query>" [--budget 1..3] [--archived] [--json] | open <id> | verify <id> | supersede <old-id> <text> | retire <id> <reason>> [path]');
}

// The Report tab's text, no AI: git and the files are verified, the sessions and the board are claimed.
async function report({ flags, positional }) {
    const root = projectPath(positional[0]);
    if (!fs.existsSync(root)) fail(`${root} does not exist.`);
    const { buildStatusReport, renderReportMarkdown, REPORT_LIMITS } = await import('./lib/report.mjs');
    const days = Number(flags.days) > 0 ? Number(flags.days) : REPORT_LIMITS.days;
    const r = buildStatusReport(root, { days });
    console.log('json' in flags ? JSON.stringify(r, null, 2) : renderReportMarkdown(r));
}

// The usage log's report (lib/usage-report.mjs). Read-only; "plutos_usage" (MCP) is the token ledger.
async function usage({ flags, positional }) {
    const root = projectPath(positional[0]);
    if (!fs.existsSync(root)) fail(`${root} does not exist.`);
    const { buildUsageReport, renderUsageText, USAGE_REPORT_LIMITS } = await import('./lib/usage-report.mjs');
    const days = Number(flags.days) > 0 ? Number(flags.days) : USAGE_REPORT_LIMITS.days;
    const r = buildUsageReport(root, { days });
    console.log('json' in flags ? JSON.stringify(r, null, 2) : renderUsageText(r));
}

// One line into a long log without reading it: the reason these exist.
async function changelog({ flags, positional }) {
    const [section, ...words] = positional;
    const root = projectPath(flags.project);
    const { addChangelogEntry, CHANGELOG_SECTIONS } = await import('./lib/changelog.mjs');
    if (!CHANGELOG_SECTIONS.includes(section) || !words.length) fail(`Usage: plutos changelog <${CHANGELOG_SECTIONS.join('|')}> <text> [--project <path>]`);
    console.log(`Added to ${path.relative(process.cwd(), addChangelogEntry(root, section, words.join(' '))) || 'CHANGELOG.md'} under ${section}.`);
}

async function idea({ flags, positional }) {
    if (!positional.length) fail('Usage: plutos idea <text> [--project <path>]');
    const { addIdea } = await import('./lib/ideas.mjs');
    const { action, path: file } = addIdea(projectPath(flags.project), positional.join(' '));
    console.log(`${action === 'exists' ? 'Already in' : 'Added to'} ${path.relative(process.cwd(), file) || file}.`);
}

// An owner's decision recorded when it is stated (lib/continuity.mjs recordDecision). It only adds a
// record, as session_end's `decided` does, so it needs no terminal; --supersedes names the decision the
// owner just changed, as session_end's `decided` may.
async function decide({ flags, positional }) {
    if (!positional[0] || positional.length > 2) fail('Usage: plutos decide "<the decision and why>" [path] [--supersedes <d-id>] [--ai <name>]  (quote the text)');
    const root = requireInstalled(projectPath(positional[1]));
    const { recordDecision, decisionReply } = await import('./lib/continuity.mjs');
    const { autoMigrateDigestDecisions, migrationNote } = await import('./lib/memory.mjs');
    const migrated = migrationNote(autoMigrateDigestDecisions(root));
    if (migrated) console.log(migrated);
    const r = recordDecision(root, positional[0], { ai: flags.ai || 'plutos decide', origin: 'decide-cli', supersedes: flags.supersedes });
    console.log(decisionReply(r));
}

// plutos rebind <new path> [--from <old path>] (lib/rebind.mjs): after a project folder moved, rewire
// each client config that names an absolute path and move the hub entry. Imported lazily so the
// rest of the CLI loads without it.
async function rebind({ flags, positional }) {
    if (!positional[0] || positional.length > 1) fail('Usage: plutos rebind <new path> [--from <old path>] [--dry-run]');
    const newPath = path.resolve(positional[0]);
    if (!fs.existsSync(newPath)) fail(`${newPath} does not exist.`);
    if ('from' in flags && !flags.from) fail('--from needs the old path.');
    refuseRealProjectInDev(newPath);
    let rebindProject;
    try { ({ rebindProject } = await import('./lib/rebind.mjs')); }
    catch (e) { fail(`rebind is not available in this PLUT_OS (${e.message}).`); }
    const r = await rebindProject(flags.from ? path.resolve(flags.from) : undefined, newPath, { dryRun: flags['dry-run'] === true });
    if (flags['dry-run'] !== true) registerInstall(newPath, flags);
    for (const item of r.changed || []) console.log(`[+] ${typeof item === 'string' ? item : JSON.stringify(item)}`);
    for (const item of r.skipped || []) console.log(`[-] ${typeof item === 'string' ? item : JSON.stringify(item)}`);
    for (const note of r.notes || []) console.log(note);
    if (!(r.changed || []).length) console.log('Nothing rewired.');
    if (r.refused) process.exitCode = 1;
}

// This PLUT_OS, wherever it runs from; projects follow it through their launcher.
async function update({ flags }) {
    const { updatePlutos, describeUpdate } = await import('./lib/update.mjs');
    const r = updatePlutos(APP_ROOT, { check: 'check' in flags, clean: 'clean' in flags, home: PLUTOS_HOME_DIR });
    console.log(describeUpdate(r));
    // --check only reads. Run from a project folder, its launcher is healed too; this process still
    // holds the stub text from before the update, and the next open of the project heals the rest.
    if (!('check' in flags)) registerInstall(looksLikePlutosProject(process.cwd()) ? process.cwd() : '', flags);
    if (r.state === 'refused') process.exitCode = 1;
}

// A project set up by an older PLUT_OS keeps what that version wrote; this finds it (lib/audit.mjs).
// Read-only, except --clean, which moves the catalogue's leftovers into the Hub and needs a terminal.
async function audit({ flags, positional }) {
    const root = projectPath(positional[0]);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail(`${root} is not a folder.`);
    const { auditProject, renderAudit, cleanLeftovers } = await import('./lib/audit.mjs');
    if ('clean' in flags) {
        requireTerminal('plutos audit --clean', 'it moves files out of the project');
        refuseRealProjectInDev(root);
        const result = cleanLeftovers(root, auditProject(root), { home: PLUTOS_HOME_DIR });
        if (result.refused) fail(`Nothing moved: ${result.refused}.`);
        if (!result.moved.length) { console.log('Nothing to move: no leftover here is one --clean may move.'); return; }
        console.log(`Moved ${result.moved.length} leftover(s) out of ${root} into ${result.target}:`);
        for (const relative of result.moved) console.log(`  ${relative}`);
        console.log(`To restore, copy them back keeping their paths: cp -R "${result.target}/." "${root}/" (Windows: robocopy "${result.target}" "${root}" /E). Nothing was deleted.`);
        console.log('Run plutos audit again for what is left.');
        return;
    }
    const report = auditProject(root);
    console.log('json' in flags ? JSON.stringify(report, null, 2) : renderAudit(report));
}

// The Skills page in the terminal: every skill the project's clients read, with its source and the
// pack's own measurement line (lib/skills.mjs); nothing here is a score the core made up.
async function skills({ positional, flags }) {
    if (positional[0] === 'inventory') return skillInventory(positional.slice(1), flags);
    if (positional[0] === 'export') return skillExport(positional.slice(1), flags);
    const targetPath = requireInstalled(projectPath(positional[0]));
    const { scanProjectSkills, SKILL_HOMES } = await import('./lib/skills.mjs');
    const { skills: found, notes } = scanProjectSkills(targetPath);
    console.log(`\nPLUT_OS · skills\nProject: ${targetPath}\nRead from: ${SKILL_HOMES.map(h => `${h.folder} (${h.clients.join(', ')})`).join('; ')}\n`);
    if (!found.length) console.log('No skill yet. An Agent Skill is a folder with a SKILL.md; put one at .agents/skills/<name>/SKILL.md, or switch a pack on (plutos pack on <id>).');
    for (const skill of found) {
        const measured = skill.measured ? `measured ${skill.measured.date}: ${skill.measured.summary}${skill.measured.record ? ` (${skill.measured.record})` : ''}` : 'not measured';
        console.log(`- ${skill.name} · ${skill.clients.join(', ')} · ${skill.source === 'project' ? 'project' : `pack ${skill.source}`} · ${measured}\n  ${skill.description}`);
    }
    for (const note of notes) console.log(`[i] ${note}`);
}

// Every skill a client on this machine would load, where each copy came from, the copies that share a
// name, the exports and whether each is current (lib/skill-inventory.mjs). A report: exit 0. Read-only,
// and the project needs no PLUT_OS kit.
async function skillInventory(positional, flags) {
    const targetPath = projectPath(positional[0]);
    if (!fs.existsSync(targetPath)) fail(`${targetPath} does not exist.`);
    const os = await import('os');
    const { inventory, renderInventory } = await import('./lib/skill-inventory.mjs');
    const result = inventory({ projectRoot: targetPath, userHome: os.homedir(), appRoot: APP_ROOT });
    if ('json' in flags) { console.log(JSON.stringify(result, null, 2)); return; }
    console.log(`${renderInventory(result)}\n\nProject: ${targetPath} · --json for every copy, path and hash.`);
}

// plutos skills export <name> <dest-folder> [--force] [--force-local]
async function skillExport(positional, flags) {
    const [name, dest] = positional;
    if (!name || !dest) fail('Usage: plutos skills export <name|plutos:<name>|<pack-id>:<name>> <dest-folder> [--force] [--force-local]');
    const { exportSkill } = await import('./lib/skill-inventory.mjs');
    let plutosVersion = '';
    try { plutosVersion = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version || ''; } catch (e) { plutosVersion = ''; }
    const r = exportSkill(name, dest, { appRoot: APP_ROOT, force: 'force' in flags || 'force-local' in flags, forceLocal: 'force-local' in flags, plutosVersion });
    console.log(`Exported ${r.skill} (${r.from.kind === 'pack' ? `pack:${r.from.id}` : 'plutos'}) to ${r.path}: ${r.files} file(s), recorded in ${path.basename(r.path)}/.plutos-source.json. plutos skills inventory says when the source changes.`);
    if (r.replacedTo) console.log(`[i] The local edits it replaced are kept in ${r.replacedTo}.`);
    for (const note of r.notes) console.log(`[i] ${note}`);
}

// plutos pack add <folder> | list | on <id> [path] | off <id> [path] | forget <id>
async function pack({ positional }) {
    const [action, arg, maybePath] = positional;
    const lib = await import('./lib/skills.mjs');
    if (action === 'add') {
        if (!arg) fail('Usage: plutos pack add <folder|codebase-memory|context-mode>');
        const result = lib.registerPack(arg);
        console.log(`Registered "${result.name}" (${result.id}) from ${result.path}: ${result.skills.map(s => s.name).join(', ')}.`);
        for (const note of result.notes) console.log(`[i] ${note}`);
        return;
    }
    if (action === 'list') {
        const packs = lib.listPacks();
        if (!packs.length) { console.log('No pack registered. plutos pack add <folder|id> registers one.'); return; }
        for (const p of packs) console.log(`- ${p.id} · ${p.name} · ${p.skills.length} skill(s) · ${p.path}${p.present ? '' : ' (folder missing)'}`);
        return;
    }
    if (action === 'on' || action === 'off') {
        if (!arg) fail(`Usage: plutos pack ${action} <id> [path]`);
        const targetPath = requireInstalled(projectPath(maybePath));
        refuseRealProjectInDev(targetPath);
        if (action === 'on') {
            const r = lib.activatePack(targetPath, arg);
            console.log(`Pack "${arg}" on: ${r.skills.join(', ')} in ${r.homes.join(' and ')}${r.placed ? '' : ' (already placed)'}.`);
            for (const note of r.notes) console.log(`[i] ${note}`);
        } else {
            const r = lib.deactivatePack(targetPath, arg);
            console.log(`Pack "${arg}" off: ${r.removed.length} folder(s) removed${r.kept.length ? `; kept, because edited or added: ${r.kept.join(', ')}` : ''}.`);
            for (const note of r.notes || []) console.log(`[i] ${note}`);
        }
        return;
    }
    if (action === 'forget') {
        if (!arg) fail('Usage: plutos pack forget <id>');
        lib.forgetPack(arg);
        console.log(`Pack "${arg}" forgotten; what it placed in projects stays until switched off there.`);
        return;
    }
    fail('Usage: plutos pack <add <folder|id> | list | on <id> [path] | off <id> [path] | forget <id>>');
}

// The dashboard's Hooks panel in the terminal: PROJECT_HOOKS through setProjectHook, plus the watcher
// and the shared-context capture, which keep their own switches (lib/watcher.mjs,
// lib/context-automation.mjs). Turning a safety check off is the owner's call, so it needs a terminal.
const SAFETY_HOOKS = ['guard', 'push-gate', 'claim-check'];
async function hooks({ flags, positional }) {
    const [first, ...rest] = positional;
    const action = ['list', 'on', 'off'].includes(first) ? first : 'list';
    const args = action === first ? rest : positional;
    const { projectHooksStatus, setProjectHook, PROJECT_HOOKS } = await import('./lib/project-hooks.mjs');
    const { watcherStatus, setWatcher } = await import('./lib/watcher.mjs');
    const { contextAutomationStatus, setContextAutomation } = await import('./lib/context-automation.mjs');
    const ids = [...PROJECT_HOOKS.map(h => h.id), 'watcher', 'capture'];
    if (action === 'list') {
        if (args.length > 1) fail('Usage: plutos hooks [list] [path]');
        const root = requireInstalled(projectPath(args[0]));
        const status = projectHooksStatus(root);
        if (status.error) console.log(`[!] ${status.settingsPath} cannot be read: ${status.error}`);
        for (const h of status.hooks) {
            console.log(`${h.id.padEnd(14)} ${h.on ? 'on ' : 'off'}  ${h.event}${h.needsUpgrade ? ' · needs an update (switch it on again)' : ''}${h.problem ? ` · ${h.problem}` : ''}`);
        }
        const watcher = watcherStatus(root);
        console.log(`${'watcher'.padEnd(14)} ${watcher.installed ? 'on ' : 'off'}  wakes Claude Code for a board TODO${watcher.needsUpgrade ? ' · needs an update (switch it on again)' : ''}`);
        console.log(`${'capture'.padEnd(14)} ${contextAutomationStatus(root).enabled ? 'on ' : 'off'}  Claude Code context capture`);
        console.log('Switch one: plutos hooks on|off <id> [path]. Each takes effect in the AI tool\'s next session.');
        return;
    }
    const [id, maybePath] = args;
    if (!id || args.length > 2) fail(`Usage: plutos hooks ${action} <${ids.join('|')}> [path]`);
    if (!ids.includes(id)) fail(`Unknown hook "${id}". The ids: ${ids.join(', ')}.`);
    const root = requireInstalled(projectPath(maybePath));
    refuseRealProjectInDev(root);
    const enabled = action === 'on';
    if (!enabled && SAFETY_HOOKS.includes(id)) requireTerminal(`plutos hooks off ${id}`, 'it switches a safety check off, which is the owner\'s call');
    // Capture starts paid background claude -p runs and the watcher gives Claude Code turns fed from
    // the board: both were owner opt-ins in the dashboard, and an AI with a shell must not switch them on.
    if (enabled && (id === 'capture' || id === 'watcher')) requireTerminal(`plutos hooks on ${id}`, id === 'capture'
        ? 'it starts paid background AI runs, which is the owner\'s call' : 'it lets the board start Claude Code turns, which is the owner\'s call');
    try {
        if (id === 'watcher') {
            const r = setWatcher(root, enabled, { agent: flags.agent || 'Claude' });
            console.log(enabled ? `[+] Watcher ${r.installed ? 'on' : 'not on'} for ${flags.agent || 'Claude'}.${r.warning ? ` ${r.warning}` : ''}` : '[+] Watcher off: the Claude Code hook and its script are gone; board entries were left alone.');
            return;
        }
        if (id === 'capture') {
            const claudeWired = connectionPlan(root, { installed: true }).some(c => c.wired && (c.id === 'claude-code' || c.id === 'claude-code-local'));
            if (enabled && !claudeWired) fail('Connect Claude Code to this project first (plutos connect claude-code); the capture hook calls the project-bound plutos MCP.');
            setContextAutomation(root, enabled);
            console.log(enabled ? '[+] Claude Code context capture on for this project (private local setting). Restart Claude Code to load it.' : '[+] Claude Code context capture off for this project.');
            return;
        }
        const r = setProjectHook(root, id, enabled);
        console.log(`[+] ${id} hook ${r.on ? 'on' : 'off'} for this project (private local setting). It takes effect in the AI tool's next session.`);
    } catch (e) {
        fail(e.message);
    }
}

// The previewed project repair the Projects page offers (lib/repair.mjs): a preview by default,
// --apply previews and applies in one step with a backup, --restore undoes the latest repair or the
// one named. The repair works on registered projects, so an unregistered one is registered first.
async function repair({ flags, positional }) {
    if (positional.length > 1 || ('apply' in flags && 'restore' in flags)) fail('Usage: plutos repair [path] [--apply | --restore [backup-id]]');
    const root = fs.realpathSync(requireInstalled(projectPath(positional[0])));
    refuseRealProjectInDev(root);
    const { previewProjectRepair, applyProjectRepair, restoreProjectRepair } = await import('./lib/repair.mjs');
    const { getWorkspaces, addWorkspace } = await import('./lib/workspaces.mjs');
    // The repair library works on registered projects, so even a preview adds the project to this machine's
    // list; the preview message says so instead of claiming nothing was written.
    const known = getWorkspaces().some(w => { try { return fs.realpathSync(w) === root; } catch { return false; } });
    if (!known) addWorkspace(root);
    const report = (r, verb) => {
        for (const p of r.changed || []) console.log(`[+] ${verb} ${p}`);
        for (const w of r.warnings || []) console.log(`[i] ${w}`);
        for (const e of r.errors || []) console.log(`[!] ${e.message}`);
        if (!r.success) process.exitCode = 1;
    };
    try {
        const preview = previewProjectRepair(root);
        if ('restore' in flags) {
            const backupId = flags.restore || preview.backups[0]?.backupId;
            if (!backupId) { console.log('No repair to undo in this project.'); return; }
            const r = restoreProjectRepair({ projectRoot: root, backupId });
            report(r, 'Restored');
            if (r.success) console.log(`Repair ${backupId} undone.`);
            return;
        }
        if (preview.noOp) { console.log('Nothing to repair: the launcher, the MCP link and the kit copies are current.'); return; }
        for (const c of preview.changes) console.log(`${c.action.padEnd(7)} ${c.path} — ${c.reason}`);
        for (const w of preview.warnings) console.log(`[i] ${w}`);
        if (!('apply' in flags)) { console.log(`\nA preview: no project file written${known ? '' : ' (the project was added to this machine\'s project list)'}. plutos repair --apply makes these changes and keeps a backup.`); return; }
        const r = applyProjectRepair({ projectRoot: root, token: preview.token });
        report(r, 'Repaired');
        if (r.backupId) console.log(`Backup ${r.backupId}; plutos repair --restore undoes it.`);
    } catch (e) {
        fail(e.message);
    }
}

// The Recommended MCPs button: PLUT_OS's own entry is wired for Claude Code by lib/connect.mjs; a
// third-party server becomes a board task, so the owner's AI asks global-vs-local and installs it
// (lib/mcp-requests.mjs). The command comes from RECOMMENDED_MCPS, never from the arguments.
async function mcp({ positional }) {
    const [action, id, maybePath] = positional;
    const { RECOMMENDED_MCPS, installRecommendedMcp, projectMcpKeys } = await import('./lib/mcps.mjs');
    if (action !== 'add' || !id || positional.length > 3) fail(`Usage: plutos mcp add <${RECOMMENDED_MCPS.map(m => m.id).join('|')}> [path]`);
    const entry = RECOMMENDED_MCPS.find(m => m.id === id);
    if (!entry) fail(`Unknown MCP "${id}". The recommended ones: ${RECOMMENDED_MCPS.map(m => m.id).join(', ')}.`);
    const root = requireInstalled(projectPath(maybePath));
    refuseRealProjectInDev(root);
    try {
        const { MCP_REQUESTS, requestMcpSetup } = await import('./lib/mcp-requests.mjs');
        if (MCP_REQUESTS[entry.id]) {
            const r = requestMcpSetup(root, [entry.id], { alreadyWired: projectMcpKeys(root) });
            console.log(r.requested.length ? `[+] Posted a board task: your AI will ask you global-vs-local and wire ${entry.id}.` : '[i] Already wired or already on the board; nothing to request.');
            return;
        }
        if (entry.id === 'plutos') { connect({ positional: ['claude-code', root] }); return; }
        if (!entry.config) fail(`${entry.id} has no configuration to write; wire it on the AI tool's side.`);
        installRecommendedMcp(root, entry.id, entry.config);
        console.log(`[+] Added ${entry.id} to this project's .mcp.json. Claude Code asks you to approve it the next time it opens this project.`);
    } catch (e) {
        fail(e.message);
    }
}

// The Board tab's remove button: taking another AI's agent off the roster is the owner's action.
async function roster({ positional }) {
    const [action, name, maybePath] = positional;
    if (action !== 'rm' || !name || positional.length > 3) fail('Usage: plutos roster rm <name> [path]');
    requireTerminal('plutos roster rm', 'it removes an agent another AI registered, which is the owner\'s action');
    const root = requireInstalled(projectPath(maybePath));
    refuseRealProjectInDev(root);
    const { removeRosterAgent } = await import('./lib/roster-store.mjs');
    try {
        const r = removeRosterAgent(root, name);
        console.log(`[+] ${name} removed from the roster (${path.relative(root, r.path)}). Commit it.`);
    } catch (e) {
        fail(e.message);
    }
}

// --help or -h anywhere prints the usage and touches nothing: a bare `--help` used to fall through
// to init and install the kit into the current folder (2026-10-29 and 2026-10-30).
if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); process.exit(0); }
// A bare `node cli.mjs` prints the usage and writes nothing: it used to run init in the current
// folder by accident (field report 2026-11-14). `<path>` and the flag-only forms still run init.
if (!argv.length) { console.log(USAGE); process.exit(0); }
async function wait({ flags, positional }) {
    const seat = (flags.seat || '').trim();
    if (!seat) fail('Name the seat: plutos wait --seat <name as the board\'s Assignee writes it>.');
    const targetPath = requireInstalled(projectPath(positional[0]));
    const seconds = (value, fallback) => { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : fallback; };
    const prompt = await waitForTask(targetPath, seat, {
        intervalMs: Math.max(1, seconds(flags.interval, 5)) * 1000,
        timeoutMs: seconds(flags.timeout, 0) * 1000,
    });
    if (prompt === null) process.exit(3);
    process.stdout.write(prompt);
}

const command = COMMANDS.includes(argv[0]) ? argv.shift() : (argv[0] && !argv[0].startsWith('--') && !fs.existsSync(path.resolve(argv[0])) && !/[\\/.]/.test(argv[0]) ? null : 'init');
if (command === null) fail(`Unknown command "${argv[0]}".\n\n${USAGE}`);
const parsed = parseArgs(argv);
switch (command) {
    case 'init': init(parsed); break;
    case 'connect': connect(parsed); break;
    case 'status': status(parsed); break;
    case 'approvals': await approvals(parsed); break;
    case 'approve': answer('approved', parsed); break;
    case 'reject': answer('rejected', parsed); break;
    case 'check': await check(parsed); break;
    case 'report': await report(parsed); break;
    case 'usage': await usage(parsed); break;
    case 'changelog': await changelog(parsed); break;
    case 'idea': await idea(parsed); break;
    case 'decide': await decide(parsed).catch(e => fail(e.message)); break;
    case 'rebind': await rebind(parsed).catch(e => fail(e.message)); break;
    case 'update': await update(parsed); break;
    case 'audit': await audit(parsed); break;
    case 'wait': await wait(parsed); break;
    // A refusal from lib/skills.mjs is one line, not a stack trace.
    case 'skills': await skills(parsed).catch(e => fail(e.message)); break;
    case 'pack': await pack(parsed).catch(e => fail(e.message)); break;
    case 'memory': await memory(parsed).catch(e => fail(e.message)); break;
    case 'hooks': await hooks(parsed); break;
    case 'repair': await repair(parsed); break;
    case 'mcp': await mcp(parsed); break;
    case 'roster': await roster(parsed); break;
    default: console.log(USAGE);
}
