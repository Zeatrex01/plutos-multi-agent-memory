// Settings → Updates ("the portable desktop app has no place to check for
// updates"). Two routes about this PLUT_OS install (`root`, APP_ROOT), never the open project, so
// neither is in lib/route-policy.mjs's project sets.
//
//   GET  /api/update          the last check, kept in memory with its time; no network.
//                             { state: 'unchecked' } until the first check.
//   GET  /api/update?check=1  checks now. A git checkout asks git (`git fetch`, nothing changes); a
//                             packaged build, or a copy that is not a git checkout of its own, asks
//                             GitHub for its newest release.
//        → { kind: 'checkout'|'submodule'|'packaged', state, behind?, ahead?, message, current?,
//            latest?, url?, token?, checkedAt }
//   POST /api/update {token}  a checkout that the check found behind fast-forwards (lib/update.mjs
//                             updatePlutos, which refuses local changes and divergence). The token
//                             binds it to the commits that check saw: HEAD or the upstream moved
//                             since → refused. Refused too: a packaged build (400: download the new
//                             version), a submodule (409: `plutos update` in a terminal, the
//                             superproject decides its commit), development mode (409: the checkout
//                             being edited), a second update while one runs (409).
//
// The network is used only on the owner's button (Settings → Check for updates). git and npm run
// in a child process (updateInChild), so the dashboard keeps answering while they do.
import { randomUUID } from 'node:crypto';
import { latestRelease, updateInChild } from './update.mjs';

/**
 * `packaged`: a built copy (PLUTOS_PACKAGED); `devMode`: lib/run-mode.mjs development mode. `run`
 * and `release` stand in for updateInChild and latestRelease in a test.
 */
export function updateRoutes({ sendJson, readJsonBody, root, packaged = false, devMode = false, run = updateInChild, release = latestRelease }) {
    let last = null;      // the last check's answer, with checkedAt
    let checked = null;   // { token, from, to } of the last check that found a checkout behind
    let running = false;
    const fromRelease = async () => ({ kind: 'packaged', ...(await release({ root })) });

    async function check() {
        checked = null;
        let answer;
        const r = packaged ? { kind: 'packaged' } : await run(root, { check: true });
        // A copy without git of its own (a downloaded zip, a built dist/) updates like a packaged build.
        if (r.kind === 'packaged') answer = await fromRelease();
        else if (r.state === 'error') answer = { kind: 'checkout', state: 'error', message: r.message };
        else {
            // updatePlutos says up-to-date for a check that found new commits: it changed nothing.
            const behind = r.kind === 'checkout' && r.state === 'up-to-date' && r.behind > 0;
            answer = { kind: r.kind, state: behind ? 'behind' : r.state, behind: r.behind ?? 0, ahead: r.ahead ?? 0, message: r.description || r.message || '' };
            if (behind) {
                checked = { token: randomUUID(), from: r.from, to: r.target };
                answer.token = checked.token;
            }
        }
        last = { ...answer, checkedAt: new Date().toISOString() };
        return last;
    }

    return {
        'GET /api/update': async (req, res, url) => {
            if (url?.searchParams.get('check') !== '1') {
                return sendJson(res, 200, last || { kind: packaged ? 'packaged' : 'checkout', state: 'unchecked', message: 'Not checked yet.' });
            }
            if (running) return sendJson(res, 409, { success: false, state: 'running', message: 'An update is running; check again when it has finished.' });
            sendJson(res, 200, await check());
        },
        'POST /api/update': async (req, res) => {
            const refuse = (status, body) => sendJson(res, status, { success: false, ...body });
            if (packaged || last?.kind === 'packaged') {
                return refuse(400, { kind: 'packaged', state: 'packaged', url: last?.url || '',
                    message: 'This PLUT_OS cannot update itself: download the new version from the release page.' });
            }
            if (devMode) return refuse(409, { state: 'refused', message: 'Development mode runs the checkout being edited: update it with git there.' });
            if (last?.kind === 'submodule') {
                return refuse(409, { kind: 'submodule', state: 'refused', message: 'PLUT_OS runs here as a submodule: run plutos update in a terminal, where the superproject decides which commit runs.' });
            }
            if (running) return refuse(409, { state: 'running', message: 'An update is already running.' });
            const input = await readJsonBody(req, { fallback: {} });
            if (!checked || typeof input.token !== 'string' || input.token !== checked.token) {
                return refuse(409, { state: 'refused', message: 'Check for updates first: an update applies the commits a check found.' });
            }
            running = true;
            const expect = { from: checked.from, to: checked.to };
            checked = null;
            try {
                const r = await run(root, { check: false, expect });
                const ok = r.state !== 'refused' && r.state !== 'error';
                // The old answer no longer holds; the next check starts fresh.
                last = null;
                sendJson(res, ok ? 200 : 409, { success: ok, kind: r.kind || 'checkout', state: r.state, behind: r.behind ?? 0,
                    restart: r.state === 'updated', message: r.description || r.message || '' });
            } finally { running = false; }
        },
    };
}
