// Approval tickets — the channel an agent uses to stop mid-task and ask the owner.
//
// Why it exists: every AI tool has its own "ask the user" prompt, and every one of them asks
// in its own window. When three agents work the same project that is three places to watch,
// and the one you are not looking at is the one that is blocked. This puts the question where
// the work already is — one queue in the project, one dashboard, one answer.
//
// What it is NOT: a message bus. A ticket is a single question with a single answer, and it
// dies once answered or once its TTL passes. Anything that wants a conversation belongs on
// the board, which is durable and already parsed.
//
// A ticket may carry OPTIONS, and that does not weaken the rule above — it is still one
// question with one answer, the answer just names which route was picked. Without them, an
// agent offering three ways to split a task had to write them into the question text and hope
// the free-text note came back parseable; the owner was choosing from prose with a yes/no
// button. Options are opt-in: every existing caller passes none and behaves exactly as before,
// and `decision` and `note` keep their meaning either way.
//
// One file per ticket, deliberately. Tickets are created concurrently by unrelated agents and
// polled hard (every few hundred ms while an agent waits); a single shared JSON would put
// every reader and writer through one mutex for no gain. Per-file means creation never
// contends, and only the answer — where two dashboard clicks really can race — takes a lock.
//
// Two rules sit on top (2026-10-21):
//
//  - Tiers. Where an approval may come from is decided here from the action, never from the
//    ticket file or the caller. T0 (a plain question) may be approved from a paired phone.
//    T1 (starting a local AI turn) and T2 (anything that changes what runs or who may act)
//    are answered at the PLUTOS computer only. Since 2026-11-04 no action kind exists: every
//    new ticket is a plain question (T0), and `cleanAction` refuses any action. The tiers and
//    the seal fields stay as they are so tickets created before then (the `profile_full`
//    casting, T2) still verify, list and settle. A rejection is allowed from anywhere, always:
//    saying no never needs more trust than the person already has.
//  - Seals. A ticket lives in the project, where every agent can write. Its question, context
//    and action are sealed at creation and its answer is sealed when recorded, with an HMAC
//    key kept in the PLUTOS data folder, outside the project. An approval whose seal does not
//    verify reads as 'tampered' and runs nothing. This does not stop a program that reads the
//    key on purpose; it stops the cheap attack, an agent (or text it read) flipping
//    "status": "pending" to "approved" in a JSON file.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { updateFileAtomically, acquireLock } from './atomic.mjs';
import { currentPlutosHome } from './home-dir.mjs';
import { pathToFileURL, fileURLToPath } from 'url';
import { openBrowser } from './open-browser.mjs';
import { keepOutOfGit } from './context-automation.mjs';

const DEFAULT_TTL_MIN = 30;
const MAX_TTL_MIN = 24 * 60;
const MAX_PENDING = 20;              // an agent stuck in a retry loop must not fill the disk
const SWEEP_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_FIELD = 2000;              // the banner has to stay readable; so does the log
const MAX_OPTIONS = 5;               // past this it is a menu, and a menu belongs on the board
const MAX_OPTION_FIELD = 300;        // each has to fit on a phone screen as a tappable button
const MAX_IMAGES = 4;                // an A/B design pick shows two, a pick among four at most
// Images a question may show: renders an AI made for an A/B design pick (owner, 2026-11-05), only
// from this folder of the project, so a ticket can never make the dashboard serve another file.
export const DESIGN_PICKS_DIR = 'docs/ai/design-picks';
const IMAGE_RE = /\.(png|jpe?g|webp)$/i;
const MAX_IMAGE_BYTES = 8 * 1048576;  // the same cap the board's evidence route keeps for binaries

// The id reaches this module from an HTTP query string and from MCP tool arguments, and it is
// used to build a path. Anything but the shape we mint ourselves is refused before it touches
// the filesystem.
const ID_RE = /^ask-[0-9a-z]+-[0-9a-z]{6}$/;

// → 'T0' | 'T1' | 'T2'. Recomputed from the action on every answer, so editing a stored
// tier changes nothing. Today only tickets from before 2026-11-04 carry an action (T2); a
// new ticket never does.
export function approvalTier(action) {
    if (!action) return 'T0';
    return 'T2';
}

