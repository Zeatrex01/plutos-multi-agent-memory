// The feedback bridge (lib/feedback.mjs): the plutos_feedback MCP tool writes one scrubbed, capped
// line into the bound project's docs/handoff/plutos-feedback.jsonl and refuses a folder that is not a
// project; session_end's optional plutos_feedback field writes the same lines once; `feedback
// collect` writes each line once, skips and counts a malformed one; Home's quiet line shows only above 0.
// Also: the scrub's home-path and secret cases, links refused, the merge=union rule, the 2 MB read
// window, the memoized pending count, collect only in PLUT_OS's own checkout, and feedbackPending
// from a real GET /api/workspaces.
// Hermetic: a temporary hub (PLUTOS_HOME) and temporary projects; never the real feedback/ folder.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-feedback-'));
process.env.PLUTOS_HOME = path.join(tmp, 'hub');
const lib = await import('../lib/feedback.mjs');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
    if (cond) { passed++; console.log(`  ✅ ${name}`); }
    else { failed++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}

const kit = dir => {
    fs.mkdirSync(path.join(dir, 'docs', 'handoff'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '<!-- plutos:kit -->\n# AGENTS.md — PLUT_OS Shared Communication Rules\n');
    fs.writeFileSync(path.join(dir, 'docs', 'handoff', 'BOARD.md'), '# BOARD\n');
    return dir;
};
const feedbackFile = dir => path.join(dir, lib.FEEDBACK_REL);
const readLines = dir => fs.readFileSync(feedbackFile(dir), 'utf8').trim().split('\n').map(l => JSON.parse(l));
// Personal strings built at run time, so this file itself carries none (lib/release-scan.mjs).
const homePath = ['', 'home', 'alice', 'work', 'game.gd'].join('/');
const winPath = ['C:', 'Users', 'Bob', 'Desktop', 'x.txt'].join('\\');
const mail = ['alice.smith', 'corp.io'].join('@');

// --- A minimal stdio JSON-RPC client for index.mjs ---------------------------------------
function mcp(projectRoot) {
    const env = { ...process.env, PLUTOS_PROJECT_ROOT: projectRoot };
    for (const k of ['CODEX_HOME', 'CLAUDE_PROJECT_DIR', 'PLUTOS_CODEX_PROJECT_CONFIG', 'PLUTOS_PROJECT_BOUND_BY_LAUNCHER']) delete env[k];
    const srv = spawn(process.execPath, [path.join(repo, 'index.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '', nextId = 1;
    const pending = new Map();
    srv.stdout.on('data', d => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            try { const m = JSON.parse(line); if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch { /* noise */ }
        }
    });
    const rpc = (method, params) => new Promise(resolve => {
        const id = nextId++;
        const t = setTimeout(() => { pending.delete(id); resolve({ __timeout: true }); }, 10000);
        pending.set(id, m => { clearTimeout(t); resolve(m); });
        srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    return {
        init: async () => {
            const r = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'claude-code', version: '1' } });
            srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
            return r;
        },
        rpc,
        call: (name, args) => rpc('tools/call', { name, arguments: args }),
        kill: () => srv.kill()
    };
}
const textOf = r => r?.result?.content?.[0]?.text || '';
const isError = r => !!(r?.error || r?.result?.isError);

try {
    console.log('\n— the MCP tool —');
    const proj = kit(path.join(tmp, 'alpha'));
    const c = mcp(proj);
    const init = await c.init();
    const tools = (await c.rpc('tools/list', {})).result?.tools || [];
    const tool = tools.find(t => t.name === 'plutos_feedback');
    check('plutos_feedback is listed with kind and what required', tool && tool.inputSchema.required.join() === 'kind,what'
        && tool.inputSchema.properties.kind.enum.join() === 'missing,friction,bug,worked', JSON.stringify(tool));
    check('the task-to-tool map names plutos_feedback', /PLUT_OS lacked something or forced a workaround: plutos_feedback/.test(init.result?.instructions || ''));
    const sessionEnd = tools.find(t => t.name === 'session_end');
    check('session_end carries the optional plutos_feedback field', sessionEnd && 'plutos_feedback' in sessionEnd.inputSchema.properties
        && !sessionEnd.inputSchema.required.includes('plutos_feedback')
        && /Optional: what PLUT_OS lacked or forced you to work around in this session \(one line each\)/.test(sessionEnd.inputSchema.properties.plutos_feedback.description));

    const r = await c.call('plutos_feedback', {
        kind: 'missing', what: `no caller lookup for ${homePath}`, instead: `grep by hand, mailed ${mail}`,
        cost: '10 min, 80 tool calls', evidence: `opened ${winPath}`
    });
    check('the tool answers with the file it wrote', !isError(r) && /docs\/handoff\/plutos-feedback\.jsonl/.test(textOf(r)), textOf(r));
    const [line] = readLines(proj);
    check('the tool writes one line with time, ai, version and the fields', line && line.kind === 'missing' && line.via === 'mcp'
        && line.ai === 'Claude Code' && /^\d{4}-\d\d-\d\dT/.test(line.time) && typeof line.plutos?.version === 'string'
        && line.cost === '10 min, 80 tool calls', JSON.stringify(line));
    const raw = fs.readFileSync(feedbackFile(proj), 'utf8');
    check('home paths and e-mail addresses are scrubbed', !raw.includes('alice') && !raw.includes('Bob') && !raw.includes(mail)
        && line.what.endsWith('~/work/game.gd') && line.instead.includes('<email>') && line.evidence.includes('~\\Desktop'), raw);
    check('an unknown kind is refused and writes nothing', isError(await c.call('plutos_feedback', { kind: 'praise', what: 'x' })) && readLines(proj).length === 1);

    console.log('\n— session_end —');
    const end = await c.call('session_end', {
        ai: 'claude', headline: 'feedback session', did: 'd', operation_id: 'op-fb-1',
        plutos_feedback: ['missing: a board filter by AI', { kind: 'bug', what: 'brief cut mid-line', evidence: 'session_start part 2' }, 'the drawer list was long']
    });
    check('session_end reports the feedback lines it wrote', !isError(end) && /3 feedback lines for PLUT_OS added/.test(textOf(end)), textOf(end));
    const afterEnd = readLines(proj);
    check('session_end lines carry their kinds and via', afterEnd.length === 4
        && afterEnd.slice(1).map(l => `${l.via}:${l.kind}`).join() === 'session_end:missing,session_end:bug,session_end:friction'
        && afterEnd[1].what === 'a board filter by AI', JSON.stringify(afterEnd.slice(1)));
    const retry = await c.call('session_end', { ai: 'claude', headline: 'feedback session', did: 'd', operation_id: 'op-fb-1', plutos_feedback: 'missing: a board filter by AI' });
    check('an idempotent session_end retry writes no second line', !isError(retry) && readLines(proj).length === 4, textOf(retry));
    const plain = await c.call('session_end', { ai: 'claude', headline: 'no feedback', did: 'e' });
    check('session_end without the field stays as before', !isError(plain) && !/feedback line/.test(textOf(plain)) && readLines(proj).length === 4);
    const odd = await c.call('session_end', { ai: 'claude', headline: 'odd kind', did: 'f', plutos_feedback: [{ kind: 'praise', what: 'the brief', evidence: { tool: 'session_start' } }] });
    const oddLine = readLines(proj).pop();
    check('an unknown kind is recorded as friction and the reply says so', !isError(odd) && /Unknown kind "praise" recorded as friction/.test(textOf(odd))
        && oddLine.kind === 'friction' && oddLine.evidence === '{"tool":"session_start"}', textOf(odd));
    c.kill();

    console.log('\n— unbound —');
    const foreign = path.join(tmp, 'not-a-project');
    fs.mkdirSync(foreign, { recursive: true });
    const f = mcp(foreign);
    await f.init();
    const refused = await f.call('plutos_feedback', { kind: 'bug', what: 'x' });
    check('a folder without the kit is refused like every project writer', isError(refused) && /not a PLUT_OS project/.test(textOf(refused))
        && !fs.existsSync(feedbackFile(foreign)), textOf(refused));
    f.kill();
    let threw = '';
    try { lib.recordFeedback(foreign, { kind: 'bug', what: 'x' }); } catch (e) { threw = e.message; }
    check('the library refuses it as well', /not a PLUT_OS project/.test(threw));

    console.log('\n— caps and the CLI —');
    const beta = kit(path.join(tmp, 'beta'));
    const long = lib.recordFeedback(beta, { kind: 'friction', what: 'w'.repeat(5000), instead: 'i'.repeat(5000), cost: 'c'.repeat(5000), evidence: 'e'.repeat(5000) }, { ai: 'a'.repeat(500) });
    const L = long.lines[0];
    check('long fields are capped', L.what.length === lib.FEEDBACK_LIMITS.what && L.instead.length === lib.FEEDBACK_LIMITS.instead
        && L.cost.length === lib.FEEDBACK_LIMITS.cost && L.evidence.length === lib.FEEDBACK_LIMITS.evidence
        && L.ai.length === lib.FEEDBACK_LIMITS.ai && L.what.endsWith('…'));
    check('session_end items are capped in number', lib.sessionFeedbackItems(Array.from({ length: 30 }, (_, i) => `x${i}`)).length === lib.FEEDBACK_LIMITS.perSession);
    const cliOut = execFileSync(process.execPath, [path.join(repo, 'cli.mjs'), 'feedback', 'worked', 'the', 'brief', 'was', 'short', '--cost', '0', '--project', beta],
        { encoding: 'utf8', env: { ...process.env } });
    const cliLine = readLines(beta).pop();
    check('plutos feedback <kind> "<what>" writes the same line', /Added to/.test(cliOut) && cliLine.kind === 'worked' && cliLine.via === 'cli'
        && cliLine.what === 'the brief was short' && cliLine.cost === '0', JSON.stringify(cliLine));

    console.log('\n— collect —');
    // A malformed line and a blank one in a project file: skipped and counted, never fatal.
    fs.appendFileSync(feedbackFile(beta), '{not json\n\n["an array"]\n');
    const gamma = kit(path.join(tmp, 'gamma'));
    const roots = [proj, beta, gamma, path.join(tmp, 'gone')];
    const outDir = path.join(tmp, 'plutos', 'feedback');
    check('the pending count reads every unseen line', lib.pendingFeedbackCount(roots) === 7);
    const now = new Date('2026-11-17T10:00:00Z');
    const first = lib.collectFeedback(roots, { outDir, now });
    const file = path.join(outDir, '2026-11-17-collected.md');
    const md = fs.readFileSync(file, 'utf8');
    check('collect writes the new lines once, grouped by project and kind', first.fresh === 7 && first.read === 7 && first.projects === 2
        && first.file === file && /### alpha[\s\S]*\*\*missing\*\*[\s\S]*\*\*bug\*\*[\s\S]*### beta/.test(md), JSON.stringify(first));
    check('each collected line carries its evidence', /evidence: opened ~\\Desktop\\x\.txt/.test(md) && /evidence: session_start part 2/.test(md)
        && /evidence: none given/.test(md));
    check('a malformed line is skipped and counted', first.malformed === 2, String(first.malformed));
    check('the seen ledger lives in the hub, not the repository', fs.existsSync(path.join(process.env.PLUTOS_HOME, lib.SEEN_LEDGER)));
    const second = lib.collectFeedback(roots, { outDir, now });
    check('a second collect writes nothing new', second.fresh === 0 && second.duplicate === 7 && second.file === null
        && fs.readFileSync(file, 'utf8') === md && lib.pendingFeedbackCount(roots) === 0);
    lib.recordFeedback(gamma, { kind: 'bug', what: 'one more' }, { ai: 'Codex' });
    const third = lib.collectFeedback(roots, { outDir, now });
    const md3 = fs.readFileSync(file, 'utf8');
    check('a later line is collected into the same day\'s file as a new section', third.fresh === 1 && /### gamma[\s\S]*one more/.test(md3)
        && (md3.match(/^## Collected/gm) || []).length === 2);
    check('collect roots list each folder once', lib.feedbackRoots({ appRoot: proj, registered: [proj, `${proj}${path.sep}`, beta] }).length === 2);

    console.log('\n— privacy of the collected files —');
    const { PRIVATE } = await import('./publish-core.mjs');
    check('feedback/ and docs/handoff/ are private in publish-core', PRIVATE.includes('feedback/') && PRIVATE.includes('docs/handoff/'));

    console.log('\n— Home —');
    const source = fs.readFileSync(path.join(repo, 'ui', 'modules', 'overview.js'), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
    const ctx = { t: key => key === 'home_feedback_pending' ? '{n} pending' : key, escHtml: v => String(v ?? ''), emptyState: () => '', refreshApprovals() {},
        aiLinkWord: () => 'connected', fetch: () => Promise.reject(new Error('offline')), document: { getElementById: () => null } };
    vm.createContext(ctx);
    vm.runInContext(`${source}\nthis.statusHtml = statusHtml;`, ctx);
    const base = { project: 'p', report: null, hooks: null, mcp: null, usage: null };
    check('Home shows the quiet line only when lines wait', /3 pending/.test(ctx.statusHtml({ ...base, feedbackPending: 3 }))
        && !/pending/.test(ctx.statusHtml({ ...base, feedbackPending: 0 })) && !/pending/.test(ctx.statusHtml(base)));
    const i18n = fs.readFileSync(path.join(repo, 'ui', 'i18n.js'), 'utf8');
    check('the Home line has an English and a Turkish string', (i18n.match(/home_feedback_pending:/g) || []).length === 2);

    console.log('\n— scrub: home folders (lib/release-scan.mjs scrubPersonal) —');
    const { scrubPersonal, scanRelease } = await import('../lib/release-scan.mjs');
    // Built at run time from parts and \u escapes, so this file carries no personal string, no
    // secret shape and no Turkish letter of its own (the release scan reads it).
    const j = (sep, ...p) => p.join(sep);
    const turkishName = 'Çağrı';
    const homeCases = [
        [j('\\', 'C:', 'Users', turkishName, 'x'), '~\\x', 'a non-ASCII Windows user name'],
        [j('/', '', 'home', turkishName.toLowerCase(), 'x'), '~/x', 'a non-ASCII Linux user name'],
        [j('/', '', 'mnt', 'c', 'Users', 'alice', 'x'), '~/x', 'a WSL path'],
        [j('/', '', 'var', 'home', 'alice', 'x'), '~/x', 'a home below another folder (/var/home)'],
        ['\\\\' + j('\\', 'fileserver', 'share', 'alice', 'x'), '~\\x', 'a UNC path'],
        [j('/', 'C:', 'Users', 'John Smith', 'x'), '~/x', 'a name with a space'],
        ['~' + j('/', 'alice', 'x'), '~/x', '~name'],
        [j('\\\\', 'C:', 'Users', 'alice', 'x'), '~\\\\x', 'an escaped Windows path'],
        [j('/', '', 'home', 'alice', 'x'), '~/x', 'a plain Linux home'],
    ];
    for (const [input, want, label] of homeCases) check(`scrub: ${label}`, scrubPersonal(input) === want, `${JSON.stringify(input)} -> ${JSON.stringify(scrubPersonal(input))}`);
    check('scrub: prose with a backslash escape or a tilde path is left alone',
        scrubPersonal('regex \\\\d+\\\\s and ~/x and a~b/c') === 'regex \\\\d+\\\\s and ~/x and a~b/c');
    check('scrub: a name with a space ends at the folder, not the sentence',
        scrubPersonal(`see ${j('\\', 'C:', 'Users', 'alice')} and then /tmp`) === 'see ~ and then /tmp');

    console.log('\n— scrub: secrets —');
    const r36 = 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
    const secretCases = [
        ['gh' + 'o_' + r36, '<secret>', 'gho_ token'], ['gh' + 's_' + r36, '<secret>', 'ghs_ token'], ['gh' + 'u_' + r36, '<secret>', 'ghu_ token'],
        ['glp' + 'at-' + r36.slice(0, 20), '<secret>', 'glpat- token'], ['np' + 'm_' + r36, '<secret>', 'npm_ token'],
        ['h' + 'f_' + r36, '<secret>', 'hf_ token'], ['s' + 'k_live_' + r36.slice(0, 24), '<secret>', 'sk_live_ key'],
        [['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'abcdefghijklmnop'].join('.'), '<secret>', 'a JWT'],
        ['Authorization: Bear' + 'er ' + r36, 'Authorization: Bearer <secret>', 'a Bearer value'],
        ['pass' + 'word=hunter2Super', 'password=<secret>', 'password='], ['client_sec' + 'ret: "abc123xyz"', 'client_secret: "<secret>"', 'secret: "…"'],
        ['tok' + 'en=' + r36, 'token=<secret>', 'token='], ['API_K' + 'EY=abc123', 'API_KEY=<secret>', 'api_key='],
        ['https://hooks.sl' + 'ack.com/services/T000/B000/' + r36, '<secret>', 'a Slack webhook'],
        [`postgres://${'admin'}:${'pa55word'}@db.internal:5432/x`, 'postgres://<secret>@db.internal:5432/x', 'URL credentials'],
    ];
    for (const [input, want, label] of secretCases) check(`scrub: ${label}`, scrubPersonal(input) === want, `-> ${JSON.stringify(scrubPersonal(input))}`);
    check('scrub: ordinary counts stay', scrubPersonal('80 tool calls, 1200 tokens, token budget') === '80 tool calls, 1200 tokens, token budget');
    // The scrub-only set must not widen the publish scan: a WSL path, /var/home and a gho_ token are no findings there.
    const scanDir = path.join(tmp, 'scan');
    fs.mkdirSync(scanDir, { recursive: true });
    fs.writeFileSync(path.join(scanDir, 'a.txt'), [j('/', '', 'var', 'home', 'alice', 'x'), 'gh' + 'o_' + r36, 'pass' + 'word=hunter2Super'].join('\n'));
    check('the publish scan keeps its narrow patterns', scanRelease(scanDir, { files: ['a.txt'], terms: [] }).length === 0);

    console.log('\n— session_end object items —');
    const objItems = lib.sessionFeedbackItems([{ what: 'x', kind: 'praise', time: 'forged', via: 'forged', evidence: { file: 'a.gd', line: 3 }, cost: 12 }]);
    const objLine = lib.feedbackLine(objItems[0], { ai: 'a', via: 'session_end' });
    check('a non-string field is kept as JSON, never [object Object]', objLine.evidence === '{"file":"a.gd","line":3}' && objLine.cost === '12', JSON.stringify(objLine));
    check('forged fields are dropped and an unknown kind is friction, marked', objLine.via === 'session_end' && objLine.time !== 'forged'
        && objLine.kind === 'friction' && objItems[0].askedKind === 'praise' && !('askedKind' in objLine), JSON.stringify(objItems));

    console.log('\n— links —');
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    const victim = path.join(outside, 'victim.txt');
    fs.writeFileSync(victim, 'untouched\n');
    let canLink = true;
    try { fs.symlinkSync(victim, path.join(tmp, 'probe-link')); } catch { canLink = false; }
    if (canLink) {
        const linkedFile = kit(path.join(tmp, 'linked-file'));
        fs.symlinkSync(victim, feedbackFile(linkedFile));
        let e1 = '';
        try { lib.recordFeedback(linkedFile, { kind: 'bug', what: 'x' }); } catch (e) { e1 = e.message; }
        check('a symlinked feedback file is refused and its target untouched', /not a regular file/.test(e1) && fs.readFileSync(victim, 'utf8') === 'untouched\n', e1);
        fs.writeFileSync(victim, JSON.stringify({ what: 'planted', kind: 'bug' }) + '\n');
        check('a symlinked feedback file is not read', lib.readProjectFeedback(linkedFile).lines.length === 0);
        const linkedDir = kit(path.join(tmp, 'linked-dir'));
        fs.rmSync(path.join(linkedDir, 'docs', 'handoff'), { recursive: true });
        fs.symlinkSync(outside, path.join(linkedDir, 'docs', 'handoff'), 'dir');
        fs.writeFileSync(path.join(outside, 'plutos-feedback.jsonl'), JSON.stringify({ what: 'planted', kind: 'bug' }) + '\n');
        let e2 = '';
        try { lib.recordFeedback(linkedDir, { kind: 'bug', what: 'x' }); } catch (e) { e2 = e.message; }
        check('docs/handoff linked outside the project is refused for writing', /outside the project/.test(e2)
            && fs.readFileSync(path.join(outside, 'plutos-feedback.jsonl'), 'utf8').split('\n').filter(Boolean).length === 1, e2);
        check('and for reading', lib.readProjectFeedback(linkedDir).lines.length === 0);
    } else check('symlink checks skipped: this system cannot create links', true);

    console.log('\n— .gitattributes merge=union —');
    const attrs = kit(path.join(tmp, 'attrs'));
    fs.writeFileSync(path.join(attrs, '.gitattributes'), '* text=auto\n*.png binary');
    lib.recordFeedback(attrs, { kind: 'bug', what: 'one' });
    lib.recordFeedback(attrs, { kind: 'bug', what: 'two' });
    const ga = fs.readFileSync(path.join(attrs, '.gitattributes'), 'utf8');
    check('the first write adds the union rule once and keeps the other lines', ga.startsWith('* text=auto\n*.png binary\n')
        && (ga.match(/^docs\/handoff\/plutos-feedback\.jsonl merge=union$/gm) || []).length === 1, ga);
    const fresh = kit(path.join(tmp, 'attrs-new'));
    lib.recordFeedback(fresh, { kind: 'bug', what: 'one' });
    check('a missing .gitattributes is created with the rule', /^docs\/handoff\/plutos-feedback\.jsonl merge=union$/m.test(fs.readFileSync(path.join(fresh, '.gitattributes'), 'utf8')));
    const own = kit(path.join(tmp, 'attrs-own'));
    fs.writeFileSync(path.join(own, '.gitattributes'), 'docs/handoff/plutos-feedback.jsonl -merge\n');
    lib.recordFeedback(own, { kind: 'bug', what: 'one' });
    check('a line the project already has for the file is left as it is', fs.readFileSync(path.join(own, '.gitattributes'), 'utf8') === 'docs/handoff/plutos-feedback.jsonl -merge\n');
    // git itself merges two branches' appends without a conflict.
    let gitOk = true;
    try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { gitOk = false; }
    if (gitOk) {
        const g = kit(path.join(tmp, 'merge'));
        const git = (...a) => execFileSync('git', ['-C', g, '-c', 'user.name=t', '-c', 'user.email=t@t.invalid', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        git('init', '-q', '-b', 'main');
        lib.recordFeedback(g, { kind: 'bug', what: 'base' });
        git('add', '-A'); git('commit', '-qm', 'base');
        git('checkout', '-qb', 'other');
        lib.recordFeedback(g, { kind: 'bug', what: 'from other' });
        git('commit', '-qam', 'other');
        git('checkout', '-q', 'main');
        lib.recordFeedback(g, { kind: 'bug', what: 'from main' });
        git('commit', '-qam', 'main');
        let merged = true;
        try { git('merge', '-q', '--no-edit', 'other'); } catch { merged = false; }
        check('git merges two branches\' feedback lines without a conflict', merged && readLines(g).map(l => l.what).sort().join() === 'base,from main,from other');
    }

    console.log('\n— the 2 MB read window —');
    const big = kit(path.join(tmp, 'big'));
    const pad = JSON.stringify({ kind: 'bug', what: 'p'.repeat(900) });
    const lineCount = Math.ceil((lib.MAX_READ_BYTES + 200000) / (pad.length + 2));
    fs.writeFileSync(feedbackFile(big), Array.from({ length: lineCount }, () => pad).join('\r\n') + '\r\n'
        + JSON.stringify({ kind: 'bug', what: 'the newest line' }) + '\r\n');
    const bigRead = lib.readProjectFeedback(big);
    check('past the cap the newest line is read and truncated is set', bigRead.truncated && bigRead.malformed === 0
        && bigRead.lines.at(-1).entry.what === 'the newest line' && bigRead.lines.length < lineCount, `${bigRead.lines.length} ${bigRead.malformed}`);
    const bigOut = lib.collectFeedback([big], { outDir: path.join(tmp, 'big-out'), now });
    check('collect reports the truncated project', bigOut.truncated.join() === 'big' && bigOut.fresh === 2 && bigOut.fresh + bigOut.duplicate === bigRead.lines.length, JSON.stringify({ ...bigOut, file: 0 }));

    console.log('\n— the pending count is memoized —');
    const memoHome = path.join(tmp, 'memo-hub');
    const memo = kit(path.join(tmp, 'memo'));
    lib.recordFeedback(memo, { kind: 'bug', what: 'a' });
    const c0 = lib.pendingFeedbackCount.computed;
    const m1 = lib.pendingFeedbackCount([memo], { home: memoHome });
    const m2 = lib.pendingFeedbackCount([memo], { home: memoHome });
    check('an unchanged poll is answered from the cache', m1 === 1 && m2 === 1 && lib.pendingFeedbackCount.computed === c0 + 1);
    lib.recordFeedback(memo, { kind: 'bug', what: 'b' });
    check('a new line is counted on the next poll', lib.pendingFeedbackCount([memo], { home: memoHome }) === 2 && lib.pendingFeedbackCount.computed === c0 + 2);
    lib.collectFeedback([memo], { home: memoHome, outDir: path.join(tmp, 'memo-out'), now });
    check('a collect (the ledger changed) clears it', lib.pendingFeedbackCount([memo], { home: memoHome }) === 0);

    console.log('\n— collect only in PLUT_OS\'s own checkout —');
    // The public copy ships without the private feedback/ folder, so there collecting is off by design.
    const ownCheckout = fs.existsSync(path.join(repo, 'feedback'));
    check(ownCheckout ? 'this checkout may collect' : 'this public copy may not collect (no feedback/)',
        lib.feedbackCollectAvailable({ appRoot: repo, env: {} }) === ownCheckout);
    check('a packaged or bundled build may not', !lib.feedbackCollectAvailable({ appRoot: repo, env: { PLUTOS_PACKAGED: '1' } })
        && !lib.feedbackCollectAvailable({ appRoot: repo, env: { PLUTOS_BUNDLED_MCP: '1' } }));
    check('a folder that is not PLUT_OS\'s source may not', !lib.feedbackCollectAvailable({ appRoot: beta, env: {} }));
    // A public clone: PLUT_OS's source without the private feedback/ folder.
    const clone = path.join(tmp, 'clone');
    fs.mkdirSync(path.join(clone, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(clone, 'package.json'), JSON.stringify({ name: 'plut-os' }));
    fs.writeFileSync(path.join(clone, 'index.mjs'), '');
    fs.writeFileSync(path.join(clone, 'lib', 'drawers.mjs'), '');
    check('a public clone without feedback/ may not', !lib.feedbackCollectAvailable({ appRoot: clone, env: {} }));
    const elsewhere = execFileSync(process.execPath, [path.join(repo, 'cli.mjs'), 'feedback', 'collect'],
        { encoding: 'utf8', env: { ...process.env, PLUTOS_BUNDLED_MCP: '1' } });
    check('collect elsewhere prints one line and writes nothing', elsewhere.trim() === lib.COLLECT_ELSEWHERE, elsewhere);

    console.log('\n— GET /api/workspaces on a running dashboard —');
    const net = await import('node:net');
    const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    const dashBase = `http://127.0.0.1:${port}`;
    const dashHome = path.join(tmp, 'dash-hub'), userHome = path.join(tmp, 'user-home');
    fs.mkdirSync(path.join(userHome, 'AppData'), { recursive: true });
    const env = { ...process.env, PLUTOS_PORT: String(port), PLUTOS_HOME: dashHome, PLUTOS_NO_OS_OPEN: '1', HOME: userHome, USERPROFILE: userHome, APPDATA: path.join(userHome, 'AppData') };
    for (const k of ['PLUTOS_PROJECT_ROOT', 'CLAUDE_PROJECT_DIR', 'PLUTOS_MODE', 'PLUTOS_DEV', 'PLUTOS_PACKAGED', 'PLUTOS_BUNDLED_MCP']) delete env[k];
    const server = spawn(process.execPath, [path.join(repo, 'dashboard.mjs')], { cwd: tmp, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let serverErr = '';
    server.stderr.on('data', d => { serverErr = (serverErr + d).slice(-2000); });
    const closed = new Promise(resolve => server.once('close', resolve));
    try {
        let up = false;
        for (let i = 0; i < 100 && !up && server.exitCode === null; i++) {
            try { up = (await fetch(dashBase + '/api/app/mode')).ok; } catch { await new Promise(r => setTimeout(r, 150)); }
        }
        check('the dashboard started', up, serverErr);
        if (up) {
            const delta = kit(path.join(tmp, 'delta'));
            lib.recordFeedback(delta, [{ kind: 'bug', what: 'd1' }, { kind: 'missing', what: 'd2' }]);
            const add = await (await fetch(dashBase + '/api/workspaces/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: delta }) })).json();
            const expected = !ownCheckout ? 0 : lib.pendingFeedbackCount(lib.feedbackRoots({ appRoot: repo, registered: [delta] }), { home: dashHome });
            const ws1 = await (await fetch(dashBase + '/api/workspaces')).json();
            check('GET /api/workspaces carries feedbackPending for the registered projects', add.success && ws1.feedbackPending === expected && (expected >= 2 || !ownCheckout),
                `${JSON.stringify(add).slice(0, 200)} ${ws1.feedbackPending} vs ${expected}`);
            lib.recordFeedback(delta, { kind: 'worked', what: 'd3' });
            const ws2 = await (await fetch(dashBase + '/api/workspaces')).json();
            check('a new line shows on the next poll', ws2.feedbackPending === (ownCheckout ? expected + 1 : 0), String(ws2.feedbackPending));
        }
    } finally {
        server.kill();
        await closed;
    }
} finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

console.log(`\nFeedback: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
