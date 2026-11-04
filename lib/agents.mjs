// Agent creation — the piece the bridge was missing.
//
// The gap: PLUT_OS was meant to be "a shared agent-CREATING
// and task-assigning centre", but an AI could only ever REGISTER an agent that already
// existed. Writing the actual agent file was a dashboard action, i.e. the user's job — so
// "the AIs divide the work among themselves and build what they need" had no middle.
//
// This closes it: one call writes the agent template and records it on the roster. PLUT_OS
// still starts nothing — creating an agent is writing a markdown file the AI's own tool will
// read when the user runs it.
//
// YAML front matter (name, description) + a body, in <project>/.claude/agents/.
import fs from 'fs';
import path from 'path';
import { writeRosterEntry } from './roster-store.mjs';

// This name becomes a filename and a directory under .agents/, so a separator or a traversal
// segment must never reach it.
const AGENT_NAME = /^[a-z0-9][a-z0-9-]{1,48}$/;

function assertName(name) {
    const n = String(name || '').trim().toLowerCase();
    if (!AGENT_NAME.test(n)) {
        throw new Error(`Invalid agent name "${name}". Use lowercase letters, digits and dashes (2-49 chars), e.g. "stripe-integrator".`);
    }
    return n;
}

// Plain (unquoted) YAML text stops being the text it looks like once it holds ": " or " #",
// ends in ":" or opens with an indicator character. The whole frontmatter then fails to parse
// and the agent loads with no name or description: it never triggers, and nothing says why.
// A one-line value written so any YAML parser reads it back unchanged.
function yamlScalar(value) {
    const text = String(value).replace(/\s*\r?\n\s*/g, ' ').trim();
    if (!/: | #|:$|^[-?:](\s|$)|^[,[\]{}#&*!%@`]/.test(text) && !/^["'>|]|["']$/.test(text)) return text;
    if (!/["\\]/.test(text)) return `"${text}"`;
    if (!text.includes("'")) return `'${text}'`;
    return `>-\n  ${text}`;
}

// → { name, file, created, rosterAction }
// `owner` is the AI doing the creating: it owns what it creates, and the roster's ownership
// rule ("you only ever task your OWN agents") is what keeps this from becoming a way to
// conscript another vendor's agents.
export function createAgent(projectRoot, { name, owner, role, description, task } = {}) {
    const agentName = assertName(name);
    if (!owner || typeof owner !== 'string') throw new Error('owner is required — the AI creating (and therefore owning) this agent.');
    if (!role || typeof role !== 'string') throw new Error('role is required — what this agent is for, in a few words.');

    if (['skills', 'plugins'].includes(agentName)) throw new Error(`"${agentName}" is reserved for the ${agentName} folder.`);
    // Where the definition goes is the owner's tool's convention: Claude Code discovers and runs
    // .claude/agents/<name>.md; any other AI keeps its definition beside the agent's memory
    // (owner decision O4, 2026-11-03). Only the owner's own tool runs it either way.
    const claude = /^claude\b/i.test(owner.trim());
    const dir = claude ? path.join(projectRoot, '.claude', 'agents') : path.join(projectRoot, '.agents', agentName);
    const rel = claude ? path.join('.claude', 'agents', `${agentName}.md`) : path.join('.agents', agentName, 'AGENT.md');
    const resolved = path.resolve(projectRoot, rel);
    if (!resolved.startsWith(path.resolve(dir) + path.sep)) throw new Error('Invalid agent path.');
    if (fs.existsSync(resolved)) {
        throw new Error(`Agent "${agentName}" already exists (${path.relative(projectRoot, resolved)}). Edit that file, or pick another name.`);
    }

    const body = [
        '---',
        `name: ${agentName}`,
        `description: ${yamlScalar(description || role)}`,
        `owner: ${owner}`,
        '---',
        '',
        `# ${agentName}`,
        '',
        (description || role).trim(),
        '',
        '## Scope',
        `- Role: ${role.trim()}`,
        task ? `- Created for board task: ${String(task).replace(/\s*\r?\n\s*/g, ' ').trim()}` : '- Created on demand.',
        `- Owner: ${owner} — only ${owner} tasks this agent. Anyone else leaves a suggestion on the board.`,
        '',
        '## Protocol',
        '- Read `AGENTS.md` before acting; it is the project\'s coordination contract.',
        '- Claim your work on the agent board (`board_update` with board: "agents", status IN_PROGRESS).',
        '- Finish with status DONE, a one-line result, and a reference to whatever you produced',
        '  (put documents in `results/` and name the file in the result).',
        '- Record one durable lesson per session; cite exact project source/evidence when available,',
        '  and leave unsupported notes honestly unverified.',
        ''
    ].join('\n');

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(resolved, body, 'utf8');

    let rosterAction;
    try {
        ({ action: rosterAction } = writeRosterEntry(projectRoot, {
            name: agentName,
            owner,
            role: role.trim(),
            kind: 'subagent',
            memory: `.agents/${agentName}/MEMORY.md`,
            status: 'introduced'   // exists and is visible; flips to active on its first agent_register
        }));
    } catch (e) {
        try { fs.rmSync(resolved, { force: true }); } catch (cleanup) { /* best-effort rollback */ }
        throw e;
    }

    return {
        name: agentName,
        file: rel,
        created: true,
        rosterAction
    };
}
