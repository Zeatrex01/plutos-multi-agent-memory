// Agent Skills in a project, and the packs that bring them: a skill is a folder with a SKILL.md,
// a pack is a folder of such skills, and the core only places folders where each client reads them.
// Open formats only; neither side imports the other's code. A pack folder is somebody else's
// content, so nothing here follows a link, every scan is bounded, and every path is checked against
// the real path of the folder it must stay in.
//
// A pack's own record is `skills.json` at the pack root:
//   { version: 1, id, name, description?, skills: [{ name, description?, measured?: { date, summary, record } }],
//     mcpServers?: { <name>: { command, args?, env?, os?: { win32|darwin|linux: { command?, args?, env? } } } } }
// `measured` is the pack's own benchmark line for that skill, shown verbatim; the core invents no
// score. `mcpServers` are added to the project's .mcp.json on `pack on` and removed on `pack off`
// (lib/mcps.mjs planPackMcp, removePackMcp; owner decision d-9ca58ad53503). A pack without
// skills.json registers from `module.json` (`id` and `name` only, nothing else is read) with its
// skill list taken from the `skills/<name>/SKILL.md` folders.
//
// Registry, in the data folder: <PLUTOS_HOME>/packs.json
//   { version: 1, packs: { <id>: { path, name, description, skills: [{ name, description, measured }], registeredAt } } }
// Activation, in the project: .plutos/packs.json, no machine path in it
//   { version: 1, active: { <id>: { at, placed: { '<home>/<name>': { files: { '<rel>': '<sha256>' } } },
//     mcp?: { servers: { <name>: { sha256 } }, created } } } }
// `mcp` lists only the .mcp.json entries this pack added (sha256 of the entry as written) and
// `created` whether the activation created the file.
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { currentPlutosHome } from './home-dir.mjs';
import { APP_ROOT } from './approot.mjs';
import { writeFileAtomic, APP_DATA_LIMITS } from './app-data.mjs';
import { parsePackMcpServers, packMcpRecord, planPackMcp, removePackMcp } from './mcps.mjs';

// The folders clients read Agent Skills from. A client is listed only with the folder its own
// documentation names; `verified` is the day that documentation was read.
export const SKILL_HOMES = Object.freeze([
    Object.freeze({ folder: '.claude/skills', clients: Object.freeze(['Claude Code']), verified: '2026-11-03' }),
    Object.freeze({ folder: '.agents/skills', clients: Object.freeze(['Codex', 'Gemini CLI']), verified: '2026-11-03' })
]);

export const SKILL_LIMITS = Object.freeze({
    foldersPerHome: 200,                                        // skill folders read per home
    skillFileBytes: 64 * 1024,                                  // of a SKILL.md, for its frontmatter
    descriptionChars: 200,
    packFiles: Math.min(2000, APP_DATA_LIMITS.files),           // copied per activation
    packBytes: Math.min(32 * 1024 * 1024, APP_DATA_LIMITS.bytes)
});

export const PACK_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
// A skill folder name as the Agent Skills format allows it: one path segment, nothing else.
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const REGISTRY_FILE = 'packs.json';
const ACTIVATION_FILE = path.join('.plutos', 'packs.json');

const registryPath = home => path.join(home || currentPlutosHome(), REGISTRY_FILE);
const activationPath = projectRoot => path.join(projectRoot, ACTIVATION_FILE);
const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function lstatOrNull(p) {
    try { return fs.lstatSync(p); } catch (e) { return null; }
}

function realDirectory(dir, what) {
    let real;
    try { real = fs.realpathSync(dir); } catch (e) { throw new Error(`${what} not found: ${dir}`); }
    if (!fs.statSync(real).isDirectory()) throw new Error(`${what} is not a folder: ${dir}`);
    return real;
}

