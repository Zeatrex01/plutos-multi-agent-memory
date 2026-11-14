// Every Agent Skill a client on this machine would load, and where each copy came from: PLUT_OS's own
// skills, the registered packs, the project's skill folders, the user's skill folders (claude.ai-synced
// ones included) and Claude Code plugins (installed and synced). Built on lib/skills.mjs: the same
// frontmatter reader, the same pack registry and activation record, the same discipline: nothing here
// follows a link, every scan is bounded, and every path is checked against the real path of its root.
//
// Read-only. inventory() changes nothing; exportSkill() writes only the folder it was asked to write
// (and, with --force, replaces an earlier export the owner named), plus one line in the export list.
// It removes a folder only when its record accounts for every entry, unchanged, or (--force-local)
// after the whole folder, links and .git included, was copied to the data folder; never into or around
// the source, PLUT_OS's skill folders or a pack.
//
// A copy is loaded by the clients of its home (SKILL_HOMES for a project; ~/.claude/skills, synced
// skills and plugins by Claude Code; ~/.agents/skills by Codex and Gemini CLI). Copies sharing a name
// are a problem only when one client loads two of them; a pack placed in both homes is one per client.
//
// An exported copy carries <folder>/.plutos-source.json:
//   { version: 1, from: { kind: 'plutos'|'pack', id, path }, skill, sourceHash, files: { <rel>: <sha256> },
//     exportedAt, plutosVersion }
// `path` is relative to the source root (PLUT_OS's app folder, or the pack folder), so the record names
// no machine path. The list of exports is <PLUTOS_HOME>/skill-exports.json { version: 1, exports: [{ path,
// skill, at }] }, so an export outside every client folder is still found.
//
// Claude Code's plugin layout, read 2026-11-11 from code.claude.com/docs/en/plugins-reference and
// /plugins/loading: a plugin's skills are skills/<name>/SKILL.md plus the folders plugin.json's `skills`
// key names (adds to the default); a plugin with SKILL.md at its root, no skills/ and no `skills` key
// is one skill; installed_plugins.json "records each install with its scope, installPath, and version"
// (the docs give those three fields, not the file's full shape: both a single entry and a list of
// entries per "<name>@<marketplace>" key are read here); synced plugins live in plugins/synced/.
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { currentPlutosHome } from './home-dir.mjs';
import { writeFileAtomic } from './app-data.mjs';
import { SKILL_HOMES, SKILL_LIMITS, SKILL_NAME_RE, PACK_ID_RE, within, parseFrontmatterKeys, readRegistry, readActivation } from './skills.mjs';

export const INVENTORY_LIMITS = Object.freeze({
    foldersPerRoot: SKILL_LIMITS.foldersPerHome,   // entries read per skill root
    plugins: 200,                                  // plugin folders read per plugin root
    filesPerSkill: 500,                            // hashed per skill folder
    bytesPerSkill: 16 * 1024 * 1024,
    skillMdBytes: 8 * 1024 * 1024,                 // a SKILL.md larger than this is not hashed
    depth: 8,                                      // folder depth inside one skill
    exports: 500,                                  // entries read from the export list
    linksPerSkill: 200                             // relative links checked per SKILL.md
});
// What export --force-local copies before it replaces a folder: the whole folder or nothing.
export const BACKUP_LIMITS = Object.freeze({ entries: 20000, bytes: 512 * 1024 * 1024, depth: 64 });
export const SOURCE_RECORD = '.plutos-source.json';
const EXPORTS_FILE = 'skill-exports.json';
const FRONT_KEYS = ['name', 'description', 'version', 'disable-model-invocation', 'user-invocable', 'paths'];
// A frontmatter `name` taken as given; anything else (a YAML list, a path, a quote left open) names the
// skill by its folder, with a note.
const FRONT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,63}$/;
// The clients that load each home outside a project (the project homes are SKILL_HOMES).
const CLAUDE_CODE = Object.freeze(['Claude Code']);
const AGENTS_CLIENTS = SKILL_HOMES.find(h => h.folder === '.agents/skills')?.clients || Object.freeze(['Codex', 'Gemini CLI']);

