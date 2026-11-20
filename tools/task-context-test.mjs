// plutos_context_for_task: anchors (path, symbol, words, Turkish words), the graph step, the
// confidence it reports, its size limit, its cache, and that it writes nothing; dotted names that
// are not files, the .sql files only the task index reads, and the capped text scan.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { taskContext, parseTask, resetTaskContextCache, shareExtraCap, buildTaskIndex, rankFiles } from '../lib/task-context.mjs';
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
write('db/schema.sql', "CREATE TABLE IF NOT EXISTS public.product_catalog (id int);\ncreate or replace view recent_orders as select 1;\n");
write('mobile/lib/cart_store.dart', "class CartStore {\n  void add() {}\n}\n");
write('shaders/dissolve_edge.gdshader', "shader_type canvas_item;\n");
write('web/components/CouponPanel.vue', "<template><div/></template>\n<script setup lang=\"ts\">\nexport function useCouponBanner() {}\n</script>\n");
write('web/src/routes/OrderTimeline.svelte', "<script>\n  export function formatShipmentEta() {}\n</script>\n");
write('site/src/pages/PricingGrid.astro', "---\nexport function loadPricingTiers() {}\n---\n<div/>\n");
write('lib/totals.mjs', "export function sumAll(o) { return o['discounts'].length; }\n");

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

    const dotted = parseTask('`orders.items` is empty; see lib/board.mjs and README.md');
    check('a dotted name whose suffix is not a file extension is not a path',
        !dotted.paths.includes('orders.items') && dotted.paths.includes('lib/board.mjs') && dotted.paths.includes('README.md'), JSON.stringify(dotted.paths));
    check('...both halves become search words', dotted.words.includes('order') && dotted.words.includes('item'), JSON.stringify(dotted.words));
    check('...and it is not reported as a missing file', !taskContext(root, 'orders.items shows nothing').unmatched.paths.length);

    const sql = taskContext(root, 'product_catalog loses rows');
    check('a .sql table declaration is found for the task index', sql.files[0]?.file === 'db/schema.sql' && /declares product_catalog/.test(sql.files[0].reasons.join(' ')), sql.files[0]?.file);
    check('Turkish catalog words reach English code', files('katalog geçmiş')[0] === 'db/schema.sql');
    check('the new Turkish words are in the dictionary', ['geçmiş', 'katalog', 'defter', 'sık'].every(w => parseTask(w).words.length), JSON.stringify(parseTask('geçmiş katalog defter sık').words));

    check('a Dart class is declared for the task index (task search only)', files('CartStore loses items')[0] === 'mobile/lib/cart_store.dart');
    check('a shader file is found by its name', files('the dissolve edge flickers')[0] === 'shaders/dissolve_edge.gdshader');
    check('a meta file name in a task is a path (project.godot, vercel.json)',
        ['project.godot', 'vercel.json', 'go.mod'].every(f => parseTask(`check ${f} first`).paths.includes(f)));
    check('a table name is compared whole, not split into a suffix (user.mod, foo.example are not files)',
        ['user.mod', 'foo.example', 'app.sample'].every(f => !parseTask(`${f} is wrong`).paths.length), JSON.stringify(parseTask('user.mod is wrong').paths));
    check('a .vue file\'s script declarations reach the task index', files('useCouponBanner shows twice')[0] === 'web/components/CouponPanel.vue');
    check('...and a .svelte file\'s', files('formatShipmentEta is off by a day')[0] === 'web/src/routes/OrderTimeline.svelte');
    check('...and an .astro file\'s frontmatter', files('loadPricingTiers returns nothing')[0] === 'site/src/pages/PricingGrid.astro');

    const text = taskContext(root, 'discounts vanish at checkout');
    check('a term nothing else found is looked for in the files\' text', text.files[0]?.file === 'lib/totals.mjs'
        && text.files[0].reasons.includes('contains discount') && text.anchors.content === 1 && /1 text/.test(text.text), JSON.stringify(text.files[0]));
    check('...and a term the text scan finds is not reported missing', !text.unmatched.words.includes('discount'));
    check('...a text match alone does not raise the confidence', text.confidence === 'low', text.confidence);
    for (let i = 0; i < 9; i++) write(`notes/n${i}.mjs`, "export const flavour = 'quux';\n");
    resetTaskContextCache();
    check('a term in more files than the cap adds nothing', !files('quux breaks').some(f => f.startsWith('notes/')));
    fs.rmSync(path.join(root, 'notes'), { recursive: true });
    resetTaskContextCache();

    // Cache: a .sql file counts for freshness too.
    files('warm the cache');
    write('db/later.sql', "CREATE TABLE stock_ledger (id int);\n");
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(root, 'db/later.sql'), later, later);
    check('a .sql file added after the scan is found on the next call', files('stock_ledger is wrong', { now: Date.now() + 6_000 })[0] === 'db/later.sql');
    fs.rmSync(path.join(root, 'db/later.sql'));
    resetTaskContextCache();

    // Cache: a new declaration is found once its file is newer than the scan.
    write('lib/notify.mjs', "export function sendNotification() {}\n");
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(root, 'lib/notify.mjs'), future, future);
    check('a file added after the scan is found on the next call', files('sendNotification fails', { now: Date.now() + 6_000 })[0] === 'lib/notify.mjs');
    resetTaskContextCache();

    // read-only sessions get no write instruction; the default keeps it.
    check('readOnly output has no board_update / doneWhen line', !/board_update|doneWhen/.test(taskContext(root, 'sendNotification fails', { readOnly: true }).text));
    check('default output still carries the doneWhen line', /board_update doneWhen/.test(taskContext(root, 'sendNotification fails').text));

    // Cache: hits do not slide the freshness window (fake clock via `now`).
    resetTaskContextCache();
    const t0 = Date.now();
    files('warm the cache', { now: t0 });
    write('lib/slide.mjs', "export function slideProbe() {}\n");
    const fut = new Date(t0 + 120_000);
    fs.utimesSync(path.join(root, 'lib/slide.mjs'), fut, fut);
    check('inside 5 s the cached index is served', files('slideProbe fails', { now: t0 + 3_000 })[0] !== 'lib/slide.mjs');
    check('a second hit at +4 s does not move the window', files('slideProbe fails', { now: t0 + 4_000 })[0] !== 'lib/slide.mjs');
    check('at +6 s from the build the source check runs, though calls were under 5 s apart',
        files('slideProbe fails', { now: t0 + 6_000 })[0] === 'lib/slide.mjs');
    fs.rmSync(path.join(root, 'lib/slide.mjs'));
    resetTaskContextCache();

    // Cache: a deleted file is noticed (file count drops), and a verified entry still expires at MAX_AGE.
    write('lib/doomed.mjs', "export function doomedProbe() {}\n");
    const t1 = Date.now();
    check('a file present at the scan is found', files('doomedProbe fails', { now: t1 })[0] === 'lib/doomed.mjs');
    fs.rmSync(path.join(root, 'lib/doomed.mjs'));
    check('a deleted file is gone from the next result', !files('doomedProbe fails', { now: t1 + 6_000 }).includes('lib/doomed.mjs'));
    resetTaskContextCache();

    fs.rmSync(path.join(root, 'lib/notify.mjs'));
    check('it writes nothing into the project', JSON.stringify(list(root)) === JSON.stringify(before));

    const built = buildProjectDocGraph(root, 'code');
    const json = JSON.parse(fs.readFileSync(path.join(root, 'graphify-out', 'code_graph.json'), 'utf8'));
    check('the graphify code graph file keeps its shape (no symbols key)', built.success && !('symbols' in json) && Array.isArray(json.nodes));
    check('the .sql files stay out of the graphify graph', !json.nodes.some(n => n.id.endsWith('.sql')));
    check('...and so do the task-search-only languages', !json.nodes.some(n => /\.(dart|gdshader)$/.test(n.id)));

    check('the MCP tool is classified read-only', toolAccess('plutos_context_for_task') === 'read');
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}