// The house rule for a path that must stay under its root (lib/claims.mjs, lib/repair.mjs); both
// sides are real paths, so a link inside the project cannot point the copy elsewhere.
export function within(root, candidate) {
    const rel = path.relative(root, candidate);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export function sha256(file) {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// `name:` and `description:` from a SKILL.md's frontmatter. YAML-ish on purpose: one line per key, a
// quoted or bare value, or a block scalar (`>` or `|`) whose indented lines follow. Nothing else is read.
export function parseSkillFrontmatter(source) {
    const { name, description } = parseFrontmatterKeys(source, ['name', 'description']);
    return { name, description };
}

// The same reader for any top-level keys (lib/skill-inventory.mjs reads the gates and `version`); a key
// that is absent comes back as ''. A key followed by an indented list (`paths:` then `- a`) reads as
// the list items joined with a space (only when every indented line is a `- ` item).
export function parseFrontmatterKeys(source, keys) {
    const out = Object.fromEntries(keys.map(k => [k, '']));
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
    if (!m) return out;
    const lines = m[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
        if (!kv || !keys.includes(kv[1])) continue;
        let value = kv[2].trim();
        if (['>', '|', '>-', '|-', ''].includes(value)) {
            const block = [];
            while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
            const list = block.length && block.every(line => /^-\s+/.test(line));
            value = (list ? block.map(line => line.replace(/^-\s+/, '')) : block).join(' ');
        }
        out[kv[1]] = value.replace(/^(["'])(.*)\1$/, '$2').trim();
    }
    return out;
}

// The skill folders under one home: [{ name, description }], plus a note per entry skipped.
function scanHome(homeDir, notes, label) {
    const found = [];
    const st = lstatOrNull(homeDir);
    if (!st) return found;
    if (st.isSymbolicLink()) { notes.push(`${label} is a link and was not read.`); return found; }
    if (!st.isDirectory()) return found;
    const entries = fs.readdirSync(homeDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length > SKILL_LIMITS.foldersPerHome) notes.push(`${label} holds ${entries.length} entries; the first ${SKILL_LIMITS.foldersPerHome} were read.`);
    for (const entry of entries.slice(0, SKILL_LIMITS.foldersPerHome)) {
        if (entry.isSymbolicLink()) { notes.push(`${label}/${entry.name} is a link and was skipped.`); continue; }
        if (!entry.isDirectory() || !SKILL_NAME_RE.test(entry.name)) continue;
        const file = path.join(homeDir, entry.name, 'SKILL.md');
        const fst = lstatOrNull(file);
        if (!fst) continue;
        if (fst.isSymbolicLink()) { notes.push(`${label}/${entry.name}/SKILL.md is a link and was skipped.`); continue; }
        if (!fst.isFile()) continue;
        let head = '';
        try {
            const fd = fs.openSync(file, 'r');
            try {
                const buf = Buffer.alloc(Math.min(fst.size, SKILL_LIMITS.skillFileBytes));
                head = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString('utf8');
            } finally { fs.closeSync(fd); }
        } catch (e) { notes.push(`${label}/${entry.name}/SKILL.md could not be read: ${e.message}`); continue; }
        const front = parseSkillFrontmatter(head);
        found.push({ name: entry.name, description: (front.description || front.name || entry.name).slice(0, SKILL_LIMITS.descriptionChars) });
    }
    return found;
}

// --- Activation record (<project>/.plutos/packs.json) -------------------------------------------

export function readActivation(projectRoot) {
    const parsed = projectRoot ? readJson(activationPath(projectRoot), null) : null;
    const active = {};
    for (const [id, entry] of Object.entries(parsed && parsed.active && typeof parsed.active === 'object' ? parsed.active : {})) {
        if (!PACK_ID_RE.test(id) || !entry || typeof entry !== 'object') continue;
        active[id] = { at: text(entry.at, 40), placed: entry.placed && typeof entry.placed === 'object' ? entry.placed : {} };
        if (entry.mcp) {
            const mcp = packMcpRecord(entry.mcp);
            if (Object.keys(mcp.servers).length) active[id].mcp = mcp;
        }
    }
    return { version: 1, active };
}

function writeActivation(projectRoot, record) {
    writeFileAtomic(activationPath(projectRoot), JSON.stringify({ version: 1, active: record.active }, null, 2) + '\n');
}

// A placed folder's key, '<home>/<name>', as a checked pair; null when the record does not fit.
function placedKey(key) {
    const home = SKILL_HOMES.find(h => key.startsWith(h.folder + '/'));
    if (!home) return null;
    const name = key.slice(home.folder.length + 1);
    return SKILL_NAME_RE.test(name) ? { home, name } : null;
}

// --- The project's skills ---------------------------------------------------------------------------

// Every skill the project's clients can read, one entry per folder name across the homes:
// { skills: [{ name, description, folders, clients, source, measured }], notes }. `source` is the id
// of the pack that placed the folder (from .plutos/packs.json) or 'project'; `measured` is that
// pack's own line for the skill, or null.
export function scanProjectSkills(projectRoot, { home } = {}) {
    const notes = [];
    const byName = new Map();
    if (!projectRoot) return { skills: [], notes };
    const placedBy = new Map();
    for (const [id, entry] of Object.entries(readActivation(projectRoot).active)) {
        for (const key of Object.keys(entry.placed)) { const p = placedKey(key); if (p) placedBy.set(p.name, id); }
    }
    const registry = placedBy.size ? readRegistry(home).packs : {};
    for (const homeEntry of SKILL_HOMES) {
        for (const skill of scanHome(path.join(projectRoot, ...homeEntry.folder.split('/')), notes, homeEntry.folder)) {
            if (!byName.has(skill.name)) {
                const source = placedBy.get(skill.name) || 'project';
                const packSkill = source !== 'project' ? (registry[source]?.skills || []).find(s => s && s.name === skill.name) : null;
                byName.set(skill.name, { name: skill.name, description: skill.description, folders: [], clients: [], source, measured: packSkill?.measured || null });
            }
            const entry = byName.get(skill.name);
            entry.folders.push(homeEntry.folder);
            for (const client of homeEntry.clients) if (!entry.clients.includes(client)) entry.clients.push(client);
        }
    }
    return { skills: [...byName.values()], notes };
}

export function listProjectSkills(projectRoot, options) {
    return scanProjectSkills(projectRoot, options).skills;
}

// --- The pack registry (<PLUTOS_HOME>/packs.json) -----------------------------------------------

export function readRegistry(home) {
    const parsed = readJson(registryPath(home), null);
    const packs = parsed && parsed.packs && typeof parsed.packs === 'object' ? parsed.packs : {};
    return { version: 1, packs };
}

function writeRegistry(home, registry) {
    writeFileAtomic(registryPath(home), JSON.stringify({ version: 1, packs: registry.packs }, null, 2) + '\n');
}

function measuredOf(value) {
    if (!value || typeof value !== 'object') return null;
    const date = text(value.date, 40), summary = text(value.summary, SKILL_LIMITS.descriptionChars), record = text(value.record, 200);
    return date || summary || record ? { date, summary, record } : null;
}

// What a pack folder holds right now: id, name and description from skills.json (or module.json's id
// and name), and one entry per skills/<name>/SKILL.md folder, with skills.json's words for it.
function inspectPack(folder, { projectRoot = '', home } = {}) {
    const root = realDirectory(path.resolve(String(folder || '')), 'Pack folder');
    const segments = root.split(path.sep);
    if (segments.includes('.git')) throw new Error(`A pack folder inside .git is refused: ${root}`);
    // The data folder may not exist yet on a fresh install; then nothing can be inside it.
    let dataHome = '';
    try { dataHome = fs.realpathSync(home || currentPlutosHome()); } catch (e) { dataHome = ''; }
    if (dataHome && (root === dataHome || within(dataHome, root))) throw new Error(`A pack folder inside the data folder is refused: ${root}`);
    if (projectRoot) {
        let projectReal = '';
        try { projectReal = fs.realpathSync(projectRoot); } catch (e) { projectReal = ''; }
        if (projectReal && (root === projectReal || within(projectReal, root))) throw new Error(`A pack folder inside the open project is refused: ${root}`);
    }
    const recordFile = path.join(root, 'skills.json');
    const manifestFile = path.join(root, 'module.json');
    let record = null;
    if (lstatOrNull(recordFile)?.isFile()) {
        record = readJson(recordFile, null);
        if (!record || typeof record !== 'object') throw new Error(`${recordFile} is not valid JSON.`);
    } else if (lstatOrNull(manifestFile)?.isFile()) {
        const manifest = readJson(manifestFile, null);
        if (!manifest || typeof manifest !== 'object') throw new Error(`${manifestFile} is not valid JSON.`);
        record = { id: manifest.id, name: manifest.name, skills: [] };   // no mcpServers from module.json
    } else {
        throw new Error(`No skills.json or module.json in ${root}: a pack folder holds one of them and skills/<name>/SKILL.md folders.`);
    }
    if (typeof record.id !== 'string' || !PACK_ID_RE.test(record.id)) throw new Error(`The pack id must match ${PACK_ID_RE} (got ${JSON.stringify(record.id)}).`);
    const name = text(record.name, 120);
    if (!name) throw new Error('The pack record names no "name".');
    const skillsDir = path.join(root, 'skills');
    const sst = lstatOrNull(skillsDir);
    if (!sst || sst.isSymbolicLink() || !sst.isDirectory()) throw new Error(`${root} has no skills/ folder (a link does not count).`);
    const notes = [];
    const words = new Map((Array.isArray(record.skills) ? record.skills : []).filter(s => s && typeof s.name === 'string').map(s => [s.name, s]));
    const skills = scanHome(skillsDir, notes, 'skills').map(s => ({
        name: s.name,
        description: text(words.get(s.name)?.description, SKILL_LIMITS.descriptionChars) || s.description,
        measured: measuredOf(words.get(s.name)?.measured)
    }));
    if (!skills.length) throw new Error(`${root} holds no skills/<name>/SKILL.md folder.`);
    const mcpServers = lstatOrNull(recordFile)?.isFile() ? parsePackMcpServers(record.mcpServers, `${recordFile} mcpServers`) : {};
    return { id: record.id, path: root, name, description: text(record.description, SKILL_LIMITS.descriptionChars), skills, mcpServers, notes };
}

// The packs PLUT_OS ships in its own folder (packs/<id>/, e.g. codebase-memory and context-mode):
// each declares an upstream MCP server it runs with npx and a skill saying when to use it; no
// upstream code is in them.
export const SHIPPED_PACKS_DIR = path.join(APP_ROOT, 'packs');

export function shippedPacks(dir = SHIPPED_PACKS_DIR) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return []; }
    return entries.filter(e => e.isDirectory() && !e.isSymbolicLink() && PACK_ID_RE.test(e.name)).map(e => e.name).sort();
}

// A bare pack id that names no folder here resolves to PLUT_OS's own packs/<id>, so
// `plutos pack add codebase-memory` needs no path; a pack folder of that name in the working folder
// wins, but a folder that is not a pack (no skills.json or module.json, e.g. a clone of the upstream
// repository) does not hide the shipped pack.
function resolvePackFolder(folder, shippedDir) {
    const raw = String(folder || '').trim();
    if (!PACK_ID_RE.test(raw)) return raw;
    const shipped = shippedPacks(shippedDir);
    if (lstatOrNull(path.resolve(raw))) {
        const isPack = ['skills.json', 'module.json'].some(f => lstatOrNull(path.resolve(raw, f)));
        return isPack || !shipped.includes(raw) ? raw : path.join(shippedDir, raw);
    }
    if (shipped.includes(raw)) return path.join(shippedDir, raw);
    throw new Error(`Pack folder not found: ${raw}.${shipped.length ? ` PLUT_OS ships ${shipped.join(', ')}; name one of them or a folder.` : ''}`);
}

// Registers (or re-registers, same id) a pack folder, or one of PLUT_OS's own packs by id; the real
// path is stored, nothing is copied.
export function registerPack(folder, { home, projectRoot = '', shippedDir = SHIPPED_PACKS_DIR } = {}) {
    const pack = inspectPack(resolvePackFolder(folder, shippedDir), { home, projectRoot });
    const registry = readRegistry(home);
    const entry = { path: pack.path, name: pack.name, description: pack.description, skills: pack.skills, registeredAt: new Date().toISOString() };
    registry.packs[pack.id] = entry;
    writeRegistry(home, registry);
    return { id: pack.id, ...entry, mcpServers: Object.keys(pack.mcpServers), notes: pack.notes };
}

// The skill folder names a pack folder holds right now (skills/<name>/SKILL.md, links skipped, the
// per-home cap applied); null when the folder or its skills/ is gone or a link.
function liveSkillNames(packPath) {
    const dir = path.join(packPath, 'skills');
    const st = lstatOrNull(dir);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) return null;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return null; }
    return entries.sort((a, b) => a.name.localeCompare(b.name)).slice(0, SKILL_LIMITS.foldersPerHome)
        .filter(e => e.isDirectory() && !e.isSymbolicLink() && SKILL_NAME_RE.test(e.name) && lstatOrNull(path.join(dir, e.name, 'SKILL.md'))?.isFile())
        .map(e => e.name);
}

// `skills` is counted from the pack folder live, so a skill added after `pack add` shows; the
// registry's list stands in only while the folder is missing.
export function listPacks({ home } = {}) {
    return Object.entries(readRegistry(home).packs)
        .filter(([id, entry]) => PACK_ID_RE.test(id) && entry && typeof entry.path === 'string')
        .map(([id, entry]) => {
            const present = !!lstatOrNull(entry.path);
            const live = present ? liveSkillNames(entry.path) : null;
            return {
                id,
                path: entry.path,
                name: text(entry.name, 120) || id,
                description: text(entry.description, SKILL_LIMITS.descriptionChars),
                skills: live || (Array.isArray(entry.skills) ? entry.skills : []).filter(s => s && typeof s.name === 'string').map(s => s.name),
                registeredAt: text(entry.registeredAt, 40),
                present
            };
        })
        .sort((a, b) => a.id.localeCompare(b.id));
}

export function forgetPack(id, { home } = {}) {
    const registry = readRegistry(home);
    if (!registry.packs[id]) throw new Error(`Unknown pack "${id}".`);
    delete registry.packs[id];
    writeRegistry(home, registry);
    return { id };
}

// --- Activation ---------------------------------------------------------------------------------

// The files of one skill folder, measured against the pack budget before anything is written: lstat
// on every entry, links skipped with a note (the walk of lib/app-data.mjs).
function listFiles(dir, budget, notes, label, acc = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) { notes.push(`${label}/${entry.name} is a link and was not copied.`); continue; }
        if (entry.isDirectory()) { listFiles(full, budget, notes, `${label}/${entry.name}`, acc); continue; }
        if (!entry.isFile()) continue;
        const size = fs.lstatSync(full).size;
        budget.files += 1;
        budget.bytes += size;
        if (budget.files > SKILL_LIMITS.packFiles || budget.bytes > SKILL_LIMITS.packBytes) {
            throw new Error(`The pack's skills exceed ${SKILL_LIMITS.packFiles} files or ${Math.round(SKILL_LIMITS.packBytes / 1024 / 1024)} MB; nothing was copied.`);
        }
        acc.push(full);
    }
    return acc;
}

