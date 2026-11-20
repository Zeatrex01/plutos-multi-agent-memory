// The file types PLUT_OS recognises, in one table (owner decision d-a67637f8d490, 2026-11-14).
// Before this, the code map (lib/graphify.mjs), the task index (lib/task-context.mjs) and the code
// index (lib/codeindex.mjs) each kept their own extension list, and the task index a second list of
// where a concept (deploy, CI, migrations) conventionally lives. A new language or engine is now one
// row here; the scanners derive their lists from it.
//
// A row:
//   id          a short name
//   kind        'code' | 'meta' (project, build, deploy, engine settings) | 'doc' | 'asset'
//   exts        suffixes, recognised anywhere ('.sql')
//   names       base names, recognised anywhere; `stem.*` is any extension ('vitest.config.*')
//   paths       where the type conventionally lives, relative to the project root: `dir/` is a
//               folder, `stem.*` any extension. With `names` (when they sit at the root) these are
//               the conventional locations the task index offers for a concept.
//   concepts    what a task about this type is about: build, test, deploy, ci, data, schema,
//               engine-settings, scene, package, config, docs, auth, style
//   inCodeMap   graphify walks its exts into the code map (lib/graphify.mjs CODE_EXTS)
//   taskSearch  the task index reads its exts (code-map rows are read through the map)
//   importsParsed  graphify draws file-to-file edges from the relative imports its files name (the
//               JS/TS family). Every other code-map language gets declaration-reference edges, and
//               inside an engine project the engine's reference rules (lib/engines.mjs)
//   importSyntax   with importsParsed: 'js' (relative `import`/`require`)
//   codeIndex   the code index's generic scanner reads its exts (lib/codeindex.mjs GENERIC_EXTS)
// Detection is the table and nothing else: no framework sniffing. An engine's own rows (its project
// file, its scenes) come from the engines table (lib/engines.mjs fileTypes), spliced in below.
import { ENGINES } from './engines.mjs';

const code = (id, exts, flags = {}) => ({ id, kind: 'code', exts, concepts: [], inCodeMap: false, taskSearch: false,
    importsParsed: false, codeIndex: false, ...flags });
const meta = (id, concepts, more) => ({ id, kind: 'meta', concepts, inCodeMap: false, taskSearch: false,
    importsParsed: false, codeIndex: false, ...more });
const JS_IMPORTS = { importsParsed: true, importSyntax: 'js' };
const MAPPED = { inCodeMap: true, taskSearch: true, codeIndex: true };
const SEARCHED = { taskSearch: true, codeIndex: true };

