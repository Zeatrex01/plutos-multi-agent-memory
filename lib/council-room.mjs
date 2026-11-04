// Council rooms: one shared job, worked on blind by every department, then revealed on one table.
// Ported from design-council (lib/room.mjs). A room lives in the project's coordination root:
//   .plutos/council/rooms/<slug>/
//     room.json    title, brief, departments, created
//     log.jsonl    one message per line: { id, t, from, kind, text, files[], round, dept, meta }
//     state.json   per department: CLI session id + ids already delivered to that seat
//     files/<dept>/  the only folder a department's seat may write into
// Round, reveal and step state are derived from the log alone, so there is no second source of truth.
import fs from 'fs';
import path from 'path';
import { acquireLock } from './atomic.mjs';
import { APP_ROOT } from './approot.mjs';   // repo root in dev, the exe's folder when packaged

export { APP_ROOT };
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const KINDS = ['brief', 'research', 'design', 'critique', 'discussion', 'consolidation', 'decision', 'reveal', 'system'];

// PLUTOS_COUNCIL_CONFIG points at another config file (tests use it to register a fixture seat).
export function councilConfig() {
    return JSON.parse(fs.readFileSync(process.env.PLUTOS_COUNCIL_CONFIG || path.join(APP_ROOT, 'council.config.json'), 'utf8'));
}

export const roomsDir = projectRoot => path.join(projectRoot, '.plutos', 'council', 'rooms');
// The moderator's id in the log (`from`): the config's `moderator`, "claude" by default and in
// rooms written before the field existed, which the Council tab still shows as Moderator.
export const moderatorId = () => { try { return councilConfig().moderator || 'claude'; } catch (e) { return 'claude'; } };

export function roomDir(projectRoot, slug) {
    if (!projectRoot) throw new Error('A project is required for council rooms.');
    if (!SLUG.test(slug || '')) throw new Error(`Bad room name "${slug}" (a-z, 0-9, -).`);
    return path.join(roomsDir(projectRoot), slug);
}
export const roomExists = (projectRoot, slug) => fs.existsSync(path.join(roomDir(projectRoot, slug), 'room.json'));

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }

export function createRoom(projectRoot, slug, { title, brief = '', departments }) {
    const dir = roomDir(projectRoot, slug);
    if (roomExists(projectRoot, slug)) throw new Error(`Room "${slug}" already exists.`);
    const cfg = councilConfig(), known = Object.keys(cfg.departments);
    // A critic reviews revealed work, so it joins a room only when named; the blind round is the others'.
    const depts = departments?.length ? departments : known.filter(d => cfg.departments[d].kind !== 'critique');
    const unknown = depts.filter(d => !known.includes(d));
    if (unknown.length) throw new Error(`Unknown department(s): ${unknown.join(', ')} (known: ${known.join(', ')}).`);
    for (const d of depts) fs.mkdirSync(path.join(dir, 'files', d), { recursive: true });
    fs.writeFileSync(path.join(dir, 'room.json'), JSON.stringify({ title: title || slug, brief, departments: depts, created: new Date().toISOString() }, null, 1));
    fs.writeFileSync(path.join(dir, 'log.jsonl'), '');
    fs.writeFileSync(path.join(dir, 'state.json'), '{}');
    append(projectRoot, slug, { from: moderatorId(), kind: 'brief', round: 1, text: brief || title || slug });
    return dir;
}

export const readRoom = (projectRoot, slug) => readJson(path.join(roomDir(projectRoot, slug), 'room.json'), null);

