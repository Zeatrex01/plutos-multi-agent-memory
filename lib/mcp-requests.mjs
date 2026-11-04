// Third-party MCP setup goes through the BOARD, not through PLUT_OS's own file writes.
//
// The rule this encodes: PLUT_OS ships itself (a repo), and it does not install other
// people's software behind the user's back. When a project wants `codebase-memory-mcp` or
// `context-mode`, PLUT_OS writes a TODO on the board; the AI working in the project picks it
// up, asks the user the one question PLUT_OS cannot answer for them — **global or
// project-local?** — and performs the install itself.
//
// Why this is better than writing .mcp.json directly:
//   - Scope is the user's call. Global (serves every project on this machine) vs local (this
//     repo only) is a real decision; PLUT_OS silently picking "local" every time was wrong.
//   - An AI can react to reality — a package that 404s, a different client's config format —
//     where a hardcoded config entry just fails silently at the next MCP client start.
//   - It is the same "prepare + make visible, never command" model as everything else here:
//     a task on a shared file, executed by whoever the user has running, with their consent.
//
// Deliberately NOT included here: the PLUT_OS coordinator itself. That entry points at this
// install's own launcher stub, so PLUT_OS is the only thing that can write it correctly.
import fs from 'fs';
import path from 'path';
import { parseBoardEntries, applyBoardUpdate } from './board.mjs';
import { updateFileAtomically } from './atomic.mjs';

// One line per server: enough for an AI to act, short enough to respect the board's
// ≤8-lines-per-entry budget. Instructions stay minimal on purpose — an agent knows how to
// wire an MCP server; what it cannot guess is the user's intent.
export const MCP_REQUESTS = {
    'codebase-memory-mcp': {
        title: 'Set up the Codebase Memory MCP',
        pkg: 'npx -y codebase-memory-mcp',
        why: 'lets agents navigate this codebase as a knowledge graph instead of grepping blind'
    },
    'context-mode': {
        title: 'Set up the Context Mode MCP',
        pkg: 'npx -y context-mode',
        why: 'trims token/context waste on long agent sessions'
    },
    'codeburn': {
        title: 'Set up the CodeBurn Cost Tracker MCP',
        pkg: 'npx -y codeburn mcp',
        why: 'tracks AI token usage, spend, and session metrics per project'
    }
};

function boardFile(projectRoot) {
    return path.join(projectRoot, 'docs', 'handoff', 'BOARD.md');
}

// Writes one TODO per requested server, skipping anything already wired or already on the
// board in ANY status — a task the user finished, or declined and closed, must not come back
// on the next dashboard start. → { requested, skipped }
export function requestMcpSetup(projectRoot, ids = [], { alreadyWired = new Set() } = {}) {
    const file = boardFile(projectRoot);
    const requested = [];
    const skipped = [];
    if (!fs.existsSync(file)) return { requested, skipped: ids.slice() };

    const existingTitles = new Set(
        parseBoardEntries(fs.readFileSync(file, 'utf8')).map(e => e.title.toLowerCase())
    );

    for (const id of ids) {
        const req = MCP_REQUESTS[id];
        if (!req) { skipped.push(id); continue; }
        if (alreadyWired.has(id) || existingTitles.has(req.title.toLowerCase())) { skipped.push(id); continue; }

        updateFileAtomically(file, (content) => ({
            content: applyBoardUpdate(content, {
                agent: 'PLUT_OS',
                status: 'TODO',
                title: req.title,
                task: `Install \`${id}\` (${req.pkg}) — ${req.why}. ASK THE USER FIRST: global (their AI client's own config, serves every project) or project-local (this repo's .mcp.json)? Wire it where they choose, then set this entry to DONE.`,
                assignee: 'main AI'
            }).content,
            result: null
        }));
        requested.push(id);
        existingTitles.add(req.title.toLowerCase());
    }
    return { requested, skipped };
}