export const FILE_TYPES = [
    // Code the map parses. The order is graphify's resolution order for an import with no suffix.
    code('javascript', ['.js', '.mjs', '.cjs'], { ...MAPPED, ...JS_IMPORTS }),
    code('typescript', ['.ts', '.tsx'], { ...MAPPED, ...JS_IMPORTS }),
    code('jsx', ['.jsx'], { ...MAPPED, ...JS_IMPORTS }),
    code('python', ['.py'], MAPPED),
    code('csharp', ['.cs'], MAPPED),
    code('go', ['.go'], MAPPED),
    code('rust', ['.rs'], MAPPED),
    code('java', ['.java'], MAPPED),
    code('cpp', ['.cpp'], MAPPED),
    code('c', ['.c', '.h'], MAPPED),
    code('cpp-header', ['.hpp'], MAPPED),
    // A language that belongs to one engine alone, from its row in lib/engines.mjs (`language`).
    ...ENGINES.filter(e => e.language).map(e => code(e.language, e.code, MAPPED)),
    code('lua', ['.lua'], MAPPED),
    code('php', ['.php'], MAPPED),
    code('ruby', ['.rb'], MAPPED),
    code('swift', ['.swift'], MAPPED),
    code('kotlin', ['.kt'], MAPPED),
    // Code the task index and the code index read, not the map: no parsed imports or edges.
    code('sql', ['.sql'], { taskSearch: true, concepts: ['data', 'schema'] }),
    code('cpp-alt', ['.cc', '.cxx', '.hh', '.hxx'], SEARCHED),
    code('objective-c', ['.m', '.mm'], SEARCHED),
    code('scala', ['.scala'], SEARCHED),
    code('zig', ['.zig'], SEARCHED),
    code('dart', ['.dart'], SEARCHED),
    code('elixir', ['.ex', '.exs'], SEARCHED),
    code('web-component', ['.vue', '.svelte', '.astro'], { taskSearch: true }),
    code('shader', ['.gdshader', '.shader', '.hlsl', '.glsl', '.wgsl'], { taskSearch: true }),
    // Code recognised in a task's text only.
    code('typescript-module', ['.mts', '.cts']),
    code('python-stub', ['.pyi']),
    code('solidity', ['.sol']),
    code('shell', ['.sh', '.bash', '.ps1', '.bat', '.cmd']),
    code('style', ['.css', '.scss', '.sass', '.less'], { concepts: ['style'] }),
    code('markup', ['.html', '.htm']),
    // A conventional file that is code: where a project keeps its auth gate.
    code('auth-entry', [], { names: ['middleware.*', 'auth.*'], paths: ['src/middleware.*', 'src/auth.*'], concepts: ['auth'] }),

    // Engine and project meta: each engine's rows from lib/engines.mjs, in table order.
    ...ENGINES.flatMap(e => e.fileTypes.map(({ id, concepts, ...more }) => meta(id, concepts, more))),
    meta('dotnet-project', ['build', 'package'], { exts: ['.csproj', '.sln'], paths: ['*.sln', '*.csproj'] }),
    meta('node-package', ['package', 'build'], { names: ['package.json'] }),
    meta('python-project', ['package', 'build'], { names: ['pyproject.toml', 'requirements.txt', 'setup.py'] }),
    meta('cargo', ['package', 'build'], { names: ['Cargo.toml'] }),
    meta('go-module', ['package'], { names: ['go.mod'] }),
    meta('gemfile', ['package'], { names: ['Gemfile'] }),
    meta('composer', ['package'], { names: ['composer.json'] }),
    meta('pubspec', ['package'], { names: ['pubspec.yaml'] }),
    meta('gradle', ['build', 'package'], { exts: ['.gradle', '.kts'], names: ['build.gradle', 'settings.gradle'] }),
    // The config concept offers these in this order: the env example first (an "env" task means it),
    // then the bundler configs, then tsconfig.
    meta('env-example', ['config'], { names: ['.env.example', '.env.sample'] }),
    meta('bundler-config', ['build', 'config'], { names: ['next.config.*', 'vite.config.*', 'webpack.config.*'] }),
    meta('typescript-config', ['build', 'config'], { names: ['tsconfig.json'] }),

    // Deploy and CI.
    meta('github-actions', ['ci'], { paths: ['.github/workflows/'] }),
    meta('ci-config', ['ci'], { names: ['.gitlab-ci.yml', 'azure-pipelines.yml', 'bitbucket-pipelines.yml', 'Jenkinsfile'], paths: ['.circleci/'] }),
    meta('vercel', ['deploy'], { names: ['vercel.json'] }),
    meta('netlify', ['deploy'], { names: ['netlify.toml'] }),
    meta('docker', ['deploy', 'build'], { names: ['Dockerfile', 'docker-compose.*'] }),
    meta('fly', ['deploy'], { names: ['fly.toml'] }),
    meta('render', ['deploy'], { names: ['render.yaml'] }),
    meta('procfile', ['deploy'], { names: ['Procfile'] }),

    // Schema and data.
    // Prisma's one schema file before the migration folders, so the generic `db/` never pushes it out.
    meta('prisma', ['schema', 'data'], { exts: ['.prisma'], paths: ['prisma/schema.prisma'] }),
    meta('migrations', ['schema', 'data'], { paths: ['supabase/migrations/', 'migrations/', 'db/migrations/', 'db/'] }),
    meta('schema-language', ['schema'], { exts: ['.proto', '.graphql', '.gql'] }),

    // Test configs.
    meta('test-config', ['test'], { names: ['playwright.config.*', 'vitest.config.*', 'jest.config.*', 'cypress.config.*', 'pytest.ini'],
        paths: ['cypress/', 'tests/', 'e2e/'] }),

    // Plain data and config formats.
    meta('json', ['config'], { exts: ['.json', '.jsonc'] }),
    meta('yaml', ['config'], { exts: ['.yml', '.yaml'] }),
    meta('toml', ['config'], { exts: ['.toml'] }),
    meta('ini', ['config'], { exts: ['.ini', '.cfg', '.conf', '.env'] }),
    meta('xml', ['config'], { exts: ['.xml'] }),
    meta('lockfile', ['package'], { exts: ['.lock'] }),
    meta('table-data', ['data'], { exts: ['.csv', '.tsv'] }),

    { id: 'markdown', kind: 'doc', exts: ['.md', '.mdx'], concepts: ['docs'], inCodeMap: false, taskSearch: true, importsParsed: false, codeIndex: false },
    { id: 'text', kind: 'doc', exts: ['.txt', '.log', '.pdf'], concepts: ['docs'], inCodeMap: false, taskSearch: false, importsParsed: false, codeIndex: false },
    { id: 'image', kind: 'asset', exts: ['.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp'], concepts: [], inCodeMap: false, taskSearch: false, importsParsed: false, codeIndex: false },
];

