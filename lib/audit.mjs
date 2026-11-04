// `plutos audit <project>`: what an older PLUT_OS left in a project, and what else there needs a
// look. Read-only: auditProject() changes nothing in
// the project. The one writer here, cleanLeftovers(), moves the catalogue's leftovers into the Hub
// (never deletes) and runs only from `plutos audit --clean` in an interactive terminal.
//
// Six sections, each a list of findings
//   { severity: 'high'|'medium'|'low', kind, path, line?, message, fix: 'repair'|'move'|'ai'|'owner' }
//   leftovers  the catalogue's paths (lib/kit-history.mjs) present here, with size and last commit
//   kitFiles   today's kit files: missing, an older copy (Repair refreshes it), edited by the owner
//   records    `plutos check` without its baseline: fresh findings and the ones the baseline accepts
//   documents  documents whose named files changed after the document's last commit (docDrift)
//   memory     the memory check (lib/memory.mjs) and an old CONTINUITY digest
//   setup      readiness, the map and the code index, the launcher wiring (the repair plan), clients
// A kind stops after AUDIT_LIMIT findings; the rest is counted in `omitted`.
//
// The verdict, in this order:
//   old    no current kit (no kit file at all, or AGENTS.md is a past kit version), or the
//          leftovers and older kit copies outnumber the current kit files present
//   mixed  any high or medium finding, or any leftover, alongside a current kit
//   clean  otherwise (low findings may remain)
// A leftover counts here when it is certain: a 'move' or 'refresh' path, or a 'keep-if-edited' one
// the install record proves unedited. One found by its name alone is listed (low) and counts for
// nothing, since the project may hold its own file of that name.
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { APP_ROOT } from './approot.mjs';
import { LEFTOVERS, pathPattern } from './kit-history.mjs';
import {
    PAST_KIT_RULES, PLUTOS_KIT_MARKER, PLUTOS_PROJECT_MARKER, CLAUDE_RULE_HEADER, fileIsOurKit, kitPointer, pastPointers,
    kitProtocolText, launcherStub, looksLikePlutosProject, planInstalledProjectRepair
} from './workspaces.mjs';
import { checkClaimsAgainstBaseline } from './claims.mjs';
import { docDrift, collectDocPaths, hygieneReport } from './hygiene.mjs';
import { memoryCheck } from './memory.mjs';
import { projectReadiness } from './readiness.mjs';
import { connectionPlan } from './connect.mjs';

export const AUDIT_LIMIT = 30;
export const AUDIT_SECTIONS = ['leftovers', 'kitFiles', 'records', 'documents', 'memory', 'setup'];
export const SECTION_TITLES = { leftovers: 'Leftovers', kitFiles: 'Kit files', records: 'Records', documents: 'Documents', memory: 'Memory', setup: 'Setup' };
const SEVERITIES = ['high', 'medium', 'low'];
const FILE_LIMIT = 512 * 1024;
const WALK_LIMIT = 5000;
const INSTALL_RECORD = '.plutos/install-manifest.json';
const HISTORY_DOC = /^(?:CHANGELOG|IDEAS)\.md$|^docs\/handoff\/(?:archive|results)\/|^docs\/ai\/(?:CODEINDEX|OBSIDIAN_INDEX)\.md$|^docs\/ai\/(?:codeindex|obsidian)\//;
const RECORD_CHECKS = ['missing-path', 'line-past-end', 'npm-script', 'count'];

const sha = text => createHash('sha256').update(text).digest('hex');
const lstat = file => { try { return fs.lstatSync(file); } catch { return null; } };
const lf = text => text.replace(/\r\n/g, '\n');

// A regular file's text with LF line ends; null for a missing, linked, large or unreadable one.
function readText(root, relative) {
    const st = lstat(path.join(root, relative));
    if (!st || !st.isFile() || st.size > FILE_LIMIT) return null;
    try { return lf(fs.readFileSync(path.join(root, relative), 'utf8')); } catch { return null; }
}

function git(root, args) {
    try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, maxBuffer: 8 * 1024 * 1024 }).trim(); }
    catch { return null; }
}

