// Council HTTP adapter for the owner's dashboard: read rooms, follow a room live, write as the owner.
// Seats are never started from here; the moderator runs tools/council.mjs.
import fs from 'fs';
import path from 'path';
import { councilConfig, moderatorId, listRooms, readRoom, readLog, append, roomExists, roundStatus, roomDir, roomFile } from './council-room.mjs';

const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };

export function councilRoutes({ sendJson, readJsonBody, coordinationRoot, requireCapturedProject }) {
    const project = url => {
        requireCapturedProject(url.searchParams.get('project'));
        return coordinationRoot();
    };
    const room = (root, slug) => {
        if (!roomExists(root, slug)) throw Object.assign(new Error('No such room.'), { statusCode: 404 });
        return slug;
    };
    const guard = handler => async (req, res, url) => {
        try { await handler(req, res, url); }
        catch (e) { if (!res.headersSent) sendJson(res, e.statusCode || 400, { success: false, message: e.message }); }
    };
    return {
        'GET /api/council/rooms': guard((req, res, url) => {
            const { departments, seats } = councilConfig();
            const seatLabels = Object.fromEntries(Object.entries(seats || {}).map(([id, s]) => [id, s.label || id]));
            sendJson(res, 200, { departments, seats: seatLabels, moderator: moderatorId(), rooms: listRooms(project(url)) });
        }),
        'GET /api/council/room': guard((req, res, url) => {
            const root = project(url), slug = room(root, url.searchParams.get('slug'));
            const meta = readRoom(root, slug), log = readLog(root, slug);
            sendJson(res, 200, { room: meta, log, status: roundStatus(log, meta.departments), moderator: moderatorId() });
        }),
        // New log lines pushed as they are written (the log file is watched, the browser does not poll).
        'GET /api/council/events': guard((req, res, url) => {
            const root = project(url), slug = room(root, url.searchParams.get('slug'));
            const file = path.join(roomDir(root, slug), 'log.jsonl');
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
            res.write(': connected\n\n');
            let sent = Number(url.searchParams.get('since')) || 0;
            // Runs in a file-watch callback, outside guard(): a read failure must not crash the dashboard.
            const push = () => {
                try { for (const m of readLog(root, slug)) if (m.id > sent) { res.write(`data: ${JSON.stringify(m)}\n\n`); sent = m.id; } }
                catch { /* the next change retries */ }
            };
            push();
            fs.watchFile(file, { interval: 400 }, push);
            const ping = setInterval(() => res.write(': ping\n\n'), 20000);
            req.on('close', () => { fs.unwatchFile(file, push); clearInterval(ping); });
        }),
        'GET /api/council/file': guard((req, res, url) => {
            const root = project(url), slug = room(root, url.searchParams.get('slug'));
            const full = roomFile(root, slug, url.searchParams.get('path'));
            if (!full) return sendJson(res, 404, { success: false, message: 'not found' });
            // Seat-written files are untrusted: an SVG or HTML opened from here must not run script on the
            // dashboard origin (which can call every local API), so every file is served sandboxed.
            res.writeHead(200, { 'Content-Type': TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store',
                'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'", 'X-Content-Type-Options': 'nosniff' });
            res.end(fs.readFileSync(full));
        }),
        'POST /api/council/human': guard(async (req, res) => {
            const data = await readJsonBody(req);
            requireCapturedProject(data.projectRoot);
            const root = coordinationRoot(), slug = room(root, data.slug);
            const text = String(data.text || '').trim().slice(0, 4000);
            if (!text) throw new Error('Empty message.');
            sendJson(res, 200, { success: true, message: append(root, slug, { from: 'human', kind: 'discussion', text }) });
        }),
    };
}
