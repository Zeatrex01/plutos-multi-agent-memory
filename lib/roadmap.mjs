// Board paths and the project kit install. (The roadmap page and its roadmap-data.js signal file went in
// 2026-10-28: nothing had written the file since the BOARD sync tool went on 2026-10-25.)
import fs from 'fs';
import path from 'path';
import { initTargetProject } from './workspaces.mjs';

export function boardPathFor(projectRoot) {
    let boardPath = path.join(projectRoot, 'docs', 'handoff', 'BOARD.md');
    if (!fs.existsSync(boardPath) && fs.existsSync(path.join(projectRoot, 'BOARD.md'))) {
        boardPath = path.join(projectRoot, 'BOARD.md');
    }
    return boardPath;
}

// Second board tier: subagents coordinate here (research notes, findings, doc
// references) so the main board stays boss-level (tasks + status only).
export function agentBoardPathFor(projectRoot) {
    return path.join(projectRoot, 'docs', 'handoff', 'AGENT_BOARD.md');
}

// Scaffolds the AI dev environment into projectRoot. Never overwrites existing files. → log lines
// Explicitly installs the same core kit as the CLI/project-kit action (initTargetProject).
// Dashboard Add Project itself is observe-only. This tool used to dump
// the entire scaffold/ into the project, which produced a different AGENTS.md
// depending on install path.
export function initRoadmap(projectRoot, { withInterview = false } = {}) {
    initTargetProject(projectRoot, { withInterview });
    return [`✅ Project kit installed: AGENTS.md, docs/handoff/{BOARD,AGENT_BOARD,ROSTER}.md${withInterview ? ', PROJECT_INTERVIEW.md' : ''}, results/, code index, document maps, PLUT_OS.bat (existing files untouched). No AI tool is wired by this: the owner connects each one on the Connect panel or with plutos connect <client-id>.`];
}
