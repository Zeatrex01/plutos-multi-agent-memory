// Agent handoff state: .plutos/state.json + activity log.
//
// Both files are shared between every client of the project, so they go through the one atomic
// primitive like every other shared file (two session_end calls in the same second used to race
// a plain writeFileSync). The log keeps the last LOG_KEEP lines: the dashboard reads twenty, and a
// file that only ever grew was the one PLUT_OS file with no budget.
import fs from 'fs';
import path from 'path';
import { updateFileAtomically } from './atomic.mjs';

export const LOG_KEEP = 500;

export function updateState(projectRoot, { taskName, status, notes }) {
    const plutosDir = path.join(projectRoot, '.plutos');
    fs.mkdirSync(path.join(plutosDir, 'logs'), { recursive: true });

    const newState = {
        lastTask: taskName || "Unknown",
        status: status || "IN_PROGRESS",
        notes: notes || "",
        timestamp: new Date().toISOString()
    };
    updateFileAtomically(path.join(plutosDir, 'state.json'), () => ({ content: JSON.stringify(newState, null, 2), result: newState }), { seed: '' });
    const line = `[${newState.timestamp}] TASK: ${newState.lastTask} | STATUS: ${newState.status} | NOTES: ${newState.notes}`;
    updateFileAtomically(path.join(plutosDir, 'logs', 'activity.log'), content => {
        const lines = String(content || '').split(/\r?\n/).filter(Boolean);
        lines.push(line.replace(/\r?\n/g, ' '));
        return { content: lines.slice(-LOG_KEEP).join('\n') + '\n', result: null };
    }, { seed: '' });
    return newState;
}

// Read the handoff state + recent activity log for the dashboard. Returns null when the
// project has no state yet. Without this, the state session_end mirrors was write-only — nothing
// surfaced the "where I left off" state the coordination story depends on.
export function readState(projectRoot, logLimit = 20) {
    const plutosDir = path.join(projectRoot, '.plutos');
    const stateFile = path.join(plutosDir, 'state.json');
    if (!fs.existsSync(stateFile)) return null;
    let state = null;
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { return null; }

    const logFile = path.join(plutosDir, 'logs', 'activity.log');
    let recent = [];
    if (fs.existsSync(logFile)) {
        recent = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean).slice(-logLimit).reverse();
    }
    return { state, recent };
}