// Whether an approval (not a rejection) of this tier may be given from where the answer came.
// 'local' is the PLUTOS computer itself; anything else is remote. T1 joins T0 once a phone
// step-up exists; today it stays at the computer, the owner's standing rule.
export function tierAllows(tier, via) {
    return via === 'local' || tier === 'T0';
}

const SEAL_KEY_FILE = 'approval-seal.key';
const sealKeys = new Map();
function readSealKey() {
    const home = currentPlutosHome();
    if (sealKeys.has(home)) return sealKeys.get(home);
    const file = path.join(home, SEAL_KEY_FILE);
    let sealKey;
    try {
        sealKey = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
    } catch (e) {
        fs.mkdirSync(home, { recursive: true });
        try {
            fs.writeFileSync(file, crypto.randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
        } catch (error) { if (error.code !== 'EEXIST') throw error; }
        sealKey = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
    }
    if (sealKey.length !== 32) throw new Error(`Approval seal key is damaged: ${file}`);
    sealKeys.set(home, sealKey);
    return sealKey;
}
const seal = (parts) => crypto.createHmac('sha256', readSealKey()).update(JSON.stringify(parts)).digest('hex');
const sameSeal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length
    && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
// Exported for the tests only: they mint tickets in the shape of before 2026-11-04 (with an
// action) to prove those still verify, since createApproval no longer accepts an action.
// Images join the seal only when a ticket has them, so tickets from before they existed still verify.
export const askSeal = t => seal(['ask', t.id, t.agent, t.question, t.context, t.options, t.action, t.createdAt, t.expiresAt, ...(t.images ? [t.images] : [])]);
const answerSeal = t => seal(['answer', t.id, t.status, t.option, t.note, t.answeredAt, t.answeredVia, t.askSeal]);
// The recorded outcome is sealed too: a hand-written "succeeded" must not read as already done.
const resultSeal = t => seal(['result', t.id, t.actionResult?.status, t.actionResult?.detail, t.actionResult?.completedAt, t.answerSeal]);
function sealsHold(ticket) {
    if (!sameSeal(ticket.askSeal, askSeal(ticket))) return false;
    return ticket.status === 'pending' || sameSeal(ticket.answerSeal, answerSeal(ticket));
}

export function approvalsDir(projectRoot) {
    return path.join(projectRoot, '.plutos', 'approvals');
}

function ticketPath(projectRoot, id) {
    if (!ID_RE.test(String(id || ''))) throw new Error(`Invalid ticket id: ${id}`);
    return path.join(approvalsDir(projectRoot), `${id}.json`);
}

const clip = (v) => {
    const s = String(v ?? '').trim();
    return s.length > MAX_FIELD ? `${s.slice(0, MAX_FIELD)}…` : s;
};

function mintId() {
    return `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`;
}

// A pending ticket past its deadline is reported as expired but NOT rewritten: an agent polls
// this path hundreds of times, and a status that decays on read costs nothing while a status
// that decays on write would turn every poll into a disk write.
function withExpiry(ticket, now = Date.now()) {
    if (!sealsHold(ticket)) return { ...ticket, status: 'tampered' };
    if ((ticket.status === 'pending' || (ticket.status === 'approved' && ticket.action
        && ticket.actionResult?.status !== 'succeeded')) && now > ticket.expiresAt) {
        return { ...ticket, status: 'expired' };
    }
    return ticket;
}

function readRaw(projectRoot, id) {
    try {
        return JSON.parse(fs.readFileSync(ticketPath(projectRoot, id), 'utf8'));
    } catch (e) {
        return null;
    }
}

// → ticket | null. Expiry applied; the caller never has to check the clock itself.
export function readApproval(projectRoot, id) {
    const raw = readRaw(projectRoot, id);
    return raw ? withExpiry(raw) : null;
}

// Answered and expired tickets are the only ones swept. A pending one is never deleted out
// from under a waiting agent, however old it looks — expiry already tells that agent to stop.
function sweep(projectRoot, now = Date.now()) {
    const dir = approvalsDir(projectRoot);
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { return; }
    for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const id = name.slice(0, -5);
        if (!ID_RE.test(id)) continue;
        const raw = readRaw(projectRoot, id);
        if (!raw) continue;
        const settledAt = raw.answeredAt || (raw.status === 'pending' ? raw.expiresAt : raw.createdAt);
        if (raw.status !== 'pending' || now > raw.expiresAt) {
            if (now - settledAt > SWEEP_AFTER_MS) {
                try { fs.rmSync(path.join(dir, name), { force: true }); } catch (e) { /* next sweep */ }
            }
        }
    }
}