// Every file under a folder (or the file itself), project-relative, bounded; links are not followed.
function filesUnder(root, relative, out = [], depth = 0) {
    if (out.length >= WALK_LIMIT || depth > 12) return out;
    const st = lstat(path.join(root, relative));
    if (!st || st.isSymbolicLink()) return out;
    if (st.isFile()) { out.push(relative); return out; }
    if (!st.isDirectory()) return out;
    let names = [];
    try { names = fs.readdirSync(path.join(root, relative)).sort(); } catch { return out; }
    for (const name of names) filesUnder(root, `${relative}/${name}`, out, depth + 1);
    return out;
}
const sizeOf = (root, relative) => filesUnder(root, relative).reduce((n, f) => n + (lstat(path.join(root, f))?.size || 0), 0);
const kb = bytes => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;

// The paths in the project a catalogue pattern names: * segments are read from the folder, links skipped.
function expand(root, pattern) {
    const { segments, folder } = pathPattern(pattern);
    let current = [''];
    for (const [i, segment] of segments.entries()) {
        const next = [];
        for (const base of current) {
            const dir = path.join(root, base);
            const names = typeof segment === 'string' ? [segment] : (() => {
                try { return fs.readdirSync(dir).filter(name => segment.test(name)).sort().slice(0, 500); } catch { return []; }
            })();
            for (const name of names) {
                const relative = base ? `${base}/${name}` : name;
                const st = lstat(path.join(root, relative));
                if (!st || st.isSymbolicLink()) continue;
                if (i < segments.length - 1 && !st.isDirectory()) continue;
                if (i === segments.length - 1 && folder && !st.isDirectory()) continue;
                next.push(relative);
            }
        }
        current = next;
    }
    return current;
}

// The old installer's record: { owner: [{ rel, sha256 }] } → Map(rel → sha256).
function installRecord(root) {
    const text = readText(root, INSTALL_RECORD);
    const files = new Map();
    try {
        const parsed = JSON.parse(text || '{}');
        for (const list of Object.values(parsed && typeof parsed === 'object' ? parsed : {})) {
            for (const f of Array.isArray(list) ? list : []) if (typeof f?.rel === 'string' && /^[a-f0-9]{64}$/i.test(f.sha256 || '')) files.set(f.rel, f.sha256.toLowerCase());
        }
    } catch { /* an unreadable record proves nothing */ }
    return files;
}
// Unedited: every file under the path is in the record with the bytes it had when it was copied.
function provenUnedited(root, relative, record) {
    const files = filesUnder(root, relative);
    if (!files.length || files.length >= WALK_LIMIT) return false;
    return files.every(f => {
        if (record.get(f) === undefined) return false;
        try { return sha(fs.readFileSync(path.join(root, f))) === record.get(f); } catch { return false; }
    });
}
// The folders packs placed (.plutos/packs.json): those are today's, not leftovers.
function packPlaced(root) {
    const placed = new Set();
    try {
        const record = JSON.parse(readText(root, '.plutos/packs.json') || '{}');
        for (const entry of Object.values(record.active || {})) for (const key of Object.keys(entry?.placed || {})) placed.add(key);
    } catch { /* none */ }
    return placed;
}

function collector() {
    const sections = Object.fromEntries(AUDIT_SECTIONS.map(s => [s, []]));
    const omitted = Object.fromEntries(AUDIT_SECTIONS.map(s => [s, {}]));
    const counts = Object.fromEntries(AUDIT_SECTIONS.map(s => [s, {}]));
    const add = (section, finding) => {
        counts[section][finding.kind] = (counts[section][finding.kind] || 0) + 1;
        if (counts[section][finding.kind] > AUDIT_LIMIT) { omitted[section][finding.kind] = (omitted[section][finding.kind] || 0) + 1; return; }
        sections[section].push(finding);
    };
    return { sections, omitted, add };
}

