// Context for a task: given the text of a task, which files should an agent open first?
//
// An agent handed "fix the approval expiry" otherwise spends its first minutes grepping, and
// each grep lands whole files in its context. This answers the question once, from the code
// graph graphify already knows how to build, and returns a short ranked list with the reason
// each file is on it. It reads the project and writes nothing into it.
//
// Three kinds of anchor find the starting files, strongest first:
//   - a path or file name the task mentions (`lib/approvals.mjs`, `board.js`);
//   - a code identifier it mentions (`answerApproval`, `needs_you`, `approvalTier()`),
//     matched to the file that declares it;
//   - plain words, matched to path segments and declared names, weighted by how rare the
//     word is in this project. Turkish task words go through a small dictionary first.
// Then the graph widens the set: files that use an anchor (two hops) and files an anchor
// uses (one hop), each hop worth less, and a hub that imports everything worth less again.
// The result says how sure it is, so a weak answer reads as weak rather than as a map.
import fs from 'fs';
import path from 'path';
import { scanCodeGraph, CODE_EXTS } from './graphify.mjs';
import { isSourceNewerThan } from './codeindex.mjs';
import { findMemory } from './memory.mjs';
import { designForTask } from './design.mjs';

export const STOP = new Set((
    'the a an and or but for nor of to in on at by with from into onto over under about as is are was were be been ' +
    'being it its this that these those there here then than so such not no do does did done doing have has had can ' +
    'could should would will shall may might must make makes made use used using add added adding fix fixed fixing ' +
    'change changes changed update updated updating new old when where what which who why how all any some each every ' +
    'more most less also just only very same other again still need needs want wants like get gets got set sets one two ' +
    'work works working way thing things file files code please now yet out off up down via per after before while ' +
    'feat fix chore refactor docs perf test style build revert wip ' +
    'bir ve ile için bu şu o da de mi mı mu mü ama fakat veya ya ki çok daha en gibi kadar olan olarak olsun oldu ' +
    'yap yapalım yapın yapsın ekle ekleyelim düzelt düzeltelim değiştir şey şeyi şeyler var yok niye neden nasıl ne ' +
    'hangi her bütün tüm sonra önce şimdi bunu şunu onu bunun bize bana sen ben biz siz lazım gerek gerekiyor artık ' +
    'tekrar yine hem zaten bile diye eğer nerede neye neyle yerine geldi aldı oluyor olamaz hangisi nedir hep ' +
    'içinde arasında değil olan olarak ise iken kendi mi ki zaman'
).split(/\s+/));

