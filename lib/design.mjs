// Design direction ("tasarımı oturtmak", owner 2026-11-05): a project with a user interface keeps its own design
// language in `docs/ai/DESIGN.md`, derived from the project by the first AI that builds UI there and extended with
// reasons by every AI after it, so a quick first design is not copied and grown by every later session. PLUT_OS only
// reads the page: one brief line for projects that have a UI or a DESIGN.md (nothing at all for the rest), and a
// head line in plutos_context_for_task for UI work. The AI writes the page from `scaffold/design/DESIGN-template.md`;
// the design-ui-direction skill (`skills/design-ui-direction/`, shipped with PLUT_OS like project-scissors) says how;
// another package may add its own checks on top.
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { APP_ROOT } from './approot.mjs';

export const DESIGN_FILE = 'docs/ai/DESIGN.md';
// From the install root, so the packaged builds (scaffold/ next to the bundle) name a file that exists.
export const DESIGN_TEMPLATE = path.join(APP_ROOT, 'scaffold', 'design', 'DESIGN-template.md');
export const DESIGN_SKILL = path.join(APP_ROOT, 'skills', 'design-ui-direction', 'SKILL.md');
export const UI_EXTENSIONS = new Set(['.html', '.css', '.scss', '.sass', '.less', '.jsx', '.tsx', '.vue', '.svelte', '.astro',
    '.erb', '.ejs', '.hbs', '.twig', '.cshtml', '.razor']);
// Folders whose UI-looking files are not the project's own interface: dependencies and build output, docs sites,
// coverage reports, test fixtures and examples. Compared lower-case; any dot-folder is skipped too.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '_build', 'out', 'target', 'vendor', 'coverage', 'htmlcov',
    'lcov-report', 'storybook-static', 'docs', 'doc', 'site', 'test', 'tests', '__tests__', 'fixtures', 'testdata',
    'examples', 'example', 'venv', '__pycache__']);
const MAX_WALK = 20000;
const CACHE_MS = 30_000;
const cache = new Map();

const skipped = file => file.split('/').slice(0, -1).some(part => part.startsWith('.') || SKIP_DIRS.has(part.toLowerCase()));
const isUiFile = file => UI_EXTENSIONS.has(path.extname(file).toLowerCase());

// UI candidates from git (tracked and untracked-not-ignored, so a first page counts before its first commit),
// filtered by git itself so the output stays small; null when git cannot answer.
function gitUiFiles(root) {
    try {
        const patterns = [...UI_EXTENSIONS].map(ext => `*${ext}`);
        const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...patterns],
            { cwd: root, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
        return out.split('\0').filter(Boolean);
    } catch { return null; }
}

function walkUiFiles(root) {
    const files = [];
    let seen = 0;
    const walk = (dir, rel) => {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (++seen > MAX_WALK) return;
            const child = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) { if (!e.name.startsWith('.') && !SKIP_DIRS.has(e.name.toLowerCase())) walk(path.join(dir, e.name), child); }
            else if (e.isFile() && isUiFile(e.name)) files.push(child);
        }
    };
    walk(root, '');
    return files;
}

// A game project has its own visual-direction flow (design-game-in-phases, game-art-review): engine markers at the
// root, or a Godot project anywhere in the repository.
function isGameProject(root) {
    if (fs.existsSync(path.join(root, 'project.godot')) || fs.existsSync(path.join(root, 'ProjectSettings', 'ProjectVersion.txt'))) return true;
    try { if (fs.readdirSync(root).some(name => name.toLowerCase().endsWith('.uproject'))) return true; } catch { /* unreadable */ }
    try {
        const nested = execFileSync('git', ['ls-files', '--', '*project.godot'], { cwd: root, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        return nested.trim().length > 0;
    } catch { return hasNestedGodot(root, 4); }
}

// Without git: a project.godot up to a few folders down (skipping the same folders as the UI walk).
function hasNestedGodot(dir, depth) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    if (entries.some(e => e.isFile() && e.name === 'project.godot')) return true;
    return depth > 0 && entries.some(e => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name.toLowerCase()) && hasNestedGodot(path.join(dir, e.name), depth - 1));
}

/** The project's UI files (paths relative to the root), [] for a project without a UI or for a game project. */
export function uiFiles(projectRoot) {
    const root = path.resolve(projectRoot);
    const hit = cache.get(root);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.files;
    const files = isGameProject(root) ? [] : (gitUiFiles(root) ?? walkUiFiles(root)).filter(f => !skipped(f));
    cache.set(root, { at: Date.now(), files });
    return files;
}

/** Whether the project has a user interface of its own (a game project does not count). */
export function hasUserInterface(projectRoot) { return uiFiles(projectRoot).length > 0; }

export function resetDesignCache() { cache.clear(); }

const PLACEHOLDER = /^(…|\.\.\.|unknown|tbd|todo)$/i;

