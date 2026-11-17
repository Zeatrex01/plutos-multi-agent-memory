#!/usr/bin/env node
// PLUT_OS MCP server — thin adapter over lib/*.mjs. Tool schemas below, one small
// handler per tool in HANDLERS; business logic stays in lib.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import path from "path";
// A static JSON import: resolved at load and inlined by the build, so the version needs no runtime file read.
import pkg from "./package.json" with { type: "json" };

import { PLUTOS_HOME_DIR, APP_ROOT } from './lib/approot.mjs';
import { parseBoardEntries } from './lib/board.mjs';
import { createBoardReads } from './lib/board-delta.mjs';
import { looksLikePlutosProject } from './lib/workspaces.mjs';
import { findPlutosProject } from './lib/project-marker.mjs';
import { initRoadmap } from './lib/roadmap.mjs';
import { mutateMcpStatus, pushMcpLogEntry, pruneMcpClients } from './lib/mcp-status.mjs';
import { requiresProject, requiresProjectBinding } from './lib/tool-policy.mjs';
import {
  resolveProjectRoot, staticBindingError, advertisedRootsError, activeProjectRoot, sameProjectPath,
  CODEX_PROJECT_SCOPE_ENV, LAUNCHER_BOUND_ENV
} from './lib/project-binding.mjs';
import { CLIENTS, STUB_REL, findClient, configEntry, configPath, isWired, snippet } from './lib/connect.mjs';
import { updateState } from './lib/state.mjs';
import { recordSession, recordDecision, decisionReply, digestBudgetNote } from './lib/continuity.mjs';
import { sessionBrief, sessionBriefParts } from './lib/session-brief.mjs';
import { hookBrief, healDefaultHooks } from './lib/project-hooks.mjs';
import { buildStatusReport, renderReportMarkdown } from './lib/report.mjs';
import { housekeeping, tidyLiveBoards } from './lib/hygiene.mjs';
import { taskContext } from './lib/task-context.mjs';
import { idsShownIn, autoMigrateDigestDecisions, migrationNote } from './lib/memory.mjs';
import { codeLookup, formatCodeLookup, usageSummary, CODE_TOOLS } from './lib/code-tools.mjs';
import { createAgent } from './lib/agents.mjs';
import { writeBoardEntry, boardPathForTier, boardTier } from './lib/board-store.mjs';
import { createApproval, readApproval, answerCommands, shellQuote } from './lib/approvals.mjs';
import { buildSnapshot } from './lib/snapshot.mjs';
import { enqueueContextCapture } from './lib/context-capture.mjs';
import { contextAutomationStatus } from './lib/context-automation.mjs';
import { researchMcpHandlers } from './lib/research/mcp.mjs';
import { modulesTool, openDrawerTools, drawerOfTool, isDrawerOpen, listDrawers, setDrawer } from './lib/drawers.mjs';
import { canonicalClientName, clientFromEnv } from './lib/presence.mjs';
import { recordUsage } from './lib/usage-log.mjs';
import { recordFeedback, sessionFeedbackItems, FEEDBACK_KINDS, FEEDBACK_REL } from './lib/feedback.mjs';

// How long plutos_ask waits before handing the ticket back. Deliberately under the ~30s tool
// timeout MCP clients default to — see the handler for why waiting longer makes things worse,
// not better. Overridable for a client known to allow more.
const ASK_WAIT_MS = Math.max(1000, Number(process.env.PLUTOS_ASK_WAIT_MS) || 25_000);
const ASK_POLL_MS = 400;

// The project root is fixed once at startup. The per-project launcher now derives and sets
// it from the launcher's own file path, never from a client's stale working directory.
const PROJECT_ROOT = resolveProjectRoot();

// Started by the Claude Code plugin (.claude-plugin/plugin.json runs lib/plugin-entry.mjs, which sets
// PLUTOS_PLUGIN=1). That entry answers by itself outside a PLUT_OS project and beside the project's own
// usable plutos entry, and loads this server only for a project it serves: 'active'. null: not the plugin.
const PLUGIN_MODE = process.env.PLUTOS_PLUGIN === '1' ? 'active' : null;
// That entry bound the project nearest the folder Claude opened, so a client root in a subfolder of it
// (Claude Code advertises the folder it was started in) is this project, as long as no nearer project
// sits between them (lib/project-marker.mjs findPlutosProject).
const ROOTS_OPTIONS = PLUGIN_MODE ? { owns: root => sameProjectPath(findPlutosProject(root) || '', PROJECT_ROOT) } : {};

const text = (t) => ({ content: [{ type: "text", text: t }] });
const errorText = (t) => ({ content: [{ type: "text", text: t }], isError: true });

// Guard for every tool that WRITES: cwd is only trustworthy when it actually is a PLUT_OS
// project. Without this, a globally-registered server whose client starts in ~/ would
// scaffold boards and memory files into the home directory and report SUCCESS — the
// "coordinator writing into the wrong project" failure. init_roadmap is the deliberate
// exception: its whole job is to set up a directory that isn't a project yet.
function requireProject() {
    if (looksLikePlutosProject(PROJECT_ROOT)) return null;
    return errorText(
        `ERROR: ${PROJECT_ROOT} is not a PLUT_OS project (no .plutos/plutos-launch.mjs, docs/handoff/PLUTOS_PROTOCOL.md, or AGENTS.md with the PLUT_OS protocol marker). ` +
        `Refusing to write coordination files here. If this IS the right directory, ask the owner to run ` +
        `node cli.mjs init in it. If not, the MCP server was started from the wrong ` +
        `working directory — launch it via the project's .plutos/plutos-launch.mjs stub, or set PLUTOS_PROJECT_ROOT.`);
}

// Prove that this MCP belongs to the client's active repository before ANY project-shaped
// operation, including reads and init_roadmap. A PLUT_OS marker alone only proves that the
// bound directory is *some* PLUT_OS project — the bug was accepting a valid wrong one.
async function requireSafeProjectBinding() {
    const clientInfo = server.getClientVersion?.() || {};
    const staticError = staticBindingError(PROJECT_ROOT, clientInfo, process.env);
    if (staticError) return errorText(`ERROR: ${staticError}`);

    const capabilities = server.getClientCapabilities?.() || {};
    if (capabilities.roots) {
      try {
        const result = await server.listRoots({}, { timeout: 3000 });
        const rootsError = advertisedRootsError(PROJECT_ROOT, result?.roots, ROOTS_OPTIONS);
        if (rootsError) return errorText(`ERROR: ${rootsError}`);
      } catch (e) {
        return errorText(`ERROR: Project verification failed while reading the MCP client's workspace roots: ${e.message}. ` +
          `PLUT_OS refuses project access rather than guessing.`);
      }
    }
    return null;
}

