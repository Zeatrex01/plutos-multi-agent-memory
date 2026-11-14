// The admin drawer's tools (lib/drawers.mjs): upkeep that no session needs on an ordinary day, kept
// out of the tool list every AI receives until a project opens the drawer.
// Their handlers stay in index.mjs, which serves every registered tool; only the listing moves.
// status_report and project_snapshot moved here on 2026-11-14 (plan 2026-11-14 section 3): the owner's
// report is also `node cli.mjs report`, and no field session asked for a snapshot. plutos_usage joins
// them from lib/code-tools.mjs through the drawer (lib/drawers.mjs).
export const ADMIN_TOOLS = [
  {
    name: "init_roadmap",
    description: "Explicitly installs the additive PLUT_OS project kit: AGENTS.md rules, docs/handoff boards (BOARD, AGENT_BOARD, ROSTER), results/, the Coordinator MCP, generated indexes and launchers. Existing files are preserved. This is NOT what dashboard Add Project does: Add Project observes/maps into Hub-private storage without writing into the target.",
    inputSchema: {
      type: "object",
      properties: {
        with_interview: { type: "boolean", description: "Also drop docs/handoff/PROJECT_INTERVIEW.md (opt-in interview-guided setup). Only set true when the user explicitly wants the interview." }
      },
      required: []
    },
  },
  {
    name: "status_report",
    description: "PLUT_OS: Generates the owner's status report — what happened (recorded sessions), what changed in the repo, what's in flight on the boards, next steps, and watch-outs. Call when the user asks for a status report / durum raporu / 'what's the state of the project'. PRESENT the result in the USER'S OWN LANGUAGE, keeping the facts and structure — the data is the report, your job is the presentation.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Reporting window in days (default 7, max 90)" }
      },
      required: []
    }
  },
  {
    name: "project_snapshot",
    description: "PLUT_OS: Produces ONE self-contained handover file describing where this project actually stands — uncommitted and experimental work included, which is precisely what a a git pull cannot give anyone. Use it when the owner says they are stopping mid-task, wants to carry the state to another AI or another machine, or asks for an export/handover. Unlike session_start's brief, it CARRIES what it refers to (board, roster, decisions, claims, the code map, the working diff) rather than naming files, because whoever reads it may have a stale checkout or none at all. Hand the result to the owner verbatim; it is state, not instructions.",
    inputSchema: { type: "object", properties: {}, required: [] },
  }
];
