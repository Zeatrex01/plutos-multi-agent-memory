// `plutos wait --seat <name>` (lib/wait.mjs): exits 3 on timeout when nothing is assigned, wakes
// when a TODO for the seat lands on the board while it waits, prints the same instruction the
// watcher hook gives, ignores other seats' and claimed work, and refuses a folder with no kit.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ok  ${name}`); } else { failed++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); } };

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-wait-'));
const project = path.join(temp, 'game');
const env = { ...process.env, HOME: path.join(temp, 'home'), USERPROFILE: path.join(temp, 'home'), PLUTOS_HOME: path.join(temp, 'hub') };
const cli = (...args) => spawnSync(process.execPath, [path.join(root, 'cli.mjs'), ...args], { cwd: temp, encoding: 'utf8', env });
const board = () => path.join(project, 'docs', 'handoff', 'BOARD.md');
const addEntry = (agent, status, title, assignee) => fs.appendFileSync(board(),
    `\n### ${agent} · ${status} · ${title}\n- **Started:** 2026-10-30\n${assignee ? `- **Assignee:** ${assignee}\n` : ''}- **Task:** ${title} task\n`);

try {
    fs.mkdirSync(project);
    check('kit installed for the test', cli('init', project).status === 0);

    const none = cli('wait', project, '--seat', 'Codex', '--interval', '1', '--timeout', '1');
    check('nothing assigned: exit 3 after the timeout, nothing printed', none.status === 3 && !none.stdout.trim(), `${none.status} ${none.stdout}`);

    addEntry('Claude', 'TODO', 'Claude only', 'Claude');
    addEntry('Codex', 'IN_PROGRESS', 'Already claimed', 'Codex');
    const other = cli('wait', project, '--seat', 'Codex', '--interval', '1', '--timeout', '1');
    check("another seat's TODO and claimed work do not wake it", other.status === 3, `${other.status} ${other.stdout}`);

    // Start waiting, then assign work while it waits.
    const child = spawn(process.execPath, [path.join(root, 'cli.mjs'), 'wait', project, '--seat', 'codex', '--interval', '1', '--timeout', '20'], { cwd: temp, env });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
    await new Promise(r => setTimeout(r, 1500));
    addEntry('Owner', 'TODO', 'Fix the login bug', 'Codex');
    const code = await exited;
    check('wakes when work for the seat lands on the board (seat matched case-insensitively)', code === 0 && out.includes('Fix the login bug'), `${code} ${out}`);
    check('prints the watcher instruction: claim it, then close it', out.includes('Claim it with board_update status IN_PROGRESS') && out.includes('assigned to you (codex)'));

    const bare = path.join(temp, 'bare');
    fs.mkdirSync(bare);
    const refused = cli('wait', bare, '--seat', 'Codex', '--timeout', '1');
    check('a folder without the kit is refused', refused.status === 1 && /no PLUT_OS kit/.test(refused.stderr), refused.stderr);
    check('a missing seat is refused', cli('wait', project).status === 1);
} finally {
    fs.rmSync(temp, { recursive: true, force: true });
}
console.log(`Wait: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
