// Drawers: optional groups of MCP tools that a project opens when it needs them.
//
// Every tool definition the server lists is sent to every connected AI on every session, used
// or not (tools/token-budget-test.mjs measures it). A drawer keeps a group of tools out of
// that list until the project opens it; while closed it costs one line in the description of
// plutos_modules, the one tool that lists, opens and closes drawers.
//
// The open set is per project, in .plutos/drawers.json, so every AI connected to the project
// sees the same tools. Without a recorded choice a drawer is closed, unless the project already
// uses it: closing a project's tools under it because a release changed a default would strand
// the AIs mid-work, so research starts open where a research topic exists. A drawer's tools stay registered in the server either way: a closed
// drawer only means they are not listed, and a call to one is refused with how to open it.
// Opening a drawer installs nothing and runs nothing; its tools keep their own approval rules.
import fs from 'fs';
import path from 'path';
import { updateFileAtomically } from './atomic.mjs';
import { RESEARCH_TOOLS } from './research/mcp.mjs';
import { ADMIN_TOOLS } from './admin-tools.mjs';
import { CODE_TOOLS } from './code-tools.mjs';

export const DRAWERS = [
    {
        id: 'research',
        summary: 'sourced web research: a question tree, fetched pages, findings that must quote their source',
        tools: RESEARCH_TOOLS,
        inUse: root => hasEntries(path.join(root, '.plutos', 'research'))
    },
    {
        // PLUT_OS's own answer to an external code-graph or cost server (audit 2026-10-28). Closed
        // by default: plutos_context_for_task already serves the ordinary "which files" question.
        id: 'code',
        summary: 'code lookup, token use',
        tools: CODE_TOOLS,
        inUse: () => false
    },
    {
        // Upkeep no ordinary session needs. Closed by default everywhere: a call to one of its tools is
        // refused with how to open it, which costs one turn on a rare day instead of ~1,900 tokens on all.
        id: 'admin',
        summary: 'rare upkeep: kit install, state, story deck',
        tools: ADMIN_TOOLS,
        inUse: () => false
    }
];

function hasEntries(dir) {
    // `_cache` holds fetched pages, not a topic; a project whose topics are gone is not using it.
    try { return fs.readdirSync(dir, { withFileTypes: true }).some(e => e.isDirectory() && !e.name.startsWith('_')); } catch (e) { return false; }
}

const BY_ID = new Map(DRAWERS.map(d => [d.id, d]));
const BY_TOOL = new Map(DRAWERS.flatMap(d => d.tools.map(t => [t.name, d.id])));
const stateFile = root => path.join(root, '.plutos', 'drawers.json');
const tokens = d => Math.ceil(JSON.stringify(d.tools).length / 4);

// { open: [...], closed: [...] } records explicit choices only; a drawer in neither list
// follows its default, so a drawer added in a later release arrives in its default state.
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
    const drawer = BY_ID.get(id);
    if (!drawer) return false;
    const { open, closed } = readChoices(root);
    if (open.includes(id)) return true;
    if (closed.includes(id)) return false;
    return drawer.inUse(root);
}

export function drawerOfTool(name) {
    return BY_TOOL.get(name) || null;
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
