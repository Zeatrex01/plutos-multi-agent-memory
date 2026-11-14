// Home's status list (ui/modules/overview.js statusHtml), run as browser code in a vm with stub
// helpers; never contacts a live server. Guards the open-items count against the capped lists in
// report.board (lib/report.mjs cuts each at REPORT_LIMITS.boardItems).
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { REPORT_LIMITS } from '../lib/report.mjs';

const source = fs.readFileSync(new URL('../ui/modules/overview.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const context = {
    t: key => key, escHtml: v => String(v ?? ''), emptyState: () => '', refreshApprovals() {},
    aiLinkWord: () => 'connected', fetch: () => Promise.reject(new Error('offline')), document: { getElementById: () => null }
};
vm.createContext(context);
vm.runInContext(`${source}\nthis.statusHtml = statusHtml;`, context);

let passed = 0;
const check = (name, condition) => { assert.ok(condition, name); passed++; console.log(`PASS ${name}`); };

const cap = REPORT_LIMITS.boardItems;
const capped = n => Array.from({ length: Math.min(n, cap) }, (_, i) => ({ title: `t${i}` }));
const report = {
    board: { todo: capped(12), inProgress: capped(3), blocked: capped(10) },
    stats: { todo: 12, inProgress: 3, blocked: 10, done: 4 }
};
const html = context.statusHtml({ project: 'demo', report, hooks: { hooks: [{ on: true }, { on: false }] }, mcp: { state: 'connected' } });
const openItems = html.match(/onclick="switchView\('board'\)">(\d+)</)?.[1];
check('open items counts every TODO, IN_PROGRESS and BLOCKED entry, not the capped lists', openItems === '25');
check('the blocked pill counts every BLOCKED entry', html.includes('>10 overview_blocked_pill<'));
check('a board with nothing blocked shows no blocked pill', !context.statusHtml({ project: 'demo',
    report: { board: {}, stats: { todo: 1, inProgress: 0, blocked: 0 } }, hooks: null, mcp: null }).includes('pill-blocked'));

// Home's status builds the whole report; it must not refresh on the 5-second Board tick.
const settings = fs.readFileSync(new URL('../ui/modules/settings.js', import.meta.url), 'utf8');
const every = Number(settings.match(/const HOME_EVERY = (\d+);/)?.[1]);
const ms = Number(settings.match(/const REFRESH_MS = (\d+);/)?.[1]);
check('Home status refreshes at most every 30 s', every * ms >= 30000
    && /ticks % HOME_EVERY === 0 && document\.getElementById\('view-overview'\)/.test(settings));

// Home's "Connect an AI" scrolls to Projects' #connect-section; a narrow window must not hide it.
check('the Connect steps are not hidden in the narrow layout',
    !/#connect-section[^{]*\{[^}]*display:\s*none/.test(fs.readFileSync(new URL('../ui/mobile.css', import.meta.url), 'utf8')));

// Status pills (styles.css .pill-*) sit on their tinted background over the page or a card. In
// light mode both must keep the text at WCAG 4.5:1; Home puts the blocked pill on the status list.
{
    const css = fs.readFileSync(new URL('../ui/styles.css', import.meta.url), 'utf8');
    const light = css.slice(css.indexOf(':root[data-theme="light"]'), css.indexOf(':root[data-theme="dark"]'));
    const token = name => light.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1].trim();
    const rgb = value => value.startsWith('#')
        ? [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16))
        : value.match(/[\d.]+/g).map(Number);
    const over = (fg, bg) => { const [r, g, b, a] = rgb(fg); return [r, g, b].map((c, i) => c * a + bg[i] * (1 - a)); };
    const lum = c => { const [r, g, b] = c.map(v => v / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const worst = [];
    for (const status of ['done', 'progress', 'todo', 'error']) {
        for (const page of ['bg-base', 'bg-surface']) {
            const r = ratio(rgb(token(`status-${status}`)), over(token(`status-${status}-bg`), rgb(token(page))));
            if (r < 4.5) worst.push(`${status} on ${page} ${r.toFixed(2)}`);
        }
    }
    check(`every light status pill reaches 4.5:1 on the page and on a card${worst.length ? ` (${worst.join(', ')})` : ''}`, worst.length === 0);
}

console.log(`\n${passed} passed, 0 failed`);