const TOOLS = [
  {
    name: "plutos_project_info",
    description: "Safety diagnostic: returns the exact repository this PLUT_OS MCP process is bound to and whether its client binding is trusted. Call this when the visible PLUT_OS project looks wrong. It never writes files and remains available even when project access is blocked.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  // Listed by default since 2026-11-14: the one drawer tool with field use, and it went unfound while
  // its drawer was closed (plan 2026-11-14 section 3). Its definition stays in lib/code-tools.mjs.
  ...CODE_TOOLS.filter(t => t.name === 'plutos_code_lookup'),
  {
    name: "board_read",
    description: "PLUT_OS: Reads a shared board as structured entries. Tiers: 'main' (docs/handoff/BOARD.md, tasks and status) and 'agents' (docs/handoff/AGENT_BOARD.md, subagent findings). Call BEFORE starting work (AGENTS.md rule 1).",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string", enum: ["main", "agents"], description: "Which board to read (default: main)" },
        limit: { type: "number", description: "Max entries returned (default 100, max 1000). Open work is kept first; DONE entries are trimmed first." },
        detailed: { type: "boolean", description: "Each field whole, up to 2,000 characters; by default a field is clipped at 600" },
        since: { type: "string", description: "Cursor from an earlier board_read in this session: returns only what changed since." }
      },
      required: [],
    },
  },
  {
    name: "plutos_context_for_task",
    description: "PLUT_OS: Before you start a task, ask which files it touches. Give the task in one or two sentences (any language; naming a file or a function helps) and get a short ranked list of files to open first, each with the reason it is there (named in the task, declares a symbol you mentioned, matches the task's words, or uses / is used by one of those) and how confident the answer is. Ranks code files and memory records; writes only a git-ignored cache. Start from this list and search only for what it leaves open.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The task, as you would explain it to a colleague." },
        max_files: { type: "number", description: "How many files to list (default 12, max 40)." },
        budget_tokens: { type: "number", description: "Rough size limit for the answer (default 1500, 200-8000)." }
      },
      required: ["task"]
    }
  },
  {
    name: "board_update",
    description: "PLUT_OS: Claims, updates or completes a task on a shared board (upserts your entry by agent + title). Assign: TODO + assignee. Claim: IN_PROGRESS with doneWhen. Finish: DONE with result (a results/<file>.md path for documents). Conflict: note. Board 'main' for owner-level tasks, 'agents' for subagent findings.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Your agent name (e.g. Claude, Cursor, research-scout)" },
        status: { type: "string", enum: ["TODO", "IN_PROGRESS", "DONE", "BLOCKED"], description: "Task status (TODO = assigned, not yet claimed)" },
        title: { type: "string", description: "Short task title — also the entry's identity for later updates" },
        task: { type: "string", description: "One-line task description (defaults to title on first write)" },
        result: { type: "string", description: "One-line result summary + output location (e.g. results/rival-analysis.md); fill when DONE" },
        evidence: { type: "string", description: "One HTTP(S) URL or project-relative path supporting extra.verification. Required when passed." },
        doneWhen: { type: "string", description: "The check that will show this is finished (a test, a file, a behaviour you can see). Set it when you claim; DONE then needs extra.verification." },
        expectedRevision: { type: "string", description: "Revision from board_read; rejects the update if the entry changed since." },
        note: { type: "string", description: "Conflict/dependency note — appended as '❓ NOTE:' under the entry" },
        assignee: { type: "string", description: "Which AI or agent this task is for (e.g. gemini, codex, backend-agent). It is an assignment inside your own team and a SUGGESTION to another AI — you never task another AI's agents directly." },
        extra: {
          type: "object",
          additionalProperties: false,
          description: "Optional: role (what the assignee works as), needs (skills it requires), priority (P1 first in briefs), verification (a recorded check; DONE never implies passed, passed needs evidence).",
          properties: {
            role: { type: "string" },
            needs: { type: ["array", "string"], items: { type: "string" } },
            priority: { type: "string", enum: ["P1", "P2", "P3"] },
            verification: { type: "string", enum: ["unverified", "passed", "failed"] }
          }
        },
        board: { type: "string", enum: ["main", "agents"], description: "Which board to write (default: main)" }
      },
      required: ["agent", "status", "title"],
    },
  },
  {
    name: "plutos_ask",
    description: "PLUT_OS: Ask the owner a question he answers in a terminal; relay it to him in chat. PENDING IS NOT APPROVAL; resume with {ticket} until APPROVED or REJECTED. The wait is bounded to ~25 seconds.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Your agent name (e.g. Claude, Antigravity, Cursor) — the owner has to know who is asking." },
        question: { type: "string", description: "The question, as one sentence the owner can answer yes/no to (e.g. 'Delete the 200 orphaned rows in orders_legacy?'). Not a status update." },
        context: { type: "string", description: "One line of what happens next if approved, so the owner can decide without opening the code." },
        ticket: { type: "string", description: "Resume waiting on a question you already asked. Pass the id from a PENDING reply; leave empty to ask a new one." },
        ttl_minutes: { type: "number", description: "How long the question stays answerable (default 30, max 1440). After that it expires and you must treat it as NOT approved." },
        options: { type: "array", items: { type: "string" }, description: "Up to 5 concrete routes, e.g. [\"Split by risk\", \"One task\"]. The owner picks one; the reply names it verbatim. Omit for a plain yes/no." },
        images: { type: "array", items: { type: "string" }, description: "Up to 4 renders under docs/ai/design-picks/; image i is labelled option i." }
      },
      required: [],
    },
  },
  {
    name: "plutos_create_agent",
    description: "PLUT_OS: Creates a new subagent for a task — writes its definition (Claude Code: .claude/agents/<name>.md; any other AI: .agents/<name>/AGENT.md) and registers it on the roster in one call. Use when a board task needs capability you have no agent for (the task's 'Needs' field says what). You own what you create: only you task it. Check the roster in your brief first so you don't duplicate one.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Agent name: lowercase letters, digits, dashes (e.g. stripe-integrator). Becomes the filename and its memory folder." },
        owner: { type: "string", description: "You — the AI creating and therefore owning this agent (claude, gemini, cursor, ...)" },
        role: { type: "string", description: "What this agent is for, in a few words (e.g. 'payments integration and webhook verification')" },
        description: { type: "string", description: "Optional longer description for the template body (defaults to role)" },
        task: { type: "string", description: "Optional board task title this agent was created for — recorded in the template so the reason survives." }
      },
      required: ["name", "owner", "role"],
    },
  },
  {
    name: "session_start",
    description: "PLUT_OS: Call this FIRST in a session on this project, unless a SessionStart hook already delivered its brief. Returns the brief: the owner's rules, where the last session left off, settled decisions, your board items, the tool map; later parts by `part`. readOnly: a side session that only reports.",
    inputSchema: {
      type: "object",
      properties: {
        ai: { type: "string", description: "Which AI you are (claude, gemini, cursor, ...) — used to filter the board items assigned to you" },
        part: { type: "integer" },
        readOnly: { type: "boolean" }
      },
      required: []
    }
  },
  {
    name: "session_end",
    description: "PLUT_OS: Call this LAST in a session: it records the session in shared memory and archives what is past budget. Field rules: AGENTS.md, A session.",
    inputSchema: {
      type: "object",
      properties: {
        ai: { type: "string" },
        headline: { type: "string", description: "One line: what this session was about" },
        did: { type: "string" },
        changed: { type: "string", description: "Optional; git is the change log, no file list." },
        next: { type: "string" },
        not_checked: { type: "string" },
        learned: {
          type: "array",
          items: {
            oneOf: [
              { type: "string" },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  claim: { type: "string" },
                  replaces: { type: "string", description: "Exact text of the earlier claim this corrects." },
                  sources: {
                    type: "array",
                    items: {
                      type: "object", additionalProperties: false,
                      properties: { path: { type: "string" }, evidence: { type: "string", description: "Exact excerpt now in that file." } },
                      required: ["path", "evidence"]
                    }
                  }
                },
                required: ["claim", "sources"]
              }
            ]
          },
          description: "Durable claims; a plain string stays unverified."
        },
        decided: {
          type: "array",
          items: {
            oneOf: [
              { type: "string" },
              {
                type: "object", additionalProperties: false,
                properties: { decision: { type: "string" }, supersedes: { type: "string", description: "Id (d-…) it reverses." } },
                required: ["decision"]
              }
            ]
          },
          description: "Settled choices and why."
        },
        story: { type: "string", description: "One plain sentence for the owner, in his language." },
        plutos_feedback: {
          oneOf: [{ type: "string" }, { type: "array", items: { oneOf: [{ type: "string" }, { type: "object" }] } }],
          description: "Optional: what PLUT_OS lacked or forced you to work around in this session (one line each)"
        },
        operation_id: { type: "string", description: "Idempotency key: a retry with it records one session." }
      },
      required: ["headline"]
    }
  },
  {
    name: "plutos_decide",
    description: "PLUT_OS: Record a decision the moment the owner states it; session_end may never run. Only what the owner said; your own choices go in session_end decided.",
    inputSchema: {
      type: "object",
      properties: {
        decision: { type: "string", description: "The owner's words and the reason." },
        supersedes: { type: "string", description: "Id (d-…) of the decision he changed." }
      },
      required: ["decision"]
    }
  },
  {
    name: "plutos_feedback",
    description: "PLUT_OS: One line for PLUT_OS's makers: what it lacked, forced you into, broke, or did well. Appends to docs/handoff/plutos-feedback.jsonl; commit it.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: FEEDBACK_KINDS },
        what: { type: "string" },
        instead: { type: "string", description: "What you did instead" },
        cost: { type: "string", description: "e.g. 10 min, 80 tool calls" },
        evidence: { type: "string", description: "File, command or tool call" }
      },
      required: ["kind", "what"]
    }
  },
  {
    name: "plutos_capture_session",
    description: "PLUT_OS internal hook intake: validates and queues a bounded Claude transcript handoff on PreCompact/SessionEnd. It returns immediately; a detached worker extracts context with the user's Claude CLI. Do not call manually — use session_end for an intentional handoff.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        transcript_path: { type: "string" },
        cwd: { type: "string" },
        event: { type: "string", enum: ["PreCompact", "SessionEnd"] },
        reason: { type: "string" },
        trigger: { type: "string" }
      },
      required: ["session_id", "transcript_path", "cwd", "event"]
    }
  },

];