const extsWhere = (pred) => FILE_TYPES.filter(pred).flatMap(r => r.exts || []);

// graphify's code map: the languages it reads. importsParsed: the ones whose relative imports it
// resolves, JS_IMPORT_EXTS the JS/TS family among them.
export const CODE_MAP_EXTS = extsWhere(r => r.inCodeMap);
export const IMPORT_PARSED_EXTS = extsWhere(r => r.importsParsed);
export const JS_IMPORT_EXTS = extsWhere(r => r.importsParsed && r.importSyntax === 'js');
// The task index reads these beside the code map.
export const TASK_ONLY_EXTS = extsWhere(r => r.taskSearch && !r.inCodeMap && r.kind !== 'doc');
// Documents have a separate, heading-only task index and never enter the code vocabulary.
export const TASK_DOC_EXTS = extsWhere(r => r.taskSearch && r.kind === 'doc');
// The code index's generic scanner.
export const CODE_INDEX_EXTS = extsWhere(r => r.codeIndex);

// Every suffix the table knows, without the dot: a dotted name in a task with one of these is a
// file name. A row's `names` are compared whole (KNOWN_NAMES), never split into suffixes, so
// `go.mod` is a file and `user.mod` is not.
export const KNOWN_SUFFIXES = new Set(extsWhere(() => true).map(e => e.slice(1)));
// The table's exact base names (no `stem.*` pattern), lower case: an engine's project file, `go.mod`, `.env.example`.
export const KNOWN_NAMES = new Set(FILE_TYPES.flatMap(r => r.names || []).filter(n => !n.includes('*')).map(n => n.toLowerCase()));

// The conventional locations of a concept, relative to the project root, in table order: a row's
// `names` (looked for at the root), then its `paths`.
export function conceptLocations(concept) {
    return FILE_TYPES.filter(r => r.concepts.includes(concept)).flatMap(r => [...(r.names || []), ...(r.paths || [])]);
}

const nameMatches = (pattern, base) => pattern.endsWith('.*')
    ? base.startsWith(pattern.slice(0, -1)) && base.length > pattern.length - 1
    : pattern.startsWith('*.') ? base.endsWith(pattern.slice(1)) : base === pattern;

const suffixRow = (lowerBase) => {
    let best = null, bestLen = 0;
    for (const r of FILE_TYPES) {
        for (const e of r.exts || []) if (lowerBase.endsWith(e) && e.length > bestLen) { best = r; bestLen = e.length; }
    }
    return best;
};

// The row a file belongs to, by its path relative to the project root, or null. A conventional
// location is the most specific, then a base name, then the longest matching suffix
// (`supabase/migrations/001.sql` is a migration, `vercel.json` is deploy, not plain JSON). Code is
// code wherever it sits: a folder rule wins over a code suffix only when the two share a concept
// (`db/001.sql` is a migration; `db/models.py`, `tests/board.test.mjs`, `scenes/player.gd` are code).
// A named file (`vitest.config.ts`, `src/middleware.ts`) is its named row.
export function fileTypeOf(relPath) {
    const p = String(relPath).replace(/\\/g, '/').replace(/^\.\//, '');
    const base = p.split('/').pop();
    const bySuffix = suffixRow(base.toLowerCase());
    const codeWins = (r) => bySuffix?.kind === 'code' && !bySuffix.concepts.some(c => r.concepts.includes(c));
    for (const r of FILE_TYPES) {
        for (const loc of r.paths || []) {
            if (loc.endsWith('/') ? (p.startsWith(loc) || p.includes('/' + loc)) && !codeWins(r)
                : loc.includes('/') && (p === loc || p.endsWith('/' + loc))) return r;
        }
    }
    for (const r of FILE_TYPES) if ((r.names || []).some(n => nameMatches(n, base))) return r;
    return bySuffix;
}
