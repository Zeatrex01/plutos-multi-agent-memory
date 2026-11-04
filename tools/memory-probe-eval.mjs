#!/usr/bin/env node
// The retrieval probes (research 2026-11-03 §5.1; canonical architecture §6 "measured before kept"):
// tools/memory-probes.json asks this repository's records questions in Turkish and English, and
// three paths answer them. Not in npm test; a measurement run by hand:
//
//   node tools/memory-probe-eval.mjs [repo] [--probes tools/memory-probes-heldout.json] [--record docs/handoff/results/<dir>] [--sweep]
//
// Paths:
//   A  brief + grep   the baseline: the ids the actual short brief carries, then a case-insensitive
//                     OR-grep of the query's content words over CONTEXT.json, CONTINUITY.md and the
//                     archives, each hit line mapped to its record, ranked by distinct terms matched.
//                     Two forms: A-plain (words as typed, for B) and A-folded (Turkish folding and
//                     the dictionary applied to the grep terms too, for C).
//   B  plain FTS5     the same records in FTS5 with unicode61 as it comes: no folding, no dictionary,
//                     no fact keys; the same quoting, prefix rule and floor as C.
//   C  the index      lib/memory.mjs findMemory: folding + TR_EN + the trigram fact keys.
// Metrics: Recall@5, MRR, top-1 hit over the probes that expect a record; the refusal rate over the
// false premises. "Refused" means no active card came back: nothing at all, or only cards labelled
// archived (history), which is the same rule for every path. The drop rules are printed at the end.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : null; };
const repo = path.resolve(args.find((a, i) => !a.startsWith('--') && !String(args[i - 1] || '').startsWith('--')) || ROOT);
const recordDir = typeof flag('--record') === 'string' ? path.resolve(flag('--record')) : null;
const sweep = !!flag('--sweep');

const { collectRecords, tokenize, stripMarks, matchExpression, termFrequencies } = await import('../lib/memory-index.mjs');
const { findMemory, queryTerms, FIND_FLOOR, informativeLimit, RECORD_ID } = await import('../lib/memory.mjs');
const { STOP } = await import('../lib/task-context.mjs');
const { sessionBriefParts } = await import('../lib/session-brief.mjs');
const { parseContinuity } = await import('../lib/continuity.mjs');

// --probes <file> runs another set, such as tools/memory-probes-heldout.json (written blind to the search code).
const probesFile = args.includes('--probes') ? path.resolve(args[args.indexOf('--probes') + 1]) : path.join(ROOT, 'tools', 'memory-probes.json');
const probes = JSON.parse(fs.readFileSync(probesFile, 'utf8')).probes;
const { records } = collectRecords(repo);
const known = new Set(records.map(r => r.id));

// Every expected id must still be a record: a probe keyed to a vanished claim fails loudly.
const missing = probes.flatMap(p => p.expect.filter(id => !known.has(id)).map(id => `${p.id}: ${id}`));
if (missing.length) { console.error(`Expected ids missing from the records (fix tools/memory-probes.json):\n  ${missing.join('\n  ')}`); process.exit(1); }

const TOP = 5;
const positives = probes.filter(p => p.expect.length);
const falses = probes.filter(p => !p.expect.length);

// --- A: brief + grep ----------------------------------------------------------------------------
const briefIds = [...new Set((sessionBriefParts(repo, 'Claude Code', { writes: false }).context.match(RECORD_ID) || []))];

