// Council seats: each department is worked by an AI CLI started as its own process, logged in with the
// owner's subscription (no API keys). Ported from design-council (council.mjs askGpt/askGemini), made
// config-driven: council.config.json → departments.<id>.seat → seats.<id>.runner.
// A seat keeps ONE conversation per room (state.json) and may start its own subagents inside its turn.
//
// Blindness on disk: a seat never runs inside the room folder (log.jsonl, every department's files).
// Its working directory is its own seat folder, outside the room:
//   .plutos/council/seats/<room>/<dept>/
//     out/     the only place it is told to write; new or changed files are copied into the room afterwards
//     reads/   its department's role and skill files
//     shared/  copies of the files of messages it is allowed to see
// The CLIs' own sandboxes limit writes to that folder; they do not stop reads elsewhere on disk, but no
// path to sealed work is ever handed to a seat.
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { APP_ROOT, councilConfig, roomDir, roomsDir, readRoom, readLog, append, getState, setDeptState, visibleTo, currentRound, revealedRounds } from './council-room.mjs';

const ARGV_PROMPT_LIMIT = 24000;   // Windows caps a whole command line at 32,767 characters
export const DEPT_KINDS = ['research', 'design', 'critique'];

export function seatDir(projectRoot, slug, dept) {
    roomDir(projectRoot, slug);   // validates the room name
    if (!councilConfig().departments[dept]) throw new Error(`Unknown department "${dept}".`);
    return path.join(path.dirname(roomsDir(projectRoot)), 'seats', slug, dept);
}

function run(cmd, argv, { cwd, input, timeoutMs }) {
    return new Promise(resolve => {
        let child;
        // No shell: the prompt travels as one argv entry (agy --print=…) and must not be re-parsed by cmd.exe.
        try { child = spawn(cmd, argv, { cwd, windowsHide: true }); }
        catch (e) { resolve({ code: -1, out: '', err: e.message }); return; }
        let out = '', err = '';
        const timer = setTimeout(() => {
            if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
            else child.kill('SIGKILL');
        }, timeoutMs);
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { err += d; });
        child.stdin.on('error', e => { err += `\nstdin: ${e.message}`; });   // child exited before reading the prompt
        child.on('error', e => { err += e.message; });
        child.on('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
        if (input !== undefined) { child.stdin.write(input); child.stdin.end(); }
    });
}

// The two seats' command lines, apart from running them, so a test can check them without either CLI
// (cleanup plan P1-12: they are the contract with tools PLUT_OS does not control).
export function codexArgs(seat, { dir, session, outFile }) {
    const common = ['--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"', '-o', outFile, ...(seat.model ? ['-m', seat.model] : [])];
    return session ? ['exec', 'resume', session, ...common, '-'] : ['exec', '-C', dir, ...common, '-'];
}
export function agyArgs(seat, { session, print }) {
    return ['--model', seat.model, '--mode', 'accept-edits', '--output-format', 'json', '--print-timeout', `${Math.round(seat.timeoutMs / 1000)}s`,
        ...(session ? ['--conversation', session] : []), `--print=${print}`];
}