// What this session was shown by board_read, for its `since` cursor (lib/board-delta.mjs).
const boardReads = createBoardReads();
// The record ids this process actually delivered (session_start, plutos_context_for_task), for the
// session block's Shown field at session_end. The SessionStart hook runs in another process: what
// it offered is not known to have been read, so it is not counted (lib/memory.mjs).
const shownIds = new Set();
const noteShown = (delivered) => { for (const id of idsShownIn(delivered)) shownIds.add(id); return delivered; };
const TRUNCATED = ' …[truncated]';

// The exact step that binds PLUT_OS to the project the client has open, per client, for
// plutos_project_info's `fix` field. `plutos connect` cannot rewire every client (wireClient in
// lib/connect.mjs): a writable:false client (claude-code-local) gets its own command, and an
// existing create-only file (Codex's .codex/config.toml) gets the snippet to paste in its place.
const CLIENT_IDS = {
  'Claude Code': ['claude-code-local', 'claude-code'], Codex: ['codex'], Cursor: ['cursor'], 'VS Code': ['vscode'],
  'Gemini CLI': ['gemini-cli'], Antigravity: ['antigravity'], Windsurf: ['windsurf'], Zed: ['zed'], 'Claude Desktop': ['claude-desktop']
};
function bindingFix(target, clientName) {
  const project = target || '<the project you have open>';
  const quote = value => shellQuote(value);
  // A packaged build has no cli.mjs beside it; the installed `plutos` command is the CLI then.
  const cliFile = path.join(APP_ROOT, 'cli.mjs');
  const cli = fs.existsSync(cliFile) ? `node ${quote(cliFile)}` : 'plutos';
  // A project without the kit has no launcher to connect yet: init installs it and connects in one step.
  const installed = !target || fs.existsSync(path.join(target, STUB_REL));
  const connectStep = id => installed ? `${cli} connect ${id} ${quote(project)}` : `${cli} init ${quote(project)} --client ${id}`;
  // A project that moved: this server is bound to the old folder and the new one carries the kit.
  // One rebind rewires every client config that names the old folder and moves the hub entry (lib/rebind.mjs).
  const rebind = target && installed && !sameProjectPath(PROJECT_ROOT, target)
    ? `${cli} rebind ${quote(project)} --from ${quote(PROJECT_ROOT)}` : null;
  // Each client gets its steps in order, one command each: no && (Windows PowerShell 5.1 refuses it).
  const commands = {};
  for (const id of CLIENT_IDS[clientName] || CLIENTS.map(c => c.id)) {
    const client = findClient(id);
    if (client.writable === false) {
      // plutos connect cannot write this client's config, but it switches on the session hooks
      // (Claude Code) and prints the client's own command, which is the second step.
      commands[id] = [connectStep(id), client.command(configEntry(client, project), project)];
      continue;
    }
    commands[id] = [connectStep(id)];
    const file = configPath(client, project);
    if (target && client.writable === 'create-only' && fs.existsSync(file) && !isWired(client, project)) {
      commands[id].push(`If it refuses because ${file} exists, replace its [${client.key}.plutos] tables with:\n${snippet(client, project)}`);
    }
  }
  return { project, ...(rebind ? { rebind } : {}), commands, then: (rebind ? 'If the project moved here from ' + PROJECT_ROOT + ', run the rebind command first: it rewires every client that names the old folder and prints the manual step for any it cannot write. ' : '') + 'Restart the client (or reload its window) after running its steps in order, so it starts PLUT_OS from that project, then call plutos_project_info again.' };
}

// A fix only where reconnecting is the cure: a project mismatch or a legacy global Codex entry. A
// failed or empty roots reply is not fixed by reconnecting, and with several advertised roots and no
// Claude project directory the open project is not known, so the steps name no path.
function fixFor(bindingError, roots, clientName) {
  if (!bindingError || !/^(Project mismatch|Unsafe legacy Codex)/.test(bindingError)) return null;
  const fileRoots = (roots || []).filter(root => typeof root?.uri === 'string' && root.uri.startsWith('file:'));
  const target = process.env.CLAUDE_PROJECT_DIR || fileRoots.length <= 1 ? activeProjectRoot(process.env, roots) : null;
  return bindingFix(target, clientName);
}

