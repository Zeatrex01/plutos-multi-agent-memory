#!/usr/bin/env node
// The subagent tool map (owner, d-821d5722b32a). Claude Code's SubagentStart hook fires for every
// subagent, Explore and Plan included, which load neither CLAUDE.md nor AGENTS.md: this hook is the
// only way to tell them that PLUT_OS's look-ups are tool calls they already inherit from the parent.
// The text stays short (a context-mode plugin cut a 6 KB session_start brief, so it was never read).
//
// It never fails a subagent's start: any error, a folder without the PLUT_OS kit, or a run past the
// time limit prints nothing and exits 0. No model call; its one write is the usage log's line.
import { isEntry } from './entry.mjs';

// Claude Code's SubagentStart answer: additionalContext goes in before the subagent's first prompt.
export const SUBAGENT_MAP = 'PLUT_OS (this project\'s multi-AI coordinator, MCP server "plutos") is already wired: look-ups are tool calls, not agents.\n'
    + '- plutos_context_for_task: which files a task touches, open those first\n'
    + '- plutos_code_lookup: where a file or symbol is declared, what imports a file (file-level)\n'
    + '- research drawer (plutos_modules open research): sourced web research\n'
    + 'Agents are for judgment, not look-ups. If the parent named tools in your brief, use them.';
const MAX_PACK_LINES = 6;

// One line per active pack MCP server. activePackMcpServers may not exist in this install yet (the
// packs side adds it), may return names or { name, description } objects, and may be async.
async function defaultPackServers(root) {
    const skills = await import('./skills.mjs');
    return typeof skills.activePackMcpServers === 'function' ? skills.activePackMcpServers(root) : [];
}

async function packLines(root, listServers) {
    let servers;
    try { servers = await listServers(root); } catch { return []; }
    if (!Array.isArray(servers)) return [];
    return servers.slice(0, MAX_PACK_LINES).flatMap(s => {
        const name = typeof s === 'string' ? s : s?.name || s?.id;
        if (typeof name !== 'string' || !name.trim()) return [];
        const what = typeof s === 'object' ? s.description || s.purpose || s.use || '' : '';
        return [`- ${name.trim().slice(0, 40)} (pack MCP server)${what ? `: ${String(what).replace(/\s+/g, ' ').trim().slice(0, 100)}` : ''}`];
    });
}

/** The SubagentStart hook's stdout for a project root: the JSON answer, or '' when the folder has no
 *  PLUT_OS kit or anything goes wrong. `listServers` stands in for activePackMcpServers in tests. */
export async function subagentHookOutput(root, { listServers = defaultPackServers } = {}) {
    try {
        const { looksLikePlutosProject } = await import('./workspaces.mjs');
        if (!looksLikePlutosProject(root)) return '';
        const extra = await packLines(root, listServers);
        const additionalContext = extra.length ? `${SUBAGENT_MAP}\nActive pack tools:\n${extra.join('\n')}` : SUBAGENT_MAP;
        return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext } });
    } catch { return ''; }
}

if (isEntry(import.meta.url)) {
    // Never hold the subagent up: past the limit, leave with nothing printed.
    setTimeout(() => process.exit(0), 800).unref();
    // stdin is read asynchronously, so the limit above still holds when a pipe never closes.
    const fromEvent = () => new Promise(resolve => {
        if (process.stdin.isTTY) return resolve({});
        let buf = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', d => { buf += d; });
        process.stdin.on('end', () => { try { resolve(JSON.parse(buf) || {}); } catch { resolve({}); } });
        process.stdin.on('error', () => resolve({}));
    });
    const started = performance.now();
    // The event carries the sub-agent type for the usage line (a label, never content). With
    // CLAUDE_PROJECT_DIR set the root does not depend on it, so a pipe that stays open is waited
    // on for 200 ms at most and the answer goes out without the type.
    const event = process.env.CLAUDE_PROJECT_DIR
        ? Promise.race([fromEvent(), new Promise(resolve => setTimeout(() => resolve({}), 200).unref())])
        : fromEvent();
    // One usage line per sub-agent start (lib/usage-log.mjs). It runs after the answer is written,
    // so a slow first write (imports, git) never holds the map back under the kill timer above, and
    // a failed import or write is swallowed.
    const record = async (root, out, agent) => {
        try {
            const { recordUsage } = await import('./usage-log.mjs');
            recordUsage(root, { kind: 'hook', name: 'subagent', ok: !!out, ms: performance.now() - started, agent });
        } catch { /* never fails the start */ }
    };
    event
        .then(async ev => {
            const root = process.env.CLAUDE_PROJECT_DIR || (typeof ev?.cwd === 'string' && ev.cwd) || process.cwd();
            let out = '';
            try { out = await subagentHookOutput(root); } catch { out = ''; }
            return { root, out, agent: typeof ev?.agent_type === 'string' ? ev.agent_type : undefined };
        })
        .catch(() => null)
        .then(r => {
            const finish = () => (r ? record(r.root, r.out, r.agent) : Promise.resolve()).finally(() => process.exit(0));
            if (r?.out) process.stdout.write(r.out, finish); else finish();
        });
}
