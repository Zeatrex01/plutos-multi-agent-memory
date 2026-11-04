// Transient notification in the bottom-right corner, in the same style as the orbit's connect
// notices (ui/modules/orbit.js): a glass card with a coloured dot and edge.
//
// The second argument started as a boolean `isError`, and most callers still pass one. But
// 29 call sites across nine modules pass a VARIANT STRING instead — showToast(msg, 'success')
// — and every non-empty string is truthy, so every one of those, success included, painted
// itself red. Rather than correct 29 sites and wait for the 30th, the parameter now accepts
// either form: `true` still means error, and a variant name means what it says.
const TOAST_COLORS = {
    error: 'var(--status-error)',
    warning: 'var(--status-todo)',
    info: 'var(--status-progress)',
    success: 'var(--status-done)'
};

// At most this many on screen: a burst of toasts used to pile six deep on the same corner.
const MAX_TOASTS = 3;

export function showToast(message, variant = false) {
    const named = typeof variant === 'string' ? variant.toLowerCase() : '';
    const kind = named ? (TOAST_COLORS[named] ? named : 'success') : (variant ? 'error' : 'success');
    const shown = document.querySelectorAll('.app-toast');
    for (let i = 0; i <= shown.length - MAX_TOASTS; i++) shown[i].remove();   // the oldest leave first
    const toast = document.createElement('div');
    toast.className = 'app-toast';
    toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    // cssText, appendChild and a guarded frame callback: plain DOM calls the smoke test's stub page has too.
    toast.style.cssText = `--toast:${TOAST_COLORS[kind]}`;
    const dot = document.createElement('i');
    const text = document.createElement('span');
    text.innerText = message;
    toast.appendChild(dot); toast.appendChild(text);
    // One fixed stack in the corner, newest at the bottom, so several toasts read one above
    // the other instead of on top of each other.
    let stack = document.getElementById('toast-stack');
    if (!stack) { stack = document.createElement('div'); stack.id = 'toast-stack'; stack.className = 'toast-stack'; document.body.appendChild(stack); }
    stack.appendChild(toast);
    (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : f => setTimeout(f, 16))(() => toast.classList.add('in'));
    setTimeout(() => {
        toast.classList.remove('in');
        setTimeout(() => toast.remove(), 350);
    }, kind === 'error' ? 5000 : 3000);
}