const HANDLERS = {
  async plutos_project_info() {
    const clientInfo = server.getClientVersion?.() || {};
    const capabilities = server.getClientCapabilities?.() || {};
    let roots = [];
    let bindingError = staticBindingError(PROJECT_ROOT, clientInfo, process.env);
    if (capabilities.roots) {
      // Read even when a static check already failed: the roots name the project the fix points at.
      try {
        roots = (await server.listRoots({}, { timeout: 3000 }))?.roots || [];
        bindingError = bindingError || advertisedRootsError(PROJECT_ROOT, roots, ROOTS_OPTIONS);
      } catch (e) {
        bindingError = bindingError || `Project verification failed while reading client roots: ${e.message}`;
      }
    }
    const clientName = canonicalClientName(clientInfo.name) || clientFromEnv(process.env);
    return text(JSON.stringify({
      projectRoot: PROJECT_ROOT,
      projectName: path.basename(PROJECT_ROOT),
      isPlutosProject: looksLikePlutosProject(PROJECT_ROOT),
      client: clientInfo.name || null,
      launcherBound: process.env[LAUNCHER_BOUND_ENV] === '1',
      codexProjectScoped: process.env[CODEX_PROJECT_SCOPE_ENV] === '1',
      clientRootsAvailable: !!capabilities.roots,
      clientRoots: roots.map(root => root.uri).filter(Boolean),
      safe: !bindingError,
      error: bindingError,
      fix: fixFor(bindingError, roots, clientName),
      ...(PLUGIN_MODE ? { plugin: PLUGIN_MODE } : {})
    }));
  },

  init_roadmap(args) {
    try {
      const logs = initRoadmap(PROJECT_ROOT, { withInterview: args?.with_interview || false });
      return text(logs.join('\n'));
    } catch (e) {
      return errorText(`ERROR: Setup failed: ${e.message}`);
    }
  },

  async plutos_modules(args) {
    const action = args?.action || 'list';
    if (action === 'list') return text(JSON.stringify({ drawers: listDrawers(PROJECT_ROOT) }));
    if (action !== 'open' && action !== 'close') return errorText('ERROR: action must be list, open or close.');
    if (typeof args?.id !== 'string' || !args.id) return errorText(`ERROR: id is required to ${action} a drawer.`);
    try {
      const result = setDrawer(PROJECT_ROOT, args.id, action === 'open');
      // Clients that honour list_changed re-read tools/list at once; others see the change on
      // their next listing, which is at the latest their next session.
      if (result.changed && clientInitialized) { try { await server.sendToolListChanged(); } catch (e) { /* client gone */ } }
      const drawer = listDrawers(PROJECT_ROOT).find(d => d.id === result.id);
      const state = result.open ? 'open' : 'closed';
      return text(`${result.changed ? 'Drawer' : 'Drawer already'} ${state}: ${drawer.id} (${drawer.tools.length} tools${result.open ? `: ${drawer.tools.join(', ')}` : ''}). `
        + `It applies to every AI connected to this project. If your tool list does not update, it will in your next session.`
        // Tool definitions sit at the front of every request, so a changed list restarts the
        // client's prompt cache for the whole conversation so far.
        + (result.changed ? ' A changed tool list restarts your prompt cache; when a task needs a drawer, open it at the start of a session.' : ''));
    } catch (e) {
      return errorText(`ERROR: ${e.message}`);
    }
  },

  plutos_context_for_task(args) {
    if (typeof args?.task !== 'string' || !args.task.trim()) return errorText('ERROR: task is required: describe the work in a sentence.');
    try {
      return text(noteShown(taskContext(PROJECT_ROOT, args.task, { maxFiles: args.max_files, budgetTokens: args.budget_tokens }).text));
    } catch (e) {
      return errorText(`ERROR: ${e.message}`);
    }
  },

  board_read(args) {
    let tier;
    try {
      tier = boardTier(args?.board);
    } catch (e) {
      return errorText(`ERROR: ${e.message}`);
    }
    const boardPath = boardPathForTier(PROJECT_ROOT, tier);
    if (!fs.existsSync(boardPath)) {
      return errorText("ERROR: board file not found. Ask the owner to run node cli.mjs init in this project.");
    }
    // This response lands verbatim in an AI's context window, so it is bounded on BOTH axes:
    // entry count (a 2000-entry board is 95k tokens pretty-printed — the context-saving tool
    // must not be the context bomb) and per-field length (writes are capped now, but boards
    // written before the cap, or edited by hand, can still carry megabyte fields).
    // Open work first, DONE last, newest side of the file preferred — then the cap trims
    // archive-fodder, not the active tasks. `limit` lets a caller ask for more explicitly.
    // By default a field is clipped at 600 characters: a board's long notes were most of its 5K-token
    // reads; `detailed` gives each field whole, up to 2,000.
    const MAX_ENTRIES = 100, MAX_FIELD = args?.detailed === true ? 2000 : 600;
    const all = parseBoardEntries(fs.readFileSync(boardPath, 'utf8'));
    const limit = Math.max(1, Math.min(Number(args?.limit) || MAX_ENTRIES, 1000));
    const select = (pool) => {
      const open = pool.filter(e => e.status !== 'DONE');
      const done = pool.filter(e => e.status === 'DONE');
      return [...open.slice(-limit), ...done.slice(-(Math.max(0, limit - Math.min(open.length, limit))))];
    };
    // Only what changed since the cursor this session was given, when it passes one back.
    const delta = boardReads(tier, all, args?.since, select);
    const kept = delta.shown;
    const clip = (s) => typeof s === 'string' && s.length > MAX_FIELD ? s.slice(0, MAX_FIELD - TRUNCATED.length) + TRUNCATED : s;
    // A 16-hex revision prefix is what board_update needs to detect a stale write; the full
    // 64-hex hash cost about 13 tokens more per entry, on every read.
    const entries = kept.map(e => ({
      ...e,
      title: clip(e.title),
      fields: Object.fromEntries(Object.entries(e.fields).map(([k, v]) => [k, clip(v)])),
      notes: (e.notes || []).map(clip),
      revision: e.revision.slice(0, 16)
    }));
    const payload = { board: tier, path: boardPath, total: all.length, cursor: delta.cursor, entries };
    if (delta.mode === 'same' || delta.mode === 'delta') {
      payload.since = args.since;
      payload.unchanged = delta.unchanged;
      if (delta.removed.length) payload.removed = delta.removed;
      payload.note = delta.mode === 'same'
        ? 'Nothing changed since that read.'
        : `Only entries added or changed since that read; ${delta.unchanged} unchanged entries are omitted.`;
    } else if (delta.mode === 'unknown') {
      payload.note = 'That cursor is not from this session, so this is the full board.';
    }
    if (delta.pending > entries.length) {
      payload.note = `${payload.note ? payload.note + ' ' : ''}Showing ${entries.length} of ${delta.pending} entries (open work first). The board is over budget; session_end archives DONE entries automatically, or pass {limit} up to 1000.`;
    }
    // Compact JSON, not pretty-printed: indentation double the token cost of large boards.
    return text(JSON.stringify(payload));
  },

  board_update(args) {
    try {
      // role, needs, priority and verification sit in `extra` since 2026-11-14 (plan section 3). The
      // old flat params are still read for one release so a client with a cached schema keeps working;
      // `extra` wins where both are given.
      const extra = args?.extra && typeof args.extra === 'object' && !Array.isArray(args.extra) ? args.extra : {};
      const pick = key => extra[key] !== undefined ? extra[key] : args?.[key];
      // Shared with the dashboard's POST /api/board — a task the user assigns and a task an
      // AI assigns must land identically on the same file.
      const { action, path: boardPath, tier } = writeBoardEntry(PROJECT_ROOT, {
        board: args?.board,
        agent: args?.agent, status: args?.status, title: args?.title,
        task: args?.task, result: args?.result, note: args?.note, assignee: args?.assignee,
        role: pick('role'), needs: pick('needs'), priority: pick('priority'), verification: pick('verification'), evidence: args?.evidence, expectedRevision: args?.expectedRevision, doneWhen: args?.doneWhen
      });
      const where = tier === 'agents' ? 'Agent board' : 'Board';
      return text(`SUCCESS: ${where} entry ${action}: ${args.agent} · ${args.status.toUpperCase()} · ${args.title}\n(${boardPath} — remember AGENTS.md rule 5: commit board updates so other agents see them.)`);
    } catch (e) {
      return errorText(`ERROR: ${e.message}`);
    }
  },

  // The one tool that waits on a human. Two rules shape it:
  //
  //  - It must never hang. MCP clients cap tool calls (~30s is the common default), and a
  //    handler that outlives that cap doesn't produce a patient agent, it produces a client
  //    error and an agent that has lost the ticket. So: wait under the cap, then hand the
  //    ticket back and let the agent re-ask. Answering an hour later still works.
  //  - It must be async, not a sync sleep. The rest of this codebase waits with Atomics.wait
  //    because its critical sections are milliseconds of file I/O; blocking the event loop
  //    for 25 seconds would freeze the heartbeat and every other tool call on this server.
  async plutos_ask(args) {
    try {
      const existing = args?.ticket ? readApproval(PROJECT_ROOT, String(args.ticket)) : null;
      if (args?.ticket && !existing) {
        return errorText(`ERROR: no question with ticket ${args.ticket} — it was answered and swept, or the id is wrong. Ask again without a ticket.`);
      }
      const agent = args?.agent || args?.ai || detectClientName();
      const ticket = existing || createApproval(PROJECT_ROOT, { agent, question: args?.question, context: args?.context, ttlMinutes: args?.ttl_minutes, options: args?.options, images: args?.images });

      const deadline = Date.now() + ASK_WAIT_MS;
      let current = ticket;
      while (current.status === 'pending' && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, ASK_POLL_MS));
        current = readApproval(PROJECT_ROOT, ticket.id) || current;
      }

      const note = current.note ? `\nOwner's note: ${current.note}` : '';
      // The chosen option is the answer when one was offered — reporting only APPROVED would
      // send the agent back to guessing which of its own routes the owner meant.
      const picked = current.option ? `\nThe owner chose: "${current.option}" — take that route, not another.` : '';
      if (current.status === 'approved') return text(`APPROVED · ${current.id}${note}${picked}\nThe owner approved: "${current.question}" — go ahead.`);
      if (current.status === 'rejected') return text(`REJECTED · ${current.id}${note}\nThe owner said no to: "${current.question}". Do NOT do it. If the note tells you what to do instead, do that; otherwise report back and stop.`);
      if (current.status === 'expired') return text(`EXPIRED · ${current.id}\nNobody answered "${current.question}" in time. Treat this as NOT approved: do not proceed, leave a BLOCKED board entry saying what you are waiting on.`);
      // The owner answers at a terminal (cli.mjs approve/reject, interactive only: O14), so the AI
      // relays the question in chat with the exact command; images are named by path, option by option.
      // Options by number: the commands carry no option text, so nothing the AI wrote reaches the shell.
      const options = current.options?.length ? `Options: ${current.options.map((o, i) => `${i + 1}) ${o}`).join('; ')}.\n` : '';
      const images = current.images?.length ? `Images: ${current.images.map((img, i) => `option ${i + 1}: ${img}`).join('; ')}.\n` : '';
      const commands = answerCommands(PROJECT_ROOT, current, { appRoot: APP_ROOT });
      return text(
        `PENDING · ticket=${current.id}\n` +
        `"${current.question}" is unanswered after ${Math.round(ASK_WAIT_MS / 1000)}s.\n` +
        `THIS IS NOT APPROVAL. Do not proceed. Relay the question to the owner in chat now, with these commands exactly; he answers by running one in a terminal:\n` +
        options + commands.join('\n') + '\n' +
        images +
        `Then call plutos_ask again with {"ticket": "${current.id}"} to keep waiting ` +
        `(it expires ${new Date(current.expiresAt).toISOString()}). If you have unrelated work that does not depend on the answer, do that first and come back.`);
    } catch (e) {
      return errorText(`ERROR: ${e.message}`);
    }
  },

  project_snapshot() {
    try {
      const snap = buildSnapshot(PROJECT_ROOT, { ai: detectClientName() });
      return text(snap.text + `\n\n---\nSnapshot: ${Math.round(snap.bytes / 1024)} KB`
        + `, branch ${snap.branch || '?'} at ${snap.head || '?'}, `
        + `${snap.changedPaths} uncommitted path(s), ${snap.untracked} untracked.`
        + (snap.truncated
          ? ` INCOMPLETE — capped: ${snap.truncatedParts.join(', ')}. Say so if you pass it on.`
          : ''));
    } catch (e) {
      return errorText(`ERROR: ${e.message}`);
    }
  },

  plutos_create_agent(args) {
    try {
      const r = createAgent(PROJECT_ROOT, {
        name: args?.name, owner: args?.owner, role: args?.role,
        description: args?.description, task: args?.task
      });
      const lines = [`SUCCESS: agent "${r.name}" created → ${r.file} (roster: ${r.rosterAction})`];
      lines.push(`The agent exists as a file — your own tool runs it when the user starts it. PLUT_OS starts nothing.`);
      lines.push(`Scope: only your own tool runs it (Claude Code discovers .claude/agents/; another AI keeps its definition beside the agent's memory). Other AIs see it on the roster (owner, role) but cannot run it — that is expected, not a failure.`);
      return text(lines.join('\n'));
    } catch (e) {
      return errorText(`ERROR: ${e.message}`);
    }
  },

  // lib/code-tools.mjs: read-only, over data PLUT_OS already keeps.
  plutos_code_lookup(args) {
    try {
      return text(formatCodeLookup(args?.query, codeLookup(PROJECT_ROOT, args?.query, { limit: args?.limit })));
    } catch (e) {
      return errorText(`ERROR: ${e.message}`);
    }
  },

  plutos_usage() {
    try { return text(usageSummary(PROJECT_ROOT)); } catch (e) { return errorText(`ERROR: ${e.message}`); }
  },

  status_report(args) {
    try {
      const days = Math.max(1, Math.min(90, Number(args?.days) || 7));
      const report = buildStatusReport(PROJECT_ROOT, { days });
      return text(renderReportMarkdown(report) + '\n\n---\nPresent this to the user in THEIR language (keep facts, sources and structure; translate the prose).');
    } catch (e) {
      return errorText(`ERROR: ${e.message}`);
    }
  },

  session_start(args) {
    try {
      // `ai` is optional in the schema and nothing in AGENTS.md tells a caller to pass it, so
      // a caller that omits it used to record no presence at all — a silent no-op, invisible
      // to everyone else on the roster. Fall back to the same auto-identify heuristic already
      // used for the MCP heartbeat instead of dropping the arrival.
      return text(noteShown(sessionBrief(PROJECT_ROOT, args?.ai || detectClientName(), { part: args?.part, readOnly: args?.readOnly === true })));
    } catch (e) {
      return errorText(`ERROR: ${e.message}`);
    }
  },

  session_end(args) {
    try {
      const ai = args?.ai || detectClientName();
      // Legacy id-less DECISION digest lines become records first, only when the scan finds one.
      const migrated = migrationNote(autoMigrateDigestDecisions(PROJECT_ROOT));
      const r = recordSession(PROJECT_ROOT, {
        ai, headline: args?.headline, did: args?.did,
        changed: args?.changed, next: args?.next, notChecked: args?.not_checked, learned: args?.learned,
        decided: args?.decided, story: args?.story,
        operationId: args?.operation_id || args?.operationId,
        shown: [...shownIds]
      });
      // The optional feedback lines (lib/feedback.mjs): written once, not again on an idempotent retry,
      // and never able to fail a session already recorded.
      let feedbackNote = '';
      const feedbackItems = sessionFeedbackItems(args?.plutos_feedback);
      if (feedbackItems.length && !r.duplicate) {
        try {
          const f = recordFeedback(PROJECT_ROOT, feedbackItems, { ai, via: 'session_end' });
          const remapped = [...new Set(feedbackItems.filter(i => i.askedKind).map(i => i.askedKind))];
          feedbackNote = `${f.written} feedback line${f.written === 1 ? '' : 's'} for PLUT_OS added to ${FEEDBACK_REL}.`
            + (remapped.length ? ` Unknown kind${remapped.length === 1 ? '' : 's'} ${remapped.map(k => `"${k}"`).join(', ')} recorded as friction (kinds: ${FEEDBACK_KINDS.join(', ')}).` : '');
        } catch (e) { feedbackNote = `WARNING: the session is recorded, but plutos_feedback was not written: ${e.message}`; }
      }
      // Dashboard state is a mirror of authoritative continuity — never fail the session
      // after the ledger write has already succeeded.
      try {
        updateState(PROJECT_ROOT, {
          taskName: args.headline,
          status: 'COMPLETED',
          notes: [args?.did, args?.next && `Next: ${args.next}`].filter(Boolean).join(' | ')
        });
      } catch (e) { /* best-effort */ }
      let boardTidy = { archived: 0 };
      try { boardTidy = tidyLiveBoards(PROJECT_ROOT); } catch (e) { boardTidy = { archived: 0 }; }
      const tidy = housekeeping(PROJECT_ROOT);
      const notes = [
        `SUCCESS: session ${r.duplicate ? 'already recorded (idempotent retry)' : 'recorded'} in docs/handoff/CONTINUITY.md (${r.sessionCount} live session${r.sessionCount === 1 ? '' : 's'}, digest ${r.digestLines} line${r.digestLines === 1 ? '' : 's'}).`,
        r.context ? `Shared context: ${r.context.sourceBacked} source-backed, ${r.context.unverified} unverified claim${r.context.sourceBacked + r.context.unverified === 1 ? '' : 's'} processed.` : '',
        r.context?.replaceMissed?.length ? `Not replaced (no such claim in the record): ${r.context.replaceMissed.map(c => `"${c}"`).join('; ')}. Copy the old claim's exact text into replaces.` : '',
        r.context?.decisions ? `Decisions recorded: ${r.context.decisions}${r.context.reversed ? ` (${r.context.reversed} earlier one(s) reversed)` : ''}; plutos memory list shows their ids.` : '',
        r.context?.supersedeMissed?.length ? `Not reversed (no such decision id): ${r.context.supersedeMissed.join(', ')}. Use an id from plutos memory list.` : '',
        r.contextError ? `WARNING: the session ledger is safe, but CONTEXT.json could not be updated: ${r.contextError}` : '',
        r.archived ? `${r.archived} older session(s) archived to docs/handoff/archive/.` : '',
        boardTidy.archived ? `${boardTidy.archived} DONE board entr${boardTidy.archived === 1 ? 'y' : 'ies'} archived off the live board.` : '',
        r.digestOverBudget ? digestBudgetNote(r.digestDecisions) : '',
        migrated,
        feedbackNote,
        ...(tidy.lines.length
          ? ['', 'BEFORE YOU COMMIT — these docs/boards drifted this session; update them or say why not:', ...tidy.lines.map(l => `- ${l}`), '']
          : []),
        'Commit the file so the next session (any AI) inherits it. Git is the changelog; do not copy it into another markdown file.'
      ].filter(Boolean);
      return text(notes.join('\n'));
    } catch (e) {
      return errorText(`ERROR: ${e.message}`);
    }
  },

  plutos_decide(args) {
    try {
      const migrated = migrationNote(autoMigrateDigestDecisions(PROJECT_ROOT));
      const reply = decisionReply(recordDecision(PROJECT_ROOT, args?.decision, { ai: detectClientName(), origin: 'plutos_decide', supersedes: args?.supersedes }));
      return text(migrated ? `${reply}\n${migrated}` : reply);
    } catch (e) {
      return errorText(`ERROR: ${e.message}`);
    }
  },

  plutos_feedback(args) {
    try {
      const f = recordFeedback(PROJECT_ROOT, args || {}, { ai: detectClientName(), via: 'mcp' });
      return text(`Recorded for PLUT_OS in ${FEEDBACK_REL} (${f.lines[0].kind}). Commit the file; the owner collects it with plutos feedback collect.`);
    } catch (e) {
      return errorText(`ERROR: ${e.message}`);
    }
  },

  plutos_capture_session(args) {
    try {
      if (!contextAutomationStatus(PROJECT_ROOT).enabled) {
        throw new Error('Automatic context capture is not enabled for this project. The owner enables it with node cli.mjs hooks on capture; use session_end for a manual handoff.');
      }
      const queued = enqueueContextCapture(PROJECT_ROOT, args || {});
      return text(queued.duplicate
        ? `PLUT_OS context capture ${queued.id} was already queued or completed.`
        : `PLUT_OS context capture ${queued.id} queued (${queued.event}); extraction continues in the background.`);
    } catch (e) {
      return errorText(`ERROR: Automatic context capture refused: ${e.message}`);
    }
  }
};

