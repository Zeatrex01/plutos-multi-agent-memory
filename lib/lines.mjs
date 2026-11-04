// Line-ending preservation for the coordination files.
//
// Every writer here follows the same shape: read the file, split on /\r?\n/, edit the array,
// join with '\n'. On Windows that last step rewrites CRLF as LF across the WHOLE file, so a
// one-word status change shows up in git as "every line modified". For files whose entire
// purpose is being committed and read by a team, that is not cosmetic — it buries the real
// change, and it makes PLUT_OS look like it is rewriting things it was not asked to touch.
//
// The rule is simply: give the file back the endings it came with.
export const CRLF = '\r\n';
export const LF = '\n';

// A file can legitimately mix endings (hand-edited on two machines, or a merge). Majority
// wins so a single stray line does not flip the whole file, and LF is the tiebreak — it is
// what a brand-new file from a seed template gets.
export function eolOf(content) {
    if (!content) return LF;
    const crlf = (content.match(/\r\n/g) || []).length;
    // Count LFs that are NOT part of a CRLF pair.
    const total = (content.match(/\n/g) || []).length;
    return crlf > total - crlf ? CRLF : LF;
}

export function splitLines(content) {
    return String(content ?? '').split(/\r?\n/);
}

// Join `lines` using the line ending `original` was written with. Pass the ORIGINAL file
// content, not the edited array — that is the whole point.
export function joinLines(lines, original) {
    return lines.join(eolOf(original));
}
