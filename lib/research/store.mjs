// Research studio records: one topic per folder under <project>/.plutos/research/<topicId>/.
//
//   topic.json            question tree, sources (metadata), findings, principles, open questions
//   sources/<id>.md       the exact text of each fetched page, frozen at fetch time
//
// The rules that make this research rather than recollection are enforced here, not asked of
// the AI: a finding must cite a fetched source, every quote it carries must appear verbatim in
// that source's frozen text, a principle must rest on findings, a branch is only "answered"
// with a finding under it, and depth and page budgets are hard limits.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { updateFileAtomically } from '../atomic.mjs';

export const LIMITS = { topics: 200, branches: 60, findings: 300, principles: 60, openQuestions: 60, images: 150,
    pagesDefault: 30, pagesMax: 120, depthDefault: 3, depthMax: 5, quotes: 4 };
const STATUSES = ['open', 'answered', 'dead_end'];

const researchRoot = root => path.join(root, '.plutos', 'research');
const topicDir = (root, id) => path.join(researchRoot(root), safeId(id));
const topicFile = (root, id) => path.join(topicDir(root, id), 'topic.json');
export const sourceFile = (root, topicId, sourceId) => path.join(topicDir(root, topicId), 'sources', `${safeId(sourceId)}.md`);
export const cacheDir = root => path.join(researchRoot(root), '_cache');
export const imagesDir = (root, topicId) => path.join(topicDir(root, topicId), 'images');

