// plutos_context_for_task: anchors (path, symbol, words, Turkish words), the graph step, the
// confidence it reports, its size limit, its cache, and that it writes nothing.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { taskContext, parseTask, resetTaskContextCache } from '../lib/task-context.mjs';
import { buildProjectDocGraph } from '../lib/graphify.mjs';
import { toolAccess } from '../lib/tool-policy.mjs';

let passed = 0, failed = 0;
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ok  ${name}`); } else { failed++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); } };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-task-context-'));
const write = (rel, body) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };
write('lib/approvals.mjs', "export function answerApproval(id) { return id; }\nexport const APPROVAL_TTL = 5;\n");
write('lib/meetings.mjs', "import { answerApproval } from './approvals.mjs';\nexport function scheduleMeeting() { return answerApproval(1); }\n");
write('lib/board.mjs', "export function readBoard() { return []; }\n");
write('server.mjs', "import { scheduleMeeting } from './lib/meetings.mjs';\nimport { readBoard } from './lib/board.mjs';\nscheduleMeeting(); readBoard();\n");
write('tools/approvals-test.mjs', "import { answerApproval } from '../lib/approvals.mjs';\nanswerApproval(2);\n");
write('game/player.gd', "class_name PlayerController\nextends Node\nfunc jump():\n\tpass\n");
write('game/level.gd', "extends Node\nvar p: PlayerController\n");
write('Assets/Scripts/Inventory.cs', "public class InventorySlot { }\n");

const list = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort();
const before = list(root);
const files = (task, opts) => taskContext(root, task, opts).files.map(f => f.file);

try {
    const named = taskContext(root, 'Change the TTL in lib/approvals.mjs');
    check('a path the task names comes first', named.files[0]?.file === 'lib/approvals.mjs', named.files[0]?.file);
    check('...and the answer says why', /named in the task/.test(named.files[0].reasons.join(' ')));
    check('a named path and a strong score read as high confidence', named.confidence === 'high', named.confidence);

    const bySymbol = taskContext(root, 'answerApproval() returns the wrong id');
    check('an identifier finds the file that declares it', bySymbol.files[0]?.file === 'lib/approvals.mjs', bySymbol.files[0]?.file);
    check('the graph adds the file that uses it, with the reason',
        bySymbol.files.some(f => f.file === 'lib/meetings.mjs' && f.reasons.some(r => r === 'uses lib/approvals.mjs')));
    const ranks = bySymbol.files.map(f => f.file);
    check('a test file ranks below the code it tests when the task is not about tests',
        ranks.indexOf('tools/approvals-test.mjs') > ranks.indexOf('lib/meetings.mjs'), ranks.join(', '));
    const testTask = files('add a test for answerApproval');
    check('...and rises when the task is about tests', testTask.indexOf('tools/approvals-test.mjs') < testTask.indexOf('lib/meetings.mjs'), testTask.join(', '));

    check('a GDScript class_name is a declaration', files('PlayerController falls through the floor')[0] === 'game/player.gd');
    check('a GDScript reference is an edge', files('PlayerController falls through the floor').includes('game/level.gd'));
    check('a C# class is a declaration', files('InventorySlot loses items')[0] === 'Assets/Scripts/Inventory.cs');

    check('Turkish task words reach English code', files('Toplantıları planlarken hata veriyor')[0] === 'lib/meetings.mjs');
    check('plain English words match path segments and symbol parts', files('the board reader is empty')[0] === 'lib/board.mjs');

    const nothing = taskContext(root, 'zzqx wibble frobnicate');
    check('a task that matches nothing says so with low confidence', nothing.files.length === 0 && nothing.confidence === 'low' && /No file/.test(nothing.text));
    const missing = taskContext(root, 'fix `doesNotExist` in lib/approvals.mjs');
    check('an identifier the code does not have is reported', missing.unmatched.identifiers.includes('doesNotExist') && /Not found in the code: doesNotExist/.test(missing.text));
    let threw = '';
    try { taskContext(root, '   '); } catch (e) { threw = e.message; }
    check('an empty task is refused', /task is required/.test(threw));

    const small = taskContext(root, 'answerApproval scheduleMeeting readBoard PlayerController InventorySlot', { budgetTokens: 200 });
    check('the answer stays within its size limit', small.text.length / 4 <= 200 + 20, String(small.text.length));
    check('max_files caps the list', taskContext(root, 'answerApproval', { maxFiles: 1 }).files.length === 1);

    const p = parseTask('fix(mcp): `ticketPath` in ./lib/approvals.mjs v1.2.3, e.g. statuses');
    check('parsing: paths, identifiers, no version numbers or commit types',
        p.paths.includes('lib/approvals.mjs') && p.identifiers.includes('ticketPath') && !p.paths.some(x => /1\.2/.test(x))
        && !p.identifiers.includes('fix') && p.words.includes('status'), JSON.stringify(p));

    // Cache: a new declaration is found once its file is newer than the scan.
    write('lib/notify.mjs', "export function sendNotification() {}\n");
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(root, 'lib/notify.mjs'), future, future);
    check('a file added after the scan is found on the next call', files('sendNotification fails', { now: Date.now() + 6_000 })[0] === 'lib/notify.mjs');
    resetTaskContextCache();

    fs.rmSync(path.join(root, 'lib/notify.mjs'));
    check('it writes nothing into the project', JSON.stringify(list(root)) === JSON.stringify(before));

    const built = buildProjectDocGraph(root, 'code');
    const json = JSON.parse(fs.readFileSync(path.join(root, 'graphify-out', 'code_graph.json'), 'utf8'));
    check('the graphify code graph file keeps its shape (no symbols key)', built.success && !('symbols' in json) && Array.isArray(json.nodes));

    check('the MCP tool is classified read-only', toolAccess('plutos_context_for_task') === 'read');
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
console.log(`Task context: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
