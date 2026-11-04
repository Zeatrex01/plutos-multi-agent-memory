// Escaping helpers for everything the UI renders through innerHTML.
//
// PLUT_OS renders content it did not write: board entries, roster rows and session logs come from
// markdown that AI agents edit, skill names are folder names read out of the target project, and
// code-index labels come from a generated file anyone can hand-edit. Interpolated raw, any of that
// becomes script running in the dashboard's own origin — which has unauthenticated access to every
// local API, so the Origin/Host allowlist happily waves it through.
//
// Both helpers existed already, in two modules each, and simply never propagated to the rest.
// They live here now so there is one place to import instead of one place to forget.

// For text landing inside markup or a quoted attribute.
export const escHtml = (v) => String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// For a value passed as an argument inside an inline onclick="fn('...')" handler. Percent-encoding
// leaves no quote, backslash or angle bracket that could close the handler early.
export const jsArg = (v) => `decodeURIComponent('${encodeURIComponent(String(v ?? '')).replace(/'/g, '%27')}')`;

// For a value used as an href. A link is not just text: `javascript:` in an href is a click away
// from executing, so anything that is not an ordinary document link is dropped.
const SAFE_HREF = /^(https?:|file:|mailto:|obsidian:|#|\/|\.{0,2}\/)/i;
export const escHref = (v) => {
    const raw = String(v ?? '').trim();
    return SAFE_HREF.test(raw) ? escHtml(raw) : '#';
};
