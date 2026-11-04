// Board persistence — the one place a board entry is written to disk.
//
// Why it exists: the MCP server (board_update) and the dashboard (POST /api/board) must
// produce byte-identical results, because a task the user assigns and a task an AI assigns
// are the same thing on the same file. That logic — resolve the tier's path, seed from the
// scaffold when the file is new, apply the upsert, write atomically — was inline in the MCP
// handler; a second copy in the HTTP layer is how two writers drift apart.
//
// Deliberately NOT folded into board.mjs: that module is pure text (parse/format, zero fs),
// which is what makes it trivially testable. Composition instead — this module is the only
// one that knows boards are files.
import fs from 'fs';
import path from 'path';
import { applyBoardUpdate } from './board.mjs';
import { boardPathFor, agentBoardPathFor } from './roadmap.mjs';
import { updateFileAtomically } from './atomic.mjs';
import { HANDOFF_TEMPLATES_DIR } from './workspaces.mjs';

const FALLBACK_SEEDS = {
    main: "# BOARD - Shared Agent Status\n<!-- plutos:clean-template -->\n\nRules: see `AGENTS.md`. Read before starting, update when starting/finishing.\n\n---\n\n(no active tasks - add your entry above this line)\n",
    agents: "# AGENT BOARD - Subagent Coordination\n<!-- plutos:clean-template -->\n\nRules: see `AGENTS.md`.\n\n---\n\n(no active tasks - add your entry above this line)\n"
};

export const BOARD_TIERS = ['main', 'agents'];

// A missing board means main. A board that is named but is not a tier is refused, not silently
// filed on main: the role tier (docs/boards/<role>.md) left on 2026-11-04, and a caller still
// asking for it must hear so instead of reading or writing the wrong board.
export function boardTier(board) {
    if (board === undefined || board === null || board === '') return 'main';
    if (BOARD_TIERS.includes(board)) return board;
    throw new Error(`Unknown board '${board}'. Boards here: ${BOARD_TIERS.join(', ')}.`);
}

export function boardPathForTier(projectRoot, tier) {
    return tier === 'agents' ? agentBoardPathFor(projectRoot) : boardPathFor(projectRoot);
}

// A brand-new board starts from the installed scaffold, so it keeps the header and the rules
// the AIs are told to follow rather than appearing as a bare list of entries.
function seedFor(tier) {
    const templatePath = path.join(HANDOFF_TEMPLATES_DIR, tier === 'agents' ? 'AGENT_BOARD.md' : 'BOARD.md');
    try {
        return fs.existsSync(templatePath) ? fs.readFileSync(templatePath, 'utf8') : FALLBACK_SEEDS[tier];
    } catch (e) {
        return FALLBACK_SEEDS[tier];
    }
}

// Upserts one entry on the given tier. → { action: 'created' | 'updated', path, tier }
// Throws with the contract error from applyBoardUpdate on invalid input (an unknown board
// included); the caller decides how to report it (MCP isError vs HTTP 400).
// `role` is an entry field describing the writer, never which board the entry lands on.
export function writeBoardEntry(projectRoot, { board, agent, status, title, task, result, note, assignee, role, needs, priority, verification, evidence, expectedRevision, doneWhen } = {}) {
    const tier = boardTier(board);
    const boardPath = boardPathForTier(projectRoot, tier);
    const action = updateFileAtomically(boardPath, (content) => {
        const { content: updated, action } = applyBoardUpdate(content, {
            agent, status, title, task, result, note, assignee, role, needs, priority, verification, evidence, expectedRevision, doneWhen
        });
        return { content: updated, result: action };
    }, { seed: seedFor(tier) });
    return { action, path: boardPath, tier };
}
