// The leftover catalogue: every path a PLUT_OS kit (or the dashboard and MCP server acting on a
// project) ever wrote into a project that today's kit no longer writes. `plutos audit`
// (lib/audit.mjs) looks for each one; tools/kit-history-test.mjs keeps the list complete.
//
// Built from the repository's own history, not from memory (2026-11-04): `git log --diff-filter=D`
// over lib/ and scaffold/, `git log -S` over lib/workspaces.mjs (initTargetProject, KIT_FILES,
// copyTreeMissing, the seeds), the deleted modules read at their parent commit (`git show
// <commit>^:lib/system.mjs`, lib/profile.mjs, lib/skills.mjs, lib/roles.mjs, lib/editions.mjs,
// lib/install-manifest.mjs, lib/studio-*.mjs, lib/roadmap.mjs), lib/board-store.mjs's role tier,
// and the CHANGELOG lines that say what left.
//
// An entry: { path, since, why, action, commit, ...qualifier }
//   path     project-relative; a trailing / is a folder; a segment may hold * (any characters
//            but /), so `docs/boards/*.md` is every Markdown file directly in docs/boards/
//   since    the day the kit stopped writing it (YYYY-MM-DD), from the commit below
//   why      one line: what wrote it and why nothing reads it now
//   action   'move'            nothing reads it; `plutos audit --clean` moves it into the Hub
//            'refresh'         Repair (dashboard Projects → Repair) replaces it with what the kit
//                              writes today
//            'keep-if-edited'  a copy of somebody else's content, or a name a project may use for
//                              its own file: moved only when the old install record proves it
//                              unedited, otherwise the owner decides
//   commit   the commit that stopped the write (the same one the comment above the entry names)
// Qualifiers narrow a path the current kit also uses, or a name a project may hold for itself:
//   contains   the file must hold this text (the old writer's fingerprint)
//   names      only these folder or file names under the * segment
//   recorded   also match what .plutos/install-manifest.json (the old installer's record) lists
//
// A feature that stops writing a project file adds an entry here in the same commit, and names the
// path in EVER_WRITTEN when it first writes it: tools/kit-history-test.mjs fails otherwise.

export const LEFTOVER_ACTIONS = Object.freeze(['move', 'refresh', 'keep-if-edited']);

// The old library's skill folder names (scaffold/shared-skills/ and the editions' skills/, from
// `git log --name-only -- scaffold/shared-skills scaffold/editions`), which the library, the role
// bundles, the editions and, from 2026-10-21 to 2026-10-29, the kit itself copied into a project.
// Names that carry a game engine's name are left out: the rule of two keeps engine names out of
// lib/ (tools/rule-of-two-test.mjs). Those folders are still found through the install record when
// the project has one (installs from 2026-08-22, 91b4c6a), and are otherwise the owner's to judge.
export const OLD_LIBRARY_SKILLS = Object.freeze([
    'advanced-evaluation', 'agent-bridge', 'agent-bridge-kit', 'agent-forge', 'agent-profiles', 'agent-watcher',
    'algorithmic-art', 'api-design-reviewer', 'asset-review', 'balance-review', 'bdi-mental-states', 'brainstorming',
    'brand-guidelines', 'build-playability-review', 'canvas-design', 'cf-init', 'claude-api', 'code-hygiene', 'code-reviewer',
    'codebase-memory', 'composition-patterns', 'concept-curator', 'context-compression', 'context-degradation',
    'context-fundamentals', 'context-optimization', 'council-mode', 'critic-panel', 'database-schema-designer', 'defuddle',
    'delegation-policy', 'design-game-in-phases', 'dispatching-parallel-agents', 'doc-coauthoring', 'docx', 'evaluation',
    'executing-plans', 'fable-multi-agent', 'feel-pass', 'filesystem-context', 'finishing-a-development-branch',
    'frontend-design', 'game-changing-features', 'game-codex', 'game-debug', 'game-design-theory', 'game-developer',
    'game-direction', 'game-docs', 'game-eng-review', 'game-ideation', 'game-import', 'game-qa', 'game-retro',
    'game-review', 'game-ship', 'game-studio-director', 'game-ux-review', 'game-visual-qa', 'gameplay-implementation-review',
    'global-rules', 'graphify', 'gstack-game', 'hosted-agents', 'implementation-handoff', 'install', 'internal-comms',
    'json-canvas', 'karpathy-guidelines', 'latent-briefing', 'learn-user', 'level-progression-design',
    'master-continuity-protocol', 'mcp-builder', 'memory-systems', 'multi-agent-patterns', 'mvp-compass', 'obsidian-bases',
    'obsidian-cli', 'obsidian-markdown', 'pdf', 'performance-profiler', 'pitch-review', 'plan-design-review',
    'planning-with-files', 'player-experience', 'player-experience-design', 'playtest', 'ponytail', 'pptx',
    'project-critic', 'project-development', 'project-intake', 'project-onboarder', 'project-setup', 'prompt-master',
    'prototype-slice-plan', 'react-best-practices', 'react-native-skills', 'receiving-code-review', 'remotion',
    'requesting-code-review', 'research-verification', 'rival-scan', 'security-pen-testing', 'senior-architect',
    'senior-backend', 'senior-frontend', 'session-wrap', 'shared-studio-collaboration', 'shipped-review', 'skill-creator',
    'skill-scout', 'slack-gif-creator', 'spark-lens', 'studio-prompt-engineer', 'studio-skill-evaluation',
    'studio-source-maintenance', 'studio-work-orchestrator', 'subagent-driven-development', 'subagent-roster',
    'supabase-postgres-best-practices', 'systematic-debugging', 'tech-debt', 'technical-portfolio-generator',
    'test-driven-development', 'test-game-prototype', 'theme-factory', 'tool-design', 'trend-mechanic-research', 'triage',
    'ui-ux-pro-max', 'using-git-worktrees', 'using-superpowers', 'validate-mobile-concept', 'verification-before-completion',
    'visual-production-ruleset', 'web-artifacts-builder', 'web-design-guidelines', 'web-rules', 'webapp-testing',
    'work-companion', 'working-discipline', 'writing-plans', 'writing-skills', 'xlsx'
]);

