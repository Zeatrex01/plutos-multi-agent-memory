#!/usr/bin/env node
// PLUT_OS dashboard — thin HTTP layer. All business logic lives in lib/*.mjs;
// each route handler only translates HTTP <-> lib calls.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import { APP_ROOT, PLUTOS_HOME_DIR } from './lib/approot.mjs';
import { registerCurrentInstall, storageInfo } from './lib/app-data.mjs';
import { isDevMode, DEV_PORT, devSandboxDir } from './lib/run-mode.mjs';

import * as workspaces from './lib/workspaces.mjs';
import { recommendedMcps, RECOMMENDED_MCPS, installRecommendedMcp, projectMcpKeys } from './lib/mcps.mjs';
import { listDirs } from './lib/fs-browse.mjs';
import { parseBoardEntries } from './lib/board.mjs';
import { hygieneReport, archiveDoneEntries, docDrift } from './lib/hygiene.mjs';
import { continuityPathFor, parseContinuity } from './lib/continuity.mjs';
import { assessContext } from './lib/context.mjs';
import { MCP_REQUESTS, requestMcpSetup } from './lib/mcp-requests.mjs';
import { buildStatusReport, renderReportMarkdown } from './lib/report.mjs';
import { buildDeck, renderDeckMarkdown, renderDeckHtml } from './lib/deck.mjs';
import { boardPathFor, agentBoardPathFor } from './lib/roadmap.mjs';
import { rosterPathFor, parseRoster } from './lib/roster.mjs';
import { removeRosterAgent } from './lib/roster-store.mjs';
import { readState } from './lib/state.mjs';
import { runCodeScan, readIndexShards, CODEINDEX_SHARD_DIR, OBSIDIAN_SHARD_DIR } from './lib/codeindex.mjs';
import { buildProjectDocGraph, getProjectDocGraphStatus, cleanProjectGraph, isGraphAutoRefresh, setGraphAutoRefresh, renderGraphPage } from './lib/graphify.mjs';
import { QUESTIONS, parseInterview, recommend, renderInterview } from './lib/interview.mjs';
import { scanProject, buildRecommendation } from './lib/recommend.mjs';
import { getActivity } from './lib/activity.mjs';
import { writeBoardEntry, boardTier } from './lib/board-store.mjs';
import { listApprovals, answerApproval, approvalTier, tierAllows, designPickImagePath } from './lib/approvals.mjs';
import { routeNeedsProject, PROJECT_WRITE_ROUTES, PROJECT_PAGE_ROUTES, NO_PROJECT_READ_PAYLOAD, NO_PROJECT_MESSAGE } from './lib/route-policy.mjs';
import { readIdeas, addIdea } from './lib/ideas.mjs';
import { openBrowser } from './lib/open-browser.mjs';
import { connectionPlan, wireClient, STUB_REL } from './lib/connect.mjs';
import { contextAutomationStatus, setContextAutomation, CONTEXT_AUTOMATION_NOTICE } from './lib/context-automation.mjs';
import { watcherStatus, setWatcher, requestDelegatedWatchers, WATCHER_SEATS } from './lib/watcher.mjs';
import { projectHooksStatus, setProjectHook, codexClaimCheckStatus } from './lib/project-hooks.mjs';
import { buildSnapshot } from './lib/snapshot.mjs';
import { contextCaptureStatus } from './lib/context-capture.mjs';
import * as auth from './lib/auth.mjs';
import { sameProjectPath } from './lib/project-binding.mjs';
import { mutateMcpStatus, readMcpStatus, pruneMcpClients, projectMcpStatus } from './lib/mcp-status.mjs';
import { managementRoutes, assertBoardProject, projectCoordinationRoot } from './lib/management-routes.mjs';
import { researchRoutes } from './lib/research/routes.mjs';
import { councilRoutes } from './lib/council-routes.mjs';
import { updateRoutes } from './lib/update-routes.mjs';
import { getProjectSpend, runProjectSpend } from './lib/spend.mjs';
import { readTokenUsage } from './lib/usage.mjs';
import { applyApprovedSideEffects } from './lib/approval-effects.mjs';
import { SKILL_HOMES, PACK_ID_RE, scanProjectSkills, listPacks, registerPack, forgetPack, activatePack, deactivatePack, readActivation } from './lib/skills.mjs';

// Not the file's real dirname — the app root (exe folder when packaged, repo root in
// dev). Everything served/copied from here must ship next to the packaged exe.
const __dirname = APP_ROOT;
// Development mode (lib/run-mode.mjs) defaults to its own port, so it runs beside the normal app.
const DEV_MODE = isDevMode();
let PORT = Number(process.env.PLUTOS_PORT) || (DEV_MODE ? DEV_PORT : 3040);

// Loopback only, always: /api/fs/list and /api/workspaces/add must never be reachable from the
// network. The checks that close what loopback leaves open are in lib/auth.mjs.
const LISTEN_HOST = '127.0.0.1';

// Packaged, PLUT_OS is double-clicked, not run from a prompt: it opens its own browser and,
// built windowless, has no console to print to. Both behaviours key off the packaged flag
// alone — `node dashboard.mjs` in a checkout (and therefore every test run) is unchanged, or
// the suite would spawn a browser per run.
const PACKAGED = process.env.PLUTOS_PACKAGED === '1';
if (DEV_MODE && PACKAGED) {
    console.error('Development mode runs the PLUT_OS source being edited, not a built copy. Start DEV_PLUT_OS.bat or `npm run dev` from the checkout.');
    process.exit(1);
}
const OPEN_BROWSER = !process.argv.includes('--no-open') && (PACKAGED || process.argv.includes('--open'));
// The source BAT can run alongside a portable copy. An explicitly configured port
// remains authoritative, and packaged startup keeps its existing single-instance policy.
const AUTO_PORT = !PACKAGED && process.argv.includes('--auto-port') && !process.env.PLUTOS_PORT;

// A windowless build has nowhere to print, and a failure nobody can see is worse than no app
// at all. Mirror the console into stable user data — truncated per run, so it always reads as
// "what happened this launch" and survives rebuilding or moving the portable app.
if (PACKAGED) {
    const logDir = path.join(PLUTOS_HOME_DIR, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, 'plutos.log');
    try {
        fs.writeFileSync(logFile, `PLUT_OS — ${new Date().toISOString()}\n`, 'utf8');
        for (const level of ['log', 'error', 'warn']) {
            const original = console[level].bind(console);
            console[level] = (...args) => {
                try { fs.appendFileSync(logFile, args.join(' ') + '\n', 'utf8'); } catch (e) { /* read-only install or full disk — never take the app down for a log line */ }
                try { original(...args); } catch (e) { /* windowless build: no console attached */ }
            };
        }
    } catch (e) { /* run without a log rather than refusing to start */ }
}

// Started from a project's own launcher? Then open that project, before the first request can
// read the active workspace. Placed after the log mirror above so a packaged, windowless build
// still records why a bound launch did not open. Registering an unseen project can fail (a
// damaged install has no handoff templates); that is worth saying out loud, but not worth
// refusing to start over — the Hub is a usable fallback and the message names the real cause.
try {
    // Development mode has one project of its own, PLUT_OS itself, and opens on it.
    if (!workspaces.openLauncherBoundWorkspace() && DEV_MODE) workspaces.openDevSelfProject();
} catch (e) {
    console.error(`Warning: could not open the project this launcher is bound to: ${e.message}`);
}

// --- HTTP helpers -----------------------------------------------------------

function sendJson(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
}

// Every route reads its body here, so both size and time are bounded. The largest legitimate
// body is a form: board fields stop at 2000 characters. 1 MiB is far above that; a route that ever needs more should say so at its call site.
const BODY_LIMIT_BYTES = 1024 * 1024;
const BODY_TIMEOUT_MS = 15_000;

