// Token budget: what every AI session pays before it does any work.
//
// Each connected client loads the MCP tool definitions, reads AGENTS.md and calls
// session_start. On 2026-10-24 that came to about 20 000 tokens per session, half of it tools
// no ordinary project uses. This suite measures the three numbers on a freshly installed kit
// project, the way a client meets them, and fails when one grows past its budget in
// tools/token-budget.json. Budgets only move down: when a change makes a number smaller, run
//   node tools/token-budget-test.mjs --update
// and commit the lowered file. --update never raises a budget.
//
// Tokens are estimated as characters / 4. That is not any model's tokenizer, but it is stable,
// so a change in the number is a change in what the client is sent. Line endings are counted
// as \n: a Windows checkout turns AGENTS.md into CRLF, which adds one character per line without
// changing a word of it, and the same budget has to hold on every platform.
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const budgetFile = path.join(root, 'tools', 'token-budget.json');
const update = process.argv.includes('--update');
const tokens = (s) => Math.ceil(String(s).replace(/\r\n/g, '\n').length / 4);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-budget-'));
process.env.PLUTOS_HOME = path.join(tmp, 'hub');
process.env.HOME = process.env.USERPROFILE = path.join(tmp, 'user-home');
process.env.APPDATA = path.join(tmp, 'user-home', 'AppData', 'Roaming');
fs.mkdirSync(process.env.APPDATA, { recursive: true });
const { initTargetProject } = await import('../lib/workspaces.mjs');
const { wireClient } = await import('../lib/connect.mjs');

function connect(projectRoot) {
    const env = { ...process.env, PLUTOS_PROJECT_ROOT: projectRoot };
    for (const k of ['CODEX_HOME', 'CLAUDE_PROJECT_DIR', 'PLUTOS_CODEX_PROJECT_CONFIG', 'PLUTOS_PROJECT_BOUND_BY_LAUNCHER']) delete env[k];
    const srv = spawn(process.execPath, [path.join(root, 'index.mjs')], { cwd: projectRoot, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '', nextId = 1;
    const pending = new Map();
    srv.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            try { const m = JSON.parse(line); if (m.id != null) pending.get(m.id)?.(m); } catch (e) { /* not JSON-RPC */ }
        }
    });
    const rpc = (method, params) => new Promise((resolve, reject) => {
        const id = nextId++;
        const t = setTimeout(() => reject(new Error(`${method} timed out`)), 15000);
        pending.set(id, (m) => { clearTimeout(t); resolve(m); });
        srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    return { srv, rpc };
}

let failed = 0;
try {
    const project = path.join(tmp, 'project');
    fs.mkdirSync(project, { recursive: true });
    initTargetProject(project);
    // The kit wires no client; the budget is measured on a wired project, as a session sees it.
    wireClient('claude-code', project);
    // The kit's pointers import AGENTS.md, so the rules measured below are what Claude Code and
    // Gemini CLI load, not a file they might open.
    for (const [file, line] of [['CLAUDE.md', '@AGENTS.md'], ['GEMINI.md', '@./AGENTS.md']]) {
        if (!fs.readFileSync(path.join(project, file), 'utf8').split('\n').includes(line)) throw new Error(`kit ${file} does not import AGENTS.md (${line})`);
    }

    const { srv, rpc } = connect(project);
    try {
        const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'token-budget', version: '1' } });
        srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        const list = await rpc('tools/list', {});
        const tools = list.result?.tools;
        if (!Array.isArray(tools)) throw new Error('tools/list returned no tools: ' + JSON.stringify(list).slice(0, 200));
        const brief = await rpc('tools/call', { name: 'session_start', arguments: { ai: 'TokenBudget' } });
        const briefText = (brief.result?.content || []).map(c => c.text || '').join('');
        if (!briefText || brief.result?.isError) throw new Error('session_start failed: ' + briefText.slice(0, 200));

        const measured = {
            toolDefinitions: tokens(JSON.stringify(tools)),
            // Every client gets these with the server; the project path in them varies by machine.
            serverInstructions: tokens(String(init.result?.instructions || '').split(project).join('<PROJECT>')),
            agentsMd: tokens(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8')),
            // The brief names the owner's agreement file in the data folder, whose path length
            // differs by machine (a Windows temp folder is longer); count it as a fixed placeholder.
            // So does the install's own folder, which the Scope line names for the project-scissors skill.
            sessionStartBrief: tokens(briefText.split(process.env.PLUTOS_HOME).join('<PLUTOS_HOME>').split(root).join('<PLUTOS_APP>'))
        };
        const toolCount = tools.length;
        const budget = JSON.parse(fs.readFileSync(budgetFile, 'utf8'));
        console.log(`Session start cost on a fresh kit project (${toolCount} tools listed):`);
        let lowered = false;
        for (const [key, value] of Object.entries(measured)) {
            const limit = budget.budgets[key];
            const status = limit == null ? 'NO BUDGET' : value > limit ? 'OVER' : 'ok';
            console.log(`  ${status.padEnd(9)} ${key.padEnd(18)} ${String(value).padStart(6)} tokens  (budget ${limit ?? '-'})`);
            if (limit == null || value > limit) failed++;
            else if (update && value < limit) { budget.budgets[key] = value; lowered = true; }
            else if (value < limit * 0.97) console.log(`            ${key} is ${limit - value} under budget: run with --update to lock the saving in.`);
        }
        const total = Object.values(measured).reduce((a, b) => a + b, 0);
        console.log(`  total ${total} tokens before the first task`);
        // chars/4 under-counts Claude: Claude Code reported the 1,670-token AGENTS.md as 2.5k (2026-10-27).
        console.log(`  about ${Math.round(total * 1.45)} by Claude's count (x1.45); Claude Code defers the tools, so it pays about ${Math.round((total - measured.toolDefinitions) * 1.45)} plus the tool names`);
        if (lowered) {
            budget.measuredAt = new Date().toISOString().slice(0, 10);
            fs.writeFileSync(budgetFile, JSON.stringify(budget, null, 2) + '\n');
            console.log('  budget file lowered to the measured values.');
        }
        if (failed) console.log('  A budget was exceeded. Make the addition smaller, or move it behind a module that is off by default.');
    } finally {
        // Wait for the server to exit before its folder goes; one that has not stopped in 5 s is killed (P1-11).
        const exited = new Promise(done => { if (srv.exitCode !== null || srv.signalCode) done(); else srv.once('exit', done); });
        srv.kill();
        const force = setTimeout(() => srv.kill('SIGKILL'), 5000);
        await exited;
        clearTimeout(force);
    }
} catch (e) {
    failed++;
    console.log(`  FAIL ${e.message}`);
} finally {
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { /* a child may still hold a file */ }
}
console.log(`Token budget: ${failed ? 'FAILED' : 'within budget'}`);
process.exit(failed ? 1 : 0);
