// Ported from core (lib/acquire/verify.mjs: normaliseQuote, protectFoldings, stripMarkdownFormatting, the token matcher), the owner's own MIT work.
//
// Is a quote on a page, verbatim? Verbatim means case-sensitive after typographic and whitespace normalisation, on
// whole tokens: a quote that ends in "5" is not on a page that says "50%", "5.5", "5 000" or "-5", "C" is not "C#",
// "won" is not "won't". A match that needs a change of case is reported (caseOnly) but not confirmed. A quote in a
// script written without spaces (Chinese, Japanese, Thai...) cannot be checked by the token rule and is reported
// unsupported, never confirmed. Nothing that carries meaning is stripped from the quote or the page; Markdown
// formatting is removed only from page text PLUT_OS itself converted to Markdown (lib/research/scrapling_bridge.py).
// core's whitespace-ignored path for converted PDF and Office documents is not ported: the research fetch reads
// HTML, text and JSON only.

// NFKC would fold glyphs that carry meaning into plain digits and letters ("5¹" into "51", "CO₂" into "CO2",
// "1½" into "11⁄2"). Before it runs, on page and quote alike, each such glyph becomes a marker and its plain form:
// "^" for superscripts, "_" for subscripts, "@" for vulgar fractions and enclosed numbers. A glyph still matches itself.
const SUPERSCRIPT = /[²³¹⁰-ⁿ]/g;
const SUBSCRIPT = /[₀-₟]/g;
const ENCLOSED = /[¼-¾⅐-⅟↉①-⓿㉑-㉟㊱-㊿\u{1F100}-\u{1F10C}]/gu;
export function protectFoldings(s) {
    return String(s ?? '')
        .replace(SUPERSCRIPT, c => `^${c.normalize('NFKC')}`)
        .replace(SUBSCRIPT, c => `_${c.normalize('NFKC')}`)
        .replace(ENCLOSED, c => `@${c.normalize('NFKC')}`);
}

// Typographic and whitespace normalisation only: "C#", "2*3" and "[1]" stay as they are on both sides.
export function normaliseQuote(s) {
    return protectFoldings(s)
        .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
        .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
        .replace(/[\u2010-\u2015\u2212]/g, '-')
        .replace(/\u2026/g, '...')
        .normalize('NFKC')
        .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// Markdown formatting, removed only as formatting: heading hashes, list bullets and quote marks at the start of a
// line, link and image syntax reduced to the visible text, emphasis and code markers that wrap words. A `#`, `*`,
// `_` or bracket inside or directly after a word or number is text and stays.
export function stripMarkdownFormatting(text) {
    return String(text ?? '')
        .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
        .replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/gm, m => (/\d/.test(m) ? m : ''))
        .replace(/^[ \t]*>[ \t]?/gm, '')
        .replace(/!\[[^\]\n]*\]\([^)\s]*(?:\s+"[^"\n]*")?\)/g, '')
        .replace(/\[([^\]\n]+)\]\([^)\s]*(?:\s+"[^"\n]*")?\)/g, '$1')
        .replace(/(^|[^\p{L}\p{N}\p{M}_*`\\])(\*{1,3}|_{1,3}|`{1,3})(?=\S)([^\n]*?\S)\2(?![\p{L}\p{N}\p{M}_*`])/gmu, '$1$3');
}

// The token rule. Page text and quote are split on whitespace (after normalisation; nothing more is stripped).
// The quote's tokens must equal a run of consecutive page tokens: inner tokens exactly, the first and last token
// up to edge punctuation on their outer side (on the page or in the quote). Edge punctuation is opening quotes and
// brackets at the start, closing quotes, brackets and sentence punctuation at the end; never - + # / % $ or an
// apostrophe inside a word.
const LEAD = `"'“‘«([`;
const TRAIL = `"'”’»)].,;:!?…`;
function stripLead(token) {
    let i = 0;
    while (i < token.length && LEAD.includes(token[i])) i++;
    return token.slice(i);
}
function stripTrail(token) {
    let j = token.length;
    while (j > 0 && TRAIL.includes(token[j - 1])) j--;
    return token.slice(0, j);
}
const ALL_DIGITS = /^\p{Nd}+$/u;
const THREE_DIGITS = /^\p{Nd}{3}$/u;
const bare = token => stripTrail(stripLead(token ?? ''));
const group = token => token !== undefined && THREE_DIGITS.test(bare(token));
const tokens = text => text.split(' ').filter(Boolean);

// Does the quote's token list qt sit at page tokens pt[i..]?
function tokensAt(qt, pt, i) {
    const n = qt.length;
    if (i + n > pt.length) return false;
    if (n === 1) {
        if (bare(qt[0]) !== bare(pt[i])) return false;
    } else {
        if (stripLead(qt[0]) !== stripLead(pt[i])) return false;
        for (let k = 1; k < n - 1; k++) if (qt[k] !== pt[i + k]) return false;
        if (stripTrail(qt[n - 1]) !== stripTrail(pt[i + n - 1])) return false;
    }
    return neighboursOk(bare(qt[0]), bare(qt[n - 1]), pt[i - 1], pt[i + n]);
}

// A page token before the match that ends in a hyphen ("non-" at a line break, "pre-" in "pre- and post-war")
// joins the first word to it. Digit grouping: "5" is not on a page that says "5 000", nor "000" on "12 000".
const HYPHENATED = /[^-]-$/;
function neighboursOk(first, last, before, after) {
    if (before !== undefined && HYPHENATED.test(before)) return false;
    if (ALL_DIGITS.test(last) && group(after)) return false;
    if (ALL_DIGITS.test(first) && group(before)) return false;
    if (THREE_DIGITS.test(first) && before !== undefined && ALL_DIGITS.test(bare(before))) return false;
    return true;
}

function tokenMatch(text, q) {
    const qt = tokens(q);
    if (!qt.length) return false;
    const pt = tokens(text);
    for (let i = 0; i + qt.length <= pt.length; i++) if (tokensAt(qt, pt, i)) return true;
    return false;
}

// Scripts written without spaces between words: the token rule cannot tell a word from part of one there.
const UNSPACED = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}\p{sc=Tibetan}]/u;
export const isUnspacedScript = quote => UNSPACED.test(String(quote ?? ''));

// body: a frozen source page, PLUT_OS's own Markdown conversion. It is compared as stored and with Markdown
// formatting removed. Returns { found, caseOnly, unsupported? }.
export function findQuote(quote, body) {
    const q = normaliseQuote(quote);
    if (!q) return { found: false, caseOnly: false };
    if (isUnspacedScript(q)) return { found: false, caseOnly: false, unsupported: 'unspaced-script' };
    const texts = [normaliseQuote(body), normaliseQuote(stripMarkdownFormatting(body))];
    if (texts.some(t => tokenMatch(t, q))) return { found: true, caseOnly: false };
    const lower = q.toLowerCase();
    return { found: false, caseOnly: texts.some(t => tokenMatch(t.toLowerCase(), lower)) };
}