Object.assign(HANDLERS, researchMcpHandlers(PROJECT_ROOT, text, errorText));

const server = new Server(
  { name: "plutos", version: pkg.version },
  {
    capabilities: { tools: { listChanged: true } },
    // A task-to-tool map, not a name list (feedback 2026-11-14 item 1): a session picks a tool by
    // its task. The first 512 characters cover the core tasks and the agents rule (checked in
    // tools/mcp-test.mjs): a client that defers tools decides from them when to search. plutos_code_lookup is file-level, so no line promises callers.
    instructions: `PLUT_OS coordinates the AIs on this project. Task → tool: a session: session_start, session_end; which files a task touches: plutos_context_for_task (agents only for judgment, not look-ups); where a file or symbol is declared, what imports a file (file-level): plutos_code_lookup; sourced web research: research drawer (plutos_modules open research); owner decision: plutos_ask, record one: plutos_decide; tasks: board_read, board_update; a new agent: plutos_create_agent; status report, handover, token use: admin drawer; PLUT_OS lacked something or forced a workaround: plutos_feedback. SAFETY: This PLUT_OS coordinator is bound to ${PROJECT_ROOT}. Use project tools only when that exact repository is the user's active workspace. If another project is active, do not call its read or write tools; reconnect through that project's launcher or project-local MCP config. Call plutos_project_info to diagnose the binding; its fix field has the exact command.`
  }
);

