// Owner-facing management views and explicit, project-bound repair transactions.
import fs from 'node:fs';
import path from 'node:path';
import * as workspaces from './workspaces.mjs';
import { parseBoardEntries } from './board.mjs';
import { boardPathForTier } from './board-store.mjs';
import { listApprovals } from './approvals.mjs';
import { sameProjectPath } from './project-binding.mjs';
import { previewProjectRepair, applyProjectRepair, restoreProjectRepair } from './repair.mjs';

function selectedProject(expected) {
    const active = workspaces.getActiveWorkspace();
    if (!active) throw new Error('Select a project first.');
    if (expected && (typeof expected !== 'string' || !path.isAbsolute(expected) || !sameProjectPath(active, expected))) {
        throw new Error('The selected project changed. Reopen this view before continuing.');
    }
    return fs.realpathSync(active);
}

export function assertBoardProject(data) {
    if ((data.verification !== undefined || data.evidence !== undefined) && !data.projectRoot) {
        throw new Error('A projectRoot is required when recording verification.');
    }
    return selectedProject(data.projectRoot);
}

export function projectCoordinationRoot(root) {
    const active = workspaces.getActiveWorkspace();
    const registered = active && sameProjectPath(active, root) ? active
        : workspaces.getWorkspaces().find(candidate => sameProjectPath(candidate, root));
    return workspaces.getCoordinationRoot(registered || root);
}

function entriesFor(root, board) {
    const file = boardPathForTier(projectCoordinationRoot(root), board);
    return fs.existsSync(file) ? parseBoardEntries(fs.readFileSync(file, 'utf8')) : [];
}

function readEvidence(root, evidence) {
    if (typeof evidence === 'string') evidence = evidence.replace(/\\/g, '/').replace(/^\.\//, '');
    const media = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf' };
    const contentType = media[path.extname(evidence || '').toLowerCase()] || 'text/plain; charset=utf-8';
    const limit = contentType.startsWith('text/') ? 256 * 1024 : 8 * 1024 * 1024;
    if (typeof evidence !== 'string' || !evidence || path.isAbsolute(evidence)
        || evidence.includes('\\') || evidence.split('/').some(p => !p || p === '..' || p.startsWith('.'))
        || !/\.(md|txt|log|json|csv|png|jpg|jpeg|webp|pdf)$/i.test(evidence)) {
        throw new Error('Evidence must reference a project-relative text, PNG/JPEG/WebP image or PDF artifact.');
    }
    // Observe-only board artifacts may live in the Hub sidecar, not the source tree.
    const roots = [...new Set([root, projectCoordinationRoot(root)])];
    for (const base of roots) {
        const candidate = path.resolve(base, evidence);
        if (!fs.existsSync(candidate)) continue;
        const real = fs.realpathSync(candidate), canonicalBase = fs.realpathSync(base);
        const relative = path.relative(canonicalBase, real);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Evidence leaves the project directory.');
        const fd = fs.openSync(real, 'r');
        try {
            const stat = fs.fstatSync(fd);
            if (!stat.isFile() || stat.size > limit) throw new Error('Evidence exceeds the preview limit (256 KiB text; 8 MiB image/PDF).');
            const buffer = Buffer.alloc(stat.size + 1);
            const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
            if (bytes !== stat.size || fs.fstatSync(fd).size !== stat.size) throw new Error('Evidence changed while being read. Try again.');
            return { body: buffer.subarray(0, bytes), contentType };
        } finally { fs.closeSync(fd); }
    }
    throw new Error('The referenced evidence file was not found.');
}

export function managementRoutes({ sendJson, readJsonBody }) {
    const fail = (res, error) => sendJson(res, error.statusCode || (/changed|stale|conflict|no longer/i.test(error.message) ? 409 : 400),
        { success: false, message: error.message });
    return {
        'GET /api/return-summary': (req, res) => {
            try {
                const expected = new URL(req.url, 'http://localhost').searchParams.get('project');
                if (!expected) throw new Error('A project is required for the return summary.');
                const projectRoot = selectedProject(expected);
                const entries = ['main', 'agents'].flatMap(board => entriesFor(projectRoot, board).map(e => ({ ...e, board })));
                sendJson(res, 200, { projectRoot, capturedAt: new Date().toISOString(), entries,
                    pendingApprovals: listApprovals(projectCoordinationRoot(projectRoot)) });
            } catch (error) { fail(res, error); }
        },
        'GET /api/board/evidence': (req, res) => {
            try {
                const query = new URL(req.url, 'http://localhost').searchParams;
                if (!query.get('project')) throw new Error('An evidence project is required.');
                const root = selectedProject(query.get('project'));
                const board = query.get('board');
                if (!['main', 'agents'].includes(board)) throw new Error('Unknown evidence board.');
                const entry = entriesFor(root, board).find(e => e.agent === query.get('agent') && e.title === query.get('title'));
                if (!entry) throw new Error('The task was not found on this project board.');
                const evidence = readEvidence(root, entry.evidence || entry.fields.Evidence);
                res.writeHead(200, { 'Content-Type': evidence.contentType, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
                res.end(evidence.body);
            } catch (error) { fail(res, error); }
        },
        'GET /api/workspaces/repair/preview': (req, res) => {
            try {
                const target = new URL(req.url, 'http://localhost').searchParams.get('project');
                if (!target) throw new Error('Choose the exact project to preview.');
                sendJson(res, 200, { success: true, ...previewProjectRepair(target) });
            } catch (error) { fail(res, error); }
        },
        'POST /api/workspaces/repair': async (req, res) => {
            try {
                const input = await readJsonBody(req);
                if (!input.projectRoot || !input.token) throw new Error('Preview this project repair before applying it.');
                const result = applyProjectRepair(input);
                sendJson(res, result.success ? 200 : 409, result);
            } catch (error) { fail(res, error); }
        },
        'POST /api/workspaces/repair/restore': async (req, res) => {
            try {
                const result = restoreProjectRepair(await readJsonBody(req));
                sendJson(res, result.success ? 200 : 409, result);
            } catch (error) { fail(res, error); }
        }
    };
}