const newId = prefix => `${prefix}-${crypto.randomBytes(5).toString('hex')}`;
function safeId(id) {
    if (typeof id !== 'string' || !/^[a-z]+-[a-f0-9]{10}$/.test(id)) throw new Error('Unknown id.');
    return id;
}
function text(value, label, max, { optional = false } = {}) {
    const clean = typeof value === 'string' ? value.replace(/\u0000/g, '').trim() : '';
    if (!clean && !optional) throw new Error(`${label} is required.`);
    if (clean.length > max) throw new Error(`${label} is longer than ${max} characters.`);
    return clean;
}
// Quotes are matched on whitespace-collapsed, case-folded text: markdown wraps lines and
// the AI re-types spacing, but the words must be the source's own.
const squash = value => String(value).replace(/[*_`#>\[\]]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

function readTopic(root, id) {
    try { return JSON.parse(fs.readFileSync(topicFile(root, id), 'utf8')); }
    catch { throw new Error('No such research topic.'); }
}
function mutateTopic(root, id, change) {
    const file = topicFile(root, id);
    if (!fs.existsSync(file)) throw new Error('No such research topic.');
    return updateFileAtomically(file, raw => {
        const topic = JSON.parse(raw);
        const result = change(topic);
        topic.updatedAt = Date.now();
        topic.revision = (topic.revision || 0) + 1;
        return { content: JSON.stringify(topic, null, 2), result };
    });
}

export function listTopics(root) {
    let names = [];
    try { names = fs.readdirSync(researchRoot(root)).filter(name => /^topic-[a-f0-9]{10}$/.test(name)); } catch { return []; }
    return names.map(name => { try { return readTopic(root, name); } catch { return null; } }).filter(Boolean)
        .map(t => ({ id: t.id, title: t.title, question: t.question, createdAt: t.createdAt, updatedAt: t.updatedAt,
            branches: t.branches.length, open: t.branches.filter(b => b.status === 'open').length,
            sources: t.sources.length, findings: t.findings.length, principles: t.principles.length }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function startTopic(root, { title, question, goal, pages, depth }) {
    if (listTopics(root).length >= LIMITS.topics) throw new Error('Research topic budget reached; archive old topics first.');
    const pageBudget = pages === undefined ? LIMITS.pagesDefault : Number(pages);
    const depthBudget = depth === undefined ? LIMITS.depthDefault : Number(depth);
    if (!Number.isInteger(pageBudget) || pageBudget < 1 || pageBudget > LIMITS.pagesMax) throw new Error(`Page budget must be 1-${LIMITS.pagesMax}.`);
    if (!Number.isInteger(depthBudget) || depthBudget < 1 || depthBudget > LIMITS.depthMax) throw new Error(`Depth must be 1-${LIMITS.depthMax}.`);
    const now = Date.now();
    const topic = { id: newId('topic'), title: text(title, 'Title', 120), question: text(question, 'Question', 1000),
        goal: text(goal, 'Goal', 1000, { optional: true }), budget: { pages: pageBudget, depth: depthBudget },
        createdAt: now, updatedAt: now, revision: 1, branches: [], sources: [], findings: [], principles: [], openQuestions: [] };
    fs.mkdirSync(path.join(topicDir(root, topic.id), 'sources'), { recursive: true });
    fs.writeFileSync(topicFile(root, topic.id), JSON.stringify(topic, null, 2));
    return topic;
}

export function addBranch(root, topicId, { question, parentId, why }) {
    return mutateTopic(root, topicId, topic => {
        if (topic.branches.length >= LIMITS.branches) throw new Error('Branch budget reached; close or merge branches first.');
        const parent = parentId ? topic.branches.find(b => b.id === parentId) : null;
        if (parentId && !parent) throw new Error('Parent branch not found.');
        const depth = parent ? parent.depth + 1 : 1;
        if (depth > topic.budget.depth) throw new Error(`Depth budget is ${topic.budget.depth}; answer this at the current level or raise the budget when starting.`);
        const branch = { id: newId('branch'), parentId: parent?.id || null, depth, question: text(question, 'Branch question', 500),
            why: text(why, 'Why', 500, { optional: true }), status: 'open', note: '', createdAt: Date.now() };
        topic.branches.push(branch);
        return branch;
    });
}

export function setBranchStatus(root, topicId, { branchId, status, note }) {
    if (!STATUSES.includes(status)) throw new Error(`Status must be one of ${STATUSES.join(', ')}.`);
    return mutateTopic(root, topicId, topic => {
        const branch = topic.branches.find(b => b.id === branchId);
        if (!branch) throw new Error('Branch not found.');
        if (status === 'answered' && !topic.findings.some(f => f.branchId === branchId)) throw new Error('A branch is answered only once a finding under it cites a source.');
        if (status === 'dead_end' && !text(note, 'Note', 500, { optional: true })) throw new Error('Say why this branch is a dead end.');
        Object.assign(branch, { status, note: text(note, 'Note', 500, { optional: true }) });
        return branch;
    });
}

// Records a fetched page as a source. The page text is frozen to sources/<id>.md so quotes are
// checked against what was actually read, even after the live page changes.
export function addSource(root, topicId, page, { branchId } = {}) {
    return mutateTopic(root, topicId, topic => {
        const existing = topic.sources.find(s => s.hash === page.hash && s.url === page.url);
        if (existing) return { source: existing, duplicate: true };
        const sameUrl = topic.sources.find(s => s.url === page.url);
        if (sameUrl) {
            Object.assign(sameUrl, { finalUrl: page.finalUrl, title: String(page.title || sameUrl.title || '').slice(0, 300), fetchedAt: page.fetchedAt, hash: page.hash, chars: page.markdown.length, truncated: !!page.truncated, branchId: branchId || sameUrl.branchId || null });
            fs.mkdirSync(path.dirname(sourceFile(root, topicId, sameUrl.id)), { recursive: true });
            fs.writeFileSync(sourceFile(root, topicId, sameUrl.id), page.markdown);
            return { source: sameUrl, duplicate: false };
        }
        if (topic.sources.length >= topic.budget.pages) throw new Error(`Page budget of ${topic.budget.pages} reached; synthesize what you have or start a topic with a larger budget.`);
        if (branchId && !topic.branches.some(b => b.id === branchId)) throw new Error('Branch not found.');
        const source = { id: newId('source'), url: page.url, finalUrl: page.finalUrl, title: String(page.title || '').slice(0, 300),
            fetchedAt: page.fetchedAt, hash: page.hash, chars: page.markdown.length, truncated: !!page.truncated, branchId: branchId || null };
        fs.mkdirSync(path.dirname(sourceFile(root, topicId, source.id)), { recursive: true });
        fs.writeFileSync(sourceFile(root, topicId, source.id), page.markdown);
        topic.sources.push(source);
        return { source, duplicate: false };
    });
}

// Records images saved from a page (lib/research/fetch.mjs fetchImages). The files are already in
// images/ under their own hash; the record keeps where each came from, so an image in a brief can be
// traced to its page. A page of images does not use the page budget, but the topic has its own cap.
export function addImages(root, topicId, pageUrl, images, { branchId } = {}) {
    return mutateTopic(root, topicId, topic => {
        topic.images ||= [];
        if (branchId && !topic.branches.some(b => b.id === branchId)) throw new Error('Branch not found.');
        const added = [];
        for (const image of images) {
            const existing = topic.images.find(item => item.sha256 === image.sha256);
            if (existing) { added.push(existing); continue; }
            if (topic.images.length >= LIMITS.images) break;
            const record = { id: newId('image'), pageUrl, url: image.url, file: `images/${image.file}`, bytes: image.bytes,
                type: image.type, sha256: image.sha256, fetchedAt: Date.now(), branchId: branchId || null };
            topic.images.push(record);
            added.push(record);
        }
        return { images: added, total: topic.images.length };
    });
}

export function readSourceText(root, topicId, sourceId, { offset = 0, length = 12_000 } = {}) {
    const topic = readTopic(root, topicId);
    const source = topic.sources.find(s => s.id === sourceId);
    if (!source) throw new Error('Source not found.');
    const body = fs.readFileSync(sourceFile(root, topicId, sourceId), 'utf8');
    const start = Math.max(0, Number(offset) || 0), size = Math.min(Math.max(1, Number(length) || 12_000), 30_000);
    return { source, text: body.slice(start, start + size), offset: start, nextOffset: start + size < body.length ? start + size : null, total: body.length };
}

export function addFinding(root, topicId, { branchId, claim, sourceIds, quotes = [] }) {
    const ids = Array.isArray(sourceIds) ? [...new Set(sourceIds)] : [];
    if (!ids.length) throw new Error('A finding must cite at least one fetched source.');
    if (!Array.isArray(quotes) || quotes.length > LIMITS.quotes) throw new Error(`Up to ${LIMITS.quotes} quotes per finding.`);
    return mutateTopic(root, topicId, topic => {
        if (topic.findings.length >= LIMITS.findings) throw new Error('Finding budget reached; merge findings into principles.');
        if (!topic.branches.some(b => b.id === branchId)) throw new Error('Branch not found.');
        for (const id of ids) if (!topic.sources.some(s => s.id === id)) throw new Error(`Source ${id} was never fetched in this topic.`);
        const checked = quotes.map(q => {
            const sourceId = q?.sourceId, quote = text(q?.text, 'Quote', 600);
            if (!ids.includes(sourceId)) throw new Error('A quote must come from one of the cited sources.');
            const body = fs.readFileSync(sourceFile(root, topicId, sourceId), 'utf8');
            if (!squash(body).includes(squash(quote))) throw new Error(`Quote not found in ${sourceId}: "${quote.slice(0, 80)}". Quote the page's own words, or drop the quote.`);
            return { sourceId, text: quote };
        });
        const finding = { id: newId('finding'), branchId, claim: text(claim, 'Claim', 1500), sourceIds: ids, quotes: checked, createdAt: Date.now() };
        topic.findings.push(finding);
        return finding;
    });
}

