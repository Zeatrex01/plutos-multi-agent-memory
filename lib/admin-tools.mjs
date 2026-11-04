// The admin drawer's tools (lib/drawers.mjs): upkeep that no session needs on an ordinary day, kept
// out of the tool list every AI receives until a project opens the drawer.
// Their handlers stay in index.mjs, which serves every registered tool; only the listing moves.
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
    name: "project_deck",
    description: "PLUT_OS: Returns the project's story deck — every recorded session's plain-language story line, chronologically (live ledger + archive), plus what the project is and where it goes next. Call when the user asks for the project story, a pitch-style summary, the roadmap-as-narrative, or 'merge the sessions into a presentation'. PRESENT it in the USER'S OWN LANGUAGE, pitch-deck style: short, plain, milestone by milestone.",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "plutos_system_status",
    description: "PLUT_OS: Lets the agent understand the system load (active MCPs). Used to find MCPs to disable when context gets tight.",
    inputSchema: { type: "object", properties: {}, required: [] },
  }
];
