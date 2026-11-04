// The session_start briefing as one function, so the MCP tool and the SessionStart hook
// (`index.mjs --brief`, lib/project-hooks.mjs) hand a session exactly the same text. Two copies
// would drift; this is the one place it is assembled.
import { buildBrief, boundedBrief, SESSION_END_LINE } from './continuity.mjs';
import { refreshIndexIfStale } from './codeindex.mjs';
import { refreshGraphIfStale } from './graphify.mjs';
import { tidyLiveBoards } from './hygiene.mjs';
import { recordArrival } from './presence.mjs';
import { workingAgreement } from './working-agreement.mjs';
import { selfBriefLine } from './run-mode.mjs';

/** The brief in two parts: `context` (the project's state, which may be trimmed to fit) and
 *  `rules` (the working agreement and the self line, which are never trimmed). `writes: false`
 *  builds the same text without the upkeep below, which writes into the project: a test can
 *  then measure a repository's brief without changing its files. `mcp: true` is the brief served
 *  over MCP (session_start), which skips the files-only setup line: it arrived through the MCP. */
export function sessionBriefParts(projectRoot, ai, { writes = true, mcp = false } = {}) {
    if (writes) {
        // Mechanically refresh the generated code index before briefing, so the map the agent
        // reads reflects the current tree — no Rescan click, no stale index. Safe/lossless and
        // never throws; the authored PROJECT_MAP is only flagged (in the brief), never rewritten.
        refreshIndexIfStale(projectRoot);
        // Same idea, same moment, for the knowledge graph — but only for a project that asked
        // for it (Graphify Studio → "keep it current"), and only for a graph that already
        // exists. Never throws; a stale map must not cost a briefing.
        refreshGraphIfStale(projectRoot);
        // DONE entries past budget leave the live board before the brief is built, so the
        // next session cannot be handed a finished-work pile. Failures are ignored; the
        // brief still returns.
        try { tidyLiveBoards(projectRoot); } catch (e) { /* briefing outranks cleanup */ }
        // Write down the arrival before briefing, so this AI shows up in its own brief's
        // participant list and — more to the point — in everyone else's from now on.
        // recordArrival never throws; a failed presence write must not cost a briefing.
        recordArrival(projectRoot, ai);
    }
    const brief = buildBrief(projectRoot, { ai, mcp });
    // The byte cap holds over the whole reply; the self line is one short sentence.
    // The agreement sits outside the byte cap's truncation, like the self line: it is the rule set, not context.
    return { context: boundedBrief(brief), rules: `${workingAgreement(undefined, undefined, projectRoot)}${selfBriefLine(projectRoot)}\n\n${SESSION_END_LINE}` };
}

// The session_start tool: served over MCP, so the brief never says the project has files only.
export function sessionBrief(projectRoot, ai) {
    const { context, rules } = sessionBriefParts(projectRoot, ai, { mcp: true });
    return context + rules;
}
