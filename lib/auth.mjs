// Who may talk to the dashboard: the owner at this computer, nobody else.
//
// The server binds 127.0.0.1 only (dashboard.mjs), so the socket itself keeps the LAN out. The
// three checks here close what loopback alone leaves open, and they live together so a reader
// finds the whole rule in one place:
//   - isLoopback: the socket address is 127.0.0.1 or ::1 (Node reports IPv4 clients on a
//     dual-stack socket as "::ffff:1.2.3.4"; without stripping that prefix a plain 127.0.0.1
//     request over IPv6 would read as remote).
//   - isLocalRequest: the Host header, and Origin when a browser sends one, name this server
//     (DNS rebinding and cross-site requests arrive on loopback too).
//   - isLocalOwner: loopback and no forwarding header. A tunnel or reverse proxy in front of
//     the dashboard (Tailscale Serve, cloudflared, nginx, ngrok) also connects from loopback, so
//     any forwarding header makes the request remote; loopback alone never stands in for "the
//     owner is at the desk". A header counts when present at all, even empty.
// There is no password, session or device list: a request that fails these is refused, and
// nothing can be presented to pass instead.

export function isLoopback(remoteAddress) {
    if (!remoteAddress) return false;
    const addr = remoteAddress.startsWith('::ffff:') ? remoteAddress.slice(7) : remoteAddress;
    return addr === '127.0.0.1' || addr === '::1';
}

// The only names this server answers to. Fixed: the dashboard never binds beyond loopback.
export function allowedHosts(port) {
    return [`localhost:${port}`, `127.0.0.1:${port}`];
}

// Host and Origin must be this server. Non-browser tools like curl send no Origin and stay
// allowed; a browser's cross-site fetch or form carries one and is refused.
export function isLocalRequest(req, port) {
    const hosts = allowedHosts(port);
    const host = (req.headers.host || '').toLowerCase();
    if (!hosts.includes(host)) return false;
    const origin = (req.headers.origin || '').toLowerCase();
    if (origin && !hosts.map(h => `http://${h}`).includes(origin)) return false;
    return true;
}

export const FORWARDING_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'tailscale-user-login', 'cf-connecting-ip'];

export function isLocalOwner(req) {
    return isLoopback(req.socket.remoteAddress) && !FORWARDING_HEADERS.some(h => req.headers[h] !== undefined);
}
