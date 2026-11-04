// Project interview — the file-based, AI-agnostic onboarding brain.
// PLUT_OS drops docs/handoff/PROJECT_INTERVIEW.md into a project; both the dashboard
// Setup tab and any AI (via AGENTS.md Rule 0) fill the same file. Answers derive a
// profile which maps to recommended MCPs and board coordination. Single source for all of it.
import { buildRecommendation } from './recommend.mjs';

// Question schema is the source of truth; the markdown template is generated from it,
// so the file and the dashboard never drift.
export const QUESTIONS = [
    {
        id: 'type', text: 'What are you building?',
        options: ['web-app', 'mobile-app', 'game', 'api-backend', 'library-tool', 'other']
    },
    {
        id: 'stage', text: 'What stage is the project at?',
        options: ['brand-new-mvp', 'existing-growing', 'maintenance']
    },
    {
        id: 'goal', text: 'Primary goal right now?',
        options: ['ship-demo-fast', 'robust-foundation', 'fix-refactor']
    },
    {
        id: 'ai', text: 'Which AI will mainly work in this project?',
        options: ['claude-code', 'codex', 'gemini-cli', 'gemini-antigravity', 'cursor', 'multiple']
    },
    {
        id: 'team', text: 'Team size?',
        options: ['solo', 'small-team', 'larger-team']
    }
];

// answers: { type, stage, goal, ai, team } (any subset). → recommendation object.
// Answer-only (no filesystem scan) so the markdown file stays reproducible offline from
// just its own answers. Delegates the actual MCP/coordination mapping to recommend.mjs — the
// dashboard's GET /api/recommendations uses the SAME function with real scan signals too.
export function recommend(answers = {}) {
    const base = buildRecommendation({}, answers);
    const complete = QUESTIONS.every(q => answers[q.id]);
    return { ...base, complete };
}

// Extract answers from a filled PROJECT_INTERVIEW.md. Blank / placeholder answers are ignored.
export function parseInterview(markdown) {
    const answers = {};
    const lines = markdown.split(/\r?\n/);
    let currentId = null;
    for (const line of lines) {
        const q = line.match(/^##\s+([a-z0-9_-]+)\s+—/i);
        if (q) { currentId = q[1].trim(); continue; }
        const a = line.match(/^>\s*answer:\s*(.*)$/i);
        if (a && currentId) {
            const val = a[1].trim();
            const known = QUESTIONS.find(x => x.id === currentId);
            if (val && known && known.options.includes(val)) answers[currentId] = val;
            currentId = null;
        }
    }
    return answers;
}

function renderRecommendation(rec) {
    if (!rec.complete) {
        return '_(fill every answer above; PLUT_OS or your AI will complete this section)_';
    }
    return [
        `- **Recommended MCPs:** ${rec.mcps.join(', ')}`,
        `- **Board coordination:** ${rec.coordination ? 'emphasized' : 'optional (solo, single AI)'}`,
        '',
        'Why:',
        ...rec.reasons.map(r => `- ${r}`)
    ].join('\n');
}

// Generate the full PROJECT_INTERVIEW.md from the schema + any known answers.
export function renderInterview(answers = {}) {
    const rec = recommend(answers);
    const out = [
        '# PROJECT_INTERVIEW.md — PLUT_OS Project Setup',
        '',
        '> PLUT_OS dropped this file into your project. It is a short interview that lets any AI',
        '> (or the PLUT_OS dashboard Setup tab) understand the project and recommend the right',
        '> MCPs and board coordination. Answer each question by writing one of the listed options',
        '> after its `> answer:` line, then commit the file.',
        '>',
        '> **AGENTS.md Rule 0:** if any answer below is blank, ask the user before starting work,',
        '> fill it in here, and commit — so every agent shares the same project profile.',
        ''
    ];
    for (const q of QUESTIONS) {
        out.push(`## ${q.id} — ${q.text}`);
        out.push(`Options: ${q.options.join(' | ')}`);
        out.push(`> answer: ${answers[q.id] || ''}`.trimEnd());
        out.push('');
    }
    out.push('## Recommendation');
    out.push(renderRecommendation(rec));
    out.push('');
    return out.join('\n');
}
