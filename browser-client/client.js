// The shell embeds the existing local UI; it never reads or forwards its records.
const form = document.getElementById('connection');
const portInput = document.getElementById('port');
const status = document.getElementById('status');
const welcome = document.getElementById('welcome');
const workspace = document.getElementById('workspace');
const close = document.getElementById('close');
const help = document.getElementById('connection-help');
let frame = null, pending = null, timer = null;
const showStatus = (state, text) => { status.dataset.state = state; status.textContent = text; };
function probe() {
    if (!frame || pending) return;
    const current = frame;
    pending = crypto.randomUUID();
    current.contentWindow.postMessage({ type: 'plutos-local-probe', id: pending }, new URL(current.src).origin);
    timer = setTimeout(() => {
        if (frame !== current) return;
        pending = null;
        showStatus('unavailable', 'The local PLUTOS does not answer. Check that the app is running and check its port; the view and drafts are kept.');
        help.open = true;
    }, 5000);
}
function clearProbe() { clearTimeout(timer); pending = null; }
window.addEventListener('message', event => {
    if (!frame || !pending || event.source !== frame.contentWindow || event.origin !== new URL(frame.src).origin
        || event.data?.type !== 'plutos-local-presence' || event.data.id !== pending || typeof event.data.ready !== 'boolean') return;
    clearProbe();
    if (event.data.ready) showStatus('ready', 'The local PLUTOS answers. Choose your project; approve the AI connections separately, inside it.');
    else {
        showStatus('unavailable', 'Cannot reach the local server. Restart PLUTOS and check its port; the open view was not refreshed.');
        help.open = true;
    }
});
setInterval(probe, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) probe(); });
const confirmation = document.getElementById('replace-confirmation');
confirmation.querySelectorAll('[data-view-discard]').forEach(button => button.addEventListener('click', () => confirmation.close(button.dataset.viewDiscard)));
const canReplace = async () => {
    if (!workspace.childElementCount) return true;
    confirmation.returnValue = 'keep';
    const answer = new Promise(resolve => confirmation.addEventListener('close', () => resolve(confirmation.returnValue === 'discard'), { once: true }));
    confirmation.showModal();
    return answer;
};
form.addEventListener('submit', async event => {
    event.preventDefault();
    const value = portInput.value.trim(), port = Number(value);
    if (!/^\d{1,5}$/.test(value) || port < 1 || port > 65535) {
        showStatus('unavailable', 'Enter a local port in the range 1–65535.'); portInput.focus(); return;
    }
    if (!await canReplace()) return;
    clearProbe();
    frame = document.createElement('iframe');
    frame.title = 'The PLUTOS workspace on this computer';
    frame.referrerPolicy = 'no-referrer';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-popups allow-popups-to-escape-sandbox');
    frame.src = `http://127.0.0.1:${port}/`;
    const openedFrame = frame;
    frame.addEventListener('load', () => { if (frame === openedFrame) { clearProbe(); probe(); } });
    workspace.replaceChildren(frame);
    welcome.hidden = true; workspace.hidden = false; close.hidden = false;
    showStatus('waiting', `Opening 127.0.0.1:${port}; waiting for the local PLUTOS to answer.`);
});
close.addEventListener('click', async () => {
    if (!await canReplace()) return;
    clearProbe(); frame = null;
    workspace.replaceChildren(); workspace.hidden = true; welcome.hidden = false; close.hidden = true;
    showStatus('closed', 'The local view is closed. To open it again, start the connection yourself.');
    portInput.focus();
});
