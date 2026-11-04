// Owner HTTP view and interactive controls for the research studio.
// The connected AI runs research through MCP (lib/research/mcp.mjs); the dashboard lets the
// owner inspect topics, read frozen source pages, trigger live fetches, manage branches,
// and install missing scraping/Chromium dependencies. The standalone research MCP package is built
// from the command line (node tools/make-research-mcp.mjs <folder> --zip), not from here.
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fetchPage, fetchRuntime } from './fetch.mjs';
import * as store from './store.mjs';

function fallbackReadJson(req) {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => {
            try { resolve(raw ? JSON.parse(raw) : {}); }
            catch (e) { reject(new Error('Invalid JSON body.')); }
        });
        req.on('error', reject);
    });
}

function findPython() {
    const candidates = process.platform === 'win32' ? [['python', []], ['py', ['-3']]] : [['python3', []], ['python', []]];
    for (const [cmd, prefix] of candidates) {
        const res = spawnSync(cmd, [...prefix, '-c', 'import sys; print(sys.version)'], { encoding: 'utf8', windowsHide: true });
        if (res.status === 0) return [cmd, ...prefix];
    }
    return null;
}

export function researchRoutes({ sendJson, readJsonBody = fallbackReadJson, getProjectRoot }) {
    const read = perform => (req, res, url) => {
        try { sendJson(res, 200, { success: true, ...perform(getProjectRoot(), url.searchParams) }); }
        catch (error) { sendJson(res, 400, { success: false, message: error.message }); }
    };
    const write = perform => async (req, res) => {
        try {
            const body = await readJsonBody(req);
            const result = await perform(getProjectRoot(), body || {});
            sendJson(res, 200, { success: true, ...result });
        } catch (error) {
            sendJson(res, 400, { success: false, message: error.message });
        }
    };

    return {
        'GET /api/research/topics': read(root => {
            const rt = fetchRuntime();
            return {
                webFetch: rt.available ? { available: true, scrapling: rt.scrapling } : { available: false, reason: rt.reason },
                topics: store.listTopics(root)
            };
        }),
        'GET /api/research/topic': read((root, query) => {
            const id = query.get('id');
            const topic = store.readTopicFull(root, id);
            const status = store.topicStatus(root, id);
            return {
                topic: { ...topic, findings: topic.findings.slice(-200) },
                status: { gaps: status.gaps, ready: status.ready, pagesUsed: status.pagesUsed },
                brief: store.topicBrief(root, id).markdown
            };
        }),
        'GET /api/research/source': read((root, query) => {
            const topicId = query.get('topicId');
            const sourceId = query.get('sourceId');
            const offset = Number(query.get('offset') || 0);
            const length = Number(query.get('length') || 30_000);
            return store.readSourceText(root, topicId, sourceId, { offset, length });
        }),
        'POST /api/research/topic': write((root, body) => {
            const topic = store.startTopic(root, {
                title: body.title,
                question: body.question,
                goal: body.goal,
                pages: body.pages,
                depth: body.depth
            });
            return { topic };
        }),
        'POST /api/research/branch': write((root, body) => {
            if (body.action === 'close') {
                const branch = store.setBranchStatus(root, body.topicId, {
                    branchId: body.branchId,
                    status: body.status || 'answered',
                    note: body.note
                });
                return { branch };
            }
            const branch = store.addBranch(root, body.topicId, {
                question: body.question,
                parentId: body.parentId,
                why: body.why
            });
            return { branch };
        }),
        'POST /api/research/fetch': write(async (root, body) => {
            store.topicStatus(root, body.topicId);
            const page = await fetchPage(body.url, {
                cacheDir: store.cacheDir(root),
                fresh: body.fresh !== false,
                render: body.render === true
            });
            const { source, duplicate } = store.addSource(root, body.topicId, page, { branchId: body.branchId || null });
            return { source, duplicate, cached: page.cached, rendered: page.rendered };
        }),
        'POST /api/research/install': write((_root, body) => {
            const py = findPython();
            if (!py) throw new Error('Python 3.10+ not found on this machine.');
            const [bin, ...prefix] = py;
            const pip = spawnSync(bin, [...prefix, '-m', 'pip', 'install', 'scrapling[fetchers]', 'markdownify', 'protego', 'playwright'], {
                encoding: 'utf8',
                windowsHide: true,
                timeout: 180_000
            });
            if (pip.status !== 0) throw new Error((pip.stderr || pip.stdout || 'pip install failed').slice(-300));
            if (body.chromium !== false) {
                const pw = spawnSync(bin, [...prefix, '-m', 'playwright', 'install', 'chromium'], {
                    encoding: 'utf8',
                    windowsHide: true,
                    timeout: 300_000
                });
                if (pw.status !== 0) throw new Error((pw.stderr || pw.stdout || 'playwright install chromium failed').slice(-300));
            }
            return { runtime: fetchRuntime({ refresh: true }) };
        })
    };
}