// Places every skill of the registered pack into every home, create-if-absent, and records each file
// with its hash. A folder of the same name that this pack did not place stops the whole activation
// before anything is written, so the project is never left half-switched. The pack's declared MCP
// servers go into the project's .mcp.json the same way: checked first, an existing entry of the same
// name is never overwritten (a conflict note instead), and each added entry is recorded.
export function activatePack(projectRoot, id, { home } = {}) {
    if (!projectRoot) throw new Error('Select a project first.');
    if (!PACK_ID_RE.test(String(id))) throw new Error(`Not a pack id: ${JSON.stringify(id)}.`);
    const pack = readRegistry(home).packs[id];
    if (!pack) throw new Error(`Unknown pack "${id}". Register its folder first.`);
    const current = inspectPack(pack.path, { home });
    if (current.id !== id) throw new Error(`${pack.path} now carries the id "${current.id}", not "${id}". Register it again.`);
    const root = realDirectory(projectRoot, 'Project');
    const record = readActivation(projectRoot);
    const placed = record.active[id]?.placed || {};
    const notes = [...current.notes];
    const budget = { files: 0, bytes: 0 };
    const jobs = [];
    for (const skill of current.skills) {
        const source = path.join(current.path, 'skills', skill.name);
        const files = listFiles(source, budget, notes, `skills/${skill.name}`);
        for (const homeEntry of SKILL_HOMES) {
            const key = `${homeEntry.folder}/${skill.name}`;
            const homeDir = path.join(root, ...homeEntry.folder.split('/'));
            // An existing home must really sit inside the project: a link to elsewhere is refused.
            const hst = lstatOrNull(homeDir);
            if (hst && (hst.isSymbolicLink() || !within(root, fs.realpathSync(homeDir)) || !hst.isDirectory())) {
                throw new Error(`${homeEntry.folder} is a link or not a folder inside the project; nothing was changed.`);
            }
            const target = path.join(homeDir, skill.name);
            if (!within(root, target)) throw new Error(`A skill folder leaves the project: ${key}`);
            if (lstatOrNull(target)) {
                if (!placed[key]) throw new Error(`${key} already exists in this project and was not placed by the pack "${id}"; nothing was changed.`);
                continue;   // placed by this pack earlier: left as it is
            }
            jobs.push({ key, source, target, files });
        }
    }
    const prior = record.active[id];
    const mcpPlan = planPackMcp(root, current.mcpServers, prior && prior.mcp, { packId: id });
    for (const job of jobs) {
        const hashes = {};
        fs.mkdirSync(job.target, { recursive: true });
        for (const file of job.files) {
            const rel = path.relative(job.source, file);
            const dest = path.join(job.target, rel);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL);
            hashes[rel.split(path.sep).join('/')] = sha256(dest);
        }
        placed[job.key] = { files: hashes };
    }
    const mcp = mcpPlan.commit();
    record.active[id] = { at: new Date().toISOString(), placed };
    if (Object.keys(mcp.servers).length) record.active[id].mcp = mcp;
    notes.push(...mcpPlan.notes);
    writeActivation(projectRoot, record);
    // The registry keeps what the folder held at `pack add`; the inspection just made is newer.
    const registry = readRegistry(home);
    if (registry.packs[id]) {
        registry.packs[id] = { ...registry.packs[id], name: current.name, description: current.description, skills: current.skills };
        writeRegistry(home, registry);
    }
    const ignored = ignoredPlacements(root, record);
    if (ignored.length) notes.push(`git ignores ${ignored.join(', ')}: other clones will not get these skills. Commit them with git add -f, or un-ignore the folder in .gitignore.`);
    return { id, skills: current.skills.map(s => s.name), homes: SKILL_HOMES.map(h => h.folder), placed: jobs.length,
        mcp: { added: mcpPlan.added, conflicts: mcpPlan.conflicts }, notes };
}

