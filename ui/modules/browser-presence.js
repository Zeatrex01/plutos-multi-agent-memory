// The outer shell receives availability only, never project content or sharing authority.
export function startBrowserPresence() {
    if (window.parent === window || location.hostname !== '127.0.0.1') return;
    let checking = false;
    window.addEventListener('message', async event => {
        if (event.source !== window.parent || event.data?.type !== 'plutos-local-probe'
            || typeof event.data.id !== 'string' || event.data.id.length > 64 || checking) return;
        checking = true;
        let ready = false;
        try {
            const response = await fetch('/api/auth/status', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
            ready = response.ok;
            await response.text();
        } catch {} finally { checking = false; }
        event.source.postMessage({ type: 'plutos-local-presence', id: event.data.id, ready }, event.origin === 'null' ? '*' : event.origin);
    });
}