// Each record as the lines a grep would see, mapped back to the record.
function recordLines(projectRoot) {
    const out = [];   // { id, archived, lines: [] }
    const byId = new Map();
    const push = (id, archived, lines) => {
        const key = `${id}#${archived ? 1 : 0}`;
        if (!byId.has(key)) { byId.set(key, { id, archived, lines: [] }); out.push(byId.get(key)); }
        byId.get(key).lines.push(...lines);
    };
    const context = path.join(projectRoot, 'docs', 'handoff', 'CONTEXT.json');
    if (fs.existsSync(context)) {
        const reg = JSON.parse(fs.readFileSync(context, 'utf8'));
        for (const item of [...(reg.claims || []), ...(reg.decisions || [])]) push(item.id, false, JSON.stringify(item, null, 2).split('\n'));
    }
    const files = [path.join(projectRoot, 'docs', 'handoff', 'CONTINUITY.md')];
    const archive = path.join(projectRoot, 'docs', 'handoff', 'archive');
    if (fs.existsSync(archive)) for (const name of fs.readdirSync(archive).sort()) files.push(path.join(archive, name));
    for (const file of files) {
        if (!fs.existsSync(file)) continue;
        const text = fs.readFileSync(file, 'utf8');
        if (file.endsWith('.jsonl')) {
            for (const line of text.split(/\r?\n/)) { if (!line.trim()) continue; try { push(JSON.parse(line).id, true, [line]); } catch { /* skip */ } }
            continue;
        }
        if (!file.endsWith('.md') || !/CONTINUITY|SESSIONS-/.test(file)) continue;
        const lines = text.split(/\r?\n/);
        const parsed = parseContinuity(text);
        for (const session of parsed.sessions) push(session.time, false, lines.slice(session.start, session.end));
        for (const line of lines) { const id = (line.match(/\((d-[0-9a-f]{12})\)\s*$/) || [])[1]; if (id && /^\s*-\s*DECISION:/i.test(line)) push(id, false, [line]); }
    }
    return out;
}
const grepRecords = recordLines(repo);
const plainStop = new Set([...STOP].map(w => w.toLowerCase()));

