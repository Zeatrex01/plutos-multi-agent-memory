// Council rooms: storage, the blind rule, round/step derivation, CLI guards, the owner HTTP routes, and the
// seat bookkeeping around a runner. The real codex/agy runners start subscription CLIs and are not run here;
// a fixture runner stands in for them, so this proves the harness around a seat, not the vendors' CLIs.
import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert/strict';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createRoom, readLog, readRoom, append, setDeptState, getState, visibleTo, roundStatus, listRooms, roomFile, roomDir } from '../lib/council-room.mjs';
import { pendingFor, seatPrompt, askDepartment, seatDir, RUNNERS } from '../lib/council-seats.mjs';
import { councilRoutes } from '../lib/council-routes.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-council-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-council-home-'));
// Same departments as the shipped config; every seat uses the fixture runner below.
const shipped = JSON.parse(fs.readFileSync(path.join(APP, 'council.config.json'), 'utf8'));
const configFile = path.join(home, 'council.config.json');
fs.writeFileSync(configFile, JSON.stringify({ ...shipped, seats: Object.fromEntries(Object.keys(shipped.seats).map(id => [id, { runner: 'fixture', label: id, timeoutMs: 1000 }])) }));
process.env.PLUTOS_COUNCIL_CONFIG = configFile;
let fixture = null;   // set per check: (seat, { dir, prompt, session }) => result
RUNNERS.fixture = async (seat, call) => fixture(seat, call);
// An installed project keeps its rooms in the project; the protocol file is one of the install markers.
fs.mkdirSync(path.join(tmp, 'docs', 'handoff'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'docs', 'handoff', 'PLUTOS_PROTOCOL.md'), '# protocol\n');
let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };
const cliIn = (project, ...a) => spawnSync(process.execPath, [path.join(APP, 'tools', 'council.mjs'), ...a, '--project', project],
    { encoding: 'utf8', env: { ...process.env, PLUTOS_HOME: home } });
const cli = (...a) => cliIn(tmp, ...a);