// → tickets, newest first. Sweeps on the way through, which is why nothing else has to.
export function listApprovals(projectRoot, { includeAnswered = false } = {}) {
    sweep(projectRoot);
    const dir = approvalsDir(projectRoot);
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { return []; }
    const out = [];
    for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const id = name.slice(0, -5);
        if (!ID_RE.test(id)) continue;
        const t = readApproval(projectRoot, id);
        if (!t) continue;
        if (!includeAnswered && t.status !== 'pending') continue;
        out.push(t);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
}

// Creates a pending ticket. Throws on invalid input or when the pending queue is full — the
// caller decides how to report it (MCP isError vs HTTP 400), same contract as writeBoardEntry.
// Duplicates are refused rather than de-duplicated: two identical buttons is a bug in the
// asking agent, and silently collapsing them would answer a different question than the one
// the owner was shown.
function cleanOptions(options) {
    if (options == null) return null;
    if (!Array.isArray(options)) throw new Error('options must be an array of strings.');
    const out = options.map((o, i) => {
        if (typeof o !== 'string') throw new Error(`options[${i}] must be a string.`);
        const text = o.replace(/\s+/g, ' ').trim().slice(0, MAX_OPTION_FIELD);
        if (!text) throw new Error(`options[${i}] is empty.`);
        return text;
    });
    if (!out.length) return null;
    if (out.length > MAX_OPTIONS) throw new Error(`At most ${MAX_OPTIONS} options — past that, put the choice on the board.`);
    if (new Set(out).size !== out.length) throw new Error('options must be distinct.');
    return out;
}

// One image path, project-relative, checked the same way when the ticket is made and when the
// dashboard serves it: inside DESIGN_PICKS_DIR, an image extension, no '..', a real file whose real
// path is still inside DESIGN_PICKS_DIR (a link to anywhere else is refused). Returns the absolute path, or throws.
export function designPickImagePath(projectRoot, rel) {
    const clean = normalImagePath(rel);
    const parts = clean.split('/');
    let real, project;
    try { real = fs.realpathSync(path.join(projectRoot, ...parts)); project = fs.realpathSync(projectRoot); } catch { throw new Error(`No image at ${clean}.`); }
    // The real path, not the written one, must still sit under the project's own docs/ai/design-picks/:
    // a linked file or a linked folder (docs, ai or design-picks itself) that points elsewhere is refused.
    const inside = path.relative(project, real).split(path.sep);
    const prefix = DESIGN_PICKS_DIR.split('/');
    if (inside.length <= prefix.length || prefix.some((seg, k) => inside[k] !== seg) || !IMAGE_RE.test(real)) throw new Error(`No image at ${clean}.`);
    const st = fs.statSync(real);
    if (!st.isFile()) throw new Error(`No image at ${clean}.`);
    if (st.size > MAX_IMAGE_BYTES) throw new Error(`${clean} is over ${MAX_IMAGE_BYTES / 1048576} MB.`);
    return real;
}

// The written form, checked before the disk is touched: project-relative, forward slashes, normalised.
function normalImagePath(rel) {
    if (typeof rel !== 'string' || !rel.trim()) throw new Error('An image path must be a non-empty string.');
    const clean = path.posix.normalize(rel.trim().replace(/\\/g, '/'));
    if (clean.split('/').includes('..') || path.posix.isAbsolute(clean) || /^[a-z]:/i.test(clean) || !clean.startsWith(`${DESIGN_PICKS_DIR}/`) || !IMAGE_RE.test(clean)) {
        throw new Error(`Images must be .png, .jpg or .webp files under ${DESIGN_PICKS_DIR}/ (got ${JSON.stringify(rel).slice(0, 120)}).`);
    }
    return clean;
}

function cleanImages(projectRoot, images) {
    if (images == null) return null;
    if (!Array.isArray(images)) throw new Error('images must be an array of paths.');
    if (images.length > MAX_IMAGES) throw new Error(`At most ${MAX_IMAGES} images.`);
    const out = images.map(rel => { designPickImagePath(projectRoot, rel); return normalImagePath(rel); });
    if (new Set(out).size !== out.length) throw new Error('images must be distinct.');
    return out.length ? out : null;
}