// --- leftovers -------------------------------------------------------------------------------------
function leftovers(root, add, { isRepo }) {
    const record = installRecord(root);
    const recordedPaths = [...record.keys()];
    const placed = packPlaced(root);
    const seen = [];
    let count = 0;
    for (const entry of LEFTOVERS) {
        for (const relative of expand(root, entry.path)) {
            if (seen.some(s => relative === s || relative.startsWith(`${s}/`))) continue;
            if (entry.contains) {
                const st = lstat(path.join(root, relative));
                if (!st?.isFile()) continue;
                let head = '';
                try { const fd = fs.openSync(path.join(root, relative), 'r'); try { const buf = Buffer.alloc(256 * 1024); head = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, 0)); } finally { fs.closeSync(fd); } } catch { continue; }
                if (!head.includes(entry.contains)) continue;
            }
            if (entry.names || entry.recorded) {
                if (placed.has(relative)) continue;
                const name = relative.split('/').at(-1);
                const named = entry.names?.includes(name);
                const recorded = entry.recorded && recordedPaths.some(f => f === relative || f.startsWith(`${relative}/`));
                if (!named && !recorded) continue;
            }
            seen.push(relative);
            count++;
            let movable = entry.action === 'move';
            let note = '';
            if (relative === INSTALL_RECORD) {
                const listed = recordedPaths.filter(f => lstat(path.join(root, f)));
                if (listed.length) { movable = false; note = ` It still lists ${listed.length} file(s) in the project, so it stays until they go.`; }
            }
            if (entry.action === 'keep-if-edited') {
                movable = provenUnedited(root, relative, record);
                note = movable ? ' The install record shows it unedited.' : ' Nothing proves it unedited: keep it if you use it, otherwise move it by hand.';
            }
            const last = isRepo ? git(root, ['log', '-1', '--format=%h %cs', '--', relative]) : null;
            const severity = entry.action === 'keep-if-edited' ? 'low' : 'medium';
            const kind = entry.action === 'refresh' ? 'leftover-refresh' : entry.action === 'keep-if-edited' ? 'leftover-check' : 'leftover';
            add('leftovers', {
                severity, kind, path: lstat(path.join(root, relative))?.isDirectory() ? `${relative}/` : relative,
                message: `${entry.why}; not written since ${entry.since} (${entry.commit}).${note}`,
                fix: entry.action === 'refresh' ? 'repair' : movable ? 'move' : 'owner',
                action: entry.action, since: entry.since, commit: entry.commit, movable,
                size: sizeOf(root, relative), lastCommit: last || null
            });
        }
    }
    return count;
}

