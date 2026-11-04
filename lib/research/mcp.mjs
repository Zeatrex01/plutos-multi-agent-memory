// MCP adapter for the research studio. The connected AI runs the research; these tools hold
// the shape of it and refuse what would make it unsourced (lib/research/store.mjs).
import fs from 'fs';
import path from 'path';
import * as store from './store.mjs';
import { fetchPage, fetchImages, fetchRuntime } from './fetch.mjs';

const EXCERPT_CHARS = 6000;
const id = description => ({ type: 'string', description });

export const RESEARCH_TOOLS = [
    {
        name: 'research_topic',
        description: 'Research studio: targeted, source-backed research on any topic (a design style, a technique, a market, a library). action=list shows topics and whether web fetching is available; start opens a topic with a question and budgets; status shows the branch tree and the gaps still open (your next moves); brief builds the learning brief from recorded, cited findings and saves it. Method: split the question into 3-6 branches, fetch sources per branch, record findings with verbatim quotes, turn findings into do/avoid principles, close every branch, then brief.',
        inputSchema: { type: 'object', properties: {
            action: { type: 'string', enum: ['list', 'start', 'status', 'brief'] },
            topicId: id('Topic id (status, brief).'),
            title: { type: 'string', description: 'Short topic title (start).' },
            question: { type: 'string', description: 'The precise question to answer (start).' },
            goal: { type: 'string', description: 'What the answer will be used for, e.g. "design the landing page in this style" (start).' },
            pages: { type: 'integer', description: 'Page budget, 1-120, default 30 (start).' },
            depth: { type: 'integer', description: 'Branch depth budget, 1-5, default 3 (start).' }
        }, required: ['action'] }
    },
    {
        name: 'research_branch',
        description: 'Add a sub-question under a topic (or under another branch), or close one. A branch closes as answered only when a finding under it cites a source; dead_end needs a note saying why.',
        inputSchema: { type: 'object', properties: {
            action: { type: 'string', enum: ['add', 'close'] },
            topicId: id('Topic id.'),
            question: { type: 'string', description: 'Sub-question (add).' },
            parentId: id('Parent branch id for a deeper sub-question (add, optional).'),
            why: { type: 'string', description: 'Why this sub-question matters to the goal (add, optional).' },
            branchId: id('Branch to close (close).'),
            status: { type: 'string', enum: ['answered', 'dead_end', 'open'] },
            note: { type: 'string', description: 'Closing note; required for dead_end.' }
        }, required: ['action', 'topicId'] }
    },
    {
        name: 'research_fetch',
        description: 'Fetch one public web page into the topic as a source (counts against the page budget). Returns the source id and the first part of its text; read the rest with research_read. Local network addresses, non-http URLs and pages disallowed by robots.txt are refused.',
        inputSchema: { type: 'object', properties: {
            topicId: id('Topic id.'),
            url: { type: 'string', description: 'http(s) URL.' },
            branchId: id('Branch this source is for (optional).'),
            fresh: { type: 'boolean', description: 'Bypass the 7-day cache.' },
            render: { type: 'boolean', description: 'Run the page in a headless browser first, for pages that fill themselves in with scripts (the plain fetch came back nearly empty). Slower; needs Playwright Chromium.' }
        }, required: ['topicId', 'url'] }
    },
    {
        name: 'research_images',
        description: 'Save the images a public page offers into the topic (store capsules, screenshots, key art) so they can be looked at and cited. For a Steam game pass its store data URL, https://store.steampowered.com/api/appdetails?appids=<id>, which lists the header, capsule and every screenshot; any other page gives its preview image and its img tags. Same rules as research_fetch (public addresses, robots.txt per host); PNG, JPEG, WebP and GIF only. Returns each saved file\'s path; open it with your file-reading tool to see it.',
        inputSchema: { type: 'object', properties: {
            topicId: id('Topic id.'),
            url: { type: 'string', description: 'http(s) URL of the page (or Steam appdetails URL).' },
            branchId: id('Branch the images are for (optional).'),
            max: { type: 'integer', description: 'How many images to keep, 1-30, default 12.' }
        }, required: ['topicId', 'url'] }
    },
    {
        name: 'research_read',
        description: 'Read more of a fetched source, by character offset. This is the frozen text that quotes are checked against.',
        inputSchema: { type: 'object', properties: {
            topicId: id('Topic id.'), sourceId: id('Source id.'),
            offset: { type: 'integer' }, length: { type: 'integer', description: 'Up to 30000.' }
        }, required: ['topicId', 'sourceId'] }
    },
    {
        name: 'research_note',
        description: 'Record what was learned. kind=finding: a claim under a branch, citing fetched sources, with optional verbatim quotes that are checked against the source text (a quote not on the page is refused). kind=principle: a do / avoid / note statement resting on findings. kind=open_question: something the sources did not settle.',
        inputSchema: { type: 'object', properties: {
            kind: { type: 'string', enum: ['finding', 'principle', 'open_question'] },
            topicId: id('Topic id.'),
            branchId: id('Branch (finding).'),
            claim: { type: 'string', description: 'The finding, in your words (finding).' },
            sourceIds: { type: 'array', items: { type: 'string' }, description: 'Fetched sources it rests on (finding).' },
            quotes: { type: 'array', items: { type: 'object', properties: { sourceId: { type: 'string' }, text: { type: 'string' } }, required: ['sourceId', 'text'] }, description: 'Verbatim excerpts, up to 4 (finding).' },
            statement: { type: 'string', description: 'The principle (principle).' },
            principleKind: { type: 'string', enum: ['do', 'avoid', 'note'] },
            findingIds: { type: 'array', items: { type: 'string' }, description: 'Findings it rests on (principle).' },
            question: { type: 'string', description: 'The unresolved question (open_question).' }
        }, required: ['kind', 'topicId'] }
    }
];

