// Project Setup tab: the recommendation engine's UI. Two independent signal sources feed
// one recommendation — a live filesystem scan (/api/recommendations, works with ZERO
// interview) and the optional interview answers (/api/interview). Renders both.
import { t } from '../i18n.js';
import { showToast } from './toast.js';
import { escHtml, jsArg } from '../esc.js';
import { emptyState } from './page.js';

let currentAnswers = {};

// The questions and answers are ids in PROJECT_INTERVIEW.md (lib/interview.mjs QUESTIONS), which
// AIs read and write; on screen each one has words. An id without a translation shows as itself.
function wordsFor(key, fallback) {
    const text = t(key);
    return text === key ? fallback : text;
}
const questionText = q => wordsFor(`setup_q_${q.id}`, q.text);
const optionText = opt => wordsFor(`setup_opt_${String(opt).replace(/-/g, '_')}`, opt);
const STACKS = { node: 'Node.js', python: 'Python', unity: 'Unity', unreal: 'Unreal Engine', godot: 'Godot' };

export async function fetchSetup() {
    const container = document.getElementById('setup-container');
    try {
        // A failed recommendation scan (a 500, or no answer) is shown in its place; the
        // questions still render. It used to drop the detected and recommendation sections silently.
        const [interview, recommendations] = await Promise.all([
            fetch('/api/interview').then(r => r.json()),
            fetch('/api/recommendations').then(async r => {
                const body = await r.json().catch(() => ({}));
                return r.ok && body.signals ? body : { failed: body.message || `HTTP ${r.status}` };
            }).catch(e => ({ failed: e.message }))
        ]);
        currentAnswers = interview.answers || {};
        render(container, interview, recommendations);
        lucide.createIcons();
    } catch (e) {
        container.innerHTML = `<p class="page-status">${t('conn_error')}</p>`;
    }
}

function renderDetected(signals) {
    const rows = [
        [t('detected_stack'), STACKS[signals.stack] || t('setup_stack_unknown')],
        (signals.frameworks && signals.frameworks.length) ? [t('detected_frameworks'), signals.frameworks.join(', ')] : null,
        [t('detected_tests'), signals.hasTests ? t('setup_yes') : t('setup_no')],
        [t('detected_monorepo'), signals.isMonorepo ? t('setup_yes') : t('setup_no')],
        [t('detected_git'), signals.isGitRepo ? t('setup_yes') : t('setup_no')]
    ].filter(Boolean);
    return `<section class="card">
        <div class="card-head"><h3 class="card-title"><i data-lucide="radar"></i> ${t('setup_detected_title')}</h3>
            <button class="btn-secondary btn-sm" style="margin-left:auto;" onclick="rescanSetup()"><i data-lucide="refresh-cw"></i> ${t('setup_rescan')}</button>
        </div>
        <div class="kv-grid">
            ${rows.map(([label, val]) => `<div><span class="kv-label">${escHtml(label)}</span><span class="kv-value">${escHtml(val)}</span></div>`).join('')}
        </div>
    </section>`;
}

function renderRecommendation(rec) {
    return `<section class="card card-accent">
        <div class="card-head"><h3 class="card-title"><i data-lucide="sparkles"></i> ${t('setup_recommendation')}</h3></div>
        <ul class="plain-list">
            <li><b>${t('setup_rec_mcps')}:</b> ${(rec.mcps || []).length ? escHtml(rec.mcps.join(', ')) : t('setup_rec_mcps_none')}</li>
            <li><b>${t('setup_rec_board')}:</b> ${rec.coordination ? t('setup_board_yes') : t('setup_board_no')}</li>
        </ul>
        <details class="cmd-line" style="margin-top:0.75rem;"><summary>${t('setup_why')}</summary>
            <ul class="plain-list" style="margin:0.5rem 0 0 1rem; list-style:disc; font-size:0.8rem;">${(rec.reasons || []).map(r => `<li>${escHtml(r)}</li>`).join('')}</ul>
        </details>
    </section>`;
}

function render(container, interview, recommendations) {
    const questions = (interview.questions || []).map(q => {
        const chips = q.options.map(opt => {
            const active = currentAnswers[q.id] === opt;
            return `<button class="seg setup-chip${active ? ' active' : ''}" aria-pressed="${active}" onclick="pickSetupAnswer(${escHtml(jsArg(q.id))}, ${escHtml(jsArg(opt))})">${escHtml(optionText(opt))}</button>`;
        }).join('');
        return `<div style="margin-bottom:1.5rem;" role="group" aria-label="${escHtml(questionText(q))}">
            <div style="color:var(--text-title); font-weight:600; margin-bottom:0.5rem;">${escHtml(questionText(q))}</div>
            <div class="seg-bar">${chips}</div>
        </div>`;
    }).join('');

    const optInNote = interview.exists === false
        ? `<div style="margin-bottom:1rem;">${emptyState({ icon: 'clipboard-list', title: t('setup_not_started') })}</div>`
        : '';

    const detected = (recommendations && recommendations.signals) ? renderDetected(recommendations.signals) : '';
    const recBox = (recommendations && recommendations.recommendation)
        ? renderRecommendation(recommendations.recommendation)
        : recommendations && recommendations.failed
            ? `<div role="alert">${emptyState({ icon: 'alert-triangle', title: t('setup_scan_failed'), text: recommendations.failed,
                action: { label: t('setup_rescan'), onclick: 'rescanSetup()' } })}</div>` : '';

    container.innerHTML = detected + optInNote + `<section class="card">${questions}</section>${recBox}`;
}

window.rescanSetup = async function() {
    await fetchSetup();
    showToast(t('setup_rescanned'));
};

window.pickSetupAnswer = async function(id, value) {
    currentAnswers[id] = value;
    try {
        const res = await fetch('/api/interview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ answers: currentAnswers })
        });
        const data = await res.json();
        if (!data.success) { showToast(t('error') + ': ' + data.message, true); return; }
        // Answers feed the scan-driven recommendation too — refetch both.
        await fetchSetup();
    } catch (e) {
        showToast(t('conn_error'), true);
    }
};
