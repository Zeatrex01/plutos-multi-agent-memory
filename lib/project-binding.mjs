// Project identity checks shared by the MCP adapter and client connection plans.
//
// A PLUT_OS marker proves that a directory is *a* PLUT_OS project. It does not prove that
// it is the project currently open in the MCP client. These helpers keep those two questions
// separate so a stale global MCP registration cannot silently read or write another repo.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const PROJECT_ROOT_ENV = 'PLUTOS_PROJECT_ROOT';
export const LAUNCHER_BOUND_ENV = 'PLUTOS_PROJECT_BOUND_BY_LAUNCHER';
export const CODEX_PROJECT_SCOPE_ENV = 'PLUTOS_CODEX_PROJECT_CONFIG';

export function resolveProjectRoot(env = process.env, cwd = process.cwd()) {
    return path.resolve(env?.[PROJECT_ROOT_ENV] || cwd);
}

function comparablePath(value) {
    if (!value || typeof value !== 'string') return '';
    let resolved = path.resolve(value);
    try {
        resolved = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
    } catch (e) {
        // init_roadmap can legitimately target a directory before every child exists. The
        // resolved spelling is still a useful comparison when realpath is unavailable.
    }
    const root = path.parse(resolved).root;
    if (resolved !== root) resolved = resolved.replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function sameProjectPath(a, b) {
    const left = comparablePath(a);
    const right = comparablePath(b);
    return !!left && left === right;
}

export function isCodexClient(clientInfo = {}, env = process.env) {
    return /codex/i.test(String(clientInfo?.name || '')) || env?.CODEX_HOME !== undefined;
}

// Checks signals already present at initialization time. Returns an actionable error string
// or null. Codex is intentionally fail-closed: old `codex mcp add plutos ...` registrations
// are global and can stay pinned to a completely different repository.
export function staticBindingError(projectRoot, clientInfo = {}, env = process.env) {
    if (isCodexClient(clientInfo, env) && env?.[CODEX_PROJECT_SCOPE_ENV] !== '1') {
        return `Unsafe legacy Codex PLUT_OS connection: this server was not loaded from this repository's .codex/config.toml. ` +
            `A global Codex MCP entry can stay pinned to another project, so PLUT_OS refuses project reads and writes. ` +
            `Run node cli.mjs connect codex in this project, then restart Codex.`;
    }

    // Claude Code supplies the active project directory independently of the MCP entry. That
    // gives us a second identity to compare with the launcher's bound root.
    const claudeRoot = env?.CLAUDE_PROJECT_DIR;
    if (claudeRoot && !sameProjectPath(projectRoot, claudeRoot)) {
        return mismatchError(projectRoot, path.resolve(claudeRoot), 'Claude reports its active project as', 'Claude Code');
    }
    return null;
}

function fileRootPath(root) {
    const uri = typeof root === 'string' ? root : root?.uri;
    if (!uri || typeof uri !== 'string') return '';
    try {
        const parsed = new URL(uri);
        return parsed.protocol === 'file:' ? fileURLToPath(parsed) : '';
    } catch (e) {
        return '';
    }
}

// MCP clients that advertise the Roots capability give the server an authoritative view of
// the open workspace. Exact equality is deliberate: accepting a common parent would make two
// sibling repositories indistinguishable again.
export function advertisedRootsError(projectRoot, roots) {
    const paths = Array.isArray(roots) ? roots.map(fileRootPath).filter(Boolean) : [];
    if (!paths.length) {
        return `Project verification failed: the MCP client advertised workspace roots but returned no local file root. ` +
            `PLUT_OS refuses project access rather than guessing.`;
    }
    if (paths.some(root => sameProjectPath(projectRoot, root))) return null;
    return mismatchError(projectRoot, paths.join(', '), 'the MCP client reports', 'the MCP client');
}

// Both mismatch messages say the same three things: the old path, the new one, and the steps
// that move the server to the new one (connect there, then restart, because a running client
// keeps the server it started).
function mismatchError(projectRoot, active, reportedBy, clientName) {
    return `Project mismatch: this PLUT_OS server is bound to ${projectRoot} (old), but ${reportedBy} ${active} (new). ` +
        `Refusing project access. Fix: connect PLUT_OS in the new project (plutos_project_info's "fix" field has the exact command), ` +
        `then restart ${clientName} so it starts the server from there.`;
}

// The project the client says is open, for the fix command: Claude Code's project directory,
// else the first local root the client advertised, else null (unknown).
export function activeProjectRoot(env = process.env, roots = []) {
    if (env?.CLAUDE_PROJECT_DIR) return path.resolve(env.CLAUDE_PROJECT_DIR);
    const paths = Array.isArray(roots) ? roots.map(fileRootPath).filter(Boolean) : [];
    return paths[0] || null;
}
