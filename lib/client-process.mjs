// Process presence and client lookup for the lock and launcher code.
import fs from 'node:fs';
import path from 'node:path';
// Presence is not identity: an existing/reused PID blocks takeover, never authorizes a kill.
export function clientProcessPresence(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return 'unobserved';
    try { process.kill(pid, 0); return 'present'; }
    catch (error) { return error.code === 'ESRCH' ? 'absent' : 'unobserved'; }
}
export function findClientExecutable(name) {
    return (process.env.PATH || '').split(path.delimiter)
        .map(dir => path.join(dir.replace(/^"|"$/g, ''), process.platform === 'win32' ? `${name}.exe` : name))
        .find(file => { try { return fs.statSync(file).isFile(); } catch { return false; } });
}
