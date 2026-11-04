#!/usr/bin/env node
// PLUT_OS mini: the project memory without the PLUT_OS server ("in some projects the session's
// Claude says the server must be started first"). One file, no dependencies, Node 18+. It reads and writes the same
// files the full PLUT_OS keeps (docs/handoff/BOARD.md, docs/handoff/CONTINUITY.md, SCOPE.md), in the same formats,
// so a project can move to the full PLUT_OS later and keep everything.
//
//   node plutos-mini.mjs init [project]          handoff files, the skills in .claude/skills, a SessionStart hook
//   node plutos-mini.mjs brief [project]         what a session starts from (the hook runs this)
//   node plutos-mini.mjs end --ai A --headline H [--did --decided "a; b" --next --not-checked --story] [--project P]
//   node plutos-mini.mjs board start|done|blocked --ai A --title T [--task --result] [--project P]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scopeBriefLines } from './scope.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, '..');                       // skills/plutos-mini
const SKILLS_DIR = path.resolve(SKILL_DIR, '..');                 // skills/
const AGREEMENT = path.join(SKILL_DIR, 'references', 'WORKING_AGREEMENT.md');
const KEEP_SESSIONS = 5;
const BOARD_SEED = '# BOARD - Shared Agent Status\n<!-- plutos:clean-template -->\n\nRules: see `AGENTS.md`. Read before starting, update when starting/finishing.\n\n---\n\n(no active tasks - add your entry above this line)\n';
const CONTINUITY_SEED = `# CONTINUITY — session memory

Maintained by PLUT_OS (\`session_start\` / \`session_end\` MCP tools, or PLUT_OS mini). Boards hold live work;
this holds how the project got here, so a new session (any AI) starts informed instead of
re-deriving — and stops making decisions that contradict earlier ones.

## Digest — settled decisions
<!-- DECISION lines are project case law. Legacy plain lines are retained for compatibility,
     but session_start labels them unverified. New learned claims live in CONTEXT.json. -->

## Sessions

(no sessions recorded yet)
`;

const HEADER = /^###\s+(.+?)\s*·\s*(.+?)\s*·\s*(.+)$/;
const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const flat = (text, max = 600) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
const paths = root => ({ board: path.join(root, 'docs', 'handoff', 'BOARD.md'), continuity: path.join(root, 'docs', 'handoff', 'CONTINUITY.md') });

function args(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith('--')) { const k = argv[i].slice(2); out[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
        else out._.push(argv[i]);
    }
    return out;
}

// Session blocks and the digest, as the full PLUT_OS writes them.
function blocks(text) {
    const lines = text.split(/\r?\n/), out = [];
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(HEADER);
        if (!m || !/^\d{4}-\d{2}-\d{2}T/.test(m[1])) continue;
        let end = i + 1;
        while (end < lines.length && !/^#{2,3}\s/.test(lines[end])) end++;
        const fields = {};
        for (const l of lines.slice(i + 1, end)) { const f = l.match(/^-\s+\*\*(.+?):\*\*\s*(.*)$/); if (f) fields[f[1]] = f[2]; }
        out.push({ time: m[1], ai: m[2], headline: m[3], fields, start: i, end });
    }
    return out;
}

