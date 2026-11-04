// Presence — "who is working on this project".
//
// The gap this closes: "Won't it show which AIs are connected?"
// They could not. session_start received the caller's identity, used it to filter the brief,
// and then threw it away; only session_end (departure) was ever recorded. So an AI that
// arrived and started working was invisible to every other AI until it finished — and one
// that never called session_end had, as far as the project was concerned, never existed.
//
// PLUT_OS still starts nothing and triggers nothing: this only writes down an arrival that
// already happened. The user triggers the AIs; the board is where they meet.
//
// No new file and no new concept: the roster already models a participant (`kind: main-ai`)
// and already upserts by name with a refreshed "Last active". A main AI calling session_start
// IS a roster participant, so presence is just that entry, kept current.
import fs from 'fs';
import { writeRosterEntry } from './roster-store.mjs';
import { rosterPathFor, parseRoster } from './roster.mjs';

// Names an AI might call itself vs. what it is. Kept deliberately small: this is a display
// nicety, never a gate — an unknown name is recorded exactly as given.
const KNOWN = { claude: 'Claude', gemini: 'Gemini', cursor: 'Cursor', codex: 'Codex', copilot: 'Copilot', antigravity: 'Antigravity' };
const pretty = (ai) => KNOWN[String(ai).trim().toLowerCase()] || String(ai).trim();

// What a client calls itself in the MCP handshake (clientInfo.name) → the name the boards use.
// Checked before any environment variable: Claude Code hands CLAUDECODE to every child process,
// so a Codex or Gemini seat the council spawns inherits it and would otherwise be "Claude Code".
// An unknown name is never returned raw (it is an id such as "codex-mcp-client", not a seat):
// the caller falls back to the environment. Antigravity stays its own name, so board entries
// assigned to "Antigravity" keep matching that seat; Gemini CLI is "Gemini CLI".
const CLIENT_NAMES = [
    [/claude/i, 'Claude Code'], [/antigravity|^agy$/i, 'Antigravity'], [/gemini/i, 'Gemini CLI'],
    [/cursor/i, 'Cursor'], [/codex/i, 'Codex'], [/windsurf|codeium/i, 'Windsurf'],
    [/vscode|visual studio code|copilot/i, 'VS Code'], [/zed/i, 'Zed'], [/roo/i, 'Roo Code'],
    [/cline/i, 'Cline'], [/continue/i, 'Continue'], [/opencode/i, 'OpenCode']
];
export function canonicalClientName(reported) {
    const name = String(reported || '').trim();
    return name ? (CLIENT_NAMES.find(([re]) => re.test(name))?.[1] || null) : null;
}

// The client an environment says spawned this process, or null. The hook entry points (--brief,
// the session close) have no handshake, so this is all they have. Only variables the clients set
// for their own processes count: an API key inherited from the shell (GEMINI_API_KEY,
// CODEIUM_API_KEY) names the key's vendor, not the tool that spawned the process.
export function clientFromEnv(env = process.env) {
    if (env.CLAUDECODE !== undefined || env.CLAUDE_LOG_LEVEL !== undefined || env.CLAUDE_CODE_ENTRYPOINT !== undefined) return 'Claude Code';
    if (env.ANTIGRAVITY_AGENT !== undefined || env.ANTIGRAVITY_CONVERSATION_ID !== undefined
        || env.ANTIGRAVITY_AGENTAPI_EXE !== undefined || env.JETSKI_APP_DATA_DIR !== undefined || env.AI_AGENT === 'antigravity') return 'Antigravity';
    if (env.GEMINI_CLI !== undefined) return 'Gemini CLI';
    if (env.WINDSURF !== undefined || env.WINDSURF_VERSION !== undefined || env.TERM_PROGRAM === 'windsurf') return 'Windsurf';
    // Claude Desktop sets its own APPDATA path.
    if (env.APPDATA && env.APPDATA.toLowerCase().includes('claude')) return 'Claude Desktop';
    if (env.CURSOR_TRACE_ID !== undefined || env.CURSOR_VERSION !== undefined || env.CURSOR_AGENT !== undefined) return 'Cursor';
    if (env.ROO_CODE_VERSION !== undefined) return 'Roo Code';
    if (env.CLINE_VERSION !== undefined) return 'Cline';
    if (env.CONTINUE_GLOBAL_DIR !== undefined) return 'Continue';
    if (env.VSCODE_PID !== undefined || env.TERM_PROGRAM === 'vscode') return 'VS Code';
    // CODEX_HOME is the CLI's own config-dir variable: process-specific, unlike PATH. A PATH
    // substring check was tried and reverted: PATH lists every installed tool, whichever one
    // spawned this process, so every client showed as Codex. Do not add one.
    if (env.CODEX_HOME !== undefined) return 'Codex';
    if (env.OPENCODE !== undefined || env.OPENCODE_SESSION !== undefined) return 'OpenCode';
    return null;
}

// Records that `ai` is here now. Returns the roster action, or null when there is nothing
// to record. NEVER throws: presence is a courtesy to the other AIs, and failing to write it
// must not cost the caller its briefing.
export function recordArrival(projectRoot, ai) {
    const name = pretty(ai);
    if (!name) return null;
    try {
        const { action } = writeRosterEntry(projectRoot, {
            name,
            owner: name,          // a main AI owns itself — nobody else may task it
            role: 'main-ai',
            kind: 'main-ai',
            status: 'active'
        });
        return action;
    } catch (e) {
        return null;
    }
}

// → [{ name, role, kind, lastActive, minutesAgo }] for the participants (kind: main-ai),
// most recently active first. Subagents are left to roster_read — this answers "who works
// here", not "what agents exist".
export function participants(projectRoot) {
    try {
        const file = rosterPathFor(projectRoot);
        if (!fs.existsSync(file)) return [];
        const now = Date.now();
        return parseRoster(fs.readFileSync(file, 'utf8'))
            .filter(a => (a.fields.Kind || '').toLowerCase().includes('main-ai'))
            .map(a => {
                const lastActive = a.fields['Last active'] || a.fields.Registered || '';
                const t = Date.parse(lastActive);
                return {
                    name: a.name,
                    role: a.role,
                    kind: a.fields.Kind || 'main-ai',
                    lastActive,
                    minutesAgo: Number.isNaN(t) ? null : Math.max(0, Math.round((now - t) / 60000))
                };
            })
            .sort((a, b) => (a.minutesAgo ?? 1e9) - (b.minutesAgo ?? 1e9));
    } catch (e) {
        return [];
    }
}

// "Claude · 2m ago" — the human-readable form used in the brief.
export function describeAge(minutesAgo) {
    if (minutesAgo === null || minutesAgo === undefined) return 'unknown';
    if (minutesAgo < 2) return 'just now';
    if (minutesAgo < 60) return `${minutesAgo}m ago`;
    if (minutesAgo < 60 * 24) return `${Math.round(minutesAgo / 60)}h ago`;
    return `${Math.round(minutesAgo / (60 * 24))}d ago`;
}