// Conventional paths: a concept the code does not name (deploy, CI, migrations) reaches the
// config files where it conventionally lives, only those that exist, below the anchors.
const conv = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-task-context-conv-'));
const put = (rel, body = '') => { fs.mkdirSync(path.dirname(path.join(conv, rel)), { recursive: true }); fs.writeFileSync(path.join(conv, rel), body); };
put('src/board.mjs', "export function readBoard() { return []; }\n");
put('vercel.json', '{}');
put('.github/workflows/ci.yml', 'on: push\n');
put('supabase/migrations/20260101_init.sql', 'select 1;\n');
put('supabase/migrations/20260301_rls.sql', 'select 2;\n');
put('playwright.config.ts', 'export default {};\n');
put('project.godot', '[application]\n');
put('scenes/main.tscn', '[gd_scene]\n');
try {
    const cfiles = (task) => taskContext(conv, task).files;
    const deploy = cfiles('the deploy to production fails');
    check('a concept the code does not name reaches its conventional path', deploy[0]?.file === 'vercel.json'
        && deploy[0].conventional && deploy[0].reasons[0] === 'conventional path for deploy', JSON.stringify(deploy[0]));
    check('...only paths that exist (no netlify.toml, no Dockerfile)', !deploy.some(f => /netlify|Dockerfile/.test(f.file)));
    check('...and it does not raise the confidence', taskContext(conv, 'the deploy to production fails').confidence === 'low');
    check('...and the answer says so', /1 conventional/.test(taskContext(conv, 'the deploy to production fails').text));
    check('a CI word lists the workflow files', cfiles('CI pipeline is red').some(f => f.file === '.github/workflows/ci.yml'));
    const tr = cfiles('migrasyon dosyası bozuk').map(f => f.file);
    check('Turkish concept words work, a directory lists its newest files first',
        tr[0] === 'supabase/migrations/20260301_rls.sql' && tr.includes('supabase/migrations/20260101_init.sql'), tr.join(', '));
    check('a Turkish suffix on a concept word matches (dağıtımı)', cfiles('dağıtımı düzelt')[0]?.file === 'vercel.json');
    check('a config glob matches by extension', cfiles('e2e tests flake').some(f => f.file === 'playwright.config.ts'));
    const mixed = cfiles('the board deploy is broken').map(f => f.file);
    check('conventional paths rank after the direct anchors', mixed[0] === 'src/board.mjs' && mixed.includes('vercel.json'), mixed.join(', '));
    const strong = cfiles('deploy breaks in `readBoard`').map(f => f.file);
    check('a task with a symbol anchor gets no conventional paths', !strong.includes('vercel.json'), strong.join(', '));
    check('an engine-settings concept reaches the engine project file', cfiles('input map is wrong in the project settings').some(f => f.file === 'project.godot'));
    check('a scene concept lists the scenes folder', cfiles('sahne açılmıyor').some(f => f.file === 'scenes/main.tscn'));
    check('a word that only contains a concept word does not match (city, cinema)', !cfiles('city cinema').some(f => f.conventional));
} finally {
    fs.rmSync(conv, { recursive: true, force: true });
}
// Named files bypass type indexing; document topics use only names and bounded headings.
const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-task-context-docs-'));
const putDoc = (rel, body = '') => { fs.mkdirSync(path.dirname(path.join(docs, rel)), { recursive: true }); fs.writeFileSync(path.join(docs, rel), body); };
putDoc('src/approval.mjs', 'export function approvalFlow() {}\n');
for (let i = 0; i < 8; i++) putDoc(`src/unrelated${i}.mjs`, `export const value${i} = ${i};\n`);
const codeBeforeDocuments = rankFiles(buildTaskIndex(docs), parseTask('approval expiry')).ranked;
putDoc('docs/handoff/results/x.md', '# Approval expiry\nBodyonlyword is not a heading.\n');
putDoc('docs/guide.md', 'Approval workflow\n=================\n');
putDoc('docs/another.md', '## Approval checks\n');
putDoc('docs/approval-reference.md', 'No heading needed for a filename match.\n');
putDoc('README.md', '# Rootreadmetopic\n');
putDoc('AGENTS.md', '# Rootagenttopic\n');
putDoc('notes/outside.md', '# Outsidedoctopic\n');
putDoc('docs/deep.md', `${'ordinary prose\n'.repeat(20_000)}# Beyondheadtopic\n`);
putDoc('docs/sample.md', '```md\n# Fencedheadingtopic\n```\n');
for (const rel of ['docs/handoff/archive/old.md', 'docs/ai/codeindex/map.md', 'docs/ai/obsidian/map.md',
    'CHANGELOG.md', 'docs/CHANGELOG.md', 'graphify-out/report.md', 'node_modules/pkg/guide.md', '.hidden/guide.md'])
    putDoc(rel, '# Approval excludedtopic\n');