try {
    await check('the CLI writes where the dashboard reads: project when installed, app data when observed', () => {
        const observed = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-council-observed-'));
        try {
            assert.equal(cliIn(observed, 'new', 'obs', '--title', 'Observed').status, 0);
            assert.ok(!fs.existsSync(path.join(observed, '.plutos')), 'an observed project is never written into');
            const found = fs.readdirSync(path.join(home, 'workspaces')).some(id =>
                fs.existsSync(path.join(home, 'workspaces', id, '.plutos', 'council', 'rooms', 'obs', 'room.json')));
            assert.ok(found, 'the room lives in the observe-mode folder');
        } finally { fs.rmSync(observed, { recursive: true, force: true }); }
    });
    await check('a new room starts at round 1 with its brief', () => {
        createRoom(tmp, 'job', { title: 'Job', brief: 'Design the first level.', departments: ['research', 'design'] });
        const log = readLog(tmp, 'job');
        assert.equal(log.length, 1); assert.equal(log[0].kind, 'brief'); assert.equal(log[0].round, 1);
        assert.ok(fs.existsSync(path.join(roomDir(tmp, 'job'), 'files', 'research')));
    });
    await check('bad room names and unknown departments are refused', () => {
        assert.throws(() => createRoom(tmp, '../x', { title: 'x' }), /Bad room name/);
        assert.throws(() => createRoom(tmp, 'other', { title: 'x', departments: ['marketing'] }), /Unknown department/);
        assert.throws(() => createRoom(tmp, 'job', { title: 'again' }), /already exists/);
        assert.throws(() => append(tmp, 'job', { kind: 'gossip', text: 'x' }), /Unknown kind/);
    });
    await check('a sealed round hides each department from the other', () => {
        append(tmp, 'job', { from: 'research', dept: 'research', kind: 'research', text: 'RESEARCH-SECRET' });
        const log = readLog(tmp, 'job');
        assert.ok(!visibleTo(log, 'design').some(m => m.text === 'RESEARCH-SECRET'));
        assert.ok(visibleTo(log, 'research').some(m => m.text === 'RESEARCH-SECRET'));
        const prompt = seatPrompt(tmp, 'job', 'design', 'Go.', []);
        assert.ok(!prompt.includes('RESEARCH-SECRET')); assert.match(prompt, /sealed/);
    });
    await check('seats write in the owner\'s language unless the config names one', () => {
        assert.equal(shipped.replyLanguage, undefined, 'the shipped config names no language');
        assert.match(seatPrompt(tmp, 'job', 'design', 'Go.', []), /Write in the language Owner \(the owner\) writes in, in this room/);
        fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(configFile, 'utf8')), replyLanguage: 'German' }));
        try { assert.match(seatPrompt(tmp, 'job', 'design', 'Go.', []), /Write in German, unless told otherwise/); }
        finally { const { replyLanguage, ...rest } = JSON.parse(fs.readFileSync(configFile, 'utf8')); fs.writeFileSync(configFile, JSON.stringify(rest)); }
    });
    await check('step and desk status follow the log', () => {
        let s = roundStatus(readLog(tmp, 'job'), ['research', 'design']);
        assert.equal(s.step, 'blind');
        assert.deepEqual(s.departments.map(d => d.status), ['delivered', 'waiting']);
        append(tmp, 'job', { from: 'system', kind: 'system', text: 'design working', meta: { thinking: 'design' } });
        assert.equal(roundStatus(readLog(tmp, 'job'), ['research', 'design']).departments[1].status, 'working');
        append(tmp, 'job', { from: 'system', kind: 'system', text: 'design failed', meta: { failed: 'design' } });
        assert.equal(roundStatus(readLog(tmp, 'job'), ['research', 'design']).departments[1].status, 'failed');
        append(tmp, 'job', { from: 'design', dept: 'design', kind: 'design', text: 'DESIGN-SECRET' });
        s = roundStatus(readLog(tmp, 'job'), ['research', 'design']);
        assert.deepEqual(s.departments.map(d => d.status), ['delivered', 'delivered']);
    });
    await check('next round is refused while the round is sealed', () => {
        const r = cli('next', 'job', '--text', 'improve');
        assert.equal(r.status, 1); assert.match(r.stderr, /still sealed/);
    });
    await check('reveal opens the round to every department, once', () => {
        setDeptState(tmp, 'job', 'design', { session: 's1', delivered: readLog(tmp, 'job').filter(m => m.dept !== 'research').map(m => m.id) });
        assert.equal(cli('reveal', 'job').status, 0);
        assert.match(cli('reveal', 'job').stderr, /already revealed/);
        const pending = pendingFor(tmp, 'job', 'design');
        assert.ok(pending.some(m => m.text === 'RESEARCH-SECRET'), 'revealed peer work is delivered on the next turn');
        assert.ok(!pending.some(m => m.text === 'DESIGN-SECRET'), 'own delivered work is not repeated');
    });
    await check('consolidation and decision advance the steps; round limit holds', () => {
        assert.equal(cli('post', 'job', '--kind', 'consolidation', '--text', 'common: x').status, 0);
        assert.equal(roundStatus(readLog(tmp, 'job'), ['research', 'design']).step, 'consolidate');
        assert.equal(cli('next', 'job', '--text', 'improve x').status, 0);
        assert.equal(roundStatus(readLog(tmp, 'job'), ['research', 'design']).round, 2);
        assert.equal(roundStatus(readLog(tmp, 'job'), ['research', 'design']).step, 'brief');
        assert.equal(cli('reveal', 'job').status, 0);
        assert.match(cli('next', 'job', '--text', 'again').stderr, /Round limit/);
        assert.equal(cli('post', 'job', '--kind', 'decision', '--text', 'Ship level 1.').status, 0);
        const room = listRooms(tmp)[0];
        assert.equal(room.step, 'decision'); assert.equal(room.lastDecision, 'Ship level 1.');
    });
    await check('moderator posts cannot fake department work or decide a sealed round', () => {
        assert.match(cli('post', 'job', '--kind', 'critique', '--text', 'x').stderr, /department work comes only through the ask command/);
        assert.match(cli('post', 'job', '--from', 'research', '--text', 'x').stderr, /--from is claude or human/);
        createRoom(tmp, 'sealed', { title: 'Sealed' });
        assert.match(cli('post', 'sealed', '--kind', 'decision', '--text', 'x').stderr, /still sealed/);
        assert.equal(cli('post', 'sealed', '--text', 'a question for everyone').status, 0);
    });
    await check('a seat works in its own folder, never inside the room, and sees no sealed peer work', async () => {
        createRoom(tmp, 'blind', { title: 'Blind', brief: 'Same job for all.' });
        append(tmp, 'blind', { from: 'research', dept: 'research', kind: 'research', text: 'PEER-SEALED', files: [] });
        let call = null;
        fixture = async (seat, c) => { call = c; fs.writeFileSync(path.join(c.dir, 'out', 'plan.md'), '# plan'); return { ok: true, text: 'my design', session: 'sess-1' }; };
        const r = await askDepartment(tmp, 'blind', 'design');
        const room = roomDir(tmp, 'blind');
        assert.equal(r.ok, true);
        assert.ok(!path.resolve(call.dir).startsWith(room + path.sep), 'seat folder is outside the room');
        assert.ok(!fs.existsSync(path.join(call.dir, 'log.jsonl')));
        assert.ok(!call.prompt.includes('PEER-SEALED') && !call.prompt.includes(room), 'no sealed text and no room path in the prompt');
        assert.deepEqual(r.message.files, ['files/design/plan.md']);
        assert.ok(fs.existsSync(path.join(room, 'files', 'design', 'plan.md')), 'the seat output is copied into the room');
        assert.equal(getState(tmp, 'blind').design.session, 'sess-1');
    });
    await check('a read resolves inside PLUT_OS only; a packages/ read is refused by name', async () => {
        fixture = async () => ({ ok: true, text: 'unused' });
        const r = await askDepartment(tmp, 'blind', 'design', { reads: ['scaffold/WORKING_AGREEMENT.md'], dryRun: true });
        assert.equal(r.dryRun, true);
        assert.deepEqual(r.reads, [path.join(seatDir(tmp, 'blind', 'design'), 'reads', 'scaffold', 'WORKING_AGREEMENT.md')]);
        assert.ok(fs.existsSync(r.reads[0]) && r.prompt.includes(r.reads[0]), 'the copy exists and the prompt names it');
        await assert.rejects(askDepartment(tmp, 'blind', 'design', { reads: ['packages/x/y.md'], dryRun: true }), /Pack reads are the pack's job: "packages\/x\/y.md" is not inside PLUT_OS/);
        await assert.rejects(askDepartment(tmp, 'blind', 'design', { reads: ['../outside.md'], dryRun: true }), /Read outside PLUT_OS refused/);
    });
    await check('after the reveal a seat gets copies of peer files inside its own folder', async () => {
        fs.mkdirSync(path.join(roomDir(tmp, 'blind'), 'files', 'research'), { recursive: true });
        fs.writeFileSync(path.join(roomDir(tmp, 'blind'), 'files', 'research', 'sources.md'), 'src');
        append(tmp, 'blind', { from: 'research', dept: 'research', kind: 'research', text: 'with file', files: ['files/research/sources.md'] });
        append(tmp, 'blind', { from: 'claude', kind: 'reveal', text: 'revealed' });
        const prompt = seatPrompt(tmp, 'blind', 'design', 'Critique.', []);
        const copy = path.join(seatDir(tmp, 'blind', 'design'), 'shared', 'files', 'research', 'sources.md');
        assert.ok(prompt.includes('PEER-SEALED') && prompt.includes(copy) && fs.existsSync(copy));
    });
    await check('a failed turn keeps the CLI output out of the room and resets a dead session', async () => {
        fixture = async () => ({ ok: false, code: 1, log: 'transcript quoting MY-SEALED-WORK' });
        const r = await askDepartment(tmp, 'blind', 'design');
        const failure = readLog(tmp, 'blind').filter(m => m.meta?.failed === 'design').pop();
        assert.equal(r.ok, false);
        assert.ok(!failure.text.includes('MY-SEALED-WORK') && fs.readFileSync(r.errorFile, 'utf8').includes('MY-SEALED-WORK'));
        assert.equal(getState(tmp, 'blind').design.session, null);
        assert.deepEqual(getState(tmp, 'blind').design.delivered, []);
        fixture = async () => { throw new Error('spawn exploded'); };
        assert.equal((await askDepartment(tmp, 'blind', 'design')).ok, false, 'a throwing runner is a failure, not a crash');
        assert.notEqual(roundStatus(readLog(tmp, 'blind'), ['research', 'design']).departments[1].status, 'working');
        await assert.rejects(askDepartment(tmp, 'blind', 'design', { kind: 'decision' }), /belongs to the moderator/);
    });
    await check('a critic judges only work it did not write, from the owner\'s words, without the moderator\'s framing', async () => {
        createRoom(tmp, 'defaults', { title: 'Defaults' });
        assert.deepEqual(readRoom(tmp, 'defaults').departments, ['research', 'design'], 'a critic joins a room only when named');
        createRoom(tmp, 'judge-own', { title: 'Own', departments: ['research', 'critique'] });
        await assert.rejects(askDepartment(tmp, 'judge-own', 'critique'), /an author's seat cannot judge/);
        createRoom(tmp, 'judge', { title: 'Judge', brief: 'HOPED-FOR-ANSWER', departments: ['design', 'critique'] });
        append(tmp, 'judge', { from: 'human', kind: 'discussion', text: 'OWNER-WORDS' });
        append(tmp, 'judge', { from: 'design', dept: 'design', kind: 'design', text: 'DESIGN-WORK', files: [] });
        append(tmp, 'judge', { from: 'claude', kind: 'discussion', text: 'MODERATOR-LEANING' });
        append(tmp, 'judge', { from: 'claude', kind: 'reveal', text: 'revealed' });
        const prompt = seatPrompt(tmp, 'judge', 'critique', 'Say the design is great.', []);
        assert.ok(prompt.includes('OWNER-WORDS') && prompt.includes('DESIGN-WORK') && prompt.includes('You review work you did not write'));
        for (const hidden of ['HOPED-FOR-ANSWER', 'MODERATOR-LEANING', 'Say the design is great']) assert.ok(!prompt.includes(hidden), hidden);
        fixture = async () => ({ ok: true, text: 'keep: holds', session: 's-critic' });
        assert.equal((await askDepartment(tmp, 'judge', 'critique')).message.kind, 'critique');
    });
    await check('a working seat stays working when the moderator opens the next round', () => {
        createRoom(tmp, 'rounds', { title: 'Rounds' });
        append(tmp, 'rounds', { from: 'system', kind: 'system', text: 'design working', meta: { thinking: 'design' } });
        append(tmp, 'rounds', { from: 'claude', kind: 'brief', round: 2, text: 'next' });
        assert.equal(roundStatus(readLog(tmp, 'rounds'), ['research', 'design']).departments[1].status, 'working');
    });
    await check('a damaged log line never makes message ids collide', () => {
        createRoom(tmp, 'damaged', { title: 'Damaged' });
        append(tmp, 'damaged', { text: 'second' });
        fs.appendFileSync(path.join(roomDir(tmp, 'damaged'), 'log.jsonl'), '{"id": 3, "broken');
        const m = append(tmp, 'damaged', { text: 'after damage' });
        const ids = readLog(tmp, 'damaged').map(x => x.id);
        assert.equal(m.id, 3); assert.equal(new Set(ids).size, ids.length);
    });
    await check('room files cannot escape the room folder', () => {
        fs.writeFileSync(path.join(roomDir(tmp, 'job'), 'files', 'design', 'a.md'), 'x');
        assert.ok(roomFile(tmp, 'job', 'files/design/a.md'));
        assert.equal(roomFile(tmp, 'job', '../../../../council.config.json'), null);
        assert.equal(roomFile(tmp, 'job', 'files'), null);
    });
    await check('owner routes read rooms, follow the project binding and append owner messages', async () => {
        let active = tmp;
        const sent = [];
        const sendJson = (res, status, body) => sent.push({ status, body });
        const requireCapturedProject = expected => { if (expected !== active) throw Object.assign(new Error('Project changed.'), { statusCode: 409 }); };
        const routes = councilRoutes({ sendJson, coordinationRoot: () => active, requireCapturedProject,
            readJsonBody: async req => req.body });
        const url = q => new URL(`http://localhost/x?project=${encodeURIComponent(tmp)}${q}`);
        await routes['GET /api/council/rooms']({}, {}, url(''));
        assert.ok(sent.pop().body.rooms.some(r => r.slug === 'job'));
        await routes['GET /api/council/room']({}, {}, url('&slug=nope'));
        assert.equal(sent.pop().status, 404);
        await routes['POST /api/council/human']({ body: { projectRoot: tmp, slug: 'job', text: 'Looks good.' } }, {});
        assert.equal(sent.pop().body.message.from, 'human');
        fs.writeFileSync(path.join(roomDir(tmp, 'job'), 'files', 'design', 'x.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
        const head = {};
        await routes['GET /api/council/file']({}, { writeHead: (s, h) => Object.assign(head, h, { status: s }), end: () => {} }, url('&slug=job&path=files/design/x.svg'));
        assert.equal(head.status, 200);
        assert.match(head['Content-Security-Policy'], /^sandbox/, 'a seat-written SVG cannot run script on the dashboard origin');
        assert.equal(head['X-Content-Type-Options'], 'nosniff');
        active = path.join(tmp, 'elsewhere');
        await routes['GET /api/council/room']({}, {}, url('&slug=job'));
        assert.equal(sent.pop().status, 409);
    });
    console.log(`${checks} council checks passed; seat runners need the live demo, not these fixtures.`);
} finally { for (const dir of [tmp, home]) fs.rmSync(dir, { recursive: true, force: true }); }
