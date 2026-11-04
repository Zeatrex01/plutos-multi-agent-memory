// Shared BOARD.md parse/update logic — used by the dashboard (/api/board) and the
// MCP tools (board_read / board_update). Zero dependencies.
//
// Entry format (see AGENTS.md):
//   ### <agent-name> · <STATUS: IN_PROGRESS|DONE|BLOCKED> · <short task title>
//   - **Started:** <timestamp>
//   - **Task:** <one line>
//   - **Result / Output:** <one line, filled when DONE>
//   - ❓ NOTE: <conflict/dependency note>
import { splitLines, joinLines } from './lines.mjs';
import { createHash } from 'node:crypto';

// Header status is captured loosely (.+?, not \S+): some boards predate PLUT_OS and write
// richer text here, e.g. "DONE (Claude implemented, 2026-07-12)" — a single \S+ token would
// never match that line at all, silently dropping the whole entry (and every board seen so
// far in this project, since parseBoardEntries would just return []).
export const HEADER_RE = /^###\s+(.+?)\s*·\s*(.+?)\s*·\s*(.+)$/;
export const FIELD_RE = /^-\s+\*\*(.+?):?\*\*:?\s*(.*)$/;

// TODO = task created/assigned but not yet claimed (the boss assigns, an agent claims).
export const BOARD_STATUSES = ['TODO', 'IN_PROGRESS', 'DONE', 'BLOCKED'];
export const VERIFICATION_STATUSES = ['unverified', 'passed', 'failed'];
// A priority is a field, not part of the title: the title is the entry's identity, so ranking by a
// "P1 - " prefix made re-prioritising an entry silently create a second one (board, 2026-09-02).
// An entry written before the field reads its old prefix as its priority.
export const BOARD_PRIORITIES = ['P1', 'P2', 'P3'];
const TITLE_PRIORITY = /^(P[1-3])\s*[-–—:]\s/;
/** Sorts P1 first, then P2, P3, then entries without one; equal ones keep their board order. */
export const byPriority = (a, b) => {
    const rank = e => BOARD_PRIORITIES.includes(e.priority) ? BOARD_PRIORITIES.indexOf(e.priority) : BOARD_PRIORITIES.length;
    return rank(a) - rank(b);
};

// Assignee is one AI identity, not free-text search: case-insensitive, and a name matches only
// itself or itself with a qualifier after a space ("claude" ~ "Claude Code", the name the
// SessionStart hook reports). A hyphen joins one identity, so a shorter name never claims another
// agent's task ("codex" is not "codex-reviewer").
export const sameAi = (left, right) => {
    const a = String(left ?? '').trim().toLowerCase(), b = String(right ?? '').trim().toLowerCase();
    return !!a && !!b && (a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `));
};

// Statuses recognized when reading — wider than BOARD_STATUSES (what PLUT_OS itself writes)
// because pre-existing boards (this project's own AGENTS.md protocol) use TODO/DOING too.
const KNOWN_READ_STATUSES = ['TODO', 'DOING', 'IN_PROGRESS', 'DONE', 'BLOCKED'];

// Header status text may carry extra commentary after the keyword ("DONE (Claude implemented, ...)").
// Normalize to just the leading known keyword when present; otherwise keep the raw text so the
// entry still surfaces (better an unrecognized status than a silently dropped entry).
function normalizeStatus(raw) {
    const upper = raw.trim().toUpperCase();
    const hit = KNOWN_READ_STATUSES.find(s => upper === s || upper.startsWith(s + ' ') || upper.startsWith(s + '('));
    return hit || upper;
}

// → [{ agent, status, title, fields: {..}, notes: [..] }]
export function parseBoardEntries(content) {
    const entries = [];
    let current = null;
    const inFence = fenceTracker();
    for (const line of splitLines(content)) {
        if (inFence(line)) continue;   // examples inside ``` are documentation, not entries
        const header = line.match(HEADER_RE);
        if (header) {
            current = { agent: header[1].trim(), status: normalizeStatus(header[2]), title: header[3].trim(), fields: {}, notes: [] };
            entries.push(current);
            continue;
        }
        if (!current) continue;
        const field = line.match(FIELD_RE);
        if (field && !line.includes('❓')) {
            const key = field[1].replace(/:$/, '').trim();
            current.fields[key] = field[2].trim();
            // Some boards keep the live status in a "**Status:** TODO" body field, separate
            // from a header label that's really a historical note — the field wins when present.
            if (key.toLowerCase() === 'status' && field[2].trim()) {
                current.status = normalizeStatus(field[2].trim());
            }
        } else if (line.includes('❓ NOTE:')) {
            current.notes.push(line.replace(/^[-\s]*❓\s*NOTE:\s*/, '').trim());
        }
    }
    return entries.map(entry => {
        const field = name => Object.entries(entry.fields).findLast(([key]) => key.toLowerCase() === name)?.[1] || '';
        const evidence = field('evidence');
        const recorded = field('verification').toLowerCase();
        const verification = VERIFICATION_STATUSES.includes(recorded) && (recorded !== 'passed' || evidence)
            ? recorded : 'unverified';
        const revision = createHash('sha256').update(JSON.stringify([
            entry.agent, entry.status, entry.title, Object.entries(entry.fields).sort(([a], [b]) => a.localeCompare(b)), entry.notes
        ])).digest('hex');
        const written = field('priority').toUpperCase();
        const priority = BOARD_PRIORITIES.includes(written) ? written : (entry.title.match(TITLE_PRIORITY)?.[1] || '');
        return { ...entry, verification, evidence, revision, priority };
    });
}