// The placed folders, across every active pack, of which git ignores at least one recorded file. One
// `git check-ignore --stdin` call with the index, so a file added with `git add -f` is not counted;
// [] when git is missing or the project is not a repository.
function ignoredPlacements(root, record) {
    const fileToKey = new Map();
    for (const entry of Object.values(record.active)) {
        for (const [key, placedEntry] of Object.entries(entry.placed)) {
            if (!placedKey(key)) continue;
            const files = placedEntry && placedEntry.files && typeof placedEntry.files === 'object' ? Object.keys(placedEntry.files) : [];
            for (const rel of files.length ? files : ['SKILL.md']) fileToKey.set(`${key}/${rel}`, key);
        }
    }
    if (!fileToKey.size) return [];
    const r = spawnSync('git', ['check-ignore', '-z', '--stdin'], { cwd: root, input: [...fileToKey.keys()].join('\0') + '\0', encoding: 'utf8', timeout: 10000, windowsHide: true });
    if (r.error || r.status !== 0 || typeof r.stdout !== 'string') return [];   // 1: nothing ignored; 128: no repository
    const keys = new Set(r.stdout.split('\0').map(p => fileToKey.get(p)).filter(Boolean));
    return [...keys].sort();
}

// Removes only what the record says this pack placed: each recorded path is checked again as
// '<home>/<one segment>' inside the real project root, a file goes only while its hash still matches,
// and a folder goes only once it is empty. Whatever the owner edited or added stays and is reported.
// The .mcp.json entries the record says this pack added go while unchanged; an edited one stays, is
// listed in `kept` as '.mcp.json:<name>', and gets a note.
export function deactivatePack(projectRoot, id) {
    if (!projectRoot) throw new Error('Select a project first.');
    const record = readActivation(projectRoot);
    const entry = record.active[id];
    if (!entry) throw new Error(`Pack "${id}" is not active in this project.`);
    const root = realDirectory(projectRoot, 'Project');
    const removed = [], kept = [];
    for (const [key, placedEntry] of Object.entries(entry.placed)) {
        const p = placedKey(key);
        if (!p) { kept.push(key); continue; }
        const folder = path.join(root, ...p.home.folder.split('/'), p.name);
        const fst = lstatOrNull(folder);
        if (!fst) continue;
        if (fst.isSymbolicLink() || !fst.isDirectory() || !within(root, fs.realpathSync(folder))) { kept.push(key); continue; }
        const files = placedEntry && placedEntry.files && typeof placedEntry.files === 'object' ? placedEntry.files : {};
        for (const [rel, hash] of Object.entries(files)) {
            const parts = rel.split('/');
            if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\\'))) { kept.push(`${key}/${rel}`); continue; }
            const file = path.join(folder, ...parts);
            const st = lstatOrNull(file);
            if (!st) continue;
            if (!st.isFile() || sha256(file) !== hash) { kept.push(`${key}/${rel}`); continue; }
            fs.unlinkSync(file);
        }
        if (removeEmptyDirs(folder)) removed.push(key); else kept.push(key);
    }
    const mcp = removePackMcp(root, entry.mcp);
    for (const name of mcp.kept) kept.push(`.mcp.json:${name}`);
    // .mcp.json could not be read: its pack entries were not touched, so the record of them stays
    // (the skills are gone from it) and a later `pack off` can still remove them.
    if (mcp.unreadable) {
        record.active[id] = { ...entry, placed: {}, mcp: entry.mcp };
        mcp.notes.push(`The pack "${id}" stays on record for its .mcp.json entries; run pack off again once .mcp.json is valid JSON.`);
    } else delete record.active[id];
    writeActivation(projectRoot, record);
    return { id, removed, kept, mcp: { removed: mcp.removed, kept: mcp.kept }, notes: mcp.notes };
}