// --- kit files ---------------------------------------------------------------------------------------
function kitFiles(root, add, plan, pastRules) {
    const facts = { kit: looksLikePlutosProject(root), current: 0, older: 0, rulesOld: false, agentsOurs: false };
    if (!facts.kit) {
        add('kitFiles', { severity: 'high', kind: 'no-kit', path: 'AGENTS.md', fix: 'owner',
            message: 'No PLUT_OS kit here: no kit AGENTS.md, board protocol or launcher. plutos init installs it (it never overwrites a file).' });
        return facts;
    }
    const planned = new Set((plan?.changes || []).map(c => path.relative(root, c.path).split(path.sep).join('/')));
    const missing = (relative, severity, fix, what) => add('kitFiles', { severity, kind: 'missing', path: relative, fix,
        message: `${what} is missing; ${fix === 'repair' ? 'Repair writes it' : 'plutos init writes it again (it never overwrites a file)'}.` });
    const older = (relative, severity, how) => { facts.older++; add('kitFiles', { severity, kind: 'older-copy', path: relative, fix: 'repair', message: `An older copy the kit wrote and nobody edited: ${how}.` }); };
    const edited = (relative, what) => add('kitFiles', { severity: 'low', kind: 'edited', path: relative, fix: 'owner', message: `${what}: edited by the owner or an older kit version, compare it by hand with what the kit writes today.` });

    const agents = readText(root, 'AGENTS.md');
    const current = lf(fs.readFileSync(path.join(APP_ROOT, 'AGENTS.md'), 'utf8'));
    const past = agents !== null && pastRules.includes(sha(agents));
    const ours = past || fileIsOurKit(path.join(root, 'AGENTS.md'));
    facts.agentsOurs = ours;
    if (agents === null && !lstat(path.join(root, 'AGENTS.md'))) missing('AGENTS.md', 'medium', 'owner', 'The rules every AI reads (AGENTS.md)');
    else if (ours) {
        if (agents === current) facts.current++;
        else if (past) { facts.rulesOld = true; older('AGENTS.md', 'high', 'every AI here reads past rules; Repair refreshes it'); }
        else edited('AGENTS.md', `Carries the kit marker (${PLUTOS_KIT_MARKER} or "${PLUTOS_PROJECT_MARKER}") but matches no kit version`);
    }

    const claude = readText(root, 'CLAUDE.md');
    const ownClaude = claude !== null && !claude.startsWith('# AI Agent Guide') && !/AGENTS\.md|PLUTOS_PROTOCOL/.test(claude);
    if (!ours || ownClaude) {
        const protocol = readText(root, 'docs/handoff/PLUTOS_PROTOCOL.md');
        if (protocol === null) missing('docs/handoff/PLUTOS_PROTOCOL.md', 'medium', 'owner', 'The board protocol this project\'s own rules need beside them');
        else if (protocol === kitProtocolText()) facts.current++;
        else if (protocol.startsWith('# PLUT_OS Board Protocol')) edited('docs/handoff/PLUTOS_PROTOCOL.md', 'The board protocol differs from today\'s');
    }
    if (agents !== null || lstat(path.join(root, 'AGENTS.md'))) {
        for (const [relative, marker] of [['CLAUDE.md', '# AI Agent Guide'], ['GEMINI.md', '# AI Agent Guide'], ['.cursor/rules/plutos.mdc', 'PLUT_OS coordination convention']]) {
            const text = relative === 'CLAUDE.md' ? claude : readText(root, relative);
            if (text === null) { if (!lstat(path.join(root, relative))) missing(relative, 'low', 'owner', `The pointer that makes its AI tool load the rules (${relative})`); continue; }
            if (text === kitPointer(relative, ours)) facts.current++;
            else if (pastPointers(relative, ours).includes(text)) older(relative, 'medium', 'the text-only pointer that does not load the rules; Repair refreshes it');
            else if (text.includes(marker)) edited(relative, 'The pointer differs from today\'s');
        }
    }
    if (ownClaude) {
        const rule = readText(root, '.claude/rules/plutos.md');
        if (rule === null) missing('.claude/rules/plutos.md', 'medium', 'owner', 'The Claude Code rule that carries the board protocol beside this project\'s own CLAUDE.md');
        else if (rule === CLAUDE_RULE_HEADER + kitProtocolText()) facts.current++;
        else edited('.claude/rules/plutos.md', 'The Claude Code rule differs from today\'s');
    }
    for (const relative of ['docs/handoff/BOARD.md', 'docs/handoff/AGENT_BOARD.md', 'docs/handoff/ROSTER.md']) {
        const legacyRoot = relative === 'docs/handoff/BOARD.md' && lstat(path.join(root, 'BOARD.md'));
        if (!lstat(path.join(root, relative)) && !legacyRoot) missing(relative, 'medium', 'owner', `The ${path.basename(relative)} the AIs coordinate on`);
    }
    if (!lstat(path.join(root, 'docs/handoff/results'))) missing('docs/handoff/results/', 'low', 'owner', 'The results/ folder documents go into');
    for (const relative of ['.plutos/plutos-launch.mjs', 'PLUT_OS.bat', 'PLUT_OS.sh']) {
        const st = lstat(path.join(root, relative));
        if (!st) { missing(relative, relative.endsWith('.mjs') ? 'medium' : 'low', 'repair', `The launcher ${relative}`); continue; }
        if (planned.has(relative)) {
            const text = readText(root, relative);
            if (relative.endsWith('.mjs') && text !== null && !text.startsWith('// Generated by PLUT_OS')) edited(relative, 'The launcher stub has no generated mark');
            else older(relative, 'medium', relative.endsWith('.mjs') ? 'an older launcher stub; Repair (or opening the project) refreshes it' : 'an older launcher; Repair refreshes it');
        } else if (!relative.endsWith('.mjs') || readText(root, relative) === launcherStub()) facts.current++;
    }
    return facts;
}

