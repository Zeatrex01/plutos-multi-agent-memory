// Home's status list (ui/modules/overview.js statusHtml) and the Activity page's Usage and Work
// sections (ui/modules/activity-page.js), run as browser code in a vm with stub helpers; never
// contacts a live server. Guards the open-items count against the capped lists in report.board
// (lib/report.mjs cuts each at REPORT_LIMITS.boardItems).
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { REPORT_LIMITS, buildStatusReport } from '../lib/report.mjs';
import { buildUsageReport } from '../lib/usage-report.mjs';

const source = fs.readFileSync(new URL('../ui/modules/overview.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const context = {
    t: key => key, escHtml: v => String(v ?? ''), emptyState: () => '', refreshApprovals() {},
    aiLinkWord: () => 'connected', fetch: () => Promise.reject(new Error('offline')), document: { getElementById: () => null }
};
vm.createContext(context);
vm.runInContext(`${source}\nthis.statusHtml = statusHtml;`, context);
// Activity (owner, 2026-11-15: usage and work on a separate page, not on Home).
const activitySource = fs.readFileSync(new URL('../ui/modules/activity-page.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const actx = {
    t: key => key, escHtml: v => String(v ?? ''), emptyState: ({ title }) => `<div class="empty-state">${title}</div>`,
    fetch: () => Promise.reject(new Error('offline')), document: { getElementById: () => null }
};
vm.createContext(actx);
vm.runInContext(`${activitySource}\nthis.usageHtml = usageHtml; this.workHtml = workHtml; this.fetchActivityPage = fetchActivityPage;`, actx);
// The stub escHtml above passes text through; the Usage and Work checks need the real one.
const escSrc = fs.readFileSync(new URL('../ui/esc.js', import.meta.url), 'utf8');
const realEsc = new Function(`${escSrc.replace(/^export /gm, '')}\nreturn escHtml;`)();

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

// "Usage, last 7 days" and "Work" (owner, 2026-11-15): the two things the owner opens the dashboard
// for. Rendered from the real route data of a temporary project, with the real escaper.
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plutos-home-'));
    try {
        const handoff = path.join(root, 'docs', 'handoff');
        fs.mkdirSync(handoff, { recursive: true });
        fs.mkdirSync(path.join(root, '.plutos'));
        const now = new Date();
        const at = h => new Date(now.getTime() - h * 3600e3).toISOString();
        const sessions = Array.from({ length: 6 }, (_, i) => [
            `### ${at(60 - i * 10)} · ${i % 2 ? 'codex' : 'claude-code'} · Session ${i}${i === 5 ? ' <script>alert(1)</script>' : ''}`,
            `- **Did:** did ${i}`, `- **Next:** next ${i}`, ...(i === 5 ? ['- **Not checked:** the Windows build <b>x</b>'] : []), ''
        ].join('\n'));
        fs.writeFileSync(path.join(handoff, 'CONTINUITY.md'), `# CONTINUITY\n\n## Digest\n\n## Sessions\n\n${sessions.join('\n')}`);
        fs.writeFileSync(path.join(handoff, 'BOARD.md'), [
            '# BOARD', '', '### claude-code · IN_PROGRESS · Wire <img src=x onerror=alert(1)>', '- **Task:** t', '',
            '### codex · BLOCKED · Needs a key', '- **Task:** t', '', '### claude-code · TODO · Archive <u>old</u> sessions', '- **Task:** t', '', '### codex · DONE · Shipped the parser', '- **Task:** t', ''
        ].join('\n'));
        const line = (h, ai, kind, name) => JSON.stringify({ t: at(h), ai, kind, name, ok: true, ms: 5 });
        fs.writeFileSync(path.join(root, '.plutos', 'usage.jsonl'), [
            line(30, 'claude-code', 'hook', 'brief'), line(29.9, 'claude-code', 'tool', 'board_read'), line(29.8, 'claude-code', 'tool', 'board_read'),
            line(29.7, 'claude-code', 'tool', 'session_end'), line(20, 'codex', 'tool', 'session_start'), line(19, 'codex', 'tool', 'plutos_code_lookup'),
            line(18, '<i>evil</i>', 'tool', 'board_read')
        ].join('\n') + '\n');

        const report = buildStatusReport(root, { days: 7 });
        check('/api/report sessions carry Not checked', report.sessions[0].notChecked.startsWith('the Windows build'));
        check('/api/report gives the last 5 sessions, newest first', report.sessions.length === 5 && report.sessions[0].headline.startsWith('Session 5'));
        const usage = buildUsageReport(root, { days: 7, tools: ['board_read', 'plutos_ask', 'session_start'], commitDays: null });
        check('/api/usage counts per AI', usage.ais.find(a => a.ai === 'Claude Code')?.toolCalls === 3 && usage.ais.find(a => a.ai === 'Codex')?.sessionsStarted === 1);

        actx.escHtml = realEsc;
        const u = actx.usageHtml(usage);
        // Draft B (d-872338fa9556): the three large numbers, the last one sessions left open.
        const kpis = [...u.matchAll(/act-kpi-n">(\d+)</g)].map(m => Number(m[1]));
        check('Usage shows tool calls, sessions opened and sessions left open large', JSON.stringify(kpis) === JSON.stringify([
            usage.totals.toolCalls, usage.totals.sessionsStarted, usage.ais.reduce((a, r) => a + Math.max(0, r.sessionsStarted - r.sessionsEnded), 0)])
            && u.includes('home_usage_calls') && u.includes('act_left_open_label'));
        check('Sessions left open take the accent only when there are some', u.includes('act-kpi act-alert') === (kpis[2] > 0));
        check('Usage has a row per AI with a bar, opened and closed', /<th scope="row">Claude Code<\/th><td><div class="act-callbar"><b>3<\/b><span><i style="width:100\.0%"><\/i><\/span><\/div><\/td><td class="act-num">1<\/td><td class="act-num">1<\/td>/.test(u)
            && u.includes('>Codex<'));
        check('An AI that left a session open has its closed count marked', /<th scope="row">Codex<\/th>.*?<span class="act-warn">0<\/span>/.test(u));
        check('Usage lists the most used tools', u.includes('<li><code>board_read</code><b>3</b></li>'));
        check('Usage lists listed tools never called', u.includes('<code>plutos_ask</code>') && !u.includes('<code>session_start</code></p>'));
        check('Usage escapes an AI name from the log', u.includes('&lt;i&gt;evil') && !u.includes('<i>evil'));
        const none = actx.usageHtml(buildUsageReport(path.join(root, 'docs'), { days: 7, tools: [], commitDays: null }));
        check('Usage says so when nothing is recorded yet', none.includes('home_usage_none') && !none.includes('act-table'));

        const w = actx.workHtml(report);
        check('Work shows each session with headline, AI, Did, Not checked and Next', w.includes(`<span>${report.sessions[0].ai}</span>`)
            && w.includes('did 5') && w.includes('act_col_not_checked') && w.includes('next 5') && /act-when"><b>/.test(w));
        check('Work marks an empty Not checked with a dash', (w.match(/class="act-muted act-empty act-nc"/g) || []).length === 4);
        check('Work escapes AI-written headlines and fields', !w.includes('<script>') && !w.includes('<b>x</b>') && w.includes('&lt;script&gt;'));
        const col = kind => w.match(new RegExp(`act-col act-col-${kind}"><div class="act-col-h"><em>[^<]*</em><span>(\\d+)</span>`))?.[1];
        check('Work counts and names the board items', col('progress') === '1' && col('blocked') === '1'
            && w.includes('Needs a key') && w.includes('Shipped the parser') && w.includes('Wire &lt;img'));
        check('Work counts and names the TODO items', col('todo') === '1' && w.includes('Archive &lt;u&gt;old&lt;/u&gt; sessions'));
        const groupSum = ['blocked', 'progress', 'todo'].reduce((a, k) => a + Number(col(k)), 0);
        check('Work\'s not-done columns add up to Status\'s open items', groupSum === report.stats.todo + report.stats.inProgress + report.stats.blocked
            && groupSum === 3);
        check('Never-called tools are separated', /<code>plutos_ask<\/code> · <code>|<code>plutos_ask<\/code><\/p>/.test(u));
        // A BLOCKED entry shows what it waits on (its Needs, or its Result) in place of the agent.
        const blockedWhy = actx.workHtml({ board: { blocked: [{ agent: 'codex', title: 'Hook', needs: 'owner <decision>' }] }, stats: { blocked: 1 }, sessions: [] });
        check('a blocked entry says what it waits on in place of the agent', blockedWhy.includes('<small class="act-why">act_waits_on</small>') && !blockedWhy.includes('codex'));

        // fetchActivityPage fills #activity-usage and #activity-work from the route data and shows their
        // sections; with no project it hides them again and says why.
        const els = Object.fromEntries(['activity-empty', 'activity-usage', 'activity-work', 'activity-usage-section', 'activity-work-section']
            .map(id => [id, { innerHTML: '', hidden: true }]));
        const routes = { '/api/workspaces': { activeWorkspace: root }, '/api/report': report, '/api/usage?days=7': usage };
        actx.document = { getElementById: id => els[id] || null };
        actx.lucide = { createIcons() {} };
        actx.fetch = url => Promise.resolve({ ok: url in routes, json: async () => routes[url] });
        await actx.fetchActivityPage();
        check('fetchActivityPage fills Usage and Work and shows both sections', els['activity-usage'].innerHTML.includes('act-kpi-n')
            && els['activity-work'].innerHTML.includes('Shipped the parser') && !els['activity-usage-section'].hidden
            && !els['activity-work-section'].hidden && els['activity-empty'].innerHTML === '');
        routes['/api/workspaces'] = { activeWorkspace: null };
        await actx.fetchActivityPage();
        check('fetchActivityPage hides Usage and Work with no project', els['activity-usage-section'].hidden && els['activity-work-section'].hidden
            && els['activity-usage'].innerHTML === '' && els['activity-work'].innerHTML === '' && els['activity-empty'].innerHTML.includes('home_no_project_title'));
        check('Work says so with no sessions', actx.workHtml({ board: {}, stats: {}, sessions: [] }).includes('home_work_no_sessions'));
        check('Work and Usage say the data did not load', actx.workHtml(null).includes('conn_error') && actx.usageHtml(null).includes('conn_error'));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }

    const i18n = fs.readFileSync(new URL('../ui/i18n.js', import.meta.url), 'utf8');
    const keys = [...fs.readFileSync(new URL('../ui/modules/activity-page.js', import.meta.url), 'utf8').matchAll(/(?:t|fill)\('((?:home_(?:usage|work)|act)_[a-z_0-9]+)'\)/g)].map(m => m[1]);
    keys.push('act_last_7', 'act_last_30', 'tab_activity', 'title_activity');
    const missing = [...new Set(keys)].filter(k => i18n.split(`        ${k}:`).length - 1 !== 2);
    check(`every Usage and Work string is in en and tr${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`, missing.length === 0);
    const html = fs.readFileSync(new URL('../dashboard-ui.html', import.meta.url), 'utf8');
    const page = (id, nextId) => html.slice(html.indexOf(`<section id="${id}"`), html.indexOf(`<section id="${nextId}"`));
    const activity = page('view-activity', 'hub-view');
    check('the Activity page has the Usage and Work sections', ['activity-usage', 'activity-work', 'activity-usage-section', 'activity-work-section']
        .every(id => activity.includes(`id="${id}"`)) && activity.includes('data-i18n="title_activity"'));
    const home = page('view-overview', 'view-activity');
    check('Home keeps only Waiting for you and Status', home.includes('id="home-waiting"') && home.includes('id="home-status"')
        && !/(usage|work)/.test(home.replace(/<!--[\s\S]*?-->/g, '')));
    check('Home\'s module no longer renders Usage or Work', !('usageHtml' in context) && !/function (usageHtml|workHtml)/.test(source));

    // Status labels start with a capital like the rest; the top bar keeps its lowercase sys_project.
    const split = i18n.indexOf('\n    tr: {'), en = i18n.slice(0, split), tr = i18n.slice(split);
    check('Status labels the project with a capitalised key in en and tr', /row\(t\('home_project'\)/.test(source)
        && split > 0 && /home_project: "Project",/.test(en) && /home_project: "Proje",/.test(tr));
    // The approval note placeholder was cut off on a phone (2026-11-15): keep it short in both languages.
    const ph = [...i18n.matchAll(/approval_note_ph: "((?:[^"\\]|\\.)*)"/g)].map(m => m[1].replace(/\\"/g, '"'));
    check('the approval note placeholder fits a phone (at most 28 characters, en and tr)', ph.length === 2 && ph.every(p => p.length <= 28));
    // On a 375 px phone the top bar pushed the theme toggle off screen (2026-11-15): the narrow layout
    // drops the word "project" and tightens the bar's gap.
    const mobileCss = fs.readFileSync(new URL('../ui/mobile.css', import.meta.url), 'utf8');
    const styles = fs.readFileSync(new URL('../ui/styles.css', import.meta.url), 'utf8');
    check('the narrow top bar keeps the theme toggle on screen', /\.dim\[data-i18n="sys_project"\]\s*\{\s*display:\s*none/.test(mobileCss)
        && /\.system-bar \{ gap: 0\.4rem; padding: 0 0\.5rem;/.test(styles));
    // The unreleased changelog must not say Usage and Work are on Home.
    // The public copy ships without CHANGELOG.md; there the check has nothing to read.
    const changelogUrl = new URL('../CHANGELOG.md', import.meta.url);
    const changelog = fs.existsSync(changelogUrl) ? fs.readFileSync(changelogUrl, 'utf8') : '## [Unreleased]\n- Activity: (no changelog in this copy)\n';
    // The newest section with entries: Unreleased, or the release just cut from it.
    const sections = changelog.split(/\n(?=## \[)/).filter(x => x.startsWith('## ['));
    const unreleased = sections.find(x => /^- /m.test(x)) || '';
    check('the unreleased changelog places Usage and Work on Activity, not Home', !/^- Home(:| Work)/m.test(unreleased) && /^- Activity/m.test(unreleased));
}

console.log(`\n${passed} passed, 0 failed`);