// Turkish words an owner is likely to use for a task, mapped to the English a codebase uses.
// A key of four or more letters also matches its suffixed forms (toplantıları → meeting).
export const TR_EN = {
    toplantı: ['meeting'], bildirim: ['notification', 'notify'], onay: ['approval', 'approve'], oturum: ['session'],
    pano: ['board'], görev: ['task'], karar: ['decision'], ayar: ['settings', 'config'], kullanıcı: ['user'],
    giriş: ['login', 'auth'], kimlik: ['auth', 'identity'], dosya: ['file'], klasör: ['folder', 'dir'],
    proje: ['project'], sürüm: ['version', 'release'], hata: ['error', 'bug'], arayüz: ['ui'], ekran: ['screen', 'view'],
    düğme: ['button'], buton: ['button'], sekme: ['tab'], harita: ['map'], grafik: ['graph', 'chart'],
    rapor: ['report'], ofis: ['office'], beceri: ['skill'], yetenek: ['skill'], paket: ['package'],
    kurulum: ['install'], kur: ['install'], telefon: ['phone', 'mobile'], eşleş: ['pair', 'pairing'],
    uzak: ['remote'], bağlam: ['context'], hafıza: ['memory'], arama: ['search'], çeviri: ['i18n', 'translation'],
    dil: ['language', 'i18n'], tema: ['theme'], oyuncu: ['player'], düşman: ['enemy'], silah: ['weapon'],
    envanter: ['inventory'], kayıt: ['save', 'log', 'record'], kaydet: ['save'], yükle: ['load', 'upload'],
    ses: ['audio', 'sound'], müzik: ['music'], kamera: ['camera'], hareket: ['movement', 'move'],
    zıpla: ['jump'], puan: ['score'], skor: ['score'], seviye: ['level'], bölüm: ['level', 'chapter'],
    ödeme: ['payment'], sepet: ['cart'], ürün: ['product'], sipariş: ['order'], mağaza: ['store', 'shop'],
    araştırma: ['research'], stüdyo: ['studio'], konsey: ['council'], harcama: ['spend', 'cost'],
    maliyet: ['cost'], başlat: ['start', 'launch'], sunucu: ['server'], istemci: ['client'],
    güvenlik: ['security'], şifre: ['password'], zamanlayıcı: ['timer', 'schedule'], yedek: ['backup'],
    dışa: ['export'], aktar: ['export', 'import'], canlı: ['live'], ajan: ['agent'], kalıcı: ['persist'],
    bekle: ['wait', 'pending'], şerit: ['lane'], süre: ['expiry', 'timeout'], mühür: ['seal'], tarama: ['scan'], iddia: ['claim'], kanıt: ['evidence'],
    sohbet: ['chat'], mesaj: ['message'], tablo: ['table'], liste: ['list'], modül: ['module'],
    // Words the memory probes (tools/memory-probes.json) showed an owner asking the record with.
    rol: ['role'], kural: ['rule'], anlaşma: ['agreement'], bellek: ['memory'], dizin: ['index'], arşiv: ['archive'],
    sayfa: ['page'], dal: ['branch'], depo: ['repository', 'repo'], jeton: ['token'], bütçe: ['budget'], sahip: ['owner'],
    belge: ['document', 'docs'], yayın: ['publish', 'release'], komut: ['command', 'cli'], damga: ['stamp'], itme: ['push'],
    kapı: ['gate'], etiket: ['label', 'tag'], kanca: ['hook'], tarih: ['date', 'history'], özet: ['brief', 'digest'],
    gizli: ['hidden'], karakter: ['character'], kopya: ['duplicate', 'copy'], sil: ['delete', 'remove'], kaldır: ['remove'],
    taşı: ['move'], yerel: ['local'], uzaktan: ['remote'], motor: ['engine'], oyun: ['game'], çekirdek: ['core'],
    eklenti: ['plugin'], yazar: ['author'], imza: ['signature', 'attribution'], çıkar: ['cut', 'remove'], ölç: ['measure'],
    deney: ['trial', 'experiment'], sonuç: ['result'], tanım: ['definition'], adı: ['name'], isim: ['name'], kimlikli: ['id'],
    tersine: ['reverse', 'supersede'], kuyruk: ['queue'], bitiş: ['done', 'finished'], bitmiş: ['done', 'finished'],
    ölçüt: ['criterion'], derleme: ['build'], çıktı: ['output'], kaynak: ['source'], bayat: ['stale'], uygula: ['apply', 'enforce'],
    kapat: ['off', 'disable'], yenile: ['refresh', 'rotate'], koruma: ['guard', 'protection'], panel: ['dashboard', 'panel'],
    önbellek: ['cache'], mobil: ['mobile'], uygulama: ['app', 'application'], karanlık: ['dark'], anahtar: ['key', 'toggle'],
    sertifika: ['certificate'], servis: ['service'], şema: ['schema'], dağıtım: ['deploy', 'deployment'], konu: ['subject', 'topic']
};
const TR_KEYS = Object.keys(TR_EN).sort((a, b) => b.length - a.length);

const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs)\/|[._-](test|spec)s?\.[a-z]+$/i;
const TEST_WORDS = /\b(tests?|testing|spec|specs|regression|test[ie]?|testler)\b/i;

// ------------------------------------------------------------------------------- the index

const CACHE = new Map();   // root -> { at, scannedAt, index }
const FRESH_MS = 5_000;
const MAX_AGE_MS = 10 * 60_000;

const splitParts = (name) => String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase().split(/[^a-z0-9]+/).filter(p => p.length >= 3);

const norm = (w) => {
    if (w.length <= 4) return w;
    if (/(uses|sses|xes|ches|shes)$/.test(w)) return w.slice(0, -2);    // statuses, classes, matches
    return /[^su]s$/.test(w) && !/(is|us)$/.test(w) ? w.slice(0, -1) : w;   // approvals, not analysis
};

// Equal after a plural is dropped, or sharing a stem: at least five letters and all but the
// last two of the shorter word (approve / approval, session / sessions, render / renderer).
function wordMatches(a, b) {
    if (a === b) return true;
    if (a.length < 5 || b.length < 5) return false;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i >= 5 && i >= Math.min(a.length, b.length) - 2;
}

