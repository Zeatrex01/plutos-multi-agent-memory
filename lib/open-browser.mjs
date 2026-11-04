// Opening the user's browser is the difference between "a server started" and "the app is
// open". Deliberately fire-and-forget: a machine with no default browser, a locked-down
// desktop, or a headless box must never take the dashboard down with it — the URL is still
// printed, and that is a working fallback.
import { spawn } from 'child_process';

export function openBrowser(url) {
    const [command, args] = process.platform === 'win32'
        // cmd's `start` treats a bare first quoted argument as the window title, so the empty
        // "" is required — without it a quoted URL becomes the title and nothing opens.
        ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin'
            ? ['open', [url]]
            : ['xdg-open', [url]];
    try {
        // detached + unref: the launcher must not keep a handle on the dashboard's lifetime,
        // and its own failure output must not land in the app's log.
        const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
        child.on('error', () => { /* no browser on this machine — the printed URL still works */ });
        child.unref();
        return true;
    } catch (e) {
        return false;
    }
}
