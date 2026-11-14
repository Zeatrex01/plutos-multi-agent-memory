// One comparable key per project root, so a card captured for one project is never applied to
// another (Windows drive letters and slashes fold together; a relative path is no key at all).
// Used by approvals.js and board.js before they act on something captured earlier.
const text = value => typeof value === 'string' ? value.trim() : '';

export function returnProjectKey(value) {
    const root = text(value);
    if (!root || root.length > 8192) return '';
    if (/^(?:[a-z]:[\\/]|\\\\|\/\/)/i.test(root)) {
        const normalized = root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        return /^[a-z]:$/.test(normalized) ? normalized + '/' : normalized;
    }
    return root.startsWith('/') ? root.replace(/\/+$/, '') || '/' : '';
}