export function buildTaskIndex(root) {
    const graph = scanCodeGraph(root);
    const files = graph.nodes.map(n => n.id);
    const deps = new Map(files.map(f => [f, new Set()]));
    const users = new Map(files.map(f => [f, new Set()]));
    for (const link of graph.links) {
        deps.get(link.source)?.add(link.target);
        users.get(link.target)?.add(link.source);
    }
    const symbolsOf = new Map(files.map(f => [f, graph.symbols.get(f) || []]));
    const declaredBy = new Map();          // symbol -> [files]
    const declaredByLower = new Map();     // lowercased symbol -> [files]
    const vocab = new Map();               // part -> Map(file -> weight): 1 basename, .5 dir, .6 symbol
    const addPart = (part, file, weight) => {
        const p = norm(part);
        if (!vocab.has(p)) vocab.set(p, new Map());
        const byFile = vocab.get(p);
        if ((byFile.get(file) || 0) < weight) byFile.set(file, weight);
    };
    for (const file of files) {
        const segs = file.split('/');
        const base = segs.pop().replace(/\.[^.]+$/, '');
        for (const part of splitParts(base)) addPart(part, file, 1);
        for (const seg of segs) for (const part of splitParts(seg)) addPart(part, file, 0.5);
        for (const sym of symbolsOf.get(file)) {
            for (const [map, key] of [[declaredBy, sym], [declaredByLower, sym.toLowerCase()]]) {
                if (!map.has(key)) map.set(key, []);
                map.get(key).push(file);
            }
            for (const part of splitParts(sym)) addPart(part, file, 0.6);
        }
    }
    return { files, deps, users, symbolsOf, declaredBy, declaredByLower, vocab, fileCount: graph.fileCount };
}

function getIndex(root, now = Date.now()) {
    const hit = CACHE.get(root);
    if (hit && (now - hit.at < FRESH_MS
        || (now - hit.at < MAX_AGE_MS && !isSourceNewerThan(root, CODE_EXTS, hit.scannedAt)))) {
        hit.at = now;
        return hit.index;
    }
    const scannedAt = Date.now();
    const index = buildTaskIndex(root);
    CACHE.set(root, { at: now, scannedAt, index });
    return index;
}

export function resetTaskContextCache() { CACHE.clear(); }

// The same cached index, for lib/code-tools.mjs: one scan serves both tools.
export function codeIndex(root) { return getIndex(root); }

// ------------------------------------------------------------------------- reading a task

function lower(text) { return text.replace(/İ/g, 'i').toLowerCase(); }

