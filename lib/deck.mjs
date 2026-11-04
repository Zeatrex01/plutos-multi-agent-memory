// The story deck — the project's history as a pitch-style presentation, in plain language.
//
// The technical report (lib/report.mjs) is for running the project; this is for
// UNDERSTANDING it. Every session_end can leave a `story` line — one or two sentences a
// non-technical reader gets ("Payments work now: a customer can actually buy the product").
// Those lines accumulate: the live CONTINUITY ledger holds recent ones, the archive holds
// everything rotated out, and this module merges BOTH chronologically. So the deck is the
// project's roadmap-as-narrative, built one session at a time — history can't be
// reconstructed retroactively, but from the day stories start, nothing is lost.
//
// Same law as the brief and the report: a generated VIEW over the real files, never stored,
// so it cannot go stale. Sessions without a story fall back to their headline — an honest
// technical one-liner beats a gap in the timeline.
//
// The page wears the identity: the planet-core mark with its orbits, the
// wordmark, and the dashboard's dark colours. The mark comes from the one source every icon
// and asset is built from (tools/plutos-icon.mjs), so the deck cannot drift from them.
import fs from 'fs';
import path from 'path';
import { continuityPathFor, parseContinuity } from './continuity.mjs';
import { createBrandSvg, PLUTOS_MARK } from '../tools/plutos-icon.mjs';

function readIfExists(file) {
    try { return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; }
}

// Live ledger + every archive file, one chronological list. Archive blocks share the
// session format, so parseContinuity reads them as-is.
export function collectStories(projectRoot) {
    const sources = [];
    const archiveDir = path.join(projectRoot, 'docs', 'handoff', 'archive');
    if (fs.existsSync(archiveDir)) {
        for (const f of fs.readdirSync(archiveDir).filter(f => f.startsWith('SESSIONS-') && f.endsWith('.md')).sort()) {
            sources.push(path.join(archiveDir, f));
        }
    }
    sources.push(continuityPathFor(projectRoot));

    const seen = new Set();
    const entries = [];
    for (const file of sources) {
        const content = readIfExists(file);
        if (!content) continue;
        for (const s of parseContinuity(content).sessions) {
            if (seen.has(s.time)) continue; // a block mid-rotation could appear in both files
            seen.add(s.time);
            entries.push({
                time: s.time,
                ai: s.ai,
                headline: s.headline,
                story: s.fields.Story || '',
                next: s.fields.Next || ''
            });
        }
    }
    entries.sort((a, b) => a.time.localeCompare(b.time));
    return entries;
}

