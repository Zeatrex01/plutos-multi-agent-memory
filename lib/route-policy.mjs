// HTTP route access policy — which routes require a selected project. One table, applied at
// dispatch, exactly like lib/tool-policy.mjs does for MCP tools.
//
// Why it exists: `getProjectRoot()` used to fall back to `process.cwd()` when no workspace was
// active, and the dashboard's cwd is the PLUT_OS install itself. With no project selected, all
// 36 routes below quietly operated on PLUT_OS's own repo — it showed PLUT_OS's board, roster,
// ideas and commits as if they were yours, and the write routes that were not individually
// guarded would have installed skills and appended board entries into the product's own
// checkout. Three of those routes had grown their own ad-hoc `if (!getActiveWorkspace()) throw`
// line; the other thirty-three had not, which is precisely the shape of hole a per-handler
// guard leaves behind.
//
// A new route is guarded by DEFAULT-OFF here, deliberately inverted from tool-policy: an HTTP
// route that forgets to declare itself simply keeps working, because the fallback it used to
// rely on is gone — getProjectRoot() now returns '' and a relative path fails loudly instead
// of resolving into the install directory. This list is the friendly answer, not the fence.

// Routes that read project files. With no project there is nothing to read, and answering with
// an empty payload is the honest response — not an error the owner has to dismiss on a fresh
// install where "no project yet" is the normal state.
export const PROJECT_READ_ROUTES = new Set([
    'GET /api/usage',
    'GET /api/interview',
    'GET /api/recommendations',
    'GET /api/board',
    'GET /api/board/evidence',
    'GET /api/return-summary',
    'GET /api/workspaces/repair/preview',
    'GET /api/hygiene',
    'GET /api/continuity',
    'GET /api/context/automation',
    'GET /api/report',
    'GET /api/deck',
    'GET /api/state',
    'GET /api/activity',
    'GET /api/approvals',
    'GET /api/ideas',
    'GET /api/roster',
    'GET /api/codeindex',
    'GET /api/docs',
    'GET /api/git/commits',
    'GET /api/snapshot',
    'GET /api/watcher',
    'GET /api/graphify',
    'GET /api/skills'
]);

// Routes that write into the project. These must fail loudly: silently doing nothing would be
// indistinguishable from success, and the owner would be left wondering where their change went.
export const PROJECT_WRITE_ROUTES = new Set([
    'POST /api/project/install',
    'POST /api/workspaces/repair',
    'POST /api/workspaces/repair/restore',
    'POST /api/connect',
    'POST /api/context/automation',
    'POST /api/interview',
    'POST /api/roster/remove',
    'POST /api/board/archive',
    'POST /api/board',
    'POST /api/approvals',
    'POST /api/ideas',
    'POST /api/codeindex/scan',
    'POST /api/watcher',
    'POST /api/graphify/scan',
    'POST /api/graphify/clean',
    'POST /api/graphify/auto',
    // A pack switched on or off writes skill folders into the project; registering or forgetting
    // a pack (`/api/packs/add`, `/api/packs/forget`) writes only the data folder's registry.
    'POST /api/packs/on',
    'POST /api/packs/off',
    // Not a write, but an action on a project file that must fail loudly without a project.
    'POST /api/docs/open'
]);

// `GET /deck` renders a page rather than JSON, so the guard owes it HTML.
export const PROJECT_PAGE_ROUTES = new Set(['GET /deck']);

export function routeNeedsProject(routeKey) {
    if (/^(GET|POST) \/api\/(council|research)\//.test(routeKey)) return true;
    return PROJECT_READ_ROUTES.has(routeKey)
        || PROJECT_WRITE_ROUTES.has(routeKey)
        || PROJECT_PAGE_ROUTES.has(routeKey);
}

export const NO_PROJECT_MESSAGE = 'No project selected — open the Projects page and pick one first.';

// The empty answer a read route gives when there is no project. Every key here is a collection
// some UI module indexes into without a `|| []` of its own; `needsProject` is the flag a module
// can key an empty state off. Keeping them in one literal is the point — the alternative was
// thirty-six hand-written empty shapes drifting apart.
export const NO_PROJECT_READ_PAYLOAD = Object.freeze({
    needsProject: true,
    project: null,
    projectRoot: null,
    exists: false,
    entries: [],
    modules: [],
    members: [],
    captain: null,
    tasks: [],
    exports: [],
    agents: [],
    ideas: [],
    clients: [],
    recent: [],
    assignments: [],
    commits: [],
    docs: [],
    files: [],
    questions: [],
    recommended: [],
    skills: [],
    packs: [],
    homes: []
});
