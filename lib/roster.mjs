// Agent roster — docs/handoff/ROSTER.md. Every AI registers the agents it spawns so
// every other AI knows who exists, who owns them, and where their memory lives.
// PLUT_OS never commands another AI's agents; the roster is awareness, not control.
//
// Entry format (same "a · b · c" shape as the boards, one parser family):
//   ### <agent-name> · <owner-ai> · <role>
//   - **Kind:** subagent | main-ai
//   - **Status:** introduced | active
//   - **Memory:** .agents/<name>/MEMORY.md
//   - **Skills:** x, y (optional)
//   - **Registered:** <timestamp>
//   - **Last active:** <timestamp>
//
// Status: `plutos_create_agent` pre-registers an agent as 'introduced' (visible on the roster
// before any AI has actually spawned it). The first real `agent_register` call for that same
// name — which every AI already does on spawn, per the memory ritual — flips it to 'active'
// automatically, since that call is the real activation event.
import path from 'path';
import { HEADER_RE, FIELD_RE, findBlocks, formatBlock, fenceTracker, requireStrings, readBody, setField, renderBody } from './board.mjs';
import { joinLines } from './lines.mjs';

export function rosterPathFor(projectRoot) {
    return path.join(projectRoot, 'docs', 'handoff', 'ROSTER.md');
}

// → [{ name, owner, role, fields: {..} }]
export function parseRoster(content) {
    const entries = [];
    let current = null;
    const inFence = fenceTracker();
    for (const line of content.split(/\r?\n/)) {
        if (inFence(line)) continue;   // the shipped "Entry format" example is not an agent
        const header = line.match(HEADER_RE);
        if (header) {
            current = { name: header[1].trim(), owner: header[2].trim(), role: header[3].trim(), fields: {} };
            entries.push(current);
            continue;
        }
        if (!current) continue;
        const field = line.match(FIELD_RE);
        if (field) current.fields[field[1].replace(/:$/, '').trim()] = field[2].trim();
    }
    return entries;
}

// Upsert by agent name (case-insensitive). Registering an existing agent refreshes
// its Last active + any provided fields — safe to call on every spawn.
// `status` defaults to 'active' when omitted — any real agent_register call (no dashboard
// involved) means a real spawn, so it's the natural activation event for a pre-registered
// 'introduced' entry. Pass status: 'introduced' explicitly to keep an entry pre-registered
// (that's what `plutos_create_agent` does) without marking it as an active, working agent.
// → { content, action: 'registered' | 'refreshed' }
export function applyRosterUpdate(content, { name, owner, role, kind, memory, skills, status }) {
    requireStrings([['name', name], ['owner', owner], ['role', role], ['kind', kind], ['memory', memory], ['skills', skills], ['status', status]]);
    // Trimmed before the identity comparison, for the same reason the board trims: findBlocks
    // trims what it reads off the file, so a stray space produced a second, identical-looking
    // entry instead of refreshing the existing one.
    name = name == null ? name : name.trim();
    if (!name || !owner || !role) throw new Error("name, owner and role are required.");
    const now = new Date().toISOString();

    const lines = content.split(/\r?\n/);
    const blocks = findBlocks(lines);
    const existing = blocks.find(b => b.agent.toLowerCase() === name.toLowerCase());

    if (existing) {
        const previousOwner = existing.status.trim(); // roster header's second field
        if (previousOwner.toLowerCase() !== owner.trim().toLowerCase()) {
            if (previousOwner.toLowerCase() !== 'unclaimed') {
                throw new Error(`Agent '${name}' is already owned by '${previousOwner}'. Explicit transfer is required.`);
            }
        }
        // Same in-place edit the board does, for the same reason: rebuilding the block from
        // its parsed fields alone deleted every other line in it — notes included, since the
        // old call passed an empty notes array. A heartbeat refresh should not be able to
        // erase what someone wrote about the agent.
        const items = readBody(lines.slice(existing.start + 1, existing.end));
        if (kind) setField(items, 'Kind', kind);
        setField(items, 'Status', status || 'active');
        if (memory) setField(items, 'Memory', memory);
        if (skills) setField(items, 'Skills', skills);
        setField(items, 'Last active', now);
        // Keep the originally registered name casing — the name is the entry's identity.
        const header = formatBlock(existing.agent, owner, role, [], [])[0];
        lines.splice(existing.start, existing.end - existing.start, header, ...renderBody(items));
        return { content: joinLines(lines, content), action: 'refreshed' };
    }

    const fields = new Map([
        ['Kind', kind || 'subagent'],
        ['Status', status || 'active'],
        ['Memory', memory || `.agents/${name}/MEMORY.md`]
    ]);
    if (skills) fields.set('Skills', skills);
    fields.set('Registered', now);
    fields.set('Last active', now);
    const block = formatBlock(name, owner, role, fields, []);

    // The placeholder is a placeholder, not an anchor: leaving it in place meant a roster
    // listing three agents still announced "(no agents registered)" underneath them.
    const placeholderIdx = lines.findIndex(l => l.includes('(no agents registered'));
    if (placeholderIdx >= 0) lines.splice(placeholderIdx, 1, ...block);
    else {
        if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
        lines.push(...block, '');
    }
    return { content: joinLines(lines, content), action: 'registered' };
}

// Remove an agent's entry from the roster (by name, case-insensitive). The file itself is
// never deleted; an emptied roster keeps its header/rules. → { content, removed, entry? }
// `entry` carries the removed block's parsed fields so callers can warn (e.g. an 'active'
// agent being removed deserves a confirm, an 'introduced' one doesn't).
export function removeRosterEntry(content, name) {
    if (!name || typeof name !== 'string') throw new Error('Agent name is required.');
    const lines = content.split(/\r?\n/);
    const blocks = findBlocks(lines);
    const existing = blocks.find(b => b.agent.toLowerCase() === name.toLowerCase());
    if (!existing) return { content, removed: false };
    const fields = {};
    for (const line of lines.slice(existing.start + 1, existing.end)) {
        const field = line.match(FIELD_RE);
        if (field) fields[field[1].replace(/:$/, '').trim()] = field[2].trim();
    }
    const entry = { name: existing.agent, owner: existing.status, role: existing.title, fields };
    // Take the trailing blank separator with the block so removals don't accumulate gaps.
    let end = existing.end;
    while (end < lines.length && lines[end].trim() === '') end++;
    lines.splice(existing.start, end - existing.start);
    return { content: joinLines(lines, content), removed: true, entry };
}
