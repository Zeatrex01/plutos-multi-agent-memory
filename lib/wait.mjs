// `plutos wait --seat <name>`: blocks until the shared board has a TODO assigned to that seat, then
// prints the instruction the watcher hook would give and exits, so the owner's loop can hand it to
// the AI (`codex exec`, `claude -p`, `gemini -p`). It reads the board file itself, so it works
// without the dashboard, and waiting costs no tokens: no model runs until there is work.
//
// This is the idle half of the watcher (lib/watcher.mjs): the Stop hook keeps a working seat
// working, this wakes a waiting one. PLUT_OS still schedules nothing; the loop is the owner's.
import fs from 'node:fs';
import { parseBoardEntries } from './board.mjs';
import { boardPathFor } from './roadmap.mjs';
import { selectAssignedTask, assignedTaskPrompt } from './watcher.mjs';

export function checkOnce(projectRoot, seat) {
    const file = boardPathFor(projectRoot);
    if (!fs.existsSync(file)) return null;
    return selectAssignedTask({ entries: parseBoardEntries(fs.readFileSync(file, 'utf8')) }, seat);
}

// Resolves to the prompt text, or null when timeoutMs (0 = never) passes first. The board is
// re-read only when its modification time changes.
export async function waitForTask(projectRoot, seat, { intervalMs = 5000, timeoutMs = 0 } = {}) {
    const file = boardPathFor(projectRoot);
    const started = Date.now();
    let seen = -1;
    for (;;) {
        let mtime = 0;
        try { mtime = fs.statSync(file).mtimeMs; } catch { /* no board yet */ }
        if (mtime !== seen) {
            seen = mtime;
            const picked = checkOnce(projectRoot, seat);
            if (picked) return assignedTaskPrompt(seat, picked);
        }
        if (timeoutMs && Date.now() - started >= timeoutMs) return null;
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
}