export function parseTask(task) {
    const text = String(task || '').slice(0, 4000);
    const paths = new Set();
    for (const m of text.matchAll(/[\w.\-\/\\]*[\w\-]\.(?:[a-z]{1,5})\b|[\w.\-]+(?:[\/\\][\w.\-]+)+/gi)) {
        const tok = m[0].replace(/\\/g, '/').replace(/^\.\//, '').replace(/[.\/]+$/, '');
        if (/\.(?:[a-z]{1,5})$/i.test(tok) || tok.includes('/')) {
            if (!/^\d+(\.\d+)+$/.test(tok) && !/^(e\.g|i\.e|vs)$/i.test(tok)) paths.add(tok);
        }
    }
    const identifiers = new Set();
    for (const m of text.matchAll(/`([^`\n]{2,80})`/g)) {
        for (const id of m[1].match(/[A-Za-z_$][\w$]{2,}/g) || []) identifiers.add(id);
    }
    for (const m of text.matchAll(/[A-Za-z_$][\w$]{2,}(\s*\()?/g)) {
        const id = m[0].replace(/\s*\($/, '');
        if (m[1] || /[a-z][A-Z]/.test(id) || /^[A-Z][a-z]+[A-Z]/.test(id) || /[A-Za-z0-9]_[A-Za-z0-9]/.test(id)) identifiers.add(id);
    }
    for (const p of paths) for (const part of p.split('/')) identifiers.delete(part.replace(/\.[^.]+$/, ''));
    for (const id of identifiers) if (STOP.has(id.toLowerCase())) identifiers.delete(id);
    const words = new Set();
    const wantsTests = TEST_WORDS.test(text);
    const withoutPaths = [...paths].reduce((t, p) => t.split(p).join(' '), text.replace(/\\/g, '/'));
    const idWords = new Set([...identifiers].map(id => id.toLowerCase()));
    for (const raw of lower(withoutPaths).match(/[\p{L}\p{N}]+/gu) || []) {
        if (raw.length < 3 || STOP.has(raw) || idWords.has(raw) || /^\d+$/.test(raw)) continue;
        const key = TR_KEYS.find(k => raw === k || (k.length >= 4 && raw.startsWith(k)));
        if (key) { for (const en of TR_EN[key]) words.add(en); continue; }
        if (/^[a-z0-9]+$/.test(raw)) {
            for (const part of splitParts(raw)) if (!STOP.has(part)) words.add(norm(part));
        }
    }
    for (const id of identifiers) for (const part of splitParts(id)) if (!STOP.has(part)) words.add(norm(part));
    return { text, paths: [...paths], identifiers: [...identifiers], words: [...words], wantsTests };
}

// ----------------------------------------------------------------------------- the ranking

// Tuned on two repositories' histories with tools/task-context-eval.mjs. Re-measured on
// 2026-10-27, the graph step adds about one point of recall at 12 (+1.0 and +1.3; the tuning had
// recorded two to seven); heavier graph weights started pushing a hub above the file the task
// actually named.
const WEIGHTS = { path: 3, basename: 2, explicit: 2.5, lexical: 2, user: 0.3, user2: 0.25, dep: 0.2, graphCap: 1.5 };

// A file that imports thirty modules says little about any one of them; the same goes for a
// utility every file imports. Both still count, at a discount.
const specificity = (n) => 1 / (1 + Math.log2(1 + n / 8));

export function rankFiles(index, parsed, { graph = true, weights = null } = {}) {
    const W = weights ? { ...WEIGHTS, ...weights } : WEIGHTS;
    const seed = new Map();      // file -> { score, reasons[], matchedSymbols:Set }
    const entry = (f) => {
        if (!seed.has(f)) seed.set(f, { score: 0, graph: 0, reasons: [], matched: new Set(), anchor: false });
        return seed.get(f);
    };
    const anchors = { path: 0, symbol: 0, word: 0 };
    const unmatchedPaths = [], unmatchedIds = [], unmatchedWords = [];

    for (const p of parsed.paths) {
        const exact = index.files.filter(f => f === p || f.endsWith('/' + p));
        const base = path.posix.basename(p);
        const byBase = exact.length ? [] : index.files.filter(f => path.posix.basename(f) === base
            || (!/\.[^.]+$/.test(base) ? false : path.posix.basename(f).replace(/\.[^.]+$/, '') === base.replace(/\.[^.]+$/, '')));
        const hits = (exact.length ? exact : byBase).slice(0, 4);
        if (!hits.length) { unmatchedPaths.push(p); continue; }
        anchors.path++;
        for (const f of hits) {
            const e = entry(f);
            e.score += (exact.length ? W.path : W.basename) / Math.sqrt(hits.length);
            e.reasons.push(`named in the task (${p})`);
            e.anchor = true;
        }
    }

    for (const id of parsed.identifiers) {
        let hits = index.declaredBy.get(id) || index.declaredByLower.get(id.toLowerCase()) || [];
        if (!hits.length) { unmatchedIds.push(id); continue; }
        hits = [...new Set(hits)];
        if (hits.length > 8) { unmatchedIds.push(`${id} (declared in ${hits.length} files)`); continue; }
        anchors.symbol++;
        for (const f of hits) {
            const e = entry(f);
            e.score += W.explicit / Math.sqrt(hits.length);
            e.reasons.push(`declares ${id}`);
            e.matched.add(id);
            e.anchor = true;
        }
    }

    // Plain words: one pass over the vocabulary per word, IDF-weighted by how many files match.
    const N = Math.max(1, index.files.length);
    const lexical = new Map();   // file -> { sum, words[] }
    let idfTotal = 0;
    for (const w of parsed.words) {
        const byFile = new Map();
        for (const [part, files] of index.vocab) {
            if (!wordMatches(w, part)) continue;
            for (const [f, weight] of files) if ((byFile.get(f) || 0) < weight) byFile.set(f, weight);
        }
        if (!byFile.size) { unmatchedWords.push(w); continue; }
        if (byFile.size > N * 0.4) continue;   // as common as a stopword here
        anchors.word++;
        const idf = Math.log(1 + N / byFile.size);
        idfTotal += idf;
        for (const [f, weight] of byFile) {
            if (!lexical.has(f)) lexical.set(f, { sum: 0, words: [] });
            const l = lexical.get(f);
            l.sum += idf * weight;
            l.words.push(w);
        }
    }
    if (idfTotal > 0) {
        const ranked = [...lexical].sort((a, b) => b[1].sum - a[1].sum);
        const best = ranked[0]?.[1].sum || 0;
        for (const [f, l] of ranked) {
            const frac = l.sum / idfTotal;
            const e = entry(f);
            e.score += W.lexical * frac;
            if (l.sum >= best * 0.3) {
                e.reasons.push(`matches ${l.words.slice(0, 4).join(', ')}`);
                e.anchor = e.anchor || frac >= 0.25;
            }
        }
    }

    // Widen through the graph from the strongest seeds only, so a weak word match does not
    // pull in its whole neighbourhood.
    const seeds = !graph ? [] : [...seed].filter(([, e]) => e.anchor).sort((a, b) => b[1].score - a[1].score).slice(0, 8);
    const bump = (f, amount, reason) => {
        const e = entry(f);
        e.graph += amount;
        if (reason && e.reasons.length < 4 && !e.reasons.includes(reason)) e.reasons.push(reason);
    };
    for (const [s, se] of seeds) {
        const S = se.score;
        for (const u of index.users.get(s) || []) {
            if (u === s) continue;
            bump(u, S * W.user * specificity(index.deps.get(u)?.size || 0), `uses ${s}`);
            for (const u2 of index.users.get(u) || []) {
                if (u2 === s || u2 === u) continue;
                bump(u2, S * W.user2 * specificity(index.deps.get(u2)?.size || 0), null);
            }
        }
        for (const d of index.deps.get(s) || []) {
            if (d === s) continue;
            bump(d, S * W.dep * specificity(index.users.get(d)?.size || 0), `used by ${s}`);
        }
    }

    const out = [];
    for (const [f, e] of seed) {
        let score = e.score + Math.min(e.graph, W.graphCap);
        if (!parsed.wantsTests && TEST_PATH.test(f)) score *= 0.5;
        if (score <= 0.05) continue;
        const degree = (index.deps.get(f)?.size || 0) + (index.users.get(f)?.size || 0);
        score += 0.15 * Math.min(degree, 20) / 20 * (e.anchor ? 1 : 0.5);
        if (!e.reasons.length) e.reasons.push('near the files above in the code graph');
        out.push({ file: f, score: Math.round(score * 100) / 100, anchor: e.anchor, reasons: e.reasons, matched: [...e.matched] });
    }
    out.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
    return { ranked: out, anchors, unmatched: { paths: unmatchedPaths, identifiers: unmatchedIds, words: unmatchedWords } };
}

// ------------------------------------------------------------------------------ the answer

function confidenceOf(anchors, ranked) {
    const top = ranked[0]?.score || 0;
    const strong = anchors.path + anchors.symbol;
    if (strong > 0 && top >= 2) return 'high';
    if ((strong > 0 || anchors.word >= 2) && top >= 0.8) return 'medium';
    return 'low';
}

const estimateTokens = (s) => Math.ceil(s.length / 4);

export function taskContext(root, task, { maxFiles = 12, budgetTokens = 1500, now } = {}) {
    const max = Math.min(Math.max(Math.trunc(Number(maxFiles) || 12), 1), 40);
    const budget = Math.min(Math.max(Math.trunc(Number(budgetTokens) || 1500), 200), 8000);
    const parsed = parseTask(task);
    if (!parsed.text.trim()) throw new Error('task is required: describe the work in a sentence.');
    const index = getIndex(path.resolve(root), now);
    const { ranked, anchors, unmatched } = rankFiles(index, parsed);
    const confidence = confidenceOf(anchors, ranked);
    const files = ranked.slice(0, max).map(r => {
        const declared = index.symbolsOf.get(r.file) || [];
        const symbols = [...r.matched, ...declared.filter(s => !r.matched.includes(s))].slice(0, 8);
        return {
            ...r, symbols,
            usedBy: [...(index.users.get(r.file) || [])].slice(0, 4),
            uses: [...(index.deps.get(r.file) || [])].slice(0, 4)
        };
    });
    // One memory card at most (canonical architecture §6 guards: one record per task or none below
    // the floor), from the same `find` the CLI uses. A project without handoff records gets none and
    // nothing is written; an index failure falls back to the scan inside find, never out of here.
    let memory = null;
    try { memory = findMemory(path.resolve(root), parsed.text, { budget: 1 }).cards[0] || null; } catch { memory = null; }
    // A UI task in a project that keeps docs/ai/DESIGN.md reads that page first (lib/design.mjs).
    let design = null;
    try { design = designForTask(path.resolve(root), parsed.text, files.map(f => f.file)); } catch { design = null; }
    const result = {
        task: parsed.text, confidence, anchors, unmatched, files, memory, design,
        scanned: index.fileCount, considered: ranked.length, root: path.resolve(root)
    };
    result.text = formatTaskContext(result, budget);
    return result;
}

// The one memory card as two lines: a heading and the record (type, status, text clipped), at most
// MEMORY_CARD_CHARS so it costs about 120 tokens; `plutos memory open <id>` has the whole card.
const MEMORY_CARD_CHARS = 420;
function memoryLines(card) {
    if (!card) return [];
    const text = card.text.replace(/\s+/g, ' ');
    const head = `- ${card.id} ${card.type} (${card.status}${card.archived ? ', archived' : ''}): `;
    const room = Math.max(40, MEMORY_CARD_CHARS - head.length - (card.evidence ? card.evidence.length + 3 : 0));
    const body = text.length > room ? `${text.slice(0, room - 1)}…` : text;
    return ['Memory:', `${head}${body}${card.evidence ? ` [${card.evidence}]` : ''}`];
}

// `name:line` for each symbol whose declaration is found, so a reader can open a range instead of
// the whole file.
function withLines(root, file, symbols) {
    if (!root) return symbols;
    let lines;
    try { lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n'); } catch { return symbols; }
    return symbols.map(sym => {
        const esc = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const decl = new RegExp(`(?:function\\*?|class|const|let|var|def)\\s+${esc}\\b|^\\s*${esc}\\s*[:(]`);
        const at = lines.findIndex(l => decl.test(l));
        return at >= 0 ? `${sym}:${at + 1}` : sym;
    });
}

// Knowing what "done" means is the context a short prompt leaves out most often.
const DONE_WHEN_HINT = 'Before you start, write what will show it is done: board_update doneWhen.';

export function formatTaskContext(result, budgetTokens = 1500) {
    const { anchors, unmatched, files, confidence } = result;
    const head = [
        `Context for: ${result.task.length > 160 ? result.task.slice(0, 157) + '...' : result.task}`,
        `Confidence: ${confidence} (anchors: ${anchors.path} path, ${anchors.symbol} symbol, ${anchors.word} word; `
            + `${result.scanned} files scanned)`
    ];
    if (result.design) head.push(result.design);
    const tail = [];
    const missing = [...unmatched.paths, ...unmatched.identifiers];
    if (files.length && missing.length) tail.push(`Not found in the code: ${missing.slice(0, 8).join(', ')}`);
    if (!files.length) tail.push('No file in this project matches the task. Search the code yourself, and name a file or a function next time.');
    else if (confidence === 'low') tail.push('Low confidence: treat this as a hint. Search for the task\'s key terms before trusting it.');
    else tail.push('Read these first; search only for what they leave open.');
    // The memory card is the first thing cut when the budget is tight: it stays only while the
    // head, the tail and a card at its largest leave half of the budget to the files (so from a
    // budget of about 400 tokens on; the default is 1500).
    const memory = memoryLines(result.memory);
    if (memory.length && estimateTokens([...head, ...tail].join('\n')) + Math.ceil(MEMORY_CARD_CHARS / 4) <= budgetTokens * 0.5) tail.push(...memory);
    tail.push(DONE_WHEN_HINT);
    if (!files.length) return [...head, ...tail].join('\n');
    const lines = [...head, 'Start with these files:'];
    let used = estimateTokens(lines.join('\n')) + estimateTokens(tail.join('\n'));
    // A low-confidence answer is a hint to search with, so it carries paths, not detail (C4).
    let compact = confidence === 'low';
    files.forEach((f, i) => {
        const full = [`${i + 1}. ${f.file}  [${f.score}] ${f.reasons.slice(0, 3).join('; ')}`];
        if (f.symbols.length) full.push(`   declares: ${withLines(result.root, f.file, f.symbols).join(', ')}`);
        const rel = [f.usedBy.length ? `used by ${f.usedBy.join(', ')}` : '', f.uses.length ? `uses ${f.uses.join(', ')}` : ''].filter(Boolean);
        if (rel.length) full.push(`   ${rel.join(' · ')}`);
        const short = `${i + 1}. ${f.file}  [${f.score}] ${f.reasons[0]}`;
        const block = !compact && i < 6 ? full.join('\n') : short;
        if (block !== short && used + estimateTokens(block) > budgetTokens * 0.8) compact = true;
        const chosen = compact ? short : block;
        if (used + estimateTokens(chosen) > budgetTokens) return;
        lines.push(chosen);
        used += estimateTokens(chosen) + 1;
    });
    return [...lines, ...tail].join('\n');
}
