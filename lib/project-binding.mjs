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
            `Open this project's PLUT_OS Connect panel, set up Codex there, then restart Codex.`;
    }

    // Claude Code supplies the active project directory independently of the MCP entry. That
    // gives us a second identity to compare with the launcher's bound root.
    const claudeRoot = env?.CLAUDE_PROJECT_DIR;
    if (claudeRoot && !sameProjectPath(projectRoot, claudeRoot)) {
        return `Project mismatch: this PLUT_OS server is bound to ${projectRoot}, but Claude reports its active project as ${path.resolve(claudeRoot)}. ` +
            `Refusing project access; reconnect through the active project's .plutos/plutos-launch.mjs.`;
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
    return `Project mismatch: this PLUT_OS server is bound to ${projectRoot}, while the MCP client reports ${paths.join(', ')}. ` +
        `Refusing project access; reconnect PLUT_OS from the active repository.`;
}