// No action kind exists since the full profile was cut (2026-11-04): a ticket is a question,
// and an action is refused here before it is sealed. A kind added later is cleaned here, so the
// ticket binds exactly what the owner read.
function cleanAction(projectRoot, action) {
    if (action == null) return null;
    throw new Error('Invalid approval action.');
}

export function createApproval(projectRoot, { agent, question, context, ttlMinutes, options, action, images } = {}) {
    const cleanAgent = clip(agent);
    const cleanQuestion = clip(question);
    if (!cleanAgent) throw new Error('agent is required — the owner has to know who is asking.');
    if (!cleanQuestion) throw new Error('question is required.');
    const cleanOpts = cleanOptions(options);
    const cleanImgs = cleanImages(projectRoot, images);
    const cleanScopedAction = cleanAction(projectRoot, action);
    if (cleanScopedAction && cleanOpts) throw new Error('A scoped approval cannot offer alternative actions.');

    const ttl = Math.min(MAX_TTL_MIN, Math.max(1, Number(ttlMinutes) || DEFAULT_TTL_MIN));
    // The pending count and the new ticket's write share one short lock, so concurrent askers
    // cannot each see 19 and leave 25 behind. Answering takes a different lock (the ticket's own).
    fs.mkdirSync(approvalsDir(projectRoot), { recursive: true });
    const unlock = acquireLock(path.join(approvalsDir(projectRoot), 'pending'));
    try {
    const pending = listApprovals(projectRoot).filter(t => t.status === 'pending');
    if (pending.length >= MAX_PENDING) {
        throw new Error(`${MAX_PENDING} questions are already waiting for an answer. Answer or let those expire before asking another.`);
    }
    const now = Date.now();
    const ticket = {
        id: mintId(),
        agent: cleanAgent,
        question: cleanQuestion,
        context: clip(context) || null,
        options: cleanOpts,
        action: cleanScopedAction,
        status: 'pending',
        note: null,
        option: null,
        tier: approvalTier(cleanScopedAction),
        createdAt: now,
        expiresAt: now + ttl * 60_000,
        answeredAt: null,
        answeredVia: null
    };
    if (cleanImgs) ticket.images = cleanImgs;
    ticket.askSeal = askSeal(ticket);
    updateFileAtomically(ticketPath(projectRoot, ticket.id), () => ({
        content: `${JSON.stringify(ticket, null, 2)}\n`,
        result: ticket
    }), { seed: '' });
    return ticket;
    } finally { unlock(); }
}

// The approval and the PLUTOS-owned action are checked under the same ticket lock. A
// successful retry returns the recorded result rather than running the action again.
export function runApprovedAction(projectRoot, id, action, perform) {
    const file = ticketPath(projectRoot, id);
    if (!fs.existsSync(file)) throw new Error(`No such question: ${id}.`);
    const expected = cleanAction(projectRoot, action);
    if (!expected || typeof perform !== 'function') throw new Error('A scoped action is required.');
    return updateFileAtomically(file, content => {
        let ticket;
        try { ticket = JSON.parse(content); } catch { throw new Error(`Question ${id} is unreadable on disk.`); }
        if (!ticket.action || Object.keys(expected).some(key => {
            const actual = String(ticket.action[key]);
            const wanted = String(expected[key]);
            return key === 'projectRoot' && process.platform === 'win32'
                ? actual.toLowerCase() !== wanted.toLowerCase() : actual !== wanted;
        })) {
            throw new Error('Approval belongs to a different project, package, version or target.');
        }
        // A retry returns the recorded outcome, even past the TTL — but only when the whole ticket
        // and the outcome's own seal hold, so a hand-written "succeeded" never reads as done.
        if (ticket.actionResult?.status === 'succeeded') {
            if (!sealsHold(ticket) || !sameSeal(ticket.resultSeal, resultSeal(ticket))) {
                throw new Error(`Question ${id} was changed outside PLUTOS; nothing was run. Ask the owner again.`);
            }
            return { content, result: ticket.actionResult };
        }
        if (ticket.status !== 'approved' || Date.now() > ticket.expiresAt) {
            throw new Error(`Question ${id} is ${Date.now() > ticket.expiresAt ? 'expired' : ticket.status}; the action is not approved.`);
        }
        if (!sealsHold(ticket)) throw new Error(`Question ${id} was changed outside PLUTOS; nothing was run. Ask the owner again.`);
        if (!tierAllows(approvalTier(ticket.action), ticket.answeredVia || 'local')) {
            throw new Error(`Question ${id} needs an approval given at the PLUTOS computer.`);
        }
        let outcome;
        try {
            outcome = { status: 'succeeded', detail: String(perform() ?? ''), completedAt: Date.now() };
        } catch (error) {
            outcome = { status: 'failed', detail: String(error.message || error), completedAt: Date.now() };
        }
        const updated = { ...ticket, actionResult: outcome };
        updated.resultSeal = resultSeal(updated);
        return { content: `${JSON.stringify(updated, null, 2)}\n`, result: outcome };
    });
}