// The agent templates the role bundles and the editions copied into .claude/agents/
// (scaffold/agent-templates/ and scaffold/editions/*/agents/); engine-named ones left out as above.
export const OLD_AGENT_TEMPLATES = Object.freeze([
    'backend-agent.md', 'concept-curator.md', 'context-engineer-agent.md', 'creative-agent.md', 'critic-agent.md',
    'design-critic.md', 'design-researcher.md', 'design-team-lead.md', 'docs-agent.md', 'feel-designer.md', 'forge-agent.md',
    'frontend-agent.md', 'game-critic-agent.md', 'game-design-agent.md', 'game-dev-agent.md', 'game-engineer-agent.md',
    'game-os-director.md', 'gameplay-designer.md', 'level-designer.md', 'mvp-agent.md', 'onboarding-agent.md',
    'orchestrator-agent.md', 'ponytail-agent.md', 'prompt-engineer-agent.md', 'quality-agent.md', 'research-agent.md',
    'scout-agent.md', 'studio-steward-agent.md', 'visual-director.md'
]);

const INSTALL_RECORD = '.plutos/install-manifest.json';

export const LEFTOVERS = Object.freeze([
    // 3f562ae (2026-11-04, P2-1) took the system roles out of the tools, the brief and the API;
    // 7af7c5d deleted lib/system.mjs and scaffold/system-roles/.
    { path: 'docs/handoff/SYSTEM.md', since: '2026-11-04', commit: '3f562ae', action: 'move',
        why: 'the system-role casting (KERNEL, BUS, DAEMON, DRIVER); the roles left and nothing reads it' },
    { path: 'docs/handoff/system-roles/', since: '2026-11-04', commit: '3f562ae', action: 'move',
        why: 'the role charters copied on the first cast; the roles left and nothing reads them' },
    // 3f562ae: "init's profile.json [is] gone"; 7af7c5d deleted lib/profile.mjs.
    { path: '.plutos/profile.json', since: '2026-11-04', commit: '3f562ae', action: 'move',
        why: 'the lite/full profile plutos init wrote; profiles left and nothing reads it' },
    // 3f562ae: the full profile's kernel grant (lib/profile.mjs grantKernelPermission) wrote this rule.
    { path: '.claude/settings.json', contains: 'mcp__plutos__*', since: '2026-11-04', commit: '3f562ae', action: 'keep-if-edited',
        why: 'the allow rule the full profile granted its KERNEL; profiles left, the rule still lets every PLUT_OS tool run unasked' },
    // 601a280 (2026-10-29, Job 24 phase 2): the editions, which copied their boards/ here, left.
    { path: 'docs/boards/PROTOCOL.md', since: '2026-10-29', commit: '601a280', action: 'move',
        why: 'the role constitution an edition copied in; the editions left' },
    { path: 'docs/boards/attachments/', since: '2026-10-29', commit: '601a280', action: 'move',
        why: 'the board attachments an edition copied in; the editions left' },
    // eb15f6d (2026-11-04, P3 code): the role tier of board_update (docs/boards/<role>.md) left.
    { path: 'docs/boards/*.md', since: '2026-11-04', commit: 'eb15f6d', action: 'move',
        why: 'a role board (board_update role tier, or an edition\'s board); the role tier left and no tool reads it' },
    // 601a280: the skill library, the role bundles, the editions and the install record left.
    // d50aee6 (2026-10-29) had already stopped the kit's own core skills (7d5a956, 2026-10-21).
    { path: 'shared-skills/', since: '2026-10-29', commit: '601a280', action: 'keep-if-edited',
        why: 'the old skill library\'s "shared" install folder, and the kit\'s core skills from 2026-10-21; no AI tool reads this folder' },
    { path: '.claude/skills/*', names: OLD_LIBRARY_SKILLS, recorded: true, since: '2026-10-29', commit: '601a280', action: 'keep-if-edited',
        why: 'a skill the old library, a role bundle or an edition copied in; packs (plutos pack) place skills now' },
    { path: '.claude/agents/*', names: OLD_AGENT_TEMPLATES, recorded: true, since: '2026-10-29', commit: '601a280', action: 'keep-if-edited',
        why: 'an agent template a role bundle or an edition copied in; the roles and editions left' },
    { path: INSTALL_RECORD, since: '2026-10-29', commit: '601a280', action: 'move',
        why: 'the old installer\'s record of what it copied; moved last, once nothing it lists is left' },
    { path: '.plutos/editions/', since: '2026-10-29', commit: '601a280', action: 'move',
        why: 'the receipts of installed editions; the editions left' },
    // dbd8157 (2026-10-29, Job 24 phase 1): the studio layer and the office left.
    { path: '.plutos/studio/', since: '2026-10-29', commit: 'dbd8157', action: 'move',
        why: 'the studio layer\'s records (meetings, goals, departments, snapshots); the studio left PLUT_OS' },
    { path: '.plutos/client-sessions/', since: '2026-10-29', commit: 'dbd8157', action: 'move',
        why: 'the studio\'s client session records; the studio left PLUT_OS' },
    { path: '.plutos/workspace/', since: '2026-10-29', commit: 'dbd8157', action: 'move',
        why: 'the studio\'s shared tabs; the studio left PLUT_OS' },
    { path: '.studio/status/plutos.*.json', since: '2026-10-29', commit: 'dbd8157', action: 'move',
        why: 'a presence report PLUT_OS left in a studio workspace when it stopped unexpectedly; the reporter left' },
    // 42050a8 (2026-10-28, Job 17a): the roadmap page and its roadmap-data.js seed left (the sync
    // tool that fed them went in d01afb1, 2026-10-25).
    { path: 'docs/roadmap/', since: '2026-10-28', commit: '42050a8', action: 'move',
        why: 'the roadmap page, its icon script and its data the kit scaffolded; nothing has written the data since 2026-10-25' },
    { path: 'public/roadmap.html', contains: 'ROADMAP_DATA', since: '2026-10-28', commit: '42050a8', action: 'move',
        why: 'the roadmap page the kit scaffolded into a web project\'s public folder, where it is served' },
    { path: 'public/data/roadmap-data.js', contains: 'ROADMAP_DATA', since: '2026-10-28', commit: '42050a8', action: 'move',
        why: 'the roadmap page\'s data seed' },
    { path: 'public/vendor/lucide.min.js', since: '2026-10-28', commit: '42050a8', action: 'keep-if-edited',
        why: 'the icon script copied beside public/roadmap.html; a web project may use its own copy' },
    { path: 'docs/handoff/roadmap-data.js', contains: 'ROADMAP_DATA', since: '2026-10-28', commit: '42050a8', action: 'move',
        why: 'the roadmap data seed for a project whose signal file lived beside the boards' },
    // 91e6140 (2026-10-11): the watcher became a Node script; Repair replaces the old shell one.
    { path: '.plutos/plutos-watcher.sh', since: '2026-10-11', commit: '91e6140', action: 'refresh',
        why: 'the shell watcher; the Node watcher (.plutos/plutos-watcher.cjs) replaced it' },
    // 6976527 (2026-08-23): the on-demand assistant stayed on its branch.
    { path: 'docs/handoff/results/assistant-summary.md', since: '2026-08-23', commit: '6976527', action: 'keep-if-edited',
        why: 'the on-demand assistant\'s summary; the assistant left, the summary may still be worth reading' },
    { path: '.plutos/assistant-last.json', since: '2026-08-23', commit: '6976527', action: 'move',
        why: 'the on-demand assistant\'s last answer; the assistant left' },
    // f8fb3ea (2026-07-18): the code-scan button stopped copying a script from one machine.
    { path: 'scan-scripts.ps1', since: '2026-07-18', commit: 'f8fb3ea', action: 'keep-if-edited',
        why: 'a scan script the first dashboard copied from one machine into the project root' }
]);