// Rejections carry statusCode (413 too large, 408 too slow) and the dispatcher answers with
// it. `fallback` stands in for an empty or malformed body on routes whose fields are all
// optional; an oversized or stalled body is never a fallback case.
function readJsonBody(req, { fallback } = {}) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        const settle = (error, value) => {
            clearTimeout(timer);
            req.off('data', onData).off('end', onEnd).off('error', onLost).off('close', onLost);
            if (!error) { resolve(value); return; }
            // Drain instead of pausing: nothing more is kept, and the client can finish its
            // write and read the refusal instead of a reset. Node closes the connection once
            // the response is out, because the request never completed.
            req.resume();
            reject(error);
        };
        const refuse = (statusCode, message) => settle(Object.assign(new Error(message), { statusCode }));
        const onData = chunk => {
            size += chunk.length;
            if (size > BODY_LIMIT_BYTES) refuse(413, `Request body is larger than ${BODY_LIMIT_BYTES} bytes.`);
            else chunks.push(chunk);
        };
        const onEnd = () => {
            let value;
            try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
            catch (error) {
                if (fallback === undefined) { settle(error); return; }
                value = fallback;
            }
            settle(null, value);
        };
        const onLost = () => refuse(400, 'The request body was not received.');
        const timer = setTimeout(() => refuse(408, 'The request body took too long to arrive.'), BODY_TIMEOUT_MS);
        req.on('data', onData).on('end', onEnd).on('error', onLost).on('close', onLost);
    });
}

// Source files and PLUT_OS coordination data are separate in observe mode. Keep the choice
// centralized so a new route cannot accidentally turn "read this project" into "write into
// this project" by reaching for getProjectRoot() out of habit.
const sourceRoot = () => workspaces.getProjectRoot();
const coordinationRoot = () => workspaces.getCoordinationRoot();
const indexRoot = () => workspaces.getIndexRoot();

function requireCapturedProject(expected) {
    if (typeof expected !== 'string' || !expected) {
        throw Object.assign(new Error('A projectRoot is required. Refresh this view before continuing.'), { statusCode: 400 });
    }
    try { assertBoardProject({ projectRoot: expected }); }
    catch (error) { error.statusCode = 409; throw error; }
    return workspaces.getActiveWorkspace();
}

function requireInstalledProject(expected) {
    if (arguments.length) requireCapturedProject(expected);
    const root = workspaces.getActiveWorkspace();
    if (!root) throw new Error('Select a workspace first.');
    if (!workspaces.isWorkspaceInstalled(root)) {
        throw Object.assign(new Error('This project is in observe-only mode. Install the PLUT_OS project kit explicitly before adding AI connections.'), { code: 'observe-only' });
    }
    return root;
}

// --- Routes ------------------------------------------------------------------