// Records the owner's decision. Takes the lock because two dashboard clicks — or a click and
// a second browser tab — can land on the same ticket, and the second must be told it lost
// rather than silently overwriting the first answer.
export function answerApproval(projectRoot, id, { decision, note, option, via = 'local' } = {}) {
    // Picking an option IS the approval — it says which route, and there is no sense in
    // choosing one while rejecting. Callers that pass no option are unaffected.
    const chosen = option == null ? null : String(option).replace(/\s+/g, ' ').trim();
    const verdict = decision == null && chosen ? 'approved' : decision;
    if (verdict !== 'approved' && verdict !== 'rejected') {
        throw new Error("decision must be 'approved' or 'rejected'.");
    }
    const file = ticketPath(projectRoot, id);
    if (!fs.existsSync(file)) throw new Error(`No such question: ${id} (it may have been answered and swept).`);

    return updateFileAtomically(file, (content) => {
        let current;
        try { current = JSON.parse(content); } catch (e) { throw new Error(`Question ${id} is unreadable on disk.`); }
        if (current.status !== 'pending') {
            throw new Error(`Question ${id} is already ${current.status}.`);
        }
        if (!sameSeal(current.askSeal, askSeal(current))) {
            throw new Error(`Question ${id} was changed outside PLUTOS after it was asked; it cannot be answered. Ask again.`);
        }
        const answeredVia = via === 'local' ? 'local' : 'remote';
        const tier = approvalTier(current.action);
        if (verdict === 'approved' && !tierAllows(tier, answeredVia)) {
            throw new Error(tier === 'T1'
                ? `Starting an AI turn is approved at the PLUTOS computer until phone step-up exists. You can reject it from here.`
                : `This approval changes what runs or who may act, so it is given at the PLUTOS computer only. You can reject it from here.`);
        }
        if (Date.now() > current.expiresAt) {
            throw new Error(`Question ${id} expired — the agent has stopped waiting for it.`);
        }
        // An option the ticket never offered is refused, not recorded: the agent will act on
        // whatever comes back, so an answer it cannot map to a route is worse than no answer.
        if (chosen && !(current.options || []).includes(chosen)) {
            throw new Error(`Question ${id} did not offer that option.`);
        }
        const answered = {
            ...current, status: verdict, note: clip(note) || null,
            option: chosen || null, answeredAt: Date.now(), answeredVia
        };
        answered.answerSeal = answerSeal(answered);
        return { content: `${JSON.stringify(answered, null, 2)}\n`, result: answered };
    });
}

// A static page of the questions waiting, for the owner who wants to SEE an A/B pick without a
// dashboard: each question, its options numbered, its images labelled by option, and the exact
// command that answers it. It answers nothing itself: no script, no form, no request (the CSP
// forbids all three), and only tickets whose seals hold are listed. The answer is still typed at
// a terminal. → the page's absolute path.
export const APPROVALS_PAGE = `${DESIGN_PICKS_DIR}/pending.html`;

