// Appends to CHANGELOG.md without anyone reading it. The file runs to
// tens of thousands of tokens, and an editor that must read a file before writing it read all of
// it to add one line. `plutos changelog <section> "<text>"` adds the line under ## [Unreleased].
import path from 'node:path';
import { updateFileAtomically } from './atomic.mjs';

// Keep a Changelog's sections, in its order.
export const CHANGELOG_SECTIONS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];

/** The changelog with `text` as the first bullet of `section` under ## [Unreleased]; the section
 *  and the Unreleased heading are created where they are missing, in Keep a Changelog's order. */
export function applyChangelogEntry(content, section, text) {
    if (!CHANGELOG_SECTIONS.includes(section)) throw new Error(`section must be one of: ${CHANGELOG_SECTIONS.join(', ')}`);
    const entry = String(text ?? '').trim().replace(/\s*\r?\n\s*/g, ' ');
    if (!entry) throw new Error('the entry text is required');
    const lines = String(content ?? '').split('\n');
    let unreleased = lines.findIndex(l => /^## \[Unreleased\]/i.test(l));
    if (unreleased < 0) {
        const firstRelease = lines.findIndex(l => /^## /.test(l));
        unreleased = firstRelease < 0 ? lines.length : firstRelease;
        lines.splice(unreleased, 0, '## [Unreleased]', '');
    }
    const next = lines.findIndex((l, i) => i > unreleased && /^## /.test(l));
    const end = next < 0 ? lines.length : next;
    const heading = lines.findIndex((l, i) => i > unreleased && i < end && l.trim() === `### ${section}`);
    if (heading >= 0) {
        lines.splice(heading + 1, 0, `- ${entry}`);
        return lines.join('\n');
    }
    let at = end;
    for (let i = unreleased + 1; i < end; i++) {
        const m = lines[i].match(/^### (\w+)/);
        if (m && CHANGELOG_SECTIONS.indexOf(m[1]) > CHANGELOG_SECTIONS.indexOf(section)) { at = i; break; }
    }
    lines.splice(at, 0, `### ${section}`, `- ${entry}`, '');
    return lines.join('\n');
}

export function addChangelogEntry(root, section, text) {
    const file = path.join(root, 'CHANGELOG.md');
    updateFileAtomically(file, content => ({ content: applyChangelogEntry(content, section, text), result: null }),
        { seed: '# Changelog\n\n## [Unreleased]\n' });
    return file;
}