// Heartbeat lives with the hub config so both honor PLUTOS_HOME (test isolation) and
// the dashboard reads the same path — see dashboard.mjs GET /api/mcp/status. Shared constant
// rather than a fifth hand-rolled copy of the expression: the copies are what drifted.
const PLUTOS_HOME = PLUTOS_HOME_DIR;

function detectClientName() {
  // The handshake first: clientInfo.name is what the client says it is, mapped to a canonical
  // name (lib/presence.mjs) and never returned raw. The environment is the fallback, because
  // Claude Code hands CLAUDECODE to every child process, so a seat it spawned would otherwise
  // be "Claude Code" too. In hook mode (--brief, below) there is no handshake, only the
  // environment.
  const name = canonicalClientName(server.getClientVersion?.()?.name) || clientFromEnv(process.env);
  if (name) return name;

  // Fallback: the parent executable name, when the process title carries it.
  const processTitle = (process.title || "").toLowerCase();
  if (processTitle.includes("claude")) return "Claude";
  if (processTitle.includes("cursor")) return "Cursor";
  if (processTitle.includes("antigravity")) return "Antigravity";
  if (processTitle.includes("gemini")) return "Gemini CLI";
  if (processTitle.includes("windsurf") || processTitle.includes("codeium")) return "Windsurf";

  // Last resort: show something useful (MCP PID) instead of "Unknown"
  return `AI Client (PID:${process.ppid || process.pid})`;
}