function grepTerms(query, folded) {
    if (folded) return queryTerms(query).terms;
    return [...new Set((String(query).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(w => w.length >= 2 && !/^\d+$/.test(w) && !plainStop.has(w)))];
}
function grepRank(query, folded, archived, expect = []) {
    const terms = grepTerms(query, folded);
    const norm = folded ? stripMarks : (s => s.toLowerCase());
    const scored = [];
    for (const record of grepRecords) {
        if (record.archived && !archived) continue;
        const text = record.lines.map(norm);
        let distinct = 0, hits = 0;
        for (const term of terms) {
            const t = norm(term);
            const n = text.reduce((c, line) => c + (line.includes(t) ? 1 : 0), 0);
            if (n) { distinct++; hits += n; }
        }
        if (distinct) scored.push({ id: record.id, archived: record.archived, distinct, hits });
    }
    scored.sort((a, b) => b.distinct - a.distinct || b.hits - a.hits || a.id.localeCompare(b.id));
    const grep = scored.map(s => ({ id: s.id, archived: s.archived, score: s.distinct }));
    // An expected id the short brief already carries is a hit at rank 1 (it is in context before
    // any grep); the grep ranks the rest. The brief is not an answer to a question, so a refusal
    // is judged on the grep alone.
    const list = [...briefIds.filter(id => expect.includes(id)).map(id => ({ id, archived: false, score: 'brief' })), ...grep.filter(g => !briefIds.includes(g.id))];
    return { list: list.slice(0, TOP), refused: !grep.some(g => !g.archived), terms };
}

// --- B: plain FTS5 ---------------------------------------------------------------------------------
let sqlite = null;
{
    const original = process.emitWarning;
    process.emitWarning = (w, ...rest) => (/sqlite/i.test(String(typeof w === 'string' ? w : w?.message)) ? undefined : original.call(process, w, ...rest));
    try { sqlite = process.getBuiltinModule('node:sqlite'); } catch { sqlite = null; } finally { process.emitWarning = original; }
}
let plainDb = null;
if (sqlite) {
    plainDb = new sqlite.DatabaseSync(':memory:');
    plainDb.exec("CREATE TABLE nodes(rowid INTEGER PRIMARY KEY, id TEXT, archived INTEGER, title TEXT, text TEXT, excerpt TEXT);"
        + "CREATE VIRTUAL TABLE fts USING fts5(title, text, excerpt, content='nodes', content_rowid='rowid', tokenize='unicode61');");
    const ins = plainDb.prepare('INSERT INTO nodes(rowid, id, archived, title, text, excerpt) VALUES(?,?,?,?,?,?)');
    records.forEach((r, i) => ins.run(i + 1, r.id, r.archived ? 1 : 0, r.title, r.text, r.excerpt));
    plainDb.exec("INSERT INTO fts(fts) VALUES('rebuild')");
}
const plainTokens = text => (String(text).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').match(/[\p{L}\p{N}]+/gu) || []);
const stem = w => w.length > 4 && /[^su]s$/.test(w) && !/(is|us)$/.test(w) ? w.slice(0, -1) : w;
// B's document frequencies over its own (unfolded) tokens, for the floor's informative-term rule.
const plainDf = termFrequencies(records, null, plainTokens);
const plainLimit = informativeLimit(records.length);
function plainRank(query, archived) {
    if (!plainDb) return { list: [], refused: true, terms: [] };
    const terms = [...new Set((String(query).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(w => w.length >= 2 && !/^\d+$/.test(w) && !plainStop.has(w)).map(stem))].slice(0, 12);
    const expression = matchExpression(terms);
    if (!expression) return { list: [], refused: true, terms };
    const rows = plainDb.prepare(`SELECT n.id, n.archived, n.title, n.text, n.excerpt, -bm25(fts, 2.0, 1.0, 0.5) AS score FROM fts JOIN nodes n ON n.rowid = fts.rowid WHERE fts MATCH ?${archived ? '' : ' AND n.archived = 0'} ORDER BY score DESC LIMIT 60`).all(expression);
    const matched = row => { const toks = new Set(plainTokens(`${row.title} ${row.text} ${row.excerpt}`)); return terms.filter(t => { const s = plainTokens(t)[0] || t; for (const tok of toks) if (s.length >= 5 ? tok.startsWith(s) : tok === s) return true; return false; }); };
    const informative = new Set(terms.filter(t => (plainDf.get(plainTokens(t)[0] || t) || 0) <= plainLimit));
    const enough = rows.map(r => ({ ...r, why: matched(r) })).filter(r => r.why.length >= FIND_FLOOR.terms && r.why.some(t => informative.has(t)));
    const best = enough.reduce((t, r) => Math.max(t, r.score), 0);
    const standing = enough.filter(r => r.score >= FIND_FLOOR.ratio * best).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return { list: standing.slice(0, TOP).map(r => ({ id: r.id, archived: !!r.archived, score: Math.round(r.score * 100) / 100 })), refused: !standing.some(r => !r.archived), terms };
}

// --- C: the index ------------------------------------------------------------------------------------
let engineSeen = null;
function indexRank(query, archived) {
    const r = findMemory(repo, query, { candidates: TOP, archived });
    engineSeen = engineSeen || r.engine;
    return { list: r.cards.map(c => ({ id: c.id, archived: c.archived, score: c.score })), refused: !r.cards.some(c => !c.archived), terms: r.terms, keys: r.keys };
}

// --- scoring -----------------------------------------------------------------------------------------
function score(arms) {
    const out = {};
    for (const [name, fn] of Object.entries(arms)) {
        let r5 = 0, mrr = 0, top1 = 0, refused = 0;
        const rows = [];
        for (const p of probes) {
            const res = fn(p.question, !!p.archived, p.expect);
            const ids = res.list.map(x => x.id);
            if (p.expect.length) {
                const hit = p.expect.filter(id => ids.includes(id)).length / p.expect.length;
                const first = ids.findIndex(id => p.expect.includes(id));
                r5 += hit; mrr += first >= 0 ? 1 / (first + 1) : 0; top1 += p.expect.includes(ids[0]) ? 1 : 0;
                rows.push({ probe: p.id, lang: p.lang, ability: p.ability, expect: p.expect, top: res.list, recall: hit, rank: first >= 0 ? first + 1 : null, terms: res.terms, keys: res.keys || [] });
            } else {
                refused += res.refused ? 1 : 0;
                rows.push({ probe: p.id, lang: p.lang, ability: p.ability, expect: [], top: res.list, refused: res.refused, terms: res.terms, keys: res.keys || [] });
            }
        }
        out[name] = { r5: r5 / positives.length, mrr: mrr / positives.length, top1: top1 / positives.length, refusal: refused / falses.length, rows };
    }
    return out;
}
const pct = v => `${(100 * v).toFixed(1).padStart(5)}%`;
const arms = {
    'A-plain (brief+grep)': (q, a, e) => grepRank(q, false, a, e),
    'A-folded (brief+grep)': (q, a, e) => grepRank(q, true, a, e),
    'B plain FTS5': (q, a) => plainRank(q, a),
    'C index': (q, a) => indexRank(q, a)
};
const result = score(arms);

const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };
say(`memory probes: ${probes.length} probes (${positives.length} with a record, ${falses.length} false premises; ${probes.filter(p => p.lang === 'tr').length} Turkish, ${probes.filter(p => p.lang === 'en').length} English) over ${records.length} records of ${path.basename(repo)}; engine ${engineSeen}; brief carries ${briefIds.length} id(s); floor terms ≥ ${FIND_FLOOR.terms} (${FIND_FLOOR.keyTerms} with a key), one informative (df ≤ ${informativeLimit(records.length)}, a ${FIND_FLOOR.informativeShare} share of the records), ratio ${FIND_FLOOR.ratio}`);
say();
say('| path | Recall@5 | MRR | top-1 hit | false premises refused |');
say('|---|---|---|---|---|');
for (const [name, m] of Object.entries(result)) say(`| ${name} | ${pct(m.r5)} | ${m.mrr.toFixed(3)} | ${pct(m.top1)} | ${pct(m.refusal)} |`);

// Breakdowns for C.
const c = result['C index'];
const breakdown = (key) => {
    const groups = {};
    for (const row of c.rows) { const g = row[key]; groups[g] = groups[g] || { n: 0, r5: 0, refused: 0, nf: 0 }; if (row.expect.length) { groups[g].n++; groups[g].r5 += row.recall; } else { groups[g].nf++; groups[g].refused += row.refused ? 1 : 0; } }
    return Object.entries(groups).map(([g, v]) => `${g}: ${v.n ? `Recall@5 ${pct(v.r5 / v.n)} (${v.n})` : ''}${v.nf ? ` refused ${pct(v.refused / v.nf)} (${v.nf})` : ''}`).join('; ');
};
say();
say(`C by ability: ${breakdown('ability')}`);
say(`C by language: ${breakdown('lang')}`);

// The ratio sweep: the top card always passes the ratio, so it moves Recall@5 and what follows the
// top card, not the refusals (which the term rules decide).
if (sweep) {
    say();
    say('| ratio | C Recall@5 | C refused | B Recall@5 | B refused |');
    say('|---|---|---|---|---|');
    const kept = FIND_FLOOR.ratio;
    for (const ratio of [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
        FIND_FLOOR.ratio = ratio;
        const r = score({ C: arms['C index'], B: arms['B plain FTS5'] });
        say(`| ${ratio} | ${pct(r.C.r5)} | ${pct(r.C.refusal)} | ${pct(r.B.r5)} | ${pct(r.B.refusal)} |`);
    }
    FIND_FLOOR.ratio = kept;
}

// Drop rules (research §5, fixed in advance).
const a = result['A-folded (brief+grep)'], b = result['B plain FTS5'];
const gain = 100 * (c.r5 - a.r5);
say();
say(`Drop rule 1 (the index beats brief+grep by 10 points of Recall@5): C ${pct(c.r5)} against A-folded ${pct(a.r5)}: ${gain >= 10 ? `KEEP (+${gain.toFixed(1)} points)` : `DROP (+${gain.toFixed(1)} points, under 10)`}`);
say(`Drop rule 2 (the index refuses false premises at least as well as brief+grep): C ${pct(c.refusal)} against A-folded ${pct(a.refusal)}: ${c.refusal >= a.refusal ? 'KEEP' : 'DROP'}`);
say(`For the record, B against A-plain: Recall@5 ${pct(b.r5)} against ${pct(result['A-plain (brief+grep)'].r5)}; refusals ${pct(b.refusal)} against ${pct(result['A-plain (brief+grep)'].refusal)}.`);
say(`Verdict: ${gain >= 10 && c.refusal >= a.refusal ? 'the index stays' : 'the index is dropped by its own rules'}.`);

if (recordDir) {
    fs.mkdirSync(recordDir, { recursive: true });
    fs.writeFileSync(path.join(recordDir, 'table.md'), lines.join('\n') + '\n');
    const raw = [];
    for (const [name, m] of Object.entries(result)) for (const row of m.rows) raw.push(JSON.stringify({ path: name, ...row }));
    fs.writeFileSync(path.join(recordDir, 'results.jsonl'), raw.join('\n') + '\n');
    say(`Recorded in ${path.relative(repo, recordDir)}/ (table.md, results.jsonl).`);
}
plainDb?.close();