// Removes a folder when nothing but empty folders is left in it; true when it is gone.
function removeEmptyDirs(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.isSymbolicLink()) removeEmptyDirs(path.join(dir, entry.name));
    }
    if (fs.readdirSync(dir).length) return false;
    fs.rmdirSync(dir);
    return true;
}

// --- The servers active packs bring ---------------------------------------------------------------

// [{ pack, server, purpose }] for every MCP server an active pack in this project declares (or
// recorded adding) and the project's .mcp.json still has, sorted by pack then server: for the brief's
// tool map (lib/continuity.mjs) and the SubagentStart hook (lib/subagent-hook.mjs), which reach
// subagents that load no CLAUDE.md. `purpose` is the pack's own line, '' when it gives none; `name`
// and `description` repeat server and purpose for readers that use those keys. Never throws: [] when
// anything is missing. An .mcp.json that is not JSON hides nothing.
export function activePackMcpServers(projectRoot, { home } = {}) {
    try {
        if (!projectRoot) return [];
        const { active } = readActivation(projectRoot);
        const ids = Object.keys(active).sort();
        if (!ids.length) return [];
        let present = new Set();
        const mcpFile = path.join(projectRoot, '.mcp.json');
        if (lstatOrNull(mcpFile)) {
            const config = readJson(mcpFile, null);
            present = config && config.mcpServers && typeof config.mcpServers === 'object' ? new Set(Object.keys(config.mcpServers)) : null;
        }
        const registry = readRegistry(home).packs;
        const out = [];
        for (const id of ids) {
            let declared = {};
            const entry = registry[id];
            if (entry && typeof entry.path === 'string') {
                try { declared = parsePackMcpServers(readJson(path.join(entry.path, 'skills.json'), {}).mcpServers); } catch (e) { declared = {}; }
            }
            const names = new Set([...Object.keys(declared), ...Object.keys(active[id].mcp?.servers || {})]);
            for (const server of [...names].sort()) {
                if (present && !present.has(server)) continue;
                const purpose = text(declared[server]?.purpose, SKILL_LIMITS.descriptionChars);
                out.push({ pack: id, server, purpose, name: server, description: purpose });
            }
        }
        return out;
    } catch (e) { return []; }
}

// --- The brief line -------------------------------------------------------------------------------

// One line for lib/continuity.mjs buildBrief: folder names only (a SKILL.md's words are the pack's,
// not something to repeat into every session), absent when the project has no skill.
export function skillsBriefLines(projectRoot, { names = 8 } = {}) {
    const skills = listProjectSkills(projectRoot);
    if (!skills.length) return [];
    const shown = skills.slice(0, names).map(s => s.name.slice(0, 40)).join(', ');
    const more = skills.length - names;
    return [`Skills: ${skills.length} in this project — ${shown}${more > 0 ? ` …${more} more` : ''}, more in the Skills page.`, ''];
}