export function brief(root) {
    const p = paths(root);
    const out = [`# SESSION BRIEF (PLUT_OS mini) — ${path.basename(root)}`, ''];
    const scissors = path.join(SKILLS_DIR, 'project-scissors', 'SKILL.md');
    out.push(...scopeBriefLines(root, Date.now(), scissors));
    const board = read(p.board);
    if (board) {
        const live = board.split(/\r?\n/).map(l => l.match(HEADER)).filter(m => m && !/^DONE$/i.test(m[2].trim()));
        out.push('## Board (live)', ...(live.length ? live.map(m => `- ${m[1]} · ${m[2]} · ${m[3]}`) : ['(no live entries)']), '');
    }
    const cont = read(p.continuity);
    if (cont) {
        const digest = cont.split(/^##\s+Digest[^\n]*$/m)[1]?.split(/^##\s/m)[0] || '';
        const decided = digest.split('\n').filter(l => l.trim().startsWith('- ')).slice(-8);
        if (decided.length) out.push('## Settled decisions (latest)', ...decided, '');
        const recent = blocks(cont).slice(-3);
        if (recent.length) {
            out.push('## Last sessions');
            for (const b of recent) out.push(`- ${b.time.slice(0, 16)} · ${b.ai} · ${b.headline}${b.fields.Next ? ` — next: ${b.fields.Next}` : ''}`);
            out.push('');
        }
    }
    if (!board && !cont) out.push(`No PLUT_OS records here yet: \`node ${path.join(HERE, 'plutos-mini.mjs')} init\` creates them.`, '');
    const rules = read(AGREEMENT);
    if (rules) out.push('(PLUT_OS mini: where the rules name a PLUT_OS tool, use this script: session_start = `brief`, session_end = `end`, board_update = `board`; plutos_context_for_task: read the board, SCOPE.md and the files the task names.)',
        rules.trim(), '');
    out.push(`Finish with: node ${path.join(HERE, 'plutos-mini.mjs')} end --ai <you> --headline "<what>" --did "…" --decided "a; b" --next "…" --story "<one sentence for the owner, in their language>"`);
    return out.join('\n');
}

export function end(root, o) {
    if (!o.ai || !o.headline) throw new Error('end needs --ai and --headline');
    const file = paths(root).continuity;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let text = read(file) ?? CONTINUITY_SEED;
    const decided = String(o.decided || '').split(';').map(s => flat(s)).filter(Boolean);
    if (decided.length) {   // DECISION lines into the digest, skipping exact repeats
        const at = text.search(/^##\s+Sessions/m);
        const have = text.toLowerCase();
        const add = decided.map(d => `- DECISION: ${d}`).filter(l => !have.includes(l.toLowerCase()));
        if (add.length && at >= 0) text = `${text.slice(0, at).trimEnd()}\n${add.join('\n')}\n\n${text.slice(at)}`;
    }
    const field = (label, value) => value && value !== true ? [`- **${label}:** ${flat(value)}`] : [];
    const block = [`### ${new Date().toISOString()} · ${flat(o.ai, 80)} · ${flat(o.headline, 160)}`,
        ...field('Did', o.did), ...field('Decided', decided.join('; ')), ...field('Changed', o.changed), ...field('Next', o.next),
        ...field('Not checked', o['not-checked']), ...field('Story', o.story)].join('\n');
    text = text.includes('(no sessions recorded yet)') ? text.replace('(no sessions recorded yet)', block) : `${text.trimEnd()}\n\n${block}\n`;
    // Keep the live file short: older sessions move to docs/handoff/archive/SESSIONS-<yyyy-mm>.md.
    const all = blocks(text);
    if (all.length > KEEP_SESSIONS) {
        const lines = text.split(/\r?\n/), old = all.slice(0, all.length - KEEP_SESSIONS);
        const archive = path.join(path.dirname(file), 'archive', `SESSIONS-${new Date().toISOString().slice(0, 7)}.md`);
        fs.mkdirSync(path.dirname(archive), { recursive: true });
        const prev = read(archive) ?? '# Session archive\n';
        fs.writeFileSync(archive, `${prev.trimEnd()}\n\n${old.map(b => lines.slice(b.start, b.end).join('\n').trimEnd()).join('\n\n')}\n`);
        for (const b of old.reverse()) lines.splice(b.start, b.end - b.start);
        text = lines.join('\n').replace(/\n{3,}/g, '\n\n');
    }
    fs.writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`);
    return file;
}

export function board(root, action, o) {
    const status = { start: 'IN_PROGRESS', done: 'DONE', blocked: 'BLOCKED' }[action];
    if (!status || !o.ai || !o.title) throw new Error('board needs start|done|blocked, --ai and --title');
    const file = paths(root).board;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lines = (read(file) ?? BOARD_SEED).split(/\r?\n/);
    const ai = flat(o.ai, 80), title = flat(o.title, 120);
    const at = lines.findIndex(l => { const m = l.match(HEADER); return m && m[1] === ai && m[3] === title; });
    if (at >= 0) {
        lines[at] = `### ${ai} · ${status} · ${title}`;
        let i = at + 1;
        while (i < lines.length && lines[i].startsWith('- ')) i++;
        if (o.result) lines.splice(i, 0, `- **Result / Output:** ${flat(o.result, 300)}`);
    } else {
        const entry = [`### ${ai} · ${status} · ${title}`, `- **Started:** ${new Date().toISOString().slice(0, 16)}`,
            ...(o.task ? [`- **Task:** ${flat(o.task, 300)}`] : []), ...(o.result ? [`- **Result / Output:** ${flat(o.result, 300)}`] : []), ''];
        const marker = lines.findIndex(l => l.includes('(no active tasks'));
        lines.splice(marker >= 0 ? marker : lines.length, 0, ...entry);
    }
    fs.writeFileSync(file, lines.join('\n'));
    return file;
}

export function init(root) {
    const p = paths(root);
    fs.mkdirSync(path.dirname(p.board), { recursive: true });
    if (!fs.existsSync(p.board)) fs.writeFileSync(p.board, BOARD_SEED);
    if (!fs.existsSync(p.continuity)) fs.writeFileSync(p.continuity, CONTINUITY_SEED);
    // The skills into the project's .claude/skills (unless they already run from there), and a SessionStart hook in
    // .claude/settings.local.json that prints the brief: Claude Code then starts every session from it.
    const target = path.join(root, '.claude', 'skills');
    if (path.resolve(SKILLS_DIR) !== path.resolve(target)) {
        for (const name of ['plutos-mini', 'project-scissors']) {
            const from = path.join(SKILLS_DIR, name);
            if (fs.existsSync(from)) fs.cpSync(from, path.join(target, name), { recursive: true });
        }
    }
    const settings = path.join(root, '.claude', 'settings.local.json');
    const json = JSON.parse(read(settings) || '{}');
    const command = 'node .claude/skills/plutos-mini/scripts/plutos-mini.mjs brief';
    json.hooks ??= {};
    json.hooks.SessionStart ??= [];
    if (!JSON.stringify(json.hooks.SessionStart).includes('plutos-mini.mjs brief')) {
        json.hooks.SessionStart.push({ matcher: 'startup|clear|compact', hooks: [{ type: 'command', command }] });
    }
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, `${JSON.stringify(json, null, 2)}\n`);
    return { board: p.board, continuity: p.continuity, skills: target, settings };
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
    const a = args(process.argv.slice(2));
    const [cmd, maybe] = a._;
    try {
        if (!cmd || cmd === 'help' || a.help) {
            console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 11).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
        } else if (cmd === 'brief') console.log(brief(path.resolve(maybe || a.project || '.')));
        else if (cmd === 'init') console.log(JSON.stringify(init(path.resolve(maybe || a.project || '.')), null, 2));
        else if (cmd === 'end') console.log(`recorded in ${end(path.resolve(a.project || '.'), a)}`);
        else if (cmd === 'board') console.log(`updated ${board(path.resolve(a.project || '.'), maybe, a)}`);
        else throw new Error(`unknown command: ${cmd} (try --help)`);
    } catch (e) { console.error(e.message); process.exit(2); }
}
