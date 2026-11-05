#!/usr/bin/env node
// PLUT_OS CLI — the terminal surface over the same lib calls the dashboard makes.
//
//   plutos init [path] [--interview] [--client <id>]   install the kit and the launcher; wire one client
//   plutos connect <client-id> [path]  write one AI client's MCP config (the Connect panel's button)
//   plutos status [path]               readiness, board, approvals, clients
//   plutos approvals [path]            questions waiting for the owner
//   plutos approve <ticket> [path] [--option <text>] [--note <text>]   (interactive terminal only)
//   plutos reject <ticket> [path] [--note <text>]                      (interactive terminal only)
//   plutos check [path] [--all] [--accept] [--json]   what the records claim that the repository
//                                      does not show (lib/claims.mjs); exit 1 on a new finding
//   plutos check [path] --weight       what a session there carries, against each part's limit
//   plutos check [path] --memory [--apply]   the memory report (lib/memory.mjs), exit 0; --apply runs
//                                      the one-time digest migration
//   plutos memory list|find|open|verify|supersede|retire   the memory verbs over CONTEXT.json;
//                                      find searches the git-ignored index (.plutos/memory.db)
//   plutos changelog <section> <text…> [--project <path>]   one line under ## [Unreleased], unread
//   plutos idea <text…> [--project <path>]      one line in IDEAS.md, unread
//   plutos report [path] [--days N] [--json]   where the project stands, each part labelled
//                                      verified (git, the files) or claimed (what an AI wrote)
//   plutos update [--check] [--clean]  this PLUT_OS, not a project: fast-forward, npm install when
//                                      the dependencies changed, leftovers listed (lib/update.mjs)
//   plutos audit [path] [--json] [--clean]   what older PLUT_OS versions left in a project and what
//                                      else needs a look (lib/audit.mjs), exit 0; --clean moves the
//                                      leftovers into the Hub (interactive terminal only)
//
// `node cli.mjs [path] [--interview]` without a command still runs init, as it always did.
//
// Init installs the kit and the launcher: enough that every change from the first session goes
// through the MCP server and is attributed. Answering an approval from the terminal counts as
// local, the same as the dashboard at the PLUTOS computer: every tier may be approved here
// (lib/approval-effects.mjs runs whatever side effect a ticket carries). It needs an interactive
// terminal (O14, 2026-11-04): a ticket answered from a script could be an AI approving itself.
import fs from 'fs';
import path from 'path';
import { initTargetProject, describeIgnores, looksLikePlutosProject, getCoordinationRoot } from './lib/workspaces.mjs';
import { CLIENTS, findClient, wireClient, connectionPlan } from './lib/connect.mjs';
import { APP_ROOT, PLUTOS_HOME_DIR } from './lib/approot.mjs';
import { isDevMode, devProjectAllowed, devProjectRefusal } from './lib/run-mode.mjs';
import { projectReadiness } from './lib/readiness.mjs';
import { listApprovals, answerApproval, readApproval } from './lib/approvals.mjs';
import { applyApprovedSideEffects } from './lib/approval-effects.mjs';
import { boardPathFor } from './lib/roadmap.mjs';
import { parseBoardEntries, BOARD_STATUSES } from './lib/board.mjs';
import { readMcpStatus, projectMcpStatus } from './lib/mcp-status.mjs';
import { waitForTask } from './lib/wait.mjs';

const COMMANDS = ['init', 'connect', 'status', 'approvals', 'approve', 'reject', 'check', 'report', 'changelog', 'idea', 'update', 'audit', 'wait', 'skills', 'pack', 'memory', 'help'];
const USAGE = `Usage: plutos <command> [path] [options]

  init [path] [--interview] [--client <id>]
                                install the kit and the launcher; --client also wires that AI tool
  connect <client-id> [path]    write one AI client's MCP config (no id: list the clients)
  status [path]                 readiness, board, approvals, live clients
  approvals [path]              questions waiting for the owner
  approve <ticket> [path] [--option <text>] [--note <text>]
  reject <ticket> [path] [--note <text>]
                                answer a question; both need an interactive terminal (the owner's)
  check [path] [--all] [--accept] [--json]
                                what the records claim that the repository does not show; exit 1
                                on a finding the baseline does not hold (--accept records today's)
  check [path] --weight         what a session there carries, against each part's limit
  check [path] --memory [--apply]
                                the memory report: broken anchors, duplicates, supersede chains,
                                old unverified claims, what ageing would archive, caps, hidden
                                characters. A report, not a gate: exit 0. --apply runs the one-time
                                migration of DECISION digest lines into decision records
  memory list [path] [--type decision|claim] [--status reversed|verified|valid|review|stale|unverified]
  memory find "<query>" [path] [--budget 1..3] [--archived] [--json]
                                at most 3 cards above the floor, Turkish or English; --archived
                                searches the cold records too (the flags come last)
  memory open <id> [path]       the record's card: text, type, status, sources, links, dates
  memory verify <id> [path]     re-snapshot the sources when every excerpt is still verbatim
  memory supersede <old-id> <text> [path]   a new decision that reverses the old one
  memory retire <id> <reason> [path]        archive the record with the reason
                                verify, supersede, retire and --apply need an interactive terminal
  report [path] [--days N] [--json]
                                where the project stands, each section labelled fact, assumption
                                or proposal
  changelog <Added|Changed|Fixed|…> <text> [--project <path>]
                                add one line to CHANGELOG.md without reading it
  idea <text> [--project <path>]   add one line to IDEAS.md without reading it
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
                                where it came from, the pack's own measurement
  pack add <folder>             register a pack folder (skills.json or module.json, skills/<name>/SKILL.md)
  pack list                     the registered packs
  pack on <id> [path]           copy the pack's skills into the project's skill folders
  pack off <id> [path]          remove the folders that pack placed there
  pack forget <id>              drop a pack from the registry (projects keep what was placed)
  help

[path] defaults to the current folder. "node cli.mjs [path]" without a command runs init.`;