export function readLog(projectRoot, slug) {
    const file = path.join(roomDir(projectRoot, slug), 'log.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

export function append(projectRoot, slug, msg) {
    if (msg.kind && !KINDS.includes(msg.kind)) throw new Error(`Unknown kind "${msg.kind}" (${KINDS.join(', ')}).`);
    const file = path.join(roomDir(projectRoot, slug), 'log.jsonl');
    const unlock = acquireLock(file);
    try {
        const log = readLog(projectRoot, slug);
        const round = msg.round || currentRound(log);
        // max+1, not length+1: a damaged line is skipped by readLog and must not make ids collide.
        const id = log.reduce((max, m) => Math.max(max, +m.id || 0), 0) + 1;
        const full = { id, t: new Date().toISOString(), from: moderatorId(), kind: 'discussion', text: '', files: [], dept: null, meta: {}, ...msg, round };
        const raw = fs.readFileSync(file, 'utf8');
        fs.appendFileSync(file, (raw && !raw.endsWith('\n') ? '\n' : '') + JSON.stringify(full) + '\n');
        return full;
    } finally { unlock(); }
}

export function getState(projectRoot, slug) { return readJson(path.join(roomDir(projectRoot, slug), 'state.json'), {}); }
export function setDeptState(projectRoot, slug, dept, patch) {
    const file = path.join(roomDir(projectRoot, slug), 'state.json');
    const unlock = acquireLock(file);
    try {
        const state = getState(projectRoot, slug);
        state[dept] = { ...(state[dept] || {}), ...patch };
        fs.writeFileSync(file, JSON.stringify(state, null, 1));
        return state;
    } finally { unlock(); }
}

// ---------------------------------------------------------------- derived state
export const currentRound = log => log.reduce((max, m) => Math.max(max, m.round || 1), 1);
export const revealedRounds = log => new Set(log.filter(m => m.kind === 'reveal').map(m => m.round));

// Blind work: a department never sees another department's work from a round that is not revealed yet.
export function visibleTo(log, dept) {
    const revealed = revealedRounds(log);
    return log.filter(m => !m.dept || m.dept === dept || revealed.has(m.round));
}

// Where the current round is in the flow: brief → blind → reveal → consolidate → decision.
export function roundStatus(log, departments) {
    const round = currentRound(log);
    const inRound = log.filter(m => m.round === round);
    const delivered = new Set(inRound.filter(m => m.dept).map(m => m.dept));
    // A seat can still be working on an earlier round's turn, so "working" is read across the whole log.
    const working = new Set();
    for (const m of log) {
        if (m.kind === 'system' && m.meta?.thinking) working.add(m.meta.thinking);
        if (m.dept || m.meta?.failed) working.delete(m.dept || m.meta.failed);
    }
    const has = kind => inRound.some(m => m.kind === kind);
    const step = has('decision') ? 'decision' : has('consolidation') ? 'consolidate' : has('reveal') ? 'reveal' : delivered.size ? 'blind' : 'brief';
    return {
        round, step, revealed: has('reveal'),
        departments: departments.map(d => {
            const failed = inRound.filter(m => m.meta?.failed === d).pop();
            const last = inRound.filter(m => m.dept === d).pop();
            const status = working.has(d) ? 'working' : last ? 'delivered' : failed ? 'failed' : 'waiting';
            return { id: d, status, lastId: last?.id || null };
        }),
    };
}

export function listRooms(projectRoot) {
    const dir = roomsDir(projectRoot);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(slug => SLUG.test(slug) && roomExists(projectRoot, slug)).map(slug => {
        const room = readRoom(projectRoot, slug), log = readLog(projectRoot, slug);
        if (!room?.departments) return null;   // one unreadable room.json must not hide every other room
        const decision = log.filter(m => m.kind === 'decision').pop();
        return { slug, title: room.title, created: room.created, ...roundStatus(log, room.departments),
            lastDecision: decision ? decision.text.slice(0, 280) : null, messages: log.length };
    }).filter(Boolean).sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

// A room file, refused outside the room folder — checked on real paths, so a link inside the room cannot point out.
export function roomFile(projectRoot, slug, rel) {
    const base = roomDir(projectRoot, slug), full = path.resolve(base, rel || '');
    if (!full.startsWith(base + path.sep) || !fs.existsSync(full)) return null;
    const realBase = fs.realpathSync(base), real = fs.realpathSync(full);
    if (!real.startsWith(realBase + path.sep) || fs.statSync(real).isDirectory()) return null;
    return real;
}