const routes = {
    'GET /api/app/mode': (req, res) => sendJson(res, 200, { cleanHarness: process.env.PLUTOS_CLEAN_HARNESS === '1', dataHome: PLUTOS_HOME_DIR, appRoot: APP_ROOT,
        devMode: DEV_MODE, ...(DEV_MODE ? { sandbox: devSandboxDir(PLUTOS_HOME_DIR) } : {}) }),
    // Liveness for the browser client (ui/modules/browser-presence.js): "is PLUT_OS here and is
    // this the owner at the computer". Like every route it answers the local owner only, so
    // both fields are true whenever it answers at all; they stay for the client's shape.
    'GET /api/auth/status': (req, res) => {
        sendJson(res, 200, { loopback: auth.isLocalOwner(req), authenticated: isAuthenticated(req), port: PORT });
    },

    'GET /api/settings/storage': (req, res) => {
        const activeProject = workspaces.getActiveWorkspace();
        const info = storageInfo({
            activeProject,
            projectDataRoot: activeProject ? workspaces.getCoordinationRoot(activeProject) : '',
            installed: activeProject ? workspaces.isWorkspaceInstalled(activeProject) : false
        });
        sendJson(res, 200, {
            ...info,
            runtime: { platform: process.platform, node: process.version, packaged: PACKAGED, port: PORT }
        });
    },

    'GET /api/workspaces': (req, res) => {
        // lastWorkspace is what the owner had open last time. It is NOT open now — the Hub
        // offers it as a one-click resume instead of the app deciding for them.
        let activeProjectRoot = null;
        try { if (workspaces.getActiveWorkspace()) activeProjectRoot = fs.realpathSync(workspaces.getActiveWorkspace()); }
        catch { /* A missing registered folder remains visible in the project list. */ }
        sendJson(res, 200, {
            workspaces: workspaces.getWorkspaces(),
            workspaceDetails: workspaces.getWorkspaces().map(workspaces.workspaceDetails),
            activeWorkspace: workspaces.getActiveWorkspace(),
            activeProjectRoot,
            lastWorkspace: workspaces.getLastWorkspace(),
            activeDetails: workspaces.getActiveWorkspace()
                ? workspaces.workspaceDetails(workspaces.getActiveWorkspace())
                : null
        });
    },

    'POST /api/workspaces/add': async (req, res) => {
        const data = await readJsonBody(req);
        try {
            const result = workspaces.addWorkspace(data.path, data);
            sendJson(res, 200, {
                success: true,
                workspaces: workspaces.getWorkspaces(),
                activeWorkspace: workspaces.getActiveWorkspace(),
                mode: result && result.mode,
                installed: !!(result && result.installed),
                storageRoot: result && result.storageRoot,
                detected: result && result.detected ? result.detected : null,
                mcpWired: !!(result && result.mcpWired)
            });
        } catch (e) {
            sendJson(res, 400, { success: false, message: e.message });
        }
    },

    // The only dashboard action that installs PLUT_OS artifacts into an observed project.
    // It deliberately does NOT connect an AI client; that is a second explicit choice in
    // the Connect panel, with the exact scope/path visible before anything is written.
    'POST /api/project/install': async (req, res) => {
        const data = await readJsonBody(req, { fallback: {} });
        try {
            const result = workspaces.installWorkspace(workspaces.getActiveWorkspace(), data);
            sendJson(res, 200, {
                success: true,
                ...result,
                details: workspaces.workspaceDetails(workspaces.getActiveWorkspace()),
                message: result.alreadyInstalled
                    ? 'PLUT_OS project kit is already installed.'
                    : `PLUT_OS project kit installed. ${result.migrated.length} local coordination file(s) migrated; no AI client was connected.`
            });
        } catch (e) {
            sendJson(res, 400, { success: false, message: e.message });
        }
    },

    'POST /api/workspaces/switch': async (req, res) => {
        const data = await readJsonBody(req);
        try {
            workspaces.switchWorkspace(data.path);
            sendJson(res, 200, { success: true, activeWorkspace: workspaces.getActiveWorkspace() });
        } catch (e) {
            sendJson(res, 400, { success: false, message: e.message });
        }
    },

    // Closing is not removing: the project stays registered and remains the remembered
    // one-click resume. Takes no path — there is only ever one open project to close, and
    // accepting one would invite closing a project that is not the open one.
    'POST /api/workspaces/close': (req, res) => {
        workspaces.closeWorkspace();
        sendJson(res, 200, { success: true, activeWorkspace: workspaces.getActiveWorkspace() });
    },

    'POST /api/workspaces/remove': async (req, res) => {
        const data = await readJsonBody(req);
        try {
            workspaces.removeWorkspace(data.path);
            sendJson(res, 200, { success: true, workspaces: workspaces.getWorkspaces(), activeWorkspace: workspaces.getActiveWorkspace() });
        } catch (e) {
            sendJson(res, 400, { success: false, message: e.message });
        }
    },

    ...managementRoutes({ sendJson, readJsonBody }),
    ...researchRoutes({ sendJson, readJsonBody, getProjectRoot: () => workspaces.getActiveWorkspace() }),
    ...councilRoutes({ sendJson, readJsonBody, coordinationRoot, requireCapturedProject }),
    // Settings → Updates: this install (APP_ROOT), never the open project.
    ...updateRoutes({ sendJson, readJsonBody, root: APP_ROOT, packaged: PACKAGED, devMode: DEV_MODE }),

    // The service worker (ui/sw.js), at the root so its scope is the whole app. Its one job is the
    // "PLUT_OS is not running" page; no-cache so a new worker is picked up on the next load.
    'GET /sw.js': (req, res) => {
        let body = null;
        try { body = fs.readFileSync(path.join(uiDir, 'sw.js')); } catch { /* missing: 404 */ }
        if (!body) { res.writeHead(404); res.end('Not Found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' });
        res.end(body);
    },

    // Project interview (Setup tab). Reads/writes docs/handoff/PROJECT_INTERVIEW.md
    // of the active project — the same file any AI fills in via AGENTS.md Rule 0.
    'GET /api/interview': (req, res) => {
        const projectRoot = coordinationRoot();
        const file = path.join(projectRoot, 'docs', 'handoff', 'PROJECT_INTERVIEW.md');
        const answers = fs.existsSync(file) ? parseInterview(fs.readFileSync(file, 'utf8')) : {};
        sendJson(res, 200, {
            exists: fs.existsSync(file),
            project: path.basename(projectRoot),
            questions: QUESTIONS,
            answers,
            recommendation: recommend(answers)
        });
    },

    'POST /api/interview': async (req, res) => {
        const data = await readJsonBody(req);
        try {
            const projectRoot = coordinationRoot();
            if (!workspaces.getActiveWorkspace()) throw new Error('Select a workspace first.');
            const answers = {};
            for (const q of QUESTIONS) {
                if (data.answers && q.options.includes(data.answers[q.id])) answers[q.id] = data.answers[q.id];
            }
            const dir = path.join(projectRoot, 'docs', 'handoff');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'PROJECT_INTERVIEW.md'), renderInterview(answers), 'utf8');
            sendJson(res, 200, { success: true, answers, recommendation: recommend(answers) });
        } catch (e) {
            sendJson(res, 400, { success: false, message: e.message });
        }
    },

    // The recommendation engine: scans the active project's actual files (package.json deps,
    // engine markers, tests, monorepo, git) and combines that with any interview answers —
    // works with ZERO interview (Structure-only / no-AI projects still get real signal).
    // Suggestion only; nothing here writes to disk.
    'GET /api/recommendations': (req, res) => {
        const projectRoot = sourceRoot();
        const interviewFile = path.join(coordinationRoot(), 'docs', 'handoff', 'PROJECT_INTERVIEW.md');
        const hasInterview = fs.existsSync(interviewFile);
        const answers = hasInterview ? parseInterview(fs.readFileSync(interviewFile, 'utf8')) : {};
        const signals = scanProject(projectRoot);
        sendJson(res, 200, {
            project: path.basename(projectRoot),
            projectRoot,
            installed: workspaces.isWorkspaceInstalled(projectRoot),
            hasInterview,
            signals,
            recommendation: buildRecommendation(signals, answers)
        });
    },

    // Remove an agent from the roster — the owner's explicit action from the Board tab.
    'POST /api/roster/remove': async (req, res) => {
        const data = await readJsonBody(req);
        try {
            removeRosterAgent(requireInstalledProject(), data.name);
            sendJson(res, 200, { success: true, message: `${data.name} removed from the roster.` });
        } catch (e) {
            sendJson(res, 400, { success: false, message: e.message });
        }
    },

    'GET /api/board': (req, res, url) => {
        // A watcher belongs to its installed project, independently of the dashboard tab.
        // Explicit reads are restricted to registered workspaces, never arbitrary paths.
        let project = workspaces.getActiveWorkspace();
        if (url.searchParams.has('project')) {
            const requested = url.searchParams.get('project');
            if (!requested || !path.isAbsolute(requested)) {
                sendJson(res, 400, { success: false, message: 'A project must be an absolute registered workspace path.' });
                return;
            }
            project = workspaces.getWorkspaces().find(root => sameProjectPath(root, requested));
            if (!project || !fs.existsSync(project)) {
                sendJson(res, 404, { success: false, message: 'The requested project is not an available registered workspace.' });
                return;
            }
        }
        const sourceProject = fs.realpathSync(project);
        const projectRoot = workspaces.getCoordinationRoot(project);
        let which;
        try { which = boardTier(url.searchParams.get('board')); } catch (e) {
            sendJson(res, 400, { success: false, message: e.message });
            return;
        }
        const boardPath = which === 'agents' ? agentBoardPathFor(projectRoot) : boardPathFor(projectRoot);
        if (!fs.existsSync(boardPath)) {
            sendJson(res, 200, { exists: false, board: which, entries: [], project: path.basename(project), projectRoot: sourceProject });
            return;
        }
        sendJson(res, 200, {
            exists: true,
            board: which,
            project: path.basename(project),
            projectRoot: sourceProject,
            path: boardPath,
            updatedAt: fs.statSync(boardPath).mtime,
            entries: parseBoardEntries(fs.readFileSync(boardPath, 'utf8'))
        });
    },

    'GET /api/hygiene': (req, res) => {
        sendJson(res, 200, hygieneReport(coordinationRoot(), { sourceRoot: sourceRoot(), indexRoot: indexRoot() }));
    },

    // Mechanical board cleanup — no AI involved: DONE entries move to
    // docs/handoff/archive/BOARD-<YYYY-MM>.md so the live board stays readable.
    'POST /api/board/archive': async (req, res) => {
        const data = await readJsonBody(req);
        try {
            const result = archiveDoneEntries(coordinationRoot(), data.board === 'agents' ? 'agents' : 'board');
            sendJson(res, 200, {
                success: true,
                ...result,
                message: result.archived
                    ? `Archived ${result.archived} DONE entr${result.archived === 1 ? 'y' : 'ies'} → ${result.archivePath}`
                    : 'Nothing to archive — no DONE entries on this board.'
            });
        } catch (e) {
            sendJson(res, 400, { success: false, message: e.message });
        }
    },

    // Session memory — the durable half of the continuity loop (session_start/session_end).
    'GET /api/continuity': (req, res) => {
        const root = coordinationRoot();
        const file = continuityPathFor(root);
        const exists = fs.existsSync(file);
        const parsed = exists ? parseContinuity(fs.readFileSync(file, 'utf8')) : { digest: [], sessions: [] };
        const context = assessContext(root);
        sendJson(res, 200, {
            exists: exists || context.exists,
            ...(exists ? { path: file, updatedAt: fs.statSync(file).mtime } : {}),
            ...parsed,
            context
        });
    },

    // The third map: status report — what happened / what changed / what's next, assembled
    // per request from git + CONTINUITY + boards + hygiene. Never stored, cannot go stale.
    'GET /api/report': (req, res, url) => {
        const days = Math.max(1, Math.min(90, Number(url.searchParams.get('days')) || 7));
        const report = buildStatusReport(coordinationRoot(), { days, sourceRoot: sourceRoot(), indexRoot: indexRoot() });
        sendJson(res, 200, { ...report, markdown: renderReportMarkdown(report) });
    },

    // The story deck: the project's history as a plain-language presentation, merged from
    // the live session ledger + the archive. GET /deck serves it as a standalone page.
    // ?lang= — the deck is the one output written for the OWNER to read, so its chrome
    // follows the UI language (the dashboard's Story Deck link passes the current one).
    // Unknown/absent falls back to English inside lib/deck.mjs. The slide text itself is the
    // AI-recorded `story` line and is never machine-translated.
    'GET /api/deck': (req, res, url) => {
        const deck = buildDeck(coordinationRoot(), { sourceRoot: sourceRoot() });
        sendJson(res, 200, { ...deck, markdown: renderDeckMarkdown(deck, url?.searchParams.get('lang')) });
    },

    'GET /deck': (req, res, url) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderDeckHtml(buildDeck(coordinationRoot(), { sourceRoot: sourceRoot() }), url?.searchParams.get('lang')));
    },

    'GET /api/state': (req, res) => {
        const data = readState(coordinationRoot());
        sendJson(res, 200, data || { state: null, recent: [] });
    },

    // Polled every few seconds by the live strip. Read-only and cheap on purpose: it must
    // stay safe to call on a loop, so it derives everything and stores nothing.
    'GET /api/activity': (req, res) => {
        // getActiveWorkspace(), NOT getProjectRoot(): with no project selected the latter
        // falls back to process.cwd(), which is the PLUT_OS install itself — the strip then
        // showed PLUT_OS's own branch and dirty files while the header said "proj: none".
        sendJson(res, 200, getActivity(workspaces.getActiveWorkspace()));
    },

    // Participants are part of /api/activity on purpose — the strip already polls it, and a
    // second endpoint for the same data is one more thing to keep in sync.

    // Assigning work is the owner's core action, and until now the dashboard could only READ
    // the board and archive it — to add a task you had to ask an AI or hand-edit BOARD.md.
    // Goes through the same lib call as the MCP board_update, so a task the owner assigns is
    // indistinguishable from one an AI assigned.
    'POST /api/board': async (req, res) => {
        const data = await readJsonBody(req);
        try {
            assertBoardProject(data);
            const { action, tier } = writeBoardEntry(coordinationRoot(), data);
            sendJson(res, 200, {
                success: true, action,
                message: `Task ${action} on the ${tier === 'agents' ? 'agent board' : 'board'}: ${data.title}`
            });
        } catch (e) {
            sendJson(res, /changed|conflict|revision/i.test(e.message) ? 409 : 400, { success: false, message: e.message });
        }
    },

    // Questions an agent stopped to ask (the plutos_ask queue). Polled every few seconds by
    // every open dashboard, so it stays a directory scan of small files and nothing more —
    // no git, no markdown parsing, no project scan. An unanswered question means an agent is
    // sitting idle, which is why the UI shows it over whatever tab you are on.
    // AI costs. The project's own ledger: Claude Code's transcripts for the open project only,
    // read off this machine, no network and no outside tool.
    'GET /api/usage': (req, res, url) => {
        const force = !!(url && url.searchParams && url.searchParams.get('force'));
        sendJson(res, 200, readTokenUsage(workspaces.getActiveWorkspace(), { force, onlyProject: true }));
    },
    // CodeBurn's machine-wide figures: GET answers with the last run (or standby) and never
    // starts CodeBurn; POST /api/spend/run is the owner's button. CodeBurn is run with npx --no,
    // so a machine without it gets standby, never a download.
    'GET /api/spend': (req, res, url) => {
        const p = url && url.searchParams ? url.searchParams : null;
        sendJson(res, 200, getProjectSpend('', p ? (p.get('range') || 'month') : 'month', p ? (p.get('from') || '') : ''));
    },
    'POST /api/spend/run': (req, res, url) => {
        const p = url && url.searchParams ? url.searchParams : null;
        sendJson(res, 200, runProjectSpend('', p ? (p.get('range') || 'month') : 'month', p ? (p.get('from') || '') : ''));
    },

    'GET /api/approvals': (req, res) => {
        try {
            const expected = new URL(req.url, 'http://localhost').searchParams.get('project');
            const projectRoot = assertBoardProject({ projectRoot: expected });
            const via = answeredVia(req);
            sendJson(res, 200, { projectRoot, project: path.basename(projectRoot), via,
                pending: listApprovals(projectCoordinationRoot(projectRoot))
                    .map(ticket => ({ ...ticket, approvableHere: tierAllows(approvalTier(ticket.action), via) })) });
        } catch (error) {
            sendJson(res, /changed/i.test(error.message) ? 409 : 400, { success: false, message: error.message });
        }
    },

    // An image a question shows (an A/B design pick): only a render under docs/ai/design-picks/ of
    // the open project, checked by the same function that checked it when the ticket was made.
    'GET /api/approvals/image': (req, res) => {
        try {
            const params = new URL(req.url, 'http://localhost').searchParams;
            const projectRoot = assertBoardProject({ projectRoot: params.get('project') });
            const file = designPickImagePath(projectCoordinationRoot(projectRoot), params.get('path') || '');
            const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[path.extname(file).toLowerCase()];
            res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
            res.end(fs.readFileSync(file));
        } catch (error) {
            sendJson(res, 404, { success: false, message: error.message });
        }
    },

    // The owner's answer. Approve or reject, plus an optional note that reaches the agent as
    // "do this instead" — which is what keeps a rejection from costing a whole round trip.
    'POST /api/approvals': async (req, res) => {
        const data = await readJsonBody(req);
        try {
            const projectRoot = assertBoardProject(data);
            const ticket = answerApproval(projectCoordinationRoot(projectRoot), data.id, {
                decision: data.decision, note: data.note, option: data.option, via: answeredVia(req)
            });
            // A ticket with an action runs its side effect here, the same call the CLI makes.
            applyApprovedSideEffects(projectRoot, ticket);
            sendJson(res, 200, {
                success: true, status: ticket.status, option: ticket.option,
                message: ticket.option
                    ? `Sent "${ticket.option}" — ${ticket.agent} can continue.`
                    : `${ticket.status === 'approved' ? 'Approved' : 'Rejected'} — ${ticket.agent} can continue.`
            });
        } catch (e) {
            sendJson(res, /changed/i.test(e.message) ? 409 : 400, { success: false, message: e.message });
        }
    },

    // The deferred list, shown next to the board: the board is what is being worked on, this
    // is what deliberately is not. Reading it needed opening the file until now, so ideas the
    // AIs parked there were invisible on the screen the owner actually watches.
    'GET /api/ideas': (req, res) => {
        const projectRoot = coordinationRoot();
        const { exists, path: filePath, rel, updatedAt, ideas } = readIdeas(projectRoot);
        sendJson(res, 200, {
            exists, ideas, rel, project: path.basename(projectRoot),
            ...(exists ? { path: filePath, updatedAt } : {})
        });
    },

    // Parking an idea is the counterpart of assigning a task — the same owner action, the
    // opposite decision. Goes through the same lib call any AI would, so an idea parked from
    // the dashboard is indistinguishable from one an AI parked mid-task.
    'POST /api/ideas': async (req, res) => {
        const data = await readJsonBody(req);
        try {
            if (!workspaces.getActiveWorkspace()) throw new Error('Select a workspace first.');
            const { action, path: filePath } = addIdea(coordinationRoot(), data.text);
            sendJson(res, 200, {
                success: true, action,
                message: action === 'exists'
                    ? 'Already on the list — nothing added.'
                    : `Idea parked in ${path.basename(filePath)}.`
            });
        } catch (e) {
            sendJson(res, 400, { success: false, message: e.message });
        }
    },

    'GET /api/roster': (req, res) => {
        const projectRoot = coordinationRoot();
        const rosterPath = rosterPathFor(projectRoot);
        if (!fs.existsSync(rosterPath)) {
            sendJson(res, 200, { exists: false, agents: [], project: path.basename(projectRoot) });
            return;
        }
        sendJson(res, 200, {
            exists: true,
            project: path.basename(projectRoot),
            path: rosterPath,
            updatedAt: fs.statSync(rosterPath).mtime,
            agents: parseRoster(fs.readFileSync(rosterPath, 'utf8'))
        });
    },

    // viaBoard: a third-party server is not installed from here; its button on the Connect panel
    // (ui/modules/connect.js) posts a board task for the owner's AI (POST /api/install-recommended-mcp).
    'GET /api/recommended-mcps': (req, res) => {
        sendJson(res, 200, {
            recommended: recommendedMcps(workspaces.getActiveWorkspace()).map(mcp => ({ ...mcp, viaBoard: !!MCP_REQUESTS[mcp.id] })),
            fullList: RECOMMENDED_MCPS
        });
    },

    // Served as text/markdown rather than JSON: the whole point is that it gets pasted into
    // some other AI's window, so the fewer layers between it and a clipboard the better.
    'GET /api/snapshot': (req, res) => {
        const projectRoot = workspaces.getActiveWorkspace();
        if (!projectRoot) { sendJson(res, 400, { success: false, message: 'Select a project first.' }); return; }
        const snap = buildSnapshot(projectRoot, { ai: 'the PLUT_OS dashboard' });
        res.writeHead(200, {
            'Content-Type': 'text/markdown; charset=utf-8',
            'Content-Disposition': `attachment; filename="${snap.name}-snapshot.md"`
        });
        res.end(snap.text);
    },

    'GET /api/watcher': (req, res) => {
        const projectRoot = workspaces.getActiveWorkspace();
        sendJson(res, 200, { seats: WATCHER_SEATS, ...watcherStatus(projectRoot) });
    },

    // One call sets up whatever the owner ticked: PLUT_OS writes the Claude Code hook itself
    // and states the rest on the board, because it does not know those tools' formats and
    // will not guess one into somebody's config.
    'POST /api/watcher': async (req, res) => {
        const projectRoot = workspaces.getActiveWorkspace();
        const data = await readJsonBody(req);
        try {
            const ids = Array.isArray(data.seats) ? data.seats : [];
            const wantsClaude = ids.includes('claude-code-local');
            const enable = data.enabled !== false;
            const native = (enable && wantsClaude) || (!enable)
                ? setWatcher(projectRoot, enable && wantsClaude, { agent: data.agent || 'Claude', port: PORT })
                : watcherStatus(projectRoot);
            const delegated = enable
                ? requestDelegatedWatchers(projectRoot, ids)
                : { requested: [], skipped: [] };
            sendJson(res, 200, {
                success: true, installed: native.installed,
                delegated: delegated.requested, alreadyOnBoard: !!delegated.alreadyOnBoard,
                warning: native.warning || null,
                message: !enable
                    ? 'Watcher removed. The Claude Code hook and its script are gone; board entries were left alone.'
                    : `Claude Code watcher ${native.installed ? 'is active' : 'was not requested'}`
                        + (delegated.requested.length ? `; ${delegated.requested.length} more seat(s) are now a board task for your main AI.` : '.')
                        + (native.warning ? ` ${native.warning}` : '')
            });
        } catch (e) {
            sendJson(res, 400, { success: false, message: e.message });
        }
    },

    // The Hooks panel: the session brief, the safety guard and the push gate are switched here;
    // the watcher and the shared-context capture keep their own switches and are shown beside them.
    'GET /api/hooks': (req, res) => {
        const projectRoot = workspaces.getActiveWorkspace();
        if (!projectRoot) { sendJson(res, 200, { project: null, hooks: [] }); return; }
        sendJson(res, 200, {
            project: path.basename(projectRoot), ...projectHooksStatus(projectRoot),
            // Codex runs the claim check from .codex/hooks.json (`node lib/claim-check.mjs install --codex`);
            // shown, not switched, here.
            codex: codexClaimCheckStatus(projectRoot),
            watcher: watcherStatus(projectRoot).installed,
            context: contextAutomationStatus(projectRoot).enabled
        });
    },

    'POST /api/hooks': async (req, res) => {
        const data = await readJsonBody(req);
        try {
            const projectRoot = requireInstalledProject();
            const result = setProjectHook(projectRoot, String(data.id || ''), data.enabled);
            sendJson(res, 200, { success: true, ...result,
                message: `${data.id} hook ${result.on ? 'on' : 'off'} for this project (private local setting). It takes effect in the AI tool's next session.` });
        } catch (e) {
            sendJson(res, 400, { success: false, message: e.message });
        }
    },

    'GET /api/graphify': (req, res, url) => {
        const projectRoot = workspaces.getActiveWorkspace();
        const mode = url && url.searchParams ? (url.searchParams.get('mode') || 'code') : 'code';
        sendJson(res, 200, {
            ...getProjectDocGraphStatus(projectRoot, mode),
            autoRefresh: isGraphAutoRefresh(projectRoot)
        });
    },

    // Whether the graph is part of the session loop, not just a tab. Project-scoped, because
    // the module switch it sits beside is localStorage and the MCP server cannot read that.
    'POST /api/graphify/auto': async (req, res) => {
        const projectRoot = workspaces.getActiveWorkspace();
        let enabled = null;
        const body = await readJsonBody(req, { fallback: null });
        if (body && typeof body.enabled === 'boolean') enabled = body.enabled;
        if (enabled === null) {
            sendJson(res, 400, { success: false, message: 'Send { enabled: true|false }.' });
            return;
        }
        sendJson(res, 200, setGraphAutoRefresh(projectRoot, enabled));
    },

    'GET /api/graphify/html': (req, res, url) => {
        const projectRoot = workspaces.getActiveWorkspace();
        if (!projectRoot) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('No project selected');
            return;
        }
        // Drawn from the graph data with the current page (lib/graphify.mjs renderGraphPage), so a
        // graph built by an older version opens with today's page instead of its stale HTML copy.
        const content = renderGraphPage(projectRoot);
        if (!content) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('The Graphify code map is not generated yet.');
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
    },

    'POST /api/graphify/scan': async (req, res, url) => {
        // No-project is handled at dispatch (lib/route-policy.mjs), which answers 409 with
        // needsProject like every other write route — a private guard here would answer 400
        // and diverge from that contract for no reason.
        const projectRoot = workspaces.getActiveWorkspace();
        let mode = url && url.searchParams ? (url.searchParams.get('mode') || 'code') : 'code';
        const body = await readJsonBody(req, { fallback: null });
        if (body && body.mode) mode = body.mode;
        const result = buildProjectDocGraph(projectRoot, mode);
        sendJson(res, result.success ? 200 : 500, result);
    },

    'POST /api/graphify/clean': async (req, res, url) => {
        const projectRoot = workspaces.getActiveWorkspace();
        // No default: an unspecified mode used to mean 'all', so a parameterless POST deleted
        // both graphs. Deletion is the one thing that should never be what you get by omission.
        let mode = url && url.searchParams ? url.searchParams.get('mode') : null;
        const body = await readJsonBody(req, { fallback: null });
        if (body && body.mode) mode = body.mode;
        if (!mode) {
            sendJson(res, 400, { success: false, message: 'Specify mode: code or all.' });
            return;
        }
        const result = cleanProjectGraph(projectRoot, mode);
        sendJson(res, result.success ? 200 : 500, result);
    },

    // Which AI tools this project is wired to. Add Project only ever wrote .mcp.json, which
    // is Claude Code's file and nobody else's — every other tool looked "broken" when in fact
    // PLUT_OS had never written anything it reads.
    'GET /api/connect': (req, res) => {
        const projectRoot = workspaces.getActiveWorkspace();
        if (!projectRoot) {
            sendJson(res, 200, { project: null, clients: [] });
            return;
        }
        const installed = workspaces.isWorkspaceInstalled(projectRoot);
        // A project can count as installed by its rules file alone (a clone of a PLUT_OS project,
        // where the launcher is git-ignored); wiring a client needs the launcher, so the page
        // is told whether it is there and offers Repair, which writes it, instead of a refusal.
        sendJson(res, 200, {
            project: path.basename(projectRoot), projectRoot, installed,
            launcher: installed && fs.existsSync(path.join(projectRoot, STUB_REL)),
            mode: installed ? 'installed' : 'observed',
            clients: connectionPlan(projectRoot, { installed })
        });
    },

    'POST /api/connect': async (req, res) => {
        const data = await readJsonBody(req);
        try {
            // The client id selects a row from the CLIENTS registry; the path and the entry
            // both come from that row. Nothing in the body reaches the filesystem or a
            // command line.
            if (!data.projectRoot) throw new Error('A projectRoot is required to connect an AI client. Refresh the Connect view.');
            const projectRoot = requireInstalledProject();
            assertBoardProject(data);
            const result = wireClient(data.client, projectRoot);
            sendJson(res, 200, { success: true, ...result, installed: true, clients: connectionPlan(projectRoot, { installed: true }) });
        } catch (e) {
            sendJson(res, /changed/i.test(e.message) ? 409 : 400, { success: false, message: e.message });
        }
    },

    // Avenox-style lifecycle capture, but deliberately local/private and opt-in. The hook
    // calls the already project-bound PLUT_OS MCP; no global Claude setting is touched.
    'GET /api/context/automation': (req, res) => {
        const projectRoot = workspaces.getActiveWorkspace();
        if (!projectRoot) {
            sendJson(res, 200, { project: null, enabled: false, available: false, notice: CONTEXT_AUTOMATION_NOTICE });
            return;
        }
        const installed = workspaces.isWorkspaceInstalled(projectRoot);
        const claudeWired = installed && connectionPlan(projectRoot, { installed: true })
            .some(client => client.wired && (client.id === 'claude-code' || client.id === 'claude-code-local'));
        sendJson(res, 200, {
            project: path.basename(projectRoot), installed, claudeWired,
            available: installed && claudeWired,
            notice: CONTEXT_AUTOMATION_NOTICE,
            capture: contextCaptureStatus(projectRoot),
            ...contextAutomationStatus(projectRoot)
        });
    },

    'POST /api/context/automation': async (req, res) => {
        const data = await readJsonBody(req);
        try {
            const projectRoot = requireInstalledProject();
            if (typeof data.enabled !== 'boolean') throw new Error('enabled must be true or false.');
            const claudeWired = connectionPlan(projectRoot, { installed: true })
                .some(client => client.wired && (client.id === 'claude-code' || client.id === 'claude-code-local'));
            if (data.enabled && !claudeWired) {
                throw new Error('Connect Claude Code to this project first; the lifecycle hook calls the project-bound plutos MCP.');
            }
            const result = setContextAutomation(projectRoot, data.enabled);
            sendJson(res, 200, {
                success: true, ...result, installed: true, claudeWired,
                available: claudeWired,
                capture: contextCaptureStatus(projectRoot),
                message: data.enabled
                    ? 'Automatic Claude context capture enabled for this project (private local setting). Restart Claude Code to load it.'
                    : 'Automatic Claude context capture disabled for this project.'
            });
        } catch (e) {
            sendJson(res, 400, { success: false, message: e.message });
        }
    },

    'GET /api/mcp/status': (req, res) => {
        // Written by index.mjs under the hub dir. This used to be built from __dirname, which
        // silently ignored PLUTOS_HOME: relocate the hub and the dashboard polled a file no
        // one writes, so every connected AI showed offline. One shared constant now.
        const plutosStatusFile = path.join(PLUTOS_HOME_DIR, 'mcp_status.json');
        let status = { active: false, lastHeartbeat: null, clients: {}, log: [] };
        if (fs.existsSync(plutosStatusFile)) {
            // A poll used to take the writers' lock and rewrite the file every few seconds. Read
            // without the lock and prune in memory; write only when a client actually went stale,
            // so its disconnect is still logged when no MCP process is left alive to do it.
            const stored = readMcpStatus(plutosStatusFile);
            status = structuredClone(stored);
            pruneMcpClients(status);
            if (Object.keys(status.clients).length !== Object.keys(stored.clients).length) {
                status = mutateMcpStatus(plutosStatusFile, pruneMcpClients);
            }
        }
        // `active` alone drove a RED light, so a perfectly healthy install showed an error
        // the moment you looked at it before opening your AI. "Nobody has connected yet" is
        // the normal state of a coordination bridge, not a fault — these four states let the
        // indicator keep red for things that are actually wrong.
        const projectRoot = workspaces.getActiveWorkspace();
        status = projectMcpStatus(status, projectRoot);
        const wiredClients = projectRoot
            ? connectionPlan(projectRoot, { installed: workspaces.isWorkspaceInstalled(projectRoot) }).filter(c => c.wired).map(c => c.name)
            : [];
        // Without the SDK the server cannot start at all, whatever the configs say — that one
        // IS an error, and it is the single most common reason the tools never appear.
        const sdkInstalled = PACKAGED
            ? fs.existsSync(path.join(APP_ROOT, 'index.mjs'))
            : fs.existsSync(path.join(APP_ROOT, 'node_modules', '@modelcontextprotocol', 'sdk'));
        const state = !projectRoot ? 'no-project'
            : status.active ? 'connected'
                : !sdkInstalled ? 'no-sdk'
                    : wiredClients.length ? 'waiting'
                        : 'not-wired';
        sendJson(res, 200, { ...status, state, wiredClients, sdkInstalled });
    },

    'POST /api/install-recommended-mcp': async (req, res) => {
        const data = await readJsonBody(req);
        try {
            // The server config comes from RECOMMENDED_MCPS, never from the request body —
            // this endpoint writes a command that MCP clients will execute, so the caller
            // gets to pick which of the known servers to wire, not what it runs.
            const entry = RECOMMENDED_MCPS.find(m => m.id === data.id);
            if (!entry) throw new Error(`Unknown MCP: ${data.id}`);
            const ws = requireInstalledProject();
            // Third-party servers are requested on the board, not installed here: the user's
            // own AI performs the install after asking them global-vs-local (lib/mcp-requests.mjs).
            // The PLUT_OS coordinator is the exception — it points at this project's launcher
            // stub, so only PLUT_OS can wire it correctly.
            if (MCP_REQUESTS[entry.id]) {
                const r = requestMcpSetup(ws, [entry.id], { alreadyWired: projectMcpKeys(ws) });
                sendJson(res, 200, {
                    success: true,
                    requested: r.requested,
                    message: r.requested.length
                        ? `Posted a board task: your AI will ask you global-vs-local and wire ${entry.id}.`
                        : `Already wired or already on the board — nothing to request.`
                });
                return;
            }
            // PLUT_OS's own entry is written by lib/connect.mjs for the chosen client: here the
            // team-shared Claude Code file. Other clients: the Connect panel.
            if (entry.id === 'plutos') wireClient('claude-code', ws);
            else installRecommendedMcp(ws, entry.id, entry.config);
            sendJson(res, 200, { success: true, approval: 'claude-code',
                message: "Added to this project's .mcp.json. Claude Code asks you to approve it the next time it opens this project." });
        } catch (e) {
            sendJson(res, 500, { success: false, message: e.message });
        }
    },

    'GET /api/fs/list': (req, res, url) => {
        try {
            sendJson(res, 200, { success: true, ...listDirs(url.searchParams.get('path')) });
        } catch (e) {
            sendJson(res, 200, { success: false, message: e.message });
        }
    },

    'GET /api/codeindex': (req, res) => {
        const projectRoot = indexRoot();
        if (!projectRoot) {
            sendJson(res, 200, { exists: false, content: '' });
            return;
        }
        const shards = readIndexShards(projectRoot, 'obsidian');
        const catalogPath = path.join(projectRoot, 'docs', 'ai', 'OBSIDIAN_INDEX.md');
        const content = shards || (fs.existsSync(catalogPath) ? fs.readFileSync(catalogPath, 'utf8') : '');
        if (!content) {
            sendJson(res, 200, { exists: false, content: '' });
            return;
        }
        sendJson(res, 200, {
            exists: true,
            content,
            updatedAt: fs.existsSync(catalogPath) ? fs.statSync(catalogPath).mtime : new Date()
        });
    },

    // Detects the project type and scans in-process — previously copied and ran a hardcoded,
    // externally-sourced single-stack PowerShell template into every project regardless of
    // stack, producing a near-empty index for every other project.
    'POST /api/codeindex/scan': (req, res) => {
        const projectRoot = sourceRoot();
        if (!projectRoot) {
            sendJson(res, 400, { success: false, message: 'No active project selected' });
            return;
        }
        try {
            const result = runCodeScan(projectRoot, { outputRoot: indexRoot() });
            sendJson(res, 200, { success: true, ...result });
        } catch (err) {
            sendJson(res, 400, { success: false, message: err.message });
        }
    },

    // Document Hub's Open button: one project document, in the OS default app, on the PLUTOS
    // computer only. A phone asking would open a file on a desk nobody is looking at. The path
    // must resolve, symlinks followed, to an existing .md file inside the project. Windows opens
    // through explorer.exe, not `cmd /c start`: cmd re-parses its arguments, so a file named
    // `a&b.md` would run `b.md` as a command.
    'POST /api/docs/open': async (req, res) => {
        if (answeredVia(req) !== 'local') {
            sendJson(res, 403, { success: false, message: 'Documents open on the PLUTOS computer only.' });
            return;
        }
        const data = await readJsonBody(req, { fallback: {} });
        const rel = typeof data.path === 'string' ? data.path : '';
        let file;
        try {
            const root = fs.realpathSync(sourceRoot());
            file = fs.realpathSync(path.resolve(root, rel));
            if (!rel || !file.startsWith(root + path.sep) || !/\.md$/i.test(file) || !fs.statSync(file).isFile()) throw new Error('outside');
        } catch (e) {
            sendJson(res, 400, { success: false, message: 'That is not a markdown document inside this project.' });
            return;
        }
        if (process.env.PLUTOS_NO_OS_OPEN === '1') {   // tests: validate, never launch an editor
            sendJson(res, 200, { success: true, opened: false, path: file });
            return;
        }
        const [command, args] = process.platform === 'win32' ? ['explorer.exe', [file]]
            : process.platform === 'darwin' ? ['open', [file]] : ['xdg-open', [file]];
        try {
            const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
            child.on('error', () => { /* no default app; the toast already said we asked */ });
            child.unref();
            sendJson(res, 200, { success: true, opened: true, path: file });
        } catch (e) {
            sendJson(res, 500, { success: false, message: `Could not open the document: ${e.message}` });
        }
    },

    'GET /api/docs': (req, res) => {
        const projectRoot = sourceRoot();
        if (!projectRoot) {
            sendJson(res, 200, { success: true, docs: [] });
            return;
        }
        const docsDir = path.join(projectRoot, 'docs');
        // The codeindex/obsidian shard folders (and their catalog files) are generated output
        // of the Codebase Index scan, not authored documentation — walking them into the doc
        // graph too flooded it with a shard per top-level code folder (14+14 after a real scan)
        // on top of the actual docs, which is what made the hub look broken/cluttered rather
        // than just large. Same exclusion codeindex.mjs's own readMdDocs() already applies when
        // cross-referencing docs against code, kept in sync via the shared path constants.
        const GENERATED_DOC_DIRS = new Set([
            path.join(...CODEINDEX_SHARD_DIR),
            path.join(...OBSIDIAN_SHARD_DIR)
        ]);
        const isGeneratedIndexDoc = (name) => /INDEX|CODEINDEX/i.test(name.replace(/\.md$/, ''));
        try {
            const getDocsRecursively = (dir, rootDir, recurse = true) => {
                let results = [];
                if (!fs.existsSync(dir)) return results;
                const list = fs.readdirSync(dir);
                list.forEach(file => {
                    const filePath = path.join(dir, file);
                    const stat = fs.statSync(filePath);
                    if (stat && stat.isDirectory()) {
                        const relDir = path.relative(rootDir, filePath);
                        if (recurse && file !== 'node_modules' && file !== '.git' && !GENERATED_DOC_DIRS.has(relDir)) {
                            results = results.concat(getDocsRecursively(filePath, rootDir));
                        }
                    } else if (file.endsWith('.md') && !isGeneratedIndexDoc(file)) {
                        const relativePath = path.relative(rootDir, filePath);

                        let lastAuthor = 'Unknown';
                        let lastCommit = 'No commit';
                        let lastCommitDate = stat.mtime.toISOString();
                        
                        try {
                            // execFileSync (argv array) — never a shell string, so a filename
                            // like `` `x`.md `` or `$(...).md` can't inject a command.
                            const gitLog = execFileSync('git', ['log', '-n', '1', '--pretty=format:%an|%ad|%s', '--', relativePath], { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
                            if (gitLog) {
                                const [author, date, msg] = gitLog.split('|');
                                lastAuthor = author || 'Unknown';
                                lastCommitDate = date ? new Date(date).toISOString() : stat.mtime.toISOString();
                                lastCommit = msg || 'No commit message';
                            }
                        } catch (e) {
                            lastAuthor = 'Local Edit';
                            lastCommit = 'Uncommitted changes';
                        }
                        
                        // Cross references: a [[wiki]] link by name, and a Markdown link to a .md
                        // file resolved against the document's own folder into a project path
                        // (README.md's `docs/GUIDE.md`, PAGES.md's `architecture/06-frontend.md`).
                        // Only wiki links were read before, and the documents here write
                        // Markdown links, so the map showed links for one document in 123.
                        const links = [];
                        const relDir = path.posix.dirname(relativePath.replace(/\\/g, '/'));
                        const add = link => { if (link && !links.includes(link)) links.push(link); };
                        try {
                            const content = fs.readFileSync(filePath, 'utf8');
                            const wikiRegex = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
                            let match;
                            while ((match = wikiRegex.exec(content)) !== null) add(match[1].trim().replace(/\.md$/, ''));
                            const mdRegex = /\]\(<?([^)\s<>]+?\.md)(?:#[^)>]*)?>?\)/gi;
                            while ((match = mdRegex.exec(content)) !== null) {
                                const target = match[1];
                                if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;   // http(s), mailto, file
                                const resolved = path.posix.normalize(path.posix.join(relDir, target));
                                if (!resolved.startsWith('../') && !path.posix.isAbsolute(resolved)) add(resolved);
                            }
                        } catch (e) {
                            // Ignored
                        }

                        results.push({
                            name: file,
                            path: relativePath.replace(/\\/g, '/'),
                            size: stat.size,
                            lastModified: lastCommitDate,
                            lastAuthor: lastAuthor,
                            lastCommit: lastCommit,
                            links: links
                        });
                    }
                });
                return results;
            };
            
            // Root-level docs too (README/MVP/ARCHITECTURE/IDEAS...) — not recursed, so the
            // whole source tree doesn't flood the hub. They are exactly the documents that
            // drift, and scanning docs/ alone left them invisible here.
            const docs = [
                ...getDocsRecursively(projectRoot, projectRoot, false),
                ...getDocsRecursively(docsDir, projectRoot)
            ];
            const drift = docDrift(projectRoot, docs.map(d => d.path));
            docs.forEach(d => { d.drift = drift[d.path] || null; });
            sendJson(res, 200, { success: true, docs });
        } catch (e) {
            sendJson(res, 500, { success: false, message: e.message });
        }
    },

    'GET /api/git/commits': (req, res) => {
        const projectRoot = workspaces.getProjectRoot();
        if (!projectRoot) {
            sendJson(res, 200, { success: true, commits: [] });
            return;
        }
        try {
            const gitLog = execFileSync('git', ['log', '-n', '10', '--pretty=format:%h|%an|%ad|%s'], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
            if (!gitLog) {
                sendJson(res, 200, { success: true, commits: [] });
                return;
            }
            const commits = gitLog.split('\n').map(line => {
                const [hash, author, date, message] = line.split('|');
                return {
                    hash,
                    author,
                    date: date ? new Date(date).toISOString() : new Date().toISOString(),
                    message
                };
            });
            sendJson(res, 200, { success: true, commits });
        } catch (e) {
            sendJson(res, 200, { success: true, commits: [] });
        }
    },

    // Skills page (lib/skills.mjs). The project's Agent Skills are read from the source tree, where
    // the clients read them; a pack is registered once in the data folder and switched on per project.
    'GET /api/skills': (req, res) => {
        const projectRoot = sourceRoot();
        const { skills, notes } = scanProjectSkills(projectRoot);
        const active = readActivation(projectRoot).active;
        sendJson(res, 200, {
            project: path.basename(projectRoot),
            projectRoot,
            installed: workspaces.isWorkspaceInstalled(projectRoot),
            skills,
            packs: listPacks().map(p => ({ ...p, active: !!active[p.id] })),
            homes: SKILL_HOMES,
            notes
        });
    },

    // The registry alone, so the Packs card works before a project is open.
    'GET /api/packs': (req, res) => {
        sendJson(res, 200, { packs: listPacks().map(p => ({ ...p, active: false })), homes: SKILL_HOMES });
    },

    'POST /api/packs/add': async (req, res) => {
        const data = await readJsonBody(req);
        try {
            if (typeof data.path !== 'string' || !data.path.trim()) throw new Error('Name the pack folder (a folder on this computer).');
            const pack = registerPack(data.path.trim(), { projectRoot: workspaces.getActiveWorkspace() || '' });
            sendJson(res, 200, { success: true, pack, message: `Pack "${pack.name}" registered with ${pack.skills.length} skill(s).` });
        } catch (e) {
            sendJson(res, 400, { success: false, message: e.message });
        }
    },

    'POST /api/packs/on': async (req, res) => {
        const data = await readJsonBody(req);
        try {
            const id = typeof data.id === 'string' && PACK_ID_RE.test(data.id) ? data.id : '';
            if (!id) throw new Error('Name the pack id.');
            const projectRoot = requireInstalledProject();
            const result = activatePack(projectRoot, id);
            sendJson(res, 200, { success: true, ...result,
                message: `Pack "${id}" on: ${result.skills.length} skill(s) in ${result.homes.join(' and ')}${result.placed ? '' : ' (already placed)'}.` });
        } catch (e) {
            sendJson(res, 400, { success: false, message: e.message });
        }
    },

    'POST /api/packs/off': async (req, res) => {
        const data = await readJsonBody(req);
        try {
            const id = typeof data.id === 'string' && PACK_ID_RE.test(data.id) ? data.id : '';
            if (!id) throw new Error('Name the pack id.');
            const projectRoot = requireInstalledProject();
            const result = deactivatePack(projectRoot, id);
            sendJson(res, 200, { success: true, ...result,
                message: `Pack "${id}" off: ${result.removed.length} folder(s) removed${result.kept.length ? `; kept, because edited or added: ${result.kept.join(', ')}` : ''}.` });
        } catch (e) {
            sendJson(res, 400, { success: false, message: e.message });
        }
    },

    'POST /api/packs/forget': async (req, res) => {
        const data = await readJsonBody(req);
        try {
            const id = typeof data.id === 'string' && PACK_ID_RE.test(data.id) ? data.id : '';
            if (!id) throw new Error('Name the pack id.');
            forgetPack(id);
            sendJson(res, 200, { success: true, id, message: `Pack "${id}" forgotten; the folders it placed in projects stay until switched off there.` });
        } catch (e) {
            sendJson(res, 400, { success: false, message: e.message });
        }
    }
};

// --- Static UI ----------------------------------------------------------------

const STATIC_TYPES = { '.css': 'text/css', '.js': 'text/javascript', '.html': 'text/html',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const uiDir = path.join(__dirname, 'ui');

// Runs outside the route try/catch, so it must not throw: a folder (GET /ui/modules) used to
// reach readFileSync, throw EISDIR as an unhandled rejection and stop the whole dashboard.
function serveStatic(res, filePath) {
    let body = null;
    try { if (fs.statSync(filePath).isFile()) body = fs.readFileSync(filePath); } catch { /* missing or unreadable: 404 */ }
    if (!body) {
        res.writeHead(404);
        res.end('Not Found');
        return;
    }
    res.writeHead(200, { 'Content-Type': STATIC_TYPES[path.extname(filePath)] || 'application/octet-stream' });
    res.end(body);
}

// --- Server -------------------------------------------------------------------

// The UI is served same-origin, so NO cross-origin access is ever legitimate. The old
// wildcard CORS header let any website in the user's browser read /api/fs/list (full-disk
// listing) and fire state-changing POSTs despite the 127.0.0.1 bind. Merely dropping the
// header is not enough — cross-origin "simple" POSTs still execute server-side even when
// the response is unreadable — so the request's provenance is verified (lib/auth.mjs
// isLocalRequest): Host must be this server (blocks DNS rebinding, where an attacker's domain
// resolves to 127.0.0.1 but the browser sends the attacker's Host), and Origin, when the
// browser sends one, must be this server too.
function isLocalRequest(req) {
    return auth.isLocalRequest(req, PORT);
}

// Where an approval answer came from (lib/approvals.mjs records it on the ticket and a T2
// action is approvable at the computer only). Every request that reaches a route is the local
// owner, so this reads 'local'; the rule stays as defence in depth should the gate ever change.
function answeredVia(req) {
    return auth.isLocalOwner(req) ? 'local' : 'remote';
}

// The owner at this computer is authenticated by definition, and nobody else is: a loopback
// socket with no forwarding header (lib/auth.mjs isLocalOwner). There is no password, session
// or paired device to present instead; a tunnel or proxy in front of the dashboard is refused.
function isAuthenticated(req) {
    return auth.isLocalOwner(req);
}

// Headers every response carries, before any route decides more. No other site may put the
// dashboard in a frame (an invisible frame over an approve button is clickjacking; its own
// dependency-graph frame is same-origin and stays allowed), no file is read as a type it does not
// declare, and no address leaks out in a Referer (the app must never put its
// user at risk).
const BASE_HEADERS = {
    'X-Frame-Options': 'SAMEORIGIN',
    'Content-Security-Policy': "frame-ancestors 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
};

const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(BASE_HEADERS)) res.setHeader(k, v);
    if (!isLocalRequest(req)) {
        sendJson(res, 403, { success: false, message: 'Forbidden: cross-origin requests are not allowed.' });
        return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);
    const routeKey = `${req.method} ${url.pathname}`;

    if (!isAuthenticated(req)) {
        sendJson(res, 403, { success: false, message: 'Forbidden: PLUT_OS answers only the owner at this computer.' });
        return;
    }

    // No project selected? Then there is no project data, and nothing may be written into
    // one. Enforced here rather than in each handler — see lib/route-policy.mjs for the
    // install-directory bug that a per-handler guard let through for thirty-three routes.
    const scopedBoardRead = routeKey === 'GET /api/board' && url.searchParams.has('project');
    if (routeNeedsProject(routeKey) && !workspaces.getActiveWorkspace() && !scopedBoardRead) {
        if (PROJECT_PAGE_ROUTES.has(routeKey)) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<!doctype html><meta charset="utf-8"><title>PLUT_OS</title>`
                + `<body style="font:15px system-ui;padding:3rem;color:#4c515b">${NO_PROJECT_MESSAGE}</body>`);
        } else if (PROJECT_WRITE_ROUTES.has(routeKey)) {
            sendJson(res, 409, { success: false, needsProject: true, message: NO_PROJECT_MESSAGE });
        } else {
            sendJson(res, 200, NO_PROJECT_READ_PAYLOAD);
        }
        return;
    }

    const handler = routes[routeKey];
    if (handler) {
        try {
            await handler(req, res, url);
        } catch (e) {
            // An error that names a client status keeps it (readJsonBody's 413 and 408 reach
            // here from every handler that reads its body before its own try); anything else
            // is a server fault.
            const status = e.statusCode >= 400 && e.statusCode < 500 ? e.statusCode : 500;
            sendJson(res, status, { success: false, message: e.message });
        }
        return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
        serveStatic(res, path.join(__dirname, 'dashboard-ui.html'));
        return;
    }
    if (url.pathname.startsWith('/ui/')) {
        // resolve + prefix check blocks ../ traversal out of the ui dir
        const resolved = path.resolve(uiDir, url.pathname.slice(4));
        if (resolved.startsWith(uiDir + path.sep)) {
            serveStatic(res, resolved);
            return;
        }
    }

    res.writeHead(404);
    res.end('Not Found');
});

server.on('error', async (err) => {
    if (err.code === 'EADDRINUSE') {
        // Reopen only this installation/data store. A clean delivery must never show an
        // unrelated older dashboard merely because it occupies the default port.
        if (PACKAGED || AUTO_PORT) {
            try {
                const response = await fetch(`http://127.0.0.1:${PORT}/api/app/mode`, { signal: AbortSignal.timeout(2000) });
                const mode = response.ok ? await response.json() : null;
                if (mode && sameProjectPath(mode.dataHome, PLUTOS_HOME_DIR) && sameProjectPath(mode.appRoot, APP_ROOT)
                    && mode.cleanHarness === (process.env.PLUTOS_CLEAN_HARNESS === '1')) {
                    console.log(`This PLUT_OS instance is already running on port ${PORT}.`);
                    if (OPEN_BROWSER) openBrowser(`http://localhost:${PORT}`);
                    process.exit(0);
                }
            } catch { /* Unknown service is never treated as this workspace. */ }
        }
        if (AUTO_PORT && PORT < 3050) {
            console.log(`Port ${PORT} is already in use. Trying port ${PORT + 1} for the source dashboard.`);
            PORT++;
            server.listen(PORT, LISTEN_HOST);
            return;
        }
        console.error(`\nError: port ${PORT} is already in use.`);
        console.error(`   Another PLUT_OS instance is probably running: http://localhost:${PORT}`);
        console.error(process.platform === 'win32'
            ? `   Start on another port: set "PLUTOS_PORT=${PORT + 1}" && node dashboard.mjs --open\n`
            : `   Start on another port: PLUTOS_PORT=${PORT + 1} node dashboard.mjs --open\n`);
        process.exit(1);
    }
    throw err;
});

function stopDashboard() {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
}
process.once('SIGINT', stopDashboard);
process.once('SIGTERM', stopDashboard);
server.listen(PORT, LISTEN_HOST, () => {
    // Only the copy that actually owns the dashboard port becomes the current install.
    // Registering before listen let a second, stale portable copy hit EADDRINUSE yet still
    // steal install.json from the instance that was genuinely running.
    const installRegistration = registerCurrentInstall();
    console.log(`\n=================================================`);
    console.log(DEV_MODE ? `PLUT_OS is running in DEVELOPMENT MODE (data: ${PLUTOS_HOME_DIR})` : `PLUT_OS is running`);
    console.log(`Interface: http://localhost:${PORT}`);
    console.log(`Target project: ${workspaces.getProjectRoot()}`);
    console.log(`Stable data: ${PLUTOS_HOME_DIR}`);
    if (installRegistration.changed) console.log(`App location registered: ${APP_ROOT}`);
    console.log(`=================================================\n`);
    console.log(`(Press CTRL+C to stop)`);
    // Last, and only once the port is actually bound: opening a browser at a URL that is not
    // serving yet shows the user an error page instead of the app.
    if (OPEN_BROWSER) openBrowser(`http://localhost:${PORT}`);
});