// mcp_status.json is the one file EVERY client writes: each AI tool spawns its own copy of this
// server, and each one ticks a heartbeat every 10s plus a write per tool call. A plain
// read -> mutate -> writeFileSync loop drops the other processes' client entries (last write wins)
// and can leave torn JSON that the dashboard then reads as "MCP offline" — the exact symptom that
// makes a visibility tool untrustworthy. Same atomic path as the boards; each process only ever
// touches its OWN clients[pid] key, so a retry re-applies cleanly on the fresh content.
const mcpStatusFile = () => path.join(PLUTOS_HOME, 'mcp_status.json');

function describeToolAction(name, args) {
  if (name === 'session_start') return `Started session (${args?.ai || 'AI'})`;
  if (name === 'session_end') return `Finished session: ${args?.headline || args?.task || 'Session end'}`;
  if (name === 'board_update') return `Board: ${args?.title || args?.task || 'Updated task'}`;
  if (name === 'plutos_ask') return `Asked: ${(args?.question || '').slice(0, 35)}...`;
  if (name === 'status_report') return `Requested status report`;
  if (name === 'init_roadmap') return `Initialized roadmap`;
  if (name === 'plutos_project_info') return `Read project info`;
  if (name === 'board_read') return `Read board`;
  if (name === 'plutos_context_for_task') return `Asked for task context`;
  if (name === 'plutos_feedback') return `Feedback for PLUT_OS (${args?.kind || '?'})`;
  if (name === 'plutos_modules') return `Drawers: ${args?.action || 'list'}${args?.id ? ' ' + args.id : ''}`;
  return `Called ${name}`;
}

function updateMcpStatus(action = 'startup', explicitAi = null, actionDetails = null) {
  try {
    mutateMcpStatus(mcpStatusFile(), (status) => {
      status.active = true;
      status.lastHeartbeat = Date.now();
      const currentEntry = status.clients[process.pid];
      let client = explicitAi || (currentEntry?.client && !currentEntry.client.startsWith('AI Client (PID:') ? currentEntry.client : detectClientName());
      if (explicitAi) {
        client = explicitAi;
      }
      status.clients[process.pid] = {
        client,
        project: PROJECT_ROOT,
        pid: process.pid,
        lastActive: Date.now(),
        lastAction: action
      };
      if (!currentEntry) {
        pushMcpLogEntry(status, { event: 'connect', client, project: PROJECT_ROOT, pid: process.pid, at: Date.now() });
      }
      if (action && action !== 'startup' && action !== 'heartbeat' && action !== 'connect' && action !== 'list_tools') {
        pushMcpLogEntry(status, {
          event: 'action',
          client,
          project: PROJECT_ROOT,
          action,
          details: actionDetails || action,
          pid: process.pid,
          at: Date.now()
        });
      } else if (explicitAi && currentEntry && currentEntry.client !== explicitAi) {
        // Fix up the client name in recent connect log if it was recorded generically
        if (Array.isArray(status.log)) {
          for (let i = status.log.length - 1; i >= 0; i--) {
            if (status.log[i].pid === process.pid) {
              status.log[i].client = explicitAi;
              break;
            }
          }
        }
      }

      pruneMcpClients(status);
    });
  } catch (e) {
    // Avoid writing console output inside stdio MCP server stream
  }
}

function cleanupMcpStatus() {
  try {
    if (!fs.existsSync(mcpStatusFile())) return;
    mutateMcpStatus(mcpStatusFile(), (status) => {
      const leaving = status.clients[process.pid];
      if (leaving) pushMcpLogEntry(status, { event: 'disconnect', client: leaving.client, project: PROJECT_ROOT, pid: process.pid, at: Date.now() });
      delete status.clients[process.pid];
      // Only the LAST client out flips active to false — with several AI tools connected, this
      // process exiting says nothing about the others.
      if (Object.keys(status.clients).length === 0) status.active = false;
    });
  } catch (e) {}
}

process.on('exit', cleanupMcpStatus);
process.on('SIGINT', () => { cleanupMcpStatus(); process.exit(0); });
process.on('SIGTERM', () => { cleanupMcpStatus(); process.exit(0); });

// Initialization supplies the client identity and capabilities. Startup alone cannot prove
// a connection belongs to this project; recheck roots before every presence refresh as well.
let clientInitialized = false;
server.onclose = () => {
  clientInitialized = false;
};
// Keep validation and its status write in one queue. Otherwise a delayed valid roots reply
// can restore presence after a newer check has already rejected the client's current root.
let presenceChecks = Promise.resolve();
function validateMcpPresence(action = null, explicitAi = null, details = null) {
  const checked = presenceChecks.then(async () => {
    const unsafeBinding = await requireSafeProjectBinding();
    if (unsafeBinding) cleanupMcpStatus();
    else if (action) updateMcpStatus(action, explicitAi, details);
    return unsafeBinding;
  });
  presenceChecks = checked.catch(() => {});
  return checked;
}
async function refreshMcpPresence(action, explicitAi = null, details = null) {
  if (clientInitialized) await validateMcpPresence(action, explicitAi, details);
}
server.oninitialized = async () => {
  clientInitialized = true;
  await refreshMcpPresence('connect');
};