const lstatOrNull = p => { try { return fs.lstatSync(p); } catch (e) { return null; } };
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; } };
const realOrNull = p => { try { return fs.realpathSync(p); } catch (e) { return null; } };
const readdirOrNote = (dir, notes, label) => { try { return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch (e) { notes.push(`${label} could not be read: ${e.message}`); return []; } };
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const slash = rel => rel.split(path.sep).join('/');
const sameOrNested = (a, b) => a === b || within(a, b) || within(b, a);

// The real path of a path that may not exist yet: its nearest existing ancestor's real path plus the rest.
function realish(p) {
    const abs = path.resolve(p);
    const rest = [];
    let cur = abs;
    for (;;) {
        const real = realOrNull(cur);
        if (real) return path.join(real, ...rest.reverse());
        const parent = path.dirname(cur);
        if (parent === cur) return abs;
        rest.push(path.basename(cur));
        cur = parent;
    }
}

// sha256 of one regular file, read in 1 MB pieces; null when it is larger than maxBytes.
export function hashFile(file, maxBytes = Infinity) {
    const fd = fs.openSync(file, 'r');
    try {
        if (fs.fstatSync(fd).size > maxBytes) return null;
        const hash = createHash('sha256');
        const buf = Buffer.alloc(1024 * 1024);
        let pos = 0, n;
        while ((n = fs.readSync(fd, buf, 0, buf.length, pos)) > 0) { hash.update(buf.subarray(0, n)); pos += n; if (pos > maxBytes) return null; }
        return hash.digest('hex');
    } finally { fs.closeSync(fd); }
}

// The normalised name a duplicate group is keyed on: case-insensitive, without a "<plugin>:" prefix.
export function normaliseSkillName(name) {
    const s = String(name || '').trim().toLowerCase();
    return s.includes(':') ? s.slice(s.lastIndexOf(':') + 1) : s;
}

// The files of one skill folder with their hashes, bounded; links are skipped with a note, and the
// export record itself is left out (it is PLUT_OS's bookkeeping, not the skill). A file that cannot be
// read is noted and the folder gets no hash; nothing here throws.
export function hashSkillFolder(dir, notes = [], label = dir) {
    const files = {};
    let count = 0, bytes = 0, newest = 0, truncated = false;
    const walk = (current, depth) => {
        if (truncated) return;
        if (depth > INVENTORY_LIMITS.depth) { notes.push(`${label}: deeper than ${INVENTORY_LIMITS.depth} folders; the rest was not read.`); truncated = true; return; }
        let entries;
        try { entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch (e) { notes.push(`${label}: ${e.message}`); truncated = true; return; }
        for (const entry of entries) {
            if (truncated) return;
            const full = path.join(current, entry.name);
            const rel = slash(path.relative(dir, full));
            if (entry.isSymbolicLink()) { notes.push(`${label}/${rel} is a link and was not read.`); continue; }
            if (entry.isDirectory()) { if (entry.name !== '.git') walk(full, depth + 1); continue; }
            if (!entry.isFile() || rel === SOURCE_RECORD) continue;
            try {
                const st = fs.lstatSync(full);
                count += 1; bytes += st.size;
                if (count > INVENTORY_LIMITS.filesPerSkill || bytes > INVENTORY_LIMITS.bytesPerSkill) {
                    notes.push(`${label}: more than ${INVENTORY_LIMITS.filesPerSkill} files or ${INVENTORY_LIMITS.bytesPerSkill / 1024 / 1024} MB; not hashed whole.`);
                    truncated = true; return;
                }
                newest = Math.max(newest, st.mtimeMs);
                files[rel] = hashFile(full, INVENTORY_LIMITS.bytesPerSkill);
            } catch (e) { notes.push(`${label}/${rel} could not be read: ${e.message}`); truncated = true; return; }
        }
    };
    walk(dir, 0);
    const folderHash = truncated ? null : createHash('sha256').update(Object.keys(files).sort().map(rel => `${rel}\0${files[rel]}\n`).join('')).digest('hex');
    return { files, folderHash, newest };
}

function readHead(file, notes, label) {
    try {
        const st = fs.lstatSync(file);
        const fd = fs.openSync(file, 'r');
        try {
            const buf = Buffer.alloc(Math.min(st.size, SKILL_LIMITS.skillFileBytes));
            return buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString('utf8');
        } finally { fs.closeSync(fd); }
    } catch (e) { notes.push(`${label}/SKILL.md could not be read: ${e.message}`); return null; }
}

// The relative links of a SKILL.md that point at nothing: Markdown link targets, and paths in backticks
// that start with ./, ../ or references/ (a bare `scripts/x.sh` in prose is often a file of the user's project). Only links that stay inside the skill folder or reach a sibling folder are checked (lstat,
// never followed); web links, anchors and absolute paths are not links to a file of this skill.
export function missingLinks(folder, text) {
    const body = String(text || '').replace(/^---\r?\n[\s\S]*?\r?\n---/, '').replace(/```[\s\S]*?```/g, '');
    const targets = new Set();
    for (const m of body.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) targets.add(m[1]);
    for (const m of body.matchAll(/`([^`\s]+)`/g)) {
        const t = m[1];
        // A backtick path counts when it is explicitly relative (./ or ../) or under references/, which is a
        // skill's own reading. A bare `scripts/x.sh` or `examples/y` is as often a file of the user's project.
        if (/^(?:\.{1,2}\/|references?\/)[\w.-]+(?:\/[\w.-]+)*$/.test(t) && /\.[A-Za-z0-9]{1,8}$/.test(t)) targets.add(t);
    }
    const parent = path.dirname(folder);
    const missing = [];
    for (const raw of [...targets].slice(0, INVENTORY_LIMITS.linksPerSkill)) {
        const t = raw.replace(/[#?].*$/, '');
        if (!t || /^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('/') || t.startsWith('\\') || /[<>*{}$]/.test(t)) continue;
        let decoded = t;
        try { decoded = decodeURIComponent(t); } catch (e) { decoded = t; }
        const full = path.resolve(folder, ...decoded.split('/'));
        if (!within(parent, full)) continue;
        if (!lstatOrNull(full)) missing.push(t);
    }
    return missing.sort();
}

// One skill folder → an entry, or null (not a skill, a link, or outside its root).
function readSkill(folder, rootReal, ctx, notes, label) {
    const fst = lstatOrNull(folder);
    if (!fst || fst.isSymbolicLink() || !fst.isDirectory()) return null;
    const real = realOrNull(folder);
    if (!real || (real !== rootReal && !within(rootReal, real))) { notes.push(`${label} resolves outside ${rootReal} and was skipped.`); return null; }
    const file = path.join(folder, 'SKILL.md');
    const sst = lstatOrNull(file);
    if (!sst) return null;
    if (sst.isSymbolicLink()) { notes.push(`${label}/SKILL.md is a link and was skipped.`); return null; }
    if (!sst.isFile()) return null;
    const head = readHead(file, notes, label);
    if (head === null) return null;
    const folderName = path.basename(folder);
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
    if (!fm) notes.push(`${label}/SKILL.md has ${/^---/.test(head) ? 'frontmatter that is not closed' : 'no frontmatter'}; it is named by its folder.`);
    const front = parseFrontmatterKeys(head, FRONT_KEYS);
    let name = str(front.name, 64);
    if (name && !FRONT_NAME_RE.test(name)) { notes.push(`${label}/SKILL.md names itself ${JSON.stringify(name.slice(0, 40))}, which is not a skill name; it is named by its folder.`); name = ''; }
    name = name || folderName;
    const hashed = hashSkillFolder(folder, notes, label);
    let skillMdHash = hashed.files['SKILL.md'] || null;
    if (!skillMdHash) {
        try { skillMdHash = hashFile(file, INVENTORY_LIMITS.skillMdBytes); } catch (e) { skillMdHash = null; }
        if (!skillMdHash) notes.push(`${label}/SKILL.md is larger than ${INVENTORY_LIMITS.skillMdBytes / 1024 / 1024} MB or unreadable; it was not hashed.`);
    }
    const record = lstatOrNull(path.join(folder, SOURCE_RECORD))?.isFile() ? readJson(path.join(folder, SOURCE_RECORD), null) : null;
    const clients = ctx.clients || [];
    const skill = {
        name,
        qualified: ctx.plugin && !name.toLowerCase().startsWith(`${ctx.plugin.toLowerCase()}:`) ? `${ctx.plugin}:${name}` : name,
        key: normaliseSkillName(name),
        source: ctx.source,
        kind: ctx.kind,
        loaded: clients.length > 0,
        clients: [...clients],
        path: folder,
        folder: folderName,
        skillMdHash,
        folderHash: hashed.folderHash,
        files: hashed.files,
        newestMtime: hashed.newest ? new Date(hashed.newest).toISOString() : '',
        description: (front.description || '').slice(0, SKILL_LIMITS.descriptionChars),
        version: str(front.version, 40) || ctx.version || '',
        brokenLinks: missingLinks(folder, head),
        gates: {
            disableModelInvocation: /^true$/i.test(front['disable-model-invocation']),
            userInvocable: front['user-invocable'] === '' ? null : !/^false$/i.test(front['user-invocable']),
            paths: front.paths !== ''
        },
        measured: ctx.measured ? ctx.measured(name, folderName) : null,
        ...(ctx.extra ? ctx.extra(name, folderName, hashed) : {}),
        exportRecord: record && record.version === 1 ? record : null
    };
    WORDS.set(skill, skillWords(head, name, folderName));
    return skill;
}

// The distinct words of a SKILL.md's description and body (its first 64 KB), without the frontmatter
// keys and without the words of the skill's own name, kept out of the result: the duplicate analysis
// compares them, nothing prints them.
const WORDS = new WeakMap();
function skillWords(head, name, folderName) {
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
    const body = fm ? head.slice(fm[0].length) : head;
    const description = parseFrontmatterKeys(head, ['description']).description;
    const own = new Set([name, folderName].flatMap(n => [n.toLowerCase(), ...n.toLowerCase().split(/[^a-z0-9]+/)]));
    return new Set(`${description}\n${body}`.toLowerCase().match(/[a-z][a-z-]{3,}/g)?.filter(w => !own.has(w) && !STOPWORDS.has(w)) || []);
}
// Common English words and skill boilerplate of 4+ letters: two unrelated short skills share them by
// chance, so they say nothing about whether two copies are one skill.
const STOPWORDS = new Set(`
about above after again against all also always another any anything around because been before being
below between both but can cannot could did does doing done down during each either else even ever every
first from further have having here how into its just last least less like make makes many might more
most much must need needs never next none only onto other others ought over own same should since some
something still such sure than that their theirs them then there these they this those through thus
till too under unless until upon used uses using very want wants wait what whatever when where whether
which while who whom whose why will with within without would yet you your yours yourself
skill skills check checks always use run runs read reads write writes file files folder folders step steps
before after first then also ask asks keep make sure note notes example examples instead every each
`.split(/\s+/).filter(w => w.length >= 4));
// Measured on this machine's copies (2026-11-11): the same skill in an older and a newer upload shared
// 0.51-0.77 of its words; unrelated skills on a similar topic shared 0.09-0.11. Below
// SAME_SKILL_MIN_WORDS distinct words on either side the overlap says nothing.
export const SAME_SKILL_WORD_OVERLAP = 0.3;
export const SAME_SKILL_MIN_WORDS = 12;
function wordOverlap(a, b) {
    const wa = WORDS.get(a), wb = WORDS.get(b);
    if (!wa || !wb || wa.size < SAME_SKILL_MIN_WORDS || wb.size < SAME_SKILL_MIN_WORDS) return 0;
    let shared = 0;
    for (const w of wa) if (wb.has(w)) shared++;
    return shared / (wa.size + wb.size - shared);
}

// Every <root>/<name>/SKILL.md, bounded; a root that is a link is not read. One folder that cannot be
// read is a note, never the end of the inventory.
function scanRoot(rootDir, ctx, notes, label, { skip = () => false } = {}) {
    const st = lstatOrNull(rootDir);
    if (!st) return [];
    if (st.isSymbolicLink()) { notes.push(`${label} is a link and was not read.`); return []; }
    if (!st.isDirectory()) return [];
    const rootReal = realOrNull(rootDir);
    if (!rootReal) return [];
    const entries = readdirOrNote(rootDir, notes, label);
    if (entries.length > INVENTORY_LIMITS.foldersPerRoot) notes.push(`${label} holds ${entries.length} entries; the first ${INVENTORY_LIMITS.foldersPerRoot} were read.`);
    const out = [];
    for (const entry of entries.slice(0, INVENTORY_LIMITS.foldersPerRoot)) {
        if (entry.isSymbolicLink()) { notes.push(`${label}/${entry.name} is a link and was skipped.`); continue; }
        if (!entry.isDirectory() || skip(entry.name)) continue;
        if (!SKILL_NAME_RE.test(entry.name)) {
            if (lstatOrNull(path.join(rootDir, entry.name, 'SKILL.md'))) notes.push(`${label}/${entry.name}: the folder name is not a skill name (letters, digits, . _ -; up to 64), so it was skipped.`);
            continue;
        }
        try {
            const skill = readSkill(path.join(rootDir, entry.name), rootReal, ctx, notes, `${label}/${entry.name}`);
            if (skill) out.push(skill);
        } catch (e) { notes.push(`${label}/${entry.name} could not be read (${e.message}); skipped.`); }
    }
    return out;
}

// --- Plugins ------------------------------------------------------------------------------------------

function pluginManifest(pluginDir) {
    const file = path.join(pluginDir, '.claude-plugin', 'plugin.json');
    const st = lstatOrNull(file);
    return st && st.isFile() ? readJson(file, null) : null;
}

// A plugin root's own measured lines, when it carries a PLUT_OS pack record (skills.json); verbatim.
function pluginMeasured(pluginDir) {
    const st = lstatOrNull(path.join(pluginDir, 'skills.json'));
    const record = st && st.isFile() ? readJson(path.join(pluginDir, 'skills.json'), null) : null;
    const map = new Map();
    for (const s of Array.isArray(record?.skills) ? record.skills : []) {
        const m = measuredOf(s?.measured);
        if (s && typeof s.name === 'string' && m) map.set(s.name, m);
    }
    return map;
}

function measuredOf(value) {
    if (!value || typeof value !== 'object') return null;
    const date = str(value.date, 40), summary = str(value.summary, SKILL_LIMITS.descriptionChars), record = str(value.record, 200);
    return date || summary || record ? { date, summary, record } : null;
}

// The skills one plugin brings: skills/*, the folders its manifest's `skills` key names (inside the
// plugin's real root only), or the plugin root itself when it is a single skill.
function scanPlugin(pluginDir, { source, origin, fallbackName, version, clients = CLAUDE_CODE, home = '' }, notes, label) {
    const st = lstatOrNull(pluginDir);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) { if (st?.isSymbolicLink()) notes.push(`${label} is a link and was not read.`); return []; }
    const rootReal = realOrNull(pluginDir);
    if (!rootReal) return [];
    const manifest = pluginManifest(pluginDir) || {};
    const name = (typeof manifest.name === 'string' && /^[^\s@:/\\]{1,64}$/.test(manifest.name)) ? manifest.name : fallbackName;
    const pluginVersion = str(manifest.version, 40) || version || '';
    const measured = pluginMeasured(pluginDir);
    const ctx = {
        source: source || `plugin:${name}`, kind: 'plugin', clients, plugin: name, version: pluginVersion,
        measured: (n, folder) => measured.get(folder) || measured.get(n) || null,
        extra: () => ({ plugin: { name, origin, version: pluginVersion, root: pluginDir }, ...(home ? { home } : {}) })
    };
    const out = [];
    const seen = new Set();
    const add = list => { for (const s of list) if (!seen.has(s.path)) { seen.add(s.path); out.push(s); } };
    add(scanRoot(path.join(pluginDir, 'skills'), ctx, notes, `${label}/skills`));
    const extra = typeof manifest.skills === 'string' ? [manifest.skills] : Array.isArray(manifest.skills) ? manifest.skills.filter(p => typeof p === 'string') : [];
    for (const rel of extra.slice(0, 20)) {
        if (rel.includes('\\') || path.isAbsolute(rel)) { notes.push(`${label}: plugin.json skills path ${JSON.stringify(rel)} was not read.`); continue; }
        const dir = path.resolve(pluginDir, rel);
        const real = realOrNull(dir);
        if (!real || (real !== rootReal && !within(rootReal, real))) { notes.push(`${label}: plugin.json skills path ${JSON.stringify(rel)} escapes the plugin or is missing.`); continue; }
        if (lstatOrNull(path.join(dir, 'SKILL.md'))?.isFile()) {
            try { const one = readSkill(dir, rootReal, ctx, notes, `${label}/${rel}`); if (one) add([one]); } catch (e) { notes.push(`${label}/${rel} could not be read (${e.message}); skipped.`); }
        }
        else add(scanRoot(dir, ctx, notes, `${label}/${rel}`));
    }
    if (!out.length && !extra.length && !lstatOrNull(path.join(pluginDir, 'skills')) && lstatOrNull(path.join(pluginDir, 'SKILL.md'))?.isFile()) {
        try { const one = readSkill(pluginDir, path.dirname(rootReal), ctx, notes, label); if (one) add([one]); } catch (e) { notes.push(`${label} could not be read (${e.message}); skipped.`); }
    }
    return out;
}

// installed_plugins.json: { plugins: { "<name>@<marketplace>": entry | [entry] } }, entry { installPath, version, scope }.
function installedPlugins(pluginsRoot, notes) {
    const file = path.join(pluginsRoot, 'installed_plugins.json');
    const st = lstatOrNull(file);
    if (!st) return [];
    if (st.isSymbolicLink() || !st.isFile()) { notes.push('installed_plugins.json is a link or not a file and was not read.'); return []; }
    const parsed = readJson(file, null);
    if (!parsed || typeof parsed.plugins !== 'object' || !parsed.plugins) { notes.push('installed_plugins.json has no "plugins" map; its installs were not read.'); return []; }
    const out = [];
    for (const [id, value] of Object.entries(parsed.plugins).slice(0, INVENTORY_LIMITS.plugins)) {
        for (const entry of (Array.isArray(value) ? value : [value])) {
            if (!entry || typeof entry.installPath !== 'string' || !path.isAbsolute(entry.installPath)) continue;
            out.push({ id, name: id.split('@')[0], installPath: entry.installPath, version: str(entry.version, 40), scope: str(entry.scope, 20) });
        }
    }
    return out;
}

// --- Sources ------------------------------------------------------------------------------------------

function plutosSkills(appRoot, notes) {
    if (!appRoot) return [];
    const ctx = { source: 'plutos', kind: 'plutos', clients: [], extra: (n, folder) => ({ from: { kind: 'plutos', id: 'plutos', path: `skills/${folder}` } }) };
    const out = scanRoot(path.join(appRoot, 'skills'), ctx, notes, 'PLUT_OS skills');
    const rootReal = realOrNull(appRoot);
    if (rootReal) {
        const mini = readSkill(path.join(appRoot, 'mini'), rootReal, { ...ctx, extra: () => ({ from: { kind: 'plutos', id: 'plutos', path: 'mini' } }) }, notes, 'PLUT_OS mini');
        if (mini) out.push(mini);
    }
    return out;
}

function packSkills(home, notes) {
    const out = [];
    for (const [id, entry] of Object.entries(readRegistry(home).packs)) {
        if (!PACK_ID_RE.test(id) || !entry || typeof entry.path !== 'string') continue;
        if (!lstatOrNull(entry.path)) { notes.push(`pack:${id}: its folder ${entry.path} is missing.`); continue; }
        const words = new Map((Array.isArray(entry.skills) ? entry.skills : []).filter(s => s && typeof s.name === 'string').map(s => [s.name, s]));
        const manifest = readJson(path.join(entry.path, 'module.json'), null);
        const ctx = {
            source: `pack:${id}`, kind: 'pack', clients: [], version: str(manifest?.version, 40),
            measured: (n, folder) => measuredOf(words.get(folder)?.measured) || measuredOf(words.get(n)?.measured),
            extra: (n, folder) => ({ pack: id, from: { kind: 'pack', id, path: `skills/${folder}` } })
        };
        out.push(...scanRoot(path.join(entry.path, 'skills'), ctx, notes, `pack:${id}/skills`));
    }
    return out;
}

function projectSkills(projectRoot, home, notes) {
    if (!projectRoot || !lstatOrNull(projectRoot)) return [];
    const placed = new Map();
    for (const [id, entry] of Object.entries(readActivation(projectRoot).active)) {
        for (const [key, value] of Object.entries(entry.placed)) placed.set(key, { pack: id, files: value && typeof value.files === 'object' ? value.files : {} });
    }
    const registry = placed.size ? readRegistry(home).packs : {};
    const out = [];
    for (const homeEntry of SKILL_HOMES) {
        const dir = path.join(projectRoot, ...homeEntry.folder.split('/'));
        const ctx = {
            source: 'project', kind: 'project', clients: homeEntry.clients,
            measured: (n, folder) => {
                const p = placed.get(`${homeEntry.folder}/${folder}`);
                return p ? measuredOf((registry[p.pack]?.skills || []).find(s => s && s.name === folder)?.measured) : null;
            },
            extra: (n, folder, hashed) => {
                const p = placed.get(`${homeEntry.folder}/${folder}`);
                if (!p) return { home: homeEntry.folder, clients: homeEntry.clients };
                const changed = Object.keys({ ...p.files, ...hashed.files }).filter(rel => p.files[rel] !== hashed.files[rel]).sort();
                return { home: homeEntry.folder, clients: homeEntry.clients, placedBy: { pack: p.pack, state: changed.length ? 'edited' : 'as-placed', changed } };
            }
        };
        out.push(...scanRoot(dir, ctx, notes, homeEntry.folder));
        out.push(...skillsDirPlugins(dir, notes, `project ${homeEntry.folder}`, homeEntry.clients, homeEntry.folder));
    }
    return out;
}

// A folder under a skills directory that carries .claude-plugin/plugin.json is a plugin (Claude Code's
// "@skills-dir" origin), read like any other plugin.
function skillsDirPlugins(dir, notes, label, clients, home) {
    const st = lstatOrNull(dir);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) return [];
    const out = [];
    for (const entry of readdirOrNote(dir, notes, label).slice(0, INVENTORY_LIMITS.foldersPerRoot)) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !SKILL_NAME_RE.test(entry.name)) continue;
        const pdir = path.join(dir, entry.name);
        try {
            if (!pluginManifest(pdir)) continue;
            out.push(...scanPlugin(pdir, { origin: 'skills-dir', fallbackName: entry.name, clients, home }, notes, `${label}/${entry.name}`)
                .filter(s => s.path !== pdir));   // its root SKILL.md is already listed as a plain skill
        } catch (e) { notes.push(`${label}/${entry.name} could not be read (${e.message}); skipped.`); }
    }
    return out;
}

function userSkills(userHome, notes) {
    if (!userHome) return [];
    const out = [];
    const claudeSkills = path.join(userHome, '.claude', 'skills');
    const homeCtx = (home, clients) => ({ source: 'user', kind: 'user', clients, extra: () => ({ home }) });
    out.push(...scanRoot(claudeSkills, homeCtx('~/.claude/skills', CLAUDE_CODE), notes, '~/.claude/skills', { skip: name => name === 'synced' }));
    out.push(...skillsDirPlugins(claudeSkills, notes, '~/.claude/skills', CLAUDE_CODE, '~/.claude/skills'));
    out.push(...scanRoot(path.join(userHome, '.agents', 'skills'), homeCtx('~/.agents/skills', AGENTS_CLIENTS), notes, '~/.agents/skills'));
    // claude.ai-synced skills: ~/.claude/skills/synced/<id>/<name>/SKILL.md
    const synced = path.join(claudeSkills, 'synced');
    const sst = lstatOrNull(synced);
    if (sst && sst.isDirectory() && !sst.isSymbolicLink()) {
        for (const bucket of readdirOrNote(synced, notes, '~/.claude/skills/synced').slice(0, INVENTORY_LIMITS.plugins)) {
            if (bucket.isSymbolicLink()) { notes.push(`~/.claude/skills/synced/${bucket.name} is a link and was skipped.`); continue; }
            if (!bucket.isDirectory() || bucket.name.startsWith('.')) continue;
            out.push(...scanRoot(path.join(synced, bucket.name), { source: 'synced', kind: 'user', clients: CLAUDE_CODE }, notes, `~/.claude/skills/synced/${bucket.name.slice(0, 8)}…`));
        }
    } else if (sst?.isSymbolicLink()) notes.push('~/.claude/skills/synced is a link and was not read.');
    return out;
}

function pluginSkills(userHome, notes) {
    if (!userHome) return [];
    const pluginsRoot = path.join(userHome, '.claude', 'plugins');
    const rst = lstatOrNull(pluginsRoot);
    if (!rst) return [];
    if (rst.isSymbolicLink()) { notes.push('~/.claude/plugins is a link and was not read.'); return []; }
    const out = [];
    for (const p of installedPlugins(pluginsRoot, notes)) {
        try { out.push(...scanPlugin(p.installPath, { origin: p.id, fallbackName: p.name, version: p.version }, notes, `plugin ${p.id}`)); }
        catch (e) { notes.push(`plugin ${p.id} could not be read (${e.message}); skipped.`); }
    }
    const synced = path.join(pluginsRoot, 'synced');
    const sst = lstatOrNull(synced);
    if (sst && sst.isDirectory() && !sst.isSymbolicLink()) {
        for (const bucket of readdirOrNote(synced, notes, 'plugins/synced').slice(0, INVENTORY_LIMITS.plugins)) {
            if (!bucket.isDirectory() || bucket.isSymbolicLink() || bucket.name.startsWith('.')) continue;
            const bdir = path.join(synced, bucket.name);
            const plugins = readdirOrNote(bdir, notes, `plugins/synced/${bucket.name.slice(0, 8)}…`);
            if (plugins.length > INVENTORY_LIMITS.plugins) notes.push(`plugins/synced/${bucket.name.slice(0, 8)}… holds ${plugins.length} entries; the first ${INVENTORY_LIMITS.plugins} were read.`);
            for (const p of plugins.slice(0, INVENTORY_LIMITS.plugins)) {
                if (p.isSymbolicLink()) { notes.push(`plugins/synced/${p.name} is a link and was skipped.`); continue; }
                if (!p.isDirectory() || p.name.startsWith('.')) continue;
                try { out.push(...scanPlugin(path.join(bdir, p.name), { origin: 'synced', fallbackName: p.name }, notes, `plugin synced/${p.name}`)); }
                catch (e) { notes.push(`plugin synced/${p.name} could not be read (${e.message}); skipped.`); }
            }
        }
    }
    return out;
}

// --- Exports ------------------------------------------------------------------------------------------

const exportsPath = home => path.join(home || currentPlutosHome(), EXPORTS_FILE);

function readExportsList(home) {
    const parsed = readJson(exportsPath(home), null);
    return (Array.isArray(parsed?.exports) ? parsed.exports : []).filter(e => e && typeof e.path === 'string' && path.isAbsolute(e.path)).slice(0, INVENTORY_LIMITS.exports);
}

// Where an export's source lives now: PLUT_OS's own folder or the registered pack's, plus the recorded
// relative path, which must stay inside that root. null when it cannot be found.
function resolveExportSource(from, { appRoot, home }) {
    if (!from || typeof from.path !== 'string') return null;
    const parts = from.path.split('/');
    if (!from.path || parts.some(p => !p || p === '.' || p === '..' || p.includes('\\'))) return null;
    let root = '';
    if (from.kind === 'plutos') root = appRoot || '';
    else if (from.kind === 'pack' && PACK_ID_RE.test(String(from.id))) root = readRegistry(home).packs[from.id]?.path || '';
    const rootReal = root ? realOrNull(root) : null;
    if (!rootReal) return null;
    const dir = path.join(root, ...parts);
    const st = lstatOrNull(dir);
    if (!st || st.isSymbolicLink() || !st.isDirectory() || !lstatOrNull(path.join(dir, 'SKILL.md'))?.isFile()) return null;
    const real = realOrNull(dir);
    return real && within(rootReal, real) ? dir : null;
}

// current | stale | edited | stale+edited | source-gone, with the files that differ.
export function exportStatus(skill, options) {
    const record = skill.exportRecord;
    const recorded = record.files && typeof record.files === 'object' ? record.files : {};
    const edited = typeof record.sourceHash === 'string' && skill.folderHash !== record.sourceHash;
    const editedFiles = edited ? Object.keys({ ...recorded, ...skill.files }).filter(rel => recorded[rel] !== skill.files[rel]).sort() : [];
    const src = resolveExportSource(record.from, options);
    if (!src) return { state: 'source-gone', edited, editedFiles, from: record.from };
    const current = hashSkillFolder(src, []);
    const stale = current.folderHash !== record.sourceHash;
    const changedAtSource = stale ? Object.keys({ ...recorded, ...current.files }).filter(rel => recorded[rel] !== current.files[rel]).sort() : [];
    return { state: stale && edited ? 'stale+edited' : stale ? 'stale' : edited ? 'edited' : 'current', edited, editedFiles, changedAtSource, from: record.from, sourcePath: src };
}

// --- Duplicates ---------------------------------------------------------------------------------------

// Two copies are taken as one skill in two versions when their folders or descriptions match, when their
// description and body share at least SAME_SKILL_WORD_OVERLAP of their distinct words (each with at
// least SAME_SKILL_MIN_WORDS of them), or when they share at least half of their file paths and more than
// SKILL.md alone; otherwise the shared name is a clash.
function related(a, b) {
    if (a.folderHash && a.folderHash === b.folderHash) return true;
    if (a.skillMdHash && a.skillMdHash === b.skillMdHash) return true;
    if (a.description && a.description === b.description) return true;
    if (wordOverlap(a, b) >= SAME_SKILL_WORD_OVERLAP) return true;
    // Boilerplate every skill may carry (SKILL.md, a licence, a readme, the export record) says nothing
    // about two copies being one skill, so it is left out before the shared paths are counted.
    const own = p => !/^(?:SKILL\.md|LICEN[CS]E[^/]*|README[^/]*|NOTICE[^/]*|\.plutos-source\.json)$/i.test(p);
    const pa = Object.keys(a.files).filter(own), pb = new Set(Object.keys(b.files).filter(own));
    const shared = pa.filter(p => pb.has(p)).length;
    const union = new Set([...pa, ...pb]).size;
    return shared >= 2 && union > 0 && shared / union >= 0.5;
}

function clusters(copies) {
    const parent = copies.map((_, i) => i);
    const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < copies.length; i++) for (let j = i + 1; j < copies.length; j++) if (related(copies[i], copies[j])) parent[find(i)] = find(j);
    const groups = new Map();
    copies.forEach((c, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(c); });
    return [...groups.values()];
}

const label = s => s.source + (s.home && s.kind !== 'plugin' ? ` ${s.home}` : '') + (s.placedBy ? ` (placed by pack:${s.placedBy.pack})` : '');

// 1.10.2 > 1.9; a part that is not a number compares as text.
export function compareVersions(a, b) {
    const pa = String(a).replace(/^v/i, '').split(/[.+-]/), pb = String(b).replace(/^v/i, '').split(/[.+-]/);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] ?? '', y = pb[i] ?? '';
        if (x === y) continue;
        if (/^\d+$/.test(x) && /^\d+$/.test(y)) return Number(x) - Number(y);
        return x.localeCompare(y);
    }
    return 0;
}

// Which copy is newer, if anything says so. An explicit version (plugin.json, module.json, the
// frontmatter) when every copy has one; a file date only when no copy is synced, a plugin's or placed
// by a pack, since syncing and placing give a fresh date and plugin archives keep an old one.
function orderOf(copies) {
    if (copies.every(c => c.version) && new Set(copies.map(c => c.version)).size > 1) {
        const newest = [...copies].sort((a, b) => compareVersions(b.version, a.version))[0];
        return { by: 'version', newest: label(newest), version: newest.version };
    }
    const dated = copies.every(c => c.kind !== 'plugin' && c.source !== 'synced' && !c.placedBy && c.newestMtime);
    if (dated) {
        const newest = [...copies].sort((a, b) => (b.newestMtime || '').localeCompare(a.newestMtime || ''))[0];
        return { by: 'mtime', newest: label(newest) };
    }
    return { by: 'unknown', newest: null };
}

function analyseGroup(key, copies) {
    const parts = clusters(copies);
    const refs = copies.filter(c => c.kind === 'plutos' || c.kind === 'pack');
    const perClient = {};
    for (const c of copies) for (const client of c.clients) (perClient[client] ||= []).push(label(c));
    // Claude Code loads a plugin's skill as <plugin>:<skill>, so it collides only with the same skill of
    // a plugin of the same name, never with a personal, project or synced one.
    const collide = {};
    for (const c of copies) for (const client of c.clients) {
        const ns = c.kind === 'plugin' ? `plugin:${c.plugin?.name || c.source}` : '';
        ((collide[client] ||= {})[ns] ||= []).push(label(c));
    }
    const sameNamespace = {};
    for (const [client, byNs] of Object.entries(collide)) {
        const twice = Object.values(byNs).filter(list => list.length > 1).flat();
        if (twice.length) sameNamespace[client] = twice;
    }
    const loadedTwice = Object.keys(sameNamespace).sort();
    const describe = c => {
        const ref = refs.find(r => r !== c && r.folderHash && r.folderHash === c.folderHash);
        return {
            source: label(c), qualified: c.qualified, path: c.path, folderHash: c.folderHash, loaded: c.loaded, clients: c.clients,
            version: c.version, newestMtime: c.newestMtime, matches: ref ? label(ref) : null,
            brokenLinks: c.brokenLinks, ...(c.placedBy ? { placedBy: c.placedBy } : {})
        };
    };
    let verdict;
    if (parts.length > 1) verdict = 'name-clash';
    else if (new Set(copies.map(c => c.folderHash)).size === 1 && copies[0].folderHash) verdict = 'identical';
    else verdict = 'different-versions';
    const group = { name: key, verdict, copies: copies.map(describe), clusters: parts.map(p => p.map(label)), perClient, sameNamespace, loadedTwice };
    // A pack placed by `pack on` as it was recorded is one copy per client: expected, not a problem.
    group.expected = !loadedTwice.length && copies.every(c => !c.placedBy || c.placedBy.state === 'as-placed');
    const broken = copies.filter(c => c.brokenLinks.length);
    group.broken = broken.map(c => ({ source: label(c), missing: c.brokenLinks.length, links: c.brokenLinks.slice(0, 5) }));
    group.prefer = broken.length && broken.length < copies.length ? copies.filter(c => !c.brokenLinks.length).map(label) : [];
    if (verdict === 'different-versions') {
        const ref = refs[0] || null;
        group.reference = ref ? label(ref) : null;
        group.referenceVersion = ref ? ref.version : '';
        group.differFromReference = ref ? copies.filter(c => c !== ref && c.folderHash !== ref.folderHash).map(label) : [];
        group.order = orderOf(copies);
    }
    return group;
}

function recommendFor(group) {
    const where = group.copies.map(c => c.source).join(', ');
    const twice = group.loadedTwice.map(client => `${client} loads ${group.sameNamespace[client].length} of them under one name (${group.sameNamespace[client].join(', ')})`).join('; ');
    const brokenText = group.broken.length
        ? ` Broken: ${group.broken.map(b => `${b.source} (${b.missing} missing link${b.missing === 1 ? '' : 's'})`).join(', ')}${group.prefer.length ? `; prefer the complete copy (${group.prefer.join(', ')})` : ''}.`
        : '';
    const order = !group.order ? ''
        : group.order.by === 'version' ? ` Newest by version: ${group.order.newest} (${group.order.version}).`
        : group.order.by === 'mtime' ? ` Newest by file date, a weak hint: ${group.order.newest}.`
        : ' No order is known (synced, plugin and pack-placed copies carry no reliable date, and not every copy has a version).';
    if (group.verdict === 'identical') {
        if (!twice) return brokenText ? `${group.name}: ${group.copies.length} identical copies (${where}).${brokenText}` : null;
        return `${group.name}: ${group.copies.length} identical copies (${where}); ${twice}; keep one per client.${brokenText}`;
    }
    if (group.verdict === 'name-clash') {
        return `${group.name}: ${group.copies.length} copies with different content (${where}) — a name clash, likely different skills that share a name; ${twice ? `${twice}, so the client may load either; keep one or rename.` : 'no client loads two of them; rename one if that is not intended.'}${brokenText}`;
    }
    if (group.reference) {
        const n = group.differFromReference.length;
        return `${group.name}: ${group.differFromReference.join(', ')} differ${n === 1 ? 's' : ''} from the copy PLUT_OS carries (${group.reference}${group.referenceVersion ? `, version ${group.referenceVersion}` : ''}) — decide which to keep; the PLUT_OS copy is the one 'plutos skills export' tracks.${twice ? ` ${twice}.` : ''}${order}${brokenText}`;
    }
    return `${group.name}: ${group.copies.length} versions of one skill (${where}), none of them PLUT_OS's or a registered pack's; ${twice ? `${twice}, so it may pick either; ` : ''}keep the one you trust.${order}${brokenText}`;
}

// --- The inventory ------------------------------------------------------------------------------------

// One source's scan; a failure there is a note, and the other sources are still read.
function guarded(fn, notes, what) {
    try { return fn(); } catch (e) { notes.push(`${what} could not be read (${e.message}); skipped.`); return []; }
}

// { skills, sources: { <label>: count }, duplicates, sameContent, broken, exports, unmeasured, recommendations, notes }
export function inventory({ projectRoot = '', home, userHome = '', appRoot = '' } = {}) {
    const notes = [];
    const skills = [
        ...guarded(() => plutosSkills(appRoot, notes), notes, 'PLUT_OS skills'),
        ...guarded(() => packSkills(home, notes), notes, 'the packs'),
        ...guarded(() => projectSkills(projectRoot, home, notes), notes, 'the project'),
        ...guarded(() => userSkills(userHome, notes), notes, 'the user skill folders'),
        ...guarded(() => pluginSkills(userHome, notes), notes, 'the plugins')
    ];
    // Exports listed in the data folder but outside every scanned folder are read too, as 'export'.
    const seen = new Set(skills.map(s => realOrNull(s.path)));
    for (const e of guarded(() => readExportsList(home), notes, 'the export list')) {
        try {
            const real = realOrNull(e.path);
            if (!real || seen.has(real)) continue;
            const one = readSkill(e.path, path.dirname(real), { source: 'export', kind: 'export', clients: [] }, notes, e.path);
            if (one && one.exportRecord) { skills.push(one); seen.add(real); }
        } catch (err) { notes.push(`${e.path} could not be read (${err.message}); skipped.`); }
    }

    const sources = {};
    for (const s of skills) sources[s.source] = (sources[s.source] || 0) + 1;

    const byKey = new Map();
    for (const s of skills) {
        if (!byKey.has(s.key)) byKey.set(s.key, []);
        byKey.get(s.key).push(s);
    }
    const duplicates = [...byKey.entries()].filter(([, list]) => list.length > 1).map(([key, list]) => analyseGroup(key, list))
        .sort((a, b) => a.name.localeCompare(b.name));

    const byMd = new Map();
    for (const s of skills) { if (!s.skillMdHash) continue; if (!byMd.has(s.skillMdHash)) byMd.set(s.skillMdHash, []); byMd.get(s.skillMdHash).push(s); }
    const sameContent = [...byMd.values()].filter(list => new Set(list.map(s => s.key)).size > 1)
        .map(list => ({ skillMdHash: list[0].skillMdHash, copies: list.map(s => ({ name: s.qualified, source: label(s), path: s.path })) }));

    const broken = skills.filter(s => s.brokenLinks.length).map(s => ({ name: s.name, source: label(s), path: s.path, missing: s.brokenLinks }));

    const exports = [];
    for (const s of skills.filter(x => x.exportRecord)) {
        try { exports.push({ name: s.name, source: s.source, path: s.path, ...exportStatus(s, { appRoot, home }) }); }
        catch (e) { notes.push(`${s.path}: the export record could not be checked (${e.message}).`); }
    }

    const measuredKeys = new Set(skills.filter(s => s.measured).map(s => s.key));
    const unmeasured = [...new Set(skills.filter(s => !measuredKeys.has(s.key)).map(s => s.key))].sort();

    const recommendations = [];
    for (const g of duplicates) { const line = recommendFor(g); if (line) recommendations.push(line); }
    const grouped = new Set(duplicates.map(g => g.name));
    for (const b of broken.filter(x => !grouped.has(normaliseSkillName(x.name)))) {
        recommendations.push(`${b.name} (${b.source}): broken: ${b.missing.length} missing link${b.missing.length === 1 ? '' : 's'} (${b.missing.slice(0, 3).join(', ')}${b.missing.length > 3 ? ', …' : ''}).`);
    }
    for (const list of sameContent) recommendations.push(`same SKILL.md under different names: ${list.copies.map(c => `${c.name} (${c.source})`).join(', ')}; one skill loaded under several names — keep one name.`);
    for (const e of exports) {
        if (e.state === 'current') continue;
        const from = e.from ? `${e.from.kind === 'pack' ? `pack:${e.from.id}` : 'plutos'}` : 'its source';
        if (e.state === 'source-gone') recommendations.push(`${e.name} (export at ${e.path}): its source in ${from} is gone; it is now your own copy — remove ${SOURCE_RECORD} to stop tracking it.`);
        else if (e.state === 'stale') recommendations.push(`${e.name} (export at ${e.path}): ${from} changed since the export (${e.changedAtSource.join(', ') || 'files'}); export again with --force.`);
        else if (e.state === 'edited') recommendations.push(`${e.name} (export at ${e.path}): edited locally (${e.editedFiles.join(', ')}); the source has not changed.`);
        else recommendations.push(`${e.name} (export at ${e.path}): ${from} changed (${e.changedAtSource.join(', ')}) and the copy was edited locally (${e.editedFiles.join(', ')}); merge by hand, or export again with --force --force-local to take the source's.`);
    }
    for (const placed of skills.filter(s => s.placedBy && s.placedBy.state === 'edited')) {
        recommendations.push(`${placed.name} (${placed.home}): edited since pack:${placed.placedBy.pack} placed it (${placed.placedBy.changed.join(', ')}); pack off keeps these files.`);
    }
    // One line per name with no measurement anywhere; the text report folds them into one summary line.
    for (const key of unmeasured) recommendations.push(`${key}: not measured.`);
    return { generatedAt: new Date().toISOString(), skills, sources, duplicates, sameContent, broken, exports, unmeasured, recommendations, notes };
}

// --- Export -------------------------------------------------------------------------------------------

// Finds one skill to export among PLUT_OS's own and the registered packs': "<name>", "plutos:<name>",
// "<pack-id>:<name>" or "pack:<pack-id>:<name>". More than one match is refused with the choices.
export function findExportSource(spec, { appRoot, home } = {}) {
    const notes = [];
    const raw = String(spec || '').trim();
    let want = raw, only = null;
    const m = /^(?:pack:)?([a-z][a-z0-9-]{0,63}):(.+)$/.exec(raw);
    if (m) { only = m[1]; want = m[2]; }
    const candidates = [...plutosSkills(appRoot, notes), ...packSkills(home, notes)]
        .filter(s => (only === null || (only === 'plutos' ? s.kind === 'plutos' : s.pack === only))
            && (s.name.toLowerCase() === want.toLowerCase() || s.folder.toLowerCase() === want.toLowerCase()));
    if (!candidates.length) throw new Error(`No skill "${raw}" in PLUT_OS's own skills or a registered pack (plutos skills inventory lists them).`);
    if (candidates.length > 1) throw new Error(`"${raw}" is in more than one place: ${candidates.map(c => c.kind === 'plutos' ? `plutos:${c.name}` : `${c.pack}:${c.name}`).join(', ')}. Name one.`);
    return candidates[0];
}

function copyFiles(srcDir, files, destDir) {
    for (const rel of Object.keys(files)) {
        const dest = path.join(destDir, ...rel.split('/'));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(srcDir, ...rel.split('/')), dest, fs.constants.COPYFILE_EXCL);
    }
}