// --- records, documents, memory, setup ---------------------------------------------------------------
function records(root, add) {
    const result = checkClaimsAgainstBaseline(root, { checks: RECORD_CHECKS });
    const say = f => f.check === 'missing-path' ? `names ${f.token}, which is not in the repository`
        : f.check === 'line-past-end' ? `cites ${f.token}, past the end of that file`
            : f.check === 'npm-script' ? `names npm run ${f.token}, which package.json does not define`
                : `says ${f.token}`;
    for (const f of result.fresh) add('records', { severity: 'medium', kind: f.check, path: f.file, line: f.line, fix: 'ai', message: `${say(f)} (fresh).`, token: f.token });
    for (const f of result.known) add('records', { severity: 'low', kind: f.check, path: f.file, line: f.line, fix: 'ai', message: `${say(f)} (accepted in the baseline: old debt, still true).`, token: f.token, accepted: true });
    return { fresh: result.fresh.length, accepted: result.known.length };
}

function documents(root, add) {
    const docs = collectDocPaths(root).filter(doc => !HISTORY_DOC.test(doc));
    const drift = docDrift(root, docs);
    let n = 0;
    for (const [doc, d] of Object.entries(drift)) {
        if (!d.drifted) continue;
        n++;
        const shown = d.staleRefs.slice(0, 5);
        add('documents', { severity: 'medium', kind: 'drift', path: doc, fix: 'ai', staleRefs: d.staleRefs, commitsBehind: d.commitsBehind,
            message: `${d.staleRefs.length} file(s) it names changed after its last commit, ${d.commitsBehind} commit(s) ago: ${shown.join(', ')}${d.staleRefs.length > shown.length ? ', …' : ''}.` });
    }
    return n;
}

const MEMORY_KINDS = {
    registry: ['high', 'owner'], 'hidden-unicode': ['high', 'owner'], anchor: ['medium', 'ai'], digest: ['medium', 'owner'],
    'duplicate-id': ['medium', 'owner'], index: ['low', 'owner'], ageing: ['low', 'owner'], cap: ['low', 'owner'], chain: ['low', 'owner'],
    'near-duplicate': ['low', 'owner'], 'unverified-30d': ['low', 'ai'], 'unseen-30d': ['low', 'owner']
};
function memory(root, add) {
    if (!lstat(path.join(root, 'docs/handoff/CONTEXT.json')) && !lstat(path.join(root, 'docs/handoff/CONTINUITY.md'))) return null;
    const report = memoryCheck(root);
    for (const f of report.findings) {
        const [severity, fix] = MEMORY_KINDS[f.kind] || ['low', 'owner'];
        const file = f.kind === 'digest' || (f.kind === 'hidden-unicode' && f.text.startsWith('digest')) || f.kind === 'near-duplicate' && f.text.includes('CONTINUITY')
            ? 'docs/handoff/CONTINUITY.md' : f.kind === 'index' ? '.plutos/memory.db' : 'docs/handoff/CONTEXT.json';
        const message = f.kind === 'digest' && /no record id/.test(f.text) ? `An old CONTINUITY format: ${f.text}.` : `${f.text}.`;
        add('memory', { severity, kind: f.kind, path: file, fix, message });
    }
    if (report.counts.reversed) add('memory', { severity: 'low', kind: 'reversed', path: 'docs/handoff/CONTEXT.json', fix: 'owner',
        message: `${report.counts.reversed} decision(s) reversed and kept as history (plutos memory list --status reversed; plutos memory retire archives one).` });
    return report.summary;
}

