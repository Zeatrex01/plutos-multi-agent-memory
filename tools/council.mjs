#!/usr/bin/env node
// The council's command line. The moderator (Claude Code) runs these; the owner watches the Council tab.
//
//   node tools/council.mjs new <room> --title "…" (--brief "…" | --brief-file f) [--departments research,design] [--project <dir>]
//   node tools/council.mjs ask <room> <department> [--instruction "…" | --instruction-file f] [--kind critique] [--read <file> …] [--dry-run]
//   node tools/council.mjs reveal <room>                       open the sealed round on the shared table
//   node tools/council.mjs post <room> --kind discussion|consolidation|decision (--text "…" | --text-file f) [--from claude|human]
//                                                               consolidation and decision only after reveal
// Ask one department at a time: two asks to the same department in parallel race on its session state.
//   node tools/council.mjs next <room> (--text "…" | --text-file f)   start the next round from the consolidated list
//   node tools/council.mjs read <room> [--since ID]             print the transcript
//   node tools/council.mjs list                                 rooms in the project
// --project defaults to the current directory.
import fs from 'fs';
import path from 'path';
import { councilConfig, moderatorId, createRoom, roomExists, readLog, readRoom, append, currentRound, revealedRounds, listRooms } from '../lib/council-room.mjs';
import { askDepartment } from '../lib/council-seats.mjs';
import { getCoordinationRoot } from '../lib/workspaces.mjs';

function args(argv) {
    const pos = [], opt = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const k = a.slice(2), v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
            opt[k] = k in opt ? [].concat(opt[k], v) : v;
        } else pos.push(a);
    }
    return { pos, opt };
}
const list = v => v === undefined ? [] : [].concat(v);
const readText = (opt, k) => opt[`${k}-file`] ? fs.readFileSync(opt[`${k}-file`], 'utf8') : (typeof opt[k] === 'string' ? opt[k] : '');

const [cmd, ...rest] = process.argv.slice(2);
const { pos, opt } = args(rest);
// Same root the dashboard reads: the project itself when the PLUT_OS kit is installed there,
// otherwise its observe-mode folder under the PLUT_OS app data.
const project = getCoordinationRoot(path.resolve(typeof opt.project === 'string' ? opt.project : process.cwd()));
const [slug] = pos;
const needRoom = () => { if (!roomExists(project, slug)) throw new Error(`No room "${slug}" in ${project}.`); };

try {
    if (cmd === 'new') {
        const dir = createRoom(project, slug, { title: opt.title, brief: readText(opt, 'brief'),
            departments: opt.departments ? String(opt.departments).split(',') : undefined });
        console.log(`room ${dir}`);
    } else if (cmd === 'ask') {
        needRoom();
        const r = await askDepartment(project, slug, pos[1], { instruction: readText(opt, 'instruction'), kind: opt.kind, reads: list(opt.read), dryRun: !!opt['dry-run'] });
        if (r.dryRun) console.log(`${pos[1]} (${r.seat}) would read ${r.reads.length} file(s); prompt ${r.prompt.length} characters\n\n${r.prompt}`);
        else if (!r.ok) { console.error(`${pos[1]} did not answer (details: ${r.errorFile}):\n${r.log.split('\n').slice(-15).join('\n')}`); process.exitCode = 1; }
        else console.log(`#${r.message.id} ${pos[1]}: ${r.message.text.slice(0, 400)}${r.message.text.length > 400 ? '…' : ''}`);
    } else if (cmd === 'reveal') {
        needRoom();
        const log = readLog(project, slug), round = currentRound(log);
        if (revealedRounds(log).has(round)) throw new Error(`Round ${round} is already revealed.`);
        const m = append(project, slug, { from: moderatorId(), kind: 'reveal', round, text: `Round ${round} revealed on the shared table.` });
        console.log(`#${m.id} round ${round} revealed`);
    } else if (cmd === 'post') {
        needRoom();
        const text = readText(opt, 'text'), kind = opt.kind || 'discussion', from = opt.from || moderatorId();
        if (!text) throw new Error('post needs --text or --text-file');
        // Department work only comes from a seat (ask); the moderator and owner speak, consolidate and decide.
        if (!['discussion', 'consolidation', 'decision'].includes(kind)) throw new Error('post takes --kind discussion, consolidation or decision; department work comes only through the ask command.');
        if (![moderatorId(), 'human'].includes(from)) throw new Error(`post --from is ${moderatorId()} or human.`);
        const log = readLog(project, slug), round = currentRound(log);
        if (kind !== 'discussion' && !revealedRounds(log).has(round)) throw new Error(`Round ${round} is still sealed; reveal it before you ${kind === 'decision' ? 'decide' : 'consolidate'}.`);
        const m = append(project, slug, { from, kind, text });
        console.log(`#${m.id} posted (${m.kind})`);
    } else if (cmd === 'next') {
        needRoom();
        const log = readLog(project, slug), round = currentRound(log), max = councilConfig().maxRounds || 2;
        if (!revealedRounds(log).has(round)) throw new Error(`Round ${round} is still sealed; reveal it first.`);
        if (round >= max) throw new Error(`Round limit (${max}) reached: the owner decides now (post --kind decision).`);
        const text = readText(opt, 'text');
        if (!text) throw new Error('next needs --text or --text-file (what to improve)');
        const m = append(project, slug, { from: moderatorId(), kind: 'brief', round: round + 1, text });
        console.log(`#${m.id} round ${round + 1} started`);
    } else if (cmd === 'read') {
        needRoom();
        const since = +opt.since || 0;
        console.log(`# ${readRoom(project, slug).title}\n`);
        for (const m of readLog(project, slug).filter(m => m.id > since && m.kind !== 'system'))
            console.log(`--- #${m.id} ${m.dept || m.from} · round ${m.round} · ${m.kind}\n${m.text}${m.files?.length ? '\n[files] ' + m.files.join(', ') : ''}\n`);
    } else if (cmd === 'list') {
        for (const r of listRooms(project)) console.log(`${r.slug}  round ${r.round} · ${r.step}  ${r.title}`);
    } else {
        console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 11).join('\n'));
    }
} catch (e) { console.error(e.message); process.exitCode = 1; }