putDoc('notes/report.txt', 'Plain text report.\n');
putDoc('assets/data.unusualsuffix', 'Arbitrary type.\n');
putDoc('LICENSE', 'Extensionless file.\n');
try {
    const query = (task, opts) => taskContext(docs, task, opts);
    const named = query('approvalFlow: inspect `./docs/handoff/results/x.md`');
    check('an exact report path ranks first ahead of code', named.files[0]?.file === 'docs/handoff/results/x.md');
    check('an exact report has the named reason', named.files[0]?.reasons.includes('named in the task'));
    check('a backslash report path works', query('inspect .\\docs\\handoff\\results\\x.md').files[0]?.file === 'docs/handoff/results/x.md');
    check('a nonexistent path is ignored', !query('inspect docs/missing.md').files.some(f => f.file === 'docs/missing.md'));
    check('a nonexistent same-basename path does not expand to a document', !query('inspect docs/missing/x.md').files.some(f => f.file === 'docs/handoff/results/x.md'));
    check('exact paths support text files', query('notes/report.txt').files[0]?.file === 'notes/report.txt');
    check('exact paths support unknown types', query('assets/data.unusualsuffix').files[0]?.file === 'assets/data.unusualsuffix');
    check('exact paths support extensionless files', query('`LICENSE`').files[0]?.file === 'LICENSE');
    check('a named directory does not expand', query('`docs/handoff/results`').files.length === 0);
    check('walker-excluded paths stay excluded even when named', query('node_modules/pkg/guide.md .hidden/guide.md graphify-out/report.md').files.length === 0);
    check('an outside-project path is ignored', query('../escape.md').files.length === 0);
    const topic = query('approval expiry');
    const topicFiles = topic.files.map(f => f.file);
    check('a heading topic returns a document below matching code', topicFiles[0] === 'src/approval.mjs'
        && topicFiles.includes('docs/handoff/results/x.md'), topicFiles.join(', '));
    check('topic documents are capped at two', topic.files.filter(f => /\.md$/.test(f.file)).length === 2);
    check('adding documents preserves code scores and ordering', JSON.stringify(codeBeforeDocuments)
        === JSON.stringify(rankFiles(buildTaskIndex(docs), parseTask('approval expiry')).ranked.filter(f => f.file.endsWith('.mjs'))));
    check('a document filename is searchable', query('reference').files.some(f => f.file === 'docs/approval-reference.md'));
    check('Setext headings are searchable', query('workflow').files.some(f => f.file === 'docs/guide.md'));
    check('root README and AGENTS headings are searchable', query('rootreadmetopic').files[0]?.file === 'README.md'
        && query('rootagenttopic').files[0]?.file === 'AGENTS.md');
    check('document body text is not searchable', query('bodyonlyword').files.length === 0);
    check('headings in fenced code are not searchable', query('fencedheadingtopic').files.length === 0);
    check('headings beyond the bounded head are not searchable', query('beyondheadtopic').files.length === 0);
    check('Markdown outside docs and root guidance stays out of topic search', query('outsidedoctopic').files.length === 0);
    check('generated documents, archives and changelogs never appear in topic search', query('excludedtopic').files.length === 0);
    const explicit = query('docs/handoff/results/x.md docs/guide.md docs/another.md');
    check('explicit documents are exempt from the topic cap', ['docs/handoff/results/x.md', 'docs/guide.md', 'docs/another.md']
        .every((f, i) => explicit.files[i]?.file === f));
    check('documents count toward max_files', query('docs/handoff/results/x.md approval', { maxFiles: 1 }).files.length === 1);
    const small = query('docs/handoff/results/x.md approval', { budgetTokens: 200 });
    check('documents respect the output token budget', small.text.length / 4 <= 220 && /1\. docs\/handoff\/results\/x\.md/.test(small.text));
    const t0 = Date.now();
    putDoc('docs/new.md', '# Freshdocumenttopic\n');
    const later = new Date(t0 + 60_000);
    fs.utimesSync(path.join(docs, 'docs/new.md'), later, later);
    check('new document headings invalidate the cache', query('freshdocumenttopic', { now: t0 + 6_000 }).files[0]?.file === 'docs/new.md');
    fs.rmSync(path.join(docs, 'docs/handoff/results/x.md'));
    check('a removed named document is ignored even with a cached index', !query('docs/handoff/results/x.md').files.some(f => f.file === 'docs/handoff/results/x.md'));
} finally {
    fs.rmSync(docs, { recursive: true, force: true });
}