async function researchTopic(root, args) {
    if (args.action === 'list') {
        const rt = fetchRuntime();
        return { webFetch: rt.available ? `available (Scrapling ${rt.scrapling})` : `unavailable: ${rt.reason}`, topics: store.listTopics(root) };
    }
    if (args.action === 'start') {
        const topic = store.startTopic(root, args);
        return { topicId: topic.id, budget: topic.budget, next: 'Split the question into 3-6 branches with research_branch(action:add).' };
    }
    if (args.action === 'status') return store.topicStatus(root, args.topicId);
    if (args.action === 'brief') {
        const brief = store.topicBrief(root, args.topicId);
        const file = path.join(root, '.plutos', 'research', args.topicId, 'brief.md');
        fs.writeFileSync(file, brief.markdown);
        return { ...brief, savedTo: path.relative(root, file).replace(/\\/g, '/') };
    }
    throw new Error('Unknown action.');
}

async function researchBranch(root, args) {
    if (args.action === 'add') return store.addBranch(root, args.topicId, args);
    if (args.action === 'close') return store.setBranchStatus(root, args.topicId, { branchId: args.branchId, status: args.status || 'answered', note: args.note });
    throw new Error('Unknown action.');
}

async function researchFetch(root, args) {
    store.topicStatus(root, args.topicId);   // fail fast on an unknown topic, before any network
    const page = await fetchPage(args.url, { cacheDir: store.cacheDir(root), fresh: args.fresh === true, render: args.render === true });
    const { source, duplicate } = store.addSource(root, args.topicId, page, { branchId: args.branchId });
    return { sourceId: source.id, duplicate, title: source.title, url: source.url, chars: source.chars, cached: page.cached,
        excerpt: page.markdown.slice(0, EXCERPT_CHARS), nextOffset: page.markdown.length > EXCERPT_CHARS ? EXCERPT_CHARS : null };
}

async function researchImages(root, args) {
    store.topicStatus(root, args.topicId);   // fail fast on an unknown topic, before any network
    const outDir = store.imagesDir(root, args.topicId);
    const result = await fetchImages(args.url, { outDir, max: args.max });
    const { images, total } = store.addImages(root, args.topicId, result.finalUrl, result.images, { branchId: args.branchId });
    const folder = path.relative(root, path.dirname(outDir)).replace(/\\/g, '/');
    return { saved: images.map(image => ({ imageId: image.id, path: `${folder}/${image.file}`, url: image.url, bytes: image.bytes, type: image.type })),
        skipped: result.skipped.slice(0, 10), candidates: result.candidates, imagesInTopic: total };
}

async function researchNote(root, args) {
    if (args.kind === 'finding') return store.addFinding(root, args.topicId, args);
    if (args.kind === 'principle') return store.addPrinciple(root, args.topicId, { statement: args.statement, findingIds: args.findingIds, kind: args.principleKind || 'do' });
    if (args.kind === 'open_question') return store.addOpenQuestion(root, args.topicId, args);
    throw new Error('Unknown kind.');
}

export function researchMcpHandlers(root, text, errorText) {
    const operations = {
        research_topic: researchTopic,
        research_branch: researchBranch,
        research_fetch: researchFetch,
        research_images: researchImages,
        research_read: async (r, d) => store.readSourceText(r, d.topicId, d.sourceId, d),
        research_note: researchNote
    };
    return Object.fromEntries(Object.entries(operations).map(([name, run]) => [name, async args => {
        try { return text(JSON.stringify(await run(root, args || {}))); }
        catch (error) { return errorText(`ERROR: ${error.message}`); }
    }]));
}