/** What DESIGN.md says, or null without one. Lenient: a part it cannot read is left out, never guessed. */
export function readDesign(projectRoot) {
    let text;
    try { text = fs.readFileSync(path.join(projectRoot, DESIGN_FILE), 'utf8'); } catch { return null; }
    const section = name => (text.split(new RegExp(`^##\\s+${name}\\b[^\\n]*$`, 'mi'))[1] || '').split(/^##\s/m)[0];
    const updated = (text.match(/^\s*Updated\s*:\s*(\d{4}-\d{2}-\d{2})/mi) || [])[1] || '';
    const blocks = [...section('Tokens').matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map(m => m[1]).join('\n');
    const tokens = blocks.split('\n').map(line => line.match(/^\s*([\w.-]+)\s*:\s*(.+?)\s*$/))
        .filter(m => m && !PLACEHOLDER.test(m[2])).map(m => ({ name: m[1], value: m[2] }));
    // Only top-level dated bullets are decisions; the template's own example line has no real date.
    const decisions = section('Decisions').split('\n').filter(line => /^[-*]\s+\d{4}-\d{2}-\d{2}\b/.test(line)).length;
    const picks = section('Owner picks').split('\n').filter(line => /^[-*]\s+\d{4}-\d{2}-\d{2}\b/.test(line) && !/superseded/i.test(line)).length;
    return { updated, tokens, decisions, picks, template: !updated && !tokens.length && !decisions && !picks };
}

// A shipped file named relative to the project when it sits inside it (PLUT_OS itself), else by its full path;
// '' when the file is missing, so the brief never names a path that does not exist.
function shipped(projectRoot, file) {
    if (!fs.existsSync(file)) return '';
    const rel = path.relative(projectRoot, file);
    return `\`${!rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : path.normalize(file)}\``;
}

function how(projectRoot, templatePath, skillPath) {
    const parts = [shipped(projectRoot, skillPath) && `the skill ${shipped(projectRoot, skillPath)} says how`, shipped(projectRoot, templatePath) && `template ${shipped(projectRoot, templatePath)}`].filter(Boolean);
    return parts.length ? ` (${parts.join('; ')})` : '';
}

/** The brief's design line: nothing for a project with neither a UI nor a DESIGN.md, one line otherwise. */
export function designBriefLines(projectRoot, { templatePath = DESIGN_TEMPLATE, skillPath = DESIGN_SKILL } = {}) {
    const design = readDesign(projectRoot);
    if (!design && !hasUserInterface(projectRoot)) return [];
    const ref = how(projectRoot, templatePath, skillPath);
    if (!design) {
        return ['## Design', `No \`${DESIGN_FILE}\`: before the first UI change, derive the project's design language from the project and write it${ref}. Every choice needs a reason from this project, not a default.`, ''];
    }
    if (design.template) {
        return ['## Design', `\`${DESIGN_FILE}\` is still the unfilled template: fill it from the project before the first UI change${ref}.`, ''];
    }
    const parts = [design.updated ? `updated ${design.updated}` : 'no Updated date', `${design.tokens.length} token(s)`, `${design.decisions} decision(s)`, ...(design.picks ? [`${design.picks} owner pick(s), follow them first`] : [])];
    return ['## Design', `\`${DESIGN_FILE}\` (${parts.join(', ')}): follow it for UI work; add a new UI decision to it with its reason; when the code and DESIGN.md disagree, fix one of them.`, ''];
}

// Words that mean UI work on their own (Turkish too: the owner speaks it). Ambiguous ones (page, style, design,
// component, header, form, menu) count only when the task's files include a UI file: an HTTP header, a form
// validator in an API, code style or a docs page is not UI work.
const UI_WORDS = /(?<![\p{L}\p{N}_])(ui|ux|user interface|screen|layout|css|button|theme|dashboard|landing|modal|font|colou?rs?|arayüz\p{L}*|ekran\p{L}*|buton\p{L}*|tasarım\p{L}*|renk\p{L}*|tema\p{L}*)(?![\p{L}\p{N}_])/iu;

/** For plutos_context_for_task: the head line for a UI task, or null when the task does not look like UI work. */
export function designForTask(projectRoot, taskText, files = []) {
    const text = String(taskText || '');
    const touchesUi = files.some(f => isUiFile(String(f)));
    if (!touchesUi && !UI_WORDS.test(text)) return null;
    const design = readDesign(projectRoot);
    if (design && !design.template) return `Design: ${DESIGN_FILE}: if this task changes the UI, read it first and add a new UI decision to it with its reason.`;
    if (isGameProject(path.resolve(projectRoot))) return null;
    return `Design: no filled ${DESIGN_FILE} yet: if this task changes the UI, write it first from the project${how(projectRoot, DESIGN_TEMPLATE, DESIGN_SKILL)}.`;
}
