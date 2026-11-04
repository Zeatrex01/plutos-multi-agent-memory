// Real static/extension shell and local dashboard; owned records only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const app = fileURLToPath(new URL('../', import.meta.url));
const packaged = process.argv.includes('--packaged'), extension = process.argv.includes('--extension');
const clientRoot = path.join(app, packaged ? 'dist/browser-client' : 'browser-client');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-browser-client-'));
// The screenshots are for the person running this by hand, so they outlive the scratch folder.
const shots = path.join(os.tmpdir(), 'plutos-browser-client-screenshots'); fs.mkdirSync(shots, { recursive: true });
const root = path.join(scratch, 'project'); fs.mkdirSync(root);
fs.writeFileSync(path.join(root, 'PLUTOS_PROTOCOL.md'), '# Owned browser client fixture\n');
process.env.PLUTOS_HOME = path.join(scratch, 'hub');
process.env.PLUTOS_CLEAN_HARNESS = '1';
let server, context, browser, passed = 0;
const external = [], errors = [], diagnostics = [];
const check = (label, value) => { assert.ok(value, label); passed++; console.log(`PASS ${label}`); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
    const workspaces = await import('../lib/workspaces.mjs');
    workspaces.addWorkspace(root); workspaces.switchWorkspace(root); workspaces.installWorkspace(root);
    const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    // --no-open: a packaged copy opens the owner's browser otherwise (OPEN_BROWSER in dashboard.mjs).
    server = spawn(packaged ? path.join(app, 'dist/PLUT_OS.exe') : process.execPath, [...(packaged ? [] : [path.join(app, 'dashboard.mjs')]), '--no-open'], {
        cwd: packaged ? path.join(app, 'dist') : app, windowsHide: true,
        env: { ...process.env, PLUTOS_PORT: String(port) }, stdio: 'ignore'
    });
    for (let i = 0; i < 100; i++) {
        assert.equal(server.exitCode, null, 'Owned dashboard stays running.');
        try { if ((await fetch(origin + '/api/app/mode')).ok) break; } catch {}
        assert.ok(i < 99, 'Owned dashboard becomes ready.'); await pause(100);
    }
    const opened = await fetch(origin + '/api/workspaces/switch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: root })
    });
    assert.ok(opened.ok, 'Owned project opens through the actual dashboard API.');
    let page, shellUrl;
    if (extension) {
        context = await chromium.launchPersistentContext(path.join(scratch, 'profile'), { channel: 'chromium', headless: true,
            args: [`--disable-extensions-except=${clientRoot}`, `--load-extension=${clientRoot}`], viewport: { width: 1440, height: 960 } });
        const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        const id = new URL(worker.url()).host;
        check('real MV3 service worker has the action listener', await worker.evaluate(() => chrome.action.onClicked.hasListeners()));
        const permissions = await worker.evaluate(() => chrome.permissions.getAll());
        check('extension has no host or privileged permissions', !permissions.permissions.length && !permissions.origins.length);
        page = await context.newPage(); shellUrl = `chrome-extension://${id}/index.html`;
    } else {
        browser = await chromium.launch({ channel: 'chrome', headless: true });
        context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
        page = await context.newPage(); shellUrl = pathToFileURL(path.join(clientRoot, 'index.html')).href;
    }
    page.on('pageerror', error => errors.push(error.stack || error.message));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) diagnostics.push(message.text().slice(0, 400)); });
    page.on('requestfailed', request => diagnostics.push(`${request.url()} ${request.failure()?.errorText}`));
    const decide = async (control, decision) => {
        await page.bringToFront();
        const dialog = page.waitForEvent('dialog', { timeout: 5000 }).then(prompt => prompt[decision]());
        await Promise.all([dialog, control.click()]);
    };
    const closeView = async decision => {
        await page.locator('#close').click();
        await page.locator('#replace-confirmation').waitFor({ timeout: 5000 });
        await page.locator(`[data-view-discard="${decision === 'accept' ? 'discard' : 'keep'}"]`).click();
        await page.locator('#replace-confirmation').waitFor({ state: 'hidden' });
        if (decision === 'accept') await page.locator('iframe').waitFor({ state: 'detached' });
    };
    context.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) external.push(request.url()); });
    await page.goto(shellUrl);
    await page.evaluate(() => {
        window.__presenceMessages = [];
        window.addEventListener('message', event => {
            if (event.data?.type === 'plutos-local-presence') window.__presenceMessages.push(event.data);
        });
    });
    check('shell opens without contacting a local application', !await page.locator('iframe').count());
    await page.locator('#port').fill('0'); await page.locator('button[type="submit"]').click();
    check('invalid port cannot open a frame', !await page.locator('iframe').count() && (await page.locator('#status').innerText()).includes('1–65535'));
    const coldStart = performance.now();
    await page.locator('#port').fill(String(port)); await page.locator('button[type="submit"]').click();
    const frame = await page.locator('iframe').elementHandle().then(handle => handle.contentFrame());
    await frame.waitForFunction(() => window.activeWorkspacePath && window.switchView);
    await page.locator('#status[data-state="ready"]').waitFor();
    check('availability confirms the local host without claiming AI connection', (await page.locator('#status').innerText()).includes('approve the AI connections separately'));
    check('outer shell receives only availability and a probe ID', await page.evaluate(() => window.__presenceMessages.length > 0
        && window.__presenceMessages.every(data => Object.keys(data).sort().join(',') === 'id,ready,type')));
    await frame.evaluate(() => window.switchView('board'));
    await frame.locator('#board-container').waitFor();
    if (process.argv.includes('--profile-startup')) console.log(JSON.stringify({ startup: {
        uiReadyMs: Math.round(performance.now() - coldStart),
        ...await frame.evaluate(() => {
            const entries = performance.getEntriesByType('resource');
            return { resources: entries.length, apis: entries.filter(item => new URL(item.name).pathname.startsWith('/api/')).map(item => new URL(item.name).pathname),
                slowest: entries.sort((a, b) => b.duration - a.duration).slice(0, 12).map(item => ({ path: new URL(item.name).pathname, ms: Math.round(item.duration), waitMs: Math.round(item.responseStart - item.requestStart), bytes: item.encodedBodySize })) };
        })
    } }));
    check('cold startup does not preload hidden catalogs or Graphify', await frame.evaluate(() => !performance.getEntriesByType('resource')
        .some(item => ['/api/graphify', '/api/deck'].includes(new URL(item.name).pathname))));
    for (const [view, endpoint] of [['graphify', '/api/graphify']]) {
        const loaded = page.waitForResponse(response => new URL(response.url()).pathname === endpoint);
        await frame.evaluate(view => window.switchView(view), view);
        const response = await loaded;
        check(`${view} still loads through the actual view router on demand`, response.ok()
            && await frame.evaluate(view => [view, `view-${view}`].includes(document.querySelector('.view-section.active')?.id), view));
    }
    await frame.evaluate(() => window.switchView('board'));
    check('actual local dashboard retains the owned project', await frame.evaluate(expected => window.activeWorkspacePath === expected, root));
    check('outer shell cannot read the local project DOM', await page.evaluate(() => document.querySelector('iframe').contentDocument === null));
    await frame.evaluate(() => window.switchView('report'));
    const popupEvent = context.waitForEvent('page'); await frame.locator('#deck-link').click();
    const popup = await popupEvent; await popup.waitForLoadState('domcontentloaded');
    check('owner-clicked local Deck still opens in its own tab', new URL(popup.url()).origin === origin && new URL(popup.url()).pathname === '/deck');
    await popup.close();
    let releasePresence;
    await page.route('**/api/auth/status', async route => {
        await new Promise(resolve => { releasePresence = resolve; });
        await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    });
    const probing = page.waitForRequest(request => request.url() === origin + '/api/auth/status');
    await page.evaluate(() => { clearProbe(); probe(); }); await probing;
    await page.evaluate(expected => {
        const data = { type: 'plutos-local-presence', id: pending, ready: false };
        window.dispatchEvent(new MessageEvent('message', { source: document.querySelector('iframe').contentWindow, origin: expected, data: { ...data, id: 'wrong-probe' } }));
        window.dispatchEvent(new MessageEvent('message', { source: window, origin: expected, data }));
        window.dispatchEvent(new MessageEvent('message', { source: document.querySelector('iframe').contentWindow, origin: 'https://external.invalid', data }));
    }, origin);
    check('wrong probe, source and origin cannot change a pending connection status', await page.locator('#status').getAttribute('data-state') === 'ready');
    releasePresence();
    await page.locator('#status[data-state="unavailable"]').waitFor();
    check('unavailable host opens actionable help without replacing the frame', await page.locator('#connection-help').evaluate(node => node.open)
        && await page.locator('iframe').count() === 1);
    await page.unroute('**/api/auth/status');
    await page.locator('#status[data-state="ready"]').waitFor();
    for (const width of [1024, 1280, 1440]) {
        await page.setViewportSize({ width, height: 960 });
        check(`outer and embedded UI fit ${width}px`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth) && await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await closeView('dismiss');
    check('cancelled shell closure keeps the frame', await page.locator('iframe').count() === 1);
    await page.locator('button[type="submit"]').click(); await page.locator('#replace-confirmation').waitFor();
    check('replacement dialog focuses its safe choice and fits the viewport', await page.evaluate(() => document.activeElement?.dataset.viewDiscard === 'keep'
        && document.querySelector('#replace-confirmation').getBoundingClientRect().right <= innerWidth));
    await page.screenshot({ path: path.join(shots, 'PLUTOS-Browser-Replace-Confirmation.png'), fullPage: true });
    await page.keyboard.press('Escape'); await page.locator('#replace-confirmation').waitFor({ state: 'hidden' });
    check('Escape cancels replacement without closing the frame', await page.locator('iframe').count() === 1);
    await page.screenshot({ path: path.join(shots, extension ? 'PLUTOS-Chrome-Local-Client.png' : 'PLUTOS-Static-Local-Client.png'), fullPage: true });
    await closeView('accept');
    check('explicit shell closure removes the actual local frame', !await page.locator('iframe').count() && await page.locator('#welcome').isVisible());
    const guarded = await fetch(origin + '/api/workspaces', { headers: { Origin: 'https://external.invalid' } });
    check('local backend still rejects foreign-origin API requests', guarded.status === 403);
    await page.locator('button[type="submit"]').click();
    await page.locator('#status[data-state="ready"]').waitFor();
    const lastFrame = await page.locator('iframe').elementHandle().then(handle => handle.contentFrame());
    await lastFrame.waitForFunction(() => window.activeWorkspacePath && window.switchView);
    await lastFrame.evaluate(() => window.switchView('board'));
    const stopped = new Promise(resolve => server.once('exit', resolve)); server.kill(); await stopped;
    await page.locator('#status[data-state="unavailable"]').waitFor();
    // The open page lives in the address hash since Job 18 (#board); a hash is not navigation.
    check('actual host shutdown is shown without navigating away from the existing frame', lastFrame.url().split('#')[0] === origin + '/'
        && await page.locator('iframe').count() === 1);
    await page.screenshot({ path: path.join(shots, 'PLUTOS-Browser-Connection-Unavailable.png'), fullPage: true });
    await closeView('accept');
    check('closing an unavailable frame resets status', await page.locator('#status').getAttribute('data-state') === 'closed');
    check('real flow reports no external requests or browser errors', !external.length && !errors.length);
    console.log(JSON.stringify({ passed, extension, packaged, isolated: true, nativeTurns: 0, externalRequests: external.length, browserErrors: errors.length, screenshots: shots }));
} catch (error) {
    console.error(JSON.stringify({ diagnostics: diagnostics.slice(-8), browserErrors: errors, frames: context?.pages().flatMap(page => page.frames().map(frame => frame.url())) }));
    throw error;
} finally {
    await context?.close().catch(() => {}); await browser?.close().catch(() => {});
    if (server && server.exitCode === null && server.signalCode === null) { const stopped = new Promise(resolve => server.once('exit', resolve)); server.kill(); await stopped; }
    fs.rmSync(scratch, { recursive: true, force: true });
    console.log('Owned browser-client resources cleaned.');
}