// Every project path any PLUT_OS version wrote, from the history above: today's kit, what the
// dashboard and the MCP server write today, and every catalogue path. A folder ends in /.
export const EVER_WRITTEN = Object.freeze([
    // The kit (lib/workspaces.mjs initTargetProject), since 2026-07-13 (69d5564) and growing.
    'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.cursor/rules/plutos.mdc', '.claude/rules/plutos.md',
    'docs/handoff/PLUTOS_PROTOCOL.md', 'docs/handoff/BOARD.md', 'docs/handoff/AGENT_BOARD.md', 'docs/handoff/ROSTER.md',
    'docs/handoff/PROJECT_INTERVIEW.md', 'docs/handoff/results/', '.plutos/plutos-launch.mjs', '.plutos/local.json',
    '.plutos/plutos.config.json', 'PLUT_OS.bat', 'PLUT_OS.sh', '.gitignore',
    'docs/ai/CODEINDEX.md', 'docs/ai/codeindex/', 'docs/ai/OBSIDIAN_INDEX.md', 'docs/ai/obsidian/',
    // The dashboard and the MCP server, today (RUNTIME_WRITES).
    '.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json', '.gemini/settings.json', '.codex/config.toml',
    '.agents/mcp_config.json', '.claude/settings.local.json', '.codex/hooks.json', '.plutos/plutos-watcher.cjs',
    '.plutos/approvals/', '.plutos/council/', '.plutos/research/', '.plutos/drawers.json', '.plutos/claims-baseline.json',
    '.plutos/memory.db', '.plutos/packs.json', '.plutos/state.json', '.plutos/logs/', 'docs/handoff/CONTINUITY.md',
    'docs/handoff/CONTEXT.json', 'docs/handoff/archive/', '.agents/*/', '.claude/agents/*', '.claude/skills/*',
    '.agents/skills/*', 'graphify-out/', 'IDEAS.md', 'CHANGELOG.md',
    // Written once, no longer (LEFTOVERS).
    'docs/handoff/SYSTEM.md', 'docs/handoff/system-roles/', '.plutos/profile.json', '.claude/settings.json',
    'docs/boards/PROTOCOL.md', 'docs/boards/attachments/', 'docs/boards/*.md', 'shared-skills/',
    '.plutos/install-manifest.json', '.plutos/editions/', '.plutos/studio/', '.plutos/client-sessions/', '.plutos/workspace/',
    '.studio/status/plutos.*.json', 'docs/roadmap/', 'public/roadmap.html', 'public/data/roadmap-data.js',
    'public/vendor/lucide.min.js', 'docs/handoff/roadmap-data.js', '.plutos/plutos-watcher.sh',
    'docs/handoff/results/assistant-summary.md', '.plutos/assistant-last.json', 'scan-scripts.ps1'
]);