export function addPrinciple(root, topicId, { statement, findingIds, kind = 'do' }) {
    if (!['do', 'avoid', 'note'].includes(kind)) throw new Error('Kind must be do, avoid or note.');
    const ids = Array.isArray(findingIds) ? [...new Set(findingIds)] : [];
    if (!ids.length) throw new Error('A principle must rest on at least one finding.');
    return mutateTopic(root, topicId, topic => {
        if (topic.principles.length >= LIMITS.principles) throw new Error('Principle budget reached.');
        for (const id of ids) if (!topic.findings.some(f => f.id === id)) throw new Error(`Finding ${id} not found.`);
        const principle = { id: newId('principle'), kind, statement: text(statement, 'Statement', 600), findingIds: ids, createdAt: Date.now() };
        topic.principles.push(principle);
        return principle;
    });
}

export function addOpenQuestion(root, topicId, { question }) {
    return mutateTopic(root, topicId, topic => {
        if (topic.openQuestions.length >= LIMITS.openQuestions) throw new Error('Open question budget reached.');
        const item = { id: newId('question'), question: text(question, 'Question', 500), createdAt: Date.now() };
        topic.openQuestions.push(item);
        return item;
    });
}

// What is still missing — the AI's next move, and the owner's progress view.
export function topicStatus(root, topicId) {
    const topic = readTopic(root, topicId);
    const findingsBy = id => topic.findings.filter(f => f.branchId === id).length;
    const gaps = [];
    if (!topic.branches.length) gaps.push('No branches yet: split the question into 3-6 sub-questions.');
    for (const b of topic.branches.filter(b => b.status === 'open')) gaps.push(`Open branch "${b.question}" (${findingsBy(b.id)} findings).`);
    const unused = topic.sources.filter(s => !topic.findings.some(f => f.sourceIds.includes(s.id)));
    if (unused.length) gaps.push(`${unused.length} fetched source(s) not cited by any finding.`);
    const singleSourced = topic.findings.filter(f => f.sourceIds.length === 1 && !f.quotes.length).length;
    if (singleSourced) gaps.push(`${singleSourced} finding(s) rest on one source with no quote; corroborate or quote.`);
    if (topic.findings.length && !topic.principles.length) gaps.push('Findings exist but no principles yet: turn them into do / avoid statements.');
    return {
        topic: { id: topic.id, title: topic.title, question: topic.question, goal: topic.goal, budget: topic.budget, revision: topic.revision },
        pagesUsed: topic.sources.length,
        branches: topic.branches.map(b => ({ ...b, findings: findingsBy(b.id) })),
        counts: { sources: topic.sources.length, findings: topic.findings.length, principles: topic.principles.length, openQuestions: topic.openQuestions.length },
        gaps,
        ready: topic.branches.length > 0 && topic.branches.every(b => b.status !== 'open') && topic.principles.length > 0
    };
}