// → { project, generatedAt, what, slides: [{date, ai, text, isStory}], next }
export function buildDeck(projectRoot, { sourceRoot = projectRoot } = {}) {
    const project = path.basename(sourceRoot || projectRoot);
    const entries = collectStories(projectRoot);

    // Opening slide: the project in plain words, from the intake map's own summary.
    let what = '';
    const map = readIfExists(path.join(sourceRoot, 'docs', 'ai', 'PROJECT_MAP.md'));
    if (map) {
        const section = map.split(/^##\s+/m).find(s => /^What this is/i.test(s));
        if (section) what = section.replace(/^What this is\s*/i, '').trim().split('\n').slice(0, 4).join(' ').trim();
    }

    const slides = entries.map(e => ({
        date: e.time.slice(0, 10),
        ai: e.ai,
        text: e.story || e.headline,
        isStory: !!e.story
    }));

    const last = entries[entries.length - 1];
    return { project, generatedAt: new Date().toISOString(), what, slides, next: last?.next || '' };
}

// The deck is the one output written FOR THE OWNER rather than for an AI — a plain-language
// presentation of what the project has become. So unlike every other string in this codebase,
// its chrome follows the owner's language (owner's rule, 2026-08-01: what the user reads gets
// translated; what only an AI reads stays English).
//
// Only the chrome. The slide text itself is the `story` line an AI recorded at session_end,
// and PLUT_OS does not translate it — AGENTS.md asks the AI to write that line in the owner's
// language instead, which keeps the meaning the author intended.
export const DECK_LABELS = {
    en: {
        storySoFar: 'the story so far', kicker: 'THE STORY SO FAR',
        generated: 'Generated', perSlide: 'one slide per recorded session · a view, not a stored file.',
        whatThisIs: 'What this project is', journey: 'The journey',
        noStoryTitle: 'No story yet',
        noStoryBody: 'Sessions record a plain-language `story` line via `session_end` — from the first one on, the roadmap builds itself here.',
        noStoryHtml: 'Every session can leave a plain-language <b>story</b> line (via <code>session_end</code>).<br>From the first one on, this deck builds itself.',
        next: 'Where it goes next', nextKicker: 'NEXT',
        technical: 'technical headline — no story line was recorded',
        scroll: '↓ scroll', deckTitle: 'story deck',
        // The close: the identity record's line (decision, 2026-11-03) and Home's orbit note,
        // in the same words (ui/i18n.js orbit_note).
        identity: 'A planet core with one orbit per connected AI.',
        identityNote: 'Each AI that connects gets an orbit around the shared record: what one learns and decides, the next one reads.'
    },
    tr: {
        storySoFar: 'buraya kadarki hikâye', kicker: 'BURAYA KADARKİ HİKÂYE',
        generated: 'Oluşturuldu', perSlide: 'kayıtlı her oturum için bir slayt · bir görünüm, saklanan bir dosya değil.',
        whatThisIs: 'Bu proje nedir', journey: 'Yolculuk',
        noStoryTitle: 'Henüz hikâye yok',
        noStoryBody: 'Oturumlar `session_end` ile sade dille bir `story` satırı bırakır — ilkinden itibaren yol haritası burada kendi kendine oluşur.',
        noStoryHtml: 'Her oturum sade dille bir <b>story</b> satırı bırakabilir (<code>session_end</code> ile).<br>İlkinden itibaren bu sunum kendi kendine oluşur.',
        next: 'Bundan sonrası', nextKicker: 'SIRADAKİ',
        technical: 'teknik başlık — hikâye satırı kaydedilmemiş',
        scroll: '↓ kaydır', deckTitle: 'hikâye sunumu',
        identity: 'Bir gezegen çekirdeği, bağlı her yapay zekâ için bir yörünge.',
        identityNote: 'Bağlanan her yapay zekâ, ortak kaydın etrafında bir yörünge alır: birinin öğrendiğini ve kararlaştırdığını sıradaki okur.'
    }
};

// The product's name as the deck writes it; the underscore is the wordmark's accent (the same
// lockup as the dashboard's boot screen).
export const DECK_WORDMARK = 'PLUT_OS';

// An unknown or missing language falls back to English rather than rendering blanks.
export function deckLabels(lang) {
    return DECK_LABELS[String(lang || '').toLowerCase()] || DECK_LABELS.en;
}

export function renderDeckMarkdown(d, lang) {
    const L = deckLabels(lang);
    const out = [`# ${d.project} — ${L.storySoFar}`, `*${L.generated} ${d.generatedAt} · ${L.perSlide}*`, ''];
    if (d.what) out.push(`## ${L.whatThisIs}`, d.what, '');
    if (!d.slides.length) {
        out.push(`## ${L.noStoryTitle}`, L.noStoryBody, '');
    } else {
        out.push(`## ${L.journey}`);
        for (const s of d.slides) out.push(`- **${s.date}** — ${s.text}${s.isStory ? '' : ` *(${L.technical})*`}`);
        out.push('');
    }
    if (d.next) out.push(`## ${L.next}`, d.next, '');
    out.push(`*${DECK_WORDMARK} — ${L.identity}*`, '');
    return out.join('\n');
}

// The mark, once per slide. createBrandSvg gives every copy the same gradient and clip ids,
// and one page carries two (cover and close), so each copy gets its own id suffix: the
// browser resolves url(#…) to the first element with that id, which would otherwise be the
// cover's for both.
function deckMark(n) {
    return createBrandSvg({ className: 'deck-mark', label: DECK_WORDMARK })
        .replace(/\b(pmg|pm0|pm1)\b/g, `$1-${n}`);
}

// Standalone presentation page — served at GET /deck, opens in its own tab. Scroll-snap
// slides, no dependencies, dark; big type because it's a deck, not a document. Cover and
// close carry the mark and the wordmark; the colours are the dashboard's dark tokens
// (ui/styles.css :root under prefers-color-scheme: dark) copied here, because the page loads
// no stylesheet of the dashboard and must look the same wherever it is opened.
export function renderDeckHtml(d, lang) {
    const L = deckLabels(lang);
    const htmlLang = DECK_LABELS[String(lang || '').toLowerCase()] ? String(lang).toLowerCase() : 'en';
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const slide = (inner, cls = '') => `<section class="slide ${cls}">${inner}</section>`;
    const wordmark = `<div class="wordmark" aria-label="${esc(DECK_WORDMARK)}">PLUT<b>_</b>OS</div>`;
    const { planet, orbits } = PLUTOS_MARK;

    const slides = [];
    slides.push(slide(`<div class="lockup">${deckMark('cover')}${wordmark}</div>`
        + `<div class="kicker">${esc(L.kicker)}</div><h1>${esc(d.project)}</h1>`
        + (d.what ? `<p class="what">${esc(d.what)}</p>` : '')
        + `<p class="hint">${esc(L.scroll)}</p>`, 'cover'));
    if (!d.slides.length) {
        // noStoryHtml carries deliberate markup (<b>, <code>, <br>) — it is our own copy from
        // the table above, never user or agent input, so it is inserted unescaped by design.
        slides.push(slide(`<h2>${esc(L.noStoryTitle)}</h2><p>${L.noStoryHtml}</p>`));
    }
    d.slides.forEach((s, i) => {
        slides.push(slide(`<div class="date">${esc(s.date)} · ${esc(s.ai)}</div><p class="story">${esc(s.text)}</p>`
            + (s.isStory ? '' : `<div class="tech">${esc(L.technical)}</div>`)
            + `<div class="count">${i + 1} / ${d.slides.length}</div>`));
    });
    if (d.next) slides.push(slide(`<div class="kicker">${esc(L.nextKicker)}</div><p class="story">${esc(d.next)}</p>`, 'next'));
    slides.push(slide(`<div class="lockup">${deckMark('close')}${wordmark}</div>`
        + `<p class="identity">${esc(L.identity)}</p><p class="note">${esc(L.identityNote)}</p>`, 'close'));

    return `<!DOCTYPE html><html lang="${esc(htmlLang)}"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(d.project)} — ${esc(L.deckTitle)}</title>
<style>
  /* The dashboard's dark tokens (ui/styles.css) and the mark's own colours (tools/plutos-icon.mjs). */
  :root {
    --bg-base:#0b1120; --bg-surface:#111a2e; --border-subtle:#22304d;
    --text-title:#eef1f7; --text-body:#a9b3c6; --text-muted:#8a96ab;
    --brand-primary:#f2a541; --brand-dim:rgba(242,165,65,0.14);
    --core-light:${planet.light}; --core-dark:${planet.dark}; --orbit-a:${orbits[0].color}; --orbit-b:${orbits[1].color};
    --font-ui:-apple-system,"Segoe UI",system-ui,Roboto,sans-serif;
    --font-mono:ui-monospace,"Cascadia Mono","SF Mono",Consolas,"Liberation Mono",monospace;
    color-scheme: dark;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  html { scroll-snap-type: y mandatory; }
  body { background:var(--bg-base); color:var(--text-body); font-family:var(--font-ui); }
  .slide { position:relative; min-height:100vh; scroll-snap-align:start; display:flex; flex-direction:column; justify-content:center; align-items:center; text-align:center; padding:3rem 2rem; border-bottom:1px solid var(--border-subtle); }
  /* Cover and close glow from the core's amber, the way Home's orbit card does. */
  .cover, .close { background:radial-gradient(60% 55% at 50% 42%, var(--brand-dim) 0%, var(--bg-base) 100%); }
  .lockup { display:flex; flex-direction:column; align-items:center; gap:1.1rem; margin-bottom:2.2rem; }
  .deck-mark { width:112px; height:112px; border-radius:27px; box-shadow:0 0 0 1px var(--border-subtle), 0 18px 48px rgba(0,0,0,0.45); }
  .wordmark { color:var(--text-title); font-size:1.5rem; font-weight:700; letter-spacing:0.35em; margin-right:-0.35em; }
  .wordmark b { color:var(--brand-primary); }
  .kicker { color:var(--brand-primary); font-family:var(--font-mono); font-weight:700; letter-spacing:0.25em; font-size:0.8rem; margin-bottom:1.2rem; }
  h1 { color:var(--text-title); font-size:3.2rem; font-weight:800; letter-spacing:-0.02em; }
  h2 { color:var(--text-title); font-size:2rem; margin-bottom:1rem; }
  .what { color:var(--text-body); font-size:1.15rem; max-width:640px; margin-top:1.2rem; line-height:1.6; }
  .hint { color:var(--text-muted); margin-top:3rem; font-size:0.9rem; }
  .date { color:var(--brand-primary); font-family:var(--font-mono); font-size:0.95rem; margin-bottom:1.4rem; }
  .story { color:var(--text-title); font-size:1.7rem; line-height:1.5; max-width:760px; font-weight:500; }
  .tech { color:var(--text-muted); font-size:0.8rem; margin-top:1.4rem; font-style:italic; }
  .count { position:absolute; right:1.5rem; bottom:1.2rem; color:var(--text-muted); font-family:var(--font-mono); font-size:0.75rem; }
  .next .story { color:var(--brand-primary); }
  /* The close: the identity line in the orbit colours, the Home note under it. */
  .identity { color:var(--text-title); font-size:1.9rem; font-weight:600; line-height:1.4; max-width:720px; }
  .identity::after { content:""; display:block; width:120px; height:4px; border-radius:2px; margin:1.6rem auto 0; background:linear-gradient(90deg, var(--orbit-a), var(--core-light), var(--orbit-b)); }
  .note { color:var(--text-body); font-size:1.1rem; line-height:1.6; max-width:640px; margin-top:1.4rem; }
  p, code { line-height:1.6; }
  @media (max-width:640px) { h1 { font-size:2.2rem; } .story { font-size:1.3rem; } .identity { font-size:1.4rem; } .deck-mark { width:88px; height:88px; border-radius:21px; } }
</style></head><body>${slides.join('\n')}</body></html>`;
}