// Entry blocks with line ranges: header + following list/blank lines (trailing blanks excluded).
// A fenced code block in these files is documentation, not data. ROSTER.md ships with the
// entry format in a ``` fence, and every parser here read that example as a real record —
// a brand-new project listed an agent called "<agent-name>" owned by "<owner-ai>", three
// lines below the file's own "(no agents registered)" marker. Any template, sample or
// quoted board entry an AI writes into a fence would do the same.
// Returns a predicate: call it per line, in order, and it reports whether that line is
// inside a fence (the fence lines themselves count as inside).
export function fenceTracker() {
    let inside = false;
    return (line) => {
        if (/^\s*(```|~~~)/.test(line)) { inside = !inside; return true; }
        return inside;
    };
}

export function findBlocks(lines) {
    const blocks = [];
    const inFence = fenceTracker();
    for (let i = 0; i < lines.length; i++) {
        const fenced = inFence(lines[i]);
        const m = lines[i].match(HEADER_RE);
        if (!m || fenced) continue;
        let j = i + 1;
        while (j < lines.length && (lines[j].trim() === '' || lines[j].trim().startsWith('-'))) j++;
        while (j > i + 1 && lines[j - 1].trim() === '') j--;
        blocks.push({ start: i, end: j, agent: m[1].trim(), status: m[2].trim().toUpperCase(), title: m[3].trim() });
    }
    return blocks;
}

// Every value that lands in a block is agent-supplied text. A newline inside any of them
// used to FORGE entries: a title containing "\n### other-agent · DONE · ..." wrote a complete
// fabricated entry attributed to someone else, which parseBoardEntries then read back as real.
// This is the single choke point every writer (board, roster, system) goes through, so the
// flattening lives here — same fix continuity.mjs applies to session fields.
//
// Length caps live here for the same reason. These files are committed to git and read back
// into AI context windows; a single unbounded field poisons both. A 2 MB task field was
// accepted without complaint and board_read then returned a 672k-token response — no model
// can read that, and the bloat is permanent in git history. A board field is a summary by
// definition; anything longer belongs in a results/ document that the entry references.
export const FIELD_LIMITS = {
    name: 200,      // agent, status, field keys — identifiers, not prose
    title: 300,
    value: 2000,    // task/result/assignee bodies
    note: 1000
};
const TRUNCATED = ' …[truncated]';
const truncate = (s, max) => s.length > max ? s.slice(0, max - TRUNCATED.length) + TRUNCATED : s;
// Exported because the ideas list (lib/ideas.mjs) writes agent- and owner-supplied text into
// the same kind of committed, AI-read markdown file, and needs the identical guarantees. A
// second copy of a security helper is how two writers drift apart.
export const flat = (v, max = FIELD_LIMITS.value) =>
    truncate(String(v ?? '').replace(/\s*\r?\n\s*/g, ' ').trim(), max);

export function formatBlock(agent, status, title, fields, notes) {
    const lines = [`### ${flat(agent, FIELD_LIMITS.name)} · ${flat(status, FIELD_LIMITS.name)} · ${flat(title, FIELD_LIMITS.title)}`];
    for (const [k, v] of fields) lines.push(`- **${flat(k, FIELD_LIMITS.name)}:** ${flat(v)}`);
    for (const n of notes) lines.push(`- ❓ NOTE: ${flat(n, FIELD_LIMITS.note)}`);
    return lines;
}

const fieldLine = (k, v) => `- **${flat(k, FIELD_LIMITS.name)}:** ${flat(v)}`;
const noteLine = (n) => `- ❓ NOTE: ${flat(n, FIELD_LIMITS.note)}`;

// Read a block's body into an ORDERED item list, keeping every line — including the ones
// this format does not recognise.
//
// The update path used to rebuild a block from its parsed fields and notes alone, which
// silently deleted everything else inside it: a `- [ ] subtask` checklist, a link to the
// results document, a paragraph of reasoning, a blank line. A human writes detail under a
// task, an AI marks it DONE, the detail is gone — and nothing reports it. These files are the
// project's memory; a writer that quietly drops what it does not understand is the one thing
// they cannot afford.
//
// Unrecognised lines are carried through verbatim, in place. They are never synthesised from
// input, so the newline-flattening that stops entry forgery still covers everything written.
export function readBody(bodyLines) {
    return bodyLines.map(raw => {
        const field = raw.match(FIELD_RE);
        if (field && !raw.includes('❓')) {
            return { kind: 'field', key: field[1].replace(/:$/, '').trim(), value: field[2].trim() };
        }
        if (raw.includes('❓ NOTE:')) {
            return { kind: 'note', text: raw.replace(/^[-\s]*❓\s*NOTE:\s*/, '').trim() };
        }
        return { kind: 'other', raw };
    });
}

// Set a field, in place when it already exists so the block's ordering survives; otherwise
// straight after the last field, which keeps the metadata together above any prose.
export function setField(items, key, value) {
    const at = items.findIndex(i => i.kind === 'field' && i.key.toLowerCase() === key.toLowerCase());
    if (at >= 0) { items[at] = { kind: 'field', key: items[at].key, value }; return; }
    let insert = 0;
    for (let i = 0; i < items.length; i++) if (items[i].kind === 'field') insert = i + 1;
    items.splice(insert, 0, { kind: 'field', key, value });
}

export function renderBody(items) {
    return items.map(i => i.kind === 'field' ? fieldLine(i.key, i.value)
        : i.kind === 'note' ? noteLine(i.text)
            : i.raw);
}

// Upsert one entry (matched by agent + title, case-insensitive).
// → { content, action: 'created' | 'updated' }
// The MCP schema says these are strings, but nothing used to enforce it at runtime: an
// array reached .toLowerCase() and the caller got "agent.toLowerCase is not a function" —
// an internal stack detail, not a contract error. Fail with the contract instead.
export function requireStrings(pairs) {
    for (const [name, v] of pairs) {
        if (v != null && typeof v !== 'string') throw new Error(`${name} must be a string, got ${Array.isArray(v) ? 'array' : typeof v}.`);
    }
}

// What shows the task is finished, written when it is claimed. An entry that has one cannot go
// DONE without a recorded verification against it: passed (with evidence), failed or unverified.
// The owner asked for this on 2026-10-29: a model that knows what "done" means stops in the right
// place, and a DONE that never looked at its own criterion says so in the record.
const DONE_WHEN_UNCHECKED = check => `This entry is done when: ${check}. Record that check with DONE: verification passed (with evidence), failed or unverified.`;

// `role` and `needs` are what turn an assignment into something the receiving AI can act on
// alone. Before them a board entry said WHAT to do and WHO should do it, but not what to be
// while doing it or what it takes — so the assignee arrived, read a title, and had to
// re-derive the rest. Now the task carries its own requirements: the brief shows them, and
// the AI can build the agent the task calls for without another round trip through the user.
export function applyBoardUpdate(content, { agent, status, title, task, result, note, assignee, role, needs, priority, verification, evidence, expectedRevision, doneWhen }) {
    requireStrings([['agent', agent], ['status', status], ['title', title], ['task', task], ['result', result], ['note', note], ['assignee', assignee], ['role', role], ['priority', priority], ['verification', verification], ['evidence', evidence], ['expectedRevision', expectedRevision], ['doneWhen', doneWhen]]);
    if (priority != null) {
        priority = priority.trim().toUpperCase();
        if (priority && !BOARD_PRIORITIES.includes(priority)) throw new Error(`priority must be one of: ${BOARD_PRIORITIES.join(', ')}`);
    }
    if (verification != null && !VERIFICATION_STATUSES.includes(verification)) {
        throw new Error(`verification must be one of: ${VERIFICATION_STATUSES.join(', ')}`);
    }
    if (evidence != null) {
        evidence = evidence.trim();
        if (evidence.length > FIELD_LIMITS.value || /[\r\n\x00]/.test(evidence)) throw new Error('evidence must be one reference of at most 2000 characters.');
        if (evidence) {
            if (/^https?:\/\//i.test(evidence)) {
                try { new URL(evidence); } catch { throw new Error('evidence must be a valid HTTP(S) URL.'); }
            } else if (/^[\\/]|^[a-z]:|[?#]|:|(^|[\\/])\.\.([\\/]|$)/i.test(evidence)) {
                throw new Error('evidence must be an HTTP(S) URL or a project-relative artifact path without traversal.');
            }
        }
    }
    if (verification === 'passed' && !evidence) throw new Error('A passed verification requires a nonempty evidence reference in the same update.');
    if (needs != null && !Array.isArray(needs) && typeof needs !== 'string') {
        throw new Error(`needs must be a string or an array of strings, got ${typeof needs}.`);
    }
    const needsList = Array.isArray(needs) ? needs.join(', ') : needs;
    // Trimmed BEFORE the identity comparison below. findBlocks trims what it reads off the
    // file, so an incoming title with a stray trailing space matched nothing and the upsert
    // "created" a second entry — one that renders identically to the first, because flat()
    // trims on the way out. Two indistinguishable blocks for the same task, and the board
    // fills up with them.
    agent = agent == null ? agent : agent.trim();
    title = title == null ? title : title.trim();
    if (!agent || !status || !title) throw new Error("agent, status and title are required.");
    status = status.trim().toUpperCase();
    if (!BOARD_STATUSES.includes(status)) throw new Error(`status must be one of: ${BOARD_STATUSES.join(', ')}`);

    const lines = splitLines(content);
    const blocks = findBlocks(lines);
    // Identity is agent + title. But an ASSIGNED task is opened by one AI and finished by
    // another, and matching on the opener's name alone meant the assignee could not close
    // it: Claude's "TODO / assignee: gemini" stayed open forever while Gemini created a
    // second DONE entry with the same title. So an entry assigned to this caller is also
    // theirs to update — found by title plus an Assignee that names them.
    const fieldOf = (b, key) => {
        for (const line of lines.slice(b.start + 1, b.end)) {
            const m = line.match(FIELD_RE);
            if (m && m[1].replace(/:$/, '').trim().toLowerCase() === key) return m[2].trim();
        }
        return '';
    };
    const sameTitle = blocks.filter(b => b.title.toLowerCase() === title.toLowerCase());
    const existing = sameTitle.find(b => sameAi(b.agent, agent))
        || sameTitle.find(b => sameAi(fieldOf(b, 'assignee'), agent));
    if (expectedRevision != null) {
        const current = existing && parseBoardEntries(joinLines(lines.slice(existing.start, existing.end), content))[0];
        // board_read shows a 16-hex prefix; the dashboard passes the full hash. Either matches.
        const matches = typeof expectedRevision === 'string' && expectedRevision.length >= 16
            && current && current.revision.startsWith(expectedRevision.toLowerCase());
        if (!matches) {
            const error = new Error('Board entry changed since it was displayed. Refresh and review it before recording verification.');
            error.code = 'BOARD_CONFLICT';
            throw error;
        }
    }

    if (existing) {
        // Edit the block in place, keeping every line it already had — see readBody.
        const items = readBody(lines.slice(existing.start + 1, existing.end));
        const setVerificationField = (key, value) => {
            setField(items, key, value);
            // Hand-edited duplicate metadata must not keep a later stale passed value alive.
            for (const item of items) if (item.kind === 'field' && item.key.toLowerCase() === key.toLowerCase()) item.value = value;
        };
        const oldVerification = items.findLast(item => item.kind === 'field' && item.key.toLowerCase() === 'verification')?.value.toLowerCase();
        const reopened = normalizeStatus(fieldOf(existing, 'status') || existing.status) === 'DONE' && status !== 'DONE';
        const changedWork = (task && flat(task) !== flat(fieldOf(existing, 'task')))
            || (result && flat(result) !== flat(fieldOf(existing, 'result / output')));
        if (oldVerification === 'passed' && (reopened || changedWork) && verification !== 'passed') {
            setVerificationField('Verification', 'unverified');
            setVerificationField('Evidence', '');
        }
        if (verification != null) setVerificationField('Verification', verification);
        if (evidence != null) setVerificationField('Evidence', evidence);
        const valueOf = key => items.find(item => item.kind === 'field' && item.key.toLowerCase() === key)?.value || '';
        if ((verification != null || evidence != null) && valueOf('verification').toLowerCase() === 'passed' && !valueOf('evidence')) {
            throw new Error('A passed verification requires a nonempty evidence reference.');
        }
        if (task) setField(items, 'Task', task);
        if (doneWhen) setField(items, 'Done when', doneWhen);
        if (status === 'DONE' && valueOf('done when') && !valueOf('verification')) throw new Error(DONE_WHEN_UNCHECKED(valueOf('done when')));
        if (role) setField(items, 'Role', role);
        if (needsList) setField(items, 'Needs', needsList);
        if (result) setField(items, 'Result / Output', result);
        if (assignee) setField(items, 'Assignee', assignee);
        if (priority) setField(items, 'Priority', priority);
        // The read path gives a body **Status:** field priority over the header — keep them
        // in sync, or updating such an entry would silently never surface (stale field wins).
        for (const item of items) {
            if (item.kind === 'field' && item.key.toLowerCase() === 'status') item.value = status;
        }
        // The header names whoever is working it now. When an assignee picks up someone
        // else's TODO, the entry becomes theirs — the opener stays visible in Assignee's
        // counterpart field so the handover is legible rather than erased.
        const takingOver = !sameAi(existing.agent, agent);
        if (takingOver && !items.some(i => i.kind === 'field' && i.key.toLowerCase() === 'opened by')) {
            setField(items, 'Opened by', existing.agent);
        }
        // A new note goes after the last existing note, or at the end — never before the
        // prose someone wrote underneath.
        if (note) {
            let at = items.length;
            for (let i = 0; i < items.length; i++) if (items[i].kind === 'note') at = i + 1;
            items.splice(at, 0, { kind: 'note', text: note });
        }
        const header = `### ${flat(takingOver ? agent : existing.agent, FIELD_LIMITS.name)} · ${flat(status, FIELD_LIMITS.name)} · ${flat(existing.title, FIELD_LIMITS.title)}`;
        lines.splice(existing.start, existing.end - existing.start, header, ...renderBody(items));
        return { content: joinLines(lines, content), action: 'updated' };
    }

    if (status === 'DONE' && doneWhen && verification == null) throw new Error(DONE_WHEN_UNCHECKED(doneWhen));
    const fields = new Map([['Started', new Date().toISOString()], ['Task', task || title]]);
    if (doneWhen) fields.set('Done when', doneWhen);
    if (role) fields.set('Role', role);
    if (needsList) fields.set('Needs', needsList);
    if (result) fields.set('Result / Output', result);
    if (assignee) fields.set('Assignee', assignee);
    if (priority) fields.set('Priority', priority);
    if (verification != null) fields.set('Verification', verification);
    if (evidence != null) fields.set('Evidence', evidence);
    const block = formatBlock(agent, status, title, fields, note ? [note] : []);

    // The seed template carries "(no active tasks — add your entry above this line)". It used
    // to be treated purely as an insertion anchor and left in place, so a board with two live
    // tasks still declared it had none — and every AI reading the file got that contradiction
    // along with the tasks. It is a placeholder: once there is something to show, it goes.
    const placeholderIdx = lines.findIndex(l => l.includes('(no active tasks'));
    if (placeholderIdx >= 0) {
        lines.splice(placeholderIdx, 1, ...block);
    } else {
        if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
        lines.push(...block, '');
    }
    return { content: joinLines(lines, content), action: 'created' };
}
