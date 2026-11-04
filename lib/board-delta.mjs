// board_read deltas within one session.
//
// Agents re-read the board before every task (AGENTS.md rule 1), and on a working project most
// of it has not changed since their last read. Each board_read now returns a cursor; passing it
// back as `since` returns only the entries added or changed since that read, the ones removed,
// and a count of the rest.
//
// A cursor names what the session was SHOWN, not the file: entries a read trimmed to stay under
// its limit are not recorded, so the next delta still brings them. The snapshots live in this
// MCP server process and nowhere else. A client starts one server per session, so a new session,
// or a server restarted mid-session, does not know the cursor and gets the full board. Nothing
// is written to disk, and no AI is told "unchanged" about an entry it never saw.
import { createHash } from 'node:crypto';

const MAX_SNAPSHOTS = 20;

// Two entries can share agent and title; the occurrence number keeps them apart.
function keyed(entries) {
    const seen = new Map();
    return entries.map(entry => {
        const base = `${entry.agent}\u0000${entry.title}`;
        const n = (seen.get(base) || 0) + 1;
        seen.set(base, n);
        return { key: `${base}\u0000${n}`, entry };
    });
}

export function createBoardReads({ max = MAX_SNAPSHOTS } = {}) {
    const snapshots = new Map();

    // scope: which board (main or agents). entries: the board's parsed entries.
    // select(pool) → the entries of pool that this read returns (the caller's limit).
    // → { cursor, mode: 'full' | 'unknown' | 'same' | 'delta', shown, pending, removed, unchanged }
    return function read(scope, entries, since, select = pool => pool) {
        const current = keyed(entries);
        const now = new Set(current.map(({ key }) => key));
        const base = typeof since === 'string' && since ? snapshots.get(since) : null;
        const known = base && base.scope === scope ? base.revisions : null;

        const pool = known ? current.filter(({ key, entry }) => known.get(key) !== entry.revision) : current;
        const removed = known ? [...known.keys()].filter(key => !now.has(key))
            .map(key => { const [agent, title] = key.split('\u0000'); return { agent, title }; }) : [];
        const shown = select(pool.map(({ entry }) => entry));

        const picked = new Set(shown);
        const revisions = new Map(known ? [...known].filter(([key]) => now.has(key)) : []);
        for (const { key, entry } of pool) if (picked.has(entry)) revisions.set(key, entry.revision);
        const cursor = createHash('sha256').update(JSON.stringify([scope, [...revisions].sort()])).digest('hex').slice(0, 12);
        snapshots.delete(cursor);
        snapshots.set(cursor, { scope, revisions });
        while (snapshots.size > max) snapshots.delete(snapshots.keys().next().value);

        const mode = !since ? 'full' : !known ? 'unknown' : pool.length || removed.length ? 'delta' : 'same';
        return { cursor, mode, shown, pending: pool.length, removed, unchanged: current.length - pool.length };
    };
}
