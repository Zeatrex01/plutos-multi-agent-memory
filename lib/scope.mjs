// Project scope ("this belongs at the centre, not in a module"): the project-scissors skill
// (`skills/project-scissors/SKILL.md`) keeps every project's scope and architecture in one page, `SCOPE.md` in the
// project's root. PLUT_OS reads that page for the session brief, so every AI in every client starts a task knowing
// whether the project is planned, how much of its appetite is left, and how many ideas are parked. It only reads;
// the skill and the owner write the page.
// It has no other PLUT_OS import, so the mini package (mini/, tools/pack-mini.mjs) ships this same file.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const SCOPE_FILE = 'SCOPE.md';
export const SCOPE_SKILL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'project-scissors', 'SKILL.md');
const DAY = 86_400_000;

/** What SCOPE.md says, or null when the project has none. Lenient: a field it cannot read is left out. */
export function readScope(projectRoot) {
    let text;
    try { text = fs.readFileSync(path.join(projectRoot, SCOPE_FILE), 'utf8'); } catch { return null; }
    const field = name => (text.match(new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`, 'mi')) || [])[1]?.trim() || '';
    const status = (field('Status').match(/\b(ACTIVE|PARKED|SHIPPED|ARCHIVED)\b/) || [])[1] || '';
    const stop = (field('Appetite').match(/hard stop\s+(\d{4}-\d{2}-\d{2})/i) || [])[1] || '';
    const architecture = /^\s*Architecture\b[^\n]*approved\s+\d{4}-\d{2}-\d{2}/mi.test(text);
    // "Later" items: the lines starting with "-" (or a number) under the Later heading, up to the next field.
    const later = text.split(/^\s*Later\b[^\n]*:\s*$/mi)[1]?.split(/^\s*(Done means|[A-Z][\w ]+:\s*$)/m)[0] || '';
    const parked = later.split('\n').filter(line => /^\s*(-|\d+\.)\s*\S/.test(line)).length;
    // The queue: the numbered lines under "In scope", in order; the first is next (open work
    // kept slipping because it lived in five places and no brief named what was next).
    const inScope = text.split(/^\s*In scope\b[^\n]*:\s*$/mi)[1]?.split(/^\S[^\n]*:/m)[0] || '';
    const queue = inScope.split('\n').map(line => (line.match(/^\s*\d+\.\s*(\S.*)$/) || [])[1]).filter(Boolean);
    return { status, stop, architecture, parked, queue };
}

/** The brief's scope lines: always one, so no AI starts work without knowing the project's scope state. */
export function scopeBriefLines(projectRoot, now = Date.now(), skillPath = SCOPE_SKILL) {
    // Inside the project (PLUT_OS itself) the skill is named relative to it, so the line does not change with the
    // folder the repository sits in; any other project gets the install's full path, which it needs to open the file.
    const rel = path.relative(projectRoot, skillPath);
    const skill = `\`${!rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : path.normalize(skillPath)}\``;
    const scope = readScope(projectRoot);
    if (!scope) return ['## Scope', `No \`SCOPE.md\`: PLAN first (${skill}).`, ''];
    const parts = [`Status ${scope.status || 'unknown'}`];
    if (scope.stop) {
        const left = Math.ceil((Date.parse(`${scope.stop}T23:59:59Z`) - now) / DAY);
        parts.push(left >= 0 ? `${left} day(s) of appetite left (hard stop ${scope.stop})` : `**appetite passed ${-left} day(s) ago** (${scope.stop}): CUT, then SHIP, re-scope or ARCHIVE`);
    }
    if (!scope.architecture) parts.push('no approved Architecture: PLAN first');
    if (scope.queue.length) {
        const next = scope.queue[0].length > 90 ? `${scope.queue[0].slice(0, 89)}…` : scope.queue[0];
        parts.push(`${scope.queue.length} in the queue, next: ${next}`);
    }
    if (scope.parked) parts.push(`${scope.parked} idea(s) parked in Later`);
    return ['## Scope', `\`SCOPE.md\`: ${parts.join(' · ')} (${skill}).`, ''];
}