// Every entry of a folder, links and .git included, never following a link: { entries: [{ rel, type:
// 'dir'|'file'|'link'|'other', size }], refused }. refused names why the walk stopped (too many entries,
// too many bytes, too deep, unreadable); a refused walk is never used to delete anything.
export function walkTree(dir) {
    const entries = [];
    let bytes = 0;
    const walk = (current, depth) => {
        if (depth > BACKUP_LIMITS.depth) return `deeper than ${BACKUP_LIMITS.depth} folders`;
        let list;
        try { list = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch (e) { return `${slash(path.relative(dir, current)) || '.'} could not be read (${e.message})`; }
        for (const entry of list) {
            const full = path.join(current, entry.name);
            const rel = slash(path.relative(dir, full));
            let st;
            try { st = fs.lstatSync(full); } catch (e) { return `${rel} could not be read (${e.message})`; }
            const type = st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
            entries.push({ rel, type, size: type === 'file' ? st.size : 0 });
            if (type === 'file') bytes += st.size;
            if (entries.length > BACKUP_LIMITS.entries) return `more than ${BACKUP_LIMITS.entries} entries`;
            if (bytes > BACKUP_LIMITS.bytes) return `more than ${BACKUP_LIMITS.bytes / 1024 / 1024} MB`;
            if (type === 'dir') { const why = walk(full, depth + 1); if (why) return why; }
        }
        return '';
    };
    const refused = walk(dir, 0);
    return { entries, refused };
}

// What in an existing export folder its record does not account for: every regular file must be in the
// record with the same hash, every folder must hold a recorded file, every recorded file must be there;
// a link, a .git folder or anything that is not a regular file is not accounted for.
function unaccounted(target, record, tree) {
    if (tree.refused) return [`the folder could not be read whole: ${tree.refused}`];
    const recorded = record && record.version === 1 && record.files && typeof record.files === 'object' ? record.files : null;
    const problems = [];
    const present = new Set();
    for (const e of tree.entries) {
        if (e.type === 'link') { problems.push(`${e.rel} (a link)`); continue; }
        if (e.type === 'other') { problems.push(`${e.rel} (not a regular file)`); continue; }
        if (e.type === 'dir') {
            if (!recorded || !Object.keys(recorded).some(rel => rel.startsWith(`${e.rel}/`))) problems.push(`${e.rel}/ (not in the record)`);
            continue;
        }
        if (e.rel === SOURCE_RECORD) continue;
        present.add(e.rel);
        if (!recorded || !(e.rel in recorded)) { problems.push(`${e.rel} (not in the record)`); continue; }
        let hash = null;
        try { hash = hashFile(path.join(target, ...e.rel.split('/'))); } catch (err) { hash = null; }
        if (hash !== recorded[e.rel]) problems.push(`${e.rel} (edited)`);
    }
    if (recorded) for (const rel of Object.keys(recorded)) if (!present.has(rel)) problems.push(`${rel} (missing)`);
    return problems;
}

// A copy of the whole folder (files, folders and links as links) into dest, which must not exist; then
// the copy is walked again and must hold the same entries with the same sizes. Throws on any failure.
function backupTree(src, tree, dest) {
    const other = tree.entries.find(e => e.type === 'other');
    if (other) throw new Error(`${other.rel} is not a file, a folder or a link and cannot be backed up`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.mkdirSync(dest);
    for (const e of tree.entries) {
        const from = path.join(src, ...e.rel.split('/')), to = path.join(dest, ...e.rel.split('/'));
        if (e.type === 'dir') fs.mkdirSync(to);
        else if (e.type === 'file') fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
        else fs.symlinkSync(fs.readlinkSync(from), to);
    }
    const again = walkTree(dest);
    const key = list => list.map(e => `${e.rel}\0${e.type}\0${e.size}`).join('\n');
    if (again.refused || key(again.entries) !== key(tree.entries)) throw new Error('the backup does not match the folder');
}

// <something>/.<client>/skills: a folder a client loads skills from.
const isClientSkillsHome = dir => path.basename(dir) === 'skills' && path.basename(path.dirname(dir)).startsWith('.');

// The folders an export must never land in, on, or around: the source skill itself, PLUT_OS's skill
// folders and every registered pack.
function protectedRoots(skill, { appRoot, home }) {
    const roots = [realOrNull(skill.path)];
    if (appRoot) roots.push(realOrNull(path.join(appRoot, 'skills')), realOrNull(path.join(appRoot, 'mini')));
    for (const entry of Object.values(readRegistry(home).packs)) if (entry && typeof entry.path === 'string') roots.push(realOrNull(entry.path));
    return roots.filter(Boolean);
}

// Copies one skill into <dest>/<name>/ with its source record. An existing folder is replaced only with
// force, and only when its record accounts for every entry in it, unchanged; with forceLocal, anything
// else is first copied whole to <PLUTOS_HOME>/skill-exports/replaced/<name>-<time>/ (and the path
// reported). A folder that cannot be copied whole is refused, never removed.
export function exportSkill(spec, destFolder, { appRoot, home, force = false, forceLocal = false, plutosVersion = '' } = {}) {
    const skill = findExportSource(spec, { appRoot, home });
    const notes = [];
    const hashed = hashSkillFolder(skill.path, notes, skill.source);
    if (!hashed.folderHash) throw new Error(`${skill.name} is too large to export (${notes.join(' ')}).`);
    if (!destFolder) throw new Error('Name the destination folder.');
    const destRoot = path.resolve(destFolder);
    const dst = lstatOrNull(destRoot);
    if (dst && (dst.isSymbolicLink() || !dst.isDirectory())) throw new Error(`${destRoot} is a link or not a folder.`);
    const folderName = SKILL_NAME_RE.test(skill.name) ? skill.name : skill.folder;
    if (!SKILL_NAME_RE.test(folderName)) throw new Error(`${skill.name} has no folder name a client could load.`);
    const destRealish = realish(destRoot);
    const targetRealish = path.join(destRealish, folderName);
    if (!within(destRealish, targetRealish)) throw new Error(`The skill name ${JSON.stringify(skill.name)} does not make a folder inside ${destRealish}.`);
    const tstEarly = lstatOrNull(targetRealish);
    const targetCheck = tstEarly && !tstEarly.isSymbolicLink() ? (realOrNull(targetRealish) || targetRealish) : targetRealish;
    for (const root of protectedRoots(skill, { appRoot, home })) {
        if (sameOrNested(root, targetCheck)) {
            throw new Error(`${targetRealish} is, is inside, or holds ${root === realOrNull(skill.path) ? 'the skill being exported' : `a PLUT_OS or pack source folder (${root})`}; nothing was changed.`);
        }
    }
    // Inside the PLUT_OS app folder only a client skills home (.claude/skills, .agents/skills, ...) takes
    // an export: any other folder there is PLUT_OS's own source, which --force-local would replace.
    const appReal = appRoot ? realOrNull(appRoot) : null;
    if (appReal && (targetCheck === appReal || within(targetCheck, appReal) || (within(appReal, targetCheck) && !isClientSkillsHome(path.dirname(targetCheck))))) {
        throw new Error(`${targetRealish} is, holds, or is inside the PLUT_OS app folder (${appReal}) outside a client skills folder such as .claude/skills; nothing was changed.`);
    }
    fs.mkdirSync(destRoot, { recursive: true });
    const destReal = fs.realpathSync(destRoot);
    const target = path.join(destReal, folderName);
    if (!within(destReal, target)) throw new Error(`The skill name ${JSON.stringify(skill.name)} does not make a folder inside ${destReal}.`);
    let replacedTo = '';
    const tst = lstatOrNull(target);
    if (tst) {
        if (tst.isSymbolicLink() || !tst.isDirectory()) throw new Error(`${target} exists and is a link or a file; nothing was changed.`);
        if (!force) throw new Error(`${target} already exists; pass --force to replace an earlier export.`);
        const recordFile = path.join(target, SOURCE_RECORD);
        const record = lstatOrNull(recordFile)?.isFile() ? readJson(recordFile, null) : null;
        const tree = walkTree(target);
        const problems = unaccounted(target, record, tree);
        if (problems.length) {
            const shown = `${problems.slice(0, 20).join(', ')}${problems.length > 20 ? `, … ${problems.length - 20} more` : ''}`;
            if (!forceLocal) {
                throw new Error(`${target} has local edits or entries its record does not account for${record ? '' : ' (it has no ' + SOURCE_RECORD + ', so every file counts as local)'}: ${shown}; pass --force-local to replace them (the whole folder is copied to the data folder first). Nothing was changed.`);
            }
            const other = tree.entries.find(e => e.type === 'other');
            const whyNot = tree.refused || (other ? `${other.rel} is not a file, a folder or a link` : '');
            if (whyNot) throw new Error(`${target} cannot be backed up whole (${whyNot}), so it is not replaced; move it away by hand. Nothing was changed.`);
            const replacedRoot = realish(path.join(home || currentPlutosHome(), 'skill-exports', 'replaced'));
            replacedTo = path.join(replacedRoot, `${folderName}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
            if (!within(replacedRoot, replacedTo) || lstatOrNull(replacedTo)) throw new Error(`The backup folder ${replacedTo} is not usable; nothing was changed.`);
            try { backupTree(target, tree, replacedTo); }
            catch (e) { throw new Error(`${target} could not be backed up whole (${e.message}), so it is not replaced; the partial copy is in ${replacedTo}. Nothing in ${target} was changed.`); }
        }
    }
    // Stage beside the target, then swap, so a failed copy never leaves half a skill.
    const staging = fs.mkdtempSync(path.join(destReal, `.${folderName}.plutos-export-`));
    try {
        copyFiles(skill.path, hashed.files, staging);
        const record = { version: 1, from: skill.from, skill: skill.name, sourceHash: hashed.folderHash, files: hashed.files, exportedAt: new Date().toISOString(), plutosVersion };
        fs.writeFileSync(path.join(staging, SOURCE_RECORD), JSON.stringify(record, null, 2) + '\n');
        if (tst) fs.rmSync(target, { recursive: true });
        fs.renameSync(staging, target);
    } catch (e) {
        fs.rmSync(staging, { recursive: true, force: true });
        throw e;
    }
    const list = readExportsList(home).filter(e => e.path !== target);
    list.push({ path: target, skill: skill.name, at: new Date().toISOString() });
    writeFileAtomic(exportsPath(home), JSON.stringify({ version: 1, exports: list }, null, 2) + '\n');
    return { skill: skill.name, from: skill.from, path: target, files: Object.keys(hashed.files).length, sourceHash: hashed.folderHash, replacedTo, notes };
}

// --- Rendering ----------------------------------------------------------------------------------------

export function renderInventory(result, { maxGroups = Infinity } = {}) {
    const lines = ['', 'PLUT_OS · skill inventory', ''];
    lines.push(`Skills found: ${result.skills.length}`);
    for (const [src, n] of Object.entries(result.sources).sort((a, b) => a[0].localeCompare(b[0]))) lines.push(`  ${src}: ${n}`);
    const counts = result.duplicates.reduce((acc, g) => ({ ...acc, [g.verdict]: (acc[g.verdict] || 0) + 1 }), {});
    const twice = result.duplicates.filter(g => g.loadedTwice.length).length;
    lines.push('', `Duplicate names: ${result.duplicates.length} (identical ${counts.identical || 0}, different versions ${counts['different-versions'] || 0}, name clash ${counts['name-clash'] || 0}; loaded twice by one client: ${twice})`);
    for (const g of result.duplicates.slice(0, maxGroups)) {
        const copies = g.copies.map(c => c.source + (c.matches ? ` = ${c.matches}` : '') + (c.brokenLinks.length ? ` [broken: ${c.brokenLinks.length} missing link(s)]` : '')).join(', ');
        const load = g.loadedTwice.length ? ` · ${g.loadedTwice.map(cl => `${cl} loads ${g.sameNamespace[cl].length}`).join(', ')}` : g.expected ? ' · one copy per client' : '';
        lines.push(`  ${g.name} · ${g.verdict} · ${copies}${load}`);
    }
    if (result.duplicates.length > maxGroups) lines.push(`  … ${result.duplicates.length - maxGroups} more (--json)`);
    if (result.sameContent.length) {
        lines.push('', `Same SKILL.md under different names: ${result.sameContent.length}`);
        for (const s of result.sameContent) lines.push(`  ${s.copies.map(c => `${c.name} (${c.source})`).join(', ')}`);
    }
    lines.push('', `Broken copies: ${result.broken.length}${result.broken.length ? ` (${result.broken.map(b => `${b.name} · ${b.source}: broken: ${b.missing.length} missing link(s)`).join('; ')})` : ''}`);
    lines.push(`Exports: ${result.exports.length}${result.exports.length ? ` (${result.exports.map(e => `${e.name} ${e.state}`).join(', ')})` : ''}`);
    const names = new Set(result.skills.map(s => s.key)).size;
    lines.push(`Not measured: ${result.unmeasured.length} of ${names} skill names have no measurement anywhere; --json lists them.`);
    const other = result.recommendations.filter(r => !r.endsWith(': not measured.'));
    lines.push('', `Recommendations: ${other.length}`);
    for (const r of other) lines.push(`- ${r}`);
    for (const n of result.notes) lines.push(`[i] ${n}`);
    return lines.join('\n');
}
