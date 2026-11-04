// The deferred list — IDEAS.md, read and appended next to the board.
//
// Why it sits with the board: the board answers "what is being worked on", and an idea that
// arrives mid-task is scope creep unless it has somewhere else to go. IDEAS.md is that
// somewhere — the AIs working the project already write to it (park the idea, keep going),
// but the owner could only read it by opening the file. A parking lot nobody looks at is a
// place ideas go to die, so it belongs on the screen the owner already watches.
//
// Same shape as the board: this module owns path + persistence, the pure text functions are
// exported separately so they stay trivially testable, and every written value goes through
// board.mjs's `flat` — a newline in an idea would otherwise forge a second bullet or a
// heading in a file that both git and every AI reads back.
import fs from 'fs';
import path from 'path';
import { splitLines, joinLines } from './lines.mjs';
import { fenceTracker, flat, FIELD_LIMITS } from './board.mjs';
import { updateFileAtomically } from './atomic.mjs';

const SEED = `# IDEAS — Deferred

Off-scope ideas are parked here instead of being lost or built now. One line each: the idea,
and why it is not being built yet. An idea that ships or is dropped leaves the file; git keeps it.
`;

// Bullets only — an idea is one line. Nested/indented bullets are detail under an idea, not
// ideas themselves, so the anchor is column zero.
const BULLET_RE = /^[-*]\s+(.*)$/;
const SECTION_RE = /^#{2,6}\s+(.*)$/;

// A struck-through idea, or one whose line records that it was promoted/shipped, is history
// that was left in the file: it reads as settled, not as pending work.
const SETTLED_RE = /^~~|→\s*(DONE|Promoted)/i;

// Resolve like boardPathFor: honour wherever the file already is, and default to the project
// root for a new one — that is where the doc convention puts it and what the README points at.
const CANDIDATES = [
    ['IDEAS.md'],
    ['docs', 'IDEAS.md'],
    ['docs', 'ai', 'IDEAS.md'],
    ['docs', 'handoff', 'IDEAS.md']
];

const IDEAS_NAME = /^ideas\.md$/i;

// Directory entries are read rather than existsSync'd for the fallback because the name may
// not be cased the way the candidate list spells it, and because a project that keeps the
// file somewhere else under docs/ still has one — telling the owner "no IDEAS.md yet" while
// their file sits two folders away is the one answer this must never give.
function findIdeasIn(dir) {
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isFile() && IDEAS_NAME.test(entry.name)) return path.join(dir, entry.name);
        }
    } catch (e) { /* unreadable or missing directory is simply not a match */ }
    return null;
}

export function ideasPathFor(projectRoot) {
    for (const rel of CANDIDATES) {
        const candidate = path.join(projectRoot, ...rel);
        if (fs.existsSync(candidate)) return candidate;
    }
    // Bounded on purpose: the root, docs/, and one level under docs/. Deeper than that and a
    // stray copy in a vendored folder would start winning over the real one.
    const docsDir = path.join(projectRoot, 'docs');
    const found = findIdeasIn(projectRoot) || findIdeasIn(docsDir);
    if (found) return found;
    try {
        for (const entry of fs.readdirSync(docsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const hit = findIdeasIn(path.join(docsDir, entry.name));
            if (hit) return hit;
        }
    } catch (e) { /* no docs/ folder: fall through to the default */ }
    return path.join(projectRoot, 'IDEAS.md');
}

// → [{ text, section, settled }] in file order. `section` is the nearest `##` heading above
// the idea ("" for the general list), which is how dated review batches keep their context.
export function parseIdeas(content) {
    const ideas = [];
    const inFence = fenceTracker();
    let section = '';
    for (const line of splitLines(content)) {
        if (inFence(line)) continue;   // a sample list inside ``` is documentation, not data
        const heading = line.match(SECTION_RE);
        if (heading) { section = heading[1].trim(); continue; }
        const bullet = line.match(BULLET_RE);
        if (!bullet) continue;
        const text = bullet[1].trim();
        if (!text) continue;
        ideas.push({ text, section, settled: SETTLED_RE.test(text) });
    }
    return ideas;
}

// Where a new idea goes: the end of the general list — the run of bullets before the first
// `##` section. Appending at the end of the file instead would file every new idea under
// whatever dated review section happens to be last, which is a claim about where it came
// from that nobody made.
function insertionPoint(lines) {
    const inFence = fenceTracker();
    let lastBullet = -1;
    let firstSection = -1;
    for (let i = 0; i < lines.length; i++) {
        if (inFence(lines[i])) continue;
        if (SECTION_RE.test(lines[i])) { firstSection = i; break; }
        if (BULLET_RE.test(lines[i])) lastBullet = i;
    }
    if (lastBullet >= 0) return { at: lastBullet + 1, spacer: false };
    // No general list yet: open one above the first section, or at the end of the file.
    if (firstSection >= 0) return { at: firstSection, spacer: true };
    return { at: -1, spacer: false };
}

// → { content, action: 'added' | 'exists' }
// Adding the same idea twice is not an error — it is the same idea. Reporting it as
// "exists" keeps the file free of near-duplicate lines that all say the same thing.
export function applyIdeaAdd(content, text) {
    if (text != null && typeof text !== 'string') {
        throw new Error(`idea must be a string, got ${Array.isArray(text) ? 'array' : typeof text}.`);
    }
    const idea = flat(text, FIELD_LIMITS.value);
    if (!idea) throw new Error('An idea needs some text.');

    const lines = splitLines(content);
    if (parseIdeas(content).some(i => i.text.toLowerCase() === idea.toLowerCase())) {
        return { content, action: 'exists' };
    }

    const { at, spacer } = insertionPoint(lines);
    if (at < 0) {
        if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
        lines.push(`- ${idea}`, '');
    } else {
        lines.splice(at, 0, `- ${idea}`, ...(spacer ? [''] : []));
    }
    return { content: joinLines(lines, content), action: 'added' };
}

// → { exists, path, rel, updatedAt, ideas }
// `rel` is what the panel shows: which file this list came from, or which one a first idea
// would create. "No IDEAS.md in this project" without naming a path is unanswerable.
export function readIdeas(projectRoot) {
    const filePath = ideasPathFor(projectRoot);
    const rel = path.relative(projectRoot, filePath).split(path.sep).join('/');
    if (!fs.existsSync(filePath)) return { exists: false, path: filePath, rel, ideas: [] };
    return {
        exists: true,
        path: filePath,
        rel,
        updatedAt: fs.statSync(filePath).mtime,
        ideas: parseIdeas(fs.readFileSync(filePath, 'utf8'))
    };
}

// → { action, path }. Seeds the file when the project has none, same as a first board entry.
export function addIdea(projectRoot, text) {
    const filePath = ideasPathFor(projectRoot);
    const action = updateFileAtomically(filePath, (content) => {
        const { content: updated, action } = applyIdeaAdd(content, text);
        return { content: updated, result: action };
    }, { seed: SEED });
    return { action, path: filePath };
}
