// Drawers: which optional tool groups a project lists, and how opening and closing one is
// stored. The protocol side (tools/list, list_changed, refusing a closed drawer's tool) is in
// tools/mcp-test.mjs.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DRAWERS, isDrawerOpen, drawerOfTool, listDrawers, openDrawerTools, setDrawer, modulesTool, drawerBriefLines } from '../lib/drawers.mjs';
import { requiresProject, requiresProjectBinding } from '../lib/tool-policy.mjs';
import { RESEARCH_TOOLS } from '../lib/research/mcp.mjs';
import { ADMIN_TOOLS } from '../lib/admin-tools.mjs';

let passed = 0, failed = 0;
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ok  ${name}`); } else { failed++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); } };
const throws = fn => { try { fn(); return ''; } catch (e) { return e.message; } };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-drawers-'));
const file = path.join(root, '.plutos', 'drawers.json');
const names = tools => tools.map(t => t.name);
try {
    check('every drawer tool belongs to exactly one drawer', DRAWERS.flatMap(d => d.tools).length === new Set(DRAWERS.flatMap(d => names(d.tools))).size);
    check('research and admin tools map to their drawers', drawerOfTool('research_topic') === 'research' && drawerOfTool('status_report') === 'admin' && drawerOfTool('board_read') === null);
    // Plan 2026-11-14 section 3: the code drawer is gone; code lookup is listed by default, token use is upkeep.
    check('only the research and admin drawers remain', DRAWERS.map(d => d.id).join() === 'research,admin');
    check('plutos_code_lookup is in no drawer; plutos_usage, status_report and project_snapshot are admin',
        drawerOfTool('plutos_code_lookup') === null && ['plutos_usage', 'status_report', 'project_snapshot', 'init_roadmap'].every(n => drawerOfTool(n) === 'admin'));
    check('the cut tools are in no drawer', ['project_deck', 'plutos_system_status', 'agent_register', 'roster_read'].every(n => drawerOfTool(n) === null));

    check('a project that uses no drawer lists none of their tools', DRAWERS.every(d => !isDrawerOpen(root, d.id)) && openDrawerTools(root).length === 0);
    check('with every drawer closed, plutos_modules names them all', DRAWERS.every(d => modulesTool(root).description.includes(d.id)));

    fs.mkdirSync(path.join(root, '.plutos', 'research', '_cache'), { recursive: true });
    check('a research page cache alone does not count as using research', !isDrawerOpen(root, 'research'));
    fs.mkdirSync(path.join(root, '.plutos', 'research', 'topic-1'), { recursive: true });
    check('a research topic alone no longer opens the research drawer', !isDrawerOpen(root, 'research'));
    setDrawer(root, 'research', true);
    setDrawer(root, 'admin', true);
    check('the listing then carries both drawers\' tools', names(openDrawerTools(root)).length === RESEARCH_TOOLS.length + ADMIN_TOOLS.length + 1);
    fs.rmSync(file);
    check('the admin drawer stays closed until a project opens it', !isDrawerOpen(root, 'admin') && modulesTool(root).description.includes('admin ('));
    setDrawer(root, 'research', true);
    setDrawer(root, 'admin', true);
    {
        const other = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-drawers-all-'));
        for (const d of DRAWERS) setDrawer(other, d.id, true);
        check('with every drawer open, plutos_modules says so', modulesTool(other).description.includes('All drawers are open.'));
        fs.rmSync(other, { recursive: true, force: true });
    }

    const closed = setDrawer(root, 'research', false);
    check('closing reports the change', closed.changed === true && closed.open === false);
    check('a closed drawer is not open and its tools are not listed',
        !isDrawerOpen(root, 'research') && !names(openDrawerTools(root)).some(n => RESEARCH_TOOLS.some(t => t.name === n)));
    check('closing one drawer leaves the others alone', isDrawerOpen(root, 'admin'));
    check('the choice is stored in .plutos/drawers.json', JSON.parse(fs.readFileSync(file, 'utf8')).closed.includes('research'));
    check('closing again reports no change', setDrawer(root, 'research', false).changed === false);

    const desc = modulesTool(root).description;
    // The per-drawer tool count left the line on 2026-10-28 to keep the tool list in its token budget;
    // plutos_modules {"action":"list"} still gives the tools.
    check('plutos_modules names the closed drawer and its summary',
        desc.includes('Closed now: research (web research'), desc);
    // Field report 2026-11-14: a summary that named tools did not connect a task to its drawer, so
    // each summary says what it is FOR and that it comes before an agent's search.
    {
        const by = id => DRAWERS.find(d => d.id === id).summary;
        check('the research drawer summary reads as a task and comes before an agent\'s web search',
            /quote/.test(by('research')) && /before asking an agent to search the web/.test(by('research')), by('research'));
        check('the admin drawer summary names what it does', /install the project kit/.test(by('admin')) && /status report/.test(by('admin')) && /token use/.test(by('admin')), by('admin'));
    }

    setDrawer(root, 'admin', false);
    setDrawer(root, 'research', true);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    check('two choices on different drawers are both kept', stored.open.includes('research') && stored.closed.includes('admin') && !stored.closed.includes('research'), JSON.stringify(stored));
    check('reopening lists the tools again', names(openDrawerTools(root)).includes('research_topic') && !names(openDrawerTools(root)).includes('status_report'));
    check('listDrawers reports state, tool names and size',
        listDrawers(root).every(d => typeof d.open === 'boolean' && Array.isArray(d.tools) && d.tokens > 0)
        && listDrawers(root).find(d => d.id === 'admin').tools.length === ADMIN_TOOLS.length + 1);

    {
        const lines = drawerBriefLines(root);
        check('the brief tool map says look-ups are tool calls and agents are for judgment', /look-ups are tool calls.*agents for judgment/.test(lines[0]), lines[0]);
        check('the brief tool map has one line per drawer with its summary, and the open command for a closed one',
            DRAWERS.every(d => lines.some(l => l.startsWith(`- ${d.id}`) && l.includes(d.summary)))
            && lines.some(l => l.startsWith('- research (open):')) && lines.some(l => l.startsWith('- admin: ')) && lines[0].includes('`plutos_modules open <id>`'), lines.join('\n'));
        check('the brief tool map stays within five lines', lines.filter(Boolean).length <= 5);
    }
    check('an unknown drawer is refused by name', /Unknown drawer "nope"\. Drawers: research, admin/.test(throws(() => setDrawer(root, 'nope', true))));

    fs.writeFileSync(file, '{not json');
    check('an unreadable state file falls back to the defaults (all closed)', !isDrawerOpen(root, 'research') && !isDrawerOpen(root, 'admin'));
    setDrawer(root, 'admin', false);
    check('the next choice rewrites an unreadable file', JSON.parse(fs.readFileSync(file, 'utf8')).closed[0] === 'admin');
    fs.writeFileSync(file, JSON.stringify({ open: ['ghost'], closed: ['ghost2', 'research'] }));
    check('unknown ids in the file are ignored', !isDrawerOpen(root, 'research') && !isDrawerOpen(root, 'ghost'));

    fs.rmSync(path.join(root, '.plutos'), { recursive: true, force: true });
    setDrawer(root, 'research', true);
    check('an explicit open works on a project that never used the drawer', isDrawerOpen(root, 'research') && !isDrawerOpen(root, 'admin'));

    check('listing drawers needs no project marker; opening or closing does',
        !requiresProject('plutos_modules', { action: 'list' }) && requiresProject('plutos_modules', { action: 'open', id: 'research' })
        && requiresProject('plutos_modules', { action: 'close', id: 'research' }));
    check('plutos_modules still requires the project binding', requiresProjectBinding('plutos_modules'));
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
console.log(`Drawers: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