function setup(root, add, kit, plan, planError) {
    const facts = {};
    const readiness = projectReadiness(root);
    facts.stage = readiness.stage;
    if (readiness.stage === 'unmapped' && kit) add('setup', { severity: 'low', kind: 'unmapped', path: 'docs/ai/PROJECT_MAP.md', fix: 'ai', message: `Nobody has mapped this project yet: ${readiness.next.action}` });
    for (const doc of hygieneReport(root).docs) {
        const warn = doc.warnings.find(w => w.level === 'warn');
        if (doc.name === 'PROJECT_MAP.md' && warn) add('setup', { severity: 'medium', kind: 'map-stale', path: doc.path, fix: 'ai', message: `The project map is ${warn.message}` });
        if (doc.name === 'CODEINDEX.md' && kit && !doc.exists) add('setup', { severity: 'low', kind: 'codeindex', path: doc.path, fix: 'owner', message: 'No code index yet: the next session_start builds it, or rescan from the Code map page.' });
        else if (doc.name === 'CODEINDEX.md' && warn) add('setup', { severity: 'low', kind: 'codeindex', path: doc.path, fix: 'owner', message: `The code index: ${warn.message}` });
    }
    if (planError) add('setup', { severity: 'medium', kind: 'repair-plan', path: '.', fix: 'owner', message: `Repair cannot plan here: ${planError}` });
    for (const change of plan?.changes || []) {
        const relative = path.relative(root, change.path).split(path.sep).join('/');
        if (!lstat(change.path)) continue;   // missing files are a kit-files finding
        if (relative === '.plutos/local.json') add('setup', { severity: 'low', kind: 'wiring', path: relative, fix: 'repair', message: 'Points at another PLUT_OS install or data folder than this one: Repair rewrites it for this machine (it is git-ignored).' });
        else if (relative === '.gitignore') add('setup', { severity: 'low', kind: 'ignores', path: relative, fix: 'repair', message: `Lacks ${plan.ignores?.entries?.length || 'some'} machine-specific line(s) the kit keeps out of git: Repair adds them.` });
        else if (relative === '.mcp.json') add('setup', { severity: 'medium', kind: 'mcp-link', path: relative, fix: 'repair', message: 'The PLUT_OS entry is an older wiring (an absolute path or an old launcher): Repair replaces that entry only.' });
    }
    facts.wired = kit ? connectionPlan(root).filter(c => c.wired).map(c => c.id) : [];
    if (kit && !facts.wired.length) add('setup', { severity: 'low', kind: 'no-client', path: '.', fix: 'owner', message: 'No AI client is wired to this project: plutos connect <client-id> (plutos connect lists them).' });
    return facts;
}

/** The whole report; reads the project and changes nothing in it. `pastRules` is a test seam. */
export function auditProject(root, { pastRules = PAST_KIT_RULES } = {}) {
    root = path.resolve(root);
    const { sections, omitted, add } = collector();
    const isRepo = git(root, ['rev-parse', '--is-inside-work-tree']) === 'true';
    let plan = null, planError = null;
    const kit = looksLikePlutosProject(root);
    if (kit) { try { plan = planInstalledProjectRepair(root); } catch (e) { planError = e.message; } }
    const leftoverCount = leftovers(root, add, { isRepo });
    const kitFacts = kitFiles(root, add, plan, pastRules);
    const recordCounts = records(root, add);
    const drifted = documents(root, add);
    const memorySummary = memory(root, add);
    const setupFacts = setup(root, add, kit, plan, planError);

    const all = AUDIT_SECTIONS.flatMap(s => sections[s]);
    const omittedCount = AUDIT_SECTIONS.reduce((n, s) => n + Object.values(omitted[s]).reduce((a, b) => a + b, 0), 0);
    const counts = Object.fromEntries(SEVERITIES.map(sev => [sev, all.filter(f => f.severity === sev).length]));
    // A leftover found by name alone (keep-if-edited, nothing proves it unedited) is reported, but
    // does not make the project old or mixed: it may be the project's own file of the same name.
    const certain = sections.leftovers.filter(f => f.action !== 'keep-if-edited' || f.movable).length + Object.values(omitted.leftovers).reduce((a, b) => a + b, 0);
    const stale = certain + kitFacts.older;
    let verdict, why;
    if (!kitFacts.kit) { verdict = 'old'; why = 'no current PLUT_OS kit is installed here'; }
    else if (kitFacts.rulesOld) { verdict = 'old'; why = 'AGENTS.md is a past version of the kit rules'; }
    else if (stale > kitFacts.current) { verdict = 'old'; why = `${certain} leftover(s) and ${kitFacts.older} older kit cop${kitFacts.older === 1 ? 'y' : 'ies'} outnumber the ${kitFacts.current} current kit file(s)`; }
    else if (counts.high || counts.medium || certain) {
        verdict = 'mixed';
        why = [certain ? `${certain} leftover(s) from older versions` : '', counts.high ? `${counts.high} high` : '', counts.medium ? `${counts.medium} medium finding(s)` : '']
            .filter(Boolean).join(', ') + ' alongside a current kit';
    } else { verdict = 'clean'; why = counts.low ? `the kit is current; ${counts.low} low finding(s) to look at when convenient` : 'the kit is current and nothing needs a look'; }
    return {
        root, project: path.basename(root), auditedAt: new Date().toISOString(), verdict, why, counts, omittedCount,
        facts: { git: isRepo, kit: kitFacts.kit, agentsIsKit: kitFacts.agentsOurs, currentKitFiles: kitFacts.current, olderKitCopies: kitFacts.older,
            leftovers: leftoverCount, certainLeftovers: certain, records: recordCounts, driftedDocuments: drifted, memory: memorySummary, ...setupFacts },
        sections, omitted
    };
}

