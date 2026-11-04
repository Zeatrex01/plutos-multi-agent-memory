// Drawers: which optional tool groups a project lists, and how opening and closing one is
// stored. The protocol side (tools/list, list_changed, refusing a closed drawer's tool) is in
// tools/mcp-test.mjs.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DRAWERS, isDrawerOpen, drawerOfTool, listDrawers, openDrawerTools, setDrawer, modulesTool } from '../lib/drawers.mjs';
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
    check('research and admin tools map to their drawers', drawerOfTool('research_topic') === 'research' && drawerOfTool('project_deck') === 'admin' && drawerOfTool('board_read') === null);

    check('a project that uses no drawer lists none of their tools', DRAWERS.every(d => !isDrawerOpen(root, d.id)) && openDrawerTools(root).length === 0);
    check('with every drawer closed, plutos_modules names them all', DRAWERS.every(d => modulesTool(root).description.includes(d.id)));

    fs.mkdirSync(path.join(root, '.plutos', 'research', '_cache'), { recursive: true });
    check('a research page cache alone does not count as using research', !isDrawerOpen(root, 'research'));
    fs.mkdirSync(path.join(root, '.plutos', 'research', 'topic-1'), { recursive: true });
    check('a project with a research topic starts with research open', isDrawerOpen(root, 'research'));
    setDrawer(root, 'admin', true);
    check('the listing then carries both drawers\' tools', names(openDrawerTools(root)).length === RESEARCH_TOOLS.length + ADMIN_TOOLS.length);
    fs.rmSync(file);
    check('the admin drawer stays closed until a project opens it', !isDrawerOpen(root, 'admin') && modulesTool(root).description.includes('admin ('));
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
    check('an explicit close wins over a drawer the project uses', !isDrawerOpen(root, 'research') && fs.existsSync(path.join(root, '.plutos', 'research', 'topic-1')));
    check('closing one drawer leaves the others alone', isDrawerOpen(root, 'admin'));
    check('the choice is stored in .plutos/drawers.json', JSON.parse(fs.readFileSync(file, 'utf8')).closed.includes('research'));
    check('closing again reports no change', setDrawer(root, 'research', false).changed === false);

    const desc = modulesTool(root).description;
    // The per-drawer tool count left the line on 2026-10-28 to keep the tool list in its token budget;
    // plutos_modules {"action":"list"} still gives the tools.
    check('plutos_modules names the closed drawer and its summary',
        desc.includes('Closed now: research (sourced web research'), desc);

    setDrawer(root, 'admin', false);
    setDrawer(root, 'research', true);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    check('two choices on different drawers are both kept', stored.open.includes('research') && stored.closed.includes('admin') && !stored.closed.includes('research'), JSON.stringify(stored));
    check('reopening lists the tools again', names(openDrawerTools(root)).includes('research_topic') && !names(openDrawerTools(root)).includes('project_deck'));
    check('listDrawers reports state, tool names and size',
        listDrawers(root).every(d => typeof d.open === 'boolean' && Array.isArray(d.tools) && d.tokens > 0)
        && listDrawers(root).find(d => d.id === 'admin').tools.length === ADMIN_TOOLS.length);

    check('an unknown drawer is refused by name', /Unknown drawer "nope"\. Drawers: research, code, admin/.test(throws(() => setDrawer(root, 'nope', true))));

    fs.writeFileSync(file, '{not json');
    check('an unreadable state file falls back to the defaults', isDrawerOpen(root, 'research') && !isDrawerOpen(root, 'admin'));
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
