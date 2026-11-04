// Roster persistence — the one place a roster entry is written to disk.
//
// Why it exists: MCP agent_register, session_start presence, agent creation, and the
// dashboard's roster-remove button must produce byte-identical, conflict-safe results.
// Direct writeFileSync on ROSTER.md was how one write racing an MCP presence write could
// drop an acknowledged update.
//
// Deliberately NOT folded into roster.mjs: that module is pure text (parse/format, zero fs),
// which is what makes it trivially testable. Composition instead — this module is the only
// one that knows the roster is a file.
import fs from 'fs';
import path from 'path';
import { applyRosterUpdate, removeRosterEntry, rosterPathFor } from './roster.mjs';
import { updateFileAtomically } from './atomic.mjs';
import { HANDOFF_TEMPLATES_DIR } from './workspaces.mjs';

const FALLBACK_SEED = "# ROSTER - Registered Agents\n<!-- plutos:clean-template -->\n\nRules: see `AGENTS.md`.\n\n---\n\n(no agents registered - add your entry above this line)\n";

export function rosterSeed() {
    const templatePath = path.join(HANDOFF_TEMPLATES_DIR, 'ROSTER.md');
    try {
        return fs.existsSync(templatePath) ? fs.readFileSync(templatePath, 'utf8') : FALLBACK_SEED;
    } catch (e) {
        return FALLBACK_SEED;
    }
}

// Upserts one agent. → { action: 'registered' | 'refreshed', path }
export function writeRosterEntry(projectRoot, fields) {
    const rosterPath = rosterPathFor(projectRoot);
    const action = updateFileAtomically(rosterPath, (content) => {
        const { content: updated, action } = applyRosterUpdate(content, fields);
        return { content: updated, result: action };
    }, { seed: rosterSeed() });
    return { action, path: rosterPath };
}

// Remove by name. Throws if the file or the named agent is missing (dashboard contract).
// → { removed: true, entry, path }
export function removeRosterAgent(projectRoot, name) {
    const rosterPath = rosterPathFor(projectRoot);
    if (!fs.existsSync(rosterPath)) throw new Error('No roster in this project.');
    let entry = null;
    updateFileAtomically(rosterPath, (content) => {
        const r = removeRosterEntry(content, name);
        if (!r.removed) throw new Error(`'${name}' is not on the roster.`);
        entry = r.entry;
        return { content: r.content, result: true };
    });
    return { removed: true, entry, path: rosterPath };
}
