// Hub settings files (lib/app-data.mjs writeFileAtomic): hub_config.json is replaced atomically,
// and an unreadable one is kept aside instead of being overwritten by the next save.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Everything below runs against a temp data folder; lib/workspaces.mjs bootstraps it on import.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-hub-config-'));
const home = path.join(temp, 'hub');
process.env.PLUTOS_HOME = home;
delete process.env.PLUTOS_MODE;

let passed = 0, failed = 0;
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ok  ${name}`); } else { failed++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); } };
const parses = file => { try { JSON.parse(fs.readFileSync(file, 'utf8')); return true; } catch (e) { return false; } };
const leftovers = () => fs.readdirSync(home).filter(f => f.endsWith('.tmp'));
const asides = name => fs.readdirSync(home).filter(f => f.startsWith(`${name}.corrupt-`));

// Collect the one-line notices instead of printing them between the ok lines.
const notices = [];
const realError = console.error;
console.error = (...args) => notices.push(args.join(' '));

try {
    const hubFile = path.join(home, 'hub_config.json');
    const torn = '{\n  "workspaces": [\n    "C:\\\\Users\\\\owner\\\\proj';
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(hubFile, torn, 'utf8');

    const workspaces = await import('../lib/workspaces.mjs');
    const { writeFileAtomic } = await import('../lib/app-data.mjs');

    // --- torn hub_config.json --------------------------------------------------------------
    const hubAside = asides('hub_config.json');
    check('a torn hub_config.json starts the app with an empty list', workspaces.getWorkspaces().length === 0);
    check('the torn file is moved aside, not left in place', hubAside.length === 1 && !fs.existsSync(hubFile), fs.readdirSync(home).join(','));
    const asideFile = path.join(home, hubAside[0] || 'missing');
    check('the moved-aside copy is byte-for-byte the original', fs.existsSync(asideFile) && fs.readFileSync(asideFile, 'utf8') === torn);
    check('one line says so and where', notices.filter(n => n.includes('hub_config.json') && n.includes(asideFile)).length === 1, notices.join(' | '));

    // --- a save after that ---------------------------------------------------------------
    const project = path.join(temp, 'project');
    fs.mkdirSync(project);
    workspaces.addWorkspace(project);
    const saved = fs.readFileSync(hubFile, 'utf8');
    const data = JSON.parse(saved);
    check('a save writes a registry that parses and holds the project', data.workspaces.length === 1 && data.activeWorkspace === data.workspaces[0], saved);
    check('the format is unchanged (2-space JSON, no trailing newline)', saved === JSON.stringify(data, null, 2));
    check('a save leaves no temp files', leftovers().length === 0, leftovers().join(','));
    check('the save does not touch the preserved copy', fs.readFileSync(asideFile, 'utf8') === torn && asides('hub_config.json').length === 1);
    workspaces.closeWorkspace();
    check('a second save still parses and keeps the last project', JSON.parse(fs.readFileSync(hubFile, 'utf8')).activeWorkspace === data.workspaces[0] && leftovers().length === 0);

    // --- a failed write cleans up -------------------------------------------------------------
    // Renaming a file onto a non-empty directory fails on every platform.
    const blocker = path.join(home, 'blocked.json');
    fs.mkdirSync(blocker);
    fs.writeFileSync(path.join(blocker, 'keep'), 'x');
    let threw = false;
    try { writeFileAtomic(blocker, '{}'); } catch (e) { threw = true; }
    check('a failed write throws and removes its temp file', threw && leftovers().length === 0, leftovers().join(','));
} catch (e) {
    failed++;
    console.log(`  FAIL unexpected error — ${e.stack || e.message}`);
} finally {
    console.error = realError;
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

console.log(`Hub config: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