export const RUNNERS = {
    // OpenAI Codex CLI: `codex exec`, then `codex exec resume <session>`; the seat folder is its writable workspace.
    async codex(seat, { dir, prompt, session }) {
        const outFile = path.join(dir, '.codex-last.txt');
        if (fs.existsSync(outFile)) fs.rmSync(outFile);
        const argv = codexArgs(seat, { dir, session, outFile });
        const r = await run(seat.command, argv, { cwd: dir, input: prompt, timeoutMs: seat.timeoutMs });
        const text = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').trim() : '';
        return { text, session: session || (r.out + r.err).match(/session id:\s*([0-9a-f-]{36})/i)?.[1], ok: r.code === 0 && !!text, code: r.code, log: (r.err || r.out).slice(-4000) };
    },
    // Google Antigravity CLI: `agy --print`, then `--conversation <id>`; JSON output carries the conversation id.
    // A prompt too long for one command line goes into PROMPT.md in the seat folder instead.
    async agy(seat, { dir, prompt, session }) {
        let print = prompt;
        if (prompt.length > ARGV_PROMPT_LIMIT) {
            fs.writeFileSync(path.join(dir, 'PROMPT.md'), prompt);
            print = 'Your full instructions for this turn are in PROMPT.md in your working directory. Read that file and follow it exactly.';
        }
        const argv = agyArgs(seat, { session, print });
        const r = await run(seat.command, argv, { cwd: dir, timeoutMs: seat.timeoutMs + 30000 });
        let json = null; try { json = JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch { }
        return { text: (json?.response || '').trim(), session: session || json?.conversation_id, ok: !!json?.response, code: r.code, log: (r.err || r.out).slice(-4000) };
    },
};

// What the seat has not been given yet, filtered by the blind rule.
export function pendingFor(projectRoot, slug, dept) {
    const log = readLog(projectRoot, slug);
    const delivered = new Set(getState(projectRoot, slug)[dept]?.delivered || []);
    return visibleTo(log, dept).filter(m => !delivered.has(m.id) && !(m.kind === 'system' && m.meta?.thinking));
}

// Room files of visible messages are copied into the seat folder; the seat only ever gets those copies' paths.
function shareFiles(projectRoot, slug, dept, files) {
    const room = roomDir(projectRoot, slug), shared = path.join(seatDir(projectRoot, slug, dept), 'shared');
    return files.map(rel => {
        const src = path.join(room, rel), dest = path.join(shared, rel);
        if (!fs.existsSync(src)) return null;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        return dest;
    }).filter(Boolean);
}

// The language seats write in: council.config.json's replyLanguage when it names one, otherwise the
// owner's own, as they write it in the room (the product is English by default and
// Turkish is a choice, so the shipped config names no language).
const replyIn = cfg => cfg.replyLanguage || `the language ${cfg.humanName} (the owner) writes in, in this room`;

// A critic judges work it did not write, from the owner's own words: it gets the departments'
// revealed work and what the owner wrote, never the moderator's framing or instruction, which can
// carry the answer someone hopes for.
const CRITIQUE_RULES = (d, cfg, out) => `You are the ${d.label} department (role: ${d.role}) of a studio. You review work you did not write.
You get the departments' work and the owner's (${cfg.humanName}'s) own words, and nothing about which AI wrote what or what
answer anyone hopes for. Rules:
- Judge each piece on its own: keep, change or drop, each with the evidence for it, and say what you could not check.
- Do not aim to agree with anyone. A plain "this holds" is a valid verdict when the evidence supports it.
- Write in ${replyIn(cfg)}, unless told otherwise; at most 300 words.
- You may write files ONLY into: ${out}. Change no other file. End with a line "FILES:" listing what you wrote, or "FILES: none".`;

export function seatPrompt(projectRoot, slug, dept, instruction, reads) {
    const cfg = councilConfig(), room = readRoom(projectRoot, slug), d = cfg.departments[dept];
    const out = path.join(seatDir(projectRoot, slug, dept), 'out');
    const fresh = !getState(projectRoot, slug)[dept]?.session;
    const log = readLog(projectRoot, slug), round = currentRound(log), sealed = !revealedRounds(log).has(round);
    const critic = d.kind === 'critique';
    const pending = pendingFor(projectRoot, slug, dept).filter(m => !critic || m.from === 'human' || (m.dept && m.dept !== dept));
    const lines = pending.map(m => {
        const who = m.from === 'human' ? `${cfg.humanName} (the owner)` : m.dept ? `${m.dept} department` : m.from;
        const copies = m.files?.length ? shareFiles(projectRoot, slug, dept, m.files) : [];
        const files = copies.length ? `\n  [files: ${copies.join(', ')}]` : '';
        return `### #${m.id} ${who} · round ${m.round} · ${m.kind}\n${m.text}${files}`;
    });
    const rules = `You are the ${d.label} department (role: ${d.role}) of a studio. Several departments get the same job and work on it
INDEPENDENTLY: you cannot see the other departments' work until the moderator reveals it on the shared table. Then the
moderator (${cfg.moderator || 'claude'}) collects the common findings, the conflicts and the unique points, and the owner (${cfg.humanName}) decides.
Rules:
- Work from your own department's view, with concrete evidence; name every source (title + URL) you rely on.
- You may start your own subagents for parts of the job when that helps; report only the combined result.
- Write in ${replyIn(cfg)}, unless told otherwise. Keep to the length the moderator asks for (default: at most 400 words).
- You may write files ONLY into: ${out}. Change no other file. End with a line "FILES:" listing what you wrote, or "FILES: none".
- If the owner wrote something in the room, it outranks the moderator's instruction.`;
    const head = fresh ? `${critic ? CRITIQUE_RULES(d, cfg, out) : rules}\n\n# Job: ${room.title}\n\n# The room so far\n\n` : `# New in the room since your last turn\n\n`;
    const state = sealed ? `\n\n(Round ${round} is sealed: you are working blind.)` : '';
    const readList = reads.length ? `\n\n# Read these first (your department's role and skills)\n${reads.map(f => '- ' + f).join('\n')}` : '';
    const turn = critic ? 'Review the work above.' : instruction || 'Do your department\'s part of the job for this round.';
    return `${head}${lines.join('\n\n') || '(nothing new)'}${state}${readList}\n\n# Your turn\n\n${turn}`;
}

// A read names a file inside PLUT_OS. A domain pack resolves its own package reads: a "packages/…" read
// is refused here, loudly, so a council configuration that still names one fails instead of reading nothing.
function resolveRead(name) {
    if (/^packages[\\/]/.test(name)) throw new Error(`Pack reads are the pack's job: "${name}" is not inside PLUT_OS`);
    const file = path.resolve(APP_ROOT, name), rel = path.relative(APP_ROOT, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Read outside PLUT_OS refused: ${name}`);
    return fs.existsSync(file) ? { file, rel } : null;
}

// Reference reads are copied into the seat folder; the seat never gets a path into PLUT_OS itself.
function copyReads(projectRoot, slug, dept, files) {
    const reads = path.join(seatDir(projectRoot, slug, dept), 'reads');
    return [...new Set(files)].map(resolveRead).filter(Boolean).map(({ file, rel }) => {
        const dest = path.join(reads, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(file, dest);
        return dest;
    });
}

// Every file under a folder with its size and mtime, so new and changed files can be told apart.
function snapshot(dir, base = dir, acc = new Map()) {
    if (!fs.existsSync(dir)) return acc;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) snapshot(full, base, acc);
        else { const s = fs.statSync(full); acc.set(path.relative(base, full).replace(/\\/g, '/'), `${s.size}:${s.mtimeMs}`); }
    }
    return acc;
}

export async function askDepartment(projectRoot, slug, dept, { instruction = '', kind, reads = [], dryRun = false } = {}) {
    const cfg = councilConfig(), room = readRoom(projectRoot, slug);
    if (!room) throw new Error(`No room "${slug}".`);
    if (!room.departments.includes(dept)) throw new Error(`Department "${dept}" is not in this room (${room.departments.join(', ')}).`);
    const d = cfg.departments[dept], seat = cfg.seats[d.seat];
    if (!seat || !RUNNERS[seat.runner]) throw new Error(`Department "${dept}" has no runnable seat (seat "${d.seat}").`);
    if (kind && !DEPT_KINDS.includes(kind)) throw new Error(`A department posts ${DEPT_KINDS.join(', ')}; "${kind}" belongs to the moderator.`);
    // The author's seat cannot judge: a critic on a seat that also works another department in this room
    // would review its own vendor's work.
    if (d.kind === 'critique') {
        const authors = room.departments.filter(other => other !== dept && cfg.departments[other]?.seat === d.seat);
        if (authors.length) throw new Error(`The critique seat "${d.seat}" also works ${authors.join(', ')} in this room, and an author's seat cannot judge. Seat ${dept} on another AI (council.config.json).`);
    }
    const dir = seatDir(projectRoot, slug, dept), out = path.join(dir, 'out');
    fs.mkdirSync(out, { recursive: true });
    const st = getState(projectRoot, slug)[dept] || {};
    const readFiles = copyReads(projectRoot, slug, dept, [...(st.session ? [] : d.reads || []), ...reads]);
    const prompt = seatPrompt(projectRoot, slug, dept, instruction, readFiles);
    const pending = pendingFor(projectRoot, slug, dept).map(m => m.id);
    if (dryRun) return { dryRun: true, seat: d.seat, reads: readFiles, prompt };

    const before = snapshot(out);
    append(projectRoot, slug, { from: 'system', kind: 'system', text: `${d.label} is working…`, meta: { thinking: dept } });
    let r;
    try { r = await RUNNERS[seat.runner](seat, { dir, prompt, session: st.session }); }
    catch (e) { r = { ok: false, code: -1, log: e.message }; }
    if (!r.ok) {
        // The CLI's own output can quote this department's sealed work, so it stays in the seat folder, not the room.
        fs.writeFileSync(path.join(dir, 'last-error.log'), r.log || '');
        // A resumed conversation that failed may be gone for good: the next turn starts fresh with the full room.
        if (st.session) setDeptState(projectRoot, slug, dept, { session: null, delivered: [] });
        append(projectRoot, slug, { from: 'system', kind: 'system', text: `${d.label} did not answer (exit ${r.code ?? '?'}).${st.session ? ' Its session was reset; the next turn starts fresh.' : ''}`, meta: { failed: dept } });
        return { ok: false, log: r.log, errorFile: path.join(dir, 'last-error.log') };
    }
    const changed = [...snapshot(out)].filter(([rel, sig]) => before.get(rel) !== sig).map(([rel]) => rel);
    const files = changed.map(rel => {
        const dest = path.join(roomDir(projectRoot, slug), 'files', dept, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(out, rel), dest);
        return `files/${dept}/${rel}`;
    });
    const msg = append(projectRoot, slug, { from: dept, dept, kind: kind || d.kind, text: r.text, files, meta: { seat: d.seat } });
    setDeptState(projectRoot, slug, dept, { session: r.session, delivered: [...new Set([...(st.delivered || []), ...pending, msg.id])] });
    return { ok: true, message: msg };
}