// --- the report as text ------------------------------------------------------------------------------
const rank = f => SEVERITIES.indexOf(f.severity);
const where = f => `${f.path}${f.line ? `:${f.line}` : ''}`;

/** The one-line prompt for an AI, per finding it can settle. */
export function aiPrompt(f) {
    if (f.kind === 'drift') return `Read ${f.path} and the files it names that changed after its last commit (${f.staleRefs.slice(0, 5).join(', ')}); correct what no longer holds, or say that it still does.`;
    if (f.kind === 'unmapped') return 'Read the project (AGENTS.md Rule 1) and write docs/ai/PROJECT_MAP.md.';
    if (f.kind === 'map-stale') return 'Read the project again and refresh docs/ai/PROJECT_MAP.md where it no longer matches the code.';
    if (RECORD_CHECKS.includes(f.kind)) return recordPrompt(f.path, [f.line]);
    return `Re-check ${f.path}: ${f.message}`;
}
// One prompt per document for its citations, one for all the claims memory flags, one per finding otherwise.
export function aiPrompts(findings) {
    const prompts = [], cited = new Map(), claims = { anchor: 0, 'unverified-30d': 0 };
    for (const f of findings) {
        if (f.kind in claims) { if (!claims.anchor && !claims['unverified-30d']) prompts.push('@claims'); claims[f.kind]++; continue; }
        if (!RECORD_CHECKS.includes(f.kind)) { prompts.push(aiPrompt(f)); continue; }
        if (!cited.has(f.path)) { cited.set(f.path, []); prompts.push(`@cite:${f.path}`); }
        cited.get(f.path).push(f.line);
    }
    return prompts.map(p => p === '@claims'
        ? `Re-check the memory claims plutos check --memory lists (${claims.anchor} stale or for review, ${claims['unverified-30d']} unverified for 30 days) against their sources; record each again with evidence at session_end, or say it no longer holds.`
        : p.startsWith('@cite:') ? recordPrompt(p.slice(6), cited.get(p.slice(6))) : p);
}
const recordPrompt = (file, lines) => {
    const shown = [...new Set(lines)].sort((a, b) => a - b);
    return `In ${file} (line${shown.length > 1 ? 's' : ''} ${shown.slice(0, 8).join(', ')}${shown.length > 8 ? ', …' : ''}), point each path, line citation or npm script plutos check names at what exists now, or say in the line that it was removed.`;
};

