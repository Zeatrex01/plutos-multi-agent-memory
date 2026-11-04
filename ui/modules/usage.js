// Local token ledger — the second half of the spend tab, and the half that answers "who
// spent what".
//
// It sits below CodeBurn rather than replacing it because they answer different questions.
// CodeBurn gives a machine-wide, currency-denominated lifetime rollup from `npx --no codeburn` (when installed);
// this reads the Claude CLI's own per-session transcripts off disk and splits the result by
// project, by model and by session. No network, so this half still renders when the other one
// is on standby.
//
// Every table ranks by WORK — output plus thinking. Cache reads are 300x larger than output
// in a real session, so ranking by a combined total would rank by cache reuse rather than by
// what a seat produced: the longest conversation would win regardless of what it did. Cache
// reads get their own column and stay out of the ranking.
//
// The By agent table is the one the owner actually reads to decide who to hand work to, so it
// comes first. Read BOTH its work and cache columns before concluding anything: a subagent
// reads a great deal and writes very little (measured: 1.23M cache read against 755 output for
// one review), so it looks free by work and is not free by tokens.
import { t } from '../i18n.js';
import { escHtml } from '../esc.js';
import { emptyState } from './page.js';

const n = (v) => Number(v || 0).toLocaleString();
const work = (r) => (r.output || 0) + (r.thinking || 0);

// A project directory name is the project path with every separator flattened to a dash, and
// that is not reversible. Showing the tail is honest and is what tells two projects apart.

function table(titleKey, rows, label) {
    if (!rows.length) return '';
    const top = work(rows[0]) || 1;
    return `<div style="margin-top:1.4rem;">
        <div class="pane-sub">${t(titleKey)}</div>
        <div style="overflow-x:auto;">
        <table class="usage-table">
            <thead><tr>
                <th>${t('usage_col_name')}</th>
                <th class="num">${t('usage_col_work')}</th>
                <th class="num">${t('usage_col_output')}</th>
                <th class="num">${t('usage_col_thinking')}</th>
                <th class="num">${t('usage_col_calls')}</th>
                <th class="num">${t('usage_col_cache_w')}</th>
                <th class="num">${t('usage_col_cache_r')}</th>
            </tr></thead>
            <tbody>${rows.map(r => `<tr${r.current ? ' class="is-current"' : ''}>
                <td>
                    <div class="usage-bar" style="--w:${Math.round((work(r) / top) * 100)}%"></div>
                    <span>${escHtml(label(r))}</span>
                </td>
                <td class="num strong">${n(work(r))}</td>
                <td class="num">${n(r.output)}</td>
                <td class="num">${n(r.thinking)}</td>
                <td class="num">${n(r.calls)}</td>
                <td class="num dim">${n(r.cacheWrite)}</td>
                <td class="num dim">${n(r.cacheRead)}</td>
            </tr>`).join('')}</tbody>
        </table></div>
    </div>`;
}

// The ledger reads the open project's Claude transcripts (lib/usage.mjs; a long project can hold
// hundreds of MB, held for 30 s afterwards) and the server answers nothing else while it does. The page says
// what it is reading while it waits, gives up after USAGE_TIMEOUT_MS, and offers Try again.
const USAGE_TIMEOUT_MS = 30000;
let usageShown = false;

function usageState(html) {
    const box = document.getElementById('usage-container');
    if (!box) return;
    box.innerHTML = html;
    if (window.lucide) lucide.createIcons();
}

export async function fetchUsage(force = false) {
    const box = document.getElementById('usage-container');
    if (!box) return;
    if (!usageShown || force) {
        usageState(`<p class="page-status" role="status" style="display:flex; align-items:center; gap:0.4rem; margin:0;"><i data-lucide="hourglass" style="width:14px; height:14px;" aria-hidden="true"></i>${t('usage_loading')}</p>`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), USAGE_TIMEOUT_MS);
    try {
        const res = await fetch(`/api/usage${force ? '?force=1' : ''}`, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json();
        usageShown = true;

        if (d.needsProject) {
            usageState(emptyState({ icon: 'folder-open', title: t('hub_no_project'), text: t('usage_needs_project') }));
            return;
        }
        if (!d.available) {
            usageState(emptyState({ icon: 'scale', title: t('usage_none_title'), text: t('usage_none') }));
            return;
        }
        if (!d.totals.calls) {
            usageState(emptyState({ icon: 'scale', title: t('usage_empty_title'), text: t('usage_empty') }));
            return;
        }

        const tot = d.totals;
        const mb = (d.scannedBytes / 1048576).toFixed(1);
        box.innerHTML = `
            <div class="usage-heads">
                <div class="usage-head"><b>${n(work(tot))}</b><span>${t('usage_col_work')}</span></div>
                <div class="usage-head"><b>${n(tot.calls)}</b><span>${t('usage_col_calls')}</span></div>
                <div class="usage-head dim"><b>${n(tot.cacheRead)}</b><span>${t('usage_col_cache_r')}</span></div>
            </div>
            <p class="usage-note">${t('usage_scanned').replace('{files}', n(d.scannedFiles)).replace('{mb}', mb)}${
                d.truncated ? ` <b style="color:var(--status-todo);">${t('usage_truncated').replace('{n}', n(d.skippedFiles))}</b>` : ''
            }</p>
            ${table('usage_by_agent', d.agents, r => r.main
                ? t('usage_main_thread')
                : (r.label || r.id).slice(0, 64))}
            ${table('usage_by_model', d.models, r => r.name)}
            ${table('usage_by_session', d.sessions, r => r.id.slice(0, 8) + (r.started ? ` · ${new Date(r.started).toLocaleDateString()}` : ''))}
        `;
    } catch (e) {
        usageShown = false;
        usageState(emptyState({ icon: 'triangle-alert', title: t('usage_error_title'),
            text: t(e && e.name === 'AbortError' ? 'usage_timeout_text' : 'lib_no_answer'),
            action: { label: t('lib_try_again'), onclick: 'refreshUsage()' } }));
    } finally {
        clearTimeout(timer);
    }
}

window.fetchUsage = fetchUsage;
window.refreshUsage = () => fetchUsage(true);