// The task-only cap: 600 .vue files must not push out the one .sql file a data task anchors on.
const many = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-task-context-cap-'));
const putMany = (rel, body = '') => { fs.mkdirSync(path.dirname(path.join(many, rel)), { recursive: true }); fs.writeFileSync(path.join(many, rel), body); };
for (let i = 0; i < 600; i++) putMany(`components/Widget${String(i).padStart(3, '0')}.vue`, '<template><div/></template>\n');
putMany('supabase/migrations/001.sql', 'create table invoice_ledger (id int);\n');
putMany('shaders/zz_glow.wgsl', 'fn glowStrength() {}\n');
try {
    const got = taskContext(many, 'invoice_ledger rows are missing').files.map(f => f.file);
    check('the task-only cap keeps the .sql files when other kinds pass it', got[0] === 'supabase/migrations/001.sql', got.join(', '));
    const capped = shareExtraCap([...Array.from({ length: 10 }, (_, i) => `a/${i}.vue`), 'b/x.wgsl', 'c/y.sql'], 4);
    check('...and shares the rest among the other kinds in turn', JSON.stringify(capped) === JSON.stringify(['c/y.sql', 'a/0.vue', 'b/x.wgsl', 'a/1.vue']), JSON.stringify(capped));
} finally {
    fs.rmSync(many, { recursive: true, force: true });
}

// Root-suffix concept paths (`*.uproject`) and the order a concept offers its files in.
const eng = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-task-context-eng-'));
const putEng = (rel, body = '') => { fs.mkdirSync(path.dirname(path.join(eng, rel)), { recursive: true }); fs.writeFileSync(path.join(eng, rel), body); };
putEng('Game.uproject', '{}');
putEng('Source/Other.uproject', '{}');
putEng('.env.example', 'A=1\n');
putEng('tsconfig.json', '{}');
putEng('vite.config.ts', 'export default {};\n');
try {
    const ue = taskContext(eng, 'the project settings are wrong').files.map(f => f.file);
    check('a `*.uproject` concept path returns the root project file only', ue.includes('Game.uproject') && !ue.includes('Source/Other.uproject'), ue.join(', '));
    const env = taskContext(eng, 'the env variable is wrong').files.map(f => f.file);
    check('an env task offers .env.example before the bundler and TypeScript configs', env[0] === '.env.example'
        && env.indexOf('vite.config.ts') < env.indexOf('tsconfig.json'), env.join(', '));
} finally {
    fs.rmSync(eng, { recursive: true, force: true });
}
console.log(`Task context: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