// A value quoted for the shell the owner pastes into: single quotes on POSIX (no $ or ` expansion),
// double quotes on Windows (cmd and PowerShell both take them; a path has no " there).
export const shellQuote = (value, platform = process.platform) => platform === 'win32'
    ? `"${value}"` : `'${String(value).replace(/'/g, `'\\''`)}'`;

// The exact commands that answer ticket t, runnable from any folder: the CLI by its absolute path
// (the installed `plutos` command in a packaged build, which has no cli.mjs) and the project named,
// since [path] defaults to the current folder. An option is chosen by its number, never by its
// text: the text is the asking AI's, and pasted into a shell inside quotes, $( ) or a backtick in
// it would run in the owner's terminal. `plutos approve` maps the number back to the text.
// Callers pass their APP_ROOT; the default is this file's checkout. Not imported from approot.mjs,
// whose home directory is fixed on import and must stay settable before this module loads.
const DEFAULT_APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function answerCommands(projectRoot, t, { appRoot = DEFAULT_APP_ROOT, platform = process.platform } = {}) {
    const cliFile = path.join(appRoot, 'cli.mjs');
    const cli = fs.existsSync(cliFile) ? `node ${shellQuote(cliFile, platform)}` : 'plutos';
    const where = shellQuote(path.resolve(projectRoot), platform);
    const options = t.options || [];
    return (options.length
        ? options.map((_, i) => `${cli} approve ${t.id} ${where} --option ${i + 1}`)
        : [`${cli} approve ${t.id} ${where}`]).concat(`${cli} reject ${t.id} ${where}`);
}

// What `--option` names: the option's exact text, or its number as answerCommands prints it.
export function resolveOptionArg(ticket, arg) {
    if (arg == null || arg === '') return undefined;
    const text = String(arg).replace(/\s+/g, ' ').trim();
    const options = ticket?.options || [];
    if (options.includes(text)) return text;
    if (/^\d+$/.test(text) && Number(text) >= 1 && Number(text) <= options.length) return options[Number(text) - 1];
    return text;
}
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function ticketSection(projectRoot, t, appRoot) {
    const options = t.options || [];
    const images = (t.images || []).map((rel, i) => {
        const label = options[i] ? `Option ${i + 1}: ${options[i]}` : `Image ${i + 1}`;
        let ok = true;
        try { designPickImagePath(projectRoot, rel); } catch { ok = false; }
        // Relative to the page, which sits in DESIGN_PICKS_DIR itself, so the folder can move whole.
        const src = path.posix.relative(DESIGN_PICKS_DIR, rel).split('/').map(encodeURIComponent).join('/');
        return `<figure><figcaption>${esc(label)}</figcaption>`
            + (ok ? `<img src="${esc(src)}" alt="${esc(label)}">` : `<p class="missing">Missing: ${esc(rel)}</p>`) + '</figure>';
    }).join('');
    const commands = answerCommands(projectRoot, t, { appRoot });
    return `<section><h2>${esc(t.question)}</h2>`
        + `<p class="meta">${esc(t.agent)} · ${esc(t.id)} · expires ${esc(new Date(t.expiresAt).toISOString())}</p>`
        + (t.context ? `<p>${esc(t.context)}</p>` : '')
        + (options.length ? `<ol>${options.map(o => `<li>${esc(o)}</li>`).join('')}</ol>` : '')
        + (images ? `<div class="images">${images}</div>` : '')
        + `<p>Answer in a terminal:</p><pre>${commands.map(esc).join('\n')}</pre></section>`;
}

export function writeApprovalsPage(projectRoot, { open = false, appRoot = DEFAULT_APP_ROOT } = {}) {
    const pending = listApprovals(projectRoot).filter(t => t.status === 'pending');
    const body = pending.length ? pending.map(t => ticketSection(projectRoot, t, appRoot)).join('\n') : '<p>No questions waiting.</p>';
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; style-src 'unsafe-inline'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Questions waiting</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem;color:#222;background:#fff}
section{border-top:1px solid #ccc;padding:1rem 0}.meta{color:#666;font-size:13px}.images{display:flex;flex-wrap:wrap;gap:1rem}
figure{margin:0;flex:1 1 16rem}img{max-width:100%;border:1px solid #ddd}pre{background:#f4f4f4;padding:.5rem;overflow-x:auto}.missing{color:#a00}</style>
</head><body><h1>Questions waiting (${pending.length})</h1>
<p>This page answers nothing. Answer each question with its command in a terminal.</p>
${body}
</body></html>
`;
    const file = path.join(projectRoot, ...APPROVALS_PAGE.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    updateFileAtomically(file, () => ({ content: html, result: null }), { seed: '' });
    // Pending questions, agent names and ticket ids are this machine's working state, not project history.
    keepOutOfGit(projectRoot, [APPROVALS_PAGE]);
    if (open) openBrowser(pathToFileURL(file).href);
    return file;
}
