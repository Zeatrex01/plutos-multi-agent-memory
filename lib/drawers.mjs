// Drawers: optional groups of MCP tools that a project opens when it needs them.
//
// Every tool definition the server lists is sent to every connected AI on every session, used
// or not (tools/token-budget-test.mjs measures it). A drawer keeps a group of tools out of
// that list until the project opens it; while closed it costs one line in the description of
// plutos_modules, the one tool that lists, opens and closes drawers.
//
// The open set is per project, in .plutos/drawers.json, so every AI connected to the project
// sees the same tools. Without a recorded choice a drawer is closed: research no longer opens itself
// because a research topic exists (plan 2026-11-14 section 3; it cost about 1,400 tokens a session for
// trial use). A drawer's tools stay registered in the server either way: a closed
// drawer only means they are not listed, and a call to one is refused with how to open it.
// Opening a drawer installs nothing and runs nothing; its tools keep their own approval rules.
import fs from 'fs';
import path from 'path';
import { updateFileAtomically } from './atomic.mjs';
import { RESEARCH_TOOLS } from './research/mcp.mjs';
import { ADMIN_TOOLS } from './admin-tools.mjs';
import { CODE_TOOLS } from './code-tools.mjs';

// `tools` is a getter: lib/continuity.mjs imports this file for the brief, and code-tools.mjs reaches
// continuity.mjs back through task-context.mjs and memory.mjs, so an eager read here would run before
// CODE_TOOLS exists whenever that cycle is entered from code-tools.mjs.
// A summary says what a session would use the drawer FOR, as a task (field report 2026-11-14:
// a summary that named the tools did not connect "list every caller" to the code drawer).
export const DRAWERS = [
    {
        id: 'research',
        summary: 'web research: fetch pages, record findings that quote them; open it before asking an agent to search the web',
        get tools() { return RESEARCH_TOOLS; }
    },
    {
        // Upkeep no ordinary session needs. Closed by default everywhere: a call to one of its tools is
        // refused with how to open it, which costs one turn on a rare day instead of tokens on all.
        // The code drawer left on 2026-11-14: plutos_code_lookup is listed by default (index.mjs) and
        // plutos_usage, an owner metric, came here.
        id: 'admin',
        summary: 'rare upkeep: install the project kit, the owner\'s status report, a handover snapshot, token use',
        get tools() { return [...ADMIN_TOOLS, ...CODE_TOOLS.filter(t => t.name === 'plutos_usage')]; }
    }
];

const BY_ID = new Map(DRAWERS.map(d => [d.id, d]));
let byTool = null;   // built on first use, for the same import cycle
const stateFile = root => path.join(root, '.plutos', 'drawers.json');
const tokens = d => Math.ceil(JSON.stringify(d.tools).length / 4);

// { open: [...], closed: [...] } records explicit choices only; a drawer in neither list is
// closed, the default for every drawer.
function readChoices(root) {
    try {
        const parsed = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'));
        return {
            open: Array.isArray(parsed.open) ? parsed.open.filter(id => BY_ID.has(id)) : [],
            closed: Array.isArray(parsed.closed) ? parsed.closed.filter(id => BY_ID.has(id)) : []
        };
    } catch (e) {
        // Missing is the normal state. Unreadable falls back to the defaults rather than
        // locking an agent out of its tools; the next open/close rewrites the file.
        return { open: [], closed: [] };
    }
}

export function isDrawerOpen(root, id) {
    return BY_ID.has(id) && readChoices(root).open.includes(id);
}

export function drawerOfTool(name) {
    byTool ||= new Map(DRAWERS.flatMap(d => d.tools.map(t => [t.name, d.id])));
    return byTool.get(name) || null;
}

export function listDrawers(root) {
    return DRAWERS.map(d => ({ id: d.id, summary: d.summary, open: isDrawerOpen(root, d.id), tools: d.tools.map(t => t.name), tokens: tokens(d) }));
}

export function openDrawerTools(root) {
    return DRAWERS.filter(d => isDrawerOpen(root, d.id)).flatMap(d => d.tools);
}

// → { id, open, changed }
export function setDrawer(root, id, open) {
    if (!BY_ID.has(id)) throw new Error(`Unknown drawer "${id}". Drawers: ${DRAWERS.map(d => d.id).join(', ')}.`);
    const was = isDrawerOpen(root, id);
    updateFileAtomically(stateFile(root), (base) => {
        let parsed = {};
        try { parsed = JSON.parse(base || '{}'); } catch (e) { parsed = {}; }
        const keep = list => (Array.isArray(list) ? list.filter(x => x !== id && BY_ID.has(x)) : []);
        const next = { open: keep(parsed.open), closed: keep(parsed.closed) };
        (open ? next.open : next.closed).push(id);
        next.open.sort(); next.closed.sort();
        return { content: JSON.stringify(next, null, 2) + '\n' };
    }, { seed: '{}' });
    return { id, open, changed: was !== open };
}

// The brief's tool map (lib/continuity.mjs, next to the skill line): one line per drawer from
// DRAWERS, open or closed, so a session learns which look-ups are a tool call away before it
// spends an agent on a search a tool answers. → [] for a project with no drawer to name.
export function drawerBriefLines(root) {
    const drawers = listDrawers(root);
    if (!drawers.length) return [];
    return ['Tools: look-ups are tool calls (which files: `plutos_context_for_task`); agents for judgment. Drawers, a closed one opened by `plutos_modules open <id>`:',
        ...drawers.map(d => `- ${d.id}${d.open ? ' (open)' : ''}: ${d.summary}`), ''];
}

// The description is built per listing, so it always names the drawers that are closed now.
export function modulesTool(root) {
    const closed = listDrawers(root).filter(d => !d.open);
    const closedLine = closed.length
        ? ` Closed now: ${closed.map(d => `${d.id} (${d.summary})`).join('; ')}.`
        : ' All drawers are open.';
    return {
        name: 'plutos_modules',
        description: 'PLUT_OS: optional tool groups (drawers). Closed ones are unlisted and cost no context. list, or open/close for every AI on this project; open one only when the task needs it.' + closedLine,
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['list', 'open', 'close'] },
                id: { type: 'string', enum: DRAWERS.map(d => d.id), description: 'Drawer to open or close.' }
            },
            required: ['action']
        }
    };
}