const _heartbeatInterval = setInterval(() => { void refreshMcpPresence('heartbeat'); }, 10000);
_heartbeatInterval.unref(); // Don't keep process alive just for this

// plutos_capture_session is listed only where capture is on: elsewhere it is about 157 tokens in
// every session for a hook that never fires. Unlisted is not removed: the capture hook calls it by
// name (lib/context-automation.mjs), and a stale list is told below when the switch changed.
const captureOn = () => { try { return contextAutomationStatus(PROJECT_ROOT).enabled; } catch (e) { return false; } };
let captureListed = null;
server.setRequestHandler(ListToolsRequestSchema, async () => {
  await refreshMcpPresence('list_tools');
  captureListed = captureOn();
  return { tools: [...TOOLS.filter(t => t.name !== 'plutos_capture_session' || captureListed), modulesTool(PROJECT_ROOT), ...openDrawerTools(PROJECT_ROOT)] };
});

async function callTool(request) {
  const { name, arguments: args } = request.params;
  const handler = HANDLERS[name];
  if (!handler) throw new Error("Unknown tool");
  // Capture switched on (or off) from the dashboard since the last listing: a client that honours
  // list_changed re-reads the list, so the capture tool appears in this session, not the next.
  if (captureListed !== null && clientInitialized && captureOn() !== captureListed) {
    captureListed = !captureListed;
    try { await server.sendToolListChanged(); } catch (e) { /* client gone */ }
  }

  let explicitAi = null;
  if (name === 'session_start' || name === 'session_end') {
    explicitAi = typeof args?.ai === 'string' ? args.ai : null;
  } else if (name === 'plutos_create_agent') {
    explicitAi = typeof args?.owner === 'string' ? args.owner : null;
  } else if (name === 'board_update') {
    explicitAi = typeof args?.agent === 'string' ? args.agent : null;
  } else if (name === 'plutos_ask' || name === 'status_report') {
    explicitAi = typeof args?.ai === 'string' ? args.ai : (typeof args?.agent === 'string' ? args.agent : null);
  }

  const unsafeBinding = await validateMcpPresence();
  if (unsafeBinding) {
    if (requiresProjectBinding(name)) return unsafeBinding;
  }
  // A closed drawer's tools are unlisted; a client with a stale list is told how to open it.
  // This comes before the project guard so the answer names the real reason: outside a kit
  // project a closed-drawer tool used to read "not a PLUT_OS project".
  const drawer = drawerOfTool(name);
  if (drawer && !isDrawerOpen(PROJECT_ROOT, drawer)) {
    return errorText(`ERROR: ${name} belongs to the "${drawer}" drawer, which is closed in this project. Open it with plutos_modules {"action":"open","id":"${drawer}"} if the task needs it.`);
  }
  // Project guard lives here, not in each handler: a new mutating tool is denied by default.
  if (requiresProject(name, args || {})) {
    const notProject = requireProject();
    if (notProject) return notProject;
  }
  const result = await handler(args);
  // A read-only side session leaves no trace, presence included.
  const readOnlyStart = name === 'session_start' && args?.readOnly === true;
  if (!result?.isError && !readOnlyStart) await refreshMcpPresence(name, explicitAi, describeToolAction(name, args));
  return result;
}

// The usage log (lib/usage-log.mjs): every call to a known tool, drawer tools included, is one
// line with its duration and ok flag; never its arguments or output. Recording runs after the
// result is settled and is wrapped twice over, so it can never change a result or an error.
// A client PLUT_OS has no canonical name for (Goose, say) keeps its handshake name, a label and
// never content, so two such clients stay two rows; only a client with no name falls back to the
// environment.
const usageClient = () => {
  try {
    const raw = server.getClientVersion?.()?.name;
    const label = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ').slice(0, 60) : '';
    return canonicalClientName(raw) || label || clientFromEnv(process.env);
  } catch (e) { return null; }
};
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const started = performance.now();
  let ok = false;
  try {
    const result = await callTool(request);
    ok = !result?.isError;
    return result;
  } finally {
    try {
      const name = request?.params?.name;
      if (typeof name === 'string' && Object.hasOwn(HANDLERS, name)) {
        // A read-only session_start is a side session that only reports, not a session start.
        const readOnly = name === 'session_start' && request?.params?.arguments?.readOnly === true;
        recordUsage(PROJECT_ROOT, { ai: usageClient(), kind: 'tool', name, ok, ms: performance.now() - started, readOnly });
      }
    } catch (e) { /* recording never reaches the client */ }
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// The SessionStart hook (lib/project-hooks.mjs) runs this entry point through the project's own
// launcher with --brief: print the session_start brief, fitted to the hook limit, and leave
// without starting the MCP server. A folder that is not a PLUT_OS project gets nothing.
if (process.argv.includes('--brief')) {
  const started = performance.now();
  // The SessionStart event on stdin says why the hook fired (startup, resume, clear, compact): only
  // a startup is a new session in the usage log. Read without blocking and given 200 ms at most,
  // after the brief is out, so a pipe that never closes delays nothing the AI sees.
  // The 200 ms start once the brief is out: building it is synchronous, and on Windows a timer armed
  // before it could fire before the queued stdin data is read.
  let armHookTimeout = () => {};
  const hookEvent = new Promise(resolve => {
    if (process.stdin.isTTY) return resolve({});
    let buf = '';
    const done = () => { try { resolve(JSON.parse(buf) || {}); } catch (e) { resolve({}); } };
    armHookTimeout = () => setTimeout(done, 200).unref();
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', d => { buf += d; });
      process.stdin.on('end', done);
      process.stdin.on('error', () => resolve({}));
    } catch (e) { resolve({}); }
  });
  let out = '', briefOk = false;
  try {
    if (looksLikePlutosProject(PROJECT_ROOT)) {
      // A hook added to the defaults since this project was wired comes on here, once (owner offs kept).
      // Not from the plugin: its hooks come with it, and it writes no hook settings into a project.
      if (process.env.PLUTOS_PLUGIN !== '1') healDefaultHooks(PROJECT_ROOT);
      out = hookBrief(sessionBriefParts(PROJECT_ROOT, detectClientName()));
      briefOk = true;
    }
  } catch (e) { out = `PLUT_OS brief unavailable (${e.message}); call session_start.`; }
  // Pipes are asynchronous on Windows and macOS: exit only once the text is out. Then one usage
  // line per brief run (nothing outside a PLUT_OS project): "brief" for a startup or an unknown
  // source, "brief:<source>" otherwise. It runs after the text is written and cannot touch it.
  process.stdout.write(out, async () => {
    try {
      armHookTimeout();
      const ev = await hookEvent;
      const source = typeof ev?.source === 'string' ? ev.source.trim().toLowerCase().replace(/[^a-z_-]/g, '').slice(0, 20) : '';
      const name = !source || source === 'startup' ? 'brief' : `brief:${source}`;
      recordUsage(PROJECT_ROOT, { ai: clientFromEnv(process.env), kind: 'hook', name, ok: briefOk, ms: performance.now() - started });
    } catch (e) {}
    process.exit(0);
  });
} else main().catch((error) => {
  cleanupMcpStatus();
  process.exit(1);
});
