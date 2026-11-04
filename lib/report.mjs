// Status report — the third map. PROJECT_MAP answers "what is this project", CODEINDEX
// answers "where does the code live"; nothing answered "WHERE ARE WE" — what happened, what
// changed, what's next. The owner could only learn that by going and reading the documents
// themselves. This module reads them instead and assembles one presentation-ready report.
//
// Design rules, same as the session brief:
//   - A VIEW, generated per request from the real sources (git, CONTINUITY.md, boards,
//     hygiene). Never stored, so it can never go stale or drift from reality.
//   - Everything it claims carries its source; nothing is invented. If a source is missing,
//     the report says so instead of guessing.
//   - Language: the DATA is English (like every PLUT_OS file); the `status_report` MCP tool
//     tells the AI to PRESENT it in the user's own language — presentation is the AI's job,
//     facts are ours.
import fs from 'fs';
import path from 'path';
import { historyGit } from './git-history.mjs';
import { parseBoardEntries } from './board.mjs';
import { boardPathFor, agentBoardPathFor } from './roadmap.mjs';
import { continuityPathFor, parseContinuity } from './continuity.mjs';
import { hygieneReport } from './hygiene.mjs';
import { assessContext } from './context.mjs';
import { claimLog } from './claim-check.mjs';

export const REPORT_LIMITS = {
    days: 7,          // default reporting window
    commits: 15,      // commit lines shown (with "…and N more" past it)
    sessions: 5,      // recent sessions shown
    boardItems: 8     // items per board section
};

// History only, but windowed by the clock (`--since=N days ago`): reused for at most a minute.
function git(projectRoot, args) {
    return historyGit(projectRoot, args, { windowMs: 60_000 });
}

// → { commits: [..], total, filesChanged, insertions, deletions, contributors: [..] } | null
function gitActivity(projectRoot, days) {
    try {
        const since = `--since=${days} days ago`;
        // One log call carries hash + date + subject; `commits` keeps the legacy
        // "hash subject" strings (Report tab + MCP markdown), `commitsDetailed`
        // adds dates so the Overview timeline can interleave commits with sessions.
        const raw = git(projectRoot, ['log', since, '--pretty=%h%cI%s']).split('\n').filter(Boolean);
        if (!raw.length) return { commits: [], commitsDetailed: [], total: 0, filesChanged: 0, insertions: 0, deletions: 0, contributors: [] };
        const detailed = raw.map(l => {
            const [hash, date, ...rest] = l.split('');
            return { hash, date, subject: rest.join('') };
        });
        const stat = git(projectRoot, ['log', since, '--shortstat', '--pretty=']);
        let files = 0, ins = 0, del = 0;
        for (const m of stat.matchAll(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/g)) {
            files += Number(m[1] || 0); ins += Number(m[2] || 0); del += Number(m[3] || 0);
        }
        const contributors = [...new Set(git(projectRoot, ['log', since, '--pretty=%an']).split('\n').filter(Boolean))];
        return {
            commits: detailed.slice(0, REPORT_LIMITS.commits).map(c => `${c.hash} ${c.subject}`),
            commitsDetailed: detailed.slice(0, REPORT_LIMITS.commits),
            total: detailed.length, filesChanged: files, insertions: ins, deletions: del, contributors
        };
    } catch (e) {
        return null; // not a git repo — the report will say so rather than pretend
    }
}

function readBoard(file) {
    try { return fs.existsSync(file) ? parseBoardEntries(fs.readFileSync(file, 'utf8')) : []; } catch (e) { return []; }
}