const argv = process.argv.slice(2);
const fail = message => { console.error(`[!] ${message}`); process.exit(1); };

// `--note a b c` takes the rest until the next flag; `--interview` is a switch; `--client` takes one id.
function parseArgs(args) {
    const flags = {}, positional = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (!arg.startsWith('--')) { positional.push(arg); continue; }
        const key = arg.slice(2);
        if (key === 'interview') { flags.interview = true; continue; }
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
    // A client is wired only when named: the kit is the same for every AI tool, the entry is not.
    if (typeof flags.client === 'string' && flags.client) connect({ positional: [flags.client, targetPath] });
    else console.log('\nNext: connect an AI (plutos connect <client-id>, or plutos init --client <client-id>) and let it run session_start; it reads the project and writes the map first.');
}

function connect({ positional }) {
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
    try {
        const result = wireClient(clientId, targetPath);
        console.log(`[+] Wrote ${client.name} config: ${result.path}`);
        if (result.ignored) console.log('[i] Added it to .gitignore: it names paths on this machine.');
        if (result.warning) console.log(`[!] ${result.warning}`);
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

function approvals({ positional }) {
    const targetPath = requireInstalled(projectPath(positional[0]));
    const pending = pendingFor(targetPath);
    if (!pending.length) { console.log('No questions waiting.'); return; }
    console.log(`${pending.length} waiting (approve: plutos approve <ticket>; reject: plutos reject <ticket>):\n`);
    for (const t of pending) console.log(describeTicket(t) + '\n');
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
    if (!readApproval(coordination, id)) fail(`No such question: ${id} (plutos approvals lists the pending ones).`);
    try {
        const ticket = answerApproval(coordination, id, {
            decision: flags.option ? undefined : decision, option: flags.option || undefined, note: flags.note || undefined, via: 'local'
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
        const { memoryCheck, renderMemoryCheck, migrateDigestDecisions } = await import('./lib/memory.mjs');
        if ('apply' in flags) {
            requireTerminal('plutos check --memory --apply');
            const m = migrateDigestDecisions(root);
            console.log(`Migration: ${m.migrated} decision record(s) created, ${m.annotated} digest line(s) linked to an existing record (dated from a session: ${m.dated.session}, from git: ${m.dated.git}, undated: ${m.dated.none}).`);
        }
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

// This PLUT_OS, wherever it runs from; projects follow it through their launcher.
async function update({ flags }) {
    const { updatePlutos, describeUpdate } = await import('./lib/update.mjs');
    const r = updatePlutos(APP_ROOT, { check: 'check' in flags, clean: 'clean' in flags, home: PLUTOS_HOME_DIR });
    console.log(describeUpdate(r));
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
async function skills({ positional }) {
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

// plutos pack add <folder> | list | on <id> [path] | off <id> [path] | forget <id>
async function pack({ positional }) {
    const [action, arg, maybePath] = positional;
    const lib = await import('./lib/skills.mjs');
    if (action === 'add') {
        if (!arg) fail('Usage: plutos pack add <folder>');
        const result = lib.registerPack(arg);
        console.log(`Registered "${result.name}" (${result.id}) from ${result.path}: ${result.skills.map(s => s.name).join(', ')}.`);
        for (const note of result.notes) console.log(`[i] ${note}`);
        return;
    }
    if (action === 'list') {
        const packs = lib.listPacks();
        if (!packs.length) { console.log('No pack registered. plutos pack add <folder> registers one.'); return; }
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
        }
        return;
    }
    if (action === 'forget') {
        if (!arg) fail('Usage: plutos pack forget <id>');
        lib.forgetPack(arg);
        console.log(`Pack "${arg}" forgotten; what it placed in projects stays until switched off there.`);
        return;
    }
    fail('Usage: plutos pack <add <folder> | list | on <id> [path] | off <id> [path] | forget <id>>');
}

// --help or -h anywhere prints the usage and touches nothing: a bare `--help` used to fall through
// to init and install the kit into the current folder (2026-10-29 and 2026-10-30).
if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); process.exit(0); }
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
    case 'approvals': approvals(parsed); break;
    case 'approve': answer('approved', parsed); break;
    case 'reject': answer('rejected', parsed); break;
    case 'check': await check(parsed); break;
    case 'report': await report(parsed); break;
    case 'changelog': await changelog(parsed); break;
    case 'idea': await idea(parsed); break;
    case 'update': await update(parsed); break;
    case 'audit': await audit(parsed); break;
    case 'wait': await wait(parsed); break;
    // A refusal from lib/skills.mjs is one line, not a stack trace.
    case 'skills': await skills(parsed).catch(e => fail(e.message)); break;
    case 'pack': await pack(parsed).catch(e => fail(e.message)); break;
    case 'memory': await memory(parsed).catch(e => fail(e.message)); break;
    default: console.log(USAGE);
}