export function renderAudit(report) {
    const out = [`PLUT_OS audit · ${report.project} (${report.root})`, `Verdict: ${report.verdict} — ${report.why}.`,
        `Findings: ${report.counts.high} high, ${report.counts.medium} medium, ${report.counts.low} low${report.omittedCount ? ` (${report.omittedCount} more not listed)` : ''}.`];
    const order = AUDIT_SECTIONS.filter(s => report.sections[s].length || Object.keys(report.omitted[s]).length)
        .sort((a, b) => Math.min(...report.sections[a].map(rank), 3) - Math.min(...report.sections[b].map(rank), 3) || AUDIT_SECTIONS.indexOf(a) - AUDIT_SECTIONS.indexOf(b));
    for (const section of order) {
        const list = [...report.sections[section]].sort((a, b) => rank(a) - rank(b));
        const tally = SEVERITIES.map(sev => [sev, list.filter(f => f.severity === sev).length]).filter(([, n]) => n).map(([sev, n]) => `${n} ${sev}`).join(', ');
        out.push('', `${SECTION_TITLES[section]} (${tally || 'none listed'})`);
        for (const f of list) {
            const extra = section === 'leftovers' ? ` [${kb(f.size)}${f.lastCommit ? `, last commit ${f.lastCommit}` : ', never committed'}]` : '';
            out.push(`  ${f.severity.padEnd(6)} ${where(f)}  ${f.message}${extra}  → ${f.fix}`);
        }
        for (const [kind, n] of Object.entries(report.omitted[section])) out.push(`  … ${n} more ${kind} finding(s) not listed (the first ${AUDIT_LIMIT} are)`);
    }
    const all = AUDIT_SECTIONS.flatMap(s => report.sections[s]);
    const by = fix => all.filter(f => f.fix === fix);
    out.push('', 'What fixes what');
    const repair = by('repair');
    out.push(`  Repair (dashboard Projects → Repair; it previews every change and keeps a backup): ${repair.length ? [...new Set(repair.map(f => f.path))].join(', ') : 'nothing to repair'}`);
    const movable = by('move');
    out.push(movable.length
        ? `  plutos audit --clean: moves ${movable.length} leftover(s) into the Hub's audit-leftovers/${report.project}/<time>/, keeping their paths; nothing is deleted (an interactive terminal, and no uncommitted change to them)`
        : '  plutos audit --clean: nothing to move');
    const ai = by('ai');
    if (ai.length) {
        const text = aiPrompts(ai);
        out.push(`  Ask an AI (${ai.length} finding(s), ${text.length} prompt(s)):`);
        for (const prompt of text.slice(0, 10)) out.push(`    - "${prompt}"`);
        if (text.length > 10) out.push(`    … and ${text.length - 10} more (--json lists the findings)`);
    } else out.push('  Ask an AI: nothing');
    const owner = by('owner');
    if (owner.length) {
        out.push(`  The owner (${owner.length}):`);
        for (const f of owner.slice(0, 10)) out.push(`    - ${where(f)}: ${f.message}`);
        if (owner.length > 10) out.push(`    … and ${owner.length - 10} more (--json lists them)`);
    } else out.push('  The owner: nothing');
    return out.join('\n');
}

// --- --clean -------------------------------------------------------------------------------------------
/** Paths among `relatives` with a change git does not hold yet (tracked and modified, staged, deleted). */
export function uncommittedChanges(root, relatives) {
    if (!relatives.length) return [];
    let out = '';
    try {
        out = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--', ...relatives.map(r => r.replace(/\/$/, ''))],
            { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch { return []; }
    // -z: "XY path\0", and a rename's source follows as one more field.
    const fields = out.split('\0').filter(Boolean), paths = [];
    for (let i = 0; i < fields.length; i++) { paths.push(fields[i].slice(3)); if (/^[RC]/.test(fields[i])) i++; }
    return paths;
}

/**
 * Moves every movable leftover of `report` under `home`/audit-leftovers/<project>/<stamp>/, keeping
 * its project-relative path; the install record goes last, once nothing it lists is left. Refuses,
 * moving nothing, when git has an uncommitted change to one of them. → { refused?, target, moved: [] }
 */
export function cleanLeftovers(root, report, { home, stamp = new Date().toISOString().replace(/[:.]/g, '-') }) {
    root = path.resolve(root);
    const movable = report.sections.leftovers.filter(f => f.movable).map(f => f.path.replace(/\/$/, ''));
    if (!movable.length) return { target: null, moved: [] };
    const dirty = report.facts.git ? uncommittedChanges(root, movable) : [];
    if (dirty.length) return { refused: `uncommitted changes to ${dirty.join(', ')}: commit or discard them first, then run --clean again`, target: null, moved: [] };
    const project = report.project.replace(/[^A-Za-z0-9._-]/g, '-') || 'project';
    const target = path.join(home, 'audit-leftovers', project, stamp);
    const moved = [];
    const move = relative => {
        const from = path.join(root, relative), to = path.join(target, relative);
        if (!lstat(from)) return;
        fs.mkdirSync(path.dirname(to), { recursive: true });
        try { fs.renameSync(from, to); }
        catch { fs.cpSync(from, to, { recursive: true }); fs.rmSync(from, { recursive: true, force: true }); }
        moved.push(relative);
    };
    for (const relative of movable) move(relative);
    // The install record: once the files it vouched for are gone, it has nothing left to say.
    const record = installRecord(root);
    if (lstat(path.join(root, INSTALL_RECORD)) && !movable.includes(INSTALL_RECORD) && record.size && [...record.keys()].every(f => !lstat(path.join(root, f)))) move(INSTALL_RECORD);
    return { target, moved };
}