// → structured report object; renderReportMarkdown() turns it into the presentation text.
export function buildStatusReport(projectRoot, { days = REPORT_LIMITS.days, sourceRoot = projectRoot, indexRoot = projectRoot } = {}) {
    const project = path.basename(sourceRoot || projectRoot);
    const generatedAt = new Date().toISOString();

    const activity = gitActivity(sourceRoot, days);

    const contFile = continuityPathFor(projectRoot);
    const { digest, sessions } = fs.existsSync(contFile)
        ? parseContinuity(fs.readFileSync(contFile, 'utf8'))
        : { digest: [], sessions: [] };
    const recentSessions = sessions.slice(-REPORT_LIMITS.sessions).reverse()
        .map(s => ({ time: s.time, ai: s.ai, headline: s.headline, did: s.fields.Did || '', next: s.fields.Next || '', story: s.fields.Story || '' }));

    const main = readBoard(boardPathFor(projectRoot));
    const agents = readBoard(agentBoardPathFor(projectRoot));
    const all = [...main, ...agents];
    const byStatus = (st) => all.filter(e => e.status === st).slice(0, REPORT_LIMITS.boardItems)
        .map(e => ({ agent: e.agent, title: e.title, assignee: e.fields.Assignee || '', task: e.fields.Task || '' }));

    // Next steps come from recorded intent, in priority order: what each AI's latest session said
    // comes next, then unclaimed assignments. An AI's newer record supersedes its older ones: on
    // b5680bb two of one AI's sessions gave contradicting next steps, and the report listed both.
    const nextSteps = [];
    const seen = new Set();
    for (const s of recentSessions) {
        const ai = s.ai.trim().toLowerCase();
        if (seen.has(ai)) continue;
        seen.add(ai);
        if (s.next) nextSteps.push({ text: s.next, source: `${s.ai} session` });
        if (nextSteps.length >= 3) break;
    }
    for (const e of byStatus('TODO')) {
        if (nextSteps.length >= 6) break;
        nextSteps.push({ text: `${e.title}${e.assignee ? ` (assigned: ${e.assignee})` : ''}`, source: 'board TODO' });
    }

    const hygiene = hygieneReport(projectRoot, { sourceRoot, indexRoot });
    const context = assessContext(projectRoot);
    const watchouts = [
        ...all.filter(e => e.status === 'BLOCKED').map(e => `BLOCKED: ${e.agent} — ${e.title}`),
        ...hygiene.warnings.filter(w => w.level !== 'info').map(w => `${w.source}: ${w.message}`),
        ...(context.error ? [`Shared context registry: ${context.error}`] : []),
        ...(context.stale.length ? [`${context.stale.length} shared context claim(s) quarantined because a source changed, disappeared, or drifted.`] : []),
        ...(context.review.length ? [`${context.review.length} shared context claim(s) to re-check: their source was edited, the cited excerpt is still there.`] : [])
    ];

    // Passive honesty counters: what the claim check sent back in the window,
    // and what a session kept after the one return. Counted per claim, from the git directory's record.
    const since = Date.now() - days * 24 * 3600e3;
    const recent = claimLog(sourceRoot).filter(e => Date.parse(e.at) >= since);
    const count = phase => recent.filter(e => e.phase === phase).reduce((n, e) => n + (e.findings?.length || 0), 0);
    const claimCheck = { sentBack: count('blocked'), kept: count('failed') };

    return {
        project, generatedAt, days, claimCheck,
        stats: {
            commits: activity ? activity.total : null,
            filesChanged: activity ? activity.filesChanged : null,
            insertions: activity ? activity.insertions : null,
            deletions: activity ? activity.deletions : null,
            contributors: activity ? activity.contributors : [],
            sessions: recentSessions.length,
            inProgress: all.filter(e => e.status === 'IN_PROGRESS').length,
            todo: all.filter(e => e.status === 'TODO').length,
            done: all.filter(e => e.status === 'DONE').length,
            blocked: all.filter(e => e.status === 'BLOCKED').length
        },
        isGitRepo: activity !== null,
        commits: activity ? activity.commits : [],
        commitsDetailed: activity ? activity.commitsDetailed : [],
        commitsOverflow: activity ? Math.max(0, activity.total - activity.commits.length) : 0,
        sessions: recentSessions,
        board: { inProgress: byStatus('IN_PROGRESS'), todo: byStatus('TODO'), blocked: byStatus('BLOCKED'), done: byStatus('DONE') },
        nextSteps,
        watchouts,
        digest,
        context
    };
}

