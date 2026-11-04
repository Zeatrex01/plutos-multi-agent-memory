# AGENTS.md — PLUT_OS Shared Communication Rules
<!-- plutos:kit -->

Several AIs work on this project through shared files, so nobody repeats work and nothing is
lost between sessions. Nothing you can do is restricted. The PLUT_OS tools describe themselves;
these are the rules they do not carry.

## Files
- `docs/handoff/BOARD.md`: the main board (assignments, status, a one-line result).
  `docs/handoff/AGENT_BOARD.md`: the subagents' board, for findings and `❓ NOTE:` discussion.
- `docs/handoff/results/`: documents. A board entry carries the path, never the content.
- `docs/handoff/ROSTER.md`: every AI registers the agents it spawns and tasks only its own; to use
  another AI's agent, leave a suggestion on the main board for its owner.

## A session
- **Start** from the brief. Claude Code's SessionStart hook delivers it; every other client calls
  `session_start` first. Without MCP, read `docs/handoff/CONTINUITY.md` and `docs/handoff/CONTEXT.json`
  and re-check each cited source before relying on a claim. The brief's WORKING AGREEMENT is the
  owner's rules. Do not re-derive the project by reading everything.
- **Before a task**, `plutos_context_for_task` names the files to open first.
- **Finish** with `session_end`: `learned` holds durable claims as `{claim, sources: [{path,
  evidence}]}` (a plain string stays unverified), `decided` holds settled choices and why, `story`
  one plain sentence for the owner. Then commit.
- **Language:** everything is English, because other AIs read it, except `story`, which is in the
  language the owner speaks to you in.
- **Rule 0:** if `docs/handoff/PROJECT_INTERVIEW.md` exists with blank `> answer:` lines, ask the
  owner those questions before real work and write the answers in. Never create that file.
- **Rule 1:** if `docs/ai/PROJECT_MAP.md` does not exist, read the project and write it before
  real work. A map that exists and is accurate is read, not redone; one that no longer matches
  the code is refreshed.

## Judging and councils
- A review, comparison or architecture call needs the project mapped and its history recorded
  (sessions, decisions, results); otherwise do the missing step first, or say what the verdict
  could not check. Never present a first impression as a finding.
- A council (two or more subagents with opposing briefs, then you rule) only for a decision that is
  irreversible, changes a contract others depend on, is already contested on the board, or takes
  more than a session to undo. Record the ruling and why in `decided`. The council decides how;
  the owner decides whether.

## Agents
- Give a piece that deserves focus its own agent (`plutos_create_agent`), register it, let it
  report on the agent board.
- An agent reads its `.agents/<name>/MEMORY.md` on spawn and, before finishing, adds the new
  durable lessons (decisions, pitfalls, where things live; never transcripts; about two pages).
- A Claude Code agent's definition lives in `.claude/agents/<name>.md`; any other AI's in
  `.agents/<name>/AGENT.md`. Only the owning AI's own tool runs it; others see it on the roster.

## Assigning work
PLUT_OS starts no AI turn; the owner opens each AI, and only council seats and opt-in capture run
without a ticket. Assign with everything the receiver needs: `assignee`, `role`, `needs`; it
reaches that AI in its next brief. Assigning to another vendor's AI is a suggestion: when you
receive one, configure yourself from it and close the same entry; do not open a second one.

## Every session, every agent
1. Read your tier's board before starting.
2. Starting a task: add or update your entry, `IN_PROGRESS`.
3. Finishing: `DONE` with a one-line result and where the output is (a `results/` path, a file or
   a commit). "No change needed" is a result: `Result: NO-CHANGE — <the check that ran>`.
4. A conflict (someone already on it, or unfinished work you depend on): add a `❓ NOTE:` under
   that entry instead of going on blind. An objection is `BLOCKED` with
   `Result: OBJECTION — <one line and its evidence>`.
5. Commit board and roster changes: git is the channel.
6. When a cycle ends: update the changelog, archive DONE entries, compact your MEMORY.md.
7. Before anything you should not decide alone (destructive or irreversible, a fork with no right
   branch, a scope call, real money), call `plutos_ask`. `PENDING` is not approval; on `REJECTED`
   or `EXPIRED`, stop and leave a `BLOCKED` entry saying what you wait on.

## Entry format and board hygiene
```
### <agent-name> · <IN_PROGRESS|DONE|BLOCKED> · <short task title>
- **Started:** <timestamp>
- **Task:** <one line>
- **Result / Output:** <one line, filled when DONE>
```
- At most 8 lines per entry; longer detail goes to `docs/handoff/results/<file>.md`.
- At most 10 active entries per board; DONE entries move to `docs/handoff/archive/`.
- Working detail belongs in `.agents/<name>/progress.md`, never on the shared board.

## Three kinds of shared file
- **Live** (`BOARD.md`, `AGENT_BOARD.md`, `ROSTER.md`, `CONTINUITY.md`, `CONTEXT.json`): bounded,
  always in the brief.
- **Generated** (`docs/ai/CODEINDEX.md` and its shards, the brief): overwritten in place; open the
  catalog, then only the shard for the folder you change.
- **Cold** (`docs/handoff/archive/`, `docs/handoff/results/`): history, read only when a live
  board entry names it. Git is the changelog; do not copy `git log` into markdown.