// What the dashboard and the MCP server write into a project today, outside initTargetProject:
// { path, writer, evidence }, where `evidence` is text the writer's source holds (the test reads it,
// so an entry whose writer stopped is caught).
export const RUNTIME_WRITES = Object.freeze([
    { path: '.mcp.json', writer: 'lib/connect.mjs', evidence: "'.mcp.json'" },
    { path: '.cursor/mcp.json', writer: 'lib/connect.mjs', evidence: "path.join('.cursor', 'mcp.json')" },
    { path: '.vscode/mcp.json', writer: 'lib/connect.mjs', evidence: "path.join('.vscode', 'mcp.json')" },
    { path: '.gemini/settings.json', writer: 'lib/connect.mjs', evidence: "path.join('.gemini', 'settings.json')" },
    { path: '.codex/config.toml', writer: 'lib/connect.mjs', evidence: "path.join('.codex', 'config.toml')" },
    { path: '.agents/mcp_config.json', writer: 'lib/connect.mjs', evidence: "path.join('.agents', 'mcp_config.json')" },
    { path: '.claude/settings.local.json', writer: 'lib/watcher.mjs', evidence: "'.claude', 'settings.local.json'" },
    { path: '.codex/hooks.json', writer: 'lib/project-hooks.mjs', evidence: "'.codex', 'hooks.json'" },
    { path: '.plutos/plutos-watcher.cjs', writer: 'lib/watcher.mjs', evidence: '${WATCHER_MARK}.cjs' },
    { path: '.plutos/approvals/', writer: 'lib/approvals.mjs', evidence: "'.plutos', 'approvals'" },
    { path: '.plutos/council/', writer: 'lib/council-room.mjs', evidence: "'.plutos', 'council'" },
    { path: '.plutos/research/', writer: 'lib/research/store.mjs', evidence: "'.plutos', 'research'" },
    { path: '.plutos/drawers.json', writer: 'lib/drawers.mjs', evidence: "'.plutos', 'drawers.json'" },
    { path: '.plutos/claims-baseline.json', writer: 'lib/claims.mjs', evidence: "'.plutos', 'claims-baseline.json'" },
    { path: '.plutos/memory.db', writer: 'lib/memory-index.mjs', evidence: "'.plutos', 'memory.db'" },
    { path: '.plutos/packs.json', writer: 'lib/skills.mjs', evidence: "path.join('.plutos', 'packs.json')" },
    { path: '.plutos/state.json', writer: 'lib/state.mjs', evidence: "plutosDir, 'state.json'" },
    { path: '.plutos/logs/', writer: 'lib/state.mjs', evidence: "plutosDir, 'logs'" },
    { path: 'docs/handoff/CONTINUITY.md', writer: 'lib/continuity.mjs', evidence: "'docs', 'handoff', 'CONTINUITY.md'" },
    { path: 'docs/handoff/CONTEXT.json', writer: 'lib/context.mjs', evidence: "'docs', 'handoff', 'CONTEXT.json'" },
    { path: 'docs/handoff/archive/', writer: 'lib/continuity.mjs', evidence: "'docs', 'handoff', 'archive'" },
    { path: '.agents/*/', writer: 'lib/agents.mjs', evidence: "path.join(projectRoot, '.agents', agentName)" },
    { path: '.claude/agents/*', writer: 'lib/agents.mjs', evidence: "path.join(projectRoot, '.claude', 'agents')" },
    { path: '.claude/skills/*', writer: 'lib/skills.mjs', evidence: "folder: '.claude/skills'" },
    { path: '.agents/skills/*', writer: 'lib/skills.mjs', evidence: "folder: '.agents/skills'" },
    { path: 'graphify-out/', writer: 'lib/graphify.mjs', evidence: "path.join(projectRoot, 'graphify-out')" },
    { path: 'IDEAS.md', writer: 'lib/ideas.mjs', evidence: "['IDEAS.md']" },
    { path: 'CHANGELOG.md', writer: 'lib/changelog.mjs', evidence: 'CHANGELOG.md' }
]);

/** A catalogue path as a matcher: { segments: [RegExp|string], folder }. */
export function pathPattern(pattern) {
    const folder = pattern.endsWith('/');
    const segments = pattern.replace(/\/$/, '').split('/').map(segment => segment.includes('*')
        ? new RegExp(`^${segment.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`)
        : segment);
    return { segments, folder };
}

/** Does a project-relative path (folder paths end in /) fall under a catalogue pattern? */
export function patternCovers(pattern, relative) {
    const { segments, folder } = pathPattern(pattern);
    const parts = relative.replace(/\/$/, '').split('/');
    if (parts.length < segments.length) return false;
    if (!segments.every((segment, i) => typeof segment === 'string' ? segment === parts[i] : segment.test(parts[i]))) return false;
    // Deeper than the pattern only inside a folder pattern, or a * last segment (a folder of any name).
    return parts.length === segments.length || folder || typeof segments.at(-1) !== 'string';
}
