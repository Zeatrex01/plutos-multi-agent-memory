// One atomic status store for MCP heartbeats and dashboard cleanup. Presence belongs to
// the client's bound project; legacy records without that identity stay explicitly unknown.
import fs from 'node:fs';
import { updateFileAtomically } from './atomic.mjs';
import { sameProjectPath } from './project-binding.mjs';

const MCP_LOG_CAP = 50;
const MCP_STALE_MS = 15_000;

function parseMcpStatus(raw) {
    let status;
    try { status = JSON.parse(raw); } catch { status = null; }
    if (!status || typeof status !== 'object' || Array.isArray(status)) status = {};
    if (!status.clients || typeof status.clients !== 'object' || Array.isArray(status.clients)) status.clients = {};
    if (!Array.isArray(status.log)) status.log = [];
    return status;
}

export function mutateMcpStatus(file, mutate) {
    return updateFileAtomically(file, raw => {
        const status = parseMcpStatus(raw);
        mutate(status);
        return { content: JSON.stringify(status, null, 2), result: status };
    }, { seed: '{}' });
}

// Readers take no lock: writers replace the file by rename, so a read sees the old or the new
// file, never half of one.
export function readMcpStatus(file) {
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch { /* absent: an empty status */ }
    return parseMcpStatus(raw);
}

export function pushMcpLogEntry(status, entry) {
    status.log.push(entry);
    if (status.log.length > MCP_LOG_CAP) status.log.splice(0, status.log.length - MCP_LOG_CAP);
}

function isLiveClient(pid, client, now) {
    if (!client || !Number.isFinite(client.lastActive) || now - client.lastActive > MCP_STALE_MS) return false;
    const id = Number(pid);
    if (!Number.isSafeInteger(id) || id <= 0) return false;
    try { process.kill(id, 0); return true; }
    catch (error) { return error.code === 'EPERM'; }
}

export function pruneMcpClients(status, now = Date.now()) {
    for (const [pid, client] of Object.entries(status.clients)) {
        if (isLiveClient(pid, client, now)) continue;
        pushMcpLogEntry(status, {
            event: 'disconnect', client: client?.client || 'Unknown client',
            project: client?.project || null, pid: Number(pid), at: now
        });
        delete status.clients[pid];
    }
    status.lastHeartbeat = Math.max(0, ...Object.values(status.clients).map(client => client.lastActive)) || null;
    status.active = Object.keys(status.clients).length > 0;
}

export function projectMcpStatus(status, projectRoot, now = Date.now()) {
    const knownProject = entry => typeof entry?.project === 'string' && entry.project.trim();
    const belongs = entry => knownProject(entry) && projectRoot && sameProjectPath(entry.project, projectRoot);
    const live = Object.entries(status.clients || {}).filter(([pid, client]) => isLiveClient(pid, client, now));
    const clients = Object.fromEntries(live.filter(([, client]) => belongs(client)));
    const unknownClients = Object.fromEntries(live.filter(([, client]) => !knownProject(client)));
    const log = (Array.isArray(status.log) ? status.log : []).filter(entry => entry && typeof entry === 'object');
    return {
        project: projectRoot || null,
        active: Object.keys(clients).length > 0,
        lastHeartbeat: Math.max(0, ...Object.values(clients).map(client => client.lastActive)) || null,
        clients,
        log: log.filter(belongs),
        unknownClients,
        unknownLog: log.filter(entry => !knownProject(entry))
    };
}