export function readTopicFull(root, topicId) { return readTopic(root, topicId); }

// The learning brief: what a design or build task takes as input. Built only from recorded,
// cited material — nothing here is written by the model at brief time.
export function topicBrief(root, topicId) {
    const topic = readTopic(root, topicId);
    const status = topicStatus(root, topicId);
    const cite = ids => ids.map(id => topic.sources.findIndex(s => s.id === id) + 1).filter(n => n > 0).map(n => `[${n}]`).join('');
    const findingCites = f => cite(f.sourceIds);
    const principleCites = p => cite([...new Set(p.findingIds.flatMap(id => topic.findings.find(f => f.id === id)?.sourceIds || []))]);
    const lines = [`# ${topic.title}`, '', `**Question:** ${topic.question}`];
    if (topic.goal) lines.push('', `**Goal:** ${topic.goal}`);
    if (!status.ready) lines.push('', `> Draft: ${status.gaps.length} gap(s) remain. ${status.gaps.slice(0, 3).join(' ')}`);
    for (const [kind, heading] of [['do', 'Do'], ['avoid', 'Avoid'], ['note', 'Notes']]) {
        const items = topic.principles.filter(p => p.kind === kind);
        if (items.length) lines.push('', `## ${heading}`, ...items.map(p => `- ${p.statement} ${principleCites(p)}`));
    }
    const roots = topic.branches.filter(b => !b.parentId);
    const walk = (branch, level) => {
        const out = [`${'#'.repeat(Math.min(2 + level, 6))} ${branch.question}${branch.status === 'dead_end' ? ' (dead end)' : ''}`];
        if (branch.note) out.push(`_${branch.note}_`);
        for (const f of topic.findings.filter(f => f.branchId === branch.id)) {
            out.push(`- ${f.claim} ${findingCites(f)}`);
            for (const q of f.quotes) out.push(`  > "${q.text}" ${cite([q.sourceId])}`);
        }
        for (const child of topic.branches.filter(b => b.parentId === branch.id)) out.push('', ...walk(child, level + 1));
        return out;
    };
    if (roots.length) lines.push('', '## Findings');
    for (const branch of roots) lines.push('', ...walk(branch, 1));
    if (topic.openQuestions.length) lines.push('', '## Open questions', ...topic.openQuestions.map(q => `- ${q.question}`));
    if (topic.sources.length) lines.push('', '## Sources', ...topic.sources.map((s, i) => `${i + 1}. ${s.title || s.url} — ${s.url} (fetched ${new Date(s.fetchedAt).toISOString().slice(0, 10)})`));
    return { topicId: topic.id, ready: status.ready, gaps: status.gaps, markdown: lines.join('\n') };
}