// Every section carries one of the shared evidence labels:
// fact, inference, assumption, proposal, unknown.
// The presentation text — used verbatim by the dashboard's Report tab and handed to the AI
// by the status_report MCP tool (which asks it to present in the user's language).
export function renderReportMarkdown(r) {
    const out = [`# STATUS REPORT — ${r.project}`, `*Generated ${r.generatedAt} · window: last ${r.days} days · a view, not a stored file.*`, ''];

    out.push('## At a glance');
    if (r.isGitRepo) {
        out.push(`- **${r.stats.commits} commit${r.stats.commits === 1 ? '' : 's'}** · ${r.stats.filesChanged} file change${r.stats.filesChanged === 1 ? '' : 's'} (+${r.stats.insertions}/−${r.stats.deletions})${r.stats.contributors.length ? ` · by ${r.stats.contributors.join(', ')}` : ''}`);
    } else {
        out.push('- Not a git repository — repo activity unavailable (sessions and boards below still apply).');
    }
    out.push(`- **Board:** ${r.stats.inProgress} in progress · ${r.stats.todo} to do · ${r.stats.blocked} blocked · ${r.stats.done} done-not-yet-archived`);
    if (r.claimCheck?.sentBack || r.claimCheck?.kept) {
        out.push(`- **Claim check** (fact: git and the disk): ${r.claimCheck.sentBack} claim(s) sent back, ${r.claimCheck.kept} kept after the return`);
    }
    out.push('');

    if (r.sessions.length) {
        out.push('## What happened (assumption: the sessions\' own records, newest first)');
        for (const s of r.sessions) out.push(`- **${s.headline}** — ${s.ai}, ${s.time.slice(0, 10)}${s.did ? `: ${s.did}` : ''}`);
        out.push('');
    } else {
        out.push('## What happened', '- No sessions recorded yet — AIs record them via `session_end`; until then this section has nothing honest to say.', '');
    }

    if (r.commits.length) {
        out.push(`## Landed in the repo (fact: git, last ${r.days} days)`);
        for (const c of r.commits) out.push(`- ${c}`);
        if (r.commitsOverflow) out.push(`- …and ${r.commitsOverflow} more`);
        out.push('');
    }

    if (r.board.inProgress.length || r.board.blocked.length) {
        out.push('## In flight right now (assumption: the board)');
        for (const e of r.board.inProgress) out.push(`- 🔵 **${e.agent}** — ${e.title}`);
        for (const e of r.board.blocked) out.push(`- 🔴 BLOCKED: **${e.agent}** — ${e.title}`);
        out.push('');
    }

    if (r.context?.current?.length || r.context?.review?.length || r.context?.stale?.length || r.context?.unverified?.length) {
        out.push('## Shared context health');
        for (const item of r.context.current.slice(0, 8)) {
            out.push(`- ✅ **Fact (source-backed):** ${item.claim} *(${item.sources.map(source => source.path).join(', ')})*`);
        }
        for (const item of (r.context.review || []).slice(0, 8)) {
            out.push(`- 🔎 **Assumption, re-check:** ${item.claim} *(${item.reasons.join('; ')})*`);
        }
        for (const item of r.context.stale.slice(0, 8)) {
            out.push(`- ⏳ **Unknown, source changed:** ${item.claim} *(${item.reasons.join('; ')})*`);
        }
        for (const item of r.context.unverified.slice(0, 8)) {
            out.push(`- ❔ **Assumption, no source:** ${item.claim}`);
        }
        out.push('');
    }

    out.push('## Next steps (proposal: each AI\'s latest session, then the board)');
    if (r.nextSteps.length) for (const n of r.nextSteps) out.push(`- ${n.text} *(${n.source})*`);
    else out.push('- Nothing recorded — no session `next` and no open board TODOs.');
    out.push('');

    if (r.watchouts.length) {
        out.push('## Watch-outs (fact: computed from the files)');
        for (const w of r.watchouts) out.push(`- ⚠️ ${w}`);
        out.push('');
    }

    return out.join('\n');
}
